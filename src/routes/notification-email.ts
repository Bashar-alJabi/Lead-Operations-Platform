import type {FastifyInstance,FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest,requireRole,type Principal} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {notificationEvents,requireNotificationBodyTypes,type NotificationEventType,type NotificationLanguage} from '../notifications.js';

type Tx=postgres.TransactionSql;
const uuid={type:'string',format:'uuid'} as const;
const version={type:'integer',minimum:0,maximum:2147483646} as const;
const branchParams={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const eventParams={type:'object',additionalProperties:false,required:['event'],properties:{event:{type:'string',enum:notificationEvents}}} as const;
const historyQuery={type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}} as const;
async function session(tx:Tx,a:Principal,r:FastifyRequest){
 const sid=await currentPaymentSession(tx,a,r);if(!sid)throw new HttpError(403,'EMAIL_NOTIFICATION_ACCESS_REVOKED');return sid;
}
async function branch(tx:Tx,a:Principal,id:string,write=false){
 requireRole(a,'SUPER_ADMIN','MANAGER');
 const b=(await tx`SELECT id,active FROM branch WHERE id=${id} AND organization_id=${a.organizationId}
  AND (${a.role==='SUPER_ADMIN'} OR id=${a.branchId}) ${write?tx`FOR UPDATE`:tx`FOR SHARE`}`)[0];
 if(!b)throw new HttpError(404,'EMAIL_NOTIFICATION_BRANCH_NOT_FOUND');return b;
}
export function registerNotificationEmailRoutes(app:FastifyInstance,db:Database){
 app.get<{Params:{id:string}}>('/api/notification-email/branches/:id',{schema:{params:branchParams}},async r=>{
  const a=await principalFromRequest(r,db);return db.begin(async tx=>{
   const b=await branch(tx,a,r.params.id);await session(tx,a,r);
   const p=(await tx`SELECT b.version,b.enabled,b.connection_id,c.name,c.status,c.branch_id AS connection_branch
    FROM notification_email_binding b LEFT JOIN integration_connection c ON c.id=b.connection_id AND c.organization_id=b.organization_id
    WHERE b.branch_id=${b.id} AND b.organization_id=${a.organizationId}`)[0];
   return {branchId:b.id,branchActive:b.active,version:p?.version??0,enabled:p?.enabled??false,connectionId:p?.connection_id??null,
    connection:p?.connection_id?{id:p.connection_id,name:p.name,status:p.status,scope:p.connection_branch?'BRANCH':'ORGANIZATION'}:null,
    canEnableCurrent:a.role==='SUPER_ADMIN'||Boolean(p?.connection_branch)};
  });
 });
 app.get<{Params:{id:string};Querystring:{after?:string}}>('/api/notification-email/branches/:id/connections',{
  schema:{params:branchParams,querystring:{type:'object',additionalProperties:false,properties:{after:uuid}}}},async r=>{
  const a=await principalFromRequest(r,db);return db.begin(async tx=>{
   await branch(tx,a,r.params.id);await session(tx,a,r);
   const rows=await tx`SELECT c.id,c.name,c.status,c.branch_id,c.version FROM integration_connection c
    JOIN operational_email_connection o ON o.connection_id=c.id WHERE c.organization_id=${a.organizationId}
    AND (c.branch_id=${r.params.id} OR ${a.role==='SUPER_ADMIN'} AND c.branch_id IS NULL)
    AND (${r.query.after??null}::uuid IS NULL OR c.id>${r.query.after??null}::uuid) ORDER BY c.id LIMIT 26`;
   await session(tx,a,r);return {items:rows.slice(0,25).map(c=>({id:c.id,name:c.name,status:c.status,version:c.version,scope:c.branch_id?'BRANCH':'ORGANIZATION'})),nextCursor:rows.length>25?rows[24]!.id:null};
  });
 });
 app.put<{Params:{id:string};Body:{version:number;enabled:boolean;connectionId:string|null;reason:string}}>('/api/notification-email/branches/:id',{
  preValidation:async r=>requireNotificationBodyTypes(r.body,'enabled',['reason']),schema:{params:branchParams,body:{type:'object',additionalProperties:false,
   required:['version','enabled','connectionId','reason'],properties:{version,enabled:{type:'boolean'},connectionId:{anyOf:[uuid,{type:'null'}]},
    reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\x00-\x1f\x7f]+$'}}}}},async r=>{
  const a=await principalFromRequest(r,db);requireRole(a,'SUPER_ADMIN','MANAGER');
  const reason=r.body.reason.trim();if(reason.length<3)throw new HttpError(400,'EMAIL_NOTIFICATION_REASON_REQUIRED');
  return db.begin(async tx=>{
   // Connection -> Branch -> current actor/session. Recheck the version after every actual wait.
   const c=r.body.connectionId?(await tx`SELECT c.id,c.branch_id,c.status FROM integration_connection c JOIN operational_email_connection o ON o.connection_id=c.id
    WHERE c.id=${r.body.connectionId} AND c.organization_id=${a.organizationId} AND (c.branch_id=${r.params.id} OR c.branch_id IS NULL) FOR SHARE OF c`)[0]:null;
   if(r.body.connectionId&&!c)throw new HttpError(404,'EMAIL_NOTIFICATION_CONNECTION_NOT_FOUND');
   const b=await branch(tx,a,r.params.id,true),sid=await session(tx,a,r);
   const old=(await tx`SELECT version,connection_id FROM notification_email_binding WHERE branch_id=${b.id} FOR UPDATE`)[0];
   if((old?.version??0)!==r.body.version)throw new HttpError(409,'EMAIL_NOTIFICATION_VERSION_CONFLICT');
   if(c?.branch_id===null&&a.role==='MANAGER'&&(r.body.enabled||old?.connection_id!==c.id))throw new HttpError(403,'EMAIL_NOTIFICATION_ORGANIZATION_APPROVAL_REQUIRED');
   if(r.body.enabled&&(!b.active||c?.status!=='CONNECTED'))throw new HttpError(409,'EMAIL_NOTIFICATION_CONNECTION_NOT_READY');
   if(old)await tx`UPDATE notification_email_binding SET connection_id=${c?.id??null},enabled=${r.body.enabled},version=version+1,
    actor_id=${a.id},session_id=${sid},actor_role=${a.role},actor_branch_id=${a.branchId},reason=${reason} WHERE branch_id=${b.id}`;
   else await tx`INSERT INTO notification_email_binding(branch_id,organization_id,connection_id,enabled,version,actor_id,session_id,actor_role,actor_branch_id,reason)
    VALUES(${b.id},${a.organizationId},${c?.id??null},${r.body.enabled},1,${a.id},${sid},${a.role},${a.branchId},${reason})`;
   await session(tx,a,r);return {version:r.body.version+1};
  });
 });
 app.get<{Params:{id:string};Querystring:{before?:number}}>('/api/notification-email/branches/:id/history',{schema:{params:branchParams,querystring:historyQuery}},async r=>{
  const a=await principalFromRequest(r,db);return db.begin(async tx=>{
   await branch(tx,a,r.params.id);await session(tx,a,r);
   const rows=await tx`SELECT version,snapshot->'enabled' enabled,snapshot->>'connection_id' connection_id,snapshot->>'reason' reason,created_at
    FROM notification_email_binding_history WHERE branch_id=${r.params.id} AND (${r.query.before??null}::integer IS NULL OR version<${r.query.before??null}) ORDER BY version DESC LIMIT 21`;
   return {items:rows.slice(0,20),nextVersion:rows.length>20?rows[19]!.version:null};
  });
 });
 app.get('/api/notification-email/preferences',async r=>{
  const a=await principalFromRequest(r,db);return db.begin(async tx=>{
   await session(tx,a,r);const rows=await tx`SELECT event_type,enabled,language,version FROM notification_email_preference WHERE user_id=${a.id}`;
   return {recipient:a.email,channel:'EMAIL',items:notificationEvents.map(event=>{
    const p=rows.find(v=>v.event_type===event);return {eventType:event,enabled:p?.enabled??false,language:p?.language??'ar',version:p?.version??0,mandatory:false};
   })};
  });
 });
 app.put<{Params:{event:NotificationEventType};Body:{version:number;enabled:boolean;language:NotificationLanguage}}>('/api/notification-email/preferences/:event',{
  preValidation:async r=>requireNotificationBodyTypes(r.body,'enabled',['language']),schema:{params:eventParams,body:{type:'object',additionalProperties:false,
   required:['version','enabled','language'],properties:{version,enabled:{type:'boolean'},language:{type:'string',enum:['ar','en','fr']}}}}},async r=>{
  const a=await principalFromRequest(r,db);return db.begin(async tx=>{
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${a.id+':email-notification:'+r.params.event},0))`;
   const sid=await session(tx,a,r),p=(await tx`SELECT version FROM notification_email_preference WHERE user_id=${a.id} AND event_type=${r.params.event} FOR UPDATE`)[0];
   if((p?.version??0)!==r.body.version)throw new HttpError(409,'EMAIL_NOTIFICATION_VERSION_CONFLICT');
   if(p)await tx`UPDATE notification_email_preference SET enabled=${r.body.enabled},language=${r.body.language},version=version+1,
    session_id=${sid},actor_role=${a.role},actor_branch_id=${a.branchId} WHERE user_id=${a.id} AND event_type=${r.params.event}`;
   else await tx`INSERT INTO notification_email_preference(user_id,event_type,enabled,language,version,session_id,actor_role,actor_branch_id)
    VALUES(${a.id},${r.params.event},${r.body.enabled},${r.body.language},1,${sid},${a.role},${a.branchId})`;
   await session(tx,a,r);return {version:r.body.version+1};
  });
 });
 app.get<{Params:{event:NotificationEventType};Querystring:{before?:number}}>('/api/notification-email/preferences/:event/history',{schema:{params:eventParams,querystring:historyQuery}},async r=>{
  const a=await principalFromRequest(r,db);return db.begin(async tx=>{
   await session(tx,a,r);const rows=await tx`SELECT version,snapshot->'enabled' enabled,snapshot->>'language' language,created_at
    FROM notification_email_preference_history WHERE user_id=${a.id} AND event_type=${r.params.event}
     AND (${r.query.before??null}::integer IS NULL OR version<${r.query.before??null}) ORDER BY version DESC LIMIT 21`;
   return {items:rows.slice(0,20),nextVersion:rows.length>20?rows[19]!.version:null};
  });
 });
}
