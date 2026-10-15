import type {FastifyInstance,FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest,requireRole,type Principal} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {approvedConversationReadContext} from '../ai/copilot-context.js';
async function access(tx:postgres.TransactionSql,a:Principal,id:string,request:FastifyRequest){
 const initial=(await tx`SELECT l.branch_id FROM conversation cv JOIN lead l ON l.id=cv.lead_id WHERE cv.id=${id} AND l.organization_id=${a.organizationId}
  AND (${a.role==='SUPER_ADMIN'} OR l.branch_id=${a.branchId}) AND (${a.role!=='AGENT'} OR l.assigned_agent_id=${a.id})`)[0];
 if(!initial)throw new HttpError(404,'CONVERSATION_NOT_FOUND');
 if(!(await tx`SELECT id FROM branch WHERE id=${initial.branch_id} AND organization_id=${a.organizationId} FOR SHARE`).length)throw new HttpError(404,'CONVERSATION_NOT_FOUND');
 const session=await currentPaymentSession(tx,a,request);if(!session)throw new HttpError(403,'HANDOFF_SLA_ACCESS_REVOKED');
 const ctx=await approvedConversationReadContext(tx,a,id,session);
 const timer=(await tx`SELECT t.action_id,t.version,t.state,t.reason_code,t.started_at,t.cursor_at,t.elapsed_microseconds::text,t.clock,t.revision,t.updated_at,
   q.version AS queue_version,q.failure_count,q.error_code,CASE WHEN q.next_run_at='infinity' THEN NULL ELSE q.next_run_at END AS next_run_at,
   cv.state='WAITING_FOR_HUMAN' AND cv.controller_type='NONE' AND cv.ai_handoff_action_id=t.action_id AS waiting
  FROM ai_handoff_sla_timer t JOIN conversation cv ON cv.id=t.conversation_id JOIN ai_handoff_sla_queue q ON q.action_id=t.action_id
  WHERE cv.id=${id} AND t.lead_id=${ctx.lead.id} AND t.campaign_id=${ctx.lead.campaign_id}
   AND t.branch_id=${ctx.lead.branch_id} AND t.organization_id=${a.organizationId}
  ORDER BY (t.action_id=cv.ai_handoff_action_id) DESC NULLS LAST,t.started_at DESC,t.action_id DESC LIMIT 1`)[0]??null;
 return {ctx,timer,session};
}
export function registerHandoffSLARoutes(app:FastifyInstance,db:Database){
 const root='/api/conversations/:id/handoff-sla',params={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}} as const;
 app.get<{Params:{id:string}}>(root,{schema:{params}},async request=>{
  const a=await principalFromRequest(request,db);return db.begin(async tx=>{
   const {timer:t}=await access(tx,a,request.params.id,request);
   return {timer:t?{actionId:t.action_id,version:t.version,state:t.state,reason:t.reason_code,startedAt:t.started_at,cursorAt:t.cursor_at,elapsedMicroseconds:t.elapsed_microseconds,
    clock:t.clock,revision:t.revision,updatedAt:t.updated_at,waiting:Boolean(t.waiting),queue:{version:t.queue_version,failureCount:t.failure_count,errorCode:t.error_code,nextRunAt:t.next_run_at},
    canRetry:a.role!=='AGENT'&&t.waiting&&t.failure_count>0&&!['EXPIRED','CANCELLED'].includes(t.state)}:null,notificationsImplemented:true};
  });
 });
 app.get<{Params:{id:string};Querystring:{before?:number;limit?:number}}>(root+'/history',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:50}}}}},async request=>{
  const a=await principalFromRequest(request,db);return db.begin(async tx=>{
   const {timer}=await access(tx,a,request.params.id,request);if(!timer)return {items:[],nextVersion:null};const limit=request.query.limit??10;
   const rows=await tx`SELECT version,snapshot->>'state' AS state,snapshot->>'reason_code' AS reason,snapshot->>'elapsed_microseconds' AS elapsed_microseconds,
    snapshot->'revision' AS revision,snapshot->'clock' AS clock,created_at FROM ai_handoff_sla_history WHERE action_id=${timer.action_id}
    AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT ${limit+1}`;
   return {items:rows.slice(0,limit),nextVersion:rows.length>limit?rows[limit-1]!.version:null};
  });
 });
 app.post<{Params:{id:string};Body:{version:number;reason:string}}>(root+'/retry',{preValidation:async r=>{
  const b=r.body as Record<string,unknown>|null;if(!b||typeof b.version!=='number'||!Number.isInteger(b.version)||typeof b.reason!=='string')throw new HttpError(400,'INVALID_HANDOFF_SLA_RECOVERY');
 },schema:{params,body:{type:'object',additionalProperties:false,required:['version','reason'],properties:{version:{type:'integer',minimum:1},reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\x00-\x1f\x7f]+$'}}}}},async request=>{
  const a=await principalFromRequest(request,db);requireRole(a,'SUPER_ADMIN','MANAGER');const reason=request.body.reason.trim();if(reason.length<3)throw new HttpError(400,'HANDOFF_SLA_REASON_REQUIRED');
  return db.begin(async tx=>{
   // Queue-before-parent matches the worker lock order. Recheck real session/parent after waiting.
   const q=(await tx`SELECT q.action_id,q.version,t.branch_id FROM ai_handoff_sla_queue q JOIN ai_handoff_sla_timer t ON t.action_id=q.action_id JOIN conversation cv ON cv.id=t.conversation_id
    JOIN lead l ON l.id=cv.lead_id WHERE cv.id=${request.params.id} AND cv.ai_handoff_action_id=t.action_id AND l.organization_id=${a.organizationId}
     AND (${a.role==='SUPER_ADMIN'} OR l.branch_id=${a.branchId}) FOR UPDATE OF q`)[0];
   if(q)await tx`SELECT id FROM branch WHERE id=${q.branch_id} FOR UPDATE`;
   const {timer,session}=await access(tx,a,request.params.id,request);if(!q||!timer||timer.action_id!==q.action_id)throw new HttpError(404,'HANDOFF_SLA_NOT_FOUND');
   if(!timer.waiting||['EXPIRED','CANCELLED'].includes(timer.state)||timer.failure_count===0)throw new HttpError(409,'HANDOFF_SLA_RECOVERY_UNAVAILABLE');
   if(q.version!==request.body.version)throw new HttpError(409,'HANDOFF_SLA_VERSION_CONFLICT');
   await tx`UPDATE ai_handoff_sla_queue SET version=version+1,operation='HUMAN_RETRY',actor_id=${a.id},session_id=${session},reason=${reason} WHERE action_id=${q.action_id}`;
   return {version:q.version+1};
  });
 });
}
