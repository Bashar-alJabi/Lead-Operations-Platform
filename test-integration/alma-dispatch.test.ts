import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealOpaque } from '../src/credentials.js';
import { sha256 } from '../src/security.js';
import { almaCheckoutAdapter } from '../src/payments/alma-checkout.js';
import { paymentCheckoutAdapters } from '../src/payments/checkout-provider.js';
import { checkoutInput,historicalPaymentCredentials,processOnePaymentDispatch } from '../src/payments/dispatch-worker.js';
import { paymentIssuanceOptions } from '../src/payments/issuance-profile.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Alma durable one-write dispatch commits native current authorization and audit after preflight, fences concurrency, lost replies, interrupted workers and historical identity without financial authority',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Alma dispatch') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'Alma dispatch branch') RETURNING id`)[0]!.id;
  const other=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'Other branch') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;session:string;cookie:string }>={};
  for(const [name,role,scope] of [['manager','MANAGER',branch],['agent','AGENT',branch],['other','MANAGER',other]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash)
      VALUES (${org},${scope},${name},${role},${name+'@alma-dispatch.test'},'no login password') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at)
      VALUES (${id},${sha256(token)},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name]={ id,session,cookie:'lop_session='+token };
  }
  const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'Alma campaign') RETURNING id`)[0]!.id;
  const lead=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind)
    VALUES (${org},${branch},${campaign},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id;
  const merchant='merchant_DurableSynthetic123';const credentials={ apiKey:'AlmaDurableSyntheticKeyOnly_123456789' };
  let ip=1;const api=(method:'GET'|'POST',path:string,payload?:object)=>app.inject({ method,url:path,payload,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users.manager!.cookie },remoteAddress:`127.0.41.${ip++}` });
  const calls:string[]=[];let eligible=true;let lost=false;let captured=false;let afterPreflight:(()=>Promise<void>)|null=null;
  let afterWrite:(()=>Promise<void>)|null=null;
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> {
    calls.push(target);assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('authorization'),'Alma-Auth '+credentials.apiKey);
    if(target.endsWith('/extended-data'))return new Response(JSON.stringify({ id:merchant }));
    if(target.endsWith('/eligibility')) {
      const request=JSON.parse(init.body as string);assert.equal(request.purchase_amount,10000);
      if(afterPreflight)await afterPreflight();return new Response(JSON.stringify([{ ...request.queries[0],eligible }]));
    }
    let intent:string;let paymentId:string;
    if(init.method==='POST') {
      assert.equal(target,'https://api.sandbox.getalma.eu/v1/payments');assert.equal(new Headers(init.headers).has('idempotency-key'),false);
      const payload=JSON.parse(init.body as string).payment;intent=payload.custom_data.intentId;paymentId='payment_'+intent.replaceAll('-','');
      assert.equal(payload.purchase_amount,10000);assert.equal(payload.installments_count,3);assert.equal(payload.capture_method,'automatic');
      const proof=(await db`SELECT a.intent_id,l.action FROM payment_write_admission a JOIN audit_log l ON l.target_id=a.intent_id::text
        WHERE a.intent_id=${intent} AND l.action='PAYMENT_WRITE_ADMITTED'`)[0];assert.ok(proof,'marker and audit must commit before actual POST');
      if(afterWrite)await afterWrite();if(lost)throw new Error('lost response '+credentials.apiKey);
    }else {
      paymentId=target.slice(target.lastIndexOf('/')+1);intent=(await db`SELECT intent_id FROM payment_checkout_ack WHERE session_id=${paymentId}`)[0]!.intent_id;
    }
    return new Response(JSON.stringify({ id:paymentId,merchant_id:merchant,purchase_amount:10000,installments_count:3,deferred_months:0,deferred_days:0,
      processing_status:captured ? 'captured' : 'awaiting_authorization',state:'paid',is_deferred_capture:false,capture_method:'automatic',
      amount_already_refunded:0,is_completely_refunded:false,custom_data:{ intentId:intent },url:'https://pay.sandbox.getalma.eu/'+paymentId }));
  });
  const made=await api('POST','/api/payments/connections',{ name:'Alma durable',provider:'ALMA',config:{ mode:'TEST' },credentials });assert.equal(made.statusCode,201,made.body);
  const connection=made.json().id;const root='/api/payments/connections/'+connection;
  assert.equal((await api('POST',root+'/test',{ version:1 })).statusCode,200);
  const endpoint=(await api('POST',root+'/notification-endpoints',{ connectionVersion:1,reason:'Prepare durable original notification context' })).json();
  assert.ok(endpoint.id);const methodResponse=await api('POST','/api/payments/methods',{ name:'Alma durable method',branchId:branch,connectionId:connection,currencies:['EUR'],active:true,
    agents:{ mode:'SELECTED',ids:[users.agent!.id] },campaigns:{ mode:'SELECTED',ids:[campaign] },reason:'Explicit Alma availability' });
  assert.equal(methodResponse.statusCode,201,methodResponse.body);const method=methodResponse.json().id;
  const c=(await db`SELECT * FROM integration_connection WHERE id=${connection}`)[0]!;
  const options=paymentIssuanceOptions('ALMA',c.config,c.capabilities,c.version);
  async function create(patch:Record<string,unknown>={}) {
    const id=randomUUID();const sealed=sealOpaque('payment-link:'+id,JSON.stringify(credentials));
    const row={ id,organization_id:org,branch_id:branch,lead_id:lead,campaign_id:campaign,assigned_agent_id:users.agent!.id,request_id:randomUUID(),
      method_id:method,method_version:1,method_name:'Alma durable method',connection_id:connection,connection_version:1,provider:'ALMA',
      config_snapshot:db.json({ mode:'TEST' }),mode:'TEST',account_ref:merchant,options_snapshot:db.json(options),webhook_id:null,webhook_version:null,
      selected_plan:db.json({ installments:3,deferredMonths:0,deferredDays:0 }),notification_endpoint_id:endpoint.id,notification_endpoint_version:1,notification_url:endpoint.callback_url,
      amount:'100.00',currency:'EUR',minor:'10000',scale:2,quantum:'1',success_url:process.env.APP_ORIGIN+'/?paymentReturn=success',cancel_url:process.env.APP_ORIGIN+'/?paymentReturn=cancel',
      ciphertext:sealed.ciphertext,nonce:sealed.nonce,auth_tag:sealed.authTag,key_version:sealed.keyVersion,
      requester_id:users.agent!.id,requester_session_id:users.agent!.session,requester_role:'AGENT',requester_branch_id:branch,...patch };
    await db`INSERT INTO payment_link_intent ${db(row)}`;return id;
  }
  const dispatch=()=>processOnePaymentDispatch(db,{ ALMA:almaCheckoutAdapter });
  const state=async(id:string)=>(await db`SELECT state,error_code FROM payment_dispatch WHERE intent_id=${id}`)[0]!;
  const writes=()=>calls.filter((path)=>path.endsWith('/v1/payments')).length;
  assert.equal(paymentCheckoutAdapters.ALMA,undefined,'financial registry activation waits for confirmation/Enrollment/Lead UI');
  for(const patch of [{ selected_plan:db.json({ installments:0,deferredMonths:0,deferredDays:0 }) },{ selected_plan:null },{ webhook_version:1 },
    { minor:'10001' },{ currency:'USD' },{ notification_url:'https://foreign.test/callback' },{ notification_endpoint_version:2 },
    { account_ref:'merchant_Foreign' },{ requester_id:users.other!.id,requester_session_id:users.other!.session,requester_role:'MANAGER',requester_branch_id:other }])await assert.rejects(create(patch));
  const accepted=await create();const results=await Promise.all(Array.from({ length:8 },dispatch));assert.ok(results.some(Boolean));assert.equal(writes(),1);
  assert.equal((await state(accepted)).state,'ACCEPTED');assert.equal((await db`SELECT count(*)::int n FROM payment_dispatch_attempt WHERE intent_id=${accepted}`)[0]!.n,1);
  const admitted=(await db`SELECT * FROM payment_write_admission WHERE intent_id=${accepted}`)[0]!;
  await assert.rejects(db`UPDATE payment_write_admission SET admitted_at=clock_timestamp() WHERE intent_id=${accepted}`,/PAYMENT_WRITE_ADMISSION_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM payment_write_admission WHERE intent_id=${accepted}`,/PAYMENT_WRITE_ADMISSION_IMMUTABLE/);
  await assert.rejects(db`INSERT INTO payment_write_admission(intent_id,attempt_id) VALUES (${accepted},${admitted.attempt_id})`,/PAYMENT_WRITE_ADMISSION_CURRENT_FENCE_REQUIRED/);
  await assert.rejects(db`UPDATE payment_link_intent SET provider='STRIPE' WHERE id=${accepted}`,/PAYMENT_LINK_INTENT_IMMUTABLE/);
  const stored=(await db`SELECT * FROM payment_link_intent WHERE id=${accepted}`)[0]!;
  assert.deepEqual(stored.selected_plan,{ installments:3,deferredMonths:0,deferredDays:0 });assert.equal(stored.webhook_id,null);
  const ack=(await db`SELECT * FROM payment_checkout_ack WHERE intent_id=${accepted}`)[0]!;assert.equal(ack.expires_at,null);
  captured=true;const read=await almaCheckoutAdapter.retrieve(stored.config_snapshot,historicalPaymentCredentials(stored),checkoutInput(stored),ack.session_id);
  assert.equal(read.paymentStatus,'PAID');assert.equal(read.providerEvidence!.source,'INDEPENDENT_ALMA_PAYMENT_READ');captured=false;
  assert.equal((await db`SELECT count(*)::int n FROM payment_record`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM enrollment`)[0]!.n,0);
  // Authorization can change during external reads. Every denial occurs before the financial write/marker.
  for(const [change,restore] of [
    [()=>db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.agent!.session}`,()=>db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.agent!.session}`],
    [()=>db`UPDATE lead SET assigned_agent_id=NULL WHERE id=${lead}`,()=>db`UPDATE lead SET assigned_agent_id=${users.agent!.id} WHERE id=${lead}`],
    [()=>db`UPDATE payment_notification_endpoint SET state='DISABLED',version=version+1,actor_user_id=${users.manager!.id},actor_session_id=${users.manager!.session},reason='Pause during preflight' WHERE id=${endpoint.id}`,
      ()=>db`UPDATE payment_notification_endpoint SET state='ENABLED',version=version+1,actor_user_id=${users.manager!.id},actor_session_id=${users.manager!.session},reason='Resume original merchant' WHERE id=${endpoint.id}`],
  ]) {
    const version=(await db`SELECT version FROM payment_notification_endpoint WHERE id=${endpoint.id}`)[0]!.version;
    const id=await create({ notification_endpoint_version:version });const before=writes();afterPreflight=async()=>{ await change!(); };
    try { assert.equal(await dispatch(),true);assert.equal((await state(id)).state,'FAILED');assert.equal(writes(),before);
      assert.equal((await db`SELECT count(*)::int n FROM payment_write_admission WHERE intent_id=${id}`)[0]!.n,0); }
    finally { afterPreflight=null;await restore!(); }
  }
  const version=(await db`SELECT version FROM payment_notification_endpoint WHERE id=${endpoint.id}`)[0]!.version;
  const plan=()=>create({ notification_endpoint_version:version });
  eligible=false;const denied=await plan();const preflightWrites=writes();assert.equal(await dispatch(),true);assert.equal((await state(denied)).state,'FAILED');assert.equal(writes(),preflightWrites);eligible=true;
  // Atomic native audit failure rolls back the marker, and there is no external write to replay.
  await db`CREATE FUNCTION synthetic_alma_admission_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_WRITE_ADMITTED' THEN RAISE EXCEPTION 'synthetic admission audit failure'; END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER synthetic_alma_admission_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_alma_admission_failure()`;
  const auditFailed=await plan();const beforeAudit=writes();try {
    assert.equal(await dispatch(),true);assert.equal((await state(auditFailed)).error_code,'PAYMENT_DISPATCH_REJECTED');assert.equal(writes(),beforeAudit);
    assert.equal((await db`SELECT count(*)::int n FROM payment_write_admission WHERE intent_id=${auditFailed}`)[0]!.n,0);
  }finally { await db`DROP TRIGGER synthetic_alma_admission_failure ON audit_log`;await db`DROP FUNCTION synthetic_alma_admission_failure()`; }
  lost=true;const unknown=await plan();const beforeLost=writes();assert.equal(await dispatch(),true);assert.equal((await state(unknown)).state,'NEEDS_ATTENTION');assert.equal(writes(),beforeLost+1);lost=false;
  assert.equal((await db`SELECT count(*)::int n FROM payment_write_admission WHERE intent_id=${unknown}`)[0]!.n,1);
  for(let n=0;n<3;n++)assert.equal(await dispatch(),false);assert.equal(writes(),beforeLost+1);
  await assert.rejects(db`UPDATE payment_dispatch SET state='RETRY' WHERE intent_id=${unknown}`,/PAYMENT_DISPATCH_TRANSITION_INVALID/);
  // A claimed worker can die after the write. A late response cannot undo recovery or authorize another POST.
  const interrupted=await plan();let release!:()=>void;let entered!:()=>void;const started=new Promise<void>((r)=>{ entered=r; });
  afterWrite=async()=>{ entered();await new Promise<void>((r)=>{ release=r; }); };const pending=dispatch();await started;
  // Isolated crash-clock fixture only; the production transition fence remains enabled before recovery.
  await db.begin(async(tx)=> {
    await tx`ALTER TABLE payment_dispatch DISABLE TRIGGER payment_dispatch_guard`;
    await tx`UPDATE payment_dispatch SET lease_until=clock_timestamp()-interval '1 second' WHERE intent_id=${interrupted}`;
    await tx`ALTER TABLE payment_dispatch ENABLE TRIGGER payment_dispatch_guard`;
  });
  try { assert.equal(await dispatch(),true);assert.equal((await state(interrupted)).state,'NEEDS_ATTENTION'); }
  finally { release();await pending;afterWrite=null; }
  assert.equal((await db`SELECT state FROM payment_dispatch_attempt WHERE intent_id=${interrupted}`)[0]!.state,'INTERRUPTED');
  assert.equal((await db`SELECT count(*)::int n FROM payment_checkout_ack WHERE intent_id=${interrupted}`)[0]!.n,0);assert.equal(await dispatch(),false);
  // Policy/profile corruption and marker claims without a matching live attempt/merchant lease fail natively.
  const fresh=await plan();const now=Number((await db`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint ms`)[0]!.ms);const token=randomUUID();
  const policy={ writeReplay:'NEVER',maxAttempts:1,retentionMs:null,dispatchBudgetMs:30000,retryBaseMs:2000,retryMaxMs:60000 };
  for(const bad of [{ ...policy,maxAttempts:2 },{ ...policy,retentionMs:1000 },{ ...policy,writeReplay:'PROVIDER_KEY' },{ ...policy,dispatchBudgetMs:0 },{ ...policy,extra:true }])
    await assert.rejects(db`UPDATE payment_dispatch SET state='RUNNING',lease_token=${token},lease_until=clock_timestamp()+interval '60 seconds',first_dispatch_ms=${now},policy=${db.json(bad)} WHERE intent_id=${fresh}`);
  await assert.rejects(db`INSERT INTO payment_write_admission(intent_id,attempt_id) VALUES (${fresh},${token})`,/PAYMENT_WRITE_ADMISSION_CURRENT_FENCE_REQUIRED/);
  await db`UPDATE payment_dispatch SET state='RUNNING',lease_token=${token},lease_until=clock_timestamp()+interval '60 seconds',first_dispatch_ms=${now-23000},policy=${db.json(policy)} WHERE intent_id=${fresh}`;
  await db`INSERT INTO payment_dispatch_attempt(id,intent_id,number) VALUES (${token},${fresh},1)`;
  await assert.rejects(db`INSERT INTO payment_write_admission(intent_id,attempt_id) VALUES (${fresh},${token})`,/PAYMENT_WRITE_ADMISSION_CURRENT_FENCE_REQUIRED/);
  await assert.rejects(db`INSERT INTO payment_dispatch_attempt(id,intent_id,number) VALUES (${randomUUID()},${fresh},2)`);
  // Isolate the native budget fence with an otherwise valid merchant lease.
  await db`UPDATE payment_merchant_lease SET token=${token},expires_at=clock_timestamp()+interval '60 seconds'
    WHERE provider='ALMA' AND account_ref=${merchant} AND mode='TEST'`;
  await assert.rejects(db`INSERT INTO payment_write_admission(intent_id,attempt_id) VALUES (${fresh},${token})`,/PAYMENT_WRITE_ADMISSION_CURRENT_FENCE_REQUIRED/);
  await db`UPDATE payment_merchant_lease SET token=NULL,expires_at=NULL WHERE provider='ALMA' AND account_ref=${merchant} AND mode='TEST'`;
  const direct=await plan();const directToken=randomUUID();
  await db`UPDATE payment_dispatch SET state='RUNNING',lease_token=${directToken},lease_until=clock_timestamp()+interval '60 seconds',
    first_dispatch_ms=floor(extract(epoch FROM clock_timestamp())*1000),policy=${db.json(policy)} WHERE intent_id=${direct}`;
  await db`INSERT INTO payment_dispatch_attempt(id,intent_id,number) VALUES (${directToken},${direct},1)`;
  await assert.rejects(db`INSERT INTO payment_write_admission(intent_id,attempt_id) VALUES (${direct},${directToken})`,/PAYMENT_WRITE_ADMISSION_CURRENT_FENCE_REQUIRED/);
  await db`UPDATE payment_merchant_lease SET token=${directToken},expires_at=clock_timestamp()+interval '60 seconds'
    WHERE provider='ALMA' AND account_ref=${merchant} AND mode='TEST'`;
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.agent!.session}`;
  await assert.rejects(db`INSERT INTO payment_write_admission(intent_id,attempt_id) VALUES (${direct},${directToken})`,/PAYMENT_WRITE_ADMISSION_CURRENT_FENCE_REQUIRED/);
  await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.agent!.session}`;
  await db`INSERT INTO payment_write_admission(intent_id,attempt_id,admitted_at) VALUES (${direct},${directToken},'2000-01-01')`;
  assert.ok(new Date((await db`SELECT admitted_at FROM payment_write_admission WHERE intent_id=${direct}`)[0]!.admitted_at).getFullYear()>2000,'native DB clock replaces caller timestamp');
  const duplicateNative=await Promise.allSettled(Array.from({ length:4 },()=>db`INSERT INTO payment_write_admission(intent_id,attempt_id) VALUES (${direct},${directToken})`));
  assert.ok(duplicateNative.every((r)=>r.status==='rejected'));
  assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='PAYMENT_WRITE_ADMITTED' AND target_id=${direct}`)[0]!.n,1);
  // The prepared source and encrypted historical inputs cannot migrate to a different merchant or mode.
  await db`UPDATE integration_connection SET version=version+1,capabilities='{}' WHERE id=${connection}`;
  assert.equal((await db`SELECT payment_dispatch_authorized(${fresh}) allowed`)[0]!.allowed,false);
  await assert.rejects(create(),/PAYMENT_LINK_CONNECTION_NOT_READY/);
  assert.equal((await db`SELECT count(*)::int n FROM payment_confirmation`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::int n FROM payment_record`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM enrollment`)[0]!.n,0);
});
