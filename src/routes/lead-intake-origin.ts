import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { TransactionSql } from 'postgres';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,requireRole,type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';

async function lockIntakeLead(tx:TransactionSql,request:FastifyRequest,actor:Principal,id:string,recover=false){
  const [initial]=await tx`SELECT branch_id FROM lead WHERE id=${id} AND organization_id=${actor.organizationId}
    AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId}) AND (${actor.role!=='AGENT'} OR assigned_agent_id=${actor.id})`;
  if(!initial)throw new HttpError(404,'LEAD_NOT_FOUND');
  if(recover)await tx`SELECT id FROM branch WHERE id=${initial.branch_id} FOR UPDATE`;
  else await tx`SELECT id FROM branch WHERE id=${initial.branch_id} FOR SHARE`;
  const session=await currentPaymentSession(tx,actor,request);
  if(!session)throw new HttpError(403,'LEAD_INTAKE_ACCESS_REVOKED');
  const [lead]=await tx`SELECT id,branch_id,campaign_id,source_kind,lifecycle FROM lead WHERE id=${id} AND organization_id=${actor.organizationId}
    AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId}) AND (${actor.role!=='AGENT'} OR assigned_agent_id=${actor.id}) FOR SHARE`;
  if(!lead)throw new HttpError(404,'LEAD_NOT_FOUND');
  if(lead.branch_id!==initial.branch_id)throw new HttpError(409,'LEAD_INTAKE_CONTEXT_CHANGED');
  return {lead,session};
}

export function registerLeadIntakeOriginRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Params: { id: string } }>('/api/leads/:id/intake-origin', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async request => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => {
      const {lead}=await lockIntakeLead(tx,request,actor,request.params.id);
      const receipt = lead.source_kind==='MESSAGING_INBOUND' ? (await tx`SELECT r.event_id AS id,'RETURNING_INBOUND' AS origin_kind,
          r.created_at,'MESSAGING_INBOUND' AS source_kind,jsonb_build_object('method',h.method,'reason',h.reason,'ownerId',h.new_agent_id) AS routing
        FROM messaging_returning_lead_intake r JOIN LATERAL (SELECT method,reason,new_agent_id FROM assignment_history
          WHERE lead_id=r.lead_id ORDER BY id LIMIT 1) h ON true
        WHERE r.lead_id=${lead.id} AND r.organization_id=${actor.organizationId}
          AND (${actor.role==='SUPER_ADMIN'} OR (r.branch_id,r.campaign_id)=(${lead.branch_id},${lead.campaign_id}))`)[0]
        : (await tx`SELECT id,origin_kind,created_at,context->'source'->>'kind' AS source_kind,context->'routing' AS routing
          FROM lead_intake_receipt WHERE lead_id=${lead.id} AND (${actor.role==='SUPER_ADMIN'} OR
            (context->'scope'->>'branchId'=${lead.branch_id}::text AND context->'scope'->>'campaignId'=${lead.campaign_id}::text))`)[0];
      const admission = receipt && receipt.origin_kind!=='RETURNING_INBOUND' ? (await tx`SELECT id,state,blockers,created_at,context->'knowledge'->'version' AS knowledge_version,
        context->'availability'->'ownerAvailable' AS owner_available,context->'effective'->'handoff'->'initialContactWithoutAgent' AS without_agent,
        context->'sender'->>'reason' AS sender_reason,
        (context->'scope'->>'branchId',context->'scope'->>'campaignId')=(${lead.branch_id}::text,${lead.campaign_id}::text) AS current_scope
        FROM ai_initial_admission WHERE receipt_id=${receipt.id}`)[0] : null;
      const runtime=admission?(await tx`SELECT j.state AS job_state,j.version AS job_version,j.failure_count,j.error_code AS job_error,a.id AS action_id,a.state AS action_state,a.error_code,a.conversation_id,a.message_id,m.delivery_state,m.last_error_code
        FROM ai_initial_job j LEFT JOIN ai_initial_send_action a ON a.admission_id=j.admission_id LEFT JOIN conversation_message m ON m.id=a.message_id WHERE j.admission_id=${admission.id}`)[0]??null:null;
      await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id)
        VALUES(${actor.organizationId},${lead.branch_id},${actor.id},'LEAD_INTAKE_ORIGIN_READ','LEAD',${lead.id})`;
      return { origin: receipt ? { id: receipt.id, originKind: receipt.origin_kind, sourceKind: receipt.source_kind, createdAt: receipt.created_at,
        routing: { method: receipt.routing.method, reason: receipt.routing.reason, ownerId: receipt.routing.ownerId },
        initialAI: admission ? { id: admission.id, state: admission.state, blockers: admission.blockers, createdAt: admission.created_at,
          knowledgeVersion: admission.knowledge_version, ownerAvailable: admission.owner_available, initialContactWithoutAgent: admission.without_agent,
          senderReason: admission.sender_reason, runtimeStarted:runtime!==null,sendAuthorized:runtime?.action_state==='APPLIED',liveTransferEnabled:false,
          runtime:runtime?{jobState:runtime.job_state,jobVersion:runtime.job_version,failureCount:runtime.failure_count,errorCode:runtime.error_code??runtime.job_error??runtime.last_error_code,
            canRequestRecovery:actor.role!=='AGENT'&&lead.lifecycle==='OPEN'&&admission.current_scope===true&&runtime.job_state==='DEAD_LETTER'&&!runtime.action_id,
            actionState:runtime.action_state,conversationId:runtime.conversation_id,messageId:runtime.message_id,deliveryState:runtime.delivery_state}:null } : null } : null };
    });
  });
  app.post<{Params:{id:string;admissionId:string};Body:{version:number;reason:string}}>(
    '/api/leads/:id/intake-origin/initial-ai/:admissionId/retry',{
      preValidation:async request=>{
        if(!request.body||!Number.isInteger(request.body.version)||typeof request.body.reason!=='string')
          throw new HttpError(400,'INVALID_AI_INITIAL_RECOVERY');
      },
      schema:{
        params:{type:'object',additionalProperties:false,required:['id','admissionId'],properties:{id:{type:'string',format:'uuid'},admissionId:{type:'string',format:'uuid'}}},
        body:{type:'object',additionalProperties:false,required:['version','reason'],properties:{
          version:{type:'integer',minimum:2},reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$'},
        }},
      },
    },async request=>{
      const actor=await principalFromRequest(request,db);
      requireRole(actor,'SUPER_ADMIN','MANAGER');
      const reason=request.body.reason.trim();
      if([...reason].length<3||/\p{Cc}/u.test(reason))throw new HttpError(400,'INVALID_AI_INITIAL_RECOVERY');
      try{
        return await db.begin(async tx=>{
          await tx`SET LOCAL lock_timeout='750ms'`;
          const {lead,session}=await lockIntakeLead(tx,request,actor,request.params.id,true);
          const {admissionId}=request.params,{version}=request.body;
          const [job]=await tx`SELECT j.version,j.state FROM ai_initial_job j JOIN ai_initial_admission a ON a.id=j.admission_id
            JOIN lead_intake_receipt i ON i.id=a.receipt_id WHERE j.admission_id=${admissionId} AND i.lead_id=${lead.id}`;
          if(!job)throw new HttpError(404,'AI_INITIAL_JOB_NOT_FOUND');
          if(job.version!==version)throw new HttpError(409,'AI_INITIAL_RECOVERY_VERSION_CONFLICT');
          if(job.state!=='DEAD_LETTER')throw new HttpError(409,'AI_INITIAL_RECOVERY_UNAVAILABLE');
          await tx`INSERT INTO ai_initial_job_recovery(admission_id,job_version,actor_id,session_id,reason)
            VALUES(${admissionId},${version},${actor.id},${session},${reason})`;
          return {state:'WAITING',version:version+1};
        });
      }catch(error){
        const {code,message}=error as {code?:string;message?:string};
        if(code==='55P03'||code==='40P01')throw new HttpError(409,'AI_INITIAL_RECOVERY_BUSY');
        if(code==='P0001'&&message==='AI_INITIAL_RECOVERY_ACCESS_REVOKED')throw new HttpError(403,message);
        if(code==='P0001'&&message&&['AI_INITIAL_RECOVERY_UNAVAILABLE','AI_INITIAL_RECOVERY_VERSION_CONFLICT',
          'AI_INITIAL_RECOVERY_CONTEXT_CHANGED'].includes(message))throw new HttpError(409,message);
        throw error;
      }
    });
}
