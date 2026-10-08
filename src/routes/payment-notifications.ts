import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,requireRole,type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { almaNotificationProfile,almaNotificationResource,paymentNotificationUrl,paymentNotificationAdmissionLimit } from '../payments/notifications.js';
import { decodeCursor,encodeCursor } from '../pagination.js';

const root='/api/payments/connections/:id';
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:{ type:'string',format:'uuid' } } } as const;
const endpointParams={ ...params,required:['id','endpointId'],properties:{ ...params.properties,endpointId:{ type:'string',format:'uuid' } } } as const;
const pageSchema={ type:'object',additionalProperties:false,properties:{ limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 } } } as const;
const version={ type:'integer',minimum:1 } as const;
const reason={ type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$' } as const;
type Scope={ id:string;endpointId:string };type Page={ limit?:number;cursor?:string };
async function managed(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,id:string,write=false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const c=(await tx`SELECT * FROM integration_connection WHERE id=${id} AND kind='PAYMENT' AND organization_id=${actor.organizationId}
    AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId}) ${write ? tx`FOR UPDATE` : tx`FOR SHARE`}`)[0];
  if(!c)throw new HttpError(404,'PAYMENT_CONNECTION_NOT_FOUND');
  const sessionId=await currentPaymentSession(tx,actor,request);if(!sessionId)throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
  if(c.provider!=='ALMA')throw new HttpError(409,'PAYMENT_NOTIFICATION_UNSUPPORTED');return { c,sessionId };
}
async function activeBranch(tx:postgres.TransactionSql,c:postgres.Row) {
  return !c.branch_id || (await tx`SELECT 1 FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length>0;
}
function current(c:postgres.Row,e:postgres.Row) {
  return c.version===e.connection_version && ['CONNECTED','WARNING'].includes(c.status) && c.config.mode===e.mode
    && c.capabilities.authenticationVerified===true && c.capabilities.authenticationVersion===c.version
    && c.capabilities.authentication?.accountRef===e.account_ref && c.capabilities.authentication?.mode===e.mode;
}
function visible(c:postgres.Row,e:postgres.Row,branchActive:boolean) {
  return { id:e.id,connection_version:e.connection_version,profile:e.profile,account_ref:e.account_ref,mode:e.mode,callback_url:e.callback_url,
    state:e.state,version:e.version,created_at:e.created_at,updated_at:e.updated_at,current:branchActive && current(c,e),
    publicHttps:e.callback_url.startsWith('https:'),signedDeliveryVerified:false,financialProcessingReady:false };
}
async function endpoint(tx:postgres.TransactionSql,c:postgres.Row,id:string,lock=false) {
  const row=(await tx`SELECT * FROM payment_notification_endpoint WHERE id=${id} AND connection_id=${c.id} ${lock ? tx`FOR UPDATE` : tx``}`)[0];
  if(!row)throw new HttpError(404,'PAYMENT_NOTIFICATION_ENDPOINT_NOT_FOUND');return row;
}
function checkReason(input:string) { if(input.trim().length<3)throw new HttpError(400,'REASON_REQUIRED');return input.trim(); }
async function audit(tx:postgres.TransactionSql,c:postgres.Row,actor:Principal|null,action:string,id:string,detail:postgres.JSONValue={}) {
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (${c.organization_id},${c.branch_id},${actor?.id ?? null},${action},'PAYMENT_NOTIFICATION',${id},${tx.json(detail)})`;
}
function pageResult(rows:postgres.Row[],limit:number,timeKey:string) {
  const items=rows.slice(0,limit);const last=items.at(-1);return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last[timeKey].toISOString(),id:last.id }) : null };
}
export function registerPaymentNotificationRoutes(app:FastifyInstance,db:Database):void {
  app.get<{ Params:{ id:string };Querystring:Page }>(root+'/notification-endpoints',{ schema:{ params,querystring:pageSchema } },async(request)=> {
    const actor=await principalFromRequest(request,db);const limit=request.query.limit ?? 20;const cursor=decodeCursor(request.query.cursor);
    return db.begin(async(tx)=> { const { c }=await managed(tx,actor,request,request.params.id);const active=await activeBranch(tx,c);
      const rows=await tx`SELECT * FROM payment_notification_endpoint WHERE connection_id=${c.id}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;const result=pageResult(rows,limit,'created_at');
      return { ...result,items:result.items.map((e)=>visible(c,e,active)) }; });
  });
  app.get<{ Params:Scope }>(root+'/notification-endpoints/:endpointId',{ schema:{ params:endpointParams } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> { const { c }=await managed(tx,actor,request,request.params.id);
      return visible(c,await endpoint(tx,c,request.params.endpointId),await activeBranch(tx,c)); });
  });
  app.post<{ Params:{ id:string };Body:{ connectionVersion:number;reason:string } }>(root+'/notification-endpoints',{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['connectionVersion','reason'],properties:{ connectionVersion:version,reason } } },
  },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);const note=checkReason(request.body.reason);
    const result=await db.begin(async(tx)=> { const { c,sessionId }=await managed(tx,actor,request,request.params.id,true);
      if(c.version!==request.body.connectionVersion)throw new HttpError(409,'CONNECTION_VERSION_CONFLICT');
      const active=await activeBranch(tx,c);if(!active)throw new HttpError(409,'BRANCH_DISABLED');
      const identity={ connection_version:c.version,account_ref:c.capabilities.authentication?.accountRef,mode:c.config.mode };
      if(!current(c,identity))throw new HttpError(409,'PAYMENT_AUTHENTICATION_REQUIRED');
      const original=(await tx`SELECT * FROM payment_notification_endpoint WHERE connection_id=${c.id} AND connection_version=${c.version}`)[0];
      if(original) {
        if(!current(c,original))throw new HttpError(409,'PAYMENT_NOTIFICATION_IDENTITY_CONFLICT');
        return { ...visible(c,original,active),duplicate:true };
      }
      const probe=(await tx`SELECT id FROM payment_connection_probe WHERE connection_id=${c.id} AND connection_version=${c.version} AND state='VERIFIED'
        AND authentication_snapshot=${tx.json(c.capabilities.authentication)} ORDER BY probe_number DESC LIMIT 1`)[0];
      if(!probe)throw new HttpError(409,'PAYMENT_AUTHENTICATION_REQUIRED');
      const id=randomUUID();const row=(await tx`INSERT INTO payment_notification_endpoint(id,connection_id,connection_version,profile,account_ref,mode,
        authentication_probe_id,callback_url,actor_user_id,actor_session_id,reason)
        VALUES (${id},${c.id},${c.version},${almaNotificationProfile},${identity.account_ref},${identity.mode},${probe.id},${paymentNotificationUrl(id)},${actor.id},${sessionId},${note}) RETURNING *`)[0]!;
      await audit(tx,c,actor,'PAYMENT_NOTIFICATION_ENDPOINT_CREATED',id,{ version:row.version,connectionVersion:c.version,reason:note,trust:'UNVERIFIED' });
      return { ...visible(c,row,active),duplicate:false };
    });reply.code(result.duplicate ? 200 : 201);return result;
  });
  for(const action of ['disable','reconnect'] as const)app.post<{ Params:Scope;Body:{ version:number;reason:string } }>(root+'/notification-endpoints/:endpointId/'+action,{
    schema:{ params:endpointParams,body:{ type:'object',additionalProperties:false,required:['version','reason'],properties:{ version,reason } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);const note=checkReason(request.body.reason);
    return db.begin(async(tx)=> { const { c,sessionId }=await managed(tx,actor,request,request.params.id,true);const e=await endpoint(tx,c,request.params.endpointId,true);
      if(e.version!==request.body.version)throw new HttpError(409,'PAYMENT_NOTIFICATION_VERSION_CONFLICT');
      const active=await activeBranch(tx,c);if(!active)throw new HttpError(409,'BRANCH_DISABLED');
      const state=action==='disable' ? 'DISABLED' : 'ENABLED';if(e.state===state)throw new HttpError(409,'PAYMENT_NOTIFICATION_STATE_CONFLICT');
      if(action==='reconnect' && !current(c,e))throw new HttpError(409,'PAYMENT_NOTIFICATION_CURRENT_CONFIG_REQUIRED');
      const changed=(await tx`UPDATE payment_notification_endpoint SET state=${state},version=version+1,actor_user_id=${actor.id},actor_session_id=${sessionId},reason=${note}
        WHERE id=${e.id} RETURNING *`)[0]!;
      await audit(tx,c,actor,action==='disable' ? 'PAYMENT_NOTIFICATION_ENDPOINT_DISABLED' : 'PAYMENT_NOTIFICATION_ENDPOINT_RECONNECTED',e.id,{ version:changed.version,reason:note });
      return visible(c,changed,active);
    });
  });
  app.get<{ Params:Scope;Querystring:{ limit?:number;before?:number } }>(root+'/notification-endpoints/:endpointId/history',{
    schema:{ params:endpointParams,querystring:{ type:'object',additionalProperties:false,properties:{ limit:{ type:'integer',minimum:1,maximum:100 },before:version } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);const limit=request.query.limit ?? 20;
    return db.begin(async(tx)=> { const { c }=await managed(tx,actor,request,request.params.id);await endpoint(tx,c,request.params.endpointId);
      const rows=await tx`SELECT version,state,actor_user_id,reason,created_at FROM payment_notification_endpoint_history WHERE endpoint_id=${request.params.endpointId}
        AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;
      const items=rows.slice(0,limit);return { items,nextVersion:rows.length>limit ? items.at(-1)!.version : null }; });
  });
  app.get<{ Params:{ id:string };Querystring:Page }>(root+'/untrusted-notifications',{ schema:{ params,querystring:pageSchema } },async(request)=> {
    const actor=await principalFromRequest(request,db);const limit=request.query.limit ?? 20;const cursor=decodeCursor(request.query.cursor);
    return db.begin(async(tx)=> { const { c }=await managed(tx,actor,request,request.params.id);
      const rows=await tx`SELECT id,endpoint_id,resource_id,profile,mode,trust,received_at FROM payment_untrusted_notification WHERE connection_id=${c.id}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (received_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY received_at DESC,id DESC LIMIT ${limit+1}`;return pageResult(rows,limit,'received_at'); });
  });
  // Alma IPN is unsigned GET. Never turn it into a signed receipt or accept monetary claims.
  app.get<{ Params:{ endpointId:string };Querystring:{ pid:string } }>('/api/webhooks/payments/alma/:endpointId',{
    schema:{ params:{ type:'object',additionalProperties:false,required:['endpointId'],properties:{ endpointId:{ type:'string',format:'uuid' } } },
      querystring:{ type:'object',additionalProperties:false,required:['pid'],properties:{ pid:{ type:'string',pattern:'^payment_[A-Za-z0-9]{1,120}$',maxLength:128 } } }, },
    config:{ rateLimit:{ max:60,timeWindow:'1 minute' } },
  },async(request,reply)=> {
    reply.header('cache-control','no-store');const resource=almaNotificationResource(request.query.pid);const cap=paymentNotificationAdmissionLimit();
    return db.begin(async(tx)=> {
      // Connection before endpoint follows setup lock ordering. Serialize bounded admissions across replicas.
      const c=(await tx`SELECT c.* FROM integration_connection c JOIN payment_notification_endpoint e ON e.connection_id=c.id
        WHERE e.id=${request.params.endpointId} AND c.kind='PAYMENT' AND c.provider='ALMA' FOR UPDATE OF c`)[0];
      if(!c)throw new HttpError(404,'PAYMENT_NOTIFICATION_ENDPOINT_NOT_FOUND');
      const e=(await tx`SELECT * FROM payment_notification_endpoint WHERE id=${request.params.endpointId} FOR SHARE`)[0]!;
      if(e.state!=='ENABLED')throw new HttpError(410,'PAYMENT_NOTIFICATION_ENDPOINT_DISABLED');
      let notification=(await tx`SELECT id FROM payment_untrusted_notification WHERE connection_id=${c.id} AND mode=${e.mode} AND resource_id=${resource}`)[0];
      const duplicate=!!notification;
      if(!notification) {
        const recent=(await tx`SELECT count(*)::integer AS n FROM (SELECT 1 FROM payment_untrusted_notification WHERE connection_id=${c.id}
          AND received_at>clock_timestamp()-interval '1 hour' LIMIT ${cap}) bounded`)[0]!.n;
        if(recent>=cap)throw new HttpError(429,'PAYMENT_NOTIFICATION_BACKPRESSURE');
        notification=(await tx`INSERT INTO payment_untrusted_notification(connection_id,mode,endpoint_id,resource_id,profile)
          VALUES (${c.id},${e.mode},${e.id},${resource},${e.profile}) RETURNING id`)[0]!;
      }
      const delivery=(await tx`INSERT INTO payment_notification_delivery(endpoint_id,notification_id,connection_id,mode)
        VALUES (${e.id},${notification.id},${c.id},${e.mode}) ON CONFLICT DO NOTHING RETURNING notification_id`)[0];
      if(delivery)await audit(tx,c,null,'PAYMENT_UNTRUSTED_NOTIFICATION_RECEIVED',e.id,{ notificationId:notification.id,duplicate,trust:'UNVERIFIED' });
      return { accepted:true,duplicate,trust:'UNVERIFIED' };
    });
  });
}
