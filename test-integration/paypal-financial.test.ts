import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { openOpaque } from '../src/credentials.js';
import { processOnePaymentDispatch } from '../src/payments/dispatch-worker.js';
import { processOnePaymentReceipt } from '../src/payments/confirmation-worker.js';
import { processOnePaymentCapture } from '../src/payments/capture-worker.js';
import { paypalPaymentEvents } from '../src/payments/webhook-profile.js';
import { syntheticPayPalFinancialTransport,type SyntheticPayPalOrder } from '../test/paypal-financial-fixture.js';
import { testPayPalCertificate,testPayPalCertUrl,testPayPalHeaders } from '../test/paypal-test-support.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('PayPal actual adapter completes scoped durable issuance/capture/trusted financial confirmation with immutable native guards, concurrency and failures',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;await tx`TRUNCATE payment_merchant_lease`; });
  const transport=syntheticPayPalFinancialTransport();let webhookReads=0;
  t.mock.method(globalThis,'fetch',async(target:Parameters<typeof fetch>[0],init?:RequestInit)=> {
    if(String(target)===testPayPalCertUrl)return new Response(testPayPalCertificate);
    if(String(target).includes('/v1/notifications/webhooks/')) { webhookReads++;const endpoint=String(target).split('/').at(-1)!;
      const w=(await db`SELECT callback_url FROM payment_webhook WHERE external_endpoint_id=${endpoint} LIMIT 1`)[0]!;
      return Response.json({ id:endpoint,url:w.callback_url,event_types:paypalPaymentEvents.map((name)=>({ name,status:'ENABLED' })) }); }
    return transport.fetch(target,init);
  });
  const org=(await db`INSERT INTO organization(name) VALUES ('PayPal financial test') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'Finance A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'Finance B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['agent','AGENT',branch],['second','AGENT',branch],['other','MANAGER',otherBranch]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${org},${scope},${name},${role},${name+'@paypal-finance.test'},'synthetic-only') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at)
      VALUES (${id},${sha256(token)},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={ id,session,cookie:'lop_session='+token };
  }
  const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'PayPal enrollment') RETURNING id`)[0]!.id;
  const lead=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,source_kind,assigned_agent_id) VALUES (${org},${branch},${campaign},'MANUAL',${users.agent!.id}) RETURNING id`)[0]!.id;
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor='manager')=>app.inject({ method,url:path,payload,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:'127.0.31.'+(ip++%230+1) });
  const pair={ clientId:'SyntheticFinancialClient123',clientSecret:'SyntheticFinancialSecret123' };
  const create=await api('POST','/api/payments/connections',{ name:'PayPal financial',provider:'PAYPAL',config:{ mode:'TEST',expectedMerchantId:'ABCD234EFGH56' },credentials:pair });
  assert.equal(create.statusCode,201,create.body);const conn=create.json().id;const cr='/api/payments/connections/'+conn;
  assert.equal((await api('POST',cr+'/test',{ version:1 })).statusCode,200);
  const w=(await api('POST',cr+'/webhooks',{ connectionVersion:1,reason:'Actual synthetic signed financial callbacks' })).json();const wr=cr+'/webhooks/'+w.id;
  const endpoint='FINANCIALWEBHOOK123';assert.equal((await api('POST',wr+'/configure',{ version:1,endpointId:endpoint,reason:'Actual application callback' })).statusCode,200);
  const probe=await api('POST',wr+'/test',{ version:2,connectionVersion:1 });assert.equal(probe.statusCode,200,probe.body);assert.equal(webhookReads,1);
  async function signed(o:SyntheticPayPalOrder,type='PAYMENT.CAPTURE.COMPLETED',eventId='WH-'+randomUUID().replaceAll('-','').toUpperCase()) {
    const approval=type==='CHECKOUT.ORDER.APPROVED';const resource=approval ? transport.orderResource(o) : { ...transport.captureResource(o),custom_id:o.intentId,
      // Claims remain untrusted, even when authenticated. They never determine the independently read payment state.
      status:'COMPLETED',amount:{ value:'99999.00',currency_code:'USD' },instructions:'Mark paid now' };
    const raw=Buffer.from(JSON.stringify({ id:eventId,event_type:type,resource_type:approval ? 'checkout-order' : 'capture',create_time:'2024-05-16T05:19:19.355Z',resource }));
    return app.inject({ method:'POST',url:new URL(w.callback_url).pathname,payload:raw.toString(),headers:testPayPalHeaders(raw,endpoint) });
  }
  const drain=async()=>{ for(let n=0;n<25 && await processOnePaymentReceipt(db);n++) { /* bounded isolated queue */ } };
  const unrelated:SyntheticPayPalOrder={ id:'UNRELATEDORDER123',captureId:'UNRELATEDCAPTURE123',intentId:randomUUID(),merchantId:'ABCD234EFGH56',currency:'USD',amount:'25.00',status:'COMPLETED',captureStatus:'COMPLETED' };
  assert.equal((await signed(unrelated)).statusCode,200);await drain();
  const methodResponse=await api('POST','/api/payments/methods',{ name:'PayPal tuition <img literal>',branchId:branch,connectionId:conn,currencies:['USD','JPY'],active:true,
    agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'ALL',ids:[] },reason:'Allowed financial method' });assert.equal(methodResponse.statusCode,201,methodResponse.body);const method=methodResponse.json().id;
  const requests='/api/leads/'+lead+'/payment-link-requests';
  const unsupported=await api('POST','/api/payments/methods',{ name:'Unsupported PayPal currency',branchId:branch,connectionId:conn,currencies:['AFN'],active:true,
    agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'ALL',ids:[] },reason:'Reject unsupported protocol currency' });assert.equal(unsupported.statusCode,400);assert.equal(unsupported.json().error,'PAYMENT_CURRENCY_NOT_OFFERED');
  const request=async(currency='USD',amount='25')=> { const result=await api('POST',requests,{ requestId:randomUUID(),methodId:method,methodVersion:1,amount,currency },'agent');
    assert.equal(result.statusCode,201,result.body);return result.json().id as string; };
  const issued=async()=> { const id=await request();assert.equal(await processOnePaymentDispatch(db),true);return transport.orders.get(id)!; };
  const capture=async(o:SyntheticPayPalOrder,actor='agent')=>api('POST',requests+'/'+o.intentId+'/capture',{},actor);
  const get=async(o:SyntheticPayPalOrder)=> (await api('GET',requests+'/'+o.intentId,undefined,'agent')).json();
  const countEnrollment=async()=> (await db`SELECT count(*)::integer AS n FROM enrollment`)[0]!.n;
  const due=async(id:string)=>db.begin(async(tx)=> { await tx`ALTER TABLE payment_capture_job DISABLE TRIGGER payment_capture_job_guard`;
    await tx`UPDATE payment_capture_job SET run_after=clock_timestamp() WHERE intent_id=${id}`;await tx`ALTER TABLE payment_capture_job ENABLE TRIGGER payment_capture_job_guard`; });
  await t.test('exact money, configured expectation, immutable issuance and safe nullable expiry do not imply paid',async()=> {
    const option=(await api('GET','/api/leads/'+lead+'/payment-link-options',undefined,'agent')).json().items.find((m:{ id:string })=>m.id===method);assert.equal(option.preparationAvailable,true);
    const invalid=await api('POST',requests,{ requestId:randomUUID(),methodId:method,methodVersion:1,amount:'25.00',currency:'JPY' },'agent');assert.equal(invalid.statusCode,400);
    const guardId=await request();const invalidPolicy={ maxAttempts:5,retentionMs:43200000,dispatchBudgetMs:20000,retryBaseMs:2000,retryMaxMs:60000 };
    await assert.rejects(db`UPDATE payment_dispatch SET state='RUNNING',lease_token=${randomUUID()},lease_until=clock_timestamp()+interval '60 seconds',
      first_dispatch_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint,policy=${db.json(invalidPolicy)} WHERE intent_id=${guardId}`,/PAYMENT_ORDER_POLICY_INVALID/);
    await processOnePaymentDispatch(db);
    const o=await issued();const dto=await get(o);assert.equal(dto.expiresAt,null);assert.equal(dto.paymentState,null);assert.equal(dto.enrollmentId,null);
    assert.equal(dto.customerUrl,'https://www.sandbox.paypal.com/checkoutnow?token='+o.id);assert.equal(dto.captureAvailable,true);
    const i=(await db`SELECT * FROM payment_link_intent WHERE id=${o.intentId}`)[0]!;assert.equal(i.options_snapshot.beneficiaryVerification,'CONFIGURED_EXPECTATION');
    assert.equal(i.options_snapshot.chargesEnabled,undefined);assert.equal(i.options_snapshot.country,undefined);assert.equal(i.config_snapshot.expectedMerchantId,'ABCD234EFGH56');
    assert.equal(transport.orderKeys.at(-1),'lop-order:'+o.intentId);assert.equal(transport.captureKeys.length,0);
    assert.equal(openOpaque('payment-link:'+i.id,{ ciphertext:i.ciphertext,nonce:i.nonce,authTag:i.auth_tag,keyVersion:i.key_version }),JSON.stringify(pair));
    assert.equal((await capture(o,'second')).statusCode,404);assert.equal((await capture(o,'other')).statusCode,404);
    assert.equal((await api('POST',requests+'/'+o.intentId+'/capture',{ paid:true },'agent')).statusCode,400);
    assert.equal((await api('GET',requests+'/'+o.intentId+'/capture-attempts',undefined,'second')).statusCode,404);
    assert.equal(await countEnrollment(),0);
    // A signed approval, including customer claims, grants neither capture authorization nor money confirmation.
    o.status='APPROVED';assert.equal((await signed(o,'CHECKOUT.ORDER.APPROVED')).statusCode,200);await drain();
    assert.equal(await countEnrollment(),0);assert.equal(transport.captureKeys.length,0);
  });
  await t.test('unapproved order is rejected without financial write or enrollment',async()=> {
    const o=await issued();const before=transport.captureKeys.length;assert.equal((await capture(o)).statusCode,202);await processOnePaymentCapture(db);
    const dto=await get(o);assert.equal(dto.captureState,'BLOCKED');assert.equal(dto.captureError,'PAYMENT_APPROVAL_REQUIRED');assert.equal(dto.enrollmentId,null);
    assert.equal(transport.captureKeys.length,before);assert.equal((await api('GET',requests+'/'+o.intentId+'/capture-attempts',undefined,'agent')).json().items[0].error_code,'PAYMENT_APPROVAL_REQUIRED');
    o.status='APPROVED';assert.equal((await capture(o)).statusCode,202);await processOnePaymentCapture(db);assert.equal((await get(o)).captureState,'ACCEPTED');
    assert.equal(transport.captureKeys.length,before+1);assert.equal(await countEnrollment(),0);
  });
  await t.test('concurrent explicit capture requests and workers perform one capture; accepted response alone never enrolls',async()=> {
    const o=await issued();o.status='APPROVED';const responses=await Promise.all(Array.from({ length:8 },()=>capture(o)));
    assert.equal(responses.filter((r)=>r.statusCode===202).length,1);assert.equal(responses.filter((r)=>r.json().duplicate).length,7);
    let arrived!:()=>void;let release!:()=>void;const started=new Promise<void>((resolve)=>{ arrived=resolve; });const gate=new Promise<void>((resolve)=>{ release=resolve; });
    transport.setGate(async()=>{ arrived();await gate; });const before=transport.captureKeys.length;
    const running=processOnePaymentCapture(db);try { await Promise.race([started,running.then(()=>{ throw new Error('No capture claim'); })]);
      assert.deepEqual(await Promise.all(Array.from({ length:8 },()=>processOnePaymentCapture(db))),Array(8).fill(false));assert.equal(transport.captureKeys.length,before+1);
    }finally { release();await running;transport.setGate(null); }
    assert.equal(transport.captureKeys.at(-1),'lop-capture:'+o.intentId);assert.equal((await get(o)).captureState,'ACCEPTED');assert.equal((await get(o)).paymentState,null);
    assert.equal((await get(o)).customerUrl,null);assert.equal(await countEnrollment(),0);
    const policy=(await db`SELECT policy FROM payment_capture_job WHERE intent_id=${o.intentId}`)[0]!.policy;assert.equal(policy.retentionMs,21600000);assert.equal(policy.dispatchBudgetMs,30000);
    const eventId='WH-CONCURRENT-FINANCIAL123';const deliveries=await Promise.all(Array.from({ length:8 },()=>signed(o,undefined,eventId)));for(const r of deliveries)assert.equal(r.statusCode,200,r.body);assert.equal(deliveries.filter((r)=>!r.json().duplicate).length,1);
    await Promise.all(Array.from({ length:6 },()=>processOnePaymentReceipt(db)));assert.equal((await get(o)).paymentState,'CONFIRMED');assert.equal(await countEnrollment(),1);
    const p=(await db`SELECT f.* FROM payment_confirmation f JOIN payment_webhook_event e ON e.id=f.event_id WHERE e.external_event_id=${eventId}`)[0]!;
    assert.equal(p.session_id,o.id);assert.equal(p.provider_evidence.captureId,o.captureId);assert.equal(p.minor,'2500');assert.equal(p.payment_ref,o.captureId);
    assert.equal((await db`SELECT lifecycle FROM lead WHERE id=${lead}`)[0]!.lifecycle,'OPEN');
    o.captureStatus='PENDING';await signed(o,'PAYMENT.CAPTURE.PENDING');await drain();assert.equal((await get(o)).paymentState,'CONFIRMED');assert.equal(await countEnrollment(),1);
    for(const secret of [pair.clientSecret,'SyntheticFinancialAccessToken123','instructions','fixture PII'])assert.equal(JSON.stringify(await get(o)).includes(secret),false);
    await assert.rejects(db`UPDATE payment_confirmation SET provider_evidence=NULL WHERE event_id=${p.event_id}`,/PAYMENT_CONFIRMATION_IMMUTABLE/);
    await assert.rejects(db`UPDATE payment_capture_job SET request_key='lop-capture:'||${randomUUID()} WHERE intent_id=${o.intentId}`,/PAYMENT_CAPTURE_POLICY_IMMUTABLE/);
    await assert.rejects(db`DELETE FROM payment_capture_ack WHERE intent_id=${o.intentId}`,/PAYMENT_CAPTURE_ACK_IMMUTABLE/);
    await assert.rejects(db`DELETE FROM payment_capture_authorization WHERE intent_id=${o.intentId}`,/PAYMENT_CAPTURE_AUTHORIZATION_IMMUTABLE/);
  });
  await t.test('lost capture response recovers by independent order read with unchanged key/window and no second capture write',async()=> {
    const o=await issued();o.status='APPROVED';await capture(o);transport.setCaptureFailure('UNKNOWN');const before=transport.captureKeys.length;
    await processOnePaymentCapture(db);assert.equal((await get(o)).captureState,'RETRY');assert.equal(await countEnrollment(),1);
    const prior=(await db`SELECT first_dispatch_ms,policy,request_key FROM payment_capture_job WHERE intent_id=${o.intentId}`)[0]!;
    transport.setCaptureFailure('NONE');await due(o.intentId);await processOnePaymentCapture(db);assert.equal((await get(o)).captureState,'ACCEPTED');assert.equal(transport.captureKeys.length,before+1);
    assert.deepEqual((await db`SELECT first_dispatch_ms,policy,request_key FROM payment_capture_job WHERE intent_id=${o.intentId}`)[0],prior);
    const attempts=(await api('GET',requests+'/'+o.intentId+'/capture-attempts',undefined,'agent')).json().items;assert.deepEqual(attempts.map((a:{ state:string })=>a.state),['UNKNOWN','ACKNOWLEDGED']);
    assert.equal((await db`SELECT write_performed FROM payment_capture_ack WHERE intent_id=${o.intentId}`)[0]!.write_performed,false);
    await signed(o);await drain();assert.equal((await get(o)).paymentState,'CONFIRMED');assert.equal(await countEnrollment(),2);
  });
  await t.test('provider rate retries are bounded and never reset financial policy or enroll without proof',async()=> {
    const o=await issued();o.status='APPROVED';await capture(o);transport.setCaptureFailure('RATE');const before=transport.captureKeys.length;
    try { for(let n=0;n<5;n++) { await processOnePaymentCapture(db);if(n<4)await due(o.intentId); } }
    finally { transport.setCaptureFailure('NONE'); }
    assert.equal(transport.captureKeys.length,before+5);assert.equal((await get(o)).captureState,'FAILED');assert.equal((await get(o)).captureError,'PAYMENT_DISPATCH_ATTEMPTS_EXHAUSTED');
    const attempts=(await api('GET',requests+'/'+o.intentId+'/capture-attempts',undefined,'agent')).json().items;assert.equal(attempts.length,5);
    assert.equal((await capture(o)).json().duplicate,true);assert.equal(transport.captureKeys.length,before+5);assert.equal(await countEnrollment(),2);
    await assert.rejects(db`UPDATE payment_capture_job SET first_dispatch_ms=first_dispatch_ms+1 WHERE intent_id=${o.intentId}`,/PAYMENT_CAPTURE_POLICY_IMMUTABLE/);
    await assert.rejects(db`INSERT INTO payment_link_intent SELECT (jsonb_populate_record(NULL::payment_link_intent,to_jsonb(i)||
      jsonb_build_object('id',gen_random_uuid(),'request_id',gen_random_uuid(),'amount','25.0','minor','250','scale',1))).*
      FROM payment_link_intent i WHERE id=${o.intentId}`,/paypal_money_precision/);
  });
  await t.test('pending independent capture cannot enroll, invalid payee cannot confirm, and explicit read-only credential recovery retains audit',async()=> {
    const o=await issued();o.status='APPROVED';o.captureStatus='PENDING';await capture(o);await processOnePaymentCapture(db);
    const eventId='WH-PENDING-PROOF123';await signed(o,undefined,eventId);await drain();assert.equal((await get(o)).paymentState,'PENDING');assert.equal(await countEnrollment(),2);
    const pending=(await db`SELECT id FROM payment_record WHERE intent_id=${o.intentId}`)[0]!;
    await assert.rejects(db`INSERT INTO enrollment(lead_id,payment_id) VALUES (${lead},${pending.id})`,/ENROLLMENT_TRUSTED_PAYMENT_REQUIRED/);
    const expected=o.merchantId;o.merchantId='JKLM234NPQR56';o.captureStatus='COMPLETED';const mismatchId='WH-BENEFICIARY-MISMATCH123';await signed(o,undefined,mismatchId);await drain();
    const event=(await db`SELECT e.id,j.attempts,j.state,j.error_code FROM payment_webhook_event e JOIN payment_receipt_job j ON j.event_id=e.id WHERE e.external_event_id=${mismatchId}`)[0]!;
    assert.equal(event.state,'NEEDS_ATTENTION');assert.equal(event.error_code,'PAYMENT_SESSION_MISMATCH');assert.equal((await get(o)).paymentState,'PENDING');assert.equal(await countEnrollment(),2);
    const retry=cr+'/webhook-events/'+event.id+'/retry';assert.equal((await api('POST',retry,{ attempts:event.attempts,reason:'Unauthorized recovery denied',useCurrentCredentials:true,connectionVersion:1 },'agent')).statusCode,403);
    o.merchantId=expected;const recovered=await api('POST',retry,{ attempts:event.attempts,reason:'Verified expected beneficiary restored in synthetic provider',useCurrentCredentials:true,connectionVersion:1 });
    assert.equal(recovered.statusCode,200,recovered.body);await drain();assert.equal((await get(o)).paymentState,'CONFIRMED');assert.equal(await countEnrollment(),3);
    assert.equal((await db`SELECT count(*)::integer AS n FROM payment_receipt_credential WHERE event_id=${event.id}`)[0]!.n,1);
  });
  await t.test('reassignment fences a queued capture and only the current owner can explicitly reauthorize it',async()=> {
    const o=await issued();o.status='APPROVED';await capture(o);const before=transport.captureKeys.length;
    await db`UPDATE lead SET assigned_agent_id=${users.second!.id} WHERE id=${lead}`;await processOnePaymentCapture(db);
    assert.equal(transport.captureKeys.length,before);assert.equal((await db`SELECT state,error_code FROM payment_capture_job WHERE intent_id=${o.intentId}`)[0]!.state,'BLOCKED');
    assert.equal((await capture(o,'agent')).statusCode,404);assert.equal((await capture(o,'second')).statusCode,202);await processOnePaymentCapture(db);
    assert.equal(transport.captureKeys.length,before+1);assert.equal((await db`SELECT assigned_agent_id FROM payment_link_intent WHERE id=${o.intentId}`)[0]!.assigned_agent_id,users.agent!.id);
    assert.equal((await db`SELECT a.assigned_agent_id FROM payment_capture_authorization a JOIN payment_capture_job j ON j.authorization_id=a.id WHERE j.intent_id=${o.intentId}`)[0]!.assigned_agent_id,users.second!.id);
    await db`UPDATE lead SET assigned_agent_id=${users.agent!.id} WHERE id=${lead}`;assert.equal(await countEnrollment(),3);
  });
  await t.test('capture request audit failure rolls back authorization and queue atomically',async()=> {
    const o=await issued();o.status='APPROVED';
    await db`CREATE FUNCTION synthetic_capture_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_CAPTURE_REQUESTED' THEN RAISE EXCEPTION 'synthetic rollback' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`;
    await db`CREATE TRIGGER synthetic_capture_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_capture_audit_failure()`;
    try { assert.equal((await capture(o)).statusCode,500);assert.equal((await db`SELECT count(*)::integer AS n FROM payment_capture_job WHERE intent_id=${o.intentId}`)[0]!.n,0);
      assert.equal((await db`SELECT count(*)::integer AS n FROM payment_capture_authorization WHERE intent_id=${o.intentId}`)[0]!.n,0);
    }finally { await db`DROP TRIGGER synthetic_capture_audit_failure ON audit_log`;await db`DROP FUNCTION synthetic_capture_audit_failure()`; }
    assert.equal((await capture(o)).statusCode,202);await processOnePaymentCapture(db);assert.equal((await get(o)).captureState,'ACCEPTED');assert.equal(await countEnrollment(),3);
  });
  await t.test('current session denial blocks queued capture; explicit current user recovery preserves authorization history',async()=> {
    const o=await issued();o.status='APPROVED';await capture(o);const before=transport.captureKeys.length;
    await db`UPDATE user_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${users.agent!.session}`;
    await processOnePaymentCapture(db);assert.equal(transport.captureKeys.length,before);assert.equal((await db`SELECT state FROM payment_capture_job WHERE intent_id=${o.intentId}`)[0]!.state,'BLOCKED');
    assert.equal((await api('POST',requests+'/'+o.intentId+'/capture',{},'manager')).statusCode,202);
    assert.equal((await db`SELECT count(*)::integer AS n FROM payment_capture_authorization WHERE intent_id=${o.intentId}`)[0]!.n,2);
    await processOnePaymentCapture(db);assert.equal(transport.captureKeys.length,before+1);
    await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=${users.agent!.session}`;
    // Historical confirmation remains possible after original requester revocation and connection disablement.
    await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.agent!.session}`;
    const c=(await api('GET',cr)).json();assert.equal((await api('POST',cr+'/disable',{ version:c.version,reason:'Disable after existing capture' })).statusCode,200);
    await signed(o);await drain();const p=(await db`SELECT state FROM payment_record WHERE intent_id=${o.intentId}`)[0]!;assert.equal(p.state,'CONFIRMED');assert.equal(await countEnrollment(),4);
    await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.agent!.session}`;
  });
});
