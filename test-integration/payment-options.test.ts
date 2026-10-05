import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { PaymentProviderError,type PaymentProviderOptions } from '../src/payments/providers.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('Payment options retain normalized scoped immutable snapshots and current version/session/latest-result fences without implying financial readiness',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const offered:PaymentProviderOptions={ accountRef:'acct_SyntheticOptions123',country:'US',defaultCurrency:'USD',currencies:['USD','EUR'],paymentMethods:['card'],chargesEnabled:false,cardPayments:'PENDING' };
  let mode:'OK'|'WAIT'|'MALFORMED'|'AUTH'|'UNSAFE'='OK';let calls=0;const pending:(()=>void)[]=[];
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,paymentConnectionAdapters:{ STRIPE:{
    verify:async(config)=>{ if(mode==='AUTH')throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');return { mode:config.mode }; },
    inspect:async(config)=>{ calls++;const behavior=mode;if(behavior==='WAIT')await new Promise<void>((resolve)=>pending.push(resolve));
      if(behavior==='UNSAFE')throw new Error('unsafe-secret');return { mode:config.mode,options:behavior==='MALFORMED' ? { ...offered,country:'https://bad.test' }
        : { ...offered,bank:'private-bank',secret:'unsafe-secret',business:'private-company' } as PaymentProviderOptions }; },
  } } });t.after(async()=>{ pending.forEach((release)=>release());await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Options') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const branchB=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string;session:string }>={};
  for(const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['other','MANAGER',branchB],['agent','AGENT',branch]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash)
      VALUES (${org},${scope},${name},${role},${name+'@options.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at)
      VALUES (${id},${sha256(token)},now()-interval '1 hour',now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={ id,cookie:'lop_session='+token,session };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.9.${ip++}` });
  const key='rk_test_'+'SyntheticOptionsOnly'.repeat(3);const input={ name:'Read-only options',provider:'STRIPE',config:{ mode:'TEST' },credentials:{ apiKey:key } };
  const root='/api/payments/connections';const id=(await api('POST',root,input)).json().id;
  const inspect=(version=1,actor='manager')=>api('POST',`${root}/${id}/test`,{ version,inspectOptions:true },actor);
  assert.equal((await inspect(1,'agent')).statusCode,403);assert.equal((await inspect(1,'other')).statusCode,404);assert.equal(calls,0);
  assert.equal((await inspect()).statusCode,200);const detail=(await api('GET',root+'/'+id)).json();assert.equal(detail.status,'WARNING');
  assert.deepEqual(detail.capabilities.paymentOptions,{ ...offered,currencies:['EUR','USD'] });assert.equal(detail.capabilities.paymentLinksReady,false);assert.equal(detail.capabilities.webhookReady,false);
  assert.equal(detail.capabilities.paymentOptionsVersion,1);assert.ok(detail.capabilities.paymentOptionsAt);
  const history=(await api('GET',root+'/'+id+'/history')).json().items;assert.equal(history[0].purpose,'OPTIONS');assert.deepEqual(history[0].options_snapshot,detail.capabilities.paymentOptions);
  assert.equal(JSON.stringify([detail,history]).includes('private-bank'),false);assert.equal(JSON.stringify([detail,history]).includes('unsafe-secret'),false);
  await assert.rejects(()=>db`UPDATE payment_connection_probe SET purpose='AUTH' WHERE id=${history[0].id}`,/PROBE_IMMUTABLE/);
  await assert.rejects(()=>db`UPDATE payment_connection_probe SET options_snapshot='{}'::jsonb WHERE id=${history[0].id}`,/PROBE_IMMUTABLE/);
  assert.equal((await api('POST',root+'/'+id+'/test',{ version:1 })).statusCode,200);
  assert.deepEqual((await api('GET',root+'/'+id)).json().capabilities.paymentOptions,detail.capabilities.paymentOptions);
  const methodInput={ name:'Inspected currency method',branchId:branch,connectionId:id,active:true,currencies:['GBP'],agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'ALL',ids:[] },reason:'Review offered currencies' };
  assert.equal((await api('POST','/api/payments/methods',methodInput)).statusCode,400);
  const method=(await api('POST','/api/payments/methods',{ ...methodInput,currencies:['USD'] })).json();assert.ok(method.id);
  assert.equal((await api('PUT','/api/payments/methods/'+method.id,{ ...methodInput,version:1 })).statusCode,400);
  assert.equal((await api('GET','/api/payments/methods/'+method.id)).json().version,1);
  assert.equal((await api('PUT','/api/payments/methods/'+method.id,{ ...methodInput,version:1,active:false })).statusCode,200);
  mode='MALFORMED';assert.equal((await inspect()).json().error,'PAYMENT_PROVIDER_RESPONSE_INVALID');
  assert.equal((await api('GET',root+'/'+id)).json().capabilities.paymentOptions,undefined);
  mode='UNSAFE';const failed=await inspect();assert.equal(failed.statusCode,502);assert.equal(failed.json().error,'PAYMENT_PROVIDER_UNAVAILABLE');assert.equal(failed.body.includes('unsafe-secret'),false);
  const startWait=async()=> { mode='WAIT';const promise=inspect();for(let n=0;n<100 && pending.length===0;n++)await delay(5);assert.ok(pending.length);return { promise }; };
  const race=await startWait();mode='AUTH';assert.equal((await api('POST',root+'/'+id+'/test',{ version:1 })).statusCode,502);
  pending.shift()!();assert.equal((await race.promise).json().state,'SUPERSEDED');assert.equal((await api('GET',root+'/'+id)).json().status,'AUTH_EXPIRED');
  const stale=await startWait();assert.equal((await api('PUT',root+'/'+id,{ ...input,name:'Reconfigured options',version:1 })).statusCode,200);
  pending.shift()!();assert.equal((await stale.promise).json().state,'SUPERSEDED');assert.equal((await api('GET',root+'/'+id)).json().status,'NOT_CONFIGURED');
  mode='WAIT';const sessionRace=api('POST',root+'/'+id+'/test',{ version:2,inspectOptions:true });for(let n=0;n<100 && pending.length===0;n++)await delay(5);assert.ok(pending.length);
  await db`UPDATE user_session SET expires_at=now()-interval '1 second' WHERE id=${users.manager!.session}`;pending.shift()!();assert.equal((await sessionRace).statusCode,403);
  await db`UPDATE user_session SET expires_at=now()+interval '1 hour' WHERE id=${users.manager!.session}`;mode='OK';assert.equal((await inspect(2)).statusCode,200);
  const realNow=Date.now;const skew=t.mock.method(Date,'now',()=>realNow()+60000);
  try { assert.equal((await inspect(2)).json().state,'VERIFIED'); }finally{ skew.mock.restore(); }
  await db`CREATE FUNCTION synthetic_options_short_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.expires_at=clock_timestamp()+interval '100 milliseconds'; RETURN NEW; END $$`;
  await db`CREATE TRIGGER zz_synthetic_options_lease BEFORE INSERT ON payment_connection_probe FOR EACH ROW EXECUTE FUNCTION synthetic_options_short_lease()`;
  try { mode='WAIT';const expired=inspect(2);for(let n=0;n<100 && pending.length===0;n++)await delay(5);assert.ok(pending.length);await delay(200);pending.shift()!();
    assert.equal((await expired).json().state,'SUPERSEDED');assert.equal((await api('GET',root+'/'+id)).json().status,'WARNING'); }
  finally{ await db`DROP TRIGGER zz_synthetic_options_lease ON payment_connection_probe`;await db`DROP FUNCTION synthetic_options_short_lease()`; }
  assert.equal((await api('POST',root+'/'+id+'/disable',{ version:2,reason:'Stop inspected account' })).statusCode,200);
  const before=calls;assert.equal((await inspect(3)).statusCode,409);assert.equal(calls,before);assert.equal((await api('GET',root+'/'+id)).json().capabilities.paymentOptions,undefined);
  const retained=(await api('GET',root+'/'+id+'/history')).json().items;assert.ok(retained.some((p:{ options_snapshot:unknown })=>p.options_snapshot));
  assert.ok(retained.some((p:{ state:string })=>p.state==='BLOCKED'));assert.ok(retained.some((p:{ state:string })=>p.state==='SUPERSEDED'));
  assert.equal(JSON.stringify(retained).includes(key),false);assert.equal((await api('GET','/api/branches')).statusCode,200);
  const audit=await db`SELECT detail FROM audit_log WHERE action LIKE 'PAYMENT_CONNECTION_TEST_%'`;
  assert.equal(JSON.stringify(audit).includes('private-company'),false);assert.equal(JSON.stringify(audit).includes('acct_SyntheticOptions123'),false);
});
