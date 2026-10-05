import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { openOpaque,openSecret,sealOpaque } from '../credentials.js';
import { HttpError,principalFromRequest,requireRole,type Principal } from '../security.js';
import { currentPaymentActor } from '../payments/access.js';
import { paymentConnectionAdapters,PaymentProviderError,stripePaymentEvents,validatePaymentCredentials,type PaymentAdapterRegistry,type PaymentCredentials,type PaymentWebhookInspection } from '../payments/providers.js';
import { checkedWebhookInspection,parseStripePaymentReceipt,validateStripeWebhookSecret,verifyStripePaymentSignature } from '../payments/webhook.js';
import { decodeCursor,encodeCursor } from '../pagination.js';

const root='/api/payments/connections/:id';
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:{ type:'string',format:'uuid' } } } as const;
const endpointParams={ ...params,required:['id','webhookId'],properties:{ ...params.properties,webhookId:{ type:'string',format:'uuid' } } } as const;
const version={ type:'integer',minimum:1 } as const;
const reason={ type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$' } as const;
const pageSchema={ type:'object',additionalProperties:false,properties:{ limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 } } } as const;
type Scope={ id:string;webhookId:string };
type Page={ limit?:number;cursor?:string };
async function managed(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,id:string,write=false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const c=(await tx`SELECT * FROM integration_connection WHERE id=${id} AND kind='PAYMENT' AND organization_id=${actor.organizationId}
    AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId}) ${write ? tx`FOR UPDATE` : tx`FOR SHARE`}`)[0];
  if(!c)throw new HttpError(404,'PAYMENT_CONNECTION_NOT_FOUND');
  if(!await currentPaymentActor(tx,actor,request))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');return c;
}
async function activeBranch(tx:postgres.TransactionSql,branchId:string|null) {
  return !branchId || (await tx`SELECT 1 FROM branch WHERE id=${branchId} AND active FOR SHARE`).length>0;
}
async function endpoint(tx:postgres.TransactionSql,c:postgres.Row,id:string,lock=false) {
  const row=(await tx`SELECT * FROM payment_webhook WHERE id=${id} AND connection_id=${c.id} ${lock ? tx`FOR UPDATE` : tx``}`)[0];
  if(!row)throw new HttpError(404,'PAYMENT_WEBHOOK_NOT_FOUND');return row;
}
function callbackUrl(id:string) {
  let url:URL;try { url=new URL(process.env.APP_ORIGIN ?? ''); }catch{ throw new HttpError(503,'PAYMENT_CALLBACK_ORIGIN_NOT_CONFIGURED'); }
  if(url.username || url.password || url.search || url.hash || url.pathname!=='/' || !['http:','https:'].includes(url.protocol)
    || (url.protocol==='http:' && (process.env.NODE_ENV==='production' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new HttpError(503,'PAYMENT_CALLBACK_ORIGIN_NOT_CONFIGURED');
  return url.origin+'/api/webhooks/payments/stripe/'+id;
}
function checkReason(text:string) { if(text.trim().length<3)throw new HttpError(400,'REASON_REQUIRED');return text.trim(); }
async function audit(tx:postgres.TransactionSql,c:postgres.Row,actor:Principal|null,action:string,id:string,detail:postgres.JSONValue={}) {
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (${c.organization_id},${c.branch_id},${actor?.id ?? null},${action},'PAYMENT_WEBHOOK',${id},${tx.json(detail)})`;
}
async function visible(tx:postgres.TransactionSql,c:postgres.Row,w:postgres.Row) {
  const probe=(await tx`SELECT id,state,error_code,snapshot,created_at,finished_at,expires_at<=clock_timestamp() AS expired
    FROM payment_webhook_probe WHERE webhook_id=${w.id} ORDER BY probe_number DESC LIMIT 1`)[0];
  const current=c.version===w.connection_version && c.config.mode===w.mode && c.status!=='DISABLED' && await activeBranch(tx,c.branch_id);
  return { id:w.id,connection_version:w.connection_version,mode:w.mode,callback_url:w.callback_url,state:w.state,external_endpoint_id:w.external_endpoint_id,
    version:w.version,created_at:w.created_at,last_signed_at:w.last_signed_at,secret_configured:!!w.ciphertext,current,
    endpointVerified:current && w.state==='CONFIGURED' && probe?.state==='VERIFIED',signedDeliveryVerified:!!w.last_signed_at,
    webhookReady:current && w.state==='CONFIGURED' && probe?.state==='VERIFIED' && !!w.last_signed_at,
    financialProcessingReady:false,publicHttps:w.callback_url.startsWith('https:'),requiredEvents:[...stripePaymentEvents],
    latestProbe:probe ? { id:probe.id,state:probe.state==='RUNNING' && probe.expired ? 'INTERRUPTED' : probe.state,
      error_code:probe.state==='RUNNING' && probe.expired ? 'PAYMENT_TEST_INTERRUPTED' : probe.error_code,snapshot:probe.snapshot,created_at:probe.created_at,finished_at:probe.finished_at } : null };
}
export function registerPaymentWebhookRoutes(app:FastifyInstance,db:Database,adapters:PaymentAdapterRegistry=paymentConnectionAdapters):void {
  app.get<{ Params:{ id:string };Querystring:Page }>(root+'/webhooks',{ schema:{ params,querystring:pageSchema } },async(request)=> {
    const actor=await principalFromRequest(request,db);const limit=request.query.limit ?? 20;const cursor=decodeCursor(request.query.cursor);
    return db.begin(async(tx)=> { const c=await managed(tx,actor,request,request.params.id);
      const rows=await tx`SELECT id,connection_version,mode,callback_url,state,external_endpoint_id,version,created_at,last_signed_at
        FROM payment_webhook WHERE connection_id=${c.id}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;
      const items=rows.slice(0,limit);const last=items.at(-1);return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null }; });
  });
  app.get<{ Params:Scope }>(root+'/webhooks/:webhookId',{ schema:{ params:endpointParams } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> { const c=await managed(tx,actor,request,request.params.id);
      return visible(tx,c,await endpoint(tx,c,request.params.webhookId)); });
  });
  app.post<{ Params:{ id:string };Body:{ connectionVersion:number;reason:string } }>(root+'/webhooks',{ schema:{ params,body:{ type:'object',additionalProperties:false,
    required:['connectionVersion','reason'],properties:{ connectionVersion:version,reason } } },config:{ rateLimit:{ max:20,timeWindow:'15 minutes' } } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);const why=checkReason(request.body.reason);const id=randomUUID();const url=callbackUrl(id);
    const result=await db.begin(async(tx)=> { const c=await managed(tx,actor,request,request.params.id,true);
      if(c.provider!=='STRIPE' || !adapters[c.provider]?.inspectWebhook)throw new HttpError(409,'PAYMENT_WEBHOOK_UNSUPPORTED');
      if(c.version!==request.body.connectionVersion)throw new HttpError(409,'CONNECTION_VERSION_CONFLICT');
      if(c.status==='DISABLED')throw new HttpError(409,'CONNECTION_DISABLED');if(!await activeBranch(tx,c.branch_id))throw new HttpError(409,'BRANCH_DISABLED');
      if(!await currentPaymentActor(tx,actor,request))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      const w=(await tx`INSERT INTO payment_webhook(id,connection_id,connection_version,mode,callback_url,created_by,updated_by,change_reason)
        VALUES (${id},${c.id},${c.version},${c.config.mode},${url},${actor.id},${actor.id},${why}) RETURNING *`)[0]!;
      await audit(tx,c,actor,'PAYMENT_WEBHOOK_PREPARED',id,{ reason:why,connectionVersion:c.version });return visible(tx,c,w); });reply.code(201);return result;
  });
  app.post<{ Params:Scope;Body:{ version:number;endpointId:string;signingSecret:string;reason:string } }>(root+'/webhooks/:webhookId/configure',{
    schema:{ params:endpointParams,body:{ type:'object',additionalProperties:false,required:['version','endpointId','signingSecret','reason'],properties:{ version,reason,
      endpointId:{ type:'string',pattern:'^we_[A-Za-z0-9]{6,100}$' },signingSecret:{ type:'string',minLength:22,maxLength:206 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);const why=checkReason(request.body.reason);validateStripeWebhookSecret(request.body.signingSecret);
    return db.begin(async(tx)=> { const c=await managed(tx,actor,request,request.params.id,true);const w=await endpoint(tx,c,request.params.webhookId,true);
      if(w.version!==request.body.version)throw new HttpError(409,'PAYMENT_WEBHOOK_VERSION_CONFLICT');
      if(w.state!=='DRAFT')throw new HttpError(409,'PAYMENT_WEBHOOK_CONFIG_IMMUTABLE');
      if(c.status==='DISABLED' || w.connection_version!==c.version || w.mode!==c.config.mode)throw new HttpError(409,'PAYMENT_WEBHOOK_CONNECTION_STALE');
      if(!await activeBranch(tx,c.branch_id))throw new HttpError(409,'BRANCH_DISABLED');
      if(!await currentPaymentActor(tx,actor,request))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      const sealed=sealOpaque('payment-webhook:'+w.id,request.body.signingSecret);
      const updated=(await tx`UPDATE payment_webhook SET state='CONFIGURED',external_endpoint_id=${request.body.endpointId},ciphertext=${sealed.ciphertext},nonce=${sealed.nonce},
        auth_tag=${sealed.authTag},key_version=${sealed.keyVersion},version=version+1,updated_by=${actor.id},change_reason=${why},updated_at=clock_timestamp() WHERE id=${w.id} RETURNING *`)[0]!;
      await audit(tx,c,actor,'PAYMENT_WEBHOOK_CONFIGURED',w.id,{ reason:why });return visible(tx,c,updated); });
  });
  app.post<{ Params:Scope;Body:{ version:number;reason:string } }>(root+'/webhooks/:webhookId/disable',{ schema:{ params:endpointParams,body:{ type:'object',additionalProperties:false,
    required:['version','reason'],properties:{ version,reason } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const why=checkReason(request.body.reason);
    return db.begin(async(tx)=> { const c=await managed(tx,actor,request,request.params.id,true);const w=await endpoint(tx,c,request.params.webhookId,true);
      if(w.version!==request.body.version)throw new HttpError(409,'PAYMENT_WEBHOOK_VERSION_CONFLICT');if(w.state==='DISABLED')throw new HttpError(409,'PAYMENT_WEBHOOK_DISABLED');
      if(!await currentPaymentActor(tx,actor,request))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      const updated=(await tx`UPDATE payment_webhook SET state='DISABLED',version=version+1,updated_by=${actor.id},change_reason=${why},updated_at=clock_timestamp() WHERE id=${w.id} RETURNING *`)[0]!;
      await audit(tx,c,actor,'PAYMENT_WEBHOOK_DISABLED',w.id,{ reason:why });return visible(tx,c,updated); });
  });
  app.post<{ Params:Scope;Body:{ version:number;connectionVersion:number } }>(root+'/webhooks/:webhookId/test',{ schema:{ params:endpointParams,body:{ type:'object',additionalProperties:false,
    required:['version','connectionVersion'],properties:{ version,connectionVersion:version } } },config:{ rateLimit:{ max:10,timeWindow:'15 minutes' } } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);
    const claim=await db.begin(async(tx)=> { const c=await managed(tx,actor,request,request.params.id,true);const w=await endpoint(tx,c,request.params.webhookId,true);
      if(w.version!==request.body.version || c.version!==request.body.connectionVersion)throw new HttpError(409,'PAYMENT_WEBHOOK_VERSION_CONFLICT');
      if(w.state!=='CONFIGURED' || c.status==='DISABLED' || w.connection_version!==c.version || w.mode!==c.config.mode)throw new HttpError(409,'PAYMENT_WEBHOOK_CONNECTION_STALE');
      if(!await activeBranch(tx,c.branch_id))throw new HttpError(409,'BRANCH_DISABLED');
      if(!await currentPaymentActor(tx,actor,request))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      const sealed=(await tx`SELECT * FROM connection_secret WHERE connection_id=${c.id}`)[0];if(!sealed)throw new HttpError(409,'PAYMENT_CREDENTIAL_MISSING');
      const credentials=JSON.parse(openSecret(c.id,{ ciphertext:sealed.ciphertext,nonce:sealed.nonce,authTag:sealed.auth_tag,keyVersion:sealed.key_version })) as PaymentCredentials;
      validatePaymentCredentials(c.config,credentials);
      const probe=(await tx`INSERT INTO payment_webhook_probe(webhook_id,connection_version,actor_user_id,actor_role,actor_branch_id)
        VALUES (${w.id},${c.version},${actor.id},${actor.role},${actor.branchId}) RETURNING id`)[0]!;
      await audit(tx,c,actor,'PAYMENT_WEBHOOK_TEST_STARTED',w.id,{ probeId:probe.id });return { c,w,credentials,probeId:probe.id }; });
    let code:string|null=null;let snapshot:PaymentWebhookInspection|null=null;
    try { const adapter=adapters[claim.c.provider];if(!adapter?.inspectWebhook)throw new PaymentProviderError('PAYMENT_WEBHOOK_UNSUPPORTED');
      snapshot=checkedWebhookInspection(await adapter.inspectWebhook(claim.c.config,claim.credentials,claim.w.external_endpoint_id),{ mode:claim.w.mode,endpointId:claim.w.external_endpoint_id,callbackUrl:claim.w.callback_url });
    }catch(error){ code=error instanceof PaymentProviderError ? error.code : 'PAYMENT_PROVIDER_UNAVAILABLE'; }
    const result=await db.begin(async(tx)=> {
      const c=(await tx`SELECT * FROM integration_connection WHERE id=${claim.c.id} FOR UPDATE`)[0]!;
      const w=await endpoint(tx,c,claim.w.id,true);const p=(await tx`SELECT * FROM payment_webhook_probe WHERE id=${claim.probeId} FOR UPDATE`)[0]!;
      const allowed=await currentPaymentActor(tx,actor,request);const branch=await activeBranch(tx,c.branch_id);
      const latest=(await tx`SELECT id FROM payment_webhook_probe WHERE webhook_id=${w.id} ORDER BY probe_number DESC LIMIT 1`)[0]!.id===p.id;
      const expiry=(await tx`SELECT expires_at<=clock_timestamp() AS expired FROM payment_webhook_probe WHERE id=${p.id}`)[0]!.expired;
      const currentAllowed=allowed && await currentPaymentActor(tx,actor,request);
      const stale=c.version!==claim.c.version || c.status==='DISABLED' || w.version!==claim.w.version || w.state!=='CONFIGURED' || !latest || expiry===true;
      const state=!currentAllowed || !branch ? 'BLOCKED' : stale ? 'SUPERSEDED' : code ? 'FAILED' : 'VERIFIED';
      const errorCode=!currentAllowed ? 'PAYMENT_ACCESS_REVOKED' : !branch ? 'BRANCH_DISABLED' : stale ? 'PAYMENT_TEST_SUPERSEDED' : code;
      await tx`UPDATE payment_webhook_probe SET state=${state},error_code=${errorCode},snapshot=${state==='VERIFIED' && snapshot ? tx.json(snapshot) : null},finished_at=clock_timestamp() WHERE id=${p.id}`;
      await audit(tx,c,actor,'PAYMENT_WEBHOOK_TEST_FINISHED',w.id,{ probeId:p.id,state,errorCode });
      return { state,errorCode,probeId:p.id,httpStatus:!currentAllowed ? 403 : !branch || stale ? 409 : code ? 502 : 200 }; });
    reply.code(result.httpStatus);const { httpStatus,...safe }=result;return { ...safe,...(httpStatus!==200 ? { error:result.errorCode } : {}) };
  });
  app.get<{ Params:Scope;Querystring:Page }>(root+'/webhooks/:webhookId/history',{ schema:{ params:endpointParams,querystring:pageSchema } },async(request)=> {
    const actor=await principalFromRequest(request,db);const limit=request.query.limit ?? 20;const cursor=decodeCursor(request.query.cursor);
    return db.begin(async(tx)=> { const c=await managed(tx,actor,request,request.params.id);await endpoint(tx,c,request.params.webhookId);
      const rows=await tx`SELECT id,connection_version,snapshot,created_at,finished_at,
        CASE WHEN state='RUNNING' AND expires_at<=clock_timestamp() THEN 'INTERRUPTED' ELSE state END AS state,
        CASE WHEN state='RUNNING' AND expires_at<=clock_timestamp() THEN 'PAYMENT_TEST_INTERRUPTED' ELSE error_code END AS error_code
        FROM payment_webhook_probe WHERE webhook_id=${request.params.webhookId}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;const items=rows.slice(0,limit);const last=items.at(-1);
      return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null }; });
  });
  app.get<{ Params:{ id:string };Querystring:Page }>(root+'/webhook-events',{ schema:{ params,querystring:pageSchema } },async(request)=> {
    const actor=await principalFromRequest(request,db);const limit=request.query.limit ?? 20;const cursor=decodeCursor(request.query.cursor);
    return db.begin(async(tx)=> { const c=await managed(tx,actor,request,request.params.id);
      // Setup telemetry has no raw event, customer, amount, provider metadata or financial status claim.
      const rows=await tx`SELECT id,webhook_id,mode,external_event_id,event_type,provider_created_at,received_at FROM payment_webhook_event
        WHERE connection_id=${c.id} AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (received_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY received_at DESC,id DESC LIMIT ${limit+1}`;const items=rows.slice(0,limit).map((r)=>({ ...r,state:'RECEIVED_NOT_PROCESSED' }));const last=rows.slice(0,limit).at(-1);
      return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.received_at.toISOString(),id:last.id }) : null,financialProcessingReady:false }; });
  });
  app.register(async(webhook)=> {
    webhook.addContentTypeParser('application/json',{ parseAs:'buffer' },(_request,body,done)=>done(null,body));
    webhook.post<{ Params:{ webhookId:string };Body:Buffer }>('/api/webhooks/payments/stripe/:webhookId',{ bodyLimit:65536,
      schema:{ params:{ type:'object',additionalProperties:false,required:['webhookId'],properties:{ webhookId:{ type:'string',format:'uuid' } } } },
      config:{ rateLimit:{ max:300,timeWindow:'1 minute' } },
    },async(request)=> {
      return db.begin(async(tx)=> {
        // Same lock order as setup. Connection disabling gates new work, not historical money receipts.
        const ref=(await tx`SELECT connection_id FROM payment_webhook WHERE id=${request.params.webhookId}`)[0];if(!ref)throw new HttpError(404,'PAYMENT_WEBHOOK_NOT_FOUND');
        const c=(await tx`SELECT * FROM integration_connection WHERE id=${ref.connection_id} AND kind='PAYMENT' AND provider='STRIPE' FOR SHARE`)[0];if(!c)throw new HttpError(404,'PAYMENT_WEBHOOK_NOT_FOUND');
        const w=await endpoint(tx,c,request.params.webhookId,true);if(w.state!=='CONFIGURED')throw new HttpError(409,'PAYMENT_WEBHOOK_NOT_CONFIGURED');
        const secret=openOpaque('payment-webhook:'+w.id,{ ciphertext:w.ciphertext,nonce:w.nonce,authTag:w.auth_tag,keyVersion:w.key_version });
        const clock=(await tx`SELECT extract(epoch FROM clock_timestamp())::double precision AS seconds`)[0]!.seconds as number;
        verifyStripePaymentSignature(request.body,request.headers['stripe-signature'],secret,clock);const parsed=parseStripePaymentReceipt(request.body,w.mode);
        const id=randomUUID();const sealed=sealOpaque('payment-event:'+id,parsed.raw);
        const inserted=(await tx`INSERT INTO payment_webhook_event(id,webhook_id,connection_id,mode,external_event_id,event_type,object_id,object_type,provider_created_at,semantic_hash,ciphertext,nonce,auth_tag,key_version)
          VALUES (${id},${w.id},${c.id},${parsed.mode},${parsed.externalId},${parsed.type},${parsed.objectId},${parsed.objectType},${new Date(parsed.created*1000)},${parsed.semanticHash},
            ${sealed.ciphertext},${sealed.nonce},${sealed.authTag},${sealed.keyVersion}) ON CONFLICT(connection_id,mode,external_event_id) DO NOTHING RETURNING id`)[0];
        const event=inserted ?? (await tx`SELECT id,semantic_hash FROM payment_webhook_event WHERE connection_id=${c.id} AND mode=${parsed.mode} AND external_event_id=${parsed.externalId}`)[0]!;
        if(!inserted && !Buffer.from(event.semantic_hash).equals(parsed.semanticHash))throw new HttpError(409,'PAYMENT_WEBHOOK_EVENT_CONFLICT');
        const delivery=(await tx`INSERT INTO payment_webhook_delivery(webhook_id,event_id) VALUES (${w.id},${event.id}) ON CONFLICT DO NOTHING RETURNING received_at`)[0];
        if(delivery) { await tx`UPDATE payment_webhook SET last_signed_at=(SELECT received_at FROM payment_webhook_delivery WHERE webhook_id=${w.id} AND event_id=${event.id}) WHERE id=${w.id}`;
          await audit(tx,c,null,'PAYMENT_WEBHOOK_RECEIVED',w.id,{ eventId:event.id,duplicate:!inserted }); }
        return { accepted:true,duplicate:!inserted };
      });
    });
  });
}
