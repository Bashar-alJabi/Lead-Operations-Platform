import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { openSecret,sealSecret } from '../credentials.js';
import { HttpError,principalFromRequest,requireRole,type Principal } from '../security.js';
import { decodeCursor,encodeCursor } from '../pagination.js';
import { currentPaymentActor,currentPaymentSession } from '../payments/access.js';
import { paymentConnectionAdapters,PaymentProviderError,validatePaymentCredentials,normalizePaymentProviderOptions,
  checkedPaymentAuthentication,type PaymentAuthenticationSnapshot,type PaymentAdapterRegistry,type PaymentConfig,type PaymentCredentials,type PaymentProviderOptions } from '../payments/providers.js';

const root='/api/payments/connections';
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:{ type:'string',format:'uuid' } } } as const;
const configSchema={ type:'object',additionalProperties:false,required:['mode'],properties:{ mode:{ type:'string',enum:['TEST','LIVE'] },
  expectedMerchantId:{ type:'string',pattern:'^[2-9A-HJ-NP-Z]{13}$',minLength:13,maxLength:13 } } } as const;
const credentialsSchema={ type:'object',additionalProperties:false,properties:{ apiKey:{ type:'string',minLength:20,maxLength:4096 },
  clientId:{ type:'string',minLength:16,maxLength:1024 },clientSecret:{ type:'string',minLength:16,maxLength:4096 } },
  oneOf:[{ required:['apiKey'],not:{ anyOf:[{ required:['clientId'] },{ required:['clientSecret'] }] } },{ required:['clientId','clientSecret'],not:{ required:['apiKey'] } }] } as const;
const version={ type:'integer',minimum:1 } as const;
type Input={ name:string;provider:string;branchId?:string|null;config:PaymentConfig;credentials?:PaymentCredentials;version?:number };
const body={ type:'object',additionalProperties:false,required:['name','provider','config','credentials'],properties:{
  name:{ type:'string',minLength:1,maxLength:100,pattern:'^[^\\x00-\\x1f\\x7f]+$' },provider:{ type:'string',enum:['STRIPE','PAYPAL','ALMA'] },
  branchId:{ anyOf:[{ type:'string',format:'uuid' },{ type:'null' }] },config:configSchema,credentials:credentialsSchema,version } } as const;
