import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { currentPaymentSession } from '../payments/access.js';
import { isOperationalNotification, notificationEvents, requireNotificationBodyTypes, type NotificationEventType, type NotificationLanguage } from '../notifications.js';
import { HttpError, principalFromRequest, requireRole, type Principal } from '../security.js';

type Tx=postgres.TransactionSql;
type BindingKey={branchId:string;event:NotificationEventType;language:NotificationLanguage};
type PreferenceKey={event:NotificationEventType};
type HistoryQuery={before?:number};
const root='/api/notification-messaging';
const uuid={type:'string',format:'uuid'} as const;
const event={type:'string',enum:notificationEvents} as const;
const language={type:'string',enum:['ar','en','fr']} as const;
const version={type:'integer',minimum:0,maximum:2147483646} as const;
const enabled={type:'boolean'} as const;
const bindingParams={type:'object',additionalProperties:false,required:['branchId','event','language'],properties:{branchId:uuid,event,language}} as const;
const preferenceParams={type:'object',additionalProperties:false,required:['event'],properties:{event}} as const;
const historyQuery={type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}} as const;

async function currentSession(tx:Tx,actor:Principal,request:FastifyRequest) {
 const session=await currentPaymentSession(tx,actor,request);
 if(!session)throw new HttpError(403,'STAFF_MESSAGING_ACCESS_DENIED');
 return session;
}
async function branchAccess(tx:Tx,actor:Principal,branchId:string) {
 requireRole(actor,'SUPER_ADMIN','MANAGER');
 if(!(await tx`SELECT id FROM branch WHERE id=${branchId} AND organization_id=${actor.organizationId}
  AND (${actor.role==='SUPER_ADMIN'} OR id=${actor.branchId}) FOR SHARE`).length)throw new HttpError(404,'BRANCH_NOT_FOUND');
}
async function history(tx:Tx,kind:'BINDING'|'PREFERENCE',id:string,eventType:NotificationEventType,keyLanguage:string,before?:number) {
 const rows=await tx`SELECT version,snapshot,changed_at AS "changedAt" FROM staff_messaging_configuration_history
  WHERE kind=${kind} AND resource_id=${id} AND event_type=${eventType} AND key_language=${keyLanguage}
   AND (${before??null}::integer IS NULL OR version<${before??null}) ORDER BY version DESC LIMIT 21`;
 return {items:rows.slice(0,20),nextVersion:rows.length>20?rows[19]!.version:null};
}
async function configured<T>(change:()=>Promise<T>) {
 try{return await change();}catch(error){
  const code=error instanceof Error?error.message:'';
  if(code==='STAFF_MESSAGING_ACCESS_DENIED')throw new HttpError(403,code);
  if(['STAFF_MESSAGING_CONSENT_REQUIRED','STAFF_MESSAGING_TEMPLATE_UNAVAILABLE','STAFF_MESSAGING_DISABLED_BINDING','STAFF_MESSAGING_VERSION_CONFLICT'].includes(code))
   throw new HttpError(409,code);
  throw error;
 }
}

