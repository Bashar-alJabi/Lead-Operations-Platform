import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';

export function registerLeadIntakeOriginRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Params: { id: string } }>('/api/leads/:id/intake-origin', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async request => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => {
      const initial = (await tx`SELECT branch_id FROM lead WHERE id=${request.params.id} AND organization_id=${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR branch_id=${actor.branchId}) AND (${actor.role !== 'AGENT'} OR assigned_agent_id=${actor.id})`)[0];
      if (!initial) throw new HttpError(404, 'LEAD_NOT_FOUND');
      await tx`SELECT id FROM branch WHERE id=${initial.branch_id} FOR SHARE`;
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'LEAD_INTAKE_ACCESS_REVOKED');
      const lead = (await tx`SELECT id,branch_id FROM lead WHERE id=${request.params.id} AND organization_id=${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR branch_id=${actor.branchId}) AND (${actor.role !== 'AGENT'} OR assigned_agent_id=${actor.id}) FOR SHARE`)[0];
      if (!lead) throw new HttpError(404, 'LEAD_NOT_FOUND');
      if (lead.branch_id !== initial.branch_id) throw new HttpError(409, 'LEAD_INTAKE_CONTEXT_CHANGED');
      const receipt = (await tx`SELECT id,origin_kind,created_at,context->'source'->>'kind' AS source_kind,context->'routing' AS routing
        FROM lead_intake_receipt WHERE lead_id=${lead.id}`)[0];
      const admission = receipt ? (await tx`SELECT id,state,blockers,created_at,context->'knowledge'->'version' AS knowledge_version,
        context->'availability'->'ownerAvailable' AS owner_available,context->'effective'->'handoff'->'initialContactWithoutAgent' AS without_agent,
        context->'sender'->>'reason' AS sender_reason FROM ai_initial_admission WHERE receipt_id=${receipt.id}`)[0] : null;
      const runtime=admission?(await tx`SELECT j.state AS job_state,j.failure_count,j.error_code AS job_error,a.id AS action_id,a.state AS action_state,a.error_code,a.conversation_id,a.message_id,m.delivery_state,m.last_error_code
        FROM ai_initial_job j LEFT JOIN ai_initial_send_action a ON a.admission_id=j.admission_id LEFT JOIN conversation_message m ON m.id=a.message_id WHERE j.admission_id=${admission.id}`)[0]??null:null;
      await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id)
        VALUES(${actor.organizationId},${lead.branch_id},${actor.id},'LEAD_INTAKE_ORIGIN_READ','LEAD',${lead.id})`;
      return { origin: receipt ? { id: receipt.id, originKind: receipt.origin_kind, sourceKind: receipt.source_kind, createdAt: receipt.created_at,
        routing: { method: receipt.routing.method, reason: receipt.routing.reason, ownerId: receipt.routing.ownerId },
        initialAI: admission ? { id: admission.id, state: admission.state, blockers: admission.blockers, createdAt: admission.created_at,
          knowledgeVersion: admission.knowledge_version, ownerAvailable: admission.owner_available, initialContactWithoutAgent: admission.without_agent,
          senderReason: admission.sender_reason, runtimeStarted:runtime!==null,sendAuthorized:runtime?.action_state==='APPLIED',liveTransferEnabled:false,
          runtime:runtime?{jobState:runtime.job_state,failureCount:runtime.failure_count,errorCode:runtime.error_code??runtime.job_error??runtime.last_error_code,
            actionState:runtime.action_state,conversationId:runtime.conversation_id,messageId:runtime.message_id,deliveryState:runtime.delivery_state}:null } : null } : null };
    });
  });
}
