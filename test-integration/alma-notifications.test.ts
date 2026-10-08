import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Alma unsigned IPN setup and bounded immutable inbox enforce current scopes/session/config, concurrency, historical identity and atomic audit without payment authority',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const previousLimit=process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT;delete process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT;
  let calls=0;let merchant='merchant_NotificationSynthetic123';const credentials={ apiKey:'AlmaNotificationsSyntheticKey_12345678' };
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> {
    calls++;assert.equal(target,'https://api.sandbox.getalma.eu/v1/me/extended-data');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
    assert.equal(new Headers(init.headers).get('authorization'),'Alma-Auth '+credentials.apiKey);
    return new Response(JSON.stringify({ id:merchant,bank_account:'private notification bank',email:'private@notification.test' }));
  });
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=>{ if(previousLimit===undefined)delete process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT;else process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT=previousLimit;await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Notification test') RETURNING id`)[0]!.id;
  const foreign=(await db`INSERT INTO organization(name) VALUES ('Foreign notification org') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'Notification branch') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'Other branch') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;session:string;cookie:string }>={};
  for(const [name,role,scope,organization] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',otherBranch,org],['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreign]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${organization},${scope},${name},${role},${name+'@notifications.test'},'not login password') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name]={ id,session,cookie:'lop_session='+token };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor='manager')=>app.inject({ method,url:path,payload,headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.29.${ip++}` });
  const receive=(endpointId:string,pid:string,extra='')=>app.inject({ method:'GET',url:'/api/webhooks/payments/alma/'+endpointId+'?pid='+encodeURIComponent(pid)+extra,remoteAddress:`127.0.30.${ip++}` });
  const root='/api/payments/connections';const made=await api('POST',root,{ name:'Alma notifications',provider:'ALMA',credentials,config:{ mode:'TEST' } });assert.equal(made.statusCode,201,made.body);
  const id=made.json().id;const path=root+'/'+id;const endpoints=path+'/notification-endpoints';const input={ connectionVersion:1,reason:'Prepare merchant notification callback' };
  assert.equal((await api('POST',endpoints,input)).statusCode,409);assert.equal(calls,0);
  assert.equal((await api('POST',path+'/test',{ version:1 })).statusCode,200);assert.equal(calls,1);
  for(const actor of ['other','agent','foreign']) {
    assert.equal((await api('POST',endpoints,input,actor)).statusCode,actor==='agent' ? 403 : 404);
    assert.equal((await api('GET',endpoints,undefined,actor)).statusCode,actor==='agent' ? 403 : 404);
    assert.equal((await api('GET',path+'/untrusted-notifications',undefined,actor)).statusCode,actor==='agent' ? 403 : 404);
  }
  for(const patch of [{ signed:true },{ accountRef:merchant },{ callbackUrl:'https://evil.test' },{ reason:'  ' },{ reason:'note\nclaim' }])assert.equal((await api('POST',endpoints,{ ...input,...patch })).statusCode,400);
  assert.equal((await api('POST',endpoints,{ ...input,connectionVersion:2 })).statusCode,409);
  const concurrent=await Promise.all(Array.from({ length:8 },()=>api('POST',endpoints,input)));
  assert.equal(concurrent.filter((r)=>r.statusCode===201).length,1);assert.equal(concurrent.filter((r)=>r.json().duplicate).length,7);
  const e=concurrent[0]!.json();assert.ok(concurrent.every((r)=>r.json().id===e.id));const endpointPath=endpoints+'/'+e.id;
  assert.equal(e.current,true);assert.equal(e.account_ref,merchant);assert.equal(e.signedDeliveryVerified,false);assert.equal(e.financialProcessingReady,true);assert.equal(e.publicHttps,false);
  assert.equal(e.callback_url,process.env.APP_ORIGIN+'/api/webhooks/payments/alma/'+e.id);
  assert.equal((await db`SELECT count(*)::integer n FROM payment_notification_endpoint_history WHERE endpoint_id=${e.id}`)[0]!.n,1);
  assert.equal((await db`SELECT count(*)::integer n FROM audit_log WHERE action='PAYMENT_NOTIFICATION_ENDPOINT_CREATED'`)[0]!.n,1);
  for(const actor of ['other','agent','foreign'])for(const suffix of ['', '/history'])assert.equal((await api('GET',endpointPath+suffix,undefined,actor)).statusCode,actor==='agent' ? 403 : 404);
  assert.equal((await api('GET',endpointPath,undefined,'admin')).statusCode,200);
  assert.equal((await receive(randomUUID(),'payment_a')).statusCode,404);
  for(const value of ['paid','payment_','payment_bad<script>','payment_'+'x'.repeat(121)])assert.equal((await receive(e.id,value)).statusCode,400);
  for(const extra of ['&paid=true','&amount=10000','&trust=VERIFIED','&pid=payment_other'])assert.equal((await receive(e.id,'payment_Claim',extra)).statusCode,400);
  const duplicated=await Promise.all(Array.from({ length:8 },()=>receive(e.id,'payment_First')));
  assert.equal(duplicated.filter((r)=>r.json().duplicate===false).length,1);assert.ok(duplicated.every((r)=>r.statusCode===200 && r.json().trust==='UNVERIFIED'));
  assert.equal(duplicated[0]!.headers['cache-control'],'no-store');assert.equal(calls,1,'unsigned reception performs no provider I/O');
  assert.equal((await db`SELECT count(*)::integer n FROM payment_untrusted_notification`)[0]!.n,1);assert.equal((await db`SELECT count(*)::integer n FROM payment_notification_delivery`)[0]!.n,1);
  const original=(await db`SELECT * FROM payment_untrusted_notification WHERE resource_id='payment_First'`)[0]!;
  assert.equal((await db`SELECT count(*)::integer n FROM audit_log WHERE action='PAYMENT_UNTRUSTED_NOTIFICATION_RECEIVED'`)[0]!.n,1);
  for(const resource of ['payment_Second','payment_Third','payment_Fourth'])assert.equal((await receive(e.id,resource)).statusCode,200);
  const inbox=(await api('GET',path+'/untrusted-notifications?limit=2')).json();assert.equal(inbox.items.length,2);assert.ok(inbox.nextCursor);
  assert.notEqual((await api('GET',path+'/untrusted-notifications?limit=2&cursor='+encodeURIComponent(inbox.nextCursor))).json().items[0].id,inbox.items[0].id);
  assert.equal((await api('GET',path+'/untrusted-notifications?limit=101')).statusCode,400);assert.equal((await api('GET',path+'/untrusted-notifications?cursor=bad')).statusCode,400);
  process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT='5';const admission=await Promise.all(Array.from({ length:4 },(_,n)=>receive(e.id,'payment_Bounded'+n)));
  assert.equal(admission.filter((r)=>r.statusCode===200).length,1);assert.equal(admission.filter((r)=>r.statusCode===429 && r.json().error==='PAYMENT_NOTIFICATION_BACKPRESSURE').length,3);
  assert.equal((await receive(e.id,'payment_First')).statusCode,200,'duplicates accepted under pressure');delete process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT;
  // Route rate limiting does not need authentication and creates no duplicate delivery or audit.
  const rateIp='127.0.32.1';const rate=[];
  for(let n=0;n<61;n++)rate.push(await app.inject({ method:'GET',url:'/api/webhooks/payments/alma/'+e.id+'?pid=payment_First',remoteAddress:rateIp }));
  assert.equal(rate.filter((r)=>r.statusCode===429).length,1);assert.equal(rate.filter((r)=>r.statusCode===200).length,60);
  const burst=await Promise.all(Array.from({ length:61 },()=>app.inject({ method:'GET',url:'/api/webhooks/payments/alma/'+e.id+'?pid=payment_First',remoteAddress:'127.0.32.2' })));
  assert.ok(burst.filter((r)=>r.statusCode===200).length<=60);assert.ok(burst.some((r)=>r.statusCode===429),'a concurrent burst cannot exceed the route allowance');
  await assert.rejects(db`UPDATE payment_untrusted_notification SET trust='VERIFIED' WHERE id=${original.id}`,/PAYMENT_NOTIFICATION_ORIGINAL_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM payment_untrusted_notification WHERE id=${original.id}`,/PAYMENT_NOTIFICATION_ORIGINAL_IMMUTABLE/);
  await assert.rejects(db`UPDATE payment_notification_delivery SET mode='LIVE' WHERE notification_id=${original.id}`,/PAYMENT_NOTIFICATION_DELIVERY_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM payment_notification_endpoint WHERE id=${e.id}`,/PAYMENT_NOTIFICATION_HISTORY_RETAINED/);
  await assert.rejects(db`UPDATE payment_notification_endpoint SET account_ref='merchant_Fake',version=version+1,state='DISABLED' WHERE id=${e.id}`,/PAYMENT_NOTIFICATION_IDENTITY_INVALID/);
  await assert.rejects(db`UPDATE payment_notification_endpoint_history SET reason='Rewritten' WHERE endpoint_id=${e.id}`,/PAYMENT_NOTIFICATION_HISTORY_IMMUTABLE/);
  const full=(await db`SELECT * FROM payment_notification_endpoint WHERE id=${e.id}`)[0]!;
  const native=(patch:Record<string,unknown>={})=>{ const eid=randomUUID();const base={ id:eid,connection_id:id,connection_version:1,profile:'ALMA_IPN_GET_V1',account_ref:merchant,mode:'TEST',
    authentication_probe_id:full.authentication_probe_id,callback_url:process.env.APP_ORIGIN+'/api/webhooks/payments/alma/'+eid,actor_user_id:users.manager!.id,actor_session_id:users.manager!.session,reason:'Native guard validation',...patch };
    return db`INSERT INTO payment_notification_endpoint ${db(base)}`; };
  await assert.rejects(native({ actor_user_id:users.agent!.id,actor_session_id:users.agent!.session }),/PAYMENT_NOTIFICATION_SCOPE_INVALID/);
  for(const authority of ['https://user:password@app.test','http://remote.test','https://app.test:8443']) { const eid=randomUUID();await assert.rejects(native({ id:eid,callback_url:authority+'/api/webhooks/payments/alma/'+eid }),/PAYMENT_NOTIFICATION_CALLBACK_INVALID/); }
  const disabled=await Promise.all([api('POST',endpointPath+'/disable',{ version:1,reason:'Pause notification intake' }),api('POST',endpointPath+'/disable',{ version:1,reason:'Concurrent pause' })]);
  assert.equal(disabled.filter((r)=>r.statusCode===200).length,1);assert.equal(disabled.filter((r)=>r.statusCode===409).length,1);
  assert.equal((await receive(e.id,'payment_Disabled')).statusCode,410);assert.equal((await receive(e.id,'payment_First')).statusCode,410);
  await assert.rejects(db`INSERT INTO payment_untrusted_notification(connection_id,mode,endpoint_id,resource_id,profile) VALUES (${id},'TEST',${e.id},'payment_Disabled','ALMA_IPN_GET_V1')`,/PAYMENT_NOTIFICATION_ENDPOINT_DISABLED/);
  assert.equal((await api('POST',endpoints,input)).json().state,'DISABLED','duplicate preparation cannot silently re-enable');
  assert.equal((await api('POST',endpointPath+'/reconnect',{ version:2,reason:'Resume original merchant' })).statusCode,200);
  assert.equal((await receive(e.id,'payment_First')).json().duplicate,true);
  // Application and native guards use the actual current session, user role and branch.
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
  assert.equal((await api('POST',endpointPath+'/disable',{ version:3,reason:'Revoked session' })).statusCode,401);
  await assert.rejects(db`UPDATE payment_notification_endpoint SET state='DISABLED',version=4 WHERE id=${e.id}`,/PAYMENT_NOTIFICATION_SCOPE_INVALID/);
  await db`UPDATE user_session SET revoked_at=NULL,expires_at=clock_timestamp()+interval '25 milliseconds' WHERE id=${users.manager!.session}`;await delay(50);
  assert.equal((await api('GET',endpoints)).statusCode,401);await assert.rejects(native(),/PAYMENT_NOTIFICATION_SCOPE_INVALID/);
  await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=${users.manager!.session}`;
  await db`UPDATE user_account SET role='AGENT' WHERE id=${users.manager!.id}`;assert.equal((await api('POST',endpoints,input)).statusCode,403);await assert.rejects(native(),/PAYMENT_NOTIFICATION_SCOPE_INVALID/);
  await db`UPDATE user_account SET role='MANAGER' WHERE id=${users.manager!.id}`;
  await db`UPDATE branch SET active=false WHERE id=${branch}`;assert.equal((await api('POST',endpointPath+'/disable',{ version:3,reason:'Disabled branch' })).statusCode,409);
  await assert.rejects(native(),/PAYMENT_NOTIFICATION_SCOPE_INVALID/);await db`UPDATE branch SET active=true WHERE id=${branch}`;
  // Configuration rotation freezes old endpoint identity. Old enabled callback still accepts read triggers.
  assert.equal((await api('PUT',path,{ name:'Rotated notifications',provider:'ALMA',config:{ mode:'TEST' },version:1 })).statusCode,200);
  assert.equal((await api('GET',endpointPath)).json().current,false);assert.equal((await receive(e.id,'payment_AfterRotation')).statusCode,200);
  assert.equal((await api('POST',endpoints,{ ...input,connectionVersion:2 })).statusCode,409);
  merchant='merchant_NotificationRotated456';assert.equal((await api('POST',path+'/test',{ version:2 })).statusCode,200);
  const second=(await api('POST',endpoints,{ ...input,connectionVersion:2 })).json();assert.equal(second.account_ref,merchant);assert.notEqual(second.id,e.id);
  const afterRotation=await receive(second.id,'payment_First');assert.equal(afterRotation.json().duplicate,true);
  assert.equal((await db`SELECT count(*)::integer n FROM payment_untrusted_notification WHERE resource_id='payment_First'`)[0]!.n,1);
  assert.equal((await db`SELECT count(*)::integer n FROM payment_notification_delivery WHERE notification_id=${original.id}`)[0]!.n,2);
  assert.deepEqual((await db`SELECT * FROM payment_untrusted_notification WHERE id=${original.id}`)[0],original);
  assert.equal((await api('POST',endpointPath+'/disable',{ version:3,reason:'Retire original endpoint' })).statusCode,200);
  assert.equal((await api('POST',endpointPath+'/reconnect',{ version:4,reason:'Do not migrate identity' })).statusCode,409);
  await assert.rejects(db`UPDATE payment_notification_endpoint SET state='ENABLED',version=5 WHERE id=${e.id}`,/PAYMENT_NOTIFICATION_CURRENT_CONFIG_REQUIRED/);
  assert.equal((await api('POST',path+'/disable',{ version:2,reason:'Stop connection financial writes' })).statusCode,200);
  assert.equal((await receive(second.id,'payment_WhileConnectionDisabled')).statusCode,200);
  assert.equal((await api('POST',endpoints,{ ...input,connectionVersion:3 })).statusCode,409);
  assert.equal((await api('POST',path+'/reconnect',{ version:3,reason:'Restore connection' })).statusCode,200);
  assert.equal((await api('POST',path+'/test',{ version:4 })).statusCode,200);
  // Every persisted reception and lifecycle mutation rolls back if its audit cannot be written.
  await db`CREATE FUNCTION test_fail_notification_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'PAYMENT_NOTIFICATION_ENDPOINT_%' OR NEW.action='PAYMENT_UNTRUSTED_NOTIFICATION_RECEIVED' THEN RAISE EXCEPTION 'TEST_AUDIT_FAIL'; END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER test_fail_notification_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_notification_audit()`;
  try {
    assert.equal((await receive(second.id,'payment_AuditFail')).statusCode,500);assert.equal((await db`SELECT count(*)::integer n FROM payment_untrusted_notification WHERE resource_id='payment_AuditFail'`)[0]!.n,0);
    assert.equal((await api('POST',endpoints,{ ...input,connectionVersion:4 })).statusCode,500);assert.equal((await db`SELECT count(*)::integer n FROM payment_notification_endpoint WHERE connection_id=${id} AND connection_version=4`)[0]!.n,0);
    assert.equal((await api('POST',endpoints+'/'+second.id+'/disable',{ version:1,reason:'Audit must persist' })).statusCode,500);assert.equal((await api('GET',endpoints+'/'+second.id)).json().version,1);
    assert.equal((await db`SELECT count(*)::integer n FROM payment_notification_endpoint_history WHERE endpoint_id=${second.id}`)[0]!.n,1);
  }finally { await db`DROP TRIGGER test_fail_notification_audit ON audit_log`;await db`DROP FUNCTION test_fail_notification_audit()`; }
  assert.equal((await receive(second.id,'payment_AuditFail')).statusCode,200);
  const last=(await api('POST',endpoints,{ ...input,connectionVersion:4 })).json();assert.equal(last.current,true);
  const firstPage=(await api('GET',endpoints+'?limit=1')).json();assert.ok(firstPage.nextCursor);assert.equal(firstPage.items.length,1);
  assert.notEqual((await api('GET',endpoints+'?limit=1&cursor='+encodeURIComponent(firstPage.nextCursor))).json().items[0].id,firstPage.items[0].id);
  const history=(await api('GET',endpointPath+'/history?limit=2')).json();assert.equal(history.nextVersion,3);assert.equal(history.items.length,2);
  assert.equal((await api('GET',endpointPath+'/history?limit=2&before=3')).json().items[0].version,2);
  // Shared organization connection remains Super Admin only.
  const shared=(await api('POST',root,{ name:'Shared Alma notification',provider:'ALMA',credentials,config:{ mode:'TEST' } },'admin')).json().id;
  assert.equal((await api('POST',root+'/'+shared+'/test',{ version:1 },'admin')).statusCode,200);
  assert.equal((await api('POST',root+'/'+shared+'/notification-endpoints',input,'manager')).statusCode,404);
  assert.equal((await api('POST',root+'/'+shared+'/notification-endpoints',input,'admin')).statusCode,201);
  const publicText=JSON.stringify([(await api('GET',endpoints)).json(),(await api('GET',path+'/untrusted-notifications')).json(),(await api('GET',endpointPath+'/history')).json(),await db`SELECT detail FROM audit_log WHERE action LIKE 'PAYMENT_%'`]);
  for(const secret of [credentials.apiKey,users.manager!.session,'private notification bank','private@notification.test','actor_session_id'])assert.equal(publicText.includes(secret),false);
  for(const table of ['payment_link_intent','payment_record','enrollment','payment_capture_job','payment_webhook_event'])assert.equal((await db`SELECT count(*)::integer n FROM ${db(table)}`)[0]!.n,0);
});
