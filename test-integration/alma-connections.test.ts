import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { openSecret } from '../src/credentials.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Alma actual merchant probe preserves encrypted scoped lifecycle, immutable identity evidence and current session/config/latest fences without financial readiness',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const credentials={ apiKey:'AlmaIntegrationSyntheticKeyOnly_123456' };const replacement={ apiKey:'AlmaRotatedSyntheticKeyOnly_123456' };
  const merchant='merchant_IntegrationSynthetic123';const rotatedMerchant='merchant_RotatedSynthetic456';
  let behavior:'OK'|'AUTH'|'WAIT'='OK';let calls=0;const pending:(()=>void)[]=[];
  t.mock.method(globalThis,'fetch',async(target:string,options:RequestInit)=> {
    calls++;assert.ok(['https://api.sandbox.getalma.eu/v1/me/extended-data','https://api.sandbox.getalma.eu/v1/me/fee-plans?kind=general&only=all&deferred=true'].includes(target));assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');assert.ok(options.signal);assert.equal(options.body,undefined);
    const header=(options.headers as Record<string,string>).authorization;
    assert.ok([credentials,replacement].some((c)=>header==='Alma-Auth '+c.apiKey));const mode=behavior;
    if(mode==='WAIT')await new Promise<void>((resolve)=>pending.push(resolve));if(mode==='AUTH')return new Response(credentials.apiKey,{ status:401 });
    if(target.includes('/fee-plans'))return new Response(JSON.stringify([{ kind:'general',installments_count:3,deferred_months:0,deferred_days:0,allowed:true,min_purchase_amount:10000,max_purchase_amount:300000,private:'private bank account' },
      { kind:'general',installments_count:1,deferred_months:0,deferred_days:30,allowed:false,min_purchase_amount:5000,max_purchase_amount:100000 }]));
    return new Response(JSON.stringify({ id:header==='Alma-Auth '+replacement.apiKey ? rotatedMerchant : merchant,
      name:'private business name',bank_account:'private bank account',email:'private@alma.test',can_create_payments:true,
      fee_plans:[{ installments_count:3,allowed:true }],payment_status:'pretend captured' }));
  });
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=>{ pending.forEach((release)=>release());await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Alma') RETURNING id`)[0]!.id;
  const foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Foreign') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope,userOrg] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',otherBranch,org],['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${userOrg},${scope},${name},${role},${name+'@alma.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name]={ id,cookie:'lop_session='+token,session };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.27.${ip++}` });
  const root='/api/payments/connections';const input={ name:'Alma <img src=x>',provider:'ALMA',config:{ mode:'TEST' },credentials };
  for(const value of [{ clientId:'SyntheticPair123456',clientSecret:'SyntheticPair123456' },{ ...credentials,clientSecret:'SyntheticPair123456' },{ apiKey:'bad\nheader'.repeat(3) }])
    assert.equal((await api('POST',root,{ ...input,credentials:value })).statusCode,400);
  assert.equal((await api('POST',root,{ ...input,config:{ mode:'TEST',expectedMerchantId:'ABCD234EFGH56' } })).statusCode,400);
  assert.equal((await api('POST',root,input,'agent')).statusCode,403);assert.equal((await api('POST',root,{ ...input,branchId:otherBranch })).statusCode,403);assert.equal(calls,0);
  const made=await api('POST',root,input);assert.equal(made.statusCode,201,made.body);const id=made.json().id as string;const path=root+'/'+id;
  const shared=await api('POST',root,{ ...input,name:'Shared merchant' },'admin');assert.equal(shared.statusCode,201);assert.equal((await api('GET',root+'/'+shared.json().id)).statusCode,404);
  for(const actor of ['other','foreign','agent']) {
    assert.equal((await api('GET',path,undefined,actor)).statusCode,actor==='agent' ? 403 : 404);
    assert.equal((await api('GET',path+'/history',undefined,actor)).statusCode,actor==='agent' ? 403 : 404);
    assert.equal((await api('POST',path+'/test',{ version:1 },actor)).statusCode,actor==='agent' ? 403 : 404);
    assert.equal((await api('POST',path+'/test',{ version:1,inspectOffers:true },actor)).statusCode,actor==='agent' ? 403 : 404);
  }
  const secret=async()=>(await db`SELECT * FROM connection_secret WHERE connection_id=${id}`)[0]!;
  const initial=await secret();assert.equal(initial.ciphertext.toString().includes(credentials.apiKey),false);
  assert.deepEqual(JSON.parse(openSecret(id,{ ciphertext:initial.ciphertext,nonce:initial.nonce,authTag:initial.auth_tag,keyVersion:initial.key_version })),credentials);
  const row=async()=>(await api('GET',path)).json();const verified=await api('POST',path+'/test',{ version:1 });assert.equal(verified.statusCode,200,verified.body);
  const snapshot={ schemaVersion:1,profile:'ALMA_ME_V1',accountRef:merchant,mode:'TEST' };
  assert.equal((await row()).status,'WARNING');assert.deepEqual((await row()).capabilities.authentication,snapshot);assert.equal((await row()).capabilities.authenticationVersion,1);
  for(const key of ['paymentLinksReady','webhookReady'])assert.equal((await row()).capabilities[key],false);
  assert.equal((await row()).capabilities.paymentOptions,undefined);
  const proof=(await db`SELECT * FROM payment_connection_probe WHERE id=${verified.json().probeId}`)[0]!;
  assert.equal(proof.actor_session_id,users.manager!.session);assert.deepEqual(proof.authentication_snapshot,snapshot);
  await assert.rejects(db`UPDATE payment_connection_probe SET authentication_snapshot=${db.json({ ...snapshot,accountRef:rotatedMerchant })} WHERE id=${proof.id}`,/PAYMENT_PROBE_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM payment_connection_probe WHERE id=${proof.id}`,/PAYMENT_PROBE_HISTORY_RETAINED/);
  assert.equal((await api('POST',path+'/test',{ version:1,inspectOffers:true,inspectOptions:true })).statusCode,400);
  const inspected=await api('POST',path+'/test',{ version:1,inspectOffers:true });assert.equal(inspected.statusCode,200,inspected.body);
  const currentOffers=(await row()).capabilities.merchantOffers;assert.equal(currentOffers.profile,'ALMA_FEE_PLANS_V1');assert.equal(currentOffers.accountRef,merchant);
  assert.deepEqual(currentOffers.plans.map((p:any)=>p.installments),[1,3]);assert.equal(currentOffers.plans[0].allowed,false);assert.equal((await row()).capabilities.merchantOffersVersion,1);
  assert.equal((await row()).capabilities.paymentLinksReady,false);assert.equal(currentOffers.currencies,undefined);
  const offersProof=(await db`SELECT * FROM payment_connection_probe WHERE id=${inspected.json().probeId}`)[0]!;
  assert.equal(offersProof.purpose,'OFFERS');assert.deepEqual(offersProof.offers_snapshot,currentOffers);assert.deepEqual(offersProof.authentication_snapshot,snapshot);
  await assert.rejects(db`UPDATE payment_connection_probe SET offers_snapshot=${db.json({ ...currentOffers,plans:[] })} WHERE id=${offersProof.id}`,/PAYMENT_PROBE_IMMUTABLE/);
  assert.equal((await api('POST',path+'/test',{ version:1 })).statusCode,200);assert.deepEqual((await row()).capabilities.merchantOffers,currentOffers,'same-current-merchant authentication retains offers');
  await assert.rejects(db`UPDATE integration_connection SET provider='PAYPAL' WHERE id=${id}`,/PAYMENT_CONNECTION_IDENTITY_IMMUTABLE/);
  await assert.rejects(db`INSERT INTO integration_connection(organization_id,kind,provider,name,config) VALUES (${org},'PAYMENT','ALMA','bad config','{"mode":"TEST","url":"https://foreign.test"}')`,/alma_connection_config_valid/);
  await assert.rejects(db`INSERT INTO payment_connection_probe(connection_id,connection_version,actor_user_id,actor_role,actor_branch_id)
    VALUES (${id},1,${users.manager!.id},'MANAGER',${branch})`,/PAYMENT_PROBE_SESSION_REQUIRED/);
  await assert.rejects(db`INSERT INTO payment_connection_probe(connection_id,connection_version,actor_user_id,actor_role,actor_branch_id,actor_session_id)
    VALUES (${id},1,${users.manager!.id},'MANAGER',${branch},${users.other!.session})`,/PAYMENT_AUTHENTICATION_SCOPE_INVALID/);
  const native=(await db`INSERT INTO payment_connection_probe(connection_id,connection_version,actor_user_id,actor_role,actor_branch_id,actor_session_id)
    VALUES (${id},1,${users.manager!.id},'MANAGER',${branch},${users.manager!.session}) RETURNING id`)[0]!.id;
  for(const value of [null,{ ...snapshot,mode:'LIVE' },{ ...snapshot,secret:credentials.apiKey },{ ...snapshot,accountRef:'../foreign' }])
    await assert.rejects(db`UPDATE payment_connection_probe SET state='VERIFIED',authentication_snapshot=${value ? db.json(value) : null},finished_at=clock_timestamp() WHERE id=${native}`,/PAYMENT_AUTHENTICATION_PROFILE_INVALID|payment_authentication_snapshot_valid/);
  await assert.rejects(db`UPDATE payment_connection_probe SET actor_session_id=${users.admin!.session},state='FAILED',error_code='TEST',finished_at=clock_timestamp() WHERE id=${native}`,/PAYMENT_PROBE_SESSION_IMMUTABLE/);
  const nativeOffers=(await db`INSERT INTO payment_connection_probe(connection_id,connection_version,actor_user_id,actor_role,actor_branch_id,actor_session_id,purpose)
    VALUES (${id},1,${users.manager!.id},'MANAGER',${branch},${users.manager!.session},'OFFERS') RETURNING id`)[0]!.id;
  for(const value of [null,{ ...currentOffers,accountRef:rotatedMerchant },{ ...currentOffers,plans:[currentOffers.plans[0],currentOffers.plans[0]] },{ ...currentOffers,currency:'EUR' }])
    await assert.rejects(db`UPDATE payment_connection_probe SET state='VERIFIED',authentication_snapshot=${db.json(snapshot)},offers_snapshot=${value ? db.json(value) : null},finished_at=clock_timestamp() WHERE id=${nativeOffers}`,/payment_merchant_offers_valid/);
  // Four read-only requests finish together; only the latest admitted probe may publish current identity.
  behavior='WAIT';const probes=Array.from({ length:4 },()=>api('POST',path+'/test',{ version:1 }));
  for(let n=0;n<100 && pending.length<4;n++)await delay(5);assert.equal(pending.length,4);pending.splice(0).forEach((release)=>release());
  const results=await Promise.all(probes);assert.equal(results.filter((r)=>r.json().state==='VERIFIED').length,1);
  assert.equal(results.filter((r)=>r.json().state==='SUPERSEDED').length,3);
  await assert.rejects(db`UPDATE payment_connection_probe SET state='VERIFIED',authentication_snapshot=${db.json(snapshot)},finished_at=clock_timestamp() WHERE id=${native}`,/PAYMENT_AUTHENTICATION_SUPERSEDED/);
  behavior='OK';const beforeOptions=calls;const options=await api('POST',path+'/test',{ version:1,inspectOptions:true });assert.equal(options.statusCode,502);
  assert.equal(options.json().error,'PAYMENT_PROVIDER_OPTIONS_UNSUPPORTED');assert.equal(calls,beforeOptions);assert.deepEqual((await row()).capabilities,{});
  assert.equal((await api('POST',path+'/webhooks',{ connectionVersion:1,reason:'Authentication is not IPN readiness' })).statusCode,409);
  behavior='AUTH';const denied=await api('POST',path+'/test',{ version:1 });assert.equal(denied.statusCode,502);assert.equal(denied.json().error,'PAYMENT_PROVIDER_AUTH_FAILED');
  assert.equal((await row()).status,'AUTH_EXPIRED');assert.equal(denied.body.includes(credentials.apiKey),false);assert.equal((await api('GET','/api/leads')).statusCode,200);
  const retained=await api('PUT',path,{ name:'Retain secure key',provider:'ALMA',config:{ mode:'TEST' },version:1 });assert.equal(retained.statusCode,200);
  assert.deepEqual((await secret()).ciphertext,initial.ciphertext);
  const rotate=await api('PUT',path,{ ...input,credentials:replacement,version:2 });assert.equal(rotate.statusCode,200);assert.notDeepEqual((await secret()).ciphertext,initial.ciphertext);
  assert.deepEqual((await row()).capabilities,{});assert.equal((await api('PUT',path,{ ...input,version:2 })).statusCode,409);
  behavior='OK';assert.equal((await api('POST',path+'/test',{ version:3 })).statusCode,200);assert.equal((await row()).capabilities.authentication.accountRef,rotatedMerchant);
  const waitProbe=async()=>{ behavior='WAIT';const promise=api('POST',path+'/test',{ version:(await row()).version });
    for(let n=0;n<100 && pending.length===0;n++)await delay(5);assert.equal(pending.length,1);return { promise }; };
  const changing=await waitProbe();assert.equal((await api('PUT',path,{ name:'Updated during GET',provider:'ALMA',config:{ mode:'TEST' },version:3 })).statusCode,200);
  pending.shift()!();assert.equal((await changing.promise).json().state,'SUPERSEDED');assert.equal((await row()).status,'NOT_CONFIGURED');
  const revoked=await waitProbe();await db`UPDATE user_session SET revoked_at=now() WHERE id=${users.manager!.session}`;
  pending.shift()!();const revokedResult=await revoked.promise;assert.equal(revokedResult.statusCode,403);assert.equal(revokedResult.json().state,'BLOCKED');
  const newToken=randomBytes(32).toString('hex');users.manager!.session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at)
    VALUES (${users.manager!.id},${sha256(newToken)},now()+interval '1 hour') RETURNING id`)[0]!.id;users.manager!.cookie='lop_session='+newToken;
  const expired=await waitProbe();await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '25 milliseconds' WHERE id=${users.manager!.session}`;await delay(50);
  pending.shift()!();assert.equal((await expired.promise).statusCode,403);
  await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=${users.manager!.session}`;
  const role=await waitProbe();await db`UPDATE user_account SET role='AGENT' WHERE id=${users.manager!.id}`;
  pending.shift()!();assert.equal((await role.promise).statusCode,403);await db`UPDATE user_account SET role='MANAGER' WHERE id=${users.manager!.id}`;
  const disabled=await waitProbe();assert.equal((await api('POST',path+'/disable',{ version:4,reason:'Stop while GET runs' })).statusCode,200);
  pending.shift()!();assert.equal((await disabled.promise).json().state,'SUPERSEDED');const beforeDisable=calls;
  assert.equal((await api('POST',path+'/test',{ version:5 })).statusCode,409);assert.equal(calls,beforeDisable);
  assert.equal((await api('POST',path+'/reconnect',{ version:5,reason:'Reconnect secure merchant' })).statusCode,200);
  behavior='OK';assert.equal((await api('POST',path+'/test',{ version:6 })).statusCode,200);
  const current=await row();
  await db`CREATE FUNCTION test_fail_alma_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='PAYMENT_CONNECTION_TEST_FINISHED' THEN RAISE EXCEPTION 'TEST_AUDIT_FAIL'; END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER test_fail_alma_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_alma_audit()`;
  try {
    const failed=await api('POST',path+'/test',{ version:6,inspectOffers:true });assert.equal(failed.statusCode,500);
    assert.deepEqual((await row()).capabilities,current.capabilities,'published identity rolls back with audit');
    const latest=(await db`SELECT state,authentication_snapshot FROM payment_connection_probe WHERE connection_id=${id} ORDER BY probe_number DESC LIMIT 1`)[0]!;
    assert.equal(latest.state,'RUNNING');assert.equal(latest.authentication_snapshot,null);
  } finally { await db`DROP TRIGGER test_fail_alma_audit ON audit_log`;await db`DROP FUNCTION test_fail_alma_audit()`; }
  assert.equal((await api('POST',path+'/test',{ version:6 })).statusCode,200);
  const history=(await api('GET',path+'/history?limit=2')).json();assert.equal(history.items.length,2);assert.ok(history.nextCursor);
  assert.notEqual((await api('GET',path+'/history?limit=2&cursor='+encodeURIComponent(history.nextCursor))).json().items[0].id,history.items[0].id);
  const records=(await api('GET',path+'/history?limit=100')).json().items;assert.ok(records.some((p:any)=>p.authentication_snapshot?.accountRef===merchant && p.connection_version===1));
  assert.ok(records.some((p:any)=>p.authentication_snapshot?.accountRef===rotatedMerchant && p.connection_version===6));
  const publicText=JSON.stringify([await row(),records,(await api('GET',root,undefined,'admin')).json(),await db`SELECT detail FROM audit_log WHERE action LIKE 'PAYMENT_%'`]);
  for(const privateValue of [credentials.apiKey,replacement.apiKey,'private business name','private bank account','private@alma.test','pretend captured'])assert.equal(publicText.includes(privateValue),false);
  for(const table of ['payment_link_intent','payment_record','enrollment','payment_capture_job'])assert.equal((await db`SELECT count(*)::integer AS n FROM ${db(table)}`)[0]!.n,0);
});
