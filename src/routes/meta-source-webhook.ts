import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest } from '../security.js';
import { managedSourceConnection,recheckSourceActor } from '../sources/catalog-sync.js';
import { sourceCredentials,checkSourceSubscription } from '../sources/subscription.js';
import { metaLeadSourceSubscriptionAdapter,type LeadSourceSubscriptionAdapter } from '../sources/meta-subscription.js';
import { parseSourceWebhook,sourceSecretEqual,verifySourceSignature } from '../sources/webhook.js';
import { decodeCursor,encodeCursor } from '../pagination.js';

const root='/api/sources/meta/connections';
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:{ type:'string',format:'uuid' } } } as const;
async function callbackConnection(db:Database,id:string) {
  const row=(await db`SELECT id,version,status FROM integration_connection WHERE id=${id} AND kind='META' AND provider='META_LEAD_ADS'`)[0];
  if (!row) throw new HttpError(404,'SOURCE_CONNECTION_NOT_FOUND');
  if (row.status==='DISABLED') throw new HttpError(409,'SOURCE_CONNECTION_DISABLED');return row;
}
export function registerMetaSourceWebhookRoutes(app:FastifyInstance,db:Database,adapter:LeadSourceSubscriptionAdapter=metaLeadSourceSubscriptionAdapter):void {
  app.get<{ Params:{ id:string };Querystring:{ pageId?:string } }>(root+'/:id/webhook',{ schema:{ params,querystring:{
    type:'object',additionalProperties:false,properties:{ pageId:{ type:'string',format:'uuid' } },
  } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const connection=await managedSourceConnection(db,actor,request.params.id);
    if (request.query.pageId && !(await db`SELECT 1 FROM source_resource WHERE id=${request.query.pageId} AND connection_id=${connection.id} AND resource_kind='PAGE'`).length)
      throw new HttpError(404,'SOURCE_PAGE_NOT_FOUND');
    const capability=(await db`SELECT capabilities FROM integration_connection WHERE id=${connection.id}`)[0]!.capabilities;
    const latest=request.query.pageId ? (await db`SELECT state,subscribed,error_code,started_at,finished_at,connection_version,page_version
      FROM source_subscription_attempt WHERE connection_id=${connection.id} AND page_id=${request.query.pageId} ORDER BY started_at DESC,id DESC LIMIT 1`)[0] : null;
    const page=request.query.pageId ? (await db`SELECT active,version,connection_version FROM source_resource WHERE id=${request.query.pageId}`)[0] : null;
    const health=(await db`SELECT count(*) FILTER (WHERE j.state='PENDING')::integer AS pending,
      count(*) FILTER (WHERE j.state='RUNNING')::integer AS running,count(*) FILTER (WHERE j.state='FAILED')::integer AS failed,
      count(*) FILTER (WHERE j.state='BLOCKED')::integer AS blocked,count(*) FILTER (WHERE j.state='SUCCEEDED')::integer AS retrieved,
      min(e.received_at) FILTER (WHERE j.state IN ('PENDING','RUNNING')) AS oldest_pending_at,max(e.received_at) AS last_incoming_at
      FROM source_webhook_event e JOIN source_retrieval_job j ON j.event_id=e.id WHERE e.connection_id=${connection.id}`)[0]!;
    return { callbackPath:`/api/webhooks/sources/meta/${connection.id}`,handshakeVerified:capability.sourceHandshakeVerified===true,
      signedCallbackVerified:capability.sourceSignedCallbackVerified===true,handshakeAt:capability.sourceHandshakeAt ?? null,
      lastIncomingAt:health.last_incoming_at,pending:health.pending,oldestPendingAt:health.oldest_pending_at,
      running:health.running,failed:health.failed,blocked:health.blocked,retrieved:health.retrieved,
      subscription:latest ? { ...latest,current:!!page?.active && connection.status!=='DISABLED' && latest.connection_version===connection.version && latest.page_version===page.version } : null,
      appIdConfigured:!!connection.config.appId,intakeReady:false,processingStatus:'SOURCE_INTAKE_NOT_CONFIGURED' };
  });
  app.post<{ Params:{ id:string };Body:{ version:number;pageId:string;pageVersion:number;subscribe:boolean } }>(root+'/:id/subscription',{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','pageId','pageVersion','subscribe'],properties:{
      version:{ type:'integer',minimum:1 },pageId:{ type:'string',format:'uuid' },pageVersion:{ type:'integer',minimum:1 },subscribe:{ type:'boolean' },
    } } },config:{ rateLimit:{ max:10,timeWindow:'15 minutes' } },
  },async(request)=>checkSourceSubscription(db,await principalFromRequest(request,db),request.params.id,request.body,adapter));
  app.get<{ Params:{ id:string };Querystring:{ pageId:string;cursor?:string;limit?:number } }>(root+'/:id/subscription-history',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,required:['pageId'],properties:{ pageId:{ type:'string',format:'uuid' },
      cursor:{ type:'string',maxLength:256 },limit:{ type:'integer',minimum:1,maximum:100 },
    } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);const connection=await managedSourceConnection(db,actor,request.params.id);
    if (!(await db`SELECT 1 FROM source_resource WHERE id=${request.query.pageId} AND connection_id=${connection.id} AND resource_kind='PAGE'`).length)
      throw new HttpError(404,'SOURCE_PAGE_NOT_FOUND');
    const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 20;
    const rows=await db`SELECT id,action,state,subscribed,error_code,started_at,finished_at FROM source_subscription_attempt
      WHERE connection_id=${connection.id} AND page_id=${request.query.pageId}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (started_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY started_at DESC,id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.started_at.toISOString(),id:last.id }) : null };
  });
  app.get<{ Params:{ id:string };Querystring:{ cursor?:string;limit?:number } }>(root+'/:id/webhook-events',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ cursor:{ type:'string',maxLength:256 },limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);const connection=await managedSourceConnection(db,actor,request.params.id);
    const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 20;
    // Operational telemetry only. Raw untrusted payloads and customer data never leave this setup route.
    const rows=await db`SELECT e.id,e.external_page_id,e.external_form_id,e.external_lead_id,e.source_created_at,e.received_at,
      j.state,j.version,j.attempts,j.failures,j.recoveries,j.error_code,j.available_at,j.submission_id
      FROM source_webhook_event e JOIN source_retrieval_job j ON j.event_id=e.id WHERE e.connection_id=${connection.id}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (e.received_at,e.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY e.received_at DESC,e.id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.received_at.toISOString(),id:last.id }) : null };
  });
  const eventParams={ ...params,required:['id','eventId'],properties:{ ...params.properties,eventId:{ type:'string',format:'uuid' } } } as const;
  app.get<{ Params:{ id:string;eventId:string };Querystring:{ beforeAttempt?:number;limit?:number } }>(root+'/:id/webhook-events/:eventId/attempts',{
    schema:{ params:eventParams,querystring:{ type:'object',additionalProperties:false,properties:{ beforeAttempt:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);await managedSourceConnection(db,actor,request.params.id);
    if (!(await db`SELECT 1 FROM source_webhook_event WHERE id=${request.params.eventId} AND connection_id=${request.params.id}`).length)
      throw new HttpError(404,'SOURCE_EVENT_NOT_FOUND');
    const limit=request.query.limit ?? 20;
    const rows=await db`SELECT attempt_number,state,error_code,connection_version,page_version,started_at,finished_at FROM source_retrieval_attempt
      WHERE event_id=${request.params.eventId} AND (${request.query.beforeAttempt ?? null}::integer IS NULL OR attempt_number<${request.query.beforeAttempt ?? null})
      ORDER BY attempt_number DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextBeforeAttempt:rows.length>limit ? items.at(-1)!.attempt_number : null };
  });
  app.post<{ Params:{ id:string;eventId:string };Body:{ version:number;reason:string } }>(root+'/:id/webhook-events/:eventId/retry',{
    schema:{ params:eventParams,body:{ type:'object',additionalProperties:false,required:['version','reason'],properties:{ version:{ type:'integer',minimum:1 },reason:{ type:'string',minLength:1,maxLength:500 } } } },
    config:{ rateLimit:{ max:10,timeWindow:'15 minutes' } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);const connection=await managedSourceConnection(db,actor,request.params.id);
    if (!request.body.reason.trim()) throw new HttpError(400,'SOURCE_RETRY_REASON_REQUIRED');
    return db.begin(async(tx)=> {
      const current=(await tx`SELECT status,version FROM integration_connection WHERE id=${connection.id} FOR UPDATE`)[0]!;
      await recheckSourceActor(tx as unknown as Database,actor);
      const job=(await tx`SELECT j.*,r.active,r.connection_version FROM source_retrieval_job j JOIN source_webhook_event e ON e.id=j.event_id
        JOIN source_resource r ON r.id=e.page_id WHERE j.event_id=${request.params.eventId} AND j.connection_id=${connection.id} FOR UPDATE OF j`)[0];
      if (!job) throw new HttpError(404,'SOURCE_EVENT_NOT_FOUND');
      if (job.version!==request.body.version) throw new HttpError(409,'SOURCE_EVENT_VERSION_CONFLICT');
      if (!['FAILED','BLOCKED'].includes(job.state)) throw new HttpError(409,'SOURCE_RETRIEVAL_NOT_RETRYABLE');
      if (['DISABLED','AUTH_EXPIRED'].includes(current.status) || !job.active || job.connection_version!==current.version)
        throw new HttpError(409,'SOURCE_CONNECTION_NOT_READY');
      await tx`UPDATE source_retrieval_job SET state='PENDING',failures=0,recoveries=recoveries+1,error_code=NULL,version=version+1,
        available_at=now(),updated_at=now() WHERE event_id=${job.event_id}`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${connection.branch_id},${actor.id},'SOURCE_RETRIEVAL_RECOVERED','SOURCE_EVENT',${job.event_id},${tx.json({ reason:request.body.reason.trim(),previousFailures:job.failures })})`;
      return { state:'PENDING',version:job.version+1 };
    });
  });
  app.register(async(webhook)=> {
    webhook.addContentTypeParser('application/json',{ parseAs:'buffer' },(_request,body,done)=>done(null,body));
    webhook.get<{ Params:{ id:string };Querystring:{ 'hub.mode':string;'hub.verify_token':string;'hub.challenge':string } }>('/api/webhooks/sources/meta/:id',{
      schema:{ params,querystring:{ type:'object',additionalProperties:false,required:['hub.mode','hub.verify_token','hub.challenge'],properties:{
        'hub.mode':{ type:'string',enum:['subscribe'] },'hub.verify_token':{ type:'string',maxLength:512 },'hub.challenge':{ type:'string',minLength:1,maxLength:256 },
      } } },config:{ rateLimit:{ max:20,timeWindow:'1 minute' } },
    },async(request,reply)=> {
      const connection=await callbackConnection(db,request.params.id);const credentials=await sourceCredentials(db,connection.id);
      if (!sourceSecretEqual(request.query['hub.verify_token'],credentials.verifyToken)) throw new HttpError(403,'SOURCE_WEBHOOK_VERIFICATION_FAILED');
      await db.begin(async(tx)=> {
        const current=(await tx`SELECT version,status FROM integration_connection WHERE id=${connection.id} FOR UPDATE`)[0]!;
        if (current.version!==connection.version || current.status==='DISABLED') throw new HttpError(409,'SOURCE_CONFIGURATION_CHANGED');
        await tx`UPDATE integration_connection SET capabilities=capabilities || ${tx.json({ sourceHandshakeVerified:true,sourceHandshakeAt:new Date().toISOString() })}
          WHERE id=${connection.id}`;
      });
      reply.type('text/plain').header('Cache-Control','no-store');return request.query['hub.challenge'];
    });
    webhook.post<{ Params:{ id:string };Body:Buffer }>('/api/webhooks/sources/meta/:id',{ schema:{ params } },async(request)=> {
      const connection=await callbackConnection(db,request.params.id);const credentials=await sourceCredentials(db,connection.id);
      if (!Buffer.isBuffer(request.body)) throw new HttpError(400,'SOURCE_WEBHOOK_PAYLOAD_INVALID');
      verifySourceSignature(request.body,request.headers['x-hub-signature-256'],credentials.appSecret);
      let body:unknown;try { body=JSON.parse(request.body.toString('utf8')); } catch { throw new HttpError(400,'SOURCE_WEBHOOK_PAYLOAD_INVALID'); }
      const events=parseSourceWebhook(body);const hash=createHash('sha256').update(request.body).digest();
      return db.begin(async(tx)=> {
        const current=(await tx`SELECT version,status FROM integration_connection WHERE id=${connection.id} FOR UPDATE`)[0]!;
        if (current.version!==connection.version || current.status==='DISABLED') throw new HttpError(409,'SOURCE_CONFIGURATION_CHANGED');
        const pageIds=[...new Set(events.map((e)=>e.pageId))];
        const pages=await tx`SELECT id,external_id FROM source_resource WHERE connection_id=${connection.id} AND resource_kind='PAGE' AND external_id IN ${tx(pageIds)}`;
        const pageMap=new Map(pages.map((page)=>[page.external_id,page.id]));
        // Previously discovered Pages remain known during credential/catalog repair. No guessing an unknown Page's owner.
        if (pages.length!==pageIds.length) throw new HttpError(403,'SOURCE_WEBHOOK_PAGE_NOT_AUTHORIZED');
        for (const event of events) {
          const inserted=await tx`INSERT INTO source_webhook_event (connection_id,connection_version,page_id,external_page_id,external_form_id,external_lead_id,
            source_created_at,raw_notification,envelope_hash) VALUES (${connection.id},${current.version},${pageMap.get(event.pageId)!},${event.pageId},
              ${event.formId},${event.leadId},${event.createdAt},${tx.json(event.raw as Parameters<typeof tx.json>[0])},${hash}) ON CONFLICT (connection_id,external_lead_id) DO NOTHING RETURNING id`;
          if (!inserted.length) {
            const original=(await tx`SELECT external_page_id,external_form_id FROM source_webhook_event WHERE connection_id=${connection.id} AND external_lead_id=${event.leadId}`)[0]!;
            if (original.external_page_id!==event.pageId || original.external_form_id!==event.formId) throw new HttpError(409,'SOURCE_WEBHOOK_IDENTITY_CONFLICT');
          }
        }
        await tx`UPDATE integration_connection SET capabilities=capabilities || '{"sourceSignedCallbackVerified":true,"intakeReady":false}'::jsonb WHERE id=${connection.id}`;
        return { received:true };
      });
    });
  });
}
