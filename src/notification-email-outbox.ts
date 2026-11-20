import type {FastifyInstance} from 'fastify';
import type {Database} from './db.js';
import {principalFromRequest,HttpError,requireRole} from './security.js';
import {currentPaymentSession} from './payments/access.js';
import {decodeCursor,encodeCursor} from './pagination.js';

/** One transaction prepares at most 25 recipients. No provider adapter or SMTP I/O. */
export async function processOneEmailPublication(db:Database):Promise<boolean>{
 return db.begin(async tx=>{
  await tx`SET LOCAL statement_timeout='5s'`;await tx`SET LOCAL lock_timeout='750ms'`;
  const candidates=await tx`SELECT p.event_id,p.connection_id,p.branch_id,p.version
    FROM notification_email_publication p LEFT JOIN LATERAL (
      SELECT failures,run_at FROM notification_email_page_retry WHERE event_id=p.event_id AND page_version=p.version
      ORDER BY sequence DESC LIMIT 1
    ) retry ON true
    WHERE p.state='WAITING' AND (retry.failures IS NULL OR retry.failures<5 AND retry.run_at<=clock_timestamp())
    ORDER BY p.created_at,p.event_id LIMIT 20`;
  for(const j of candidates){
   if(!(await tx`SELECT id FROM integration_connection WHERE id=${j.connection_id} FOR SHARE SKIP LOCKED`).length)continue;
   if(!(await tx`SELECT id FROM branch WHERE id=${j.branch_id} FOR SHARE SKIP LOCKED`).length)continue;
   if(!(await tx`SELECT event_id FROM notification_email_publication WHERE event_id=${j.event_id}
      AND state='WAITING' AND version=${j.version} FOR UPDATE SKIP LOCKED`).length)continue;
   const [retry]=await tx`SELECT failures,run_at<=clock_timestamp() AS ready FROM notification_email_page_retry
      WHERE event_id=${j.event_id} AND page_version=${j.version} ORDER BY sequence DESC LIMIT 1`;
   if(retry && (!retry.ready || retry.failures===5))continue;
   try {
    await tx.savepoint(async page=>{await page`INSERT INTO notification_email_materialization(event_id) VALUES(${j.event_id})`;});
   } catch {
    await tx`INSERT INTO notification_email_page_retry(event_id,page_version) VALUES(${j.event_id},${j.version})`;
   }
   return true;
  }return false;
 });
}

