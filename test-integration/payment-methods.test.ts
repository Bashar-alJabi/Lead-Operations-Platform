import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Branch Payment Methods preserve scoped versions/history, explicit shared use, Agent/Campaign availability and current authorization under races',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,paymentConnectionAdapters:{ STRIPE:{ verify:async(config)=>({ mode:config.mode }) } } });
  t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Methods') RETURNING id`)[0]!.id;
  const foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Foreign') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const branchB=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope,userOrg] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',branchB,org],
    ['agent','AGENT',branch,org],['agent2','AGENT',branch,org],['agentB','AGENT',branchB,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash)
      VALUES (${userOrg},${scope},${name},${role},${name+'@methods.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at)
      VALUES (${id},${sha256(token)},now()-interval '1 hour',now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={ id,cookie:'lop_session='+token,session };
  }
  const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'One') RETURNING id`)[0]!.id;
  const campaign2=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'Two') RETURNING id`)[0]!.id;
  const campaignB=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branchB},'Other branch') RETURNING id`)[0]!.id;
  const lead=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind) VALUES (${org},${branch},${campaign},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id;
  const lead2=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind) VALUES (${org},${branch},${campaign2},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id;
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.8.${ip++}` });
  const key='rk_test_'+ 'SyntheticOnly'.repeat(3);
  const accountInput={ name:'Independent account',provider:'STRIPE',config:{ mode:'TEST' },credentials:{ apiKey:key } };
  const account=(await api('POST','/api/payments/connections',accountInput)).json().id;
  const shared=(await api('POST','/api/payments/connections',{ ...accountInput,name:'Shared account' },'admin')).json().id;
  const accountB=(await api('POST','/api/payments/connections',accountInput,'other')).json().id;
  const root='/api/payments/methods';
  const input={ name:'Tuition <img src=x>',branchId:branch,connectionId:account,currencies:['USD','EUR'],active:true,
    agents:{ mode:'SELECTED',ids:[users.agent!.id] },campaigns:{ mode:'SELECTED',ids:[campaign] },reason:'Reviewed branch availability' };
  assert.equal((await api('POST',root,input,'agent')).statusCode,403);
  assert.equal((await api('POST',root,{ ...input,branchId:branchB })).statusCode,403);
  assert.equal((await api('POST',root,{ ...input,connectionId:accountB })).statusCode,404);
  assert.equal((await api('POST',root,{ ...input,connectionId:shared })).statusCode,404);
  assert.equal((await api('POST',root,{ ...input,agents:{ mode:'SELECTED',ids:[users.agentB!.id] } })).statusCode,400);
  assert.equal((await api('POST',root,{ ...input,agents:{ mode:'SELECTED',ids:[users.manager!.id] } })).statusCode,400);
  assert.equal((await api('POST',root,{ ...input,campaigns:{ mode:'SELECTED',ids:[campaignB] } })).statusCode,400);
  assert.equal((await api('POST',root,{ ...input,currencies:['XYZ'] })).statusCode,400);
  const created=await api('POST',root,input);assert.equal(created.statusCode,201);const id=created.json().id;
  const initial=(await api('GET',root+'/'+id)).json();assert.deepEqual(initial.currencies,['EUR','USD']);assert.equal(initial.available,false);
  assert.ok(initial.issues.includes('PAYMENT_AUTHENTICATION_REQUIRED'));assert.ok(initial.issues.includes('PAYMENT_FLOW_NOT_READY'));
  assert.equal(initial.agentSelections[0].name,'agent');assert.equal(initial.campaignSelections[0].name,'One');
  assert.equal((await api('GET',root+'/'+id,undefined,'other')).statusCode,404);assert.equal((await api('GET',root+'/'+id+'/history',undefined,'foreign')).statusCode,404);
  assert.equal((await api('GET',root,undefined,'agent')).statusCode,403);assert.equal((await api('GET',root+'/'+id+'/history',undefined,'agent')).statusCode,403);
  const sharedMethod=(await api('POST',root,{ ...input,connectionId:shared },'admin')).json().id;
  assert.equal((await api('PUT',root+'/'+sharedMethod,{ ...input,connectionId:shared,name:'Manager maintains shared method',version:1 })).statusCode,200);
  assert.equal((await api('GET','/api/payments/connections/'+shared)).statusCode,404);
  assert.equal((await api('GET','/api/payments/method-options?kind=CONNECTION&branchId='+branch)).json().items.some((x:{ id:string })=>x.id===shared),false);
  assert.equal((await api('GET','/api/payments/method-options?kind=CONNECTION&branchId='+branch,undefined,'admin')).json().items.some((x:{ id:string })=>x.id===shared),true);
  assert.equal((await api('GET','/api/payments/method-options?kind=AGENT&branchId='+branch,undefined,'agent')).statusCode,403);
  assert.equal((await api('GET','/api/payments/method-options?kind=CAMPAIGN&branchId='+branchB)).statusCode,403);
  const options=(await api('GET','/api/payments/method-options?kind=AGENT&branchId='+branch+'&limit=1')).json();assert.equal(options.items.length,1);assert.ok(options.nextCursor);
  const options2=(await api('GET','/api/payments/method-options?kind=AGENT&branchId='+branch+'&limit=1&cursor='+encodeURIComponent(options.nextCursor))).json();assert.notEqual(options2.items[0].id,options.items[0].id);
  assert.equal((await api('GET','/api/payments/method-options?kind=AGENT&branchId='+branch+'&q=agentB')).json().items.length,0);
  const listed=(await api('GET',root+'?limit=1')).json();assert.equal(listed.items.length,1);assert.ok(listed.nextCursor);
  assert.equal((await api('GET',root+'?branchId='+branchB)).statusCode,403);assert.equal((await api('GET',root,undefined,'foreign')).json().items.length,0);
  assert.equal((await api('POST','/api/payments/connections/'+account+'/test',{ version:1 })).statusCode,200);
  const eligible=(await api('GET','/api/leads/'+lead+'/payment-methods',undefined,'agent')).json();assert.ok(eligible.items.some((x:{ id:string })=>x.id===id));
  assert.equal(eligible.items.find((x:{ id:string })=>x.id===id).available,false);assert.deepEqual(eligible.items.find((x:{ id:string })=>x.id===id).issues,['PAYMENT_FLOW_NOT_READY']);
  assert.equal(JSON.stringify(eligible).includes('connection_id'),false);assert.equal(JSON.stringify(eligible).includes(key),false);
  assert.equal((await api('GET','/api/leads/'+lead2+'/payment-methods',undefined,'agent')).json().items.length,0);
  assert.equal((await api('GET','/api/leads/'+lead+'/payment-methods?currency=JPY',undefined,'agent')).json().items.length,0);
  assert.equal((await api('GET','/api/leads/'+lead+'/payment-methods?currency=XYZ',undefined,'agent')).statusCode,400);
  assert.equal((await api('GET','/api/leads/'+lead+'/payment-methods',undefined,'agent2')).statusCode,404);
  assert.equal((await api('GET','/api/leads/'+lead+'/payment-methods',undefined,'other')).statusCode,404);
  await db`UPDATE lead SET assigned_agent_id=${users.agent2!.id},version=version+1 WHERE id=${lead}`;
  assert.equal((await api('GET','/api/leads/'+lead+'/payment-methods',undefined,'agent')).statusCode,404);
  assert.equal((await api('GET','/api/leads/'+lead+'/payment-methods',undefined,'agent2')).json().items.length,0);
  const all={ ...input,agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'ALL',ids:[] },version:1 };
  const races=await Promise.all([api('PUT',root+'/'+id,{ ...all,name:'Changed one' }),api('PUT',root+'/'+id,{ ...all,name:'Changed two' })]);
  assert.deepEqual(races.map((r)=>r.statusCode).sort(),[200,409]);
  assert.ok((await api('GET','/api/leads/'+lead+'/payment-methods',undefined,'agent2')).json().items.some((x:{ id:string })=>x.id===id));
  assert.ok((await api('GET','/api/leads/'+lead2+'/payment-methods',undefined,'agent')).json().items.some((x:{ id:string })=>x.id===id));
  const history=(await api('GET',root+'/'+id+'/history?limit=1')).json();assert.equal(history.items[0].version,2);assert.equal(history.nextVersion,2);
  assert.equal((await api('GET',root+'/'+id+'/history?before=2')).json().items[0].snapshot.name,input.name);
  await assert.rejects(()=>db`UPDATE payment_method_history SET reason='rewrite' WHERE method_id=${id}`,/HISTORY_IMMUTABLE/);
  await assert.rejects(()=>db`DELETE FROM payment_method_history WHERE method_id=${id}`,/HISTORY_IMMUTABLE/);
  await assert.rejects(()=>db`UPDATE payment_method SET branch_id=${branchB},version=version+1 WHERE id=${id}`,/IDENTITY_IMMUTABLE/);
  await assert.rejects(()=>db`UPDATE payment_method SET agent_mode='SELECTED',agent_ids=${db.json([users.agentB!.id])},version=version+1 WHERE id=${id}`,/AVAILABILITY_SCOPE_INVALID/);
  await assert.rejects(()=>db`DELETE FROM payment_method WHERE id=${id}`,/HISTORY_RETAINED/);
  const gate=async(run:()=>Promise<void>)=> {
    let release!:()=>void;let acquired!:()=>void;const ready=new Promise<void>((resolve)=>acquired=resolve);
    const hold=db.begin(async(tx)=>{ await tx`SELECT id FROM payment_method WHERE id=${id} FOR UPDATE`;acquired();await new Promise<void>((resolve)=>release=resolve); });
    await ready;const promise=api('PUT',root+'/'+id,{ ...all,version:2,name:'Late forbidden change' });
    try { let blocked=false;for(let n=0;n<100;n++){ const rows=await db`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%payment_method%FOR UPDATE%'`;
      if(rows.length){ blocked=true;break; }await delay(10); }assert.equal(blocked,true);await run(); }
    finally { release();await hold; }return promise;
  };
  assert.equal((await gate(async()=>{ await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`; })).statusCode,403);
  await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;
  assert.equal((await gate(async()=>{ await db`UPDATE user_session SET expires_at=now()-interval '1 second' WHERE id=${users.manager!.session}`; })).statusCode,403);
  await db`UPDATE user_session SET expires_at=now()+interval '1 hour' WHERE id=${users.manager!.session}`;
  assert.equal((await api('GET',root+'/'+id)).json().version,2);
  await db`CREATE FUNCTION synthetic_method_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_METHOD_UPDATED' THEN RAISE EXCEPTION 'synthetic rollback' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`;
  await db`CREATE TRIGGER synthetic_method_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_method_audit_failure()`;
  try { assert.equal((await api('PUT',root+'/'+id,{ ...all,version:2 })).statusCode,500);assert.equal((await api('GET',root+'/'+id)).json().version,2);
    assert.equal((await api('GET',root+'/'+id+'/history')).json().items.length,2); }
  finally { await db`DROP TRIGGER synthetic_method_audit ON audit_log`;await db`DROP FUNCTION synthetic_method_audit_failure()`; }
  assert.equal((await api('PUT',root+'/'+id,{ ...all,version:2 })).statusCode,200);
  await db`UPDATE integration_connection SET status='DISABLED',version=version+1,capabilities='{}'::jsonb WHERE id=${account}`;
  assert.ok((await api('GET','/api/leads/'+lead+'/payment-methods',undefined,'agent2')).json().items.find((x:{ id:string })=>x.id===id).issues.includes('CONNECTION_DISABLED'));
  assert.equal((await api('PUT',root+'/'+id,{ ...all,version:3 })).statusCode,409);
  assert.equal((await api('PUT',root+'/'+id,{ ...all,version:3,active:false })).statusCode,200);
  assert.equal((await api('GET','/api/leads/'+lead+'/payment-methods',undefined,'agent2')).json().items.some((x:{ id:string })=>x.id===id),false);
  await db`UPDATE branch SET active=false WHERE id=${branch}`;
  assert.equal((await api('PUT',root+'/'+sharedMethod,{ ...input,connectionId:shared,version:2 })).statusCode,409);
  assert.equal((await api('PUT',root+'/'+sharedMethod,{ ...input,connectionId:shared,version:2,active:false })).statusCode,200);
  const audit=await db`SELECT detail FROM audit_log WHERE action LIKE 'PAYMENT_METHOD_%'`;
  assert.ok(audit.length>=6);assert.equal(JSON.stringify(audit).includes(key),false);assert.equal((await api('GET','/api/payments/currencies')).json().providerSupportVerified,false);
});
