import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { sessionCookie } from '../config.js';
import { openSecret, sealOpaque } from '../credentials.js';
import { HttpError, principalFromRequest, sha256, type Principal } from '../security.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { currentPaymentActor } from '../payments/access.js';
import { paymentCheckoutAdapters, type PaymentCheckoutAdapter } from '../payments/checkout-provider.js';
import { normalizePaymentProviderOptions, validatePaymentCredentials, type PaymentConfig, type PaymentCredentials } from '../payments/providers.js';
import { linkIntentDto, normalizedLinkRequest, paymentReturnTargets, preparationIssues, type PaymentLinkRequest } from '../payments/link-intent.js';

const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:{ type:'string',format:'uuid' } } } as const;
const pageSchema={ type:'object',additionalProperties:false,properties:{ limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 } } } as const;
type Page={ limit?:number;cursor?:string };
type Adapters=Readonly<Record<string,PaymentCheckoutAdapter>>;
async function visibleLead(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,id:string) {
  const row=(await tx`SELECT * FROM lead WHERE id=${id} AND organization_id=${actor.organizationId}
    AND (${actor.role==='SUPER_ADMIN'} OR (${actor.role==='MANAGER'} AND branch_id=${actor.branchId})
      OR (${actor.role==='AGENT'} AND assigned_agent_id=${actor.id} AND branch_id=${actor.branchId})) FOR SHARE`)[0];
  if(!row)throw new HttpError(404,'LEAD_NOT_FOUND');
  if(!await currentPaymentActor(tx,actor,request))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');return row;
}
function pageResult(rows:postgres.Row[],limit:number,mapper:(row:postgres.Row)=>unknown) {
  const items=rows.slice(0,limit);const last=items.at(-1);
  return { items:items.map(mapper),nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null };
}

