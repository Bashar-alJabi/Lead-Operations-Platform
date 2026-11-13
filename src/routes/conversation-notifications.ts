import type {FastifyInstance,FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest,requireRole,type Principal} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {decodeCursor,encodeCursor} from '../pagination.js';
async function access(tx:postgres.TransactionSql,actor:Principal,id:string,request:FastifyRequest){
 const original=(await tx`SELECT l.id,l.branch_id,l.campaign_id FROM conversation cv JOIN lead l ON l.id=cv.lead_id WHERE cv.id=${id}
  AND l.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId})`)[0];
 if(!original)throw new HttpError(404,'CONVERSATION_NOT_FOUND');
 await tx`SELECT id FROM branch WHERE id=${original.branch_id} FOR SHARE`;
 await tx`SELECT id FROM lead WHERE id=${original.id} FOR SHARE`;
 await tx`SELECT id FROM campaign WHERE id=${original.campaign_id} FOR SHARE`;
 await tx`SELECT id FROM conversation WHERE id=${id} FOR SHARE`;
 if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
 const l=(await tx`SELECT l.id,l.branch_id,l.campaign_id FROM conversation cv JOIN lead l ON l.id=cv.lead_id
  JOIN campaign c ON c.id=l.campaign_id AND c.branch_id=l.branch_id AND c.organization_id=l.organization_id WHERE cv.id=${id}
   AND l.id=${original.id} AND l.branch_id=${original.branch_id} AND l.campaign_id=${original.campaign_id} AND l.organization_id=${actor.organizationId}
   AND (${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId}) AND (${actor.role!=='AGENT'} OR l.assigned_agent_id=${actor.id})`)[0];
 if(!l)throw new HttpError(404,'CONVERSATION_NOT_FOUND');return l;
}
export function registerConversationNotificationRoutes(app:FastifyInstance,db:Database){
 const ids={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'},sourceId:{type:'string',format:'uuid'}}} as const;
 app.get<{Params:{id:string};Querystring:{limit?:number;cursor?:string}}>('/api/conversations/:id/notification-delivery',{schema:{params:ids,querystring:{type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:50},cursor:{type:'string',maxLength:256}}}}},async request=>{
  const actor=await principalFromRequest(request,db),cursor=decodeCursor(request.query.cursor),limit=request.query.limit??10;
  return db.begin(async tx=>{
   const l=await access(tx,actor,request.params.id,request);
   const rows=await tx`SELECT s.id,s.reason_code,s.created_at,s.created_at::text AS cursor_at,q.version,q.state,q.failure_count,q.next_run_at,e.id AS event_id
    FROM conversation_attention_transition s LEFT JOIN conversation_attention_queue q ON q.source_id=s.id
    LEFT JOIN notification_event e ON e.event_type='CONVERSATION_NEEDS_ATTENTION' AND e.source_id=s.id
    WHERE s.conversation_id=${request.params.id} AND s.lead_id=${l.id} AND s.organization_id=${actor.organizationId} AND s.branch_id=${l.branch_id} AND s.campaign_id=${l.campaign_id}
     AND (${cursor?.timestamp??null}::text::timestamptz IS NULL OR (s.created_at,s.id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
    ORDER BY s.created_at DESC,s.id DESC LIMIT ${limit+1}`;
   const page=rows.slice(0,limit),last=page.at(-1);return {items:page.map(r=>({id:r.id,reasonCode:r.reason_code,createdAt:r.created_at,eventId:r.event_id,
    version:r.version,state:r.state??'CLEARED',failureCount:r.failure_count??0,nextRunAt:r.state==='QUEUED'?r.next_run_at:null})),nextCursor:rows.length>limit&&last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};
  });
 });
 const sourceParams={...ids,required:['id','sourceId']} as const;
 app.get<{Params:{id:string;sourceId:string};Querystring:{before?:number}}>('/api/conversations/:id/notification-delivery/:sourceId/history',{schema:{params:sourceParams,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   await access(tx,actor,request.params.id,request);
   if(!(await tx`SELECT 1 FROM conversation_attention_transition s WHERE s.id=${request.params.sourceId} AND s.conversation_id=${request.params.id} AND conversation_attention_scope(s.id)`).length)throw new HttpError(404,'NOTIFICATION_SOURCE_NOT_FOUND');
   const rows=await tx`SELECT version,snapshot->>'state' AS state,(snapshot->>'failure_count')::integer AS failure_count,created_at FROM conversation_attention_queue_history WHERE source_id=${request.params.sourceId}
    AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT 11`;
   return {items:rows.slice(0,10),nextVersion:rows.length>10?rows[9]!.version:null};
  });
 });
 app.post<{Params:{id:string;sourceId:string};Body:{version:number}}>('/api/conversations/:id/notification-delivery/:sourceId/retry',{schema:{params:sourceParams,body:{type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1,maximum:2147483646}}}}},async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');return db.begin(async tx=>{
   await access(tx,actor,request.params.id,request);
   const q=(await tx`SELECT q.version,q.state FROM conversation_attention_queue q JOIN conversation_attention_transition s ON s.id=q.source_id
    WHERE s.id=${request.params.sourceId} AND s.conversation_id=${request.params.id} AND conversation_attention_scope(s.id) FOR UPDATE OF q`)[0];
   if(!q)throw new HttpError(404,'NOTIFICATION_SOURCE_NOT_FOUND');if(q.version!==request.body.version)throw new HttpError(409,'NOTIFICATION_VERSION_CONFLICT');
   if(q.state!=='DEAD_LETTER')throw new HttpError(409,'NOTIFICATION_RETRY_NOT_AVAILABLE');
   const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
   await tx`UPDATE conversation_attention_queue SET version=version+1,operation='RETRY',actor_id=${actor.id},session_id=${session} WHERE source_id=${request.params.sourceId}`;
   return {version:q.version+1,state:'QUEUED'};
  });
 });
}
