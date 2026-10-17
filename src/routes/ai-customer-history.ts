import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { approvedConversationReadContext } from '../ai/copilot-context.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { readHumanQualificationState, humanQualificationDTO } from '../ai/human-qualification.js';
import { enqueueHandoffSummary } from '../ai/handoff-summary.js';
import { currentHandoffReception } from '../ai/handoff-reception.js';

export function registerAICustomerHistoryRoutes(app: FastifyInstance, db: Database) {
  app.post<{ Params: { id: string }; Body: { requestId: string } }>('/api/conversations/:id/ai-handoff-summary', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => {
      const initial = (await tx`SELECT l.branch_id FROM conversation cv JOIN lead l ON l.id=cv.lead_id WHERE cv.id=${request.params.id}
        AND l.organization_id=${actor.organizationId} AND (${actor.role === 'SUPER_ADMIN'} OR l.branch_id=${actor.branchId}) AND (${actor.role !== 'AGENT'} OR l.assigned_agent_id=${actor.id})`)[0];
      if (!initial) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
      await tx`SELECT id FROM branch WHERE id=${initial.branch_id} FOR UPDATE`;
      const session = await currentPaymentSession(tx, actor, request);
      if (!session) throw new HttpError(403, 'AI_HANDOFF_ACCESS_REVOKED');
      const access = await approvedConversationReadContext(tx, actor, request.params.id, session);
      if (access.lead.branch_id !== initial.branch_id) throw new HttpError(409, 'AI_HANDOFF_SUMMARY_CONTEXT_CHANGED');
      const current = (await tx`SELECT ai_handoff_action_id FROM conversation WHERE id=${request.params.id}`)[0];
      if (!current?.ai_handoff_action_id) throw new HttpError(409, 'AI_HANDOFF_SUMMARY_CURRENT_ADMISSION_REQUIRED');
      const result = await enqueueHandoffSummary(tx, current.ai_handoff_action_id, request.body.requestId, actor.id, session);
      if (!result) throw new HttpError(409, 'AI_HANDOFF_SUMMARY_CURRENT_ADMISSION_REQUIRED');
      reply.code(result.duplicate ? 200 : 202); return result;
    });
  });
  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/ai/human-handoff-queue', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', maxLength: 256 } } } },
  }, async request => {
    const actor = await principalFromRequest(request, db), cursor = decodeCursor(request.query.cursor), limit = request.query.limit ?? 10;
    return db.begin(async tx => {
      const rows = await tx`SELECT a.id,a.handoff_reason,a.created_at,cv.id AS conversation_id,l.id AS lead_id,c.name AS campaign_name,
          ct.name AS contact_name,l.assigned_agent_id,ai_handoff_reception(a.id,statement_timestamp()) AS reception FROM conversation cv JOIN ai_customer_handoff_action a ON a.id=cv.ai_handoff_action_id
          JOIN lead l ON l.id=cv.lead_id JOIN campaign c ON c.id=l.campaign_id LEFT JOIN contact ct ON ct.id=l.contact_id
        WHERE cv.state='WAITING_FOR_HUMAN' AND cv.controller_type='NONE' AND a.state='APPLIED' AND a.lead_id=l.id AND a.campaign_id=c.id
          AND l.organization_id=${actor.organizationId} AND (${actor.role === 'SUPER_ADMIN'} OR l.branch_id=${actor.branchId})
          AND (${actor.role !== 'AGENT'} OR l.assigned_agent_id=${actor.id})
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (a.created_at,a.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY a.created_at DESC,a.id DESC LIMIT ${limit + 1} FOR SHARE OF l,cv`;
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'AI_HANDOFF_ACCESS_REVOKED');
      const items = rows.slice(0, limit), last = items.at(-1);
      await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES(${actor.organizationId},${actor.branchId},${actor.id},'AI_HUMAN_HANDOFF_QUEUE_READ','USER',${actor.id},${tx.json({ count: items.length })})`;
      return { items, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
    });
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: number; cursor?: string } }>('/api/conversations/:id/ai-handoffs', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', maxLength: 256 } } } },
  }, async request => {
    const actor = await principalFromRequest(request, db), cursor = decodeCursor(request.query.cursor), limit = request.query.limit ?? 10;
    return db.begin(async tx => {
      const session = await currentPaymentSession(tx, actor, request);
      if (!session) throw new HttpError(403, 'AI_HANDOFF_ACCESS_REVOKED');
      const access = await approvedConversationReadContext(tx, actor, request.params.id, session);
      const rows = await tx`SELECT a.id,a.state,a.error_code,a.handoff_reason,a.created_at,a.qualification_action_id,a.context->'knowledge'->'version' AS knowledge_version,
          p.message_id,left(m.body,2000) AS customer_question,re.snapshot AS reception_at_request FROM ai_customer_handoff_action a JOIN ai_customer_proposal p ON p.id=a.proposal_id
          LEFT JOIN ai_handoff_reception_event re ON re.action_id=a.id
          JOIN conversation_message m ON m.id=p.message_id AND m.conversation_id=a.conversation_id
        WHERE a.conversation_id=${request.params.id} AND a.lead_id=${access.lead.id} AND a.campaign_id=${access.lead.campaign_id}
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (a.created_at,a.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY a.created_at DESC,a.id DESC LIMIT ${limit + 1}`;
      const current = (await tx`SELECT cv.state,cv.controller_type,cv.controller_user_id,cv.version,cv.ai_handoff_action_id,l.assigned_agent_id,l.source_kind,c.name AS campaign_name
        FROM conversation cv JOIN lead l ON l.id=cv.lead_id JOIN campaign c ON c.id=l.campaign_id WHERE cv.id=${request.params.id}`)[0]!;
      const qualification = humanQualificationDTO(await readHumanQualificationState(tx, actor, { id: access.lead.id as string, campaign_id: access.lead.campaign_id as string }, access.b.active));
      const reception = await currentHandoffReception(tx,current.ai_handoff_action_id);
      const summaries = await tx`SELECT s.id,s.action_id,s.state,s.error_code,s.created_at,s.completed_at,s.attempt_count,s.result,s.context->'summaryContext'->'truncated' AS truncated,
          s.context->'sourceContext'->'knowledge'->'version' AS knowledge_version,s.context->'profile'->>'id' AS profile_id,
          s.context IS DISTINCT FROM ai_handoff_summary_context(s.action_id) AS stale
        FROM ai_handoff_summary s WHERE s.conversation_id=${request.params.id} AND s.lead_id=${access.lead.id} AND s.campaign_id=${access.lead.campaign_id}
        ORDER BY s.created_at DESC,s.id DESC LIMIT 5`;
      // Transport evidence, not a claim that a semantic answer was satisfactory. FAILED/QUEUED never count as a reply.
      const awaiting = (await tx`SELECT m.id,m.body,m.message_kind,m.created_at FROM conversation_message m WHERE m.conversation_id=${request.params.id}
        AND m.direction='INBOUND' AND m.author_type='CUSTOMER' AND NOT EXISTS(SELECT 1 FROM conversation_message o WHERE o.conversation_id=m.conversation_id
          AND o.direction='OUTBOUND' AND o.delivery_state IN ('SENT','DELIVERED','READ') AND (o.created_at,o.id)>(m.created_at,m.id))
        ORDER BY m.created_at DESC,m.id DESC LIMIT 1`)[0] ?? null;
      const publication = (await tx`SELECT version,ai_simulation_references(jsonb_build_object('content',content,'assets',COALESCE((SELECT jsonb_agg(pa.snapshot ORDER BY pa.asset_id)
        FROM ai_knowledge_publication_asset pa JOIN ai_knowledge_asset ka ON ka.id=pa.asset_id JOIN ai_knowledge_asset_approval ap ON ap.asset_id=ka.id
        WHERE pa.campaign_id=kp.campaign_id AND pa.version=kp.version AND ka.state='REVIEW' AND ap.decision='APPROVED'),'[]'))) AS references
        FROM ai_knowledge_publication kp WHERE campaign_id=${access.lead.campaign_id} ORDER BY version DESC LIMIT 1`)[0] ?? null;
      const refreshAvailable = !!current.ai_handoff_action_id && !!(await tx`SELECT ai_handoff_summary_context(${current.ai_handoff_action_id}) IS NOT NULL AS available`)[0]?.available;
      const items = rows.slice(0, limit), last = items.at(-1);
      await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES(${actor.organizationId},${access.lead.branch_id},${actor.id},'AI_HUMAN_HANDOFF_HISTORY_READ','CONVERSATION',${request.params.id},${tx.json({ count: items.length })})`;
      return { items, current, qualification, reception, package: { summaries, awaitingCustomerMessage: awaiting, publication, refreshAvailable,
        suggestedNextAction: current.state === 'WAITING_FOR_HUMAN' ? 'REVIEW_AND_ACCEPT_HUMAN_CONTROL' : current.controller_type === 'HUMAN' ? 'REVIEW_AND_RESPOND_AS_CURRENT_CONTROLLER' : 'REVIEW_CURRENT_CONTROL',
        liveTransferEnabled: false }, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
    });
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: number; cursor?: string } }>('/api/conversations/:id/ai-customer-executions', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: { type: 'string', maxLength: 256 } } } },
  }, async request => {
    const actor = await principalFromRequest(request, db), cursor = decodeCursor(request.query.cursor), limit = request.query.limit ?? 10;
    return db.begin(async tx => {
      const session = await currentPaymentSession(tx, actor, request);
      if (!session) throw new HttpError(403, 'AI_HISTORY_ACCESS_REVOKED');
      const access = await approvedConversationReadContext(tx, actor, request.params.id, session);
      const rows = await tx`SELECT e.*,e.created_at::text AS cursor_at,e.context->'knowledge'->'version' AS knowledge_version,COALESCE(a.id,h.id,s.id) AS action_id,COALESCE(a.state,h.state,s.state) AS action_state,
        COALESCE(a.error_code,h.error_code,s.error_code) AS action_error,COALESCE(a.created_at,h.created_at,s.created_at) AS action_created_at,COALESCE(a.tool,h.tool,s.tool) AS action_tool,
        s.message_id AS send_message_id,sm.delivery_state AS send_delivery_state,
        a.id AS qualification_action_id,h.id AS handoff_id,h.tool AS handoff_tool,h.state AS handoff_state,h.error_code AS handoff_error,h.created_at AS handoff_created_at,stop.action_id IS NOT NULL AS safety_stopped,
        o.ordinal::text AS misunderstanding_count,o.threshold AS misunderstanding_threshold,o.handoff_required AS misunderstanding_required,o.conversation_version AS misunderstanding_version,
        e.context IS DISTINCT FROM CASE WHEN e.kind='CUSTOMER_PROPOSAL' THEN ai_customer_proposal_context(e.event_id) ELSE ai_customer_inbound_context(e.event_id) END AS stale
        FROM (
          SELECT p.id,p.organization_id,p.branch_id,p.campaign_id,p.lead_id,p.conversation_id,p.message_id,p.event_id,p.state,p.error_code,p.context_hash,p.created_at,p.context,p.result,p.provider_invoked,p.attempt_count,'CUSTOMER_PROPOSAL' AS kind
          FROM ai_customer_proposal p WHERE p.conversation_id=${request.params.id}
          UNION ALL
          SELECT b.id,b.organization_id,b.branch_id,b.campaign_id,b.lead_id,b.conversation_id,b.message_id,b.event_id,b.state,b.error_code,b.context_hash,b.created_at,b.context,NULL::jsonb,false,0,'BLOCKED_INBOUND' AS kind
          FROM ai_customer_inbound_execution b WHERE b.conversation_id=${request.params.id} AND NOT EXISTS(SELECT 1 FROM ai_customer_proposal p WHERE p.event_id=b.event_id)
        ) e LEFT JOIN ai_customer_action a ON a.proposal_id=e.id AND e.kind='CUSTOMER_PROPOSAL'
        LEFT JOIN ai_customer_handoff_action h ON h.proposal_id=e.id AND e.kind='CUSTOMER_PROPOSAL'
        LEFT JOIN ai_customer_send_action s ON s.proposal_id=e.id AND e.kind='CUSTOMER_PROPOSAL'
        LEFT JOIN conversation_message sm ON sm.id=s.message_id AND sm.conversation_id=s.conversation_id
        LEFT JOIN ai_handoff_safety_stop stop ON stop.action_id=h.id
        LEFT JOIN ai_misunderstanding_observation o ON o.proposal_id=e.id AND e.kind='CUSTOMER_PROPOSAL'
        WHERE e.conversation_id=${request.params.id} AND e.lead_id=${access.lead.id}
          AND e.organization_id=${actor.organizationId} AND e.branch_id=${access.lead.branch_id} AND e.campaign_id=${access.lead.campaign_id}
          AND (${cursor?.timestamp ?? null}::text::timestamptz IS NULL OR (e.created_at,e.id)<(${cursor?.timestamp ?? null}::text::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY e.created_at DESC,e.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit), last = items.at(-1);
      await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${access.lead.branch_id},${actor.id},'AI_CUSTOMER_HISTORY_READ','CONVERSATION',${request.params.id},${tx.json({ leadId: access.lead.id, count: items.length })})`;
      return { items: items.map(e => {
        const action = e.action_id ? { id: e.action_id, tool: e.action_tool, state: e.action_state, errorCode: e.action_error, createdAt: e.action_created_at, safetyStopped: !e.qualification_action_id && e.safety_stopped,
          messageId: e.send_message_id ?? null, deliveryState: e.send_delivery_state ?? null } : null;
        const actions = action ? [action] : [];
        if (e.qualification_action_id && e.handoff_id) actions.push({ id: e.handoff_id, tool: e.handoff_tool, state: e.handoff_state, errorCode: e.handoff_error, createdAt: e.handoff_created_at, safetyStopped: e.safety_stopped, messageId: null, deliveryState: null });
        return { id: e.id, sourceMessageId: e.message_id, sourceEventId: e.event_id, assistant: 'AI_LEAD_ASSISTANT', state: e.state,
        errorCode: e.error_code, contextHash: e.context_hash, knowledgeVersion: e.knowledge_version, createdAt: e.created_at, stale: e.stale,
        kind: e.kind, attemptCount: e.attempt_count, providerInvoked: e.provider_invoked,
        // A qualification candidate may refer to a Field hidden from this employee. Never expose its value, question or schema here.
        proposal: e.result ? { decision: e.result.decision, handoffReason: e.result.handoffReason,
          answer: e.result.decision === 'ANSWER' ? e.result.referenceIds.map((id: string) => e.context.references.find((r: { id: string; text: string }) => r.id === id)?.text ?? '').join('\n\n') : null } : null,
        misunderstanding: e.misunderstanding_count ? { count: e.misunderstanding_count, threshold: e.misunderstanding_threshold,
          handoffRequired: e.misunderstanding_required, conversationVersion: e.misunderstanding_version } : null,
        action, actions, toolsExecuted: actions.filter(a => a.state === 'APPLIED').map(a => a.tool), sendAllowed: false, mutationsAllowed: false };
      }),
        nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.cursor_at, id: last.id }) : null,
        liveTransferEnabled: false, runtimeReady: false };
    });
  });
}
