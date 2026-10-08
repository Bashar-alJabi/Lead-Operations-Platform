import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,requireRole,type Principal } from '../security.js';
import { openOpaque,sealOpaque } from '../credentials.js';
import { currentPaymentSession } from '../payments/access.js';
import { bankMoney,bankText,parseBankSettlement } from '../payments/bank-transfer.js';
import { persistBankPaymentState } from '../payments/payment-state.js';
import { decodeCursor,encodeCursor } from '../pagination.js';

const uuid={ type:'string',format:'uuid' } as const;
const text=(min:number,max:number)=>({ type:'string',minLength:min,maxLength:max,pattern:'^[^\\x00-\\x1f\\x7f]+$' });
const page={ type:'object',additionalProperties:false,properties:{ limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 } } } as const;
const idParams={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
const transferParams={ ...idParams,required:['id','transferId'],properties:{ id:uuid,transferId:uuid } } as const;
type Page={ limit?:number;cursor?:string };
type AccountInput={ name:string;branchId:string;mode:'TEST'|'LIVE';beneficiary:string;accountIdentifier:string;bankName:string;instructions:string;currencies:string[];active:boolean;reason:string };
type Approval={ transactionId:string;accountIdentifier:string;reference:string;amount:string;currency:string;settledAt:string;reason:string;bankVerified:true };
async function session(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest) {
  const id=await currentPaymentSession(tx,actor,request);if(!id)throw new HttpError(403,'BANK_ACCESS_REVOKED');return id;
}
async function managedAccount(tx:postgres.TransactionSql,actor:Principal,id:string,write=false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const row=(await tx`SELECT a.*,c.name,c.status AS connection_status FROM bank_transfer_account a JOIN integration_connection c ON c.id=a.id
    WHERE a.id=${id} AND a.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR a.branch_id=${actor.branchId})
    ${write ? tx`FOR UPDATE OF a,c` : tx`FOR SHARE OF a,c`}`)[0];
  if(!row)throw new HttpError(404,'BANK_ACCOUNT_NOT_FOUND');return row;
}
async function visibleLead(tx:postgres.TransactionSql,actor:Principal,id:string) {
  const lead=(await tx`SELECT * FROM lead WHERE id=${id} AND organization_id=${actor.organizationId}
    AND (${actor.role==='SUPER_ADMIN'} OR (${actor.role==='MANAGER'} AND branch_id=${actor.branchId}) OR (${actor.role==='AGENT'} AND assigned_agent_id=${actor.id})) FOR SHARE`)[0];
  if(!lead)throw new HttpError(404,'LEAD_NOT_FOUND');return lead;
}
async function audit(tx:postgres.TransactionSql,row:postgres.Row,actor:Principal,action:string,detail:postgres.JSONValue={}) {
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (${row.organization_id},${row.branch_id},${actor.id},${action},'BANK_TRANSFER',${row.id},${tx.json(detail)})`;
}
function callback(id:string) {
  const origin=process.env.APP_ORIGIN;if(!origin)throw new HttpError(503,'BANK_CALLBACK_ORIGIN_REQUIRED');
  const url=new URL(origin);
  if(url.username || url.password || url.search || url.hash || url.pathname!=='/' || !['https:','http:'].includes(url.protocol)
    || (url.protocol==='http:' && (process.env.NODE_ENV==='production' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new HttpError(503,'BANK_CALLBACK_ORIGIN_INVALID');
  return url.origin+'/api/webhooks/bank-settlements/'+id;
}
async function transferRows(tx:postgres.TransactionSql,leadId:string,query:Page={},onlyId:string|null=null) {
  const cursor=decodeCursor(query.cursor);const limit=query.limit ?? 20;
  const rows=await tx`SELECT r.id,r.reference,r.method_name,r.amount,r.currency,r.mode,r.beneficiary,r.account_identifier,r.bank_name,r.instructions,
    r.created_at,r.created_at::text AS cursor_time,p.id AS payment_id,p.state AS payment_state,p.confirmed_at,e.id AS enrollment_id,e.enrolled_at,
    f.source AS confirmation_source,f.transaction_id,f.reason,f.actor_id,f.settled_at
    FROM bank_transfer_request r LEFT JOIN payment_record p ON p.bank_request_id=r.id LEFT JOIN enrollment e ON e.payment_id=p.id
    LEFT JOIN bank_transfer_confirmation f ON f.id=p.bank_confirmation_id
    WHERE r.lead_id=${leadId} AND (${onlyId}::uuid IS NULL OR r.id=${onlyId}::uuid)
      AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (r.created_at,r.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
    ORDER BY r.created_at DESC,r.id DESC LIMIT ${limit+1}`;
  const items=rows.slice(0,limit);const last=items.at(-1);
  return { items:items.map(({ cursor_time,...row })=>row),nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.cursor_time,id:last.id }) : null };
}
export function registerBankTransferRoutes(app:FastifyInstance,db:Database) {
  app.get<{ Querystring:Page }>('/api/payments/bank-accounts',{ schema:{ querystring:page } },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 20;
    const rows=await db`SELECT a.*,c.name,a.created_at::text AS cursor_time FROM bank_transfer_account a JOIN integration_connection c ON c.id=a.id
      WHERE a.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR a.branch_id=${actor.branchId})
      AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (a.created_at,a.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY a.created_at DESC,a.id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);return { items:items.map(({ cursor_time,...r })=>r),nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.cursor_time,id:last.id }) : null };
  });
  app.post<{ Body:AccountInput }>('/api/payments/bank-accounts',{ schema:{ body:{ type:'object',additionalProperties:false,
    required:['name','branchId','mode','beneficiary','accountIdentifier','bankName','instructions','currencies','active','reason'],properties:{
      name:text(1,100),branchId:uuid,mode:{ enum:['TEST','LIVE'] },beneficiary:text(1,160),accountIdentifier:text(3,200),bankName:text(1,160),
      instructions:{ type:'string',maxLength:1000,pattern:'^[^\\x00-\\x1f\\x7f]*$' },currencies:{ type:'array',minItems:1,maxItems:32,uniqueItems:true,items:{ type:'string',enum:Intl.supportedValuesOf('currency') } },active:{ type:'boolean' },reason:text(3,500) } } } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const p=request.body;
    const name=bankText(p.name,1,100),beneficiary=bankText(p.beneficiary,1,160),identifier=bankText(p.accountIdentifier,3,200),bankName=bankText(p.bankName,1,160),reason=bankText(p.reason,3,500);
    const result=await db.begin(async(tx)=> {
      const branch=(await tx`SELECT * FROM branch WHERE id=${p.branchId} AND organization_id=${actor.organizationId}
        AND (${actor.role==='SUPER_ADMIN'} OR id=${actor.branchId}) FOR SHARE`)[0];if(!branch)throw new HttpError(404,'BRANCH_NOT_FOUND');
      const sessionId=await session(tx,actor,request);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'bank-account:'+actor.organizationId+':'+p.mode+':'+identifier},0))`;
      if((await tx`SELECT 1 FROM bank_transfer_account WHERE organization_id=${actor.organizationId} AND mode=${p.mode} AND account_identifier=${identifier}`).length)throw new HttpError(409,'BANK_ACCOUNT_ALREADY_EXISTS');
      if(!branch.active && p.active)throw new HttpError(409,'BRANCH_DISABLED');
      const config={ mode:p.mode,currencies:p.currencies };
      const c=(await tx`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config,capabilities,created_by)
        VALUES (${actor.organizationId},${branch.id},'PAYMENT','BANK_TRANSFER',${name},${p.active ? 'CONNECTED' : 'DISABLED'},${tx.json(config)},${tx.json({ bankAccountConfigured:true })},${actor.id}) RETURNING id`)[0]!;
      await tx`INSERT INTO bank_transfer_account(id,organization_id,branch_id,mode,beneficiary,account_identifier,bank_name,instructions,currencies,active,actor_id,session_id,reason)
        VALUES (${c.id},${actor.organizationId},${branch.id},${p.mode},${beneficiary},${identifier},${bankName},${p.instructions.trim()},${tx.json([...p.currencies].sort())},${p.active},${actor.id},${sessionId},${reason})`;
      return { id:c.id,version:1 };
    });reply.code(201);return result;
  });
  app.put<{ Params:{ id:string };Body:{ name:string;instructions:string;active:boolean;version:number;reason:string } }>('/api/payments/bank-accounts/:id',{
    schema:{ params:idParams,body:{ type:'object',additionalProperties:false,required:['name','instructions','active','version','reason'],properties:{ name:text(1,100),instructions:{ type:'string',maxLength:1000,pattern:'^[^\\x00-\\x1f\\x7f]*$' },active:{ type:'boolean' },version:{ type:'integer',minimum:1 },reason:text(3,500) } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const a=await managedAccount(tx,actor,request.params.id,true);const sessionId=await session(tx,actor,request);const p=request.body;
      if(a.version!==p.version)throw new HttpError(409,'BANK_ACCOUNT_VERSION_CONFLICT');
      await tx`UPDATE integration_connection SET name=${bankText(p.name,1,100)},status=${p.active ? 'CONNECTED' : 'DISABLED'},version=version+1,updated_at=clock_timestamp() WHERE id=${a.id}`;
      await tx`UPDATE bank_transfer_account SET instructions=${p.instructions.trim()},active=${p.active},version=version+1,actor_id=${actor.id},session_id=${sessionId},reason=${bankText(p.reason,3,500)},updated_at=clock_timestamp() WHERE id=${a.id}`;
      return { id:a.id,version:a.version+1 };
    });
  });
  app.get<{ Params:{ id:string };Querystring:{ before?:number;limit?:number } }>('/api/payments/bank-accounts/:id/history',{
    schema:{ params:idParams,querystring:{ type:'object',additionalProperties:false,properties:{ before:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await managedAccount(tx,actor,request.params.id);await session(tx,actor,request);const limit=request.query.limit ?? 20;
      const rows=await tx`SELECT * FROM bank_transfer_account_history WHERE account_id=${request.params.id} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;
      return { items:rows.slice(0,limit),nextVersion:rows.length>limit ? rows[limit-1]!.version : null };
    });
  });
  app.get<{ Params:{ id:string };Querystring:Page }>('/api/leads/:id/bank-transfers',{ schema:{ params:idParams,querystring:page } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> { await visibleLead(tx,actor,request.params.id);await session(tx,actor,request);return transferRows(tx,request.params.id,request.query); });
  });
  app.post<{ Params:{ id:string };Body:{ requestId:string;methodId:string;methodVersion:number;amount:string;currency:string } }>('/api/leads/:id/bank-transfers',{
    schema:{ params:idParams,body:{ type:'object',additionalProperties:false,required:['requestId','methodId','methodVersion','amount','currency'],properties:{ requestId:uuid,methodId:uuid,methodVersion:{ type:'integer',minimum:1 },amount:text(1,32),currency:{ type:'string',enum:Intl.supportedValuesOf('currency') } } } },
  },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);const p=request.body;const money=bankMoney(p.amount,p.currency);
    const result=await db.begin(async(tx)=> {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'bank-request:'+request.params.id+':'+p.requestId.toLowerCase()},0))`;
      const original=(await tx`SELECT * FROM bank_transfer_request WHERE lead_id=${request.params.id} AND request_id=${p.requestId}`)[0];
      if(original) {
        await visibleLead(tx,actor,request.params.id);await session(tx,actor,request);
        if(original.requester_id!==actor.id || original.method_id!==p.methodId.toLowerCase() || original.method_version!==p.methodVersion || original.amount!==money.amount || original.currency!==money.currency)throw new HttpError(409,'BANK_REQUEST_CONFLICT');
        return { duplicate:true,...(await transferRows(tx,request.params.id,{},original.id)).items[0] };
      }
      const a=(await tx`SELECT a.* FROM bank_transfer_account a JOIN payment_method m ON m.connection_id=a.id JOIN integration_connection c ON c.id=a.id
        WHERE m.id=${p.methodId} AND m.organization_id=${actor.organizationId} AND a.active AND c.status='CONNECTED'
        AND (${actor.role==='SUPER_ADMIN'} OR a.branch_id=${actor.branchId}) FOR SHARE OF a,c`)[0];
      if(!a)throw new HttpError(404,'BANK_METHOD_NOT_FOUND');
      const method=(await tx`SELECT * FROM payment_method WHERE id=${p.methodId} FOR SHARE`)[0]!;
      const lead=await visibleLead(tx,actor,request.params.id);const sessionId=await session(tx,actor,request);
      const branch=(await tx`SELECT active FROM branch WHERE id=${lead.branch_id} FOR SHARE`)[0]!;
      if(a.branch_id!==lead.branch_id || !method.active || !branch.active || lead.lifecycle!=='OPEN' || method.version!==p.methodVersion
        || !a.currencies.includes(p.currency) || !method.currencies.includes(p.currency)
        || (method.campaign_mode==='SELECTED' && !method.campaign_ids.includes(lead.campaign_id))
        || (actor.role==='AGENT' && method.agent_mode==='SELECTED' && !method.agent_ids.includes(actor.id)))throw new HttpError(409,'BANK_METHOD_NOT_AVAILABLE');
      const id=randomUUID();const reference='BT-'+id.replaceAll('-','').toUpperCase();
      await tx`INSERT INTO bank_transfer_request(id,organization_id,branch_id,lead_id,method_id,method_version,method_name,account_id,account_version,
        beneficiary,account_identifier,bank_name,instructions,mode,request_id,requester_id,session_id,reference,amount,minor,currency,scale)
        VALUES (${id},${lead.organization_id},${lead.branch_id},${lead.id},${method.id},${method.version},${method.name},${a.id},${a.version},${a.beneficiary},${a.account_identifier},${a.bank_name},${a.instructions},${a.mode},
          ${p.requestId},${actor.id},${sessionId},${reference},${money.amount},${money.minor},${money.currency},${money.scale})`;
      await tx`INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES (${lead.id},${actor.id},'BANK_TRANSFER_REQUESTED',${tx.json({ requestId:id,reference,amount:money.amount,currency:money.currency })})`;
      await audit(tx,{ id,organization_id:lead.organization_id,branch_id:lead.branch_id },actor,'BANK_TRANSFER_REQUESTED',{ reference });
      return { duplicate:false,...(await transferRows(tx,lead.id,{},id)).items[0] };
    });reply.code(result.duplicate ? 200 : 201);return result;
  });
  app.post<{ Params:{ id:string;transferId:string };Body:Approval }>('/api/leads/:id/bank-transfers/:transferId/confirm',{
    schema:{ params:transferParams,body:{ type:'object',additionalProperties:false,required:['transactionId','accountIdentifier','reference','amount','currency','settledAt','reason','bankVerified'],properties:{
      transactionId:text(1,200),accountIdentifier:text(3,200),reference:text(3,100),amount:text(1,32),currency:{ type:'string',enum:Intl.supportedValuesOf('currency') },
      settledAt:{ type:'string',format:'date-time' },reason:text(3,500),bankVerified:{ const:true } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const p=request.body;const money=bankMoney(p.amount,p.currency);
    if(Date.parse(p.settledAt)>Date.now()+60_000)throw new HttpError(400,'BANK_SETTLEMENT_TIME_INVALID');
    return db.begin(async(tx)=> {
      const r0=(await tx`SELECT * FROM bank_transfer_request WHERE id=${request.params.transferId} AND lead_id=${request.params.id}`)[0];if(!r0)throw new HttpError(404,'BANK_REQUEST_NOT_FOUND');
      const a=await managedAccount(tx,actor,r0.account_id);await visibleLead(tx,actor,request.params.id);const sessionId=await session(tx,actor,request);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'bank-confirmation:'+r0.id},0))`;
      if(!a.active || a.connection_status!=='CONNECTED')throw new HttpError(409,'BANK_ACCOUNT_DISABLED');
      const branch=(await tx`SELECT active FROM branch WHERE id=${r0.branch_id} FOR SHARE`)[0];
      if(!branch?.active)throw new HttpError(409,'BRANCH_DISABLED');
      if(r0.amount!==money.amount || r0.currency!==money.currency || r0.account_identifier!==bankText(p.accountIdentifier,3,200) || r0.reference!==bankText(p.reference))throw new HttpError(409,'BANK_CONFIRMATION_MISMATCH');
      const transactionId=bankText(p.transactionId);await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'bank-transaction:'+a.id+':'+transactionId},0))`;
      const old=(await tx`SELECT * FROM bank_transfer_confirmation WHERE account_id=${a.id} AND mode=${r0.mode} AND transaction_id=${transactionId}`)[0];
      if(old && old.request_id!==r0.id)throw new HttpError(409,'BANK_TRANSACTION_ALREADY_USED');
      const confirmed=(await tx`SELECT * FROM bank_transfer_confirmation WHERE request_id=${r0.id}`)[0];
      if(confirmed && (!old || old.id!==confirmed.id))throw new HttpError(409,'BANK_REQUEST_ALREADY_CONFIRMED');
      if(!old) {
        const f=(await tx`INSERT INTO bank_transfer_confirmation(request_id,source,transaction_id,account_id,mode,account_identifier,reference,amount,minor,currency,settled_at,actor_id,session_id,reason,bank_verified)
          VALUES (${r0.id},'AUTHORIZED_MANUAL',${transactionId},${a.id},${r0.mode},${r0.account_identifier},${r0.reference},${money.amount},${money.minor},${money.currency},${p.settledAt},${actor.id},${sessionId},${bankText(p.reason,3,500)},true) RETURNING id`)[0]!;
        await persistBankPaymentState(tx,r0,f.id);
      }
      return { duplicate:!!old,...(await transferRows(tx,request.params.id,{},r0.id)).items[0] };
    });
  });
  app.get<{ Params:{ id:string };Querystring:Page }>('/api/payments/bank-accounts/:id/sources',{ schema:{ params:idParams,querystring:page } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await managedAccount(tx,actor,request.params.id);await session(tx,actor,request);const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 20;
      const rows=await tx`SELECT id,description,approved_by,active,created_at,created_at::text AS cursor_time,disabled_at FROM bank_settlement_source WHERE account_id=${request.params.id}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;
      const items=rows.slice(0,limit);const last=items.at(-1);return { items:items.map(({ cursor_time,...r })=>({ ...r,callbackUrl:callback(r.id),verification:'Live Verification Pending External Credential/Approval' })),nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.cursor_time,id:last.id }) : null };
    });
  });
  app.post<{ Params:{ id:string };Body:{ description:string;secret:string;trustedSourceApproved:true } }>('/api/payments/bank-accounts/:id/sources',{
    schema:{ params:idParams,body:{ type:'object',additionalProperties:false,required:['description','secret','trustedSourceApproved'],properties:{ description:text(3,500),secret:{ type:'string',minLength:32,maxLength:256,pattern:'^[A-Za-z0-9_-]+$' },trustedSourceApproved:{ const:true } } } },
  },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);const result=await db.begin(async(tx)=> {
      const a=await managedAccount(tx,actor,request.params.id,true);const sessionId=await session(tx,actor,request);if(!a.active)throw new HttpError(409,'BANK_ACCOUNT_DISABLED');
      await tx`UPDATE bank_settlement_source SET active=false,disabled_at=clock_timestamp() WHERE account_id=${a.id} AND active`;
      const id=randomUUID(),secret=sealOpaque('bank-source:'+id,request.body.secret);
      await tx`INSERT INTO bank_settlement_source(id,account_id,description,approved_by,session_id,ciphertext,nonce,auth_tag,key_version)
        VALUES (${id},${a.id},${bankText(request.body.description,3,500)},${actor.id},${sessionId},${secret.ciphertext},${secret.nonce},${secret.authTag},${secret.keyVersion})`;
      await audit(tx,a,actor,'BANK_SOURCE_APPROVED',{ sourceId:id,description:request.body.description });return { id,callbackUrl:callback(id),verification:'Live Verification Pending External Credential/Approval' };
    });reply.code(201);return result;
  });
  app.post<{ Params:{ id:string };Body:{ reason:string } }>('/api/payments/bank-accounts/:id/disable-source',{
    schema:{ params:idParams,body:{ type:'object',additionalProperties:false,required:['reason'],properties:{ reason:text(3,500) } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const a=await managedAccount(tx,actor,request.params.id,true);await session(tx,actor,request);
      await tx`UPDATE bank_settlement_source SET active=false,disabled_at=clock_timestamp() WHERE account_id=${a.id} AND active`;
      await audit(tx,a,actor,'BANK_SOURCE_DISABLED',{ reason:bankText(request.body.reason,3,500) });return { disabled:true };
    });
  });
  app.get<{ Params:{ id:string };Querystring:Page }>('/api/payments/bank-accounts/:id/events',{ schema:{ params:idParams,querystring:page } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await managedAccount(tx,actor,request.params.id);await session(tx,actor,request);const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 20;
      const rows=await tx`SELECT e.id,e.event_id,e.transaction_id,e.reference,e.amount,e.currency,e.settled_at,e.received_at,e.received_at::text AS cursor_time,j.state,j.attempts,j.error_code,j.version
        FROM bank_settlement_event e JOIN bank_settlement_job j ON j.event_id=e.id WHERE e.account_id=${request.params.id}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (e.received_at,e.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY e.received_at DESC,e.id DESC LIMIT ${limit+1}`;
      const items=rows.slice(0,limit),last=items.at(-1);return { items:items.map(({ cursor_time,...r })=>r),nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.cursor_time,id:last.id }) : null };
    });
  });
  app.get<{ Params:{ id:string;transferId:string } }>('/api/payments/bank-accounts/:id/events/:transferId/attempts',{ schema:{ params:transferParams } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await managedAccount(tx,actor,request.params.id);await session(tx,actor,request);
      return { items:await tx`SELECT a.number,a.outcome,a.error_code,a.finished_at FROM bank_settlement_attempt a JOIN bank_settlement_event e ON e.id=a.event_id WHERE e.account_id=${request.params.id} AND e.id=${request.params.transferId} ORDER BY number` };
    });
  });
  app.post<{ Params:{ id:string;transferId:string };Body:{ version:number;reason:string } }>('/api/payments/bank-accounts/:id/events/:transferId/retry',{
    schema:{ params:transferParams,body:{ type:'object',additionalProperties:false,required:['version','reason'],properties:{ version:{ type:'integer',minimum:1 },reason:text(3,500) } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const a=await managedAccount(tx,actor,request.params.id);await session(tx,actor,request);
      const j=(await tx`SELECT j.* FROM bank_settlement_job j JOIN bank_settlement_event e ON e.id=j.event_id WHERE e.id=${request.params.transferId} AND e.account_id=${a.id} FOR UPDATE OF j`)[0];
      if(!j)throw new HttpError(404,'BANK_EVENT_NOT_FOUND');if(j.version!==request.body.version || j.state!=='NEEDS_ATTENTION' || j.attempts>=5)throw new HttpError(409,'BANK_RETRY_NOT_ALLOWED');
      await tx`UPDATE bank_settlement_job SET state='RETRY',version=version+1,error_code=NULL,run_after=clock_timestamp() WHERE event_id=${j.event_id}`;
      await audit(tx,a,actor,'BANK_RECONCILIATION_RETRY',{ eventId:j.event_id,reason:bankText(request.body.reason,3,500) });return { queued:true };
    });
  });
  app.register(async(webhook)=> {
    webhook.addContentTypeParser('application/json',{ parseAs:'buffer' },(_request,body,done)=>done(null,body));
    webhook.post<{ Params:{ id:string };Body:Buffer }>('/api/webhooks/bank-settlements/:id',{ bodyLimit:8192,schema:{ params:idParams },config:{ rateLimit:{ max:120,timeWindow:'1 minute' } } },async(request)=>db.begin(async(tx)=> {
      const s=(await tx`SELECT s.*,a.mode,a.account_identifier,a.active AS account_active,c.status,b.active AS branch_active
        FROM bank_settlement_source s JOIN bank_transfer_account a ON a.id=s.account_id JOIN integration_connection c ON c.id=a.id JOIN branch b ON b.id=a.branch_id
        WHERE s.id=${request.params.id} FOR SHARE OF s,a,c,b`)[0];
      if(!s || !s.active || !s.account_active || !s.branch_active || s.status!=='CONNECTED')throw new HttpError(404,'BANK_SOURCE_NOT_AVAILABLE');
      const raw=request.body;if(!Buffer.isBuffer(raw))throw new HttpError(400,'BANK_EVENT_INVALID');
      const key=openOpaque('bank-source:'+s.id,{ ciphertext:s.ciphertext,nonce:s.nonce,authTag:s.auth_tag,keyVersion:s.key_version });
      const parsed=parseBankSettlement(raw,typeof request.headers['x-bank-signature']==='string' ? request.headers['x-bank-signature'] : undefined,key);
      if(parsed.mode!==s.mode || parsed.accountIdentifier!==s.account_identifier)throw new HttpError(400,'BANK_EVENT_ACCOUNT_MISMATCH');
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'bank-event:'+s.account_id+':'+parsed.eventId},0))`;
      const existing=(await tx`SELECT id,semantic_hash FROM bank_settlement_event WHERE account_id=${s.account_id} AND event_id=${parsed.eventId}`)[0];
      if(existing) { if(!Buffer.from(existing.semantic_hash).equals(parsed.hash))throw new HttpError(409,'BANK_EVENT_CONFLICT');return { accepted:true,duplicate:true }; }
      const event=(await tx`INSERT INTO bank_settlement_event(source_id,account_id,event_id,transaction_id,mode,account_identifier,reference,amount,currency,settled_at,semantic_hash)
        VALUES (${s.id},${s.account_id},${parsed.eventId},${parsed.transactionId},${parsed.mode},${parsed.accountIdentifier},${parsed.reference},${parsed.amount},${parsed.currency},${parsed.settledAt},${parsed.hash}) RETURNING id`)[0]!;
      await tx`INSERT INTO bank_settlement_job(event_id) VALUES (${event.id})`;return { accepted:true,duplicate:false };
    }));
  });
}
