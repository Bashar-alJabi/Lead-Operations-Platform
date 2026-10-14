import type { FastifyInstance,FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,requireRole,type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { notificationEvent,notificationDefaults,validateNotificationText,requireNotificationBodyTypes,type NotificationLanguage } from '../notifications.js';
type Scope='GLOBAL'|'BRANCH'|'CAMPAIGN';
type Params={scope:Scope;id:string;language:NotificationLanguage};
async function access(tx:postgres.TransactionSql,actor:Principal,p:Params,request:FastifyRequest,write=false) {
 requireRole(actor,'SUPER_ADMIN','MANAGER');
 if(p.scope==='GLOBAL') {
  requireRole(actor,'SUPER_ADMIN');if(p.id!==actor.organizationId)throw new HttpError(404,'NOTIFICATION_TEMPLATE_RESOURCE_NOT_FOUND');
  if(write)await tx`SELECT id FROM organization WHERE id=${p.id} FOR UPDATE`;else await tx`SELECT id FROM organization WHERE id=${p.id} FOR SHARE`;
 } else {
  const initial=p.scope==='BRANCH' ? (await tx`SELECT id AS branch_id FROM branch WHERE id=${p.id} AND organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR id=${actor.branchId})`)[0]
   : (await tx`SELECT branch_id FROM campaign WHERE id=${p.id} AND organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId})`)[0];
  if(!initial)throw new HttpError(404,'NOTIFICATION_TEMPLATE_RESOURCE_NOT_FOUND');
  const branch=write ? (await tx`SELECT active FROM branch WHERE id=${initial.branch_id} FOR UPDATE`)[0] : (await tx`SELECT active FROM branch WHERE id=${initial.branch_id} FOR SHARE`)[0];
  if(p.scope==='CAMPAIGN' && !(await tx`SELECT id FROM campaign WHERE id=${p.id} AND organization_id=${actor.organizationId} AND branch_id=${initial.branch_id} FOR SHARE`).length)throw new HttpError(404,'NOTIFICATION_TEMPLATE_RESOURCE_NOT_FOUND');
  const existing=(await tx`SELECT branch_id,organization_id FROM notification_template WHERE scope=${p.scope} AND resource_id=${p.id} AND event_type=${notificationEvent} AND channel='IN_APP' AND language=${p.language}`)[0];
  if(existing && (existing.branch_id!==initial.branch_id || existing.organization_id!==actor.organizationId))throw new HttpError(404,'NOTIFICATION_TEMPLATE_RESOURCE_NOT_FOUND');
  if(write && !branch?.active)throw new HttpError(409,'BRANCH_DISABLED');
  const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
  return {branchId:initial.branch_id as string,session};
 }
 const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
 return {branchId:null,session};
}
export function registerNotificationTemplateRoutes(app:FastifyInstance,db:Database) {
 const root='/api/notification-templates/:scope/:id/:language';
 const params={type:'object',additionalProperties:false,required:['scope','id','language'],properties:{scope:{type:'string',enum:['GLOBAL','BRANCH','CAMPAIGN']},id:{type:'string',format:'uuid'},language:{type:'string',enum:['ar','en','fr']}}} as const;
 app.get<{Params:Params}>(root,{schema:{params}},async request=>{
  const actor=await principalFromRequest(request,db),p=request.params;return db.begin(async tx=>{
   await access(tx,actor,p,request);
   const row=(await tx`SELECT title,body,active,version,reason,updated_at FROM notification_template WHERE scope=${p.scope} AND resource_id=${p.id} AND event_type=${notificationEvent} AND channel='IN_APP' AND language=${p.language}`)[0];
   const defaults=notificationDefaults[p.language];return {title:row?.title??defaults.title,body:row?.body??defaults.body,active:row?.active??false,version:row?.version??0,reason:row?.reason??null,updatedAt:row?.updated_at??null,eventType:notificationEvent,channel:'IN_APP',defaults:{title:defaults.title,body:defaults.body},tokens:['campaign','owner']};
  });
 });
 app.put<{Params:Params;Body:{title:string;body:string;active:boolean;version:number;reason:string}}>(root,{bodyLimit:16384,preValidation:async r=>requireNotificationBodyTypes(r.body,'active',['title','body','reason']),schema:{params,body:{type:'object',additionalProperties:false,required:['title','body','active','version','reason'],properties:{
  title:{type:'string',minLength:1,maxLength:160},body:{type:'string',minLength:1,maxLength:1000},active:{type:'boolean'},version:{type:'integer',minimum:0},reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\x00-\x1f\x7f]+$'}}}}},async request=>{
  const actor=await principalFromRequest(request,db),p=request.params,title=validateNotificationText(request.body.title,160),body=validateNotificationText(request.body.body,1000),reason=request.body.reason.trim();
  if(reason.length<3)throw new HttpError(400,'NOTIFICATION_REASON_REQUIRED');
  return db.begin(async tx=>{
   const a=await access(tx,actor,p,request,true),old=(await tx`SELECT version FROM notification_template WHERE scope=${p.scope} AND resource_id=${p.id} AND event_type=${notificationEvent} AND channel='IN_APP' AND language=${p.language} FOR UPDATE`)[0];
   if((old?.version??0)!==request.body.version)throw new HttpError(409,'NOTIFICATION_VERSION_CONFLICT');
   if(old)await tx`UPDATE notification_template SET title=${title},body=${body},active=${request.body.active},version=version+1,actor_id=${actor.id},session_id=${a.session},reason=${reason}
    WHERE scope=${p.scope} AND resource_id=${p.id} AND event_type=${notificationEvent} AND channel='IN_APP' AND language=${p.language}`;
   else await tx`INSERT INTO notification_template(scope,resource_id,organization_id,branch_id,campaign_id,event_type,channel,language,title,body,active,version,actor_id,session_id,reason)
    VALUES(${p.scope},${p.id},${actor.organizationId},${a.branchId},${p.scope==='CAMPAIGN'?p.id:null},${notificationEvent},'IN_APP',${p.language},${title},${body},${request.body.active},1,${actor.id},${a.session},${reason})`;
   return {version:request.body.version+1};
  });
 });
 app.get<{Params:Params;Querystring:{before?:number;limit?:number}}>(root+'/history',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:50}}}}},async request=>{
  const actor=await principalFromRequest(request,db),p=request.params;return db.begin(async tx=>{
   await access(tx,actor,p,request);const limit=request.query.limit??10;
   const rows=await tx`SELECT version,snapshot->>'title' AS title,snapshot->>'body' AS body,snapshot->'active' AS active,snapshot->>'reason' AS reason,snapshot->>'actor_id' AS actor_id,created_at FROM notification_template_history
    WHERE scope=${p.scope} AND resource_id=${p.id} AND event_type=${notificationEvent} AND channel='IN_APP' AND language=${p.language}
     AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT ${limit+1}`;
   return {items:rows.slice(0,limit),nextVersion:rows.length>limit?rows[limit-1]!.version:null};
  });
 });
}
