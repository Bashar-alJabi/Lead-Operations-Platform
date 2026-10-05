import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { openSecret } from '../src/credentials.js';
import { PaymentProviderError } from '../src/payments/providers.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Payment Connection authentication lifecycle encrypts credentials, fences roles/sessions/config/latest probes and retains safe failure history',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  let mode:'OK'|'AUTH'|'UNSAFE'|'WAIT'='OK';let calls=0;const pending:(()=>void)[]=[];
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,paymentConnectionAdapters:{ STRIPE:{ verify:async(config)=> {
    calls++;const behavior=mode;if(behavior==='WAIT')await new Promise<void>((resolve)=>pending.push(resolve));
    if(behavior==='AUTH')throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');if(behavior==='UNSAFE')throw new Error('unsafe-provider-secret');return { mode:config.mode };
  } } } });t.after(async()=>{ pending.forEach((release)=>release());await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Payments') RETURNING id`)[0]!.id;
  const foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Foreign') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope,userOrg] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',otherBranch,org],['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash)
      VALUES (${userOrg},${scope},${name},${role},${name+'@payments.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at)
      VALUES (${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={ id,cookie:'lop_session='+token,session };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.7.${ip++}` });
  const key='rk_test_'+ 'dedicatedSynthetic'.repeat(3);
  const input={ name:'Branch account <img src=x>',provider:'STRIPE',config:{ mode:'TEST' },credentials:{ apiKey:key } };
  const root='/api/payments/connections';
  assert.equal((await api('POST',root,input,'agent')).statusCode,403);
  assert.equal((await api('POST',root,{ ...input,branchId:otherBranch })).statusCode,403);
  assert.equal((await api('POST',root,{ ...input,branchId:null })).statusCode,403);
  assert.equal((await api('POST',root,{ ...input,credentials:{ apiKey:'pk_test_'+ 'x'.repeat(24) } })).statusCode,400);
  const made=await api('POST',root,input);assert.equal(made.statusCode,201,made.body);const id=made.json().id as string;const path=root+'/'+id;
  const shared=await api('POST',root,{ ...input,name:'Organization account' },'admin');assert.equal(shared.statusCode,201,shared.body);
  assert.equal((await api('GET',root)).json().items.length,1);
  assert.equal((await api('GET',root,undefined,'admin')).json().items.length,2);
  assert.equal((await api('GET',root+'/'+shared.json().id)).statusCode,404);
  for(const actor of ['other','foreign','agent']) {
    assert.equal((await api('GET',path,undefined,actor)).statusCode,actor==='agent' ? 403 : 404);
    assert.equal((await api('POST',path+'/test',{ version:1 },actor)).statusCode,actor==='agent' ? 403 : 404);
  }
  const secret=(await db`SELECT * FROM connection_secret WHERE connection_id=${id}`)[0]!;
  assert.equal(secret.ciphertext.toString().includes(key),false);
  assert.deepEqual(JSON.parse(openSecret(id,{ ciphertext:secret.ciphertext,nonce:secret.nonce,authTag:secret.auth_tag,keyVersion:secret.key_version })),input.credentials);
  const row=async()=>(await api('GET',path)).json();
  assert.equal((await row()).secret_configured,true);assert.equal(JSON.stringify(await row()).includes(key),false);
  const tested=await api('POST',path+'/test',{ version:1 });assert.equal(tested.statusCode,200,tested.body);assert.equal(tested.json().state,'VERIFIED');
  assert.equal((await row()).status,'WARNING');assert.equal((await row()).capabilities.authenticationVerified,true);
  assert.equal((await row()).capabilities.paymentLinksReady,false);assert.equal((await row()).capabilities.webhookReady,false);assert.equal((await row()).last_error_code,'PAYMENT_FLOW_NOT_READY');
  mode='AUTH';const failed=await api('POST',path+'/test',{ version:1 });assert.equal(failed.statusCode,502);assert.equal(failed.json().error,'PAYMENT_PROVIDER_AUTH_FAILED');assert.equal((await row()).status,'AUTH_EXPIRED');
  mode='UNSAFE';const unsafe=await api('POST',path+'/test',{ version:1 });assert.equal(unsafe.json().error,'PAYMENT_PROVIDER_UNAVAILABLE');assert.equal(unsafe.body.includes('unsafe-provider-secret'),false);
  assert.equal((await api('GET','/api/leads')).statusCode,200,'Core CRM remains available during payment provider failures');
  const probes=(await api('GET',path+'/history?limit=1')).json();assert.equal(probes.items.length,1);assert.ok(probes.nextCursor);
  assert.notEqual((await api('GET',path+'/history?limit=1&cursor='+encodeURIComponent(probes.nextCursor))).json().items[0].id,probes.items[0].id);
  assert.equal((await api('GET',path+'/history',undefined,'other')).statusCode,404);
  await assert.rejects(db`UPDATE payment_connection_probe SET error_code=NULL WHERE id=${tested.json().probeId}`,/PAYMENT_PROBE_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM payment_connection_probe WHERE id=${tested.json().probeId}`,/PAYMENT_PROBE_HISTORY_RETAINED/);
  assert.equal((await api('PUT',path,{ name:'Retained',provider:'STRIPE',config:{ mode:'LIVE' },version:1 })).statusCode,400,'retained TEST key cannot become LIVE');
  assert.equal((await api('PUT',path,{ name:'Retained',provider:'STRIPE',config:{ mode:'TEST' },version:1,branchId:otherBranch })).statusCode,400);
  assert.equal((await api('PUT',path,{ name:'Retained',provider:'STRIPE',config:{ mode:'TEST' },version:1 })).statusCode,200);
  assert.equal((await row()).version,2);assert.equal((await row()).status,'NOT_CONFIGURED');assert.deepEqual((await db`SELECT ciphertext FROM connection_secret WHERE connection_id=${id}`)[0]!.ciphertext,secret.ciphertext);
  const replacement='rk_test_'+ 'rotatedSynthetic'.repeat(3);
  const rotated=await api('PUT',path,{ ...input,name:'Rotated',credentials:{ apiKey:replacement },version:2 });assert.equal(rotated.statusCode,200,rotated.body);
  assert.notDeepEqual((await db`SELECT ciphertext FROM connection_secret WHERE connection_id=${id}`)[0]!.ciphertext,secret.ciphertext);
  assert.equal((await api('PUT',path,{ ...input,version:2 })).statusCode,409);
  const startWait=async()=>{ mode='WAIT';const promise=api('POST',path+'/test',{ version:(await row()).version });
    for(let n=0;n<100 && pending.length===0;n++)await delay(5);assert.equal(pending.length,1);return { promise }; };
  const late=await startWait();mode='AUTH';const newest=await api('POST',path+'/test',{ version:3 });assert.equal(newest.statusCode,502);
  pending.shift()!();assert.equal((await late.promise).json().state,'SUPERSEDED');assert.equal((await row()).status,'AUTH_EXPIRED','late success cannot overwrite a newer failure');
  const configRace=await startWait();assert.equal((await api('PUT',path,{ name:'Updated during I/O',provider:'STRIPE',config:{ mode:'TEST' },version:3 })).statusCode,200);
  pending.shift()!();assert.equal((await configRace.promise).json().state,'SUPERSEDED');assert.equal((await row()).status,'NOT_CONFIGURED');
  const sessionRace=await startWait();await db`UPDATE user_session SET revoked_at=now() WHERE id=${users.manager!.session}`;
  pending.shift()!();const revoked=await sessionRace.promise;assert.equal(revoked.statusCode,403);assert.equal(revoked.json().state,'BLOCKED');
  assert.equal((await api('GET',path,undefined,'admin')).json().status,'NOT_CONFIGURED');
  const newToken=randomBytes(32).toString('hex');await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at) VALUES (${users.manager!.id},${sha256(newToken)},now()-interval '1 hour',now()+interval '1 hour')`;
  users.manager!.cookie='lop_session='+newToken;
  const expiryRace=await startWait();await db`UPDATE user_session SET expires_at=now()-interval '1 second' WHERE token_hash=${sha256(newToken)}`;
  pending.shift()!();assert.equal((await expiryRace.promise).statusCode,403);
  await db`UPDATE user_session SET expires_at=now()+interval '1 hour' WHERE token_hash=${sha256(newToken)}`;
  const roleRace=await startWait();await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;
  pending.shift()!();assert.equal((await roleRace.promise).statusCode,403);await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;
  const disableRace=await startWait();const disabled=await api('POST',path+'/disable',{ version:4,reason:'Stop during authentication' });assert.equal(disabled.statusCode,200);
  pending.shift()!();assert.equal((await disableRace.promise).json().state,'SUPERSEDED');assert.equal((await row()).status,'DISABLED');
  const before=calls;assert.equal((await api('POST',path+'/test',{ version:5 })).statusCode,409);assert.equal(calls,before);
  assert.equal((await api('PUT',path,{ ...input,version:5 })).statusCode,409);
  await db`UPDATE branch SET active=false WHERE id=${branch}`;
  assert.equal((await api('POST',path+'/reconnect',{ version:5,reason:'Cannot reactivate disabled branch' })).statusCode,409);
  await db`UPDATE branch SET active=true WHERE id=${branch}`;
  const reconnect=await api('POST',path+'/reconnect',{ version:5,reason:'Test replacement before use' });assert.equal(reconnect.statusCode,200);assert.equal(reconnect.json().version,6);
  mode='OK';assert.equal((await api('POST',path+'/test',{ version:6 })).statusCode,200);
  const interrupted=(await db`INSERT INTO payment_connection_probe(connection_id,connection_version,actor_user_id,actor_role,actor_branch_id,created_at,expires_at)
    VALUES (${id},6,${users.manager!.id},'MANAGER',${branch},now()-interval '60 seconds',now()-interval '30 seconds') RETURNING id`)[0]!.id;
  const history=(await api('GET',path+'/history?limit=100')).json();assert.equal(history.items.find((p:{ id:string })=>p.id===interrupted).state,'INTERRUPTED');
  assert.equal(JSON.stringify(history).includes(replacement),false);
  assert.equal((await db`SELECT detail::text AS detail FROM audit_log WHERE action LIKE 'PAYMENT_%'`).some((r)=>r.detail.includes(key) || r.detail.includes(replacement) || r.detail.includes('unsafe-provider-secret')),false);
  const pageOne=(await api('GET',root+'?limit=1',undefined,'admin')).json();assert.ok(pageOne.nextCursor);
  const pageTwo=(await api('GET',root+'?limit=1&cursor='+encodeURIComponent(pageOne.nextCursor),undefined,'admin')).json();assert.notEqual(pageOne.items[0].id,pageTwo.items[0].id);
});
