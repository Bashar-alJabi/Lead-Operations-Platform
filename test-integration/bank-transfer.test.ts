import test,{ type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac,randomBytes,randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { processOneBankSettlement } from '../src/payments/bank-worker.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
async function fixture(t:TestContext) {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url),app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Bank tests') RETURNING id`)[0]!.id;
  const foreign=(await db`INSERT INTO organization(name) VALUES ('Foreign bank tests') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope,o] of [['manager','MANAGER',branch,org],['other','MANAGER',otherBranch,org],['agent','AGENT',branch,org],['second','AGENT',branch,org],['admin','SUPER_ADMIN',null,org],['foreign','SUPER_ADMIN',null,foreign]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${o},${scope},${name},${role},${name+'@bank.test'},'synthetic-only') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at) VALUES (${id},${sha256(token)},now()-interval '1 hour',now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={ id,session,cookie:'lop_session='+token };
  }
  const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'Bank campaign') RETURNING id`)[0]!.id;
  const lead=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind) VALUES (${org},${branch},${campaign},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id;
  const lead2=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind) VALUES (${org},${branch},${campaign},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id;
  const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor='manager')=>app.inject({ method,url:path,payload,headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie } });
  const accountInput={ name:'Bank account',branchId:branch,mode:'TEST',beneficiary:'Synthetic company',accountIdentifier:'SYNTHETIC-ACCOUNT-A',bankName:'Synthetic bank',instructions:'Use the exact reference <img src=x onerror=alert(1)>',currencies:['EUR','JPY'],active:true,reason:'Verified configuration from independent bank records' };
  const accountResponse=await api('POST','/api/payments/bank-accounts',accountInput);assert.equal(accountResponse.statusCode,201,accountResponse.body);const accountId=accountResponse.json().id;
  const methodInput={ name:'Synthetic transfer',branchId:branch,connectionId:accountId,currencies:['EUR','JPY'],active:true,agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'ALL',ids:[] },reason:'Allow bank method' };
  const method=await api('POST','/api/payments/methods',methodInput);assert.equal(method.statusCode,201,method.body);const methodId=method.json().id;
  const requestInput=()=>({ requestId:randomUUID(),methodId,methodVersion:1,amount:'25.00',currency:'EUR' });
  const request=async(id=lead)=>{ const r=await api('POST',`/api/leads/${id}/bank-transfers`,requestInput(),'agent');assert.equal(r.statusCode,201,r.body);return r.json(); };
  const approval=(r:{ reference:string })=>({ transactionId:'MANUAL-'+randomUUID(),accountIdentifier:accountInput.accountIdentifier,reference:r.reference,amount:'25.00',currency:'EUR',settledAt:new Date(Date.now()-60_000).toISOString(),reason:'Reviewed settled transaction directly in bank records',bankVerified:true });
  return { db,app,org,branch,otherBranch,users,lead,lead2,api,accountId,accountInput,methodId,methodInput,requestInput,request,approval };
}
test('Bank Transfer manual approval enforces native scope/session/exact money, dedup/concurrency, audit atomicity and independent Enrollment',async(t)=> {
  const f=await fixture(t);const { db,api,users,accountId,accountInput,lead,lead2 }=f;
  assert.equal((await api('POST','/api/payments/bank-accounts',accountInput,'agent')).statusCode,403);
  assert.equal((await api('POST','/api/payments/bank-accounts',accountInput,'other')).statusCode,404);
  assert.equal((await api('POST','/api/payments/bank-accounts',accountInput)).statusCode,409);
  assert.equal((await api('GET','/api/payments/bank-accounts',undefined,'agent')).statusCode,403);
  assert.equal((await api('GET',`/api/payments/bank-accounts/${accountId}/history`,undefined,'other')).statusCode,404);
  assert.equal((await api('GET','/api/payments/bank-accounts',undefined,'foreign')).json().items.length,0);
  assert.equal((await api('GET',`/api/leads/${lead}/payment-methods`,undefined,'agent')).json().items[0].preparationAvailable,true);
  const input=f.requestInput();const races=await Promise.all(Array.from({ length:4 },()=>api('POST',`/api/leads/${lead}/bank-transfers`,input,'agent')));
  assert.deepEqual(races.map((r)=>r.statusCode).sort(),[200,200,200,201]);const r=races[0]!.json();assert.ok(r.reference.startsWith('BT-'));assert.equal(r.payment_id,null);assert.equal(r.enrollment_id,null);
  assert.equal((await api('POST',`/api/leads/${lead}/bank-transfers`,{ ...input,amount:'26' },'agent')).statusCode,409);
  assert.equal((await api('POST',`/api/leads/${lead}/bank-transfers`,{ ...f.requestInput(),paid:true },'agent')).statusCode,400);
  assert.equal((await api('GET',`/api/leads/${lead}/bank-transfers`,undefined,'second')).statusCode,404);
  const path=`/api/leads/${lead}/bank-transfers/${r.id}/confirm`;const proof=f.approval(r);
  assert.equal((await api('POST',path,proof,'agent')).statusCode,403);assert.equal((await api('POST',path,proof,'other')).statusCode,404);
  assert.equal((await api('POST',path,{ ...proof,bankVerified:false })).statusCode,400);
  assert.equal((await api('POST',path,{ ...proof,uploadedReceipt:'customer-proof' })).statusCode,400);
  for(const change of [{ amount:'24.00' },{ currency:'JPY',amount:'25' },{ accountIdentifier:'OTHER-ACCOUNT' },{ reference:'BT-'+'0'.repeat(32) }])assert.equal((await api('POST',path,{ ...proof,...change })).statusCode,409);
  assert.equal((await api('POST',path,{ ...proof,settledAt:'2030-01-01T00:00:00Z' })).statusCode,400);
  assert.equal(Number((await db`SELECT count(*) FROM payment_record`)[0]!.count),0);assert.equal(Number((await db`SELECT count(*) FROM enrollment`)[0]!.count),0);
  const approvals=await Promise.all(Array.from({ length:4 },()=>api('POST',path,proof)));assert.ok(approvals.every((x)=>x.statusCode===200),approvals.map((x)=>x.body).join('\n'));
  const paid=approvals[0]!.json();assert.equal(paid.payment_state,'CONFIRMED');assert.equal(paid.confirmation_source,'AUTHORIZED_MANUAL');assert.ok(paid.payment_id);assert.ok(paid.enrollment_id);
  assert.equal(Number((await db`SELECT count(*) FROM bank_transfer_confirmation`)[0]!.count),1);assert.equal(Number((await db`SELECT count(*) FROM enrollment`)[0]!.count),1);
  assert.equal((await db`SELECT lifecycle FROM lead WHERE id=${lead}`)[0]!.lifecycle,'OPEN');
  const other=await f.request(lead2);assert.equal((await api('POST',`/api/leads/${lead2}/bank-transfers/${other.id}/confirm`,{ ...proof,reference:other.reference })).statusCode,409);
  await assert.rejects(()=>db`UPDATE bank_transfer_request SET amount='1.00' WHERE id=${r.id}`,/BANK_REQUEST_IMMUTABLE/);
  await assert.rejects(()=>db`UPDATE bank_transfer_confirmation SET reason='rewrite' WHERE request_id=${r.id}`,/BANK_CONFIRMATION_IMMUTABLE/);
  await assert.rejects(()=>db`UPDATE payment_record SET state='PENDING' WHERE bank_request_id=${r.id}`,/BANK_PAYMENT_IMMUTABLE/);
  await assert.rejects(()=>db`UPDATE payment_record SET bank_request_id=NULL WHERE bank_request_id=${r.id}`,/PAYMENT_SOURCE_IMMUTABLE/);
  await assert.rejects(()=>db`INSERT INTO enrollment(lead_id,payment_id) VALUES (${lead2},${paid.payment_id})`,/ENROLLMENT_TRUSTED_PAYMENT_REQUIRED/);
  await assert.rejects(()=>db`UPDATE bank_transfer_account SET beneficiary='different',version=version+1 WHERE id=${accountId}`,/BANK_ACCOUNT_IDENTITY_IMMUTABLE/);
  await assert.rejects(()=>db`DELETE FROM bank_transfer_account_history WHERE account_id=${accountId}`,/BANK_HISTORY_IMMUTABLE/);
  await assert.rejects(()=>db`INSERT INTO bank_transfer_account_history(account_id,version,snapshot) VALUES (${accountId},99,'{}'::jsonb)`,/BANK_ACCOUNT_HISTORY_SNAPSHOT_INVALID/);
  const p2=f.approval(other);
  await db`CREATE FUNCTION synthetic_bank_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='BANK_TRANSFER_CONFIRMED' THEN RAISE EXCEPTION 'synthetic bank audit failure'; END IF; RETURN NEW; END $$`;
  await db`CREATE TRIGGER synthetic_bank_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_bank_audit_failure()`;
  try { assert.equal((await api('POST',`/api/leads/${lead2}/bank-transfers/${other.id}/confirm`,p2)).statusCode,500);
    assert.equal(Number((await db`SELECT count(*) FROM bank_transfer_confirmation WHERE request_id=${other.id}`)[0]!.count),0); }
  finally { await db`DROP TRIGGER synthetic_bank_audit ON audit_log`;await db`DROP FUNCTION synthetic_bank_audit_failure()`; }
  await db`UPDATE user_session SET expires_at=now()-interval '1 second' WHERE id=${users.manager!.session}`;
  assert.equal((await api('POST',`/api/leads/${lead2}/bank-transfers/${other.id}/confirm`,p2)).statusCode,401);
  await assert.rejects(()=>db`INSERT INTO bank_transfer_confirmation(request_id,source,transaction_id,account_id,mode,account_identifier,reference,amount,minor,currency,settled_at,actor_id,session_id,reason,bank_verified)
    VALUES (${other.id},'AUTHORIZED_MANUAL',${p2.transactionId},${accountId},'TEST',${accountInput.accountIdentifier},${other.reference},'25.00','2500','EUR',now(),${users.manager!.id},${users.manager!.session},'native expired session',true)`,/BANK_MANUAL_APPROVAL_DENIED/);
  await db`UPDATE user_session SET expires_at=now()+interval '1 hour' WHERE id=${users.manager!.session}`;
  await assert.rejects(()=>db`INSERT INTO bank_transfer_confirmation(request_id,source,transaction_id,account_id,mode,account_identifier,reference,amount,minor,currency,settled_at,actor_id,session_id,reason,bank_verified)
    VALUES (${other.id},'AUTHORIZED_MANUAL',${p2.transactionId},${accountId},'TEST',${accountInput.accountIdentifier},${other.reference},'25.00','2500','EUR',now(),${users.manager!.id},${users.manager!.session},NULL,true)`,/bank_manual_evidence_required/);
  const update={ name:'Disabled bank account',instructions:'Disabled instructions',active:false,version:1,reason:'Bank account disabled for review' };
  assert.equal((await api('PUT',`/api/payments/bank-accounts/${accountId}`,update)).statusCode,200);
  assert.equal((await api('PUT',`/api/payments/bank-accounts/${accountId}`,update)).statusCode,409);
  assert.equal((await api('POST',`/api/leads/${lead2}/bank-transfers/${other.id}/confirm`,p2)).statusCode,409);
  assert.equal((await api('POST',`/api/leads/${lead}/bank-transfers`,f.requestInput(),'agent')).statusCode,404);
  const saved=(await api('GET',`/api/leads/${lead}/bank-transfers`,undefined,'agent')).json().items[0];assert.equal(saved.enrollment_id,paid.enrollment_id);assert.equal(saved.instructions,accountInput.instructions);
  const history=(await api('GET',`/api/payments/bank-accounts/${accountId}/history?limit=1`)).json();assert.equal(history.items[0].version,2);assert.equal(history.nextVersion,2);
  assert.equal((await api('GET',`/api/payments/bank-accounts/${accountId}/history?before=2`)).json().items[0].snapshot.beneficiary,accountInput.beneficiary);
  await db`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`;
  assert.equal((await api('GET',`/api/leads/${lead}/bank-transfers`,undefined,'agent')).statusCode,404);
  assert.equal((await api('GET',`/api/leads/${lead}/bank-transfers`,undefined,'second')).json().items[0].confirmation_source,'AUTHORIZED_MANUAL');
});
test('Bank signed feed uses durable independent reconciliation, exact original evidence, retries/leases, source rotation and no duplicate Payment/Enrollment',async(t)=> {
  const f=await fixture(t);const { db,app,api,accountId,accountInput,lead }=f;const r=await f.request();
  const secret='SyntheticBankFeedOnly'.repeat(3);const sourcePath=`/api/payments/bank-accounts/${accountId}/sources`;
  const sourceInput={ description:'Synthetic independent bank settlement connector',secret,trustedSourceApproved:true };
  assert.equal((await api('POST',sourcePath,sourceInput,'agent')).statusCode,403);assert.equal((await api('POST',sourcePath,sourceInput,'other')).statusCode,404);
  assert.equal((await api('POST',sourcePath,{ ...sourceInput,trustedSourceApproved:false })).statusCode,400);
  const source=(await api('POST',sourcePath,sourceInput)).json();assert.ok(source.id);assert.match(source.verification,/Pending/);
  const sourceList=(await api('GET',sourcePath)).json();assert.equal(JSON.stringify(sourceList).includes(secret),false);assert.equal(JSON.stringify(sourceList).includes('ciphertext'),false);
  const e={ eventId:'evt-'+randomUUID(),transactionId:'AUTO-'+randomUUID(),mode:'TEST',accountIdentifier:accountInput.accountIdentifier,reference:r.reference,amount:r.amount,currency:r.currency,settledAt:new Date(Date.now()-60_000).toISOString(),status:'SETTLED' };
  const send=async(body:object=e,id=source.id,signed=true)=>{ const raw=JSON.stringify(body),stamp=Math.floor(Date.now()/1000).toString();return app.inject({ method:'POST',url:'/api/webhooks/bank-settlements/'+id,payload:raw,headers:{ 'content-type':'application/json','x-bank-signature':`t=${stamp},v1=${signed ? createHmac('sha256',secret).update(stamp+'.'+raw).digest('hex') : '0'.repeat(64)}` } }); };
  assert.equal((await send(e,source.id,false)).statusCode,400);assert.equal((await send({ ...e,status:'PENDING' })).statusCode,400);
  assert.equal((await send({ ...e,customerPaid:true })).statusCode,400);assert.equal((await send({ ...e,accountIdentifier:'CUSTOMER-ACCOUNT' })).statusCode,400);
  const receipts=await Promise.all(Array.from({ length:4 },()=>send()));assert.ok(receipts.every((x)=>x.statusCode===200),receipts.map((x)=>x.body).join('\n'));
  assert.equal(Number((await db`SELECT count(*) FROM bank_settlement_event`)[0]!.count),1);assert.equal(Number((await db`SELECT count(*) FROM payment_record`)[0]!.count),0);
  assert.equal((await send({ ...e,amount:'26.00' })).statusCode,409);
  const processed=await Promise.all(Array.from({ length:8 },()=>processOneBankSettlement(db)));assert.equal(processed.filter(Boolean).length,1);
  const paid=(await api('GET',`/api/leads/${lead}/bank-transfers`,undefined,'agent')).json().items[0];assert.equal(paid.payment_state,'CONFIRMED');assert.equal(paid.confirmation_source,'TRUSTED_FEED');assert.ok(paid.enrollment_id);
  const sameTx={ ...e,eventId:'evt-'+randomUUID() };assert.equal((await send(sameTx)).statusCode,200);await processOneBankSettlement(db);
  assert.equal(Number((await db`SELECT count(*) FROM enrollment`)[0]!.count),1);assert.equal(Number((await db`SELECT count(*) FROM bank_transfer_confirmation`)[0]!.count),1);
  const unmatched={ ...e,eventId:'evt-'+randomUUID(),transactionId:'unmatched-'+randomUUID(),reference:'BT-'+'F'.repeat(32) };await send(unmatched);await processOneBankSettlement(db);
  const bad=(await db`SELECT e.id,j.version,j.error_code FROM bank_settlement_event e JOIN bank_settlement_job j ON j.event_id=e.id WHERE e.event_id=${unmatched.eventId}`)[0]!;assert.equal(bad.error_code,'BANK_REQUEST_NOT_FOUND');
  assert.equal((await api('POST',`/api/payments/bank-accounts/${accountId}/events/${bad.id}/retry`,{ version:bad.version,reason:'Reviewed unmatched reference' })).statusCode,200);
  assert.equal((await api('POST',`/api/payments/bank-accounts/${accountId}/events/${bad.id}/retry`,{ version:bad.version,reason:'Stale retry' })).statusCode,409);await processOneBankSettlement(db);
  const attempts=(await api('GET',`/api/payments/bank-accounts/${accountId}/events/${bad.id}/attempts`)).json();assert.equal(attempts.items.length,2);
  await assert.rejects(()=>db`UPDATE bank_settlement_event SET amount='1' WHERE id=${bad.id}`,/BANK_HISTORY_IMMUTABLE/);
  await assert.rejects(()=>db`UPDATE bank_settlement_attempt SET outcome='PROCESSED' WHERE event_id=${bad.id}`,/BANK_HISTORY_IMMUTABLE/);
  const r2=await f.request();const e2={ ...e,eventId:'evt-'+randomUUID(),transactionId:'AUTO-'+randomUUID(),reference:r2.reference };await send(e2);
  await db`CREATE FUNCTION synthetic_bank_feed_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='BANK_TRANSFER_CONFIRMED' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$`;
  await db`CREATE TRIGGER synthetic_bank_feed_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_bank_feed_audit_failure()`;
  try { await processOneBankSettlement(db);assert.equal(Number((await db`SELECT count(*) FROM bank_transfer_confirmation WHERE request_id=${r2.id}`)[0]!.count),0);
    assert.equal((await db`SELECT j.state FROM bank_settlement_job j JOIN bank_settlement_event e ON e.id=j.event_id WHERE e.event_id=${e2.eventId}`)[0]!.state,'RETRY'); }
  finally { await db`DROP TRIGGER synthetic_bank_feed_audit ON audit_log`;await db`DROP FUNCTION synthetic_bank_feed_audit_failure()`; }
  // Explicit expired claim fixture, preserving the actual native transition and attempt count.
  const r3=await f.request();const e3={ ...e,eventId:'evt-'+randomUUID(),transactionId:'AUTO-'+randomUUID(),reference:r3.reference };await send(e3);
  const job=(await db`SELECT id FROM bank_settlement_event WHERE event_id=${e3.eventId}`)[0]!;
  await db`UPDATE bank_settlement_job SET state='RUNNING',attempts=1,lease_token=${randomUUID()},lease_until=clock_timestamp()-interval '1 second',version=version+1 WHERE event_id=${job.id}`;
  await processOneBankSettlement(db);assert.equal((await db`SELECT state FROM bank_settlement_job WHERE event_id=${job.id}`)[0]!.state,'PROCESSED');
  assert.deepEqual((await db`SELECT outcome FROM bank_settlement_attempt WHERE event_id=${job.id} ORDER BY number`).map((x)=>x.outcome),['INTERRUPTED','PROCESSED']);
  const rotated=await api('POST',sourcePath,{ ...sourceInput,description:'Approved rotated connector' });assert.equal(rotated.statusCode,201);
  assert.equal((await send({ ...e,eventId:'late-old-source' })).statusCode,404);assert.equal((await api('GET',sourcePath)).json().items.length,2);
  assert.equal((await api('GET',`/api/payments/bank-accounts/${accountId}/events?limit=1`)).json().items.length,1);assert.ok((await api('GET',`/api/payments/bank-accounts/${accountId}/events?limit=1`)).json().nextCursor);
  assert.equal((await api('GET',`/api/payments/bank-accounts/${accountId}/events`,undefined,'agent')).statusCode,403);
  assert.equal((await api('GET',`/api/payments/bank-accounts/${accountId}/events`,undefined,'other')).statusCode,404);
});
