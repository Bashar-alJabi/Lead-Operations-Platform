import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { openSecret } from '../src/credentials.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('PayPal actual OAuth adapter uses encrypted scoped setup, immutable identities, current sessions and safe late/failure history without financial readiness',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  let behavior:'OK'|'AUTH'|'WAIT'='OK';let calls=0;const pending:(()=>void)[]=[];const tokens:string[]=[];
  const pair={ clientId:'IntegrationClientSynthetic_123456',clientSecret:'IntegrationSecretSynthetic_123456' };
  const replacement={ clientId:'RotatedClientSynthetic_123456',clientSecret:'RotatedSecretSynthetic_123456' };
  t.mock.method(globalThis,'fetch',async(target:string,options:RequestInit)=> {
    calls++;assert.equal(target,'https://api-m.sandbox.paypal.com/v1/oauth2/token');assert.equal(options.method,'POST');
    assert.equal(options.body,'grant_type=client_credentials');assert.equal(options.redirect,'error');assert.ok(options.signal);
    const basic=(options.headers as Record<string,string>).authorization;assert.ok([pair,replacement].some((p)=>basic==='Basic '+Buffer.from(p.clientId+':'+p.clientSecret).toString('base64')));
    const mode=behavior;if(mode==='WAIT')await new Promise<void>((resolve)=>pending.push(resolve));
    if(mode==='AUTH')return new Response(pair.clientSecret,{ status:401 });
    const token='IntegrationTokenSynthetic_'+calls;tokens.push(token);
    return new Response(JSON.stringify({ access_token:token,token_type:'Bearer',expires_in:3600,app_id:'APP-SyntheticPayPal123',scope:'not a payment or payee proof' }));
  });
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=>{ pending.forEach((release)=>release());await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('PayPal') RETURNING id`)[0]!.id;
  const foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Foreign') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope,userOrg] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',otherBranch,org],['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${userOrg},${scope},${name},${role},${name+'@paypal.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name]={ id,cookie:'lop_session='+token,session };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.17.${ip++}` });
  const root='/api/payments/connections';const input={ name:'PayPal <img src=x>',provider:'PAYPAL',config:{ mode:'TEST' },credentials:pair };
  for(const credentials of [{ apiKey:'rk_test_'+'WrongProviderOnly'.repeat(2) },{ clientId:pair.clientId },{ ...pair,apiKey:'rk_test_'+'MixedCredentialsOnly'.repeat(2) }])
    assert.equal((await api('POST',root,{ ...input,credentials })).statusCode,400);
  assert.equal((await api('POST',root,input,'agent')).statusCode,403);assert.equal((await api('POST',root,{ ...input,branchId:otherBranch })).statusCode,403);assert.equal(calls,0);
  const made=await api('POST',root,input);assert.equal(made.statusCode,201,made.body);const id=made.json().id as string;const path=root+'/'+id;
  const shared=await api('POST',root,{ ...input,name:'Shared application' },'admin');assert.equal(shared.statusCode,201,shared.body);
  assert.equal((await api('GET',root+'/'+shared.json().id)).statusCode,404);
  for(const actor of ['other','foreign','agent']) {
    assert.equal((await api('GET',path,undefined,actor)).statusCode,actor==='agent' ? 403 : 404);
    assert.equal((await api('POST',path+'/test',{ version:1 },actor)).statusCode,actor==='agent' ? 403 : 404);
  }
  const secret=async()=>(await db`SELECT * FROM connection_secret WHERE connection_id=${id}`)[0]!;
  const initial=await secret();assert.equal(initial.ciphertext.toString().includes(pair.clientSecret),false);
  assert.deepEqual(JSON.parse(openSecret(id,{ ciphertext:initial.ciphertext,nonce:initial.nonce,authTag:initial.auth_tag,keyVersion:initial.key_version })),pair);
  const row=async()=>(await api('GET',path)).json();
  const verified=await api('POST',path+'/test',{ version:1 });assert.equal(verified.statusCode,200,verified.body);
  assert.equal((await row()).status,'WARNING');assert.equal((await row()).capabilities.authenticationVerified,true);
  for(const key of ['paymentLinksReady','webhookReady'])assert.equal((await row()).capabilities[key],false);
  assert.equal((await row()).capabilities.paymentOptions,undefined);
  const beforeOptions=calls;const options=await api('POST',path+'/test',{ version:1,inspectOptions:true });assert.equal(options.statusCode,502);
  assert.equal(options.json().error,'PAYMENT_PROVIDER_OPTIONS_UNSUPPORTED');assert.equal(calls,beforeOptions);
  const hook=await api('POST',path+'/webhooks',{ connectionVersion:1,reason:'OAuth is not callback proof' });assert.equal(hook.statusCode,409);assert.equal(hook.json().error,'PAYMENT_WEBHOOK_UNSUPPORTED');
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_link_intent`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM enrollment`)[0]!.n,0);
  behavior='AUTH';const denied=await api('POST',path+'/test',{ version:1 });assert.equal(denied.statusCode,502);assert.equal(denied.json().error,'PAYMENT_PROVIDER_AUTH_FAILED');
  assert.equal((await row()).status,'AUTH_EXPIRED');assert.equal(denied.body.includes(pair.clientSecret),false);assert.equal((await api('GET','/api/leads')).statusCode,200);
  const retained=await api('PUT',path,{ name:'Retain secure pair',provider:'PAYPAL',config:{ mode:'TEST' },version:1 });assert.equal(retained.statusCode,200);
  assert.deepEqual((await secret()).ciphertext,initial.ciphertext);
  const rotate=await api('PUT',path,{ ...input,credentials:replacement,version:2 });assert.equal(rotate.statusCode,200,rotate.body);
  assert.notDeepEqual((await secret()).ciphertext,initial.ciphertext);assert.deepEqual((await row()).capabilities,{});
  assert.equal((await api('PUT',path,{ ...input,version:2 })).statusCode,409);
  assert.equal((await api('PUT',path,{ ...input,provider:'STRIPE',credentials:{ apiKey:'rk_test_'+'WrongProviderOnly'.repeat(2) },version:3 })).statusCode,400);
  const waitProbe=async()=>{ behavior='WAIT';const promise=api('POST',path+'/test',{ version:(await row()).version });
    for(let n=0;n<100&&pending.length===0;n++)await delay(5);assert.equal(pending.length,1);return { promise }; };
  const late=await waitProbe();behavior='AUTH';assert.equal((await api('POST',path+'/test',{ version:3 })).statusCode,502);
  pending.shift()!();assert.equal((await late.promise).json().state,'SUPERSEDED');assert.equal((await row()).status,'AUTH_EXPIRED');
  const changing=await waitProbe();assert.equal((await api('PUT',path,{ name:'Updated during OAuth',provider:'PAYPAL',config:{ mode:'TEST' },version:3 })).statusCode,200);
  pending.shift()!();assert.equal((await changing.promise).json().state,'SUPERSEDED');assert.equal((await row()).status,'NOT_CONFIGURED');
  const session=await waitProbe();await db`UPDATE user_session SET revoked_at=now() WHERE id=${users.manager!.session}`;
  pending.shift()!();assert.equal((await session.promise).statusCode,403);assert.equal((await api('GET',path,undefined,'admin')).json().status,'NOT_CONFIGURED');
  const newToken=randomBytes(32).toString('hex');users.manager!.session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at)
    VALUES (${users.manager!.id},${sha256(newToken)},now()+interval '1 hour') RETURNING id`)[0]!.id;users.manager!.cookie='lop_session='+newToken;
  const disabled=await waitProbe();assert.equal((await api('POST',path+'/disable',{ version:4,reason:'Stop during OAuth' })).statusCode,200);
  pending.shift()!();assert.equal((await disabled.promise).json().state,'SUPERSEDED');const beforeDisable=calls;
  assert.equal((await api('POST',path+'/test',{ version:5 })).statusCode,409);assert.equal(calls,beforeDisable);
  assert.equal((await api('POST',path+'/reconnect',{ version:5,reason:'Retry authorized app pair' })).statusCode,200);
  behavior='OK';assert.equal((await api('POST',path+'/test',{ version:6 })).statusCode,200);
  // Production ignores test headers: rotating them cannot bypass the real IP limit.
  const beforeRate=calls;
  for(let n=0;n<11;n++) {
    const limited:{ statusCode:number;body:string;json:()=>{ error?:string } }=await app.inject({ method:'POST',url:path+'/test',payload:{ version:6 },remoteAddress:'127.0.18.1',
      headers:{ origin:process.env.APP_ORIGIN!,cookie:users.manager!.cookie,'x-e2e-rate-scope':'untrusted-'+n } });
    assert.equal(limited.statusCode,n<10 ? 200 : 429,limited.body);
    if(n===10)assert.equal(limited.json().error,'RATE_LIMITED');
  }
  assert.equal(calls,beforeRate+10);
  const history=(await api('GET',path+'/history?limit=2')).json();assert.equal(history.items.length,2);assert.ok(history.nextCursor);
  assert.notEqual((await api('GET',path+'/history?limit=2&cursor='+encodeURIComponent(history.nextCursor))).json().items[0].id,history.items[0].id);
  const publicText=JSON.stringify([await row(),(await api('GET',path+'/history?limit=100')).json(),(await api('GET',root,undefined,'admin')).json(),
    await db`SELECT detail FROM audit_log WHERE action LIKE 'PAYMENT_%'`]);
  for(const secret of [pair.clientId,pair.clientSecret,replacement.clientId,replacement.clientSecret,...tokens])assert.equal(publicText.includes(secret),false);
  await assert.rejects(db`UPDATE payment_connection_probe SET error_code=NULL WHERE id=${verified.json().probeId}`,/PAYMENT_PROBE_IMMUTABLE/);
  await assert.rejects(db`UPDATE integration_connection SET provider='STRIPE' WHERE id=${id}`,/PAYMENT_CONNECTION_IDENTITY_IMMUTABLE/);
});
