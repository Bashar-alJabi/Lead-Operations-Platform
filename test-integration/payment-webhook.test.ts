import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { openOpaque } from '../src/credentials.js';
import { PaymentProviderError,stripePaymentEvents } from '../src/payments/providers.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('Payment webhooks enforce current setup scope, immutable encrypted identities, signed durable receipts, global dedup and fenced provider probes without claiming paid',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);let behavior:'OK'|'WAIT'|'FAIL'|'WRONG_URL'='OK';let calls=0;const pending:(()=>void)[]=[];
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,paymentConnectionAdapters:{ STRIPE:{ verify:async(config)=>({ mode:config.mode }),
    inspectWebhook:async(config,_credentials,id)=> { calls++;const current=behavior;if(current==='WAIT')await new Promise<void>((resolve)=>pending.push(resolve));
      if(current==='FAIL')throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');
      const w=(await db`SELECT callback_url FROM payment_webhook WHERE external_endpoint_id=${id} ORDER BY created_at DESC LIMIT 1`)[0]!;
      return { mode:config.mode,endpointId:id,url:current==='WRONG_URL' ? 'https://wrong.test' : w.callback_url,enabled:true,enabledEvents:[...stripePaymentEvents],private:'not-returned' }; },
  } } });t.after(async()=>{ pending.forEach((release)=>release());await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Webhook') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const branchB=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const otherOrg=(await db`INSERT INTO organization(name) VALUES ('Other') RETURNING id`)[0]!.id;
  const foreignBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${otherOrg},'Elsewhere') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope,tenant] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',branchB,org],['agent','AGENT',branch,org],['foreign','MANAGER',foreignBranch,otherOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${tenant},${scope},${name},${role},${name+'@webhook.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at)
      VALUES (${id},${sha256(token)},now()-interval '1 hour',now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={ id,cookie:'lop_session='+token,session };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.7.${ip++}` });
  const key='rk_test_'+'SyntheticWebhookKey'.repeat(3);const secret='whsec_'+'SyntheticSigningOnly'.repeat(3);
  const input={ name:'Payment <img src=x>',provider:'STRIPE',config:{ mode:'TEST' },credentials:{ apiKey:key } };
  const base='/api/payments/connections';const connection=(await api('POST',base,input)).json().id;const root=base+'/'+connection;
  const shared=(await api('POST',base,{ ...input,name:'Shared webhook',branchId:null },'admin')).json().id;
  const sharedRow=await api('POST',base+'/'+shared+'/webhooks',{ connectionVersion:1,reason:'Root prepares shared account' },'admin');assert.equal(sharedRow.statusCode,201);
  assert.equal((await api('GET',base+'/'+shared+'/webhooks')).statusCode,404);
  assert.equal((await api('GET',base+'/'+shared+'/webhooks/'+sharedRow.json().id)).statusCode,404);
  const prepare=(connectionVersion=1,actor='manager')=>api('POST',root+'/webhooks',{ connectionVersion,reason:'Prepare owned account callback' },actor);
  assert.equal((await prepare(1,'agent')).statusCode,403);assert.equal((await prepare(1,'other')).statusCode,404);assert.equal((await prepare(1,'foreign')).statusCode,404);
  assert.equal((await prepare(2)).statusCode,409);const w=(await prepare()).json();assert.equal(w.state,'DRAFT');assert.equal(w.financialProcessingReady,false);
  assert.equal(w.publicHttps,false);assert.equal(w.callback_url,process.env.APP_ORIGIN+'/api/webhooks/payments/stripe/'+w.id);
  const webhook=root+'/webhooks/'+w.id;const endpointId='we_SyntheticWebhook123';
  const setup={ version:1,endpointId,signingSecret:secret,reason:'Register exact snapshot destination' };
  assert.equal((await api('POST',webhook+'/configure',{ ...setup,signingSecret:'bad' })).statusCode,400);
  const configured=await Promise.all([api('POST',webhook+'/configure',setup),api('POST',webhook+'/configure',setup)]);
  assert.deepEqual(configured.map((r)=>r.statusCode).sort(),[200,409]);assert.equal(configured.some((r)=>r.body.includes(secret)),false);
  const sealed=(await db`SELECT * FROM payment_webhook WHERE id=${w.id}`)[0]!;assert.equal(sealed.ciphertext.toString().includes(secret),false);
  assert.equal(openOpaque('payment-webhook:'+w.id,{ ciphertext:sealed.ciphertext,nonce:sealed.nonce,authTag:sealed.auth_tag,keyVersion:sealed.key_version }),secret);
  assert.equal((await api('POST',webhook+'/configure',{ ...setup,version:2 })).statusCode,409);
  const probe=()=>api('POST',webhook+'/test',{ version:2,connectionVersion:1 });
  assert.equal((await probe()).json().state,'VERIFIED');let detail=(await api('GET',webhook)).json();assert.equal(detail.endpointVerified,true);assert.equal(detail.signedDeliveryVerified,false);assert.equal(detail.webhookReady,false);
  behavior='WRONG_URL';assert.equal((await probe()).json().error,'PAYMENT_WEBHOOK_ENDPOINT_MISMATCH');assert.equal((await api('GET',webhook)).json().endpointVerified,false);behavior='OK';assert.equal((await probe()).statusCode,200);
  const event=(id='evt_SyntheticFirst123',extra:object={})=>({ id,object:'event',type:'checkout.session.completed',livemode:false,created:1234567890,
    data:{ object:{ id:'cs_test_Synthetic123',object:'checkout.session',payment_status:'unpaid',amount_total:1250,currency:'usd',customer_email:'private-customer@example.test' } },...extra });
  const send=(value:object|string,id=w.id,signedBy=secret,timestamp=Math.floor(Date.now()/1000),signature?:string)=> {
    const payload=typeof value==='string' ? value : JSON.stringify(value);const signatureValue=signature ?? `t=${timestamp},v1=${createHmac('sha256',signedBy).update(timestamp+'.').update(payload).digest('hex')}`;
    return app.inject({ method:'POST',url:'/api/webhooks/payments/stripe/'+id,payload,headers:{ 'content-type':'application/json','stripe-signature':signatureValue },remoteAddress:`127.0.8.${ip++}` });
  };
  assert.equal((await send(event(),w.id,secret+'wrong')).statusCode,403);assert.equal((await send(event(),w.id,secret,Math.floor(Date.now()/1000)-301)).statusCode,403);
  assert.equal((await send(event(),w.id,secret,Math.floor(Date.now()/1000)+301)).statusCode,403);
  assert.equal((await send(event('evt_ModeInvalid123',{ livemode:true }))).statusCode,400);assert.equal((await send(event('evt_ScopeInvalid123',{ account:'acct_elsewhere' }))).statusCode,400);
  assert.equal((await send('{bad}')).statusCode,400);assert.equal((await send('x'.repeat(65537))).statusCode,413);
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_webhook_event`)[0]!.n,0);
  const incoming=await Promise.all(Array.from({ length:8 },()=>send(event())));assert.deepEqual(incoming.map((r)=>r.statusCode),Array(8).fill(200));assert.equal(incoming.filter((r)=>!r.json().duplicate).length,1);
  detail=(await api('GET',webhook)).json();assert.equal(detail.webhookReady,true);assert.equal(detail.financialProcessingReady,true);
  const original=(await db`SELECT * FROM payment_webhook_event`)[0]!;assert.equal(original.ciphertext.toString().includes('private-customer'),false);
  const decoded=openOpaque('payment-event:'+original.id,{ ciphertext:original.ciphertext,nonce:original.nonce,authTag:original.auth_tag,keyVersion:original.key_version });assert.equal(JSON.parse(decoded).data.object.payment_status,'unpaid');
  const replay={ ...event(),pending_webhooks:99 };assert.equal((await send(JSON.stringify(replay,null,2))).json().duplicate,true);
  assert.equal((await send(event('evt_SyntheticFirst123',{ data:{ object:{ ...event().data.object,amount_total:9999 } } }))).statusCode,409);
  const row2=(await prepare()).json();const secret2='whsec_'+'SyntheticReplacement'.repeat(3);
  assert.equal((await api('POST',root+'/webhooks/'+row2.id+'/configure',{ ...setup,endpointId:'we_SyntheticSecond123',signingSecret:secret2 })).statusCode,200);
  assert.equal((await send(event(),row2.id,secret)).statusCode,403);assert.equal((await send(event(),row2.id,secret2)).json().duplicate,true);
  assert.equal((await api('GET',root+'/webhooks/'+row2.id)).json().signedDeliveryVerified,true);
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_webhook_event`)[0]!.n,1);assert.equal((await db`SELECT count(*)::integer AS n FROM payment_webhook_delivery`)[0]!.n,2);
  for(const action of [db`UPDATE payment_webhook_event SET event_type='checkout.session.expired' WHERE id=${original.id}`,db`DELETE FROM payment_webhook_delivery WHERE event_id=${original.id}`,
    db`UPDATE payment_webhook SET ciphertext=${Buffer.from('changed')} WHERE id=${w.id}`,db`UPDATE payment_webhook SET last_signed_at=clock_timestamp()+interval '1 hour' WHERE id=${w.id}`])await assert.rejects(action);
  const list=(await api('GET',root+'/webhook-events?limit=1')).json();assert.equal(list.items[0].state,'QUEUED');assert.equal(JSON.stringify(list).includes('private-customer'),false);
  assert.equal(JSON.stringify(list).includes('amount_total'),false);assert.equal((await api('GET',root+'/webhook-events',undefined,'agent')).statusCode,403);
  assert.equal((await api('GET',webhook,undefined,'other')).statusCode,404);assert.equal((await api('GET',webhook,undefined,'foreign')).statusCode,404);
  const page=(await api('GET',root+'/webhooks?limit=1')).json();assert.ok(page.nextCursor);assert.equal((await api('GET',root+'/webhooks?limit=1&cursor='+encodeURIComponent(page.nextCursor))).json().items.length,1);
  const hist=(await api('GET',webhook+'/history?limit=1')).json();assert.ok(hist.nextCursor);assert.equal((await api('GET',webhook+'/history?limit=1&cursor='+encodeURIComponent(hist.nextCursor))).json().items.length,1);
  assert.equal(JSON.stringify(hist).includes(secret),false);assert.equal(JSON.stringify(hist).includes('not-returned'),false);
  await db`CREATE FUNCTION synthetic_payment_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_WEBHOOK_RECEIVED' THEN RAISE EXCEPTION 'synthetic receipt rollback' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`;
  await db`CREATE TRIGGER synthetic_payment_receipt_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_payment_receipt_failure()`;
  try { assert.equal((await send(event('evt_RollbackSynthetic123'))).statusCode,500);assert.equal((await db`SELECT count(*)::integer AS n FROM payment_webhook_event`)[0]!.n,1); }
  finally { await db`DROP TRIGGER synthetic_payment_receipt_failure ON audit_log`;await db`DROP FUNCTION synthetic_payment_receipt_failure()`; }
  assert.equal((await send(event('evt_RollbackSynthetic123'))).statusCode,200);
  const startWait=async()=>{ behavior='WAIT';const promise=probe();for(let n=0;n<100 && pending.length===0;n++)await delay(5);assert.ok(pending.length);return { promise }; };
  const old=await startWait();behavior='FAIL';assert.equal((await probe()).statusCode,502);pending.shift()!();assert.equal((await old.promise).json().state,'SUPERSEDED');assert.equal((await api('GET',webhook)).json().endpointVerified,false);
  behavior='OK';assert.equal((await probe()).statusCode,200);
  const revoked=await startWait();await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;pending.shift()!();assert.equal((await revoked.promise).statusCode,403);
  await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.manager!.session}`;
  const expired=await startWait();await db`UPDATE user_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${users.manager!.session}`;pending.shift()!();assert.equal((await expired.promise).statusCode,403);
  await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=${users.manager!.session}`;
  const disabledUser=await startWait();await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;pending.shift()!();assert.equal((await disabledUser.promise).statusCode,403);
  await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;
  behavior='OK';const realNow=Date.now;const skew=t.mock.method(Date,'now',()=>realNow()+60000);
  try { assert.equal((await probe()).json().state,'VERIFIED'); }finally{ skew.mock.restore(); }
  const receiptSkew=t.mock.method(Date,'now',()=>realNow()+600000);
  try { assert.equal((await send(event('evt_ClockSkewSynthetic123'),w.id,secret,Math.floor(realNow()/1000))).statusCode,200); }finally{ receiptSkew.mock.restore(); }
  await db`CREATE FUNCTION synthetic_webhook_short_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.expires_at=clock_timestamp()+interval '100 milliseconds'; RETURN NEW; END $$`;
  await db`CREATE TRIGGER zz_synthetic_webhook_lease BEFORE INSERT ON payment_webhook_probe FOR EACH ROW EXECUTE FUNCTION synthetic_webhook_short_lease()`;
  try { const ttl=await startWait();await delay(200);pending.shift()!();assert.equal((await ttl.promise).json().state,'SUPERSEDED'); }
  finally { await db`DROP TRIGGER zz_synthetic_webhook_lease ON payment_webhook_probe`;await db`DROP FUNCTION synthetic_webhook_short_lease()`; }
  const changed=await startWait();assert.equal((await api('PUT',root,{ ...input,name:'Rotated account key',version:1 })).statusCode,200);pending.shift()!();assert.equal((await changed.promise).json().state,'SUPERSEDED');
  assert.equal((await api('GET',webhook)).json().current,false);const before=calls;assert.equal((await probe()).statusCode,409);assert.equal(calls,before);
  // A disabled Connection/Branch still retains authentic old callback receipts. Outbound work remains blocked.
  assert.equal((await api('POST',root+'/disable',{ version:2,reason:'Stop new financial requests' })).statusCode,200);await db`UPDATE branch SET active=false WHERE id=${branch}`;
  assert.equal((await send(event('evt_HistoricalAfterDisable123'))).statusCode,200);assert.equal((await api('GET',webhook)).json().webhookReady,false);
  assert.equal((await api('POST',webhook+'/disable',{ version:2,reason:'Reconciled pending payments and stopped this endpoint' })).statusCode,200);
  assert.equal((await send(event('evt_AfterEndpointDisable123'))).statusCode,409);assert.equal((await api('GET',webhook)).json().last_signed_at!==null,true);
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_webhook_event`)[0]!.n,4);
  const audits=await db`SELECT detail FROM audit_log WHERE action LIKE 'PAYMENT_WEBHOOK_%'`;assert.equal(JSON.stringify(audits).includes(secret),false);assert.equal(JSON.stringify(audits).includes('private-customer'),false);
  assert.equal((await api('GET','/api/branches')).statusCode,200);
});
