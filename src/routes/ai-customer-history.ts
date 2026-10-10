import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { approvedConversationReadContext } from '../ai/copilot-context.js';
import { decodeCursor, encodeCursor } from '../pagination.js';

export function registerAICustomerHistoryRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Params: { id: string }; Querystring: { limit?: number; cursor?: string } }>('/api/conversations/:id/ai-customer-executions', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', maxLength: 256 } } } },
  }, async request => {
    const actor = await principalFromRequest(request, db), cursor = decodeCursor(request.query.cursor), limit = request.query.limit ?? 10;
    return db.begin(async tx => {
      const session = await currentPaymentSession(tx, actor, request);
      if (!session) throw new HttpError(403, 'AI_HISTORY_ACCESS_REVOKED');
      const access = await approvedConversationReadContext(tx, actor, request.params.id, session);
      const rows = await tx`SELECT e.id,e.message_id,e.event_id,e.state,e.error_code,e.context_hash,e.created_at,
        e.context->'knowledge'->'version' AS knowledge_version,
        e.context IS DISTINCT FROM ai_customer_inbound_context(e.event_id) AS stale
        FROM ai_customer_inbound_execution e WHERE e.conversation_id=${request.params.id} AND e.lead_id=${access.lead.id}
          AND e.organization_id=${actor.organizationId} AND e.branch_id=${access.lead.branch_id} AND e.campaign_id=${access.lead.campaign_id}
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (e.created_at,e.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY e.created_at DESC,e.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit), last = items.at(-1);
      await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${access.lead.branch_id},${actor.id},'AI_CUSTOMER_HISTORY_READ','CONVERSATION',${request.params.id},${tx.json({ leadId: access.lead.id, count: items.length })})`;
      return { items: items.map(e => ({ id: e.id, sourceMessageId: e.message_id, sourceEventId: e.event_id, assistant: 'AI_LEAD_ASSISTANT', state: e.state,
        errorCode: e.error_code, contextHash: e.context_hash, knowledgeVersion: e.knowledge_version, createdAt: e.created_at, stale: e.stale,
        providerInvoked: false, toolsExecuted: [], sendAllowed: false, mutationsAllowed: false })),
        nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null,
        liveTransferEnabled: false, runtimeReady: false };
    });
  });
}