export function registerPaymentLinkRoutes(app:FastifyInstance,db:Database,adapters:Adapters=paymentCheckoutAdapters) {
  app.get<{ Params:{ id:string };Querystring:Page }>('/api/leads/:id/payment-link-options',{ schema:{ params,querystring:pageSchema } },async(request)=> {
    const actor=await principalFromRequest(request,db);const limit=request.query.limit ?? 20;const cursor=decodeCursor(request.query.cursor);
    return db.begin(async(tx)=> {
      const l=await visibleLead(tx,actor,request,request.params.id);
      const rows=await tx`SELECT m.id,m.name,m.version,m.currencies,m.active,m.created_at,b.active AS branch_active,c.status AS connection_status,
        c.capabilities,c.version AS connection_version,c.provider,EXISTS(SELECT 1 FROM payment_webhook w
          WHERE w.connection_id=c.id AND w.connection_version=c.version AND w.mode=c.config->>'mode' AND w.state='CONFIGURED' AND w.last_signed_at IS NOT NULL
          AND (SELECT p.state FROM payment_webhook_probe p WHERE p.webhook_id=w.id ORDER BY p.probe_number DESC LIMIT 1)='VERIFIED') AS webhook_ready
        FROM payment_method m JOIN integration_connection c ON c.id=m.connection_id JOIN branch b ON b.id=m.branch_id
        WHERE m.organization_id=${actor.organizationId} AND m.branch_id=${l.branch_id} AND m.active AND c.kind='PAYMENT'
          AND c.organization_id=m.organization_id AND (c.branch_id IS NULL OR c.branch_id=m.branch_id)
          AND (m.campaign_mode='ALL' OR m.campaign_ids ? ${l.campaign_id}::text)
          AND (${actor.role!=='AGENT'} OR m.agent_mode='ALL' OR m.agent_ids ? ${actor.id}::text)
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (m.created_at,m.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY m.created_at DESC,m.id DESC LIMIT ${limit+1}`;
      if(!await currentPaymentActor(tx,actor,request))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      return pageResult(rows,limit,(row)=> {
        const issues=preparationIssues(row);if(!adapters[row.provider])issues.push('PAYMENT_CHECKOUT_UNSUPPORTED');
        return { id:row.id,name:row.name,version:row.version,currencies:row.currencies,preparationAvailable:issues.length===0,issues };
      });
    });
  });
  app.get<{ Params:{ id:string };Querystring:Page }>('/api/leads/:id/payment-link-requests',{ schema:{ params,querystring:pageSchema } },async(request)=> {
    const actor=await principalFromRequest(request,db);const limit=request.query.limit ?? 20;const cursor=decodeCursor(request.query.cursor);
    return db.begin(async(tx)=> {
      await visibleLead(tx,actor,request,request.params.id);
      const rows=await tx`SELECT id,method_name,method_version,amount,currency,created_at FROM payment_link_intent WHERE lead_id=${request.params.id}
        AND organization_id=${actor.organizationId} AND (${cursor?.timestamp ?? null}::timestamptz IS NULL
          OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;
      if(!await currentPaymentActor(tx,actor,request))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      return pageResult(rows,limit,linkIntentDto);
    });
  });
  app.post<{ Params:{ id:string };Body:PaymentLinkRequest }>('/api/leads/:id/payment-link-requests',{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['requestId','methodId','methodVersion','amount','currency'],properties:{
      requestId:{ type:'string',format:'uuid' },methodId:{ type:'string',format:'uuid' },methodVersion:{ type:'integer',minimum:1 },
      amount:{ type:'string',minLength:1,maxLength:32 },currency:{ type:'string',pattern:'^[A-Z]{3}$' } } } },
    config:{ rateLimit:{ max:30,timeWindow:'15 minutes' } },
  },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);const input=request.body;const leadId=request.params.id.toLowerCase();
    const result=await db.begin(async(tx)=> {
      // Serialize one logical request before acquiring resources. Replays still require current Lead/session access.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'payment-link:'+leadId+':'+input.requestId.toLowerCase()},0))`;
      const previous=(await tx`SELECT * FROM payment_link_intent WHERE lead_id=${leadId} AND request_id=${input.requestId}`)[0];
      if(previous) {
        await visibleLead(tx,actor,request,leadId);
        const normalized=normalizedLinkRequest(input,{ scale:previous.scale,quantum:previous.quantum });
        if(previous.requester_id!==actor.id || previous.method_id!==normalized.methodId || previous.method_version!==normalized.methodVersion
          || previous.amount!==normalized.money.amount || previous.currency!==normalized.money.currency)throw new HttpError(409,'PAYMENT_REQUEST_IDEMPOTENCY_CONFLICT');
        return { ...linkIntentDto(previous),duplicate:true };
      }
      // Connection -> Branch -> Method -> Endpoint -> Lead -> current User/Session. Provider I/O is never performed here.
      const c=(await tx`SELECT c.* FROM integration_connection c JOIN payment_method m ON m.connection_id=c.id
        WHERE m.id=${input.methodId} AND m.organization_id=${actor.organizationId} AND c.kind='PAYMENT'
          AND c.organization_id=${actor.organizationId} FOR SHARE OF c`)[0];
      if(!c)throw new HttpError(404,'PAYMENT_METHOD_NOT_AVAILABLE');
      const initial=(await tx`SELECT branch_id FROM payment_method WHERE id=${input.methodId}`)[0]!;
      const branch=(await tx`SELECT * FROM branch WHERE id=${initial.branch_id} AND organization_id=${actor.organizationId} FOR SHARE`)[0];
      const m=(await tx`SELECT * FROM payment_method WHERE id=${input.methodId} AND organization_id=${actor.organizationId} FOR SHARE`)[0]!;
      const w=(await tx`SELECT w.* FROM payment_webhook w WHERE w.connection_id=${c.id} AND w.connection_version=${c.version}
        AND w.mode=${c.config.mode} AND w.state='CONFIGURED' AND w.last_signed_at IS NOT NULL
        AND (SELECT p.state FROM payment_webhook_probe p WHERE p.webhook_id=w.id ORDER BY p.probe_number DESC LIMIT 1)='VERIFIED'
        ORDER BY w.created_at DESC,w.id DESC LIMIT 1 FOR SHARE OF w`)[0];
      const l=await visibleLead(tx,actor,request,leadId);
      if(m.branch_id!==l.branch_id || m.connection_id!==c.id || (c.branch_id && c.branch_id!==l.branch_id)
        || (m.campaign_mode==='SELECTED' && !m.campaign_ids.includes(l.campaign_id))
        || (actor.role==='AGENT' && m.agent_mode==='SELECTED' && !m.agent_ids.includes(actor.id)))throw new HttpError(404,'PAYMENT_METHOD_NOT_AVAILABLE');
      if(m.version!==input.methodVersion)throw new HttpError(409,'PAYMENT_METHOD_VERSION_CONFLICT');
      // The endpoint lock can wait behind a newer probe; use a fresh SQL snapshot after all waits.
      const latest=w ? (await tx`SELECT state FROM payment_webhook_probe WHERE webhook_id=${w.id} ORDER BY probe_number DESC LIMIT 1`)[0] : null;
      const issues=preparationIssues({ ...m,branch_active:branch?.active,connection_status:c.status,capabilities:c.capabilities,connection_version:c.version,webhook_ready:!!w && latest?.state==='VERIFIED' });
      if(issues.length)throw new HttpError(409,issues[0]!);
      const adapter=adapters[c.provider];if(!adapter)throw new HttpError(409,'PAYMENT_CHECKOUT_UNSUPPORTED');
      const config:PaymentConfig={ mode:c.config.mode };const options=normalizePaymentProviderOptions(c.capabilities.paymentOptions);
      if(!['TEST','LIVE'].includes(config.mode))throw new HttpError(409,'PAYMENT_CONFIG_INVALID');
      if(!m.currencies.includes(input.currency) || !options.currencies.includes(input.currency))throw new HttpError(400,'PAYMENT_CURRENCY_NOT_OFFERED');
      const normalized=normalizedLinkRequest(input,adapter.currencyPrecision(input.currency));
      const currentSecret=(await tx`SELECT * FROM connection_secret WHERE connection_id=${c.id} FOR SHARE`)[0];
      if(!currentSecret)throw new HttpError(409,'PAYMENT_CREDENTIALS_REQUIRED');
      const credentials=JSON.parse(openSecret(c.id,{ ciphertext:currentSecret.ciphertext,nonce:currentSecret.nonce,authTag:currentSecret.auth_tag,keyVersion:currentSecret.key_version })) as PaymentCredentials;
      validatePaymentCredentials(config,credentials);
      const id=randomUUID();const sealed=sealOpaque('payment-link:'+id,JSON.stringify(credentials));const returns=paymentReturnTargets();
      const session=(await tx`SELECT id FROM user_session WHERE user_id=${actor.id} AND token_hash=${sha256(request.cookies[sessionCookie]!)}
        AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`)[0];
      if(!session || !await currentPaymentActor(tx,actor,request))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      const row=(await tx`INSERT INTO payment_link_intent(id,organization_id,branch_id,lead_id,campaign_id,assigned_agent_id,request_id,
        method_id,method_version,method_name,connection_id,connection_version,provider,config_snapshot,mode,account_ref,options_snapshot,webhook_id,webhook_version,
        amount,currency,minor,scale,quantum,success_url,cancel_url,ciphertext,nonce,auth_tag,key_version,requester_id,requester_session_id,requester_role,requester_branch_id)
        VALUES (${id},${actor.organizationId},${l.branch_id},${l.id},${l.campaign_id},${l.assigned_agent_id},${normalized.requestId},
          ${m.id},${m.version},${m.name},${c.id},${c.version},${c.provider},${tx.json(config)},${config.mode},${options.accountRef},${tx.json(options)},${w!.id},${w!.version},
          ${normalized.money.amount},${normalized.money.currency},${normalized.money.minor},${normalized.money.scale},${normalized.money.quantum},${returns.successUrl},${returns.cancelUrl},
          ${sealed.ciphertext},${sealed.nonce},${sealed.authTag},${sealed.keyVersion},${actor.id},${session.id},${actor.role},${actor.branchId}) RETURNING *`)[0]!;
      await tx`INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES (${l.id},${actor.id},'PAYMENT_LINK_REQUESTED',
        ${tx.json({ intentId:id,methodName:m.name,amount:row.amount,currency:row.currency })})`;
      await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${l.branch_id},${actor.id},'PAYMENT_LINK_REQUESTED','PAYMENT_LINK',${id},${tx.json({ methodVersion:m.version })})`;
      return { ...linkIntentDto(row),duplicate:false };
    });reply.code(result.duplicate ? 200 : 201);return result;
  });
}
