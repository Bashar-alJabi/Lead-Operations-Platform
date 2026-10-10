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
      const rows = await tx`SELECT e.*,e.context->'knowledge'->'version' AS knowledge_version,a.id AS action_id,a.state AS action_state,a.error_code AS action_error,a.created_at AS action_created_at,
        e.context IS DISTINCT FROM CASE WHEN e.kind='CUSTOMER_PROPOSAL' THEN ai_customer_proposal_context(e.event_id) ELSE ai_customer_inbound_context(e.event_id) END AS stale
        FROM (
          SELECT p.id,p.organization_id,p.branch_id,p.campaign_id,p.lead_id,p.conversation_id,p.message_id,p.event_id,p.state,p.error_code,p.context_hash,p.created_at,p.context,p.result,p.provider_invoked,p.attempt_count,'CUSTOMER_PROPOSAL' AS kind
          FROM ai_customer_proposal p WHERE p.conversation_id=${request.params.id}
          UNION ALL
          SELECT b.id,b.organization_id,b.branch_id,b.campaign_id,b.lead_id,b.conversation_id,b.message_id,b.event_id,b.state,b.error_code,b.context_hash,b.created_at,b.context,NULL::jsonb,false,0,'BLOCKED_INBOUND' AS kind
          FROM ai_customer_inbound_execution b WHERE b.conversation_id=${request.params.id} AND NOT EXISTS(SELECT 1 FROM ai_customer_proposal p WHERE p.event_id=b.event_id)
        ) e LEFT JOIN ai_customer_action a ON a.proposal_id=e.id AND e.kind='CUSTOMER_PROPOSAL'
        WHERE e.conversation_id=${request.params.id} AND e.lead_id=${access.lead.id}
          AND e.organization_id=${actor.organizationId} AND e.branch_id=${access.lead.branch_id} AND e.campaign_id=${access.lead.campaign_id}
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (e.created_at,e.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY e.created_at DESC,e.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit), last = items.at(-1);
      await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${access.lead.branch_id},${actor.id},'AI_CUSTOMER_HISTORY_READ','CONVERSATION',${request.params.id},${tx.json({ leadId: access.lead.id, count: items.length })})`;
      return { items: items.map(e => ({ id: e.id, sourceMessageId: e.message_id, sourceEventId: e.event_id, assistant: 'AI_LEAD_ASSISTANT', state: e.state,
        errorCode: e.error_code, contextHash: e.context_hash, knowledgeVersion: e.knowledge_version, createdAt: e.created_at, stale: e.stale,
        kind: e.kind, attemptCount: e.attempt_count, providerInvoked: e.provider_invoked,
        // A qualification candidate may refer to a Field hidden from this employee. Never expose its value, question or schema here.
        proposal: e.result ? { decision: e.result.decision, handoffReason: e.result.handoffReason,
          answer: e.result.decision === 'ANSWER' ? e.result.referenceIds.map((id: string) => e.context.references.find((r: { id: string; text: string }) => r.id === id)?.text ?? '').join('\n\n') : null } : null,
        action: e.action_id ? { id: e.action_id, tool: 'updateQualificationField', state: e.action_state, errorCode: e.action_error, createdAt: e.action_created_at } : null,
        toolsExecuted: e.action_state === 'APPLIED' ? ['updateQualificationField'] : [], sendAllowed: false, mutationsAllowed: false })),
        nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null,
        liveTransferEnabled: false, runtimeReady: false };
    });
  });
}
