import type { FastifyInstance,FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { decodeCursor,encodeCursor } from '../pagination.js';
import { notificationEvent,notificationEvents,notificationDefaults,effectiveNotificationTemplate,renderNotification,requireNotificationBodyTypes,type NotificationEventType,type NotificationLanguage,type NotificationTemplate } from '../notifications.js';

async function eventAccess(tx:postgres.TransactionSql,actor:Principal,id:string,request:FastifyRequest) {
 const initial=(await tx`SELECT branch_id,lead_id,campaign_id,conversation_id,follow_up_id FROM notification_event WHERE id=${id} AND organization_id=${actor.organizationId}
  AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId})`)[0];
 if(!initial)throw new HttpError(404,'NOTIFICATION_NOT_FOUND');
 await tx`SELECT id FROM branch WHERE id=${initial.branch_id} FOR SHARE`;
 await tx`SELECT id FROM lead WHERE id=${initial.lead_id} FOR SHARE`;
 await tx`SELECT id FROM campaign WHERE id=${initial.campaign_id} FOR SHARE`;
 await tx`SELECT id FROM conversation WHERE id=${initial.conversation_id} FOR SHARE`;
 if(initial.follow_up_id)await tx`SELECT id FROM follow_up WHERE id=${initial.follow_up_id} FOR SHARE`;
 const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
 if(!(await tx`SELECT notification_access(${id},${actor.id}) AS ok`)[0]!.ok)throw new HttpError(404,'NOTIFICATION_NOT_FOUND');
 return session;
}
export function registerNotificationRoutes(app:FastifyInstance,db:Database) {
 const params={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}} as const;
 const pageQuery={type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:50},cursor:{type:'string',maxLength:256},language:{type:'string',enum:['ar','en','fr']},unreadOnly:{type:'boolean'}}} as const;
 app.get('/api/notifications/indicator',async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
   const row=(await tx`SELECT EXISTS(SELECT 1 FROM notification_event e
    JOIN lead l ON l.id=e.lead_id AND l.organization_id=e.organization_id AND l.branch_id=e.branch_id AND l.campaign_id=e.campaign_id
    JOIN campaign c ON c.id=l.campaign_id AND c.organization_id=e.organization_id AND c.branch_id=e.branch_id
    LEFT JOIN conversation cv ON cv.id=e.conversation_id AND cv.lead_id=l.id
    LEFT JOIN notification_preference p ON p.user_id=${actor.id} AND p.event_type=e.event_type AND p.channel='IN_APP'
    LEFT JOIN notification_state ns ON ns.user_id=${actor.id} AND ns.event_id=e.id
    WHERE (e.conversation_id IS NULL OR cv.id IS NOT NULL) AND e.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR e.branch_id=${actor.branchId})
     AND (${actor.role!=='AGENT'} OR l.assigned_agent_id=${actor.id}) AND notification_access(e.id,${actor.id}) AND COALESCE(p.enabled,true) AND NOT COALESCE(ns.is_read,false)) AS has_unread`)[0]!;
   return {hasUnread:row.has_unread};
  });
 });
 app.get<{Querystring:{limit?:number;cursor?:string;language?:NotificationLanguage;unreadOnly?:boolean}}>('/api/notifications',{schema:{querystring:pageQuery}},async request=>{
  const actor=await principalFromRequest(request,db),cursor=decodeCursor(request.query.cursor),limit=request.query.limit??10,language=request.query.language??'ar';
  return db.begin(async tx=>{
   // Only bounded identifiers are read before the current scope/session locks. No customer content is loaded.
   const candidates=await tx`SELECT e.id,e.branch_id,e.lead_id,e.campaign_id,e.conversation_id,e.follow_up_id FROM notification_event e
    JOIN lead l ON l.id=e.lead_id AND l.organization_id=e.organization_id AND l.branch_id=e.branch_id AND l.campaign_id=e.campaign_id
    JOIN campaign c ON c.id=e.campaign_id AND c.branch_id=e.branch_id AND c.organization_id=e.organization_id
    LEFT JOIN conversation cv ON cv.id=e.conversation_id AND cv.lead_id=l.id
    LEFT JOIN notification_preference p ON p.user_id=${actor.id} AND p.event_type=e.event_type AND p.channel='IN_APP'
    LEFT JOIN notification_state ns ON ns.user_id=${actor.id} AND ns.event_id=e.id
    WHERE (e.conversation_id IS NULL OR cv.id IS NOT NULL) AND e.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR e.branch_id=${actor.branchId})
     AND (${actor.role!=='AGENT'} OR l.assigned_agent_id=${actor.id}) AND notification_access(e.id,${actor.id}) AND COALESCE(p.enabled,true)
     AND (${!request.query.unreadOnly} OR NOT COALESCE(ns.is_read,false))
     AND (${cursor?.timestamp??null}::text::timestamptz IS NULL OR (e.created_at,e.id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
    ORDER BY e.created_at DESC,e.id DESC LIMIT ${limit+1}`;
   if(candidates.length) {
    await tx`SELECT id FROM branch WHERE id IN ${tx([...new Set(candidates.map(r=>r.branch_id))])} ORDER BY id FOR SHARE`;
    await tx`SELECT id FROM lead WHERE id IN ${tx([...new Set(candidates.map(r=>r.lead_id))])} ORDER BY id FOR SHARE`;
    await tx`SELECT id FROM campaign WHERE id IN ${tx([...new Set(candidates.map(r=>r.campaign_id))])} ORDER BY id FOR SHARE`;
    if(candidates.some(r=>r.conversation_id))await tx`SELECT id FROM conversation WHERE id IN ${tx([...new Set(candidates.map(r=>r.conversation_id).filter(Boolean))])} ORDER BY id FOR SHARE`;
    if(candidates.some(r=>r.follow_up_id))await tx`SELECT id FROM follow_up WHERE id IN ${tx([...new Set(candidates.map(r=>r.follow_up_id).filter(Boolean))])} ORDER BY id FOR SHARE`;
   }
   if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
   const rows=candidates.length ? await tx`SELECT e.id,e.event_type,e.branch_id,e.campaign_id,e.lead_id,e.conversation_id,e.payment_id,e.enrollment_id,e.follow_up_id,o.due_at AS observed_due_at,f.due_at AS current_due_at,f.status AS follow_up_status,
    f.status='OPEN' AND f.due_at=o.due_at AND f.due_at<=clock_timestamp() AS currently_due,e.created_at,e.created_at::text AS cursor_at,c.name AS campaign_name,u.name AS owner_name,
    COALESCE(ns.version,0) AS version,COALESCE(ns.is_read,false) AS is_read,
    cv.ai_handoff_action_id=e.source_id AND cv.state='WAITING_FOR_HUMAN' AND cv.controller_type='NONE' AS waiting
    FROM notification_event e JOIN lead l ON l.id=e.lead_id AND l.organization_id=e.organization_id AND l.branch_id=e.branch_id AND l.campaign_id=e.campaign_id
    JOIN campaign c ON c.id=e.campaign_id AND c.branch_id=e.branch_id AND c.organization_id=e.organization_id
    LEFT JOIN conversation cv ON cv.id=e.conversation_id AND cv.lead_id=l.id
    LEFT JOIN follow_up f ON f.id=e.follow_up_id AND f.lead_id=l.id
    LEFT JOIN follow_up_due_observation o ON o.id=e.follow_up_due_id AND o.follow_up_id=f.id
    LEFT JOIN user_account u ON u.id=CASE WHEN e.follow_up_id IS NOT NULL THEN f.owner_user_id ELSE l.assigned_agent_id END AND u.branch_id=l.branch_id AND u.organization_id=l.organization_id
    LEFT JOIN notification_preference p ON p.user_id=${actor.id} AND p.event_type=e.event_type AND p.channel='IN_APP'
    LEFT JOIN notification_state ns ON ns.user_id=${actor.id} AND ns.event_id=e.id
    WHERE (e.conversation_id IS NULL OR cv.id IS NOT NULL) AND e.id IN ${tx(candidates.map(r=>r.id))} AND e.organization_id=${actor.organizationId}
     AND (${actor.role==='SUPER_ADMIN'} OR e.branch_id=${actor.branchId}) AND (${actor.role!=='AGENT'} OR l.assigned_agent_id=${actor.id})
     AND notification_access(e.id,${actor.id}) AND COALESCE(p.enabled,true) AND (${!request.query.unreadOnly} OR NOT COALESCE(ns.is_read,false)) ORDER BY e.created_at DESC,e.id DESC` : [];
   const page=rows.slice(0,limit),last=page.at(-1);
   const templates=page.length ? await tx`SELECT scope,resource_id,branch_id,title,body,version,active,event_type FROM notification_template
    WHERE organization_id=${actor.organizationId} AND language=${language} AND event_type IN ${tx(notificationEvents as readonly string[])} AND channel='IN_APP'
     AND (scope='GLOBAL' OR scope='BRANCH' AND resource_id IN ${tx([...new Set(page.map(r=>r.branch_id))])}
      OR scope='CAMPAIGN' AND resource_id IN ${tx([...new Set(page.map(r=>r.campaign_id))])})` : [];
   const items=page.map(r=>{
    const tpl=effectiveNotificationTemplate(templates as NotificationTemplate[],actor.organizationId,r.branch_id,r.campaign_id,language,r.event_type as NotificationEventType),values={campaign:r.campaign_name as string,owner:(r.owner_name??notificationDefaults[language].owner) as string};
    return {id:r.id,eventType:r.event_type,channel:'IN_APP',leadId:r.lead_id,conversationId:r.conversation_id,createdAt:r.created_at,version:r.version,isRead:r.is_read,waiting:Boolean(r.waiting),
     paymentId:r.payment_id,enrollmentId:r.enrollment_id,followUp:r.follow_up_id?{id:r.follow_up_id,observedDueAt:r.observed_due_at,currentDueAt:r.current_due_at,status:r.follow_up_status,currentlyDue:Boolean(r.currently_due)}:null,
     title:renderNotification(tpl.title,values),body:renderNotification(tpl.body,values),templateSource:tpl.source,templateVersion:tpl.version};
   });
   await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(${actor.organizationId},${actor.branchId},${actor.id},'IN_APP_NOTIFICATION_CENTER_READ','USER',${actor.id},${tx.json({count:items.length,language})})`;
   return {items,nextCursor:rows.length>limit && last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};
  });
 });
 app.put<{Params:{id:string};Body:{version:number;isRead:boolean}}>('/api/notifications/:id/state',{preValidation:async r=>requireNotificationBodyTypes(r.body,'isRead'),schema:{params,body:{type:'object',additionalProperties:false,required:['version','isRead'],properties:{version:{type:'integer',minimum:0},isRead:{type:'boolean'}}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   await eventAccess(tx,actor,request.params.id,request);
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id+':notification:'+request.params.id},0))`;
   const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
   const old=(await tx`SELECT version FROM notification_state WHERE user_id=${actor.id} AND event_id=${request.params.id} FOR UPDATE`)[0];
   if((old?.version??0)!==request.body.version)throw new HttpError(409,'NOTIFICATION_VERSION_CONFLICT');
   if(old)await tx`UPDATE notification_state SET version=version+1,is_read=${request.body.isRead},session_id=${session} WHERE user_id=${actor.id} AND event_id=${request.params.id}`;
   else await tx`INSERT INTO notification_state(user_id,event_id,version,is_read,session_id) VALUES(${actor.id},${request.params.id},1,${request.body.isRead},${session})`;
   return {version:request.body.version+1,isRead:request.body.isRead};
  });
 });
 app.get<{Params:{id:string};Querystring:{before?:number;limit?:number}}>('/api/notifications/:id/history',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:50}}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   await eventAccess(tx,actor,request.params.id,request);const limit=request.query.limit??10;
   const rows=await tx`SELECT version,snapshot->'is_read' AS is_read,created_at FROM notification_user_history WHERE user_id=${actor.id} AND kind='STATE' AND resource_id=${request.params.id}
    AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT ${limit+1}`;
   return {items:rows.slice(0,limit),nextVersion:rows.length>limit?rows[limit-1]!.version:null};
  });
 });
 for(const event of notificationEvents){
 const preferenceRoot='/api/notification-preferences'+(event===notificationEvent?'':'/'+event);
 app.get(preferenceRoot,async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
   const p=(await tx`SELECT enabled,version FROM notification_preference WHERE user_id=${actor.id} AND event_type=${event as string} AND channel='IN_APP'`)[0];
   return {eventType:event,channel:'IN_APP',enabled:p?.enabled??true,version:p?.version??0,mandatory:false};
  });
 });
 app.put<{Body:{enabled:boolean;version:number}}>(preferenceRoot,{preValidation:async r=>requireNotificationBodyTypes(r.body,'enabled'),schema:{body:{type:'object',additionalProperties:false,required:['enabled','version'],properties:{enabled:{type:'boolean'},version:{type:'integer',minimum:0}}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id+':notification-preference:'+event},0))`;
   const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
   const p=(await tx`SELECT version FROM notification_preference WHERE user_id=${actor.id} AND event_type=${event as string} AND channel='IN_APP' FOR UPDATE`)[0];
   if((p?.version??0)!==request.body.version)throw new HttpError(409,'NOTIFICATION_VERSION_CONFLICT');
   if(p)await tx`UPDATE notification_preference SET version=version+1,enabled=${request.body.enabled},session_id=${session} WHERE user_id=${actor.id} AND event_type=${event as string} AND channel='IN_APP'`;
   else await tx`INSERT INTO notification_preference(user_id,event_type,channel,enabled,version,session_id) VALUES(${actor.id},${event as string},'IN_APP',${request.body.enabled},1,${session})`;
   return {version:request.body.version+1};
  });
 });
 }
}
