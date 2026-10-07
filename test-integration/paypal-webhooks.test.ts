import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/security.js';
import { openOpaque,sealOpaque } from '../src/credentials.js';
import { paypalPaymentEvents } from '../src/payments/webhook-profile.js';
import { processOnePaymentReceipt } from '../src/payments/confirmation-worker.js';
import { testPayPalCertificate,testPayPalHeaders,testPayPalEvent,testPayPalCertUrl } from '../test/paypal-test-support.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('PayPal actual OAuth webhook inspection and RSA receiver preserve scope, current probes, encrypted immutable receipts and duplicate-safe history without financial claims',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  let behavior:'OK'|'FAIL'|'WAIT'|'WRONG_URL'|'MISSING'='OK';let reads=0;let certificateReads=0;let waitCertificate=false;const pending:(()=>void)[]=[];
  const pair={ clientId:'IntegrationWebhookClient_123456',clientSecret:'IntegrationWebhookSecret_123456' };
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> {
    assert.equal(init.redirect,'error');assert.ok(init.signal);
    if(target.startsWith('https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-INTEGRATION')) {
      certificateReads++;if(waitCertificate)await new Promise<void>((resolve)=>pending.push(resolve));return new Response(testPayPalCertificate);
    }
    if(target==='https://api-m.sandbox.paypal.com/v1/oauth2/token') {
      assert.equal(init.method,'POST');assert.equal(init.body,'grant_type=client_credentials');
      assert.equal((init.headers as Record<string,string>).authorization,'Basic '+Buffer.from(pair.clientId+':'+pair.clientSecret).toString('base64'));
      return new Response(JSON.stringify({ access_token:'SyntheticWebhookAccessToken123',token_type:'Bearer',expires_in:3600,app_id:'APP-Synthetic123' }));
    }
    assert.match(target,/^https:\/\/api-m\.sandbox\.paypal\.com\/v1\/notifications\/webhooks\/[A-Z0-9]+$/);assert.equal(init.method,'GET');
    reads++;const mode=behavior;if(mode==='WAIT')await new Promise<void>((resolve)=>pending.push(resolve));
    if(mode==='FAIL')return new Response(pair.clientSecret,{ status:401 });
    const id=target.split('/').at(-1)!;const row=(await db`SELECT callback_url FROM payment_webhook WHERE external_endpoint_id=${id} ORDER BY created_at DESC LIMIT 1`)[0]!;
    return new Response(JSON.stringify({ id,url:mode==='WRONG_URL' ? 'https://wrong.test' : row.callback_url,
      event_types:(mode==='MISSING' ? ['PAYMENT.CAPTURE.COMPLETED'] : paypalPaymentEvents).map((name)=>({ name,status:'ENABLED' })),private:'discarded' }));
  });
  t.after(async()=>{ pending.forEach((release)=>release());await db`DROP TRIGGER IF EXISTS reject_paypal_receipt_audit ON audit_log`;await db`DROP FUNCTION IF EXISTS reject_paypal_receipt_audit()`;await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('PayPal callbacks') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['other','MANAGER',otherBranch],['agent','AGENT',branch]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${org},${scope},${name},${role},${name+'@paypal-webhook.test'},'synthetic') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name]={ id,cookie:'lop_session='+token,session };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor='manager')=>app.inject({ method,url:path,payload,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.19.${ip++}` });
  const input={ name:'PayPal Webhook <img literal>',provider:'PAYPAL',config:{ mode:'TEST' },credentials:pair };
  const made=await api('POST','/api/payments/connections',input);assert.equal(made.statusCode,201,made.body);const id=made.json().id;const root='/api/payments/connections/'+id;
  for(const actor of ['agent','other'])assert.equal((await api('POST',root+'/webhooks',{ connectionVersion:1,reason:'Unauthorized setup' },actor)).statusCode,actor==='agent' ? 403 : 404);
  const create=async(endpointId:string)=> {
    const prepared=await api('POST',root+'/webhooks',{ connectionVersion:1,reason:'Register exact PayPal app callback' });assert.equal(prepared.statusCode,201,prepared.body);const w=prepared.json();
    assert.match(w.callback_url,/\/api\/webhooks\/payments\/paypal\//);assert.equal(w.endpointVerified,false);assert.equal(w.signedDeliveryVerified,false);assert.equal(w.financialProcessingReady,false);
    for(const payload of [{ version:1,endpointId:'we_StripeWrong123',reason:'Reject foreign profile' },{ version:1,endpointId,signingSecret:'whsec_'+'SyntheticOnly'.repeat(3),reason:'No PayPal private signing secret' }])
      assert.equal((await api('POST',root+'/webhooks/'+w.id+'/configure',payload)).statusCode,400);
    const configured=await api('POST',root+'/webhooks/'+w.id+'/configure',{ version:1,endpointId,reason:'Register app identity' });assert.equal(configured.statusCode,200,configured.body);
    assert.equal(configured.json().secret_configured,false);assert.equal(configured.json().financialProcessingReady,false);
    assert.equal((await api('POST',root+'/webhooks/'+w.id+'/configure',{ version:2,endpointId,reason:'Do not mutate original identity' })).statusCode,409);
    return { id:w.id,path:root+'/webhooks/'+w.id,callback:new URL(w.callback_url).pathname,endpointId };
  };
  const a=await create('INTEGRATIONWEBHOOK123');const b=await create('INTEGRATIONWEBHOOK456');
  const stripe=await api('POST','/api/payments/connections',{ ...input,provider:'STRIPE',credentials:{ apiKey:'rk_test_'+'SyntheticStripeOnly'.repeat(2) } });assert.equal(stripe.statusCode,201);
  const stripeDraft=await api('POST','/api/payments/connections/'+stripe.json().id+'/webhooks',{ connectionVersion:1,reason:'Retain strict encrypted secret shape' });assert.equal(stripeDraft.statusCode,201);
  const sealed=sealOpaque('payment-webhook:'+stripeDraft.json().id,'whsec_'+'SyntheticStripeOnly'.repeat(2));
  await assert.rejects(db`UPDATE payment_webhook SET state='CONFIGURED',version=version+1,external_endpoint_id='we_NullVersionOnly123',ciphertext=${sealed.ciphertext},nonce=${sealed.nonce},auth_tag=${sealed.authTag},key_version=NULL WHERE id=${stripeDraft.json().id}`,/payment_webhook_secret_shape_check/);
  const probe=()=>api('POST',a.path+'/test',{ version:2,connectionVersion:1 });
  assert.equal((await probe()).statusCode,200);assert.equal((await api('GET',a.path)).json().endpointVerified,true);assert.equal((await api('GET',a.path)).json().webhookReady,false);
  behavior='WRONG_URL';assert.equal((await probe()).json().error,'PAYMENT_WEBHOOK_ENDPOINT_MISMATCH');behavior='MISSING';assert.equal((await probe()).json().error,'PAYMENT_WEBHOOK_EVENTS_MISSING');
  behavior='WAIT';const late=probe();for(let n=0;n<100&&Number(pending.length)===0;n++)await delay(5);assert.equal(Number(pending.length),1);
  behavior='FAIL';assert.equal((await probe()).json().error,'PAYMENT_PROVIDER_AUTH_FAILED');pending.shift()!();assert.equal((await late).json().state,'SUPERSEDED');
  behavior='OK';assert.equal((await probe()).statusCode,200);
  const clock=async()=>(await db`SELECT extract(epoch FROM clock_timestamp())::double precision AS seconds`)[0]!.seconds as number;
  const signed=async(w:typeof a,event:ReturnType<typeof testPayPalEvent>,suffix='')=> {
    const raw=Buffer.from(JSON.stringify(event,null,2));const headers=testPayPalHeaders(raw,w.endpointId,new Date((await clock())*1000).toISOString(),testPayPalCertUrl.replace('CERT-SYNTHETIC-ONLY','CERT-INTEGRATION'+suffix));
    return { raw,headers,send:()=>app.inject({ method:'POST',url:w.callback,payload:raw,headers }) };
  };
  const event=testPayPalEvent('WH-INTEGRATION-COMPLETED123');const first=await signed(a,event);
  assert.equal((await app.inject({ method:'POST',url:a.callback,payload:first.raw,headers:{ 'content-type':'application/json' } })).statusCode,403);assert.equal(certificateReads,0);
  assert.equal((await app.inject({ method:'POST',url:a.callback,payload:first.raw,headers:{ ...first.headers,'paypal-cert-url':'http://127.0.0.1/private' } })).statusCode,403);assert.equal(certificateReads,0);
  assert.equal((await app.inject({ method:'POST',url:a.callback,payload:Buffer.from(JSON.stringify({ ...event,summary:'changed raw bytes' })),headers:first.headers })).statusCode,403);
  const results=await Promise.all(Array.from({ length:8 },()=>first.send()));assert.ok(results.every((r)=>r.statusCode===200));assert.equal(results.filter((r)=>!r.json().duplicate).length,1);
  assert.equal(certificateReads,1);assert.equal((await (await signed(b,event)).send()).json().duplicate,true);
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_webhook_event`)[0]!.n,1);assert.equal((await db`SELECT count(*)::integer AS n FROM payment_webhook_delivery`)[0]!.n,2);
  const detail=(await api('GET',a.path)).json();assert.equal(detail.signedDeliveryVerified,true);assert.equal(detail.webhookReady,true);assert.equal(detail.financialProcessingReady,false);
  assert.equal((await api('GET',root)).json().capabilities.paymentLinksReady,undefined);
  const stored=(await db`SELECT * FROM payment_webhook_event`)[0]!;assert.equal(openOpaque('payment-event:'+stored.id,{ ciphertext:stored.ciphertext,nonce:stored.nonce,authTag:stored.auth_tag,keyVersion:stored.key_version }),first.raw.toString());
  const conflict=await signed(a,{ ...event,resource:{ ...event.resource,amount:{ value:'99.00',currency_code:'USD' } } });assert.equal((await conflict.send()).statusCode,409);
  const second=await signed(a,testPayPalEvent('WH-INTEGRATION-NEXT123'));assert.equal((await second.send()).statusCode,200);
  const events=(await api('GET',root+'/webhook-events?limit=1')).json();assert.equal(events.items.length,1);assert.ok(events.nextCursor);
  assert.notEqual((await api('GET',root+'/webhook-events?limit=1&cursor='+encodeURIComponent(events.nextCursor))).json().items[0].id,events.items[0].id);
  assert.ok((await api('GET',a.path+'/history?limit=1')).json().nextCursor);
  await db`CREATE FUNCTION reject_paypal_receipt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_WEBHOOK_RECEIVED' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`;
  await db`CREATE TRIGGER reject_paypal_receipt_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_paypal_receipt_audit()`;
  const rollback=await signed(a,testPayPalEvent('WH-INTEGRATION-ROLLBACK123'));assert.equal((await rollback.send()).statusCode,500);assert.equal((await db`SELECT count(*)::integer AS n FROM payment_webhook_event`)[0]!.n,2);
  await db`DROP TRIGGER reject_paypal_receipt_audit ON audit_log`;await db`DROP FUNCTION reject_paypal_receipt_audit()`;assert.equal((await rollback.send()).statusCode,200);
  // Disable while certificate I/O is in flight: no SQL locks held and no late receipt stored.
  waitCertificate=true;const interrupted=await signed(b,testPayPalEvent('WH-INTEGRATION-INTERRUPTED123'),'-WAIT');const inflight=interrupted.send();
  for(let n=0;n<100&&Number(pending.length)===0;n++)await delay(5);assert.equal(Number(pending.length),1);
  assert.equal((await api('POST',b.path+'/disable',{ version:2,reason:'Stop delivery while verification waits' })).statusCode,200);pending.shift()!();assert.equal((await inflight).statusCode,409);waitCertificate=false;
  assert.equal((await first.send()).statusCode,200);
  const rotate=await api('PUT',root,{ ...input,name:'Rotated connection snapshot',version:1 });assert.equal(rotate.statusCode,200,rotate.body);
  assert.equal((await api('POST',a.path+'/test',{ version:2,connectionVersion:2 })).statusCode,409);
  assert.equal((await api('POST',root+'/disable',{ version:2,reason:'Historical receipts remain valid' })).statusCode,200);
  assert.equal((await (await signed(a,testPayPalEvent('WH-INTEGRATION-HISTORICAL123'))).send()).statusCode,200);
  while(await processOnePaymentReceipt(db)) {};
  assert.ok((await db`SELECT state,error_code,attempts FROM payment_receipt_job`).every((j)=>j.state==='NEEDS_ATTENTION' && j.error_code==='PAYMENT_RECEIPT_PROFILE_UNSUPPORTED' && j.attempts===0));
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_record`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM enrollment`)[0]!.n,0);
  const safe=JSON.stringify([(await api('GET',a.path)).json(),(await api('GET',a.path+'/history')).json(),(await api('GET',root+'/webhook-events')).json(),await db`SELECT detail FROM audit_log WHERE action LIKE 'PAYMENT_%'`]);
  for(const secret of [pair.clientSecret,'SyntheticWebhookAccessToken123','private-buyer@fixture.test'])assert.equal(safe.includes(secret),false);
  await assert.rejects(db`UPDATE payment_webhook SET external_endpoint_id='OTHERWEBHOOK123' WHERE id=${a.id}`,/PAYMENT_WEBHOOK_/);
  await assert.rejects(db`UPDATE payment_webhook_event SET event_type='PAYMENT.CAPTURE.PENDING' WHERE id=${stored.id}`,/PAYMENT_WEBHOOK_EVENT_IMMUTABLE/);
  await assert.rejects(db`INSERT INTO payment_webhook_event(id,webhook_id,connection_id,mode,external_event_id,event_type,object_id,object_type,provider_created_at,semantic_hash,ciphertext,nonce,auth_tag,key_version)
    SELECT gen_random_uuid(),webhook_id,connection_id,mode,'evt_ForeignProfile123','checkout.session.completed',object_id,object_type,provider_created_at,semantic_hash,ciphertext,nonce,auth_tag,key_version FROM payment_webhook_event WHERE id=${stored.id}`,/PAYMENT_WEBHOOK_EVENT_PROFILE_INVALID/);
  assert.ok(reads>=6);
});
