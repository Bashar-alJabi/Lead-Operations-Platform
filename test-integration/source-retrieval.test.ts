import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes,randomUUID,createHmac } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { SourceProviderError } from '../src/sources/meta-provider.js';
import { processOneSourceRetrieval } from '../src/sources/retrieval-worker.js';
import type { SourceLeadInput } from '../src/sources/meta-lead.js';
const url=process.env.TEST_DATABASE_URL;if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('Source retrieval preserves original submissions, fences concurrent workers and context changes, bounds failures and exposes scoped audited recovery',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.SOURCE_RETRIEVAL_MAX_FAILURES='2';
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,leadSourceCatalogAdapter:{
    discoverPages:async()=>[{ externalId:'11',name:'Page',accessToken:'synthetic-retrieval-page' }],discoverForms:async()=>[],
  } });t.after(async()=> { delete process.env.SOURCE_RETRIEVAL_MAX_FAILURES;await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Retrieval') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const other=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['other','MANAGER',other],['agent','AGENT',branch]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash) VALUES (${org},${scope},${name},${role},${name+'@retrieval.test'},'not-login') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;users[name]={ id,cookie:'lop_session='+token };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,headers:{ cookie:users[actor]!.cookie,origin:process.env.APP_ORIGIN! },remoteAddress:`127.0.0.${ip++}` });
  const root='/api/sources/meta/connections';const credentials={ accessToken:'synthetic-retrieval-root',appSecret:'synthetic-retrieval-secret',verifyToken:'synthetic-retrieval-verify' };
  const input={ name:'Source',config:{ graphVersion:'v25.0',appId:'777' },credentials };
  const id=(await api('POST',root,input)).json().id;const base=root+'/'+id;await api('POST',base+'/discover',{ version:1 });
  const event=async(leadId:string)=> {
    const raw=JSON.stringify({ object:'page',entry:[{ id:'11',time:1700000000,changes:[{ field:'leadgen',value:{ page_id:'11',form_id:'101',leadgen_id:leadId,created_time:1699999999,adgroup_id:'77' } }] }] });
    const received=await app.inject({ method:'POST',url:'/api/webhooks/sources/meta/'+id,payload:raw,headers:{ 'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',credentials.appSecret).update(raw).digest('hex') } });
    assert.equal(received.statusCode,200);return (await db`SELECT id FROM source_webhook_event WHERE connection_id=${id} AND external_lead_id=${leadId}`)[0]!.id as string;
  };
  let mode='ok';let calls=0;let wait:Promise<void>|undefined;let entered:(()=>void)|undefined;
  const adapter={ retrieve:async(request:SourceLeadInput)=> {
    calls++;assert.equal(request.page.accessToken,'synthetic-retrieval-page');assert.deepEqual(Object.keys(request).sort(),['config','formId','leadId','page']);entered?.();await wait;
    if (mode==='retry') throw new SourceProviderError('SOURCE_PROVIDER_UNAVAILABLE',true);
    if (mode==='auth') throw new SourceProviderError('SOURCE_PROVIDER_AUTH_FAILED');if (mode==='error') throw new Error('unsafe '+credentials.accessToken);
    return { id:request.leadId,form_id:mode==='mismatch' ? '102' : request.formId,created_time:'2023-11-14T22:13:19+0000',ad_id:'31',adset_id:'32',campaign_id:'33',field_data:[
      { name:'full_name',values:['<img src=x onerror=alert(1)>'] },{ name:'phone',values:['+15550009999'] },{ name:'choices',values:['a','b'] }],custom_disclaimer_responses:[{ text:'Original disclaimer' }] };
  } };
  const first=await event('900');assert.equal((await db`SELECT count(*)::integer AS n FROM source_retrieval_job`)[0]!.n,1);
  let release!:()=>void;wait=new Promise<void>((resolve)=> { release=resolve; });const started=new Promise<void>((resolve)=> { entered=resolve; });
  const running=processOneSourceRetrieval(db,adapter);await started;assert.equal(await processOneSourceRetrieval(db,adapter),false);release();assert.equal(await running,true);wait=undefined;entered=undefined;
  assert.equal(calls,1);await event('900');assert.equal(await processOneSourceRetrieval(db,adapter),false);
  const submission=(await db`SELECT * FROM source_submission`)[0]!;assert.equal(submission.source_kind,'META');assert.equal(submission.state,'NEEDS_ATTENTION');assert.equal(submission.failure_code,'SOURCE_EVALUATION_PENDING');
  assert.equal(submission.source_timestamp.toISOString(),'2023-11-14T22:13:19.000Z');assert.equal(submission.raw_payload.notification.change.value.adgroup_id,'77');assert.equal(submission.raw_payload.lead.adset_id,'32');
  assert.deepEqual(submission.raw_payload.lead.field_data[2].values,['a','b']);assert.equal(submission.branch_id,branch);assert.equal(submission.campaign_id,null);
  await assert.rejects(db`UPDATE source_submission SET raw_payload='{}'::jsonb WHERE id=${submission.id}`);await assert.rejects(db`UPDATE source_submission SET source_timestamp=now() WHERE id=${submission.id}`);await assert.rejects(db`DELETE FROM source_submission WHERE id=${submission.id}`);
  assert.equal((await api('POST','/api/contact-reviews/'+submission.id+'/resolve',{ contactId:randomUUID() })).statusCode,404);
  let health=(await api('GET',base+'/webhook')).json();assert.equal(health.retrieved,1);assert.equal(health.pending,0);assert.equal(health.intakeReady,false);
  let dto=(await api('GET',base+'/webhook-events')).json();assert.equal(dto.items[0].submission_id,submission.id);assert.ok(!JSON.stringify(dto).includes('15550009999'));assert.ok(!JSON.stringify(dto).includes('Original disclaimer'));
  const retry=async(eventId:string,actor='manager')=> { const job=(await db`SELECT version FROM source_retrieval_job WHERE event_id=${eventId}`)[0]!;return api('POST',base+'/webhook-events/'+eventId+'/retry',{ version:job.version,reason:'Provider failure fixed' },actor); };
  assert.equal((await retry(first)).statusCode,409);
  const second=await event('901');mode='retry';assert.equal(await processOneSourceRetrieval(db,adapter),true);assert.equal(await processOneSourceRetrieval(db,adapter),false);
  const backoff=(await db`SELECT state,available_at>now() AS delayed FROM source_retrieval_job WHERE event_id=${second}`)[0]!;assert.equal(backoff.state,'PENDING');assert.equal(backoff.delayed,true);
  await db`UPDATE source_retrieval_job SET available_at=now(),version=version+1 WHERE event_id=${second}`;await processOneSourceRetrieval(db,adapter);
  assert.equal((await db`SELECT state FROM source_retrieval_job WHERE event_id=${second}`)[0]!.state,'FAILED');assert.equal(await processOneSourceRetrieval(db,adapter),false);
  assert.equal((await retry(second,'agent')).statusCode,403);assert.equal((await retry(second,'other')).statusCode,404);
  const v=(await db`SELECT version FROM source_retrieval_job WHERE event_id=${second}`)[0]!.version;
  const recoveries=await Promise.all([api('POST',base+'/webhook-events/'+second+'/retry',{ version:v,reason:'Confirmed repaired' }),api('POST',base+'/webhook-events/'+second+'/retry',{ version:v,reason:'Concurrent repaired' })]);assert.deepEqual(recoveries.map((r)=>r.statusCode).sort(),[200,409]);
  mode='ok';await processOneSourceRetrieval(db,adapter);assert.equal((await db`SELECT attempts,recoveries FROM source_retrieval_job WHERE event_id=${second}`)[0]!.attempts,3);
  const hist=(await api('GET',base+'/webhook-events/'+second+'/attempts?limit=1')).json();assert.equal(hist.items[0].state,'SUCCEEDED');assert.ok(hist.nextBeforeAttempt);
  assert.equal((await api('GET',base+'/webhook-events/'+second+'/attempts?beforeAttempt='+hist.nextBeforeAttempt)).json().items.length,2);
  const attempt=(await db`SELECT id FROM source_retrieval_attempt WHERE event_id=${second} ORDER BY attempt_number DESC LIMIT 1`)[0]!.id;
  await assert.rejects(db`DELETE FROM source_retrieval_attempt WHERE id=${attempt}`);await assert.rejects(db`UPDATE source_retrieval_job SET version=version+1 WHERE event_id=${second}`);
  const third=await event('902');mode='mismatch';await processOneSourceRetrieval(db,adapter);assert.equal((await db`SELECT state,error_code FROM source_retrieval_job WHERE event_id=${third}`)[0]!.error_code,'SOURCE_RESPONSE_INVALID');assert.equal((await db`SELECT count(*)::integer AS n FROM source_submission`)[0]!.n,2);
  mode='ok';await retry(third);wait=new Promise<void>((resolve)=> { release=resolve; });const contextStarted=new Promise<void>((resolve)=> { entered=resolve; });
  const stale=processOneSourceRetrieval(db,adapter);await contextStarted;await api('PUT',base,{ name:'Changed',config:input.config,version:1 });release();await stale;wait=undefined;entered=undefined;
  assert.equal((await db`SELECT state FROM source_retrieval_job WHERE event_id=${third}`)[0]!.state,'BLOCKED');assert.equal((await retry(third)).statusCode,409);
  await api('POST',base+'/discover',{ version:2 });assert.equal((await retry(third)).statusCode,200);await processOneSourceRetrieval(db,adapter);
  const fourth=await event('903');mode='auth';await processOneSourceRetrieval(db,adapter);assert.equal((await db`SELECT state FROM source_retrieval_job WHERE event_id=${fourth}`)[0]!.state,'BLOCKED');assert.equal((await retry(fourth)).statusCode,409);
  await api('POST',base+'/discover',{ version:2 });mode='ok';await retry(fourth);
  // A transient database failure after retrieval rolls back the Submission and can be retried safely.
  await db`CREATE FUNCTION test_fail_source_insert() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION USING ERRCODE = ''40001'', MESSAGE = ''test rollback''; END'`;
  await db`CREATE TRIGGER test_source_insert BEFORE INSERT ON source_submission FOR EACH ROW EXECUTE FUNCTION test_fail_source_insert()`;
  try { await processOneSourceRetrieval(db,adapter); } finally { await db`DROP TRIGGER test_source_insert ON source_submission`;await db`DROP FUNCTION test_fail_source_insert()`; }
  assert.equal((await db`SELECT error_code FROM source_retrieval_job WHERE event_id=${fourth}`)[0]!.error_code,'SOURCE_RETRIEVAL_DATABASE_RETRY');assert.equal((await db`SELECT count(*)::integer AS n FROM source_submission`)[0]!.n,3);
  await db`UPDATE source_retrieval_job SET available_at=now(),version=version+1 WHERE event_id=${fourth}`;await processOneSourceRetrieval(db,adapter);
  const fifth=await event('904');const oldLease=randomUUID();const page=(await db`SELECT version FROM source_resource WHERE connection_id=${id} AND resource_kind='PAGE'`)[0]!;
  await db`INSERT INTO source_retrieval_attempt (id,event_id,attempt_number,connection_version,page_version) VALUES (${oldLease},${fifth},1,2,${page.version})`;
  await db`UPDATE source_retrieval_job SET state='RUNNING',attempts=1,version=version+1,lease_id=${oldLease},lease_until=now()-interval '1 second' WHERE event_id=${fifth}`;
  await processOneSourceRetrieval(db,adapter);assert.equal((await db`SELECT state FROM source_retrieval_attempt WHERE id=${oldLease}`)[0]!.state,'SUPERSEDED');
  assert.equal((await db`SELECT attempts FROM source_retrieval_job WHERE event_id=${fifth}`)[0]!.attempts,2);
  const sixth=await event('905');mode='error';await processOneSourceRetrieval(db,adapter);dto=(await api('GET',base+'/webhook-events')).json();assert.ok(!JSON.stringify(dto).includes(credentials.accessToken));
  mode='ok';await retry(sixth);wait=new Promise<void>((resolve)=> { release=resolve; });const disableStarted=new Promise<void>((resolve)=> { entered=resolve; });
  const disabling=processOneSourceRetrieval(db,adapter);await disableStarted;await api('POST',base+'/disable',{ version:2 });release();await disabling;wait=undefined;entered=undefined;
  assert.equal((await db`SELECT state FROM source_retrieval_job WHERE event_id=${sixth}`)[0]!.state,'BLOCKED');
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM contact`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM source_submission`)[0]!.n,5);
  const injected=(await db`INSERT INTO source_submission (organization_id,branch_id,connection_id,external_event_id,source_kind,raw_payload,state,failure_code)
    VALUES (${org},${branch},${id},'external-review-shape','META',${db.json({ candidateContactIds:[randomUUID()],contact:{ name:'Untrusted review shape',phone:'+15550001234' } })},'NEEDS_ATTENTION','CONTACT_AMBIGUOUS') RETURNING id`)[0]!.id;
  assert.equal((await api('GET','/api/contact-reviews')).json().items.length,0);
  assert.equal((await api('POST','/api/contact-reviews/'+injected+'/resolve',{ contactId:randomUUID() })).statusCode,404);
  const audit=await db`SELECT action,detail FROM audit_log`;assert.ok(audit.some((r)=>r.action==='SOURCE_RETRIEVAL_RECOVERED'));assert.ok(!JSON.stringify(audit).includes('Original disclaimer'));assert.ok(!JSON.stringify(audit).includes(credentials.accessToken));
});
