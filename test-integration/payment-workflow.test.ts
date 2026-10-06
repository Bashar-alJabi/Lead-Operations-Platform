import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes,createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { openOpaque } from '../src/credentials.js';
import { processOnePaymentDispatch } from '../src/payments/dispatch-worker.js';
import { processOnePaymentReceipt } from '../src/payments/confirmation-worker.js';
import { stripeCurrencyPrecision,PaymentCheckoutError,type CheckoutIntent,type CheckoutSnapshot,type PaymentCheckoutAdapter } from '../src/payments/checkout-provider.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Durable payment issuance and trusted confirmation preserve authorization, retry evidence, money, independent Enrollment and historical recovery',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const accountRef='acct_WorkflowSynthetic123';const key='rk_test_'+'WorkflowSyntheticOnly'.repeat(3);
  const options={ accountRef,country:'US',defaultCurrency:'USD',currencies:['USD'],paymentMethods:['card'],chargesEnabled:true,cardPayments:'ACTIVE' as const };
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,paymentConnectionAdapters:{ STRIPE:{ verify:async(config)=>({ mode:config.mode }),inspect:async(config)=>({ mode:config.mode,options }),
    inspectWebhook:async(config,_secret,id)=>({ mode:config.mode,endpointId:id,url:(await db`SELECT callback_url FROM payment_webhook WHERE external_endpoint_id=${id}`)[0]!.callback_url,
      enabled:true,enabledEvents:['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'] }) } } });
  t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;await tx`TRUNCATE payment_merchant_lease`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Financial workflow') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['agent','AGENT',branch],['second','AGENT',branch],['other','MANAGER',otherBranch]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${org},${scope},${name},${role},${name+'@finance.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at)
      VALUES (${id},${sha256(token)},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name]={ id,cookie:'lop_session='+token,session };
  }
  const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'Enrollment') RETURNING id`)[0]!.id;
  const lead=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind)
    VALUES (${org},${branch},${campaign},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id;
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor='manager')=>app.inject({ method,url:path,payload,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.10.${ip++%240+1}` });
  const connection=(await api('POST','/api/payments/connections',{ name:'Tuition account',provider:'STRIPE',config:{ mode:'TEST' },credentials:{ apiKey:key } })).json().id;
  const cr='/api/payments/connections/'+connection;assert.equal((await api('POST',cr+'/test',{ version:1,inspectOptions:true })).statusCode,200);
  const w=(await api('POST',cr+'/webhooks',{ connectionVersion:1,reason:'Trusted financial callbacks' })).json();const wr=cr+'/webhooks/'+w.id;
  const secret='whsec_'+'WorkflowSyntheticOnly'.repeat(3);
  assert.equal((await api('POST',wr+'/configure',{ version:1,endpointId:'we_WorkflowSynthetic123',signingSecret:secret,reason:'Configured exact destination' })).statusCode,200);
  assert.equal((await api('POST',wr+'/test',{ version:2,connectionVersion:1 })).statusCode,200);
  const send=async(intentId:string|null,sessionId:string,type='checkout.session.completed',eventId='evt_'+randomUUID().replaceAll('-',''),signed=true)=> {
    const payload=JSON.stringify({ id:eventId,object:'event',type,livemode:false,created:1234567890,
      data:{ object:{ id:sessionId,object:'checkout.session',metadata:{ platform_intent_id:intentId },payment_status:'paid',amount_total:1250,currency:'usd' } } });
    const now=(await db`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS n`)[0]!.n;
    return app.inject({ method:'POST',url:new URL(w.callback_url).pathname,payload,headers:{ 'content-type':'application/json',
      'stripe-signature':`t=${now},v1=${createHmac('sha256',signed ? secret : secret+'wrong').update(now+'.').update(payload).digest('hex')}` } });
  };
  assert.equal((await send(null,'cs_test_WorkflowProbe123','checkout.session.expired')).statusCode,200);
  const method=(await api('POST','/api/payments/methods',{ name:'Tuition <img src=x>',branchId:branch,connectionId:connection,currencies:['USD'],active:true,
    agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'ALL',ids:[] },reason:'Approved financial method' })).json().id;
  const requests='/api/leads/'+lead+'/payment-link-requests';
  const request=async(actor='agent')=> { const response=await api('POST',requests,{ requestId:randomUUID(),methodId:method,methodVersion:1,amount:'12.5',currency:'USD' },actor);
    assert.equal(response.statusCode,201,response.body);return response.json().id as string; };
  const snapshots=new Map<string,CheckoutSnapshot>();const inputs:CheckoutIntent[]=[];let reads=0;let createHook:((i:CheckoutIntent)=>Promise<void>)|null=null;
  let createError:PaymentCheckoutError|null=null;let retrievalError:PaymentCheckoutError|null=null;let retention=86400000;let expectedRetrievalKey=key;
  const adapter:PaymentCheckoutAdapter={ currencyPrecision:stripeCurrencyPrecision,get idempotencyRetentionMs(){ return retention; },
    async create(config,credentials,i) {
      assert.equal(credentials.apiKey,key);assert.equal(config.mode,'TEST');inputs.push(structuredClone(i));
      if(createError)throw createError;
      if(!snapshots.has(i.id)) { const sessionId='cs_test_'+i.id.replaceAll('-','');snapshots.set(i.id,{ sessionId,url:'https://checkout.stripe.com/c/pay/'+sessionId,
        expiresAt:new Date(Date.now()+3600000).toISOString(),mode:'TEST',currency:i.money.currency,minor:i.money.minor,intentId:i.id,status:'OPEN',paymentStatus:'UNPAID',paymentRef:null }); }
      const result=structuredClone(snapshots.get(i.id)!);if(createHook)await createHook(i);return result;
    },async retrieve(_config,credentials,i,id) { reads++;if(credentials.apiKey!==expectedRetrievalKey)throw new PaymentCheckoutError('PAYMENT_PROVIDER_AUTH_FAILED','REJECTED');if(retrievalError)throw retrievalError;
      const result=structuredClone(snapshots.get(i.id)!);assert.equal(result.sessionId,id);return result; },
  };
  const adapters={ STRIPE:adapter };
  const drain=async()=>{ for(let n=0;n<25 && await processOnePaymentReceipt(db,adapters);n++) { /* bounded test drain */ } };
  const paid=(id:string)=>{ const snapshot=snapshots.get(id)!;snapshot.status='COMPLETE';snapshot.paymentStatus='PAID';snapshot.url=null;snapshot.paymentRef='pi_'+id.replaceAll('-',''); };
  const dispatchState=async(id:string)=>(await db`SELECT state,error_code FROM payment_dispatch WHERE intent_id=${id}`)[0]!;
  const countEnrollment=async()=>(await db`SELECT count(*)::integer AS n FROM enrollment`)[0]!.n;

  await t.test('one merchant lease prevents parallel writes; an accepted URL is encrypted and does not imply payment',async()=> {
    const id=await request();const second=await request();
    assert.equal((await api('GET',requests+'/'+id,undefined,'agent')).json().customerUrl,null);
    let arrived!:()=>void;let release!:()=>void;
    const started=new Promise<void>((resolve)=>{ arrived=resolve; });const gate=new Promise<void>((resolve)=>{ release=resolve; });createHook=async()=>{ arrived();await gate; };
    const running=processOnePaymentDispatch(db,adapters);await Promise.race([started,running.then(()=>{ throw new Error('No provider claim'); })]);
    const others=await Promise.all(Array.from({ length:8 },()=>processOnePaymentDispatch(db,adapters)));assert.deepEqual(others,Array(8).fill(false));assert.equal(inputs.length,1);
    release();await running;createHook=null;assert.equal((await dispatchState(id)).state,'ACCEPTED');await processOnePaymentDispatch(db,adapters);assert.equal((await dispatchState(second)).state,'ACCEPTED');
    const ack=(await db`SELECT * FROM payment_checkout_ack WHERE intent_id=${id}`)[0]!;assert.equal(ack.ciphertext.toString().includes('checkout.stripe.com'),false);
    const dto=(await api('GET',requests,undefined,'agent')).json().items.find((row:{ id:string })=>row.id===id);assert.equal(dto.customerUrl,snapshots.get(id)!.url);assert.equal(dto.paymentState,null);assert.equal(dto.enrollmentId,null);
    const detail=await api('GET',requests+'/'+id,undefined,'agent');assert.equal(detail.statusCode,200);assert.equal(detail.json().customerUrl,dto.customerUrl);
    for(const forbidden of ['account_ref','ciphertext','nonce','config_snapshot',key,accountRef])assert.equal(detail.body.includes(forbidden),false);
    assert.equal((await api('GET',requests+'/'+id,undefined,'second')).statusCode,404);
    assert.equal((await api('GET',requests+'/'+id,undefined,'other')).statusCode,404);
    assert.equal((await api('GET',requests+'/'+randomUUID(),undefined,'agent')).statusCode,404);
    assert.equal((await api('GET',requests+'/invalid-uuid',undefined,'agent')).statusCode,400);
    const anotherLead=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind)
      VALUES (${org},${branch},${campaign},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id;
    assert.equal((await api('GET','/api/leads/'+anotherLead+'/payment-link-requests/'+id,undefined,'agent')).statusCode,404);
    assert.equal(await countEnrollment(),0);assert.equal((await db`SELECT count(*)::integer AS n FROM contact`)[0]!.n,0);
    assert.equal((await send(id,ack.session_id,undefined,undefined,false)).statusCode,403);assert.equal(await countEnrollment(),0);
    snapshots.get(id)!.status='COMPLETE';snapshots.get(id)!.url=null;
    await send(id,ack.session_id);await drain();assert.equal((await db`SELECT state FROM payment_record WHERE intent_id=${id}`)[0]!.state,'PENDING');assert.equal(await countEnrollment(),0);
    assert.equal((await api('GET',requests,undefined,'agent')).json().items.find((row:{ id:string })=>row.id===id).customerUrl,null);
    assert.equal((await api('GET',requests+'/'+id,undefined,'agent')).json().customerUrl,null);
    paid(id);const eventId='evt_WorkflowPaid123';const deliveries=await Promise.all(Array.from({ length:8 },()=>send(id,ack.session_id,undefined,eventId)));
    assert.equal(deliveries.filter((r)=>!r.json().duplicate).length,1);
    await db`CREATE FUNCTION synthetic_confirmation_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_RECEIPT_VERIFIED' THEN RAISE EXCEPTION 'synthetic rollback' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`;
    await db`CREATE TRIGGER synthetic_confirmation_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_confirmation_audit_failure()`;
    const receiptId=(await db`SELECT id FROM payment_webhook_event WHERE external_event_id=${eventId}`)[0]!.id;
    try { await assert.rejects(processOnePaymentReceipt(db,adapters));assert.equal(await countEnrollment(),0);
      assert.equal((await db`SELECT state FROM payment_record WHERE intent_id=${id}`)[0]!.state,'PENDING');
      assert.equal((await db`SELECT count(*)::integer AS n FROM payment_confirmation WHERE event_id=${receiptId}`)[0]!.n,0);
    }finally { await db`DROP TRIGGER synthetic_confirmation_audit_failure ON audit_log`;await db`DROP FUNCTION synthetic_confirmation_audit_failure()`; }
    await db.begin(async(tx)=>{ await tx`ALTER TABLE payment_receipt_job DISABLE TRIGGER payment_receipt_job_guard`;
      await tx`UPDATE payment_receipt_job SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=${receiptId}`;await tx`ALTER TABLE payment_receipt_job ENABLE TRIGGER payment_receipt_job_guard`; });
    await processOnePaymentReceipt(db,adapters);await delay(2100);await Promise.all(Array.from({ length:6 },()=>processOnePaymentReceipt(db,adapters)));
    assert.equal((await db`SELECT state FROM payment_record WHERE intent_id=${id}`)[0]!.state,'CONFIRMED');assert.equal(await countEnrollment(),1);
    const confirmed=(await api('GET',requests,undefined,'agent')).json().items.find((row:{ id:string })=>row.id===id);assert.equal(confirmed.customerUrl,null);assert.ok(confirmed.enrollmentId);assert.ok(confirmed.confirmedAt);
    snapshots.get(id)!.status='EXPIRED';snapshots.get(id)!.paymentStatus='UNPAID';snapshots.get(id)!.paymentRef=null;
    await send(id,ack.session_id,'checkout.session.expired');await drain();assert.equal((await db`SELECT state FROM payment_record WHERE intent_id=${id}`)[0]!.state,'CONFIRMED');assert.equal(await countEnrollment(),1);
    assert.equal((await db`SELECT lifecycle FROM lead WHERE id=${lead}`)[0]!.lifecycle,'OPEN');
    for(const mutation of [db`DELETE FROM enrollment`,db`UPDATE payment_confirmation SET minor='9999'`,db`UPDATE payment_record SET state='PENDING',confirmed_at=NULL,payment_ref=NULL WHERE intent_id=${id}`,db`DELETE FROM payment_checkout_ack WHERE intent_id=${id}`])await assert.rejects(mutation);
  });
  await t.test('trusted callback before ACK confirms with historical credentials even after requester disable and Connection rotation',async()=> {
    const id=await request();let arrived!:()=>void;let release!:()=>void;const started=new Promise<void>((r)=>{ arrived=r; });const gate=new Promise<void>((r)=>{ release=r; });
    createHook=async()=>{ arrived();await gate; };const running=processOnePaymentDispatch(db,adapters);await Promise.race([started,running.then(()=>{ throw new Error('No provider claim'); })]);
    try {
      paid(id);await db`UPDATE user_account SET active=false WHERE id=${users.agent!.id}`;
      await api('PUT',cr,{ name:'Rotated account',provider:'STRIPE',config:{ mode:'TEST' },credentials:{ apiKey:'rk_test_'+'ReplacementSyntheticOnly'.repeat(3) },version:1 });
      await send(id,snapshots.get(id)!.sessionId);await drain();assert.equal(await countEnrollment(),2);assert.equal((await dispatchState(id)).state,'RUNNING');
    }finally { release();await running;createHook=null;await db`UPDATE user_account SET active=true WHERE id=${users.agent!.id}`; }
    assert.equal((await dispatchState(id)).state,'ACCEPTED');assert.equal((await api('GET',requests,undefined,'agent')).json().items[0].customerUrl,null);
    await db`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`;
    assert.equal((await api('GET',requests,undefined,'agent')).statusCode,404);assert.equal((await api('GET',requests+'/'+id+'/attempts',undefined,'agent')).statusCode,404);
    const current=await api('GET',requests,undefined,'second');assert.equal(current.statusCode,200);assert.ok(current.json().items[0].enrollmentId);
    assert.equal((await api('GET',requests,undefined,'other')).statusCode,404);
    // Restore public setup using the same synthetic original account credential; earlier inputs remain immutable.
    await api('PUT',cr,{ name:'Original account restored',provider:'STRIPE',config:{ mode:'TEST' },credentials:{ apiKey:key },version:2 });
    await api('POST',cr+'/test',{ version:3,inspectOptions:true });
  });
  // The old Method uses Connection version3 now; prepare its new immutable endpoint for new requests.
  const nw=(await api('POST',cr+'/webhooks',{ connectionVersion:3,reason:'New credential version callback' })).json();
  await api('POST',cr+'/webhooks/'+nw.id+'/configure',{ version:1,endpointId:'we_WorkflowReplacement123',signingSecret:secret,reason:'Registered current version' });
  await api('POST',cr+'/webhooks/'+nw.id+'/test',{ version:2,connectionVersion:3 });
  const probePayload=JSON.stringify({ id:'evt_WorkflowReplacement123',object:'event',type:'checkout.session.expired',livemode:false,created:1234567890,data:{ object:{ id:'cs_test_WorkflowReplacement123',object:'checkout.session' } } });
  const probeTime=Math.floor(Date.now()/1000);await app.inject({ method:'POST',url:new URL(nw.callback_url).pathname,payload:probePayload,headers:{ 'content-type':'application/json',
    'stripe-signature':`t=${probeTime},v1=${createHmac('sha256',secret).update(probeTime+'.').update(probePayload).digest('hex')}` } });
  await db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
  await t.test('metadata, exact money mismatch and unavailable providers never fabricate confirmed Payment',async()=> {
    const before=reads;await send(randomUUID(),'cs_test_UnmatchedSynthetic123');await drain();assert.equal(reads,before);assert.equal(await countEnrollment(),2);
    const id=await request();await processOnePaymentDispatch(db,adapters);paid(id);snapshots.get(id)!.minor='9999';
    await send(id,snapshots.get(id)!.sessionId);await drain();assert.equal(await countEnrollment(),2);
    const rejected=(await db`SELECT j.* FROM payment_receipt_job j JOIN payment_webhook_event e ON e.id=j.event_id WHERE e.object_id=${snapshots.get(id)!.sessionId}`)[0]!;
    assert.equal(rejected.state,'NEEDS_ATTENTION');const rr=cr+'/webhook-events/'+rejected.event_id;
    assert.equal((await api('POST',rr+'/retry',{ attempts:1,reason:'Review exact money mismatch' },'agent')).statusCode,403);
    assert.equal((await api('POST',rr+'/retry',{ attempts:1,reason:'Review exact money mismatch' },'other')).statusCode,404);
    assert.equal((await api('POST',rr+'/retry',{ attempts:0,reason:'Stale recovery budget' })).statusCode,409);
    const recoveries=await Promise.all(Array.from({ length:6 },()=>api('POST',rr+'/retry',{ attempts:1,reason:'Review exact money mismatch' })));
    assert.deepEqual(recoveries.map((r)=>r.statusCode).sort(),[200,409,409,409,409,409]);await drain();
    const attempts=(await api('GET',rr+'/attempts')).json().items;assert.equal(attempts.length,2);assert.deepEqual(attempts.map((a:{ state:string })=>a.state),['REJECTED','REJECTED']);
    snapshots.get(id)!.minor='1250';retrievalError=new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE','RETRYABLE');
    await send(id,snapshots.get(id)!.sessionId);await drain();assert.equal(await countEnrollment(),2);retrievalError=null;
  });
  await t.test('current revoked session and changed ownership block unsent requests without provider I/O',async()=> {
    const id=await request();const before=inputs.length;await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.agent!.session}`;
    const token=randomUUID();
    await assert.rejects(db.begin(async(tx)=> {
      await tx`UPDATE payment_dispatch SET state='RUNNING',lease_token=${token},lease_until=clock_timestamp()+interval '60 seconds',
        first_dispatch_ms=floor(extract(epoch FROM clock_timestamp())*1000),policy=${tx.json({ maxAttempts:5,retentionMs:86400000,dispatchBudgetMs:20000,retryBaseMs:2000,retryMaxMs:60000 })} WHERE intent_id=${id}`;
      await tx`INSERT INTO payment_dispatch_attempt(id,intent_id,number) VALUES (${token},${id},1)`;
    }),/PAYMENT_DISPATCH_CURRENT_FENCE_REQUIRED/);
    assert.equal((await dispatchState(id)).state,'QUEUED');
    await assert.rejects(db`UPDATE payment_dispatch SET state='RUNNING',lease_token=${token},lease_until=clock_timestamp()+interval '60 seconds',first_dispatch_ms=1,policy='{}'::jsonb WHERE intent_id=${id}`);
    await processOnePaymentDispatch(db,adapters);assert.equal((await dispatchState(id)).state,'BLOCKED');assert.equal(inputs.length,before);
    await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.agent!.session}`;
    const changed=await request();await db`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`;
    await processOnePaymentDispatch(db,adapters);assert.equal((await dispatchState(changed)).state,'BLOCKED');assert.equal(inputs.length,before);
    await db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
  });
  await t.test('UNKNOWN remains uncertain at the deadline; known rejection fails without generating a new key',async()=> {
    retention=21000;createError=new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE','UNKNOWN');const unknown=await request();await processOnePaymentDispatch(db,adapters);
    assert.equal((await dispatchState(unknown)).state,'NEEDS_ATTENTION');assert.equal((await dispatchState(unknown)).error_code,'PAYMENT_DISPATCH_WINDOW_ELAPSED');
    const before=inputs.length;assert.equal(await processOnePaymentDispatch(db,adapters),false);assert.equal(inputs.length,before);
    createError=new PaymentCheckoutError('PAYMENT_PROVIDER_RATE_LIMITED','RETRYABLE',60);const known=await request();await processOnePaymentDispatch(db,adapters);assert.equal((await dispatchState(known)).state,'FAILED');
    createError=null;retention=86400000;assert.equal(await countEnrollment(),2);
    for(const mutation of [db`UPDATE payment_dispatch SET first_dispatch_ms=first_dispatch_ms+1 WHERE intent_id=${unknown}`,db`UPDATE payment_dispatch_attempt SET state='REJECTED' WHERE intent_id=${unknown}`,db`DELETE FROM payment_dispatch WHERE intent_id=${unknown}`])await assert.rejects(mutation);
    createError=new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE','UNKNOWN');const ambiguous=await request();await processOnePaymentDispatch(db,adapters);
    assert.equal((await dispatchState(ambiguous)).state,'RETRY');createError=new PaymentCheckoutError('PAYMENT_PROVIDER_AUTH_FAILED','REJECTED');await delay(2100);await processOnePaymentDispatch(db,adapters);
    assert.equal((await dispatchState(ambiguous)).state,'NEEDS_ATTENTION');assert.equal(inputs.filter((i)=>i.id===ambiguous).length,2);createError=null;
  });
  await t.test('a failed result transaction is recovered using the same immutable request, after an expired lease records INTERRUPTED',async()=> {
    const id=await request();await db`CREATE FUNCTION synthetic_checkout_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_DISPATCH_STATE' AND NEW.detail->>'state'='ACCEPTED' THEN RAISE EXCEPTION 'synthetic rollback' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`;
    await db`CREATE TRIGGER synthetic_checkout_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_checkout_audit_failure()`;
    try { await assert.rejects(processOnePaymentDispatch(db,adapters));assert.equal((await dispatchState(id)).state,'RUNNING');assert.equal((await db`SELECT count(*)::integer AS n FROM payment_checkout_ack WHERE intent_id=${id}`)[0]!.n,0); }
    finally { await db`DROP TRIGGER synthetic_checkout_audit_failure ON audit_log`;await db`DROP FUNCTION synthetic_checkout_audit_failure()`; }
    // Test-only crash-time fixture. Production recovery uses the real database lease deadline.
    await db.begin(async(tx)=> { await tx`ALTER TABLE payment_dispatch DISABLE TRIGGER payment_dispatch_guard`;
      await tx`UPDATE payment_dispatch SET lease_until=clock_timestamp()-interval '1 second' WHERE intent_id=${id}`;await tx`ALTER TABLE payment_dispatch ENABLE TRIGGER payment_dispatch_guard`; });
    await processOnePaymentDispatch(db,adapters);assert.equal((await dispatchState(id)).state,'RETRY');await delay(2100);await processOnePaymentDispatch(db,adapters);
    assert.equal((await dispatchState(id)).state,'ACCEPTED');const attempts=(await api('GET',requests+'/'+id+'/attempts',undefined,'agent')).json().items;
    assert.deepEqual(attempts.map((a:{ state:string })=>a.state),['INTERRUPTED','ACKNOWLEDGED']);
    const repeated=inputs.filter((i)=>i.id===id);assert.equal(repeated.length,2);assert.deepEqual(repeated[0],repeated[1]);
    for(const hidden of [key,secret,accountRef,'ciphertext','requester_session_id'])assert.equal((await api('GET',requests,undefined,'agent')).body.includes(hidden),false);
  });
  await t.test('explicit credential repair requires the same verified account/mode and current management scope without replacing originals or resetting budgets',async()=> {
    const id=inputs.at(-1)!.id;paid(id);const replacement='rk_test_'+'ApprovedRepairSynthetic'.repeat(3);expectedRetrievalKey=replacement;
    const eventId='evt_WorkflowCredentialRepair123';await send(id,snapshots.get(id)!.sessionId,undefined,eventId);await drain();
    const event=(await db`SELECT e.id,j.attempts,j.state FROM payment_webhook_event e JOIN payment_receipt_job j ON j.event_id=e.id WHERE e.external_event_id=${eventId}`)[0]!;
    assert.equal(event.state,'NEEDS_ATTENTION');assert.equal(event.attempts,1);const rr=cr+'/webhook-events/'+event.id;
    for(let attempts=1;attempts<5;attempts++) {
      assert.equal((await api('POST',rr+'/retry',{ attempts,reason:'Verify whether historical permission recovered' })).statusCode,200);await drain();
    }
    assert.equal((await db`SELECT attempts FROM payment_receipt_job WHERE event_id=${event.id}`)[0]!.attempts,5);
    assert.equal((await api('POST',rr+'/retry',{ attempts:5,reason:'No approval for another verification window' })).statusCode,409);
    await assert.rejects(db`UPDATE payment_receipt_job SET attempt_limit=10 WHERE event_id=${event.id}`);
    const body={ attempts:5,reason:'Replace revoked read credential and approve five more verification attempts',useCurrentCredentials:true,connectionVersion:4 };
    assert.equal((await api('POST',rr+'/retry',body,'agent')).statusCode,403);assert.equal((await api('POST',rr+'/retry',body,'other')).statusCode,404);
    assert.equal((await api('POST',rr+'/retry',body)).statusCode,409);
    assert.equal((await api('PUT',cr,{ name:'Verified historical repair',provider:'STRIPE',config:{ mode:'TEST' },credentials:{ apiKey:replacement },version:3 })).statusCode,200);
    assert.equal((await api('POST',rr+'/retry',body)).statusCode,409); // No current authentication/options proof.
    options.accountRef='acct_WrongRepairMerchant123';assert.equal((await api('POST',cr+'/test',{ version:4,inspectOptions:true })).statusCode,200);
    assert.equal((await api('POST',rr+'/retry',body)).json().error,'PAYMENT_RECOVERY_ACCOUNT_MISMATCH');options.accountRef=accountRef;
    assert.equal((await api('POST',cr+'/test',{ version:4,inspectOptions:true })).statusCode,200);
    assert.equal((await api('POST',rr+'/retry',{ ...body,connectionVersion:3 })).json().error,'CONNECTION_VERSION_CONFLICT');
    await db`CREATE FUNCTION synthetic_repair_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_RECEIPT_RETRY' AND NEW.detail->>'credentialRepair'='true' THEN RAISE EXCEPTION 'synthetic rollback' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`;
    await db`CREATE TRIGGER synthetic_repair_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_repair_audit_failure()`;
    try { assert.equal((await api('POST',rr+'/retry',body)).statusCode,500);assert.equal((await db`SELECT count(*)::integer AS n FROM payment_receipt_credential`)[0]!.n,0); }
    finally { await db`DROP TRIGGER synthetic_repair_audit_failure ON audit_log`;await db`DROP FUNCTION synthetic_repair_audit_failure()`; }
    const responses=await Promise.all(Array.from({ length:6 },()=>api('POST',rr+'/retry',body)));assert.deepEqual(responses.map((r)=>r.statusCode).sort(),[200,409,409,409,409,409]);
    const sealed=(await db`SELECT * FROM payment_receipt_credential WHERE event_id=${event.id}`)[0]!;assert.equal(sealed.ciphertext.toString().includes(replacement),false);
    assert.equal(JSON.parse(openOpaque('payment-receipt-repair:'+sealed.id,{ ciphertext:sealed.ciphertext,nonce:sealed.nonce,authTag:sealed.auth_tag,keyVersion:sealed.key_version })).apiKey,replacement);
    const original=(await db`SELECT * FROM payment_link_intent WHERE id=${id}`)[0]!;
    assert.equal(JSON.parse(openOpaque('payment-link:'+id,{ ciphertext:original.ciphertext,nonce:original.nonce,authTag:original.auth_tag,keyVersion:original.key_version })).apiKey,key);
    const writes=inputs.length;const enrolled=await countEnrollment();await drain();assert.equal(await countEnrollment(),enrolled+1);assert.equal(inputs.length,writes);
    const attempts=(await api('GET',rr+'/attempts')).json().items;assert.deepEqual(attempts.map((a:{ repaired_credentials:boolean })=>a.repaired_credentials),[true,false,false,false,false,false]);
    assert.equal((await db`SELECT attempts,attempt_limit FROM payment_receipt_job WHERE event_id=${event.id}`)[0]!.attempt_limit,10);
    const historyPage=(await api('GET',rr+'/attempts?limit=2')).json();assert.equal(historyPage.nextNumber,5);
    assert.deepEqual((await api('GET',rr+'/attempts?limit=2&before=5')).json().items.map((a:{ number:number })=>a.number),[4,3]);
    assert.equal((await api('POST',rr+'/retry',{ ...body,attempts:6 })).statusCode,409);
    for(const mutation of [db`DELETE FROM payment_receipt_credential WHERE id=${sealed.id}`,db`UPDATE payment_receipt_credential SET account_ref='changed' WHERE id=${sealed.id}`,
      db`UPDATE payment_receipt_attempt SET credential_repair_id=NULL WHERE event_id=${event.id} AND number=6`])await assert.rejects(mutation);
    for(const hidden of [replacement,key,'ciphertext',accountRef])assert.equal((await api('GET',cr+'/webhook-events')).body.includes(hidden),false);
  });
});
