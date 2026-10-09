import type postgres from 'postgres';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, type Principal } from '../security.js';
import { knowledgeCampaign } from './ai-knowledge.js';
import { aiConfigurationBranch } from '../ai/configuration-access.js';
import { emptyAIBehaviorPolicy, normalizeAIBehaviorPolicy, aiBehaviorPolicySchema, aiBehaviorPreviewContextSchema, inheritAIBehaviorPolicy, evaluateAIBehaviorPolicy, aiMandatoryHandoffTriggers, type AIBehaviorPolicy, type AIBehaviorPreviewContext } from '../ai/behavior-policy.js';
const uuid = { type: 'string', format: 'uuid' } as const;
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } } as const;
export async function currentAIBehaviorPolicy(tx: postgres.TransactionSql, scope: string, id: string) {
  return (await tx`SELECT version,definition,actor_id,reason,updated_at FROM ai_behavior_policy WHERE scope=${scope} AND resource_id=${id} FOR SHARE`)[0] ?? { version: 0, definition: emptyAIBehaviorPolicy() };
}
export function registerAIBehaviorPolicyRoutes(app: FastifyInstance, db: Database) {
  for (const scope of ['BRANCH', 'CAMPAIGN'] as const) {
    const root = scope === 'BRANCH' ? '/api/ai/branches/:id/behavior-defaults' : '/api/ai/campaigns/:id/behavior-policy';
    async function access(tx: postgres.TransactionSql, actor: Principal, id: string, request: FastifyRequest, write = false) {
      if (scope === 'BRANCH') { const { b, sessionId } = await aiConfigurationBranch(tx, actor, id, request, write); return { branchId: b.id as string, sessionId }; }
      const { c, sessionId } = await knowledgeCampaign(tx, actor, id, request, write); return { branchId: c.branch_id as string, sessionId };
    }
    app.get<{ Params: { id: string } }>(root, { schema: { params } }, async request => {
      const actor = await principalFromRequest(request, db);
      return db.begin(async tx => { await access(tx, actor, request.params.id, request); return { ...await currentAIBehaviorPolicy(tx, scope, request.params.id), scope, mandatoryHandoffTriggers: aiMandatoryHandoffTriggers, runtimeImplemented: false }; });
    });
    app.put<{ Params: { id: string }; Body: { version: number; definition: AIBehaviorPolicy; reason: string } }>(root, {
      bodyLimit: 65536, schema: { params, body: { type: 'object', additionalProperties: false, required: ['version', 'definition', 'reason'], properties: {
        version: { type: 'integer', minimum: 0 }, definition: aiBehaviorPolicySchema, reason: { type: 'string', minLength: 3, maxLength: 500, pattern: '^[^\\x00-\\x1f\\x7f]+$' },
      } } },
    }, async request => {
      const actor = await principalFromRequest(request, db), definition = normalizeAIBehaviorPolicy(request.body.definition), reason = request.body.reason.trim();
      if (reason.length < 3 || Buffer.from(reason).toString() !== reason) throw new HttpError(400, 'AI_BEHAVIOR_REASON_REQUIRED');
      if (scope === 'BRANCH' && definition.returningContact !== null) throw new HttpError(400, 'AI_RETURNING_POLICY_CAMPAIGN_ONLY');
      return db.begin(async tx => {
        const id = request.params.id, { branchId, sessionId } = await access(tx, actor, id, request, true);
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'ai-behavior:' + scope + ':' + id},0))`;
        const old = (await tx`SELECT version FROM ai_behavior_policy WHERE scope=${scope} AND resource_id=${id} FOR UPDATE`)[0];
        if ((old?.version ?? 0) !== request.body.version) throw new HttpError(409, 'AI_BEHAVIOR_VERSION_CONFLICT');
        if (old) await tx`UPDATE ai_behavior_policy SET version=version+1,definition=${tx.json(definition)},actor_id=${actor.id},session_id=${sessionId},reason=${reason} WHERE scope=${scope} AND resource_id=${id}`;
        else await tx`INSERT INTO ai_behavior_policy(scope,resource_id,branch_id,campaign_id,version,definition,actor_id,session_id,reason) VALUES (${scope},${id},${branchId},${scope === 'CAMPAIGN' ? id : null},1,${tx.json(definition)},${actor.id},${sessionId},${reason})`;
        return { version: request.body.version + 1, runtimeImplemented: false };
      });
    });
    app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>(root + '/history', { schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }, async request => {
      const actor = await principalFromRequest(request, db);
      return db.begin(async tx => { await access(tx, actor, request.params.id, request); const limit = request.query.limit ?? 20;
        const rows = await tx`SELECT version,snapshot->>'reason' AS reason,snapshot->>'actor_id' AS actor_id,created_at FROM ai_behavior_policy_history WHERE scope=${scope} AND resource_id=${request.params.id} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit + 1}`;
        return { items: rows.slice(0, limit), nextVersion: rows.length > limit ? rows[limit - 1]!.version : null }; });
    });
    app.get<{ Params: { id: string; version: number } }>(root + '/versions/:version', { schema: { params: { ...params, required: ['id', 'version'], properties: { id: uuid, version: { type: 'integer', minimum: 1 } } } } }, async request => {
      const actor = await principalFromRequest(request, db);
      return db.begin(async tx => { await access(tx, actor, request.params.id, request);
        const row = (await tx`SELECT version,snapshot->'definition' AS definition,snapshot->>'reason' AS reason,snapshot->>'actor_id' AS actor_id,created_at FROM ai_behavior_policy_history WHERE scope=${scope} AND resource_id=${request.params.id} AND version=${request.params.version}`)[0];
        if (!row) throw new HttpError(404, 'AI_BEHAVIOR_VERSION_NOT_FOUND'); return row; });
    });
  }
  app.post<{ Params: { id: string }; Body: { branchVersion: number; campaignVersion: number; context: AIBehaviorPreviewContext } }>('/api/ai/campaigns/:id/behavior-policy/preview', {
    bodyLimit: 16384, schema: { params, body: { type: 'object', additionalProperties: false, required: ['branchVersion', 'campaignVersion', 'context'], properties: { branchVersion: { type: 'integer', minimum: 0 }, campaignVersion: { type: 'integer', minimum: 0 }, context: aiBehaviorPreviewContextSchema } } },
  }, async request => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => {
      const { c } = await knowledgeCampaign(tx, actor, request.params.id, request);
      const branch = await currentAIBehaviorPolicy(tx, 'BRANCH', c.branch_id), campaign = await currentAIBehaviorPolicy(tx, 'CAMPAIGN', c.id);
      if (branch.version !== request.body.branchVersion || campaign.version !== request.body.campaignVersion) throw new HttpError(409, 'AI_BEHAVIOR_VERSION_CONFLICT');
      const inherited = inheritAIBehaviorPolicy(branch.definition, campaign.definition);
      return { ...evaluateAIBehaviorPolicy(inherited.effective, request.body.context), ...inherited, branchVersion: branch.version, campaignVersion: campaign.version, runtimeImplemented: false };
    });
  });
}
