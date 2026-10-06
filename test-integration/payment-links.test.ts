import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac,randomBytes,randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { openOpaque } from '../src/credentials.js';
import { sha256 } from '../src/security.js';
import { PaymentProviderError } from '../src/payments/providers.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Immutable Lead payment requests enforce current authorization, exact money, safe history and concurrency without financial dispatch',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);let providerCalls=0;let webhookFailure=false;
  const options={ accountRef:'acct_RequestSynthetic123',country:'US',defaultCurrency:'USD',currencies:['EUR','USD'],paymentMethods:['card'],chargesEnabled:true,cardPayments:'ACTIVE' as const };
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,paymentConnectionAdapters:{ STRIPE:{ verify:async(config)=>{ providerCalls++;return { mode:config.mode }; },
    inspect:async(config)=>{ providerCalls++;return { mode:config.mode,options }; },inspectWebhook:async(config,_secret,id)=> {
      providerCalls++;if(webhookFailure)throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');
      const w=(await db`SELECT callback_url FROM payment_webhook WHERE external_endpoint_id=${id}`)[0]!;
      return { mode:config.mode,endpointId:id,url:w.callback_url,enabled:true,enabledEvents:['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'] };
    } } } });t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Requests') RETURNING id`)[0]!.id;
  const foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Foreign') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const branchB=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope,userOrg] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',branchB,org],
    ['agent','AGENT',branch,org],['agent2','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash)
      VALUES (${userOrg},${scope},${name},${role},${name+'@requests.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at)
      VALUES (${id},${sha256(token)},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name]={ id,cookie:'lop_session='+token,session };
  }
  const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'One') RETURNING id`)[0]!.id;
  const campaign2=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'Two') RETURNING id`)[0]!.id;
  // Optional Contact is intentional; this internal financial request must not fabricate Customer identity.
  const lead=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind) VALUES (${org},${branch},${campaign},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id;
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.9.${ip++%240+1}` });
  const key='rk_test_'+'SyntheticOnly'.repeat(3);const connInput={ name:'Account',provider:'STRIPE',config:{ mode:'TEST' },credentials:{ apiKey:key } };
  const connection=(await api('POST','/api/payments/connections',connInput)).json().id;const connectionRoot='/api/payments/connections/'+connection;
  const methodInput={ name:'Tuition <img src=x>',branchId:branch,connectionId:connection,currencies:['USD','EUR'],active:true,
    agents:{ mode:'SELECTED',ids:[users.agent!.id] },campaigns:{ mode:'SELECTED',ids:[campaign] },reason:'Approved request availability' };
  const method=(await api('POST','/api/payments/methods',methodInput)).json().id;
  const root='/api/leads/'+lead;const requests=root+'/payment-link-requests';const methods=root+'/payment-link-options';
  const body=()=>({ requestId:randomUUID(),methodId:method,methodVersion:1,amount:'12.5',currency:'USD' });
  assert.equal((await api('GET',methods,undefined,'agent2')).statusCode,404);assert.equal((await api('GET',requests,undefined,'other')).statusCode,404);
  assert.equal((await api('POST',requests,body(),'foreign')).statusCode,404);
  assert.equal((await api('POST',requests,body(),'agent')).json().error,'PAYMENT_AUTHENTICATION_REQUIRED');
  assert.equal((await api('POST',connectionRoot+'/test',{ version:1,inspectOptions:true })).statusCode,200);
  assert.equal((await api('POST',requests,body(),'agent')).json().error,'PAYMENT_WEBHOOK_VERIFICATION_REQUIRED');
  const webhook=(await api('POST',connectionRoot+'/webhooks',{ connectionVersion:1,reason:'Prepare exact payment callback' })).json();
  const secret='whsec_'+'SyntheticOnly'.repeat(3);const wr=connectionRoot+'/webhooks/'+webhook.id;
  assert.equal((await api('POST',wr+'/configure',{ version:1,endpointId:'we_RequestSynthetic123',signingSecret:secret,reason:'Register endpoint and key' })).statusCode,200);
  assert.equal((await api('POST',wr+'/test',{ version:2,connectionVersion:1 })).statusCode,200);
  assert.equal((await api('POST',requests,body(),'agent')).json().error,'PAYMENT_WEBHOOK_VERIFICATION_REQUIRED');
  const raw=JSON.stringify({ id:'evt_RequestProbe123',object:'event',type:'checkout.session.expired',livemode:false,created:1234567890,
    data:{ object:{ id:'cs_test_RequestProbe123',object:'checkout.session' } } });
  const now=(await db`SELECT extract(epoch FROM clock_timestamp())::bigint AS n`)[0]!.n;
  const signature=`t=${now},v1=${createHmac('sha256',secret).update(now+'.').update(raw).digest('hex')}`;
  assert.equal((await app.inject({ method:'POST',url:new URL(webhook.callback_url).pathname,payload:raw,headers:{ 'content-type':'application/json','stripe-signature':signature } })).statusCode,200);
  const ready=(await api('GET',methods,undefined,'agent')).json();assert.equal(ready.items[0].preparationAvailable,true);
  for(const hidden of ['connection_id','accountRef','apiKey',key,secret])assert.equal(JSON.stringify(ready).includes(hidden),false);
  for(const amount of ['0','-1','1e3','01.2','12.501','12,50',' 12.5'])assert.equal((await api('POST',requests,{ ...body(),amount },'agent')).statusCode,400);
  assert.equal((await api('POST',requests,{ ...body(),currency:'JPY' },'agent')).json().error,'PAYMENT_CURRENCY_NOT_OFFERED');
  assert.equal((await api('POST',requests,{ ...body(),methodVersion:2 },'agent')).statusCode,409);
  const firstBody=body();const before=providerCalls;const concurrent=await Promise.all(Array.from({ length:8 },()=>api('POST',requests,firstBody,'agent')));
  assert.equal(concurrent.filter((r)=>r.statusCode===201).length,1);assert.equal(concurrent.filter((r)=>r.statusCode===200).length,7);
  const id=concurrent[0]!.json().id;assert.ok(concurrent.every((r)=>r.json().id===id));assert.equal(providerCalls,before);
  assert.equal(concurrent[0]!.json().amount,'12.50');assert.equal(concurrent[0]!.json().customerUrl,null);assert.equal(concurrent[0]!.json().financialProcessingReady,false);
  assert.equal((await api('POST',requests,{ ...firstBody,amount:'13.00' },'agent')).json().error,'PAYMENT_REQUEST_IDEMPOTENCY_CONFLICT');
  assert.equal((await api('POST',requests,firstBody)).json().error,'PAYMENT_REQUEST_IDEMPOTENCY_CONFLICT');
  assert.equal((await api('POST',requests,{ ...firstBody,amount:'12.50' },'agent')).statusCode,200);
  const stored=(await db`SELECT * FROM payment_link_intent WHERE id=${id}`)[0]!;
  assert.equal(stored.account_ref,options.accountRef);assert.equal(stored.campaign_id,campaign);assert.equal(stored.requester_session_id,users.agent!.session);
  assert.equal(openOpaque('payment-link:'+id,{ ciphertext:stored.ciphertext,nonce:stored.nonce,authTag:stored.auth_tag,keyVersion:stored.key_version }),JSON.stringify({ apiKey:key }));
  assert.equal(stored.ciphertext.toString().includes(key),false);assert.equal(stored.minor,'1250');assert.equal(stored.success_url,process.env.APP_ORIGIN+'/?paymentReturn=success');
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead_activity WHERE lead_id=${lead} AND event_type='PAYMENT_LINK_REQUESTED'`)[0]!.n,1);
  assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE action='PAYMENT_LINK_REQUESTED'`)[0]!.n,1);
  assert.equal((await db`SELECT contact_id FROM lead WHERE id=${lead}`)[0]!.contact_id,null);assert.equal((await db`SELECT count(*)::integer AS n FROM contact`)[0]!.n,0);
  for(const mutation of [db`UPDATE payment_link_intent SET amount='13.00',minor='1300' WHERE id=${id}`,db`UPDATE payment_link_intent SET ciphertext=${Buffer.from('changed')} WHERE id=${id}`,db`DELETE FROM payment_link_intent WHERE id=${id}`])await assert.rejects(mutation);
  const history=(await api('GET',requests,undefined,'agent')).json();assert.equal(history.items[0].state,'PREPARED');assert.equal(history.items[0].id,id);
  for(const hidden of ['connection_id','account_ref','nonce','ciphertext','requester_session_id',key,secret])assert.equal(JSON.stringify(history).includes(hidden),false);
  // Audit failure rolls back the request and Activity together; replay with the same logical key is safe.
  await db`CREATE FUNCTION synthetic_payment_request_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_LINK_REQUESTED' THEN RAISE EXCEPTION 'synthetic rollback' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`;
  await db`CREATE TRIGGER synthetic_payment_request_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_payment_request_failure()`;
  const retryBody=body();try { assert.equal((await api('POST',requests,retryBody,'agent')).statusCode,500);assert.equal((await db`SELECT count(*)::integer AS n FROM payment_link_intent`)[0]!.n,1); }
  finally { await db`DROP TRIGGER synthetic_payment_request_failure ON audit_log`;await db`DROP FUNCTION synthetic_payment_request_failure()`; }
  assert.equal((await api('POST',requests,retryBody,'agent')).statusCode,201);
  const page=(await api('GET',requests+'?limit=1',undefined,'agent')).json();assert.ok(page.nextCursor);
  assert.notEqual((await api('GET',requests+'?limit=1&cursor='+encodeURIComponent(page.nextCursor),undefined,'agent')).json().items[0].id,page.items[0].id);
  // Latest failure invalidates readiness even when an older verified probe exists.
  webhookFailure=true;assert.equal((await api('POST',wr+'/test',{ version:2,connectionVersion:1 })).statusCode,502);
  assert.equal((await api('POST',requests,body(),'agent')).json().error,'PAYMENT_WEBHOOK_VERIFICATION_REQUIRED');
  webhookFailure=false;assert.equal((await api('POST',wr+'/test',{ version:2,connectionVersion:1 })).statusCode,200);
  await db`UPDATE integration_connection SET capabilities=jsonb_set(capabilities,'{paymentOptions,chargesEnabled}','false') WHERE id=${connection}`;
  assert.equal((await api('POST',requests,body(),'agent')).json().error,'PAYMENT_ACCOUNT_NOT_READY');
  await db`UPDATE integration_connection SET capabilities=jsonb_set(capabilities,'{paymentOptions,chargesEnabled}','true') WHERE id=${connection}`;
  await db`UPDATE branch SET active=false WHERE id=${branch}`;assert.equal((await api('POST',requests,body(),'agent')).json().error,'BRANCH_DISABLED');
  await db`UPDATE branch SET active=true WHERE id=${branch}`;
  await db`UPDATE user_account SET active=false WHERE id=${users.agent!.id}`;assert.equal((await api('GET',requests,undefined,'agent')).statusCode,401);await db`UPDATE user_account SET active=true WHERE id=${users.agent!.id}`;
  // A request waiting for the Method lock must recheck the session and assignment using database time.
  const blocked=async(change:()=>Promise<unknown>,expected:number)=> {
    let release!:()=>void;let acquired!:()=>void;const locked=new Promise<void>((resolve)=>{ acquired=resolve; });
    const holding=db.begin(async(tx)=>{ await tx`SELECT id FROM payment_method WHERE id=${method} FOR UPDATE`;acquired();await new Promise<void>((resolve)=>{ release=resolve; }); });
    await locked;const pending=api('POST',requests,body(),'agent');await delay(80);try { await change(); }finally { release();await holding; }
    const response=await pending;assert.equal(response.statusCode,expected,response.body);
  };
  await blocked(()=>db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.agent!.session}`,403);
  await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.agent!.session}`;
  await blocked(()=>db`UPDATE user_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${users.agent!.session}`,403);
  await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=${users.agent!.session}`;
  await blocked(()=>db`UPDATE user_account SET active=false WHERE id=${users.agent!.id}`,403);
  await db`UPDATE user_account SET active=true WHERE id=${users.agent!.id}`;
  await blocked(()=>db`UPDATE user_account SET role='MANAGER' WHERE id=${users.agent!.id}`,403);
  await db`UPDATE user_account SET role='AGENT',branch_id=${branch} WHERE id=${users.agent!.id}`;
  await blocked(()=>db`UPDATE lead SET assigned_agent_id=${users.agent2!.id},version=version+1 WHERE id=${lead}`,404);
  assert.equal((await api('GET',requests,undefined,'agent')).statusCode,404);assert.equal((await api('GET',requests,undefined,'agent2')).statusCode,200);
  assert.equal((await api('POST',requests,body(),'agent2')).statusCode,404); // SELECTED Method does not follow reassignment automatically.
  assert.equal((await api('GET',methods,undefined,'agent2')).json().items.length,0);
  await db`UPDATE lead SET assigned_agent_id=${users.agent!.id},campaign_id=${campaign2},version=version+1 WHERE id=${lead}`;
  assert.equal((await api('POST',requests,body(),'agent')).statusCode,404);await db`UPDATE lead SET campaign_id=${campaign},version=version+1 WHERE id=${lead}`;
  // Rotation changes current availability, never the original encrypted account/mode/config inputs.
  assert.equal((await api('PUT',connectionRoot,{ name:'Rotated account',provider:'STRIPE',config:{ mode:'TEST' },credentials:{ apiKey:'rk_test_'+'ReplacementOnly'.repeat(3) },version:1 })).statusCode,200);
  assert.equal((await api('POST',requests,firstBody,'agent')).statusCode,200);
  assert.equal((await api('POST',requests,body(),'agent')).statusCode,409);
  assert.equal(openOpaque('payment-link:'+id,{ ciphertext:stored.ciphertext,nonce:stored.nonce,authTag:stored.auth_tag,keyVersion:stored.key_version }),JSON.stringify({ apiKey:key }));
  assert.equal((await api('GET',requests,undefined,'agent')).json().items.length,2);
  assert.equal((await db`SELECT count(*)::integer AS n FROM background_job WHERE queue LIKE 'payment%'`)[0]!.n,0);
  assert.equal((await api('POST',wr+'/disable',{ version:2,reason:'Retain history and stop receipts' })).statusCode,200);
  // A Root-created shared Method grants operational use, never Connection/credential setup access.
  const shared=(await api('POST','/api/payments/connections',connInput,'admin')).json().id;const sr='/api/payments/connections/'+shared;
  assert.equal((await api('POST',sr+'/test',{ version:1,inspectOptions:true },'admin')).statusCode,200);
  const sw=(await api('POST',sr+'/webhooks',{ connectionVersion:1,reason:'Shared account callback' },'admin')).json();
  assert.equal((await api('POST',sr+'/webhooks/'+sw.id+'/configure',{ version:1,endpointId:'we_RequestSharedSynthetic123',signingSecret:secret,reason:'Registered shared endpoint' },'admin')).statusCode,200);
  assert.equal((await api('POST',sr+'/webhooks/'+sw.id+'/test',{ version:2,connectionVersion:1 },'admin')).statusCode,200);
  const sharedTime=(await db`SELECT extract(epoch FROM clock_timestamp())::bigint AS n`)[0]!.n;
  const sharedSignature=`t=${sharedTime},v1=${createHmac('sha256',secret).update(sharedTime+'.').update(raw).digest('hex')}`;
  assert.equal((await app.inject({ method:'POST',url:new URL(sw.callback_url).pathname,payload:raw,headers:{ 'content-type':'application/json','stripe-signature':sharedSignature } })).statusCode,200);
  const sm=(await api('POST','/api/payments/methods',{ ...methodInput,connectionId:shared,name:'Shared tuition' },'admin')).json();
  const saved=await api('POST',requests,{ ...body(),methodId:sm.id },'agent');assert.equal(saved.statusCode,201,saved.body);
  assert.equal((await api('GET',sr)).statusCode,404);assert.equal((await api('GET',sr,undefined,'agent')).statusCode,403);
  assert.equal((await api('GET',requests,undefined,'agent')).json().items.length,3);
  assert.equal((await api('GET',requests,undefined,'other')).statusCode,404);
});
