import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireRole, type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { approvedConversationReadContext } from '../ai/copilot-context.js';
import { decodeCursor, encodeCursor } from '../pagination.js';

async function access(tx: postgres.TransactionSql, actor: Principal, id: string, request: FastifyRequest) {
  const initial = (await tx`SELECT l.branch_id FROM conversation cv JOIN lead l ON l.id=cv.lead_id WHERE cv.id=${id}
    AND l.organization_id=${actor.organizationId} AND (${actor.role === 'SUPER_ADMIN'} OR l.branch_id=${actor.branchId})
    AND (${actor.role !== 'AGENT'} OR l.assigned_agent_id=${actor.id})`)[0];
  if (!initial) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
  await tx`SELECT id FROM branch WHERE id=${initial.branch_id} AND organization_id=${actor.organizationId} FOR SHARE`;
  const session = await currentPaymentSession(tx, actor, request);
  if (!session) throw new HttpError(403, 'AI_ACTION_JOB_ACCESS_REVOKED');
  const ctx = await approvedConversationReadContext(tx, actor, id, session);
  if (ctx.lead.branch_id !== initial.branch_id) throw new HttpError(409, 'AI_ACTION_JOB_CONTEXT_CHANGED');
  return { ctx, session };
}
export function registerAIActionJobRoutes(app: FastifyInstance, db: Database) {
  const uuid = { type: 'string', format: 'uuid' } as const, root = '/api/conversations/:id/ai-action-jobs';
  const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } } as const;
  const jobParams = { ...params, required: ['id', 'jobId'], properties: { id: uuid, jobId: uuid } } as const;
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: number; includeCompleted?: boolean } }>(root, {
    schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, includeCompleted: { type: 'boolean' } } } },
  }, async request => {
    const actor = await principalFromRequest(request, db), cursor = decodeCursor(request.query.cursor), limit = request.query.limit ?? 10;
    return db.begin(async tx => {
      const { ctx } = await access(tx, actor, request.params.id, request);
      const rows = await tx`SELECT q.id,q.proposal_id,q.kind,q.version,q.state,q.failure_count,q.error_code,q.updated_at,q.updated_at::text AS cursor_at,
        CASE WHEN isfinite(q.available_at) THEN q.available_at ELSE NULL END AS next_run_at,
        CASE WHEN ${actor.role !== 'AGENT'} AND q.failure_count>0 AND q.state<>'COMPLETED' THEN ai_local_action_context_current(q.proposal_id,q.kind) ELSE false END AS can_retry
        FROM ai_local_action_queue q WHERE q.conversation_id=${request.params.id} AND q.lead_id=${ctx.lead.id} AND q.campaign_id=${ctx.lead.campaign_id}
          AND q.organization_id=${actor.organizationId} AND q.branch_id=${ctx.lead.branch_id} AND (${request.query.includeCompleted === true} OR q.state<>'COMPLETED')
          AND (${cursor?.timestamp ?? null}::text::timestamptz IS NULL OR (q.updated_at,q.id)<(${cursor?.timestamp ?? null}::text::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY q.updated_at DESC,q.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit), last = items.at(-1);
      return { items: items.map(q => ({ id: q.id, proposalId: q.proposal_id, kind: q.kind, version: q.version, state: q.state, failureCount: q.failure_count,
        errorCode: q.error_code, nextRunAt: q.next_run_at, updatedAt: q.updated_at, canRetry: q.can_retry })),
        nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.cursor_at, id: last.id }) : null };
    });
  });
  app.get<{ Params: { id: string; jobId: string }; Querystring: { before?: number; limit?: number } }>(root + '/:jobId/history', {
    schema: { params: jobParams, querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50 } } } },
  }, async request => {
    const actor = await principalFromRequest(request, db), limit = request.query.limit ?? 10;
    return db.begin(async tx => {
      const { ctx } = await access(tx, actor, request.params.id, request);
      const q = (await tx`SELECT id FROM ai_local_action_queue WHERE id=${request.params.jobId} AND conversation_id=${request.params.id} AND lead_id=${ctx.lead.id}
        AND organization_id=${actor.organizationId} AND branch_id=${ctx.lead.branch_id} AND campaign_id=${ctx.lead.campaign_id}`)[0];
      if (!q) throw new HttpError(404, 'AI_ACTION_JOB_NOT_FOUND');
      const rows = await tx`SELECT version,snapshot->>'operation' AS operation,snapshot->>'state' AS state,snapshot->'failure_count' AS failure_count,
        snapshot->>'error_code' AS error_code,snapshot->>'actor_id' AS actor_id,snapshot->>'reason' AS reason,created_at
        FROM ai_local_action_queue_history WHERE queue_id=${q.id} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null})
        ORDER BY version DESC LIMIT ${limit + 1}`;
      return { items: rows.slice(0, limit), nextVersion: rows.length > limit ? rows[limit - 1]!.version : null };
    });
  });
  app.post<{ Params: { id: string; jobId: string }; Body: { version: number; reason: string } }>(root + '/:jobId/retry', {
    preValidation: async request => { const b = request.body as Record<string, unknown> | null;
      if (!b || typeof b.version !== 'number' || !Number.isInteger(b.version) || typeof b.reason !== 'string') throw new HttpError(400, 'INVALID_AI_ACTION_RECOVERY'); },
    schema: { params: jobParams, body: { type: 'object', additionalProperties: false, required: ['version', 'reason'], properties: {
      version: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 3, maxLength: 500, pattern: '^[^\\x00-\\x1f\\x7f]+$' },
    } } },
  }, async request => {
    const actor = await principalFromRequest(request, db); requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const reason = request.body.reason.trim(); if (reason.length < 3) throw new HttpError(400, 'AI_ACTION_RECOVERY_REASON_REQUIRED');
    return db.begin(async tx => {
      const q = (await tx`SELECT q.* FROM ai_local_action_queue q JOIN lead l ON l.id=q.lead_id JOIN conversation cv ON cv.id=q.conversation_id AND cv.lead_id=l.id
        WHERE q.id=${request.params.jobId} AND q.conversation_id=${request.params.id} AND l.organization_id=${actor.organizationId}
          AND (${actor.role === 'SUPER_ADMIN'} OR l.branch_id=${actor.branchId}) AND (q.organization_id,q.branch_id,q.campaign_id)=(l.organization_id,l.branch_id,l.campaign_id)
        FOR UPDATE OF q`)[0];
      if (!q) throw new HttpError(404, 'AI_ACTION_JOB_NOT_FOUND');
      await tx`SELECT id FROM branch WHERE id=${q.branch_id} FOR UPDATE`;
      const { ctx, session } = await access(tx, actor, request.params.id, request);
      if (ctx.lead.branch_id !== q.branch_id || ctx.lead.campaign_id !== q.campaign_id) throw new HttpError(404, 'AI_ACTION_JOB_NOT_FOUND');
      if (q.state === 'COMPLETED' || q.failure_count === 0) throw new HttpError(409, 'AI_ACTION_RECOVERY_UNAVAILABLE');
      if (q.version !== request.body.version) throw new HttpError(409, 'AI_ACTION_JOB_VERSION_CONFLICT');
      const current = q.kind === 'QUALIFICATION' ? (await tx`SELECT ai_customer_action_context(${q.proposal_id}) AS ctx`)[0]?.ctx
        : (await tx`SELECT ai_customer_handoff_context(${q.proposal_id}) AS ctx`)[0]?.ctx;
      if (!current) throw new HttpError(409, 'AI_ACTION_RECOVERY_CONTEXT_CHANGED');
      await tx`UPDATE ai_local_action_queue SET operation='HUMAN_RETRY',version=version+1,actor_id=${actor.id},session_id=${session},reason=${reason} WHERE id=${q.id}`;
      return { version: q.version + 1 };
    });
  });
}
