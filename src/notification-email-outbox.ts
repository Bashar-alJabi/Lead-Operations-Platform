import type {FastifyInstance} from 'fastify';
import type {Database} from './db.js';
import {principalFromRequest,HttpError} from './security.js';
import {currentPaymentSession} from './payments/access.js';
import {decodeCursor,encodeCursor} from './pagination.js';

/** One transaction prepares at most 25 recipients. No provider adapter or SMTP I/O. */
export async function processOneEmailPublication(db:Database):Promise<boolean>{
 return db.begin(async tx=>{
  await tx`SET LOCAL statement_timeout='5s'`;await tx`SET LOCAL lock_timeout='750ms'`;
  const candidates=await tx`SELECT event_id,connection_id,branch_id FROM notification_email_publication WHERE state='WAITING' ORDER BY created_at,event_id LIMIT 20`;
  for(const j of candidates){
   if(!(await tx`SELECT id FROM integration_connection WHERE id=${j.connection_id} FOR SHARE SKIP LOCKED`).length)continue;
   if(!(await tx`SELECT id FROM branch WHERE id=${j.branch_id} FOR SHARE SKIP LOCKED`).length)continue;
   if(!(await tx`SELECT event_id FROM notification_email_publication WHERE event_id=${j.event_id} AND state='WAITING' FOR UPDATE SKIP LOCKED`).length)continue;
   await tx`INSERT INTO notification_email_materialization(event_id) VALUES(${j.event_id})`;return true;
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
   const rows=candidates.length?await tx`SELECT o.id,o.state,o.language,o.preference_version,o.created_at,o.created_at::text cursor_at,e.event_type,e.lead_id,
    j.state publication_state FROM notification_email_outbox o JOIN notification_event e ON e.id=o.event_id JOIN notification_email_publication j ON j.event_id=e.id
    WHERE o.id IN ${tx(candidates.map(x=>x.id))} AND o.user_id=${a.id} AND notification_access(e.id,${a.id}) ORDER BY o.created_at DESC,o.id DESC`:[];
   const items=rows.slice(0,20),last=items.at(-1);
   await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(${a.organizationId},${a.branchId},${a.id},'EMAIL_NOTIFICATION_OUTBOX_READ','USER',${a.id},${tx.json({count:items.length})})`;
   return {items:items.map(x=>({id:x.id,state:x.state,eventType:x.event_type,leadId:x.lead_id,language:x.language,
    preferenceVersion:x.preference_version,createdAt:x.created_at})),nextCursor:rows.length>20&&last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};
  });
 });
}
