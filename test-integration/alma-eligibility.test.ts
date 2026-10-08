import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('Alma actual amount-specific eligibility preserves immutable money-plan evidence, current identity/session/config, scopes, concurrent publication and atomic audit without financial records',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const credentials={ apiKey:'AlmaIntegrationEligibilityKeyOnly_123456' };const merchant='merchant_EligibilitySynthetic123';
  let behavior:'OK'|'WAIT'|'AUTH'|'MISMATCH'|'PLAN'='OK';let calls=0;const pending:(()=>void)[]=[];
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> {
    calls++;assert.equal(init.redirect,'error');assert.ok(init.signal);assert.equal(new Headers(init.headers).get('authorization'),'Alma-Auth '+credentials.apiKey);
    const mode=behavior;if(mode==='WAIT')await new Promise<void>((resolve)=>pending.push(resolve));if(mode==='AUTH')return new Response(credentials.apiKey,{ status:401 });
    if(target.endsWith('/extended-data')){ assert.equal(init.method,'GET');return new Response(JSON.stringify({ id:mode==='MISMATCH' ? 'merchant_ForeignSynthetic' : merchant,bank_account:'private bank' })); }
    assert.equal(target,'https://api.sandbox.getalma.eu/v2/payments/eligibility');assert.equal(init.method,'POST');
    const body=JSON.parse(init.body as string);assert.equal(body.origin,'online');assert.equal(body.queries.length,1);assert.equal(body.purchase_amount,Math.floor(body.purchase_amount));
    const query=body.queries[0];return new Response(JSON.stringify([{ ...query,installments_count:mode==='PLAN' ? 4 : query.installments_count,
      eligible:body.purchase_amount>=10000 && body.purchase_amount<=300000,customer_total_cost_amount:100,payment_plan:[{ bank:'private bank' }],reasons:{ internal:'private reason' } }]));
  });
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=>{ pending.forEach((release)=>release());await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Eligibility test') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'Eligibility branch') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'Other branch') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;session:string;cookie:string }>={};
  for(const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['other','MANAGER',otherBranch],['agent','AGENT',branch]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${org},${scope},${name},${role},${name+'@eligibility.test'},'not login password') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name]={ id,session,cookie:'lop_session='+token };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor='manager')=>app.inject({ method,url:path,payload,headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.28.${ip++}` });
  const root='/api/payments/connections';const made=await api('POST',root,{ name:'Alma eligibility',provider:'ALMA',credentials,config:{ mode:'TEST' } });assert.equal(made.statusCode,201,made.body);
  const id=made.json().id;const path=root+'/'+id;const plan={ installments:3,deferredMonths:0,deferredDays:0 };const eligibility={ amount:'100',currency:'EUR',plan };const input={ version:1,eligibility };
  const row=async()=>(await api('GET',path)).json();
  assert.equal((await api('POST',path+'/test',input)).statusCode,409);assert.equal(calls,0);
  assert.equal((await api('POST',path+'/test',{ version:1 })).statusCode,200);
  for(const actor of ['other','agent'])assert.equal((await api('POST',path+'/test',input,actor)).statusCode,actor==='agent' ? 403 : 404);
  for(const patch of [{ amount:'1.001' },{ amount:'0' },{ amount:'21474836.48' },{ currency:'USD' },{ plan:{ ...plan,installments:0 } },{ eligible:true }])assert.equal((await api('POST',path+'/test',{ ...input,eligibility:{ ...eligibility,...patch } })).statusCode,400);
  assert.equal((await api('POST',path+'/test',{ ...input,inspectOffers:true })).statusCode,400);assert.equal((await api('POST',path+'/test',{ ...input,version:2 })).statusCode,409);assert.equal(calls,1);
  const inspected=await api('POST',path+'/test',input);assert.equal(inspected.statusCode,200,inspected.body);
  const current=(await row()).capabilities.paymentEligibility;assert.equal(current.eligible,true);assert.equal(current.accountRef,merchant);assert.equal(current.money.amount,'100.00');assert.equal(current.money.minor,'10000');assert.deepEqual(current.plan,plan);
  assert.equal((await row()).capabilities.paymentLinksReady,false);assert.equal((await row()).capabilities.paymentEligibilityVersion,1);
  const proof=(await db`SELECT * FROM payment_connection_probe WHERE id=${inspected.json().probeId}`)[0]!;assert.equal(proof.purpose,'ELIGIBILITY');assert.deepEqual(proof.eligibility_snapshot,current);
  assert.deepEqual(proof.eligibility_request,{ money:current.money,plan });assert.equal(proof.actor_session_id,users.manager!.session);
  await assert.rejects(db`UPDATE payment_connection_probe SET eligibility_snapshot=${db.json({ ...current,eligible:false })} WHERE id=${proof.id}`,/PAYMENT_PROBE_IMMUTABLE/);
  assert.equal((await api('POST',path+'/test',{ ...input,eligibility:{ ...eligibility,amount:'50' } })).statusCode,200);assert.equal((await row()).capabilities.paymentEligibility.eligible,false);
  assert.equal((await row()).status,'WARNING','a successfully assessed ineligible offer is not an authentication or payment failure');
  for(const value of [null,{ money:{ ...current.money,minor:'9999' },plan },{ money:{ ...current.money,currency:'USD' },plan },{ money:current.money,plan:{ ...plan,installments:0 } }]) {
    await assert.rejects(db`INSERT INTO payment_connection_probe(connection_id,connection_version,actor_user_id,actor_role,actor_branch_id,actor_session_id,purpose,eligibility_request)
      VALUES (${id},1,${users.manager!.id},'MANAGER',${branch},${users.manager!.session},'ELIGIBILITY',${value ? db.json(value) : null})`,/payment_eligibility_evidence_valid/);
  }
  const native=(await db`INSERT INTO payment_connection_probe(connection_id,connection_version,actor_user_id,actor_role,actor_branch_id,actor_session_id,purpose,eligibility_request)
    VALUES (${id},1,${users.manager!.id},'MANAGER',${branch},${users.manager!.session},'ELIGIBILITY',${db.json(proof.eligibility_request)}) RETURNING id`)[0]!.id;
  await assert.rejects(db`UPDATE payment_connection_probe SET eligibility_request=${db.json({ money:{ ...current.money,amount:'101.00',minor:'10100' },plan })},state='FAILED',error_code='TEST',finished_at=clock_timestamp() WHERE id=${native}`,/PAYMENT_PROBE_INPUT_IMMUTABLE/);
  for(const value of [null,{ ...current,eligible:1 },{ ...current,plan:{ ...plan,installments:4 } },{ ...current,money:{ ...current.money,minor:'9999' } },{ ...current,secret:credentials.apiKey }])
    await assert.rejects(db`UPDATE payment_connection_probe SET state='VERIFIED',authentication_snapshot=${db.json(proof.authentication_snapshot)},eligibility_snapshot=${value ? db.json(value) : null},finished_at=clock_timestamp() WHERE id=${native}`,
      value===null ? /PAYMENT_ELIGIBILITY_IDENTITY_INVALID/ : /payment_eligibility_evidence_valid/);
  await assert.rejects(db`UPDATE payment_connection_probe SET state='VERIFIED',authentication_snapshot=${db.json({ ...proof.authentication_snapshot,accountRef:'merchant_ForeignSynthetic' })},
    eligibility_snapshot=${db.json({ ...current,accountRef:'merchant_ForeignSynthetic' })},finished_at=clock_timestamp() WHERE id=${native}`,/PAYMENT_ELIGIBILITY_IDENTITY_INVALID/);
  // Concurrent reads finish out of order: only the latest admitted assessment publishes.
  behavior='WAIT';const concurrent=Array.from({ length:4 },()=>api('POST',path+'/test',input));
  for(let n=0;n<100 && pending.length<4;n++)await delay(5);assert.equal(pending.length,4);behavior='OK';pending.splice(0).forEach((release)=>release());
  const results=await Promise.all(concurrent);assert.equal(results.filter((r)=>r.json().state==='VERIFIED').length,1);assert.equal(results.filter((r)=>r.json().state==='SUPERSEDED').length,3);
  behavior='PLAN';assert.equal((await api('POST',path+'/test',input)).json().error,'PAYMENT_PROVIDER_RESPONSE_INVALID');assert.deepEqual((await row()).capabilities,{});
  behavior='OK';assert.equal((await api('POST',path+'/test',{ version:1 })).statusCode,200);
  behavior='MISMATCH';assert.equal((await api('POST',path+'/test',input)).json().error,'PAYMENT_PROVIDER_RESPONSE_INVALID');assert.deepEqual((await row()).capabilities,{});
  behavior='OK';assert.equal((await api('POST',path+'/test',{ version:1 })).statusCode,200);
  const wait=async(version:number)=>{ behavior='WAIT';const promise=api('POST',path+'/test',{ ...input,version });for(let n=0;n<100 && !pending.length;n++)await delay(5);assert.equal(pending.length,1);return { promise }; };
  const revoked=await wait(1);await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;behavior='OK';pending.shift()!();assert.equal((await revoked.promise).statusCode,403);
  await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.manager!.session}`;
  const expired=await wait(1);await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '25 milliseconds' WHERE id=${users.manager!.session}`;await delay(50);behavior='OK';pending.shift()!();assert.equal((await expired.promise).statusCode,403);
  await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=${users.manager!.session}`;
  const stale=await wait(1);assert.equal((await api('PUT',path,{ name:'Edited during assessment',provider:'ALMA',config:{ mode:'TEST' },version:1 })).statusCode,200);behavior='OK';pending.shift()!();assert.equal((await stale.promise).json().state,'SUPERSEDED');assert.deepEqual((await row()).capabilities,{});
  assert.equal((await api('POST',path+'/test',{ version:2 })).statusCode,200);
  const disabled=await wait(2);assert.equal((await api('POST',path+'/disable',{ version:2,reason:'Stop pending assessment' })).statusCode,200);behavior='OK';pending.shift()!();assert.equal((await disabled.promise).json().state,'SUPERSEDED');
  assert.equal((await api('POST',path+'/test',{ ...input,version:3 })).statusCode,409);assert.equal((await api('POST',path+'/reconnect',{ version:3,reason:'Reconnect assessment' })).statusCode,200);
  assert.equal((await api('POST',path+'/test',{ version:4 })).statusCode,200);const before=(await row()).capabilities;
  await db`CREATE FUNCTION test_fail_eligibility_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_CONNECTION_TEST_FINISHED' THEN RAISE EXCEPTION 'TEST_AUDIT_FAIL'; END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER test_fail_eligibility_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_eligibility_audit()`;
  try { assert.equal((await api('POST',path+'/test',{ ...input,version:4 })).statusCode,500);assert.deepEqual((await row()).capabilities,before);
    const failed=(await db`SELECT state,eligibility_request,eligibility_snapshot FROM payment_connection_probe WHERE connection_id=${id} ORDER BY probe_number DESC LIMIT 1`)[0]!;
    assert.equal(failed.state,'RUNNING');assert.deepEqual(failed.eligibility_request,proof.eligibility_request);assert.equal(failed.eligibility_snapshot,null);
  }finally { await db`DROP TRIGGER test_fail_eligibility_audit ON audit_log`;await db`DROP FUNCTION test_fail_eligibility_audit()`; }
  assert.equal((await api('POST',path+'/test',{ ...input,version:4 })).statusCode,200);
  const history=(await api('GET',path+'/history?limit=2')).json();assert.ok(history.nextCursor);assert.equal(history.items.length,2);
  assert.notEqual((await api('GET',path+'/history?limit=2&cursor='+encodeURIComponent(history.nextCursor))).json().items[0].id,history.items[0].id);
  const records=(await api('GET',path+'/history?limit=100')).json().items;assert.ok(records.some((r:any)=>r.eligibility_snapshot?.eligible===false && r.eligibility_snapshot.money.amount==='50.00' && r.connection_version===1));
  const publicText=JSON.stringify([await row(),records,await db`SELECT detail FROM audit_log WHERE action LIKE 'PAYMENT_%'`]);
  for(const privateValue of [credentials.apiKey,'private bank','private reason','customer_total_cost_amount','payment_plan'])assert.equal(publicText.includes(privateValue),false);
  for(const table of ['payment_link_intent','payment_record','enrollment'])assert.equal((await db`SELECT count(*)::integer AS n FROM ${db(table)}`)[0]!.n,0);
});