export function registerEmailOutboxRoutes(app:FastifyInstance,db:Database){
 app.get<{Querystring:{cursor?:string}}>('/api/notification-email/deliveries',{schema:{querystring:{type:'object',additionalProperties:false,
  properties:{cursor:{type:'string',maxLength:256}}}}},async r=>{
  const a=await principalFromRequest(r,db),cursor=decodeCursor(r.query.cursor);
  return db.begin(async tx=>{
   // Bounded identifiers only until current Lead/recipient authority has been locked again.
   const candidates=await tx`SELECT o.id,o.event_id,e.branch_id,e.lead_id,e.campaign_id,e.conversation_id,e.follow_up_id FROM notification_email_outbox o
    JOIN notification_event e ON e.id=o.event_id WHERE o.user_id=${a.id} AND e.organization_id=${a.organizationId}
    AND (${a.role==='SUPER_ADMIN'} OR e.branch_id=${a.branchId}) AND notification_access(e.id,${a.id})
    AND (${cursor?.timestamp??null}::text::timestamptz IS NULL OR (o.created_at,o.id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
    ORDER BY o.created_at DESC,o.id DESC LIMIT 21`;
   if(candidates.length){
    await tx`SELECT id FROM branch WHERE id IN ${tx([...new Set(candidates.map(x=>x.branch_id))])} ORDER BY id FOR SHARE`;
    await tx`SELECT id FROM lead WHERE id IN ${tx([...new Set(candidates.map(x=>x.lead_id))])} ORDER BY id FOR SHARE`;
    await tx`SELECT id FROM campaign WHERE id IN ${tx([...new Set(candidates.map(x=>x.campaign_id))])} ORDER BY id FOR SHARE`;
    const conversations=candidates.map(x=>x.conversation_id).filter(Boolean),tasks=candidates.map(x=>x.follow_up_id).filter(Boolean);
    if(conversations.length)await tx`SELECT id FROM conversation WHERE id IN ${tx([...new Set(conversations)])} ORDER BY id FOR SHARE`;
    if(tasks.length)await tx`SELECT id FROM follow_up WHERE id IN ${tx([...new Set(tasks)])} ORDER BY id FOR SHARE`;
   }
   if(!await currentPaymentSession(tx,a,r))throw new HttpError(403,'EMAIL_NOTIFICATION_ACCESS_REVOKED');
   const rows=candidates.length?await tx`SELECT o.id,d.state,COALESCE(a.language,o.language) AS language,
    COALESCE(a.preference_version,o.preference_version) AS preference_version,o.created_at,o.created_at::text cursor_at,e.event_type,e.lead_id,
    d.version,d.changed_at,d.error_code,COALESCE(history.items,'[]'::jsonb) AS history
    FROM notification_email_outbox o JOIN notification_event e ON e.id=o.event_id
    JOIN notification_email_dispatch d ON d.outbox_id=o.id LEFT JOIN notification_email_attempt a ON a.outbox_id=o.id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('state',recent.state,'changedAt',recent.created_at,'version',recent.version)
        ORDER BY recent.version DESC) AS items FROM (
        SELECT state,created_at,version FROM notification_email_dispatch_history
        WHERE outbox_id=o.id ORDER BY version DESC LIMIT 6
      ) recent
    ) history ON true
    WHERE o.id IN ${tx(candidates.map(x=>x.id))} AND o.user_id=${a.id} AND notification_access(e.id,${a.id}) ORDER BY o.created_at DESC,o.id DESC`:[];
   const items=rows.slice(0,20),last=items.at(-1);
   await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(${a.organizationId},${a.branchId},${a.id},'EMAIL_NOTIFICATION_OUTBOX_READ','USER',${a.id},${tx.json({count:items.length})})`;
   return {items:items.map(x=>({id:x.id,state:x.state,eventType:x.event_type,leadId:x.lead_id,language:x.language,
    preferenceVersion:x.preference_version,createdAt:x.created_at,changedAt:x.changed_at,version:x.version,errorCode:x.error_code,history:x.history})),
    nextCursor:rows.length>20&&last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};
  });
 });
 const retryBody={type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1}}} as const;
 const params={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}} as const;
 app.post<{Params:{id:string};Body:{version:number}}>('/api/notification-email/deliveries/:id/retry',{schema:{params,body:retryBody}},async request=>{
  const actor=await principalFromRequest(request,db);
  return db.begin(async tx=>{
   const id=request.params.id;
   const [entry]=await tx`SELECT d.connection_id FROM notification_email_outbox o JOIN notification_email_dispatch d ON d.outbox_id=o.id
    WHERE o.id=${id} AND o.user_id=${actor.id} AND notification_access(o.event_id,o.user_id)`;
   if(!entry)throw new HttpError(404,'EMAIL_DELIVERY_NOT_FOUND');
   await tx`SELECT id FROM integration_connection WHERE id=${entry.connection_id} FOR SHARE`;
   const [job]=await tx`SELECT state,version FROM notification_email_dispatch WHERE outbox_id=${id} FOR UPDATE`;
   const [access]=await tx`SELECT notification_email_dispatch_allowed(${id}) AS allowed`;
   const session=await currentPaymentSession(tx,actor,request);
   if(!session)throw new HttpError(403,'EMAIL_NOTIFICATION_ACCESS_REVOKED');
   if(!access?.allowed || job?.state!=='DEAD_LETTER' || job.version!==request.body.version)
    throw new HttpError(409,'EMAIL_DELIVERY_NOT_RETRYABLE');
   await tx`INSERT INTO notification_email_dispatch_recovery(outbox_id,version,actor_id,session_id)
    VALUES(${id},${job.version},${actor.id},${session})`;
   return {state:'WAITING'};
  });
 });
 app.get('/api/notification-email/page-failures',async request=>{
  const actor=await principalFromRequest(request,db);
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  return db.begin(async tx=>{
   if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'EMAIL_NOTIFICATION_ACCESS_REVOKED');
   const items=await tx`SELECT p.event_id AS id,p.version,e.event_type AS "eventType",last.created_at AS "changedAt"
    FROM notification_email_publication p JOIN notification_event e ON e.id=p.event_id
    JOIN LATERAL (
      SELECT failures,created_at FROM notification_email_page_retry WHERE event_id=p.event_id AND page_version=p.version
      ORDER BY sequence DESC LIMIT 1
    ) last ON last.failures=5
    WHERE p.state='WAITING' AND p.organization_id=${actor.organizationId}
      AND (${actor.role==='SUPER_ADMIN'} OR p.branch_id=${actor.branchId})
    ORDER BY last.created_at DESC,p.event_id LIMIT 25`;
   return {items};
  });
 });
 app.post<{Params:{id:string};Body:{version:number}}>('/api/notification-email/page-failures/:id/retry',{schema:{params,body:retryBody}},async request=>{
  const actor=await principalFromRequest(request,db);
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  return db.begin(async tx=>{
   const id=request.params.id;
   const [job]=await tx`SELECT state,version FROM notification_email_publication WHERE event_id=${id}
      AND organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId}) FOR UPDATE`;
   const session=await currentPaymentSession(tx,actor,request);
   if(!session)throw new HttpError(403,'EMAIL_NOTIFICATION_ACCESS_REVOKED');
   if(!job)throw new HttpError(404,'EMAIL_PUBLICATION_NOT_FOUND');
   const [latest]=await tx`SELECT failures FROM notification_email_page_retry WHERE event_id=${id} AND page_version=${job.version}
    ORDER BY sequence DESC LIMIT 1`;
   if(job.state!=='WAITING' || job.version!==request.body.version || latest?.failures!==5)throw new HttpError(409,'EMAIL_PUBLICATION_NOT_RETRYABLE');
   await tx`INSERT INTO notification_email_page_retry(event_id,page_version,actor_id,session_id)
    VALUES(${id},${job.version},${actor.id},${session})`;
   return {state:'WAITING'};
  });
 });
}