export function registerStaffMessagingConfigurationRoutes(app:FastifyInstance,db:Database) {
 const binding=root+'/branches/:branchId/bindings/:event/:language';
 app.get<{Params:BindingKey}>(binding,{schema:{params:bindingParams}},async request=>{
  const actor=await principalFromRequest(request,db),p=request.params;
  return db.begin(async tx=>{
   await branchAccess(tx,actor,p.branchId);await currentSession(tx,actor,request);
   const [row]=await tx`SELECT b.sender_id AS "senderId",b.template_id AS "templateId",b.version,b.enabled,b.reason,
    t.name AS "templateName",s.display_name AS "senderName",c.status AS "connectionStatus",
    (t.active AND t.status='APPROVED' AND encode(sha256(convert_to(jsonb_build_array(t.external_template_id,t.name,t.language,t.components)::text,'UTF8')),'hex')=b.template_digest)
      AS "templateCurrent" FROM staff_messaging_binding b JOIN provider_message_template t ON t.id=b.template_id
    JOIN messaging_sender s ON s.id=b.sender_id JOIN integration_connection c ON c.id=s.connection_id
    WHERE b.branch_id=${p.branchId} AND b.event_type=${p.event} AND b.language=${p.language}`;
   return {binding:row??null};
  });
 });
 app.get<{Params:BindingKey;Querystring:{after?:string}}>(binding+'/options',{schema:{params:bindingParams,
  querystring:{type:'object',additionalProperties:false,properties:{after:{type:'string',pattern:'^[0-9a-f-]{36}:[0-9a-f-]{36}$'}}}}},async request=>{
  const actor=await principalFromRequest(request,db),p=request.params;
  const [afterSender,afterTemplate]=(request.query.after??'').split(':');
  return db.begin(async tx=>{
   await branchAccess(tx,actor,p.branchId);await currentSession(tx,actor,request);
   const items=await tx`SELECT r.sender_id AS "senderId",t.id AS "templateId",ms.display_name AS "senderName",
     t.name AS "templateName",t.language AS "providerLanguage",staff_messaging_template_copy(t.components) AS preview
    FROM staff_messaging_sender r JOIN messaging_sender ms ON ms.id=r.sender_id AND ms.active AND ms.capabilities->'template'='true'::jsonb
    JOIN integration_connection c ON c.id=r.connection_id AND c.branch_id=r.branch_id AND c.status IN ('CONNECTED','WARNING')
    JOIN provider_message_template t ON t.connection_id=c.id AND t.active AND t.status='APPROVED'
      AND lower(split_part(replace(t.language,'-','_'),'_',1))=${p.language} AND staff_messaging_template_copy(t.components) IS NOT NULL
    WHERE r.branch_id=${p.branchId} AND r.organization_id=${actor.organizationId}
     AND (${afterSender||null}::text IS NULL OR (r.sender_id::text,t.id::text)>(${afterSender||null},${afterTemplate||null}))
    ORDER BY r.sender_id,t.id LIMIT 26`;
   const last=items[24];
   return {items:items.slice(0,25),nextCursor:items.length>25?last!.senderId+':'+last!.templateId:null};
  });
 });
 app.put<{Params:BindingKey;Body:{version:number;enabled:boolean;senderId:string;templateId:string;reason:string}}>(binding,{
  preValidation:async request=>requireNotificationBodyTypes(request.body,'enabled',['senderId','templateId','reason']),
  schema:{params:bindingParams,body:{type:'object',additionalProperties:false,required:['version','enabled','senderId','templateId','reason'],
   properties:{version,enabled,senderId:uuid,templateId:uuid,reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$'}}}},
 },async request=>{
  const actor=await principalFromRequest(request,db),p=request.params,d=request.body,reason=d.reason.trim();
  if(reason.length<3)throw new HttpError(400,'STAFF_MESSAGING_REASON_REQUIRED');
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  return configured(()=>db.begin(async tx=>{
   if(d.enabled)await tx`SELECT c.id FROM staff_messaging_sender r JOIN integration_connection c ON c.id=r.connection_id
    WHERE r.sender_id=${d.senderId} AND r.branch_id=${p.branchId} AND r.organization_id=${actor.organizationId}
     AND (${actor.role==='SUPER_ADMIN'} OR r.branch_id=${actor.branchId}) FOR SHARE OF c`;
   await branchAccess(tx,actor,p.branchId);
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-binding:${p.branchId}:${p.event}:${p.language}`},0))`;
   const session=await currentSession(tx,actor,request);
   const [old]=await tx`SELECT version FROM staff_messaging_binding WHERE branch_id=${p.branchId} AND event_type=${p.event} AND language=${p.language} FOR UPDATE`;
   if((old?.version??0)!==d.version)throw new HttpError(409,'STAFF_MESSAGING_VERSION_CONFLICT');
   if(old)await tx`UPDATE staff_messaging_binding SET version=version+1,enabled=${d.enabled},sender_id=${d.senderId},template_id=${d.templateId},
    reason=${reason},actor_id=${actor.id},session_id=${session} WHERE branch_id=${p.branchId} AND event_type=${p.event} AND language=${p.language}`;
   else await tx`INSERT INTO staff_messaging_binding(branch_id,organization_id,event_type,language,sender_id,template_id,enabled,version,reason,actor_id,session_id)
    VALUES(${p.branchId},${actor.organizationId},${p.event},${p.language},${d.senderId},${d.templateId},${d.enabled},1,${reason},${actor.id},${session})`;
   return {version:d.version+1};
  }));
 });
 app.get<{Params:BindingKey;Querystring:HistoryQuery}>(binding+'/history',{schema:{params:bindingParams,querystring:historyQuery}},async request=>{
  const actor=await principalFromRequest(request,db),p=request.params;
  return db.begin(async tx=>{
   await branchAccess(tx,actor,p.branchId);await currentSession(tx,actor,request);
   return history(tx,'BINDING',p.branchId,p.event,p.language,request.query.before);
  });
 });

 const pref=root+'/preferences';
 app.get(pref,async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'MANAGER','AGENT');
  return db.begin(async tx=>{
   await currentSession(tx,actor,request);
   const [destination]=await tx`SELECT (consented_since IS NOT NULL AND phone IS NOT NULL) AS consented FROM staff_messaging_destination
    WHERE user_id=${actor.id} AND organization_id=${actor.organizationId} AND branch_id=${actor.branchId} AND user_role=${actor.role}`;
   const rows=await tx`SELECT event_type AS "eventType",language,enabled,version FROM staff_messaging_preference WHERE user_id=${actor.id}`;
   return {consented:destination?.consented??false,items:notificationEvents.filter(e=>actor.role!=='AGENT'||!isOperationalNotification(e))
    .map(e=>rows.find(r=>r.eventType===e)??{eventType:e,language:'ar',enabled:false,version:0})};
  });
 });
 app.put<{Params:PreferenceKey;Body:{version:number;enabled:boolean;language:NotificationLanguage}}>(pref+'/:event',{
  preValidation:async request=>requireNotificationBodyTypes(request.body,'enabled',['language']),
  schema:{params:preferenceParams,body:{type:'object',additionalProperties:false,required:['version','enabled','language'],properties:{version,enabled,language}}},
 },async request=>{
  const actor=await principalFromRequest(request,db),e=request.params.event,d=request.body;requireRole(actor,'MANAGER','AGENT');
  if(actor.role==='AGENT'&&isOperationalNotification(e))throw new HttpError(403,'STAFF_MESSAGING_ACCESS_DENIED');
  return configured(()=>db.begin(async tx=>{
   await tx`SELECT id FROM branch WHERE id=${actor.branchId} FOR SHARE`;
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-preference:${actor.id}:${e}`},0))`;
   const session=await currentSession(tx,actor,request);
   const [old]=await tx`SELECT version FROM staff_messaging_preference WHERE user_id=${actor.id} AND event_type=${e} FOR UPDATE`;
   if((old?.version??0)!==d.version)throw new HttpError(409,'STAFF_MESSAGING_VERSION_CONFLICT');
   if(old)await tx`UPDATE staff_messaging_preference SET version=version+1,enabled=${d.enabled},language=${d.language},session_id=${session}
    WHERE user_id=${actor.id} AND event_type=${e}`;
   else await tx`INSERT INTO staff_messaging_preference(user_id,event_type,enabled,language,version,session_id)
    VALUES(${actor.id},${e},${d.enabled},${d.language},1,${session})`;
   return {version:d.version+1};
  }));
 });
 app.get<{Params:PreferenceKey;Querystring:HistoryQuery}>(pref+'/:event/history',{schema:{params:preferenceParams,querystring:historyQuery}},async request=>{
  const actor=await principalFromRequest(request,db),e=request.params.event;requireRole(actor,'MANAGER','AGENT');
  if(actor.role==='AGENT'&&isOperationalNotification(e))throw new HttpError(403,'STAFF_MESSAGING_ACCESS_DENIED');
  return db.begin(async tx=>{
   await currentSession(tx,actor,request);return history(tx,'PREFERENCE',actor.id,e,'',request.query.before);
  });
 });
}
