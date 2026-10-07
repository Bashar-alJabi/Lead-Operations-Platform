import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('PayPal expected beneficiary configuration is scoped, versioned and immutable without payee verification; concurrency, Audit rollback and current session fences preserve history',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const pair={ clientId:'BeneficiaryClientSynthetic_123456',clientSecret:'BeneficiarySecretSynthetic_123456' };let calls=0;
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> {
    calls++;assert.equal(target,'https://api-m.sandbox.paypal.com/v1/oauth2/token');assert.equal(init.method,'POST');
    return Response.json({ access_token:'BeneficiaryTokenSynthetic_123456',token_type:'Bearer',app_id:'APP-BeneficiarySynthetic123',expires_in:3600,private:pair.clientSecret });
  });
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('PayPal beneficiary') RETURNING id`)[0]!.id;
  const foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Foreign beneficiary') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope,userOrg] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',otherBranch,org],['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${userOrg},${scope},${name},${role},${name+'@beneficiary.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at) VALUES (${id},${sha256(token)},now()-interval '1 hour',now()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name]={ id,cookie:'lop_session='+token,session };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.23.${ip++}` });
  const root='/api/payments/connections';const a='ABCD234EFGH56';const b='JKLM234NPQR56';
  const input={ name:'Expected beneficiary <img src=x>',provider:'PAYPAL',config:{ mode:'TEST',expectedMerchantId:a },credentials:pair };
  for(const expectedMerchantId of [null,42,'','MERCHANTTEST1','abcd234efgh56','ABCD234EFGH5','ABCD234EFGHI2','ABCD234EFGHO2','ABCD234EFGH02','../../capture'])
    assert.equal((await api('POST',root,{ ...input,config:{ mode:'TEST',expectedMerchantId } })).statusCode,400);
  const stripe=await api('POST',root,{ ...input,provider:'STRIPE',credentials:{ apiKey:'rk_test_'+'SyntheticBeneficiaryOnly'.repeat(2) } });assert.equal(stripe.statusCode,400);assert.equal(calls,0);
  assert.equal((await api('POST',root,input,'agent')).statusCode,403);
  const made=await api('POST',root,input);assert.equal(made.statusCode,201,made.body);const id=made.json().id;const path=root+'/'+id;
  const row=async()=>(await api('GET',path,undefined,'admin')).json();
  const history=async()=>(await api('GET',path+'/beneficiary-history?limit=100')).json();
  assert.equal((await row()).config.expectedMerchantId,a);assert.equal((await row()).status,'NOT_CONFIGURED');assert.deepEqual((await row()).capabilities,{});
  const initialHistory=await history();assert.equal(initialHistory.identityStatus,'CONFIGURED_EXPECTATION');assert.equal(initialHistory.items.length,1);
  assert.equal(initialHistory.items[0].expected_merchant_id,a);assert.equal(initialHistory.items[0].actor_role,'MANAGER');assert.equal(initialHistory.items[0].connection_version,1);
  const initialSecret=(await db`SELECT ciphertext FROM connection_secret WHERE connection_id=${id}`)[0]!.ciphertext;
  for(const actor of ['agent','other','foreign']) {
    assert.equal((await api('GET',path+'/beneficiary-history',undefined,actor)).statusCode,actor==='agent' ? 403 : 404);
    assert.equal((await api('PUT',path,{ ...input,version:1 },actor)).statusCode,actor==='agent' ? 403 : 404);
  }
  const shared=await api('POST',root,{ ...input,name:'Shared expected beneficiary' },'admin');assert.equal(shared.statusCode,201);
  assert.equal((await api('GET',root+'/'+shared.json().id+'/beneficiary-history')).statusCode,404);
  assert.equal((await api('GET',root+'/'+shared.json().id+'/beneficiary-history',undefined,'admin')).json().items[0].actor_role,'SUPER_ADMIN');
  const concurrent=await Promise.all(Array.from({ length:8 },()=>api('PUT',path,{ name:input.name,provider:'PAYPAL',config:{ mode:'TEST',expectedMerchantId:b },version:1 })));
  assert.equal(concurrent.filter((r)=>r.statusCode===200).length,1);assert.equal(concurrent.filter((r)=>r.statusCode===409).length,7);
  assert.equal((await row()).version,2);assert.equal((await history()).items.length,2);assert.equal((await history()).items[0].expected_merchant_id,b);
  const tested=await api('POST',path+'/test',{ version:2 });assert.equal(tested.statusCode,200,tested.body);assert.equal(calls,1);
  assert.equal((await row()).capabilities.authenticationVerified,true);assert.equal((await row()).capabilities.paymentLinksReady,false);assert.equal((await row()).capabilities.paymentOptions,undefined);
  assert.equal((await api('PUT',path,{ name:'Authentication only',provider:'PAYPAL',config:{ mode:'TEST' },version:2 })).statusCode,200);
  assert.equal((await row()).config.expectedMerchantId,undefined);assert.deepEqual((await row()).capabilities,{});assert.equal((await history()).items[0].expected_merchant_id,null);
  assert.deepEqual((await db`SELECT ciphertext FROM connection_secret WHERE connection_id=${id}`)[0]!.ciphertext,initialSecret,'merchant edit retains encrypted credentials');
  let page=(await api('GET',path+'/beneficiary-history?limit=1')).json();const seen:string[]=[];
  while(page.items.length) { seen.push(page.items[0].id);if(!page.nextCursor)break;page=(await api('GET',path+'/beneficiary-history?limit=1&cursor='+encodeURIComponent(page.nextCursor))).json(); }
  assert.equal(new Set(seen).size,3);assert.equal(seen.length,3);assert.equal((await api('GET',path+'/beneficiary-history?limit=101')).statusCode,400);
  assert.equal((await api('GET',path+'/beneficiary-history?cursor=broken')).statusCode,400);
  const restored=await api('PUT',path,{ name:input.name,provider:'PAYPAL',config:input.config,version:3 });assert.equal(restored.statusCode,200);
  await db`CREATE FUNCTION test_beneficiary_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_BENEFICIARY_CONFIGURED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`;
  await db`CREATE TRIGGER test_beneficiary_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_beneficiary_audit_failure()`;
  try {
    const failed=await api('PUT',path,{ ...input,config:{ mode:'TEST',expectedMerchantId:b },version:4,credentials:{ clientId:'RotatedBeneficiaryClient_123456',clientSecret:'RotatedBeneficiarySecret_123456' } });
    assert.equal(failed.statusCode,500);assert.equal((await row()).version,4);assert.equal((await row()).config.expectedMerchantId,a);assert.equal((await history()).items.length,4);
    assert.deepEqual((await db`SELECT ciphertext FROM connection_secret WHERE connection_id=${id}`)[0]!.ciphertext,initialSecret);
  }finally { await db`DROP TRIGGER test_beneficiary_audit_failure ON audit_log`;await db`DROP FUNCTION test_beneficiary_audit_failure()`; }
  const record=(await history()).items[0];
  await assert.rejects(db`UPDATE payment_beneficiary_configuration SET expected_merchant_id=${b} WHERE id=${record.id}`,/PAYMENT_BENEFICIARY_HISTORY_RETAINED/);
  await assert.rejects(db`DELETE FROM payment_beneficiary_configuration WHERE id=${record.id}`,/PAYMENT_BENEFICIARY_HISTORY_RETAINED/);
  for(const [actor,merchant,version] of [['agent',a,4],['other',a,4],['manager',b,4],['manager',a,5]] as const) {
    await assert.rejects(db`INSERT INTO payment_beneficiary_configuration(connection_id,connection_version,mode,expected_merchant_id,actor_user_id,actor_role,actor_branch_id)
      SELECT ${id},${version},'TEST',${merchant},u.id,u.role,u.branch_id FROM user_account u WHERE u.id=${users[actor]!.id}`,
      /PAYMENT_BENEFICIARY_SCOPE_INVALID|check constraint/);
  }
  await assert.rejects(db`UPDATE integration_connection SET config=${db.json({ mode:'TEST',expectedMerchantId:b })} WHERE id=${id}`,/PAYMENT_BENEFICIARY_RECONFIGURATION_REQUIRED/);
  for(const expectedMerchantId of [null,42,'MERCHANTTEST1'])await assert.rejects(db`UPDATE integration_connection SET config=${db.json({ mode:'TEST',expectedMerchantId })},
    version=version+1,status='NOT_CONFIGURED',capabilities='{}',last_error_code=NULL WHERE id=${id}`,/payment_expected_merchant_valid/);
  let release!:()=>void;let locked!:()=>void;const ready=new Promise<void>((r)=>{ locked=r; });
  const holder=db.begin(async(tx)=>{ await tx`SELECT 1 FROM integration_connection WHERE id=${id} FOR UPDATE`;locked();await new Promise<void>((r)=>{ release=r; }); });await ready;
  const waiting=api('PUT',path,{ name:input.name,provider:'PAYPAL',config:{ mode:'TEST',expectedMerchantId:b },version:4 });await delay(75);
  try { await db`UPDATE user_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${users.manager!.session}`; }
  finally { release();await holder; }
  const expired=await waiting;assert.equal(expired.statusCode,403,expired.body);assert.equal((await row()).version,4);
  await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=${users.manager!.session}`;
  await db`UPDATE branch SET active=false WHERE id=${branch}`;
  assert.equal((await api('PUT',path,{ name:input.name,provider:'PAYPAL',config:input.config,version:4 })).statusCode,409);
  await db`UPDATE branch SET active=true WHERE id=${branch}`;
  assert.equal((await api('POST',path+'/disable',{ version:4,reason:'Preserve beneficiary history' })).statusCode,200);
  assert.equal((await api('PUT',path,{ ...input,version:5 })).statusCode,409);assert.equal((await history()).items.length,4);
  assert.equal((await api('POST',path+'/reconnect',{ version:5,reason:'Retain configured expectation only' })).statusCode,200);
  assert.equal((await row()).config.expectedMerchantId,a);assert.deepEqual((await row()).capabilities,{});
  const publicText=JSON.stringify([await row(),await history(),await db`SELECT detail FROM audit_log WHERE target_id=${id}`]);
  for(const secret of [pair.clientId,pair.clientSecret,'BeneficiaryTokenSynthetic_123456'])assert.equal(publicText.includes(secret),false);
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_record`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM enrollment`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_link_intent`)[0]!.n,0);assert.equal(calls,1);
});
