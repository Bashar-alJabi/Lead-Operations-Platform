import type {FastifyInstance} from 'fastify';
import type {Database} from './db.js';
import {currentPaymentSession} from './payments/access.js';
import {decodeCursor,encodeCursor} from './pagination.js';
import {HttpError,principalFromRequest,requireRole} from './security.js';

export async function processOneStaffMessagingPublication(db:Database):Promise<boolean> {
 return db.begin(async tx=>{
  await tx`SET LOCAL lock_timeout='750ms'`;
  await tx`SET LOCAL statement_timeout='5s'`;
  const jobs=await tx`SELECT event_id,language FROM staff_messaging_publication
   WHERE state='WAITING' AND run_at<=statement_timestamp() ORDER BY run_at,event_id,language LIMIT 20`;
  for(const job of jobs){
   const [result]=await tx`SELECT materialize_staff_messaging_page(${job.event_id},${job.language}) AS processed`;
   if(result?.processed)return true;
  }
  return false;
 });
}

export function registerStaffMessagingOutboxRoutes(app:FastifyInstance,db:Database) {
 app.get<{Querystring:{cursor?:string}}>('/api/notification-messaging/outbox',{
  schema:{querystring:{type:'object',additionalProperties:false,properties:{cursor:{type:'string',maxLength:256}}}},
 },async request=>{
  const actor=await principalFromRequest(request,db),cursor=decodeCursor(request.query.cursor);
  requireRole(actor,'MANAGER','AGENT');
  return db.begin(async tx=>{
   if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'STAFF_MESSAGING_ACCESS_DENIED');
   const rows=await tx`SELECT o.event_id AS id,e.event_type AS "eventType",o.language,o.created_at AS "preparedAt",
     o.created_at::text AS cursor_at,CASE WHEN EXISTS(SELECT 1 FROM staff_messaging_current_binding(o.event_id,o.language,o.binding_version) b
       CROSS JOIN staff_messaging_recipient(o.event_id,o.user_id,o.language) a
       WHERE b.connection_version=o.connection_version AND a.destination_version=o.destination_version AND a.preference_version=o.preference_version)
      THEN 'PREPARED' ELSE 'SUPPRESSED' END AS state
    FROM staff_messaging_outbox o JOIN notification_event e ON e.id=o.event_id
    WHERE o.user_id=${actor.id} AND e.organization_id=${actor.organizationId} AND e.branch_id=${actor.branchId}
      AND notification_access(e.id,${actor.id})
      AND (${cursor?.timestamp??null}::text::timestamptz IS NULL OR (o.created_at,o.event_id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
    ORDER BY o.created_at DESC,o.event_id DESC LIMIT 21`;
   const items=rows.slice(0,20),last=items.at(-1);
   return {items:items.map(({cursor_at:_cursor,...row})=>row),
    nextCursor:rows.length>20&&last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};
  });
 });
}
