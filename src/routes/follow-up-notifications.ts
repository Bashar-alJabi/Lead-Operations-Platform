import type {FastifyInstance,FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest,requireRole,type Principal} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';

async function access(tx:postgres.TransactionSql,actor:Principal,id:string,request:FastifyRequest){
 const initial=(await tx`SELECT l.id,l.branch_id,l.campaign_id FROM follow_up f JOIN lead l ON l.id=f.lead_id
  WHERE f.id=${id} AND l.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId})`)[0];
 if(!initial)throw new HttpError(404,'FOLLOW_UP_NOT_FOUND');
 await tx`SELECT id FROM branch WHERE id=${initial.branch_id} FOR SHARE`;
 await tx`SELECT id FROM lead WHERE id=${initial.id} FOR SHARE`;
 await tx`SELECT id FROM campaign WHERE id=${initial.campaign_id} FOR SHARE`;
 const f=(await tx`SELECT f.id FROM follow_up f JOIN lead l ON l.id=f.lead_id JOIN campaign c ON c.id=l.campaign_id AND c.branch_id=l.branch_id AND c.organization_id=l.organization_id
  WHERE f.id=${id} AND l.id=${initial.id} AND l.branch_id=${initial.branch_id} AND l.campaign_id=${initial.campaign_id} AND l.organization_id=${actor.organizationId}
   AND (${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId}) AND (${actor.role!=='AGENT'} OR l.assigned_agent_id=${actor.id} AND f.owner_user_id=${actor.id}) FOR SHARE OF f`)[0];
 const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
 if(!f)throw new HttpError(404,'FOLLOW_UP_NOT_FOUND');return session;
}
export function registerFollowUpNotificationRoutes(app:FastifyInstance,db:Database){
 const params={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}} as const;
 app.get<{Params:{id:string};Querystring:{before?:number}}>('/api/followups/:id/notification',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   await access(tx,actor,request.params.id,request);
   const q=(await tx`SELECT version,state,failure_count,next_run_at,last_failure_at,updated_at FROM follow_up_notification_queue WHERE follow_up_id=${request.params.id}`)[0];
   const rows=await tx`SELECT version,snapshot->>'operation' AS operation,snapshot->>'state' AS state,(snapshot->>'failure_count')::integer AS failure_count,created_at
    FROM follow_up_notification_history WHERE follow_up_id=${request.params.id} AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT 11`;
   return {queue:q?{version:q.version,state:q.state,failureCount:q.failure_count,nextRunAt:q.state==='WAITING'?q.next_run_at:null,lastFailureAt:q.last_failure_at,updatedAt:q.updated_at}:null,
    history:rows.slice(0,10),nextVersion:rows.length>10?rows[9]!.version:null};
  });
 });
 app.post<{Params:{id:string};Body:{version:number}}>('/api/followups/:id/notification/retry',{schema:{params,body:{type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1,maximum:2147483646}}}}},async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');
  return db.begin(async tx=>{
   const session=await access(tx,actor,request.params.id,request);
   const q=(await tx`SELECT version,state FROM follow_up_notification_queue WHERE follow_up_id=${request.params.id} FOR UPDATE`)[0];
   if(!q||q.version!==request.body.version)throw new HttpError(409,'FOLLOW_UP_NOTIFICATION_VERSION_CONFLICT');
   if(q.state!=='DEAD_LETTER')throw new HttpError(409,'FOLLOW_UP_NOTIFICATION_RETRY_NOT_AVAILABLE');
   await tx`UPDATE follow_up_notification_queue SET version=version+1,operation='RETRY',actor_id=${actor.id},session_id=${session} WHERE follow_up_id=${request.params.id}`;
   return {version:q.version+1,state:'WAITING'};
  });
 });
}
