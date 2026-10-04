import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac,randomBytes,randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { SourceProviderError } from '../src/sources/meta-provider.js';
const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('source webhook durably preserves authenticated notifications and subscription setup enforces scope, replay, atomic batches, history and current leases',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const credentials={ accessToken:'synthetic-root-source-token',appSecret:'synthetic-source-secret',verifyToken:'synthetic-source-verify' };
  let mode='ok';let calls=0;let wait:Promise<void>|undefined;let entered:(()=>void)|undefined;
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,
    leadSourceCatalogAdapter:{ discoverPages:async()=>[{ externalId:'11',name:'Page',accessToken:'synthetic-page-token' },{ externalId:'12',name:'Other Page',accessToken:'synthetic-other-page-token' }],discoverForms:async()=>[] },
    leadSourceSubscriptionAdapter:{ check:async(input)=> {
      calls++;assert.equal(input.page.accessToken,'synthetic-page-token');assert.equal(input.appSecret,credentials.appSecret);assert.equal(input.config.appId,'777');entered?.();await wait;
      if (mode==='auth') throw new SourceProviderError('SOURCE_PROVIDER_AUTH_FAILED');
      if (mode==='error') throw new Error('secret '+credentials.appSecret);
      if (mode==='retry') throw new SourceProviderError('SOURCE_PROVIDER_UNAVAILABLE',true);
      return { subscribed:mode!=='absent' };
    } },
  });t.after(async()=> { await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Source Webhook') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const other=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['other','MANAGER',other],['agent','AGENT',branch]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash) VALUES (${org},${scope},${name},${role},${name+'@source-webhook.test'},'test-non-login-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
    users[name]={ id,cookie:'lop_session='+token };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.0.${ip++}` });
  const root='/api/sources/meta/connections';const config={ graphVersion:'v25.0',appId:'777' };
  const id=(await api('POST',root,{ name:'Source',config,credentials })).json().id;const base=root+'/'+id;const callback='/api/webhooks/sources/meta/'+id;
  const shared=(await api('POST',root,{ name:'Shared',config,credentials },'admin')).json().id;
  await api('POST',base+'/discover',{ version:1 });const page=(await api('GET',base+'/resources?kind=PAGE')).json().items.find((p:{ external_id:string })=>p.external_id==='11');
  const input={ version:1,pageId:page.id,pageVersion:page.version,subscribe:false };
  for (const [path,actor,code] of [[base+'/webhook','agent',403],[base+'/webhook','other',404],[root+'/'+shared+'/webhook','manager',404],[base+'/subscription-history?pageId='+page.id,'other',404],[base+'/webhook-events','agent',403]] as const)
    assert.equal((await api('GET',path,undefined,actor)).statusCode,code);
  assert.equal((await api('POST',base+'/subscription',input,'agent')).statusCode,403);
  assert.equal((await api('POST',base+'/subscription',{ ...input,pageVersion:999 })).statusCode,409);
  assert.equal((await api('POST',base+'/subscription',{ ...input,pageId:randomUUID() })).statusCode,404);
  mode='absent';assert.equal((await api('POST',base+'/subscription',input)).json().subscribed,false);
  mode='ok';assert.equal((await api('POST',base+'/subscription',{ ...input,subscribe:true })).statusCode,200);
  let health=(await api('GET',base+'/webhook?pageId='+page.id)).json();assert.equal(health.subscription.current,true);assert.equal(health.subscription.subscribed,true);assert.equal(health.handshakeVerified,false);assert.equal(health.intakeReady,false);
  const handshake=(token=credentials.verifyToken)=>callback+'?'+new URLSearchParams({ 'hub.mode':'subscribe','hub.verify_token':token,'hub.challenge':'12345' });
  assert.equal((await app.inject({ method:'GET',url:handshake('bad') })).statusCode,403);
  const verified=await app.inject({ method:'GET',url:handshake() });assert.equal(verified.statusCode,200);assert.equal(verified.body,'12345');assert.equal(verified.headers['cache-control'],'no-store');
  const notification=(lead='900',form='101',pageId='11')=>({ object:'page',entry:[{ id:pageId,time:1700000000,changes:[{ field:'leadgen',value:{ page_id:pageId,form_id:form,leadgen_id:lead,created_time:1699999999,adgroup_id:'77',custom:'<img onerror=alert(1)>' } }] }] });
  const send=(payload:unknown,valid=true)=> { const raw=JSON.stringify(payload);return app.inject({ method:'POST',url:callback,payload:raw,headers:{ 'content-type':'application/json',
    'x-hub-signature-256':'sha256='+createHmac('sha256',valid ? credentials.appSecret : 'wrong').update(raw).digest('hex') },remoteAddress:`127.1.0.${ip++}` }); };
  assert.equal((await send(notification(),false)).statusCode,403);assert.equal((await send({ object:'page',entry:[] })).statusCode,400);
  assert.equal((await send(notification('901','101','13'))).statusCode,403);
  const result=await Promise.all([send(notification()),send(notification()),send(notification())]);assert.ok(result.every((r)=>r.statusCode===200));
  assert.equal((await db`SELECT count(*)::integer AS n FROM source_webhook_event`)[0]!.n,1);
  const original=(await db`SELECT * FROM source_webhook_event`)[0]!;assert.equal(original.source_created_at.toISOString(),'2023-11-14T22:13:19.000Z');assert.equal(original.raw_notification.change.value.adgroup_id,'77');
  assert.equal((await send(notification('900','102'))).statusCode,409);
  const batch={ object:'page',entry:[...notification('902').entry,...notification('903','101','13').entry] };assert.equal((await send(batch)).statusCode,403);
  assert.equal((await db`SELECT count(*)::integer AS n FROM source_webhook_event`)[0]!.n,1);
  assert.equal((await send(notification('904','unknown'))).statusCode,400); // IDs are validated; unknown but valid numeric Forms are preserved.
  assert.equal((await send(notification('904','99999'))).statusCode,200);
  const dto=(await api('GET',base+'/webhook-events?limit=1')).json();assert.ok(dto.nextCursor);assert.ok(!JSON.stringify(dto).includes('raw_notification'));assert.ok(!JSON.stringify(dto).includes('<img'));
  const next=(await api('GET',base+'/webhook-events?limit=1&cursor='+encodeURIComponent(dto.nextCursor))).json();assert.equal(next.items[0].id,original.id);
  await assert.rejects(db`UPDATE source_webhook_event SET raw_notification='{}'::jsonb WHERE id=${original.id}`);await assert.rejects(db`DELETE FROM source_webhook_event WHERE id=${original.id}`);
  health=(await api('GET',base+'/webhook')).json();assert.equal(health.pending,2);assert.equal(health.handshakeVerified,true);assert.equal(health.signedCallbackVerified,true);
  mode='auth';assert.equal((await api('POST',base+'/subscription',input)).statusCode,502);
  assert.equal((await db`SELECT status FROM integration_connection WHERE id=${id}`)[0]!.status,'AUTH_EXPIRED');assert.equal((await send(notification('905'))).statusCode,200);
  mode='retry';assert.equal((await api('POST',base+'/subscription',input)).statusCode,503);
  mode='error';const failed=await api('POST',base+'/subscription',input);assert.equal(failed.statusCode,502);assert.ok(!failed.body.includes(credentials.appSecret));
  mode='ok';assert.equal((await api('POST',base+'/subscription',input)).statusCode,200);
  const history=(await api('GET',base+'/subscription-history?pageId='+page.id+'&limit=1')).json();assert.ok(history.nextCursor);
  await assert.rejects(db`UPDATE source_subscription_attempt SET subscribed=false WHERE id=${history.items[0].id}`);
  await assert.rejects(db`DELETE FROM source_subscription_attempt WHERE id=${history.items[0].id}`);
  let release!:()=>void;wait=new Promise<void>((resolve)=> { release=resolve; });const started=new Promise<void>((resolve)=> { entered=resolve; });
  const running=api('POST',base+'/subscription',input);await started;
  assert.equal((await api('POST',base+'/subscription',input)).json().error,'SOURCE_SUBSCRIPTION_RUNNING');
  await api('POST',base+'/discover',{ version:1 });release();assert.equal((await running).statusCode,409);wait=undefined;entered=undefined;
  assert.equal((await api('GET',base+'/webhook?pageId='+page.id)).json().subscription.current,false);
  const freshPage=(await db`SELECT version FROM source_resource WHERE id=${page.id}`)[0]!;const fresh={ ...input,pageVersion:freshPage.version };
  wait=new Promise<void>((resolve)=> { release=resolve; });const requesterStarted=new Promise<void>((resolve)=> { entered=resolve; });
  const revoked=api('POST',base+'/subscription',fresh);await requesterStarted;await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;
  release();assert.equal((await revoked).statusCode,403);wait=undefined;entered=undefined;await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;
  await db`INSERT INTO source_subscription_attempt (id,connection_id,connection_version,page_id,page_version,actor_user_id,action,lease_until)
    VALUES (gen_random_uuid(),${id},1,${page.id},${fresh.pageVersion},${users.manager!.id},'TEST',now()-interval '1 second')`;
  assert.equal((await api('POST',base+'/subscription',fresh)).statusCode,200);
  wait=new Promise<void>((resolve)=> { release=resolve; });const disablingStarted=new Promise<void>((resolve)=> { entered=resolve; });
  const disabled=api('POST',base+'/subscription',fresh);await disablingStarted;await api('POST',base+'/disable',{ version:1 });release();assert.equal((await disabled).statusCode,409);wait=undefined;entered=undefined;
  assert.equal((await send(notification('906'))).statusCode,409);assert.equal((await app.inject({ method:'GET',url:handshake() })).statusCode,409);
  assert.equal((await api('GET',base+'/webhook')).json().handshakeVerified,false);assert.equal((await api('GET',base+'/webhook-events')).json().items.length,3);
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM source_submission`)[0]!.n,0);
  const audit=await db`SELECT action,detail FROM audit_log WHERE target_id=${id}`;assert.ok(audit.some((r)=>r.action==='SOURCE_SUBSCRIPTION_FAILED'));assert.ok(!JSON.stringify(audit).includes('synthetic-'));assert.ok(calls>5);
});
