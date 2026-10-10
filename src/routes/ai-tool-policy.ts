import type postgres from 'postgres';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireRole, type Principal } from '../security.js';
import { knowledgeCampaign } from './ai-knowledge.js';
import { aiConfigurationBranch } from '../ai/configuration-access.js';
import { currentAIToolPolicy, normalizeAIToolPolicy, aiToolPolicySchema, aiCustomerToolCatalog, type AIToolPolicy } from '../ai/tool-policy.js';
const uuid = { type: 'string', format: 'uuid' } as const;
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } } as const;
export function registerAIToolPolicyRoutes(app: FastifyInstance, db: Database) {
  for (const scope of ['BRANCH', 'CAMPAIGN'] as const) {
    const root = scope === 'BRANCH' ? '/api/ai/branches/:id/tool-defaults' : '/api/ai/campaigns/:id/tool-policy';
    async function access(tx: postgres.TransactionSql, actor: Principal, id: string, request: FastifyRequest, write = false) {
      requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
      if (write) {
        // Parent UPDATE is chosen first to fence creation/clearing of absent policies against current workers.
        const branchId = scope === 'BRANCH' ? id : (await tx`SELECT branch_id FROM campaign WHERE id=${id} AND organization_id=${actor.organizationId} AND (${actor.role === 'SUPER_ADMIN'} OR branch_id=${actor.branchId})`)[0]?.branch_id;
        const b = branchId && (await tx`SELECT id FROM branch WHERE id=${branchId} AND organization_id=${actor.organizationId} AND (${actor.role === 'SUPER_ADMIN'} OR id=${actor.branchId}) FOR UPDATE`)[0];
        if (!b) throw new HttpError(404, scope === 'BRANCH' ? 'BRANCH_NOT_FOUND' : 'CAMPAIGN_NOT_FOUND');
      }
      if (scope === 'BRANCH') { const { b, sessionId } = await aiConfigurationBranch(tx, actor, id, request, write); return { branchId: b.id as string, sessionId }; }
      const { c, sessionId } = await knowledgeCampaign(tx, actor, id, request, write); return { branchId: c.branch_id as string, sessionId };
    }
    app.get<{ Params: { id: string } }>(root, { schema: { params } }, async request => {
      const actor = await principalFromRequest(request, db);
      return db.begin(async tx => { await access(tx, actor, request.params.id, request); return { ...await currentAIToolPolicy(tx, scope, request.params.id), scope, catalog: aiCustomerToolCatalog, runtimeAuthorized: false, liveTransferEnabled: false }; });
    });
    app.put<{ Params: { id: string }; Body: { version: number; definition: AIToolPolicy; reason: string } }>(root, {
      bodyLimit: 8192, preValidation: async request => { normalizeAIToolPolicy((request.body as { definition?: unknown } | undefined)?.definition); }, schema: { params, body: { type: 'object', additionalProperties: false, required: ['version', 'definition', 'reason'], properties: {
        version: { type: 'integer', minimum: 0 }, definition: aiToolPolicySchema, reason: { type: 'string', minLength: 3, maxLength: 500, pattern: '^[^\\x00-\\x1f\\x7f]+$' },
      } } },
    }, async request => {
      const actor = await principalFromRequest(request, db), definition = normalizeAIToolPolicy(request.body.definition), reason = request.body.reason.trim();
      if (reason.length < 3 || Buffer.from(reason).toString() !== reason) throw new HttpError(400, 'AI_TOOL_POLICY_REASON_REQUIRED');
      return db.begin(async tx => {
        const id = request.params.id, { branchId, sessionId } = await access(tx, actor, id, request, true);
        const old = (await tx`SELECT version FROM ai_tool_policy WHERE scope=${scope} AND resource_id=${id} FOR UPDATE`)[0];
        if ((old?.version ?? 0) !== request.body.version) throw new HttpError(409, 'AI_TOOL_POLICY_VERSION_CONFLICT');
        if (old) await tx`UPDATE ai_tool_policy SET version=version+1,definition=${tx.json(definition)},actor_id=${actor.id},session_id=${sessionId},reason=${reason} WHERE scope=${scope} AND resource_id=${id}`;
        else await tx`INSERT INTO ai_tool_policy(scope,resource_id,branch_id,campaign_id,version,definition,actor_id,session_id,reason) VALUES (${scope},${id},${branchId},${scope === 'CAMPAIGN' ? id : null},1,${tx.json(definition)},${actor.id},${sessionId},${reason})`;
        return { version: request.body.version + 1, runtimeAuthorized: false, liveTransferEnabled: false };
      });
    });
    app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>(root + '/history', { schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }, async request => {
      const actor = await principalFromRequest(request, db);
      return db.begin(async tx => { await access(tx, actor, request.params.id, request); const limit = request.query.limit ?? 20;
        const rows = await tx`SELECT version,snapshot->>'reason' AS reason,snapshot->>'actor_id' AS actor_id,created_at FROM ai_tool_policy_history WHERE scope=${scope} AND resource_id=${request.params.id} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit + 1}`;
        return { items: rows.slice(0, limit), nextVersion: rows.length > limit ? rows[limit - 1]!.version : null }; });
    });
    app.get<{ Params: { id: string; version: number } }>(root + '/versions/:version', { schema: { params: { ...params, required: ['id', 'version'], properties: { id: uuid, version: { type: 'integer', minimum: 1 } } } } }, async request => {
      const actor = await principalFromRequest(request, db);
      return db.begin(async tx => { await access(tx, actor, request.params.id, request);
        const row = (await tx`SELECT version,snapshot->'definition' AS definition,snapshot->>'reason' AS reason,snapshot->>'actor_id' AS actor_id,created_at FROM ai_tool_policy_history WHERE scope=${scope} AND resource_id=${request.params.id} AND version=${request.params.version}`)[0];
        if (!row) throw new HttpError(404, 'AI_TOOL_POLICY_VERSION_NOT_FOUND'); return row; });
    });
  }
}