async function connection(tx:Database|postgres.TransactionSql,actor:Principal,id:string,lock=false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const row=(await tx`SELECT c.* FROM integration_connection c WHERE c.id=${id} AND c.kind='PAYMENT'
    AND c.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})
    ${lock ? tx`FOR UPDATE OF c` : tx``}`)[0];
  if (!row) throw new HttpError(404,'PAYMENT_CONNECTION_NOT_FOUND');return row;
}
async function branchActive(tx:postgres.TransactionSql,branchId:string|null) {
  return branchId===null || (await tx`SELECT 1 FROM branch WHERE id=${branchId} AND active FOR SHARE`).length>0;
}
async function audit(tx:postgres.TransactionSql,actor:Principal,row:postgres.Row,action:string,detail:postgres.JSONValue={}) {
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (${actor.organizationId},${row.branch_id},${actor.id},${action},'CONNECTION',${row.id},${tx.json(detail)})`;
}
async function savedCredentials(tx:Database|postgres.TransactionSql,id:string):Promise<PaymentCredentials> {
  const secret=(await tx`SELECT * FROM connection_secret WHERE connection_id=${id}`)[0];
  if (!secret) throw new HttpError(409,'PAYMENT_CREDENTIAL_MISSING');
  return JSON.parse(openSecret(id,{ ciphertext:secret.ciphertext,nonce:secret.nonce,authTag:secret.auth_tag,keyVersion:secret.key_version })) as PaymentCredentials;
}
async function beneficiaryHistory(tx:postgres.TransactionSql,actor:Principal,row:postgres.Row,config:PaymentConfig,connectionVersion:number) {
  if(row.provider!=='PAYPAL')return;
  const item=(await tx`INSERT INTO payment_beneficiary_configuration(connection_id,connection_version,mode,expected_merchant_id,actor_user_id,actor_role,actor_branch_id)
    VALUES (${row.id},${connectionVersion},${config.mode},${config.expectedMerchantId ?? null},${actor.id},${actor.role},${actor.branchId}) RETURNING id`)[0]!;
  await audit(tx,actor,row,'PAYMENT_BENEFICIARY_CONFIGURED',{ configurationId:item.id,version:connectionVersion,mode:config.mode,
    expectedMerchantId:config.expectedMerchantId ?? null,identityStatus:'CONFIGURED_EXPECTATION' });
}
export function registerPaymentConnectionRoutes(app:FastifyInstance,db:Database,adapters:PaymentAdapterRegistry=paymentConnectionAdapters) {
  app.get<{ Params:{ id:string } }>(root+'/:id',{ schema:{ params } },async(request)=> {
    const actor=await principalFromRequest(request,db);const row=await connection(db,actor,request.params.id);
    const secret=(await db`SELECT 1 FROM connection_secret WHERE connection_id=${row.id}`).length>0;
    return { id:row.id,name:row.name,branch_id:row.branch_id,provider:row.provider,status:row.status,config:row.config,capabilities:row.capabilities,
      version:row.version,last_success_at:row.last_success_at,last_failure_at:row.last_failure_at,last_error_code:row.last_error_code,secret_configured:secret };
  });
  app.get<{ Querystring:{ limit?:number;cursor?:string } }>(root,{ schema:{ querystring:{ type:'object',additionalProperties:false,
    properties:{ limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT c.id,c.branch_id,c.provider,c.name,c.status,c.config,c.capabilities,c.version,c.last_success_at,c.last_failure_at,c.last_error_code,c.created_at,
      EXISTS(SELECT 1 FROM connection_secret s WHERE s.connection_id=c.id) AS secret_configured
      FROM integration_connection c WHERE c.kind='PAYMENT' AND c.organization_id=${actor.organizationId}
        AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (c.created_at,c.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY c.created_at DESC,c.id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null };
  });
  app.post<{ Body:Input }>(root,{ schema:{ body } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');
    const branchId=actor.role==='MANAGER' ? actor.branchId : request.body.branchId ?? null;
    if (actor.role==='MANAGER' && (!branchId || (Object.hasOwn(request.body,'branchId') && request.body.branchId!==branchId))) throw new HttpError(403,'FORBIDDEN');
    validatePaymentCredentials(request.body.config,request.body.credentials!,request.body.provider);if (!request.body.name.trim()) throw new HttpError(400,'NAME_REQUIRED');
    const id=randomUUID();const sealed=sealSecret(id,JSON.stringify(request.body.credentials));
    await db.begin(async(tx)=> {
      if (!(await currentPaymentActor(tx,actor,request))) throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      if (branchId && !(await tx`SELECT 1 FROM branch WHERE id=${branchId} AND organization_id=${actor.organizationId} AND active FOR SHARE`).length)
        throw new HttpError(404,'BRANCH_NOT_AVAILABLE');
      await tx`INSERT INTO integration_connection(id,organization_id,branch_id,kind,provider,name,config,created_by)
        VALUES (${id},${actor.organizationId},${branchId},'PAYMENT',${request.body.provider},${request.body.name.trim()},${tx.json(request.body.config)},${actor.id})`;
      await tx`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag,key_version)
        VALUES (${id},${sealed.ciphertext},${sealed.nonce},${sealed.authTag},${sealed.keyVersion})`;
      await audit(tx,actor,{ id,branch_id:branchId },'PAYMENT_CONNECTION_CREATED');
      await beneficiaryHistory(tx,actor,{ id,branch_id:branchId,provider:request.body.provider },request.body.config,1);
    });reply.code(201);return { id,status:'NOT_CONFIGURED',version:1 };
  });
  app.put<{ Params:{ id:string };Body:Input }>(root+'/:id',{ schema:{ params,body:{ ...body,required:['name','provider','config','version'] } } },async(request)=> {
    const actor=await principalFromRequest(request,db);
    return db.begin(async(tx)=> {
      const row=await connection(tx,actor,request.params.id,true);
      if (!(await currentPaymentActor(tx,actor,request))) throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      if (row.version!==request.body.version) throw new HttpError(409,'CONNECTION_VERSION_CONFLICT');
      if (row.status==='DISABLED') throw new HttpError(409,'CONNECTION_DISABLED');
      if (row.provider!==request.body.provider || (Object.hasOwn(request.body,'branchId') && request.body.branchId!==row.branch_id)) throw new HttpError(400,'CONNECTION_SCOPE_IMMUTABLE');
      if (!(await branchActive(tx,row.branch_id))) throw new HttpError(409,'BRANCH_DISABLED');
      if (!request.body.name.trim()) throw new HttpError(400,'NAME_REQUIRED');
      const credentials=request.body.credentials ?? await savedCredentials(tx,row.id);validatePaymentCredentials(request.body.config,credentials,row.provider);
      if (request.body.credentials) { const sealed=sealSecret(row.id,JSON.stringify(credentials));
        await tx`UPDATE connection_secret SET ciphertext=${sealed.ciphertext},nonce=${sealed.nonce},auth_tag=${sealed.authTag},key_version=${sealed.keyVersion},updated_at=now() WHERE connection_id=${row.id}`; }
      const result=(await tx`UPDATE integration_connection SET name=${request.body.name.trim()},config=${tx.json(request.body.config)},version=version+1,
        status='NOT_CONFIGURED',capabilities='{}'::jsonb,last_error_code=NULL,updated_at=now() WHERE id=${row.id} RETURNING version,status`)[0]!;
      await audit(tx,actor,row,'PAYMENT_CONNECTION_UPDATED');
      await beneficiaryHistory(tx,actor,row,request.body.config,result.version);return result;
    });
  });
  for (const action of ['disable','reconnect'] as const) app.post<{ Params:{ id:string };Body:{ version:number;reason:string } }>(root+'/:id/'+action,
    { schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','reason'],properties:{ version,reason:{ type:'string',minLength:3,maxLength:500 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);if (request.body.reason.trim().length<3) throw new HttpError(400,'REASON_REQUIRED');
    return db.begin(async(tx)=> { const row=await connection(tx,actor,request.params.id,true);
      if (!(await currentPaymentActor(tx,actor,request))) throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      if (row.version!==request.body.version) throw new HttpError(409,'CONNECTION_VERSION_CONFLICT');
      if (action==='reconnect' && !(await branchActive(tx,row.branch_id))) throw new HttpError(409,'BRANCH_DISABLED');
      const result=(await tx`UPDATE integration_connection SET status=${action==='disable' ? 'DISABLED' : 'NOT_CONFIGURED'},version=version+1,
        capabilities='{}'::jsonb,last_error_code=NULL,updated_at=now() WHERE id=${row.id} RETURNING version,status`)[0]!;
      await audit(tx,actor,row,action==='disable' ? 'PAYMENT_CONNECTION_DISABLED' : 'PAYMENT_CONNECTION_RECONNECTED',{ reason:request.body.reason.trim() });return result;
    });
  });
  app.get<{ Params:{ id:string };Querystring:{ limit?:number;cursor?:string } }>(root+'/:id/beneficiary-history',{ schema:{ params,querystring:{ type:'object',additionalProperties:false,
    properties:{ limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const row=await connection(db,actor,request.params.id);
    if(row.provider!=='PAYPAL')throw new HttpError(404,'PAYMENT_BENEFICIARY_PROFILE_UNSUPPORTED');
    const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 20;
    const rows=await db`SELECT h.id,h.connection_version,h.mode,h.expected_merchant_id,h.actor_user_id,h.actor_role,h.created_at
      FROM payment_beneficiary_configuration h WHERE h.connection_id=${row.id}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (h.created_at,h.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY h.created_at DESC,h.id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null,
      identityStatus:'CONFIGURED_EXPECTATION' };
  });
  app.get<{ Params:{ id:string };Querystring:{ limit?:number;cursor?:string } }>(root+'/:id/history',{ schema:{ params,querystring:{ type:'object',additionalProperties:false,
    properties:{ limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);await connection(db,actor,request.params.id);const limit=request.query.limit ?? 20;const cursor=decodeCursor(request.query.cursor);
    const rows=await db`SELECT p.id,p.connection_version,p.created_at,p.finished_at,p.purpose,p.options_snapshot,p.authentication_snapshot,
      CASE WHEN p.state='RUNNING' AND p.expires_at<now() THEN 'INTERRUPTED' ELSE p.state END AS state,
      CASE WHEN p.state='RUNNING' AND p.expires_at<now() THEN 'PAYMENT_TEST_INTERRUPTED' ELSE p.error_code END AS error_code
      FROM payment_connection_probe p JOIN integration_connection c ON c.id=p.connection_id
      WHERE p.connection_id=${request.params.id} AND c.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (p.created_at,p.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY p.created_at DESC,p.id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null };
  });
  app.post<{ Params:{ id:string };Body:{ version:number;inspectOptions?:boolean } }>(root+'/:id/test',{ schema:{ params,body:{ type:'object',additionalProperties:false,required:['version'],properties:{ version,inspectOptions:{ type:'boolean' } } } },
    config:{ rateLimit:{ max:10,timeWindow:'15 minutes' } } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);
    const claim=await db.begin(async(tx)=> { const row=await connection(tx,actor,request.params.id,true);
      const sessionId=await currentPaymentSession(tx,actor,request);if (!sessionId) throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
      if (row.version!==request.body.version) throw new HttpError(409,'CONNECTION_VERSION_CONFLICT');
      if (row.status==='DISABLED') throw new HttpError(409,'CONNECTION_DISABLED');
      if (!(await branchActive(tx,row.branch_id))) throw new HttpError(409,'BRANCH_DISABLED');
      const credentials=await savedCredentials(tx,row.id);validatePaymentCredentials(row.config,credentials,row.provider);
      const purpose=request.body.inspectOptions ? 'OPTIONS' : 'AUTH';
      const probe=(await tx`INSERT INTO payment_connection_probe(connection_id,connection_version,actor_user_id,actor_role,actor_branch_id,purpose,actor_session_id)
        VALUES (${row.id},${row.version},${actor.id},${actor.role},${actor.branchId},${purpose},${row.provider==='ALMA' ? sessionId : null}) RETURNING id`)[0]!;
      await audit(tx,actor,row,'PAYMENT_CONNECTION_TEST_STARTED',{ probeId:probe.id,version:row.version,purpose });return { row,credentials,probeId:probe.id as string,purpose };
    });
    let code:string|null=null;let providerOptions:PaymentProviderOptions|null=null;let authentication:PaymentAuthenticationSnapshot|null=null;
    try { const adapter=adapters[claim.row.provider];if (!adapter) throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
      if(claim.purpose==='OPTIONS') {
        if(!adapter.inspect)throw new PaymentProviderError('PAYMENT_PROVIDER_OPTIONS_UNSUPPORTED');
        const inspected=await adapter.inspect(claim.row.config,claim.credentials);
        if(!inspected || inspected.mode!==claim.row.config.mode)throw new PaymentProviderError('PAYMENT_MODE_MISMATCH');
        providerOptions=normalizePaymentProviderOptions(inspected.options);
      } else { const verified=await adapter.verify(claim.row.config,claim.credentials);
        if (!verified || verified.mode!==claim.row.config.mode) throw new PaymentProviderError('PAYMENT_MODE_MISMATCH');
        authentication=checkedPaymentAuthentication(verified.authentication,claim.row.provider,claim.row.config); } }
    catch(error) { code=error instanceof PaymentProviderError ? error.code : 'PAYMENT_PROVIDER_UNAVAILABLE'; }
    const result=await db.begin(async(tx)=> {
      const row=(await tx`SELECT * FROM integration_connection WHERE id=${claim.row.id} FOR UPDATE`)[0]!;
      const probe=(await tx`SELECT *,expires_at<=clock_timestamp() AS expired FROM payment_connection_probe WHERE id=${claim.probeId} FOR UPDATE`)[0]!;
      const allowed=await currentPaymentActor(tx,actor,request);
      const latest=(await tx`SELECT id FROM payment_connection_probe WHERE connection_id=${row.id} ORDER BY probe_number DESC LIMIT 1`)[0]!.id===probe.id;
      const stale=row.version!==claim.row.version || row.status==='DISABLED' || !latest || probe.expired===true;
      const available=await branchActive(tx,row.branch_id);
      const outcome=!allowed || !available ? 'BLOCKED' : stale ? 'SUPERSEDED' : code ? 'FAILED' : 'VERIFIED';
      const errorCode=!allowed ? 'PAYMENT_ACCESS_REVOKED' : !available ? 'BRANCH_DISABLED' : stale ? 'PAYMENT_TEST_SUPERSEDED' : code;
      const finished=(await tx`UPDATE payment_connection_probe SET state=${outcome},error_code=${errorCode},options_snapshot=${outcome==='VERIFIED' && providerOptions ? tx.json(providerOptions) : null},
        authentication_snapshot=${outcome==='VERIFIED' && authentication ? tx.json(authentication) : null},finished_at=clock_timestamp() WHERE id=${probe.id} RETURNING finished_at`)[0]!;
      const priorOptions=row.capabilities.paymentOptionsVersion===row.version && row.capabilities.paymentOptions
        ? { paymentOptions:row.capabilities.paymentOptions,paymentOptionsVersion:row.version,paymentOptionsAt:row.capabilities.paymentOptionsAt } : {};
      if (allowed && available && !stale) await tx`UPDATE integration_connection SET status=${code ? code==='PAYMENT_PROVIDER_AUTH_FAILED' ? 'AUTH_EXPIRED' : 'ERROR' : 'WARNING'},
        capabilities=${tx.json(code ? {} : { authenticationVerified:true,mode:row.config.mode,paymentLinksReady:false,webhookReady:false,...priorOptions,
          ...(authentication ? { authentication,authenticationVersion:row.version,authenticationAt:finished.finished_at.toISOString() } : {}),
          ...(providerOptions ? { paymentOptions:providerOptions,paymentOptionsVersion:row.version,paymentOptionsAt:finished.finished_at.toISOString() } : {}) })},
        last_success_at=CASE WHEN ${code===null} THEN now() ELSE last_success_at END,last_failure_at=CASE WHEN ${code!==null} THEN now() ELSE last_failure_at END,
        last_error_code=${code ?? 'PAYMENT_FLOW_NOT_READY'},updated_at=now() WHERE id=${row.id}`;
      await audit(tx,actor,row,'PAYMENT_CONNECTION_TEST_FINISHED',{ probeId:probe.id,outcome,errorCode });
      return { state:outcome,errorCode,probeId:probe.id,httpStatus:!allowed ? 403 : stale || !available ? 409 : code ? 502 : 200 };
    });reply.code(result.httpStatus);const { httpStatus:_,...visible }=result;return { ...visible,...(result.httpStatus!==200 ? { error:result.errorCode } : {}) };
  });
}
