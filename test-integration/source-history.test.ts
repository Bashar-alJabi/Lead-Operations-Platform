import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHmac } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { processOneHistoricalPreview,processOneHistoricalImport } from '../src/sources/historical.js';
import { processOneSourceEvaluation } from '../src/sources/evaluation.js';
import { processOneSourceIntake } from '../src/sources/intake.js';
import { processOneSourceRetrieval } from '../src/sources/retrieval-worker.js';
import { SourceProviderError } from '../src/sources/meta-provider.js';
import type { LeadSourceHistoryAdapter } from '../src/sources/meta-history.js';
const url=process.env.TEST_DATABASE_URL;if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('historical preview/import resumes safely, preserves originals, shares current intake and fences ACL, concurrent receipts and cancellation',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,leadSourceCatalogAdapter:{
    discoverPages:async()=>[{ externalId:'11',name:'Page',accessToken:'synthetic-page-token' }],
    discoverForms:async()=>[{ externalId:'22',name:'Form',status:'ACTIVE',questions:['phone'].map((key)=>({ key,externalId:null,type:'CUSTOM',label:key,options:[] })) }],
  } });t.after(async()=> { await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Historical') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const other=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const foreign=(await db`INSERT INTO organization (name) VALUES ('Foreign') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,b,o] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',other,org],['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreign]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash) VALUES (${o},${b},${name},${role},${name+'@historical.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;users[name]={ id,cookie:'lop_session='+token };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.3.${ip++%250+1}` });
  const credentials={ accessToken:'synthetic-root-token',appSecret:'synthetic-app-secret',verifyToken:'synthetic-verify-token' };
  const root='/api/sources/meta/connections';const connection=(await api('POST',root,{ name:'Historical',config:{ graphVersion:'v25.0',appId:'777' },credentials })).json().id;
  const base=root+'/'+connection;await api('POST',base+'/discover',{ version:1 });const page=(await api('GET',base+'/resources?kind=PAGE')).json().items[0];
  await api('POST',base+'/discover',{ version:1,pageId:page.id });const form=(await api('GET',base+'/resources?kind=FORM')).json().items[0];
  const camp=(await api('POST','/api/campaigns',{ branchId:branch,name:'Historical',sourceKind:'META' })).json().id;
  const binding=(await api('POST',`/api/sources/campaigns/${camp}/bindings`,{ connectionId:connection,formId:form.id,connectionVersion:1,requestId:randomUUID(),externalCampaignId:null,externalAdSetId:null,externalAdId:null,active:true,reason:'Historical binding' })).json().id;
  const mapping=`/api/sources/campaigns/${camp}/bindings/${binding}/mapping`;
  const published=await api('PUT',mapping,{ version:0,bindingVersion:1,connectionVersion:1,resourceVersion:form.version,status:'PUBLISHED',reason:'Historical mapping',entries:[{ sourceKey:'phone',kind:'CONTACT_PHONE',transform:'TEXT',optionMap:[] }] });assert.equal(published.statusCode,200,published.body);
  // Domain fixture isolates historical processing; public source activation is covered by source-readiness.test.
  await db`UPDATE campaign SET status='ACTIVE' WHERE id=${camp}`;
  const hist=base+'/historical';const range={ from:'2023-11-14T00:00:00Z',until:'2023-11-15T00:00:00Z' };
  const job=async(requestId=randomUUID(),extra={})=> { const r=await api('POST',hist,{ version:1,formId:form.id,requestId,...range,...extra });assert.equal(r.statusCode,202,r.body);return r.json().id as string; };
  const detail=async(id:string)=>(await api('GET',hist+'/'+id)).json();
  const action=async(id:string,name:string,override?:object)=>api('POST',hist+'/'+id+'/'+name,{ version:(await detail(id)).version,reason:'Reviewed historical operation',...override });
  const lead=(id:string,time='2023-11-14T22:13:19+0000')=>({ id,form_id:'22',created_time:time,field_data:[{ name:'phone',values:['+1555'+id.padStart(7,'0')] }] });
  const requestId=randomUUID();const first=await job(requestId);assert.equal(await job(requestId),first);
  assert.equal((await api('POST',hist,{ version:1,formId:form.id,requestId,...range,until:'2023-11-16T00:00:00Z' })).statusCode,409);
  for (const actor of ['agent','other','foreign']) {
    const code=actor==='agent' ? 403 : 404;
    for (const path of [hist,hist+'/'+first,hist+'/'+first+'/results',hist+'/'+first+'/attempts']) assert.equal((await api('GET',path,undefined,actor)).statusCode,code);
    assert.equal((await api('POST',hist,{ version:1,formId:form.id,requestId:randomUUID(),...range },actor)).statusCode,code);
    assert.equal((await api('POST',hist+'/'+first+'/cancel',{ version:1,reason:'denied' },actor)).statusCode,code);
  }
  assert.equal((await action(first,'confirm')).statusCode,409,'must complete preview');
  let calls=0;const paginated:LeadSourceHistoryAdapter={ page:async(input)=> { calls++;return input.after ? { data:[lead('102'),lead('103'),lead('999','2023-11-15T00:00:00+0000')] }
    : { data:[lead('101'),lead('102'),lead('100','2023-11-14T00:00:00+0000')],paging:{ next:'https://untrusted.invalid',cursors:{ after:'next-token' } } }; } };
  await Promise.all([processOneHistoricalPreview(db,paginated),processOneHistoricalPreview(db,paginated)]);assert.equal(calls,1,'single in-flight page');
  assert.equal((await detail(first)).state,'PENDING');assert.equal((await db`SELECT count(*)::int n FROM source_submission`)[0]!.n,0,'preview must not create operational rows');
  await processOneHistoricalPreview(db,paginated);let report=await detail(first);assert.equal(report.state,'PREVIEW_READY');assert.equal(report.counts.matched,4);assert.equal(report.scanned,6);
  assert.ok(!(await api('GET',hist+'/'+first)).body.includes('synthetic-page-token'));assert.ok(!(await api('GET',hist+'/'+first+'/results')).body.includes('field_data'));
  const results=(await api('GET',hist+'/'+first+'/results?limit=2')).json();assert.equal(results.items.length,2);assert.ok(results.nextAfter);
  assert.equal((await api('GET',hist+'/'+first+'/results?limit=2&after='+results.nextAfter)).json().items.length,2);
  const attempts=(await api('GET',hist+'/'+first+'/attempts?limit=1')).json();assert.equal(attempts.nextBefore,2);
  assert.equal((await action(first,'confirm',{ reason:' ' })).statusCode,400);assert.equal((await action(first,'confirm',{ version:1 })).statusCode,409);
  const confirmations=await Promise.all([action(first,'confirm'),action(first,'confirm')]);assert.deepEqual(confirmations.map((r)=>r.statusCode).sort(),[200,409]);
  await Promise.all([processOneHistoricalImport(db),processOneHistoricalImport(db)]);report=await detail(first);assert.equal(report.state,'SUCCEEDED');assert.equal(report.counts.imported,4);
  assert.equal((await db`SELECT count(*)::int n FROM source_submission`)[0]!.n,4);assert.equal((await action(first,'cancel')).statusCode,409);
  while (await processOneSourceEvaluation(db)) {}while (await processOneSourceIntake(db)) {}
  report=await detail(first);assert.equal(report.counts.processed,4);assert.equal((await db`SELECT count(*)::int n FROM lead`)[0]!.n,4);
  const original=(await db`SELECT * FROM source_submission WHERE external_event_id='101'`)[0]!;
  assert.equal(original.source_timestamp.toISOString(),'2023-11-14T22:13:19.000Z');
  const overlap=await job();await processOneHistoricalPreview(db,{ page:async()=>({ data:[{ ...lead('101'),field_data:[] },lead('104')] }) });
  assert.equal((await detail(overlap)).counts.known,1);await action(overlap,'confirm');await processOneHistoricalImport(db);
  assert.equal((await detail(overlap)).counts.duplicates,1);assert.deepEqual((await db`SELECT raw_payload FROM source_submission WHERE id=${original.id}`)[0]!.raw_payload,original.raw_payload);
  const signed=async(id:string)=> { const raw=JSON.stringify({ object:'page',entry:[{ id:'11',time:1700000000,changes:[{ field:'leadgen',value:{ page_id:'11',form_id:'22',leadgen_id:id,created_time:1699999999 } }] }] });
    const r=await app.inject({ method:'POST',url:'/api/webhooks/sources/meta/'+connection,payload:raw,headers:{ 'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',credentials.appSecret).update(raw).digest('hex') } });assert.equal(r.statusCode,200,r.body); };
  const receiptJob=await job();await processOneHistoricalPreview(db,{ page:async()=>({ data:[lead('105')] }) });await signed('105');await action(receiptJob,'confirm');await processOneHistoricalImport(db);
  assert.equal((await detail(receiptJob)).counts.duplicates,1);assert.equal((await db`SELECT count(*)::int n FROM source_submission WHERE external_event_id='105'`)[0]!.n,0);
  await processOneSourceRetrieval(db,{ retrieve:async()=>lead('105') });assert.equal((await db`SELECT count(*)::int n FROM source_submission WHERE external_event_id='105'`)[0]!.n,1);
  // A later signed notification reuses an already imported Submission and preserves raw/history.
  await signed('101');await processOneSourceRetrieval(db,{ retrieve:async()=>({ ...lead('101'),field_data:[] }) });assert.deepEqual((await db`SELECT raw_payload FROM source_submission WHERE id=${original.id}`)[0]!.raw_payload,original.raw_payload);
  const recovery=await job();let failOnce=true;const failing:LeadSourceHistoryAdapter={ page:async()=> { if (failOnce) { failOnce=false;throw new SourceProviderError('SOURCE_PROVIDER_RATE_LIMITED',true); }return { data:[lead('106')] }; } };
  await processOneHistoricalPreview(db,failing);assert.equal((await detail(recovery)).state,'PENDING');assert.equal((await detail(recovery)).errorCode,'SOURCE_PROVIDER_RATE_LIMITED');
  assert.equal(await processOneHistoricalPreview(db,failing),false,'backoff avoids immediate I/O');
  await db`UPDATE source_historical_job SET available_at=now(),version=version+1 WHERE id=${recovery}`;
  await processOneHistoricalPreview(db,failing);assert.equal((await detail(recovery)).state,'PREVIEW_READY');
  await action(recovery,'cancel');assert.equal((await detail(recovery)).state,'CANCELLED');
  const permanent=await job();await processOneHistoricalPreview(db,{ page:async()=> { throw new SourceProviderError('SOURCE_RESPONSE_INVALID'); } });assert.equal((await detail(permanent)).state,'FAILED');
  assert.equal((await action(permanent,'retry')).statusCode,200);await processOneHistoricalPreview(db,{ page:async()=>({ data:[] }) });assert.equal((await detail(permanent)).state,'PREVIEW_READY');await action(permanent,'cancel');
  // Crash after a page reservation: no partial page commits; expired attempt remains immutable.
  const crash=await job();const attemptId=randomUUID();await db`INSERT INTO source_historical_attempt (id,job_id,number) VALUES (${attemptId},${crash},1)`;
  await db`UPDATE source_historical_job SET state='RUNNING',attempts=1,lease_id=${attemptId},lease_until=now()-interval '1 second',version=version+1 WHERE id=${crash}`;
  await processOneHistoricalPreview(db,{ page:async()=>({ data:[] }) });assert.equal((await detail(crash)).state,'PREVIEW_READY');assert.equal((await db`SELECT state FROM source_historical_attempt WHERE id=${attemptId}`)[0]!.state,'SUPERSEDED');await action(crash,'cancel');
  const looping=await job();const loop={ page:async()=>({ data:[],paging:{ next:'ignored',cursors:{ after:'same' } } }) };await processOneHistoricalPreview(db,loop);await processOneHistoricalPreview(db,loop);assert.equal((await detail(looping)).errorCode,'SOURCE_HISTORICAL_CURSOR_REPEATED');await action(looping,'cancel');
  let release!:()=>void;let started!:()=>void;const gate=new Promise<void>((r)=>release=r);const entered=new Promise<void>((r)=>started=r);
  const cancelled=await job();const running=processOneHistoricalPreview(db,{ page:async()=> { started();await gate;return { data:[lead('107')] }; } });await entered;
  await action(cancelled,'cancel');release();await running;assert.equal((await detail(cancelled)).state,'CANCELLED');assert.equal((await detail(cancelled)).counts.matched,0);
  const disabled=await job();await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;
  let unauthorizedCalls=0;await processOneHistoricalPreview(db,{ page:async()=> { unauthorizedCalls++;return { data:[] }; } });assert.equal(unauthorizedCalls,0);
  await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;assert.equal((await detail(disabled)).errorCode,'SOURCE_ACTOR_NO_LONGER_AUTHORIZED');await action(disabled,'cancel');
  // Permission revoked after provider I/O started cannot authorize a late result.
  let resume!:()=>void;let inFlight!:()=>void;const wait=new Promise<void>((r)=>resume=r);const fetched=new Promise<void>((r)=>inFlight=r);
  const revoked=await job();const unauthorized=processOneHistoricalPreview(db,{ page:async()=> { inFlight();await wait;return { data:[lead('108')] }; } });await fetched;
  await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;resume();await unauthorized;await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;
  assert.equal((await detail(revoked)).state,'BLOCKED');assert.equal((await detail(revoked)).counts.matched,0);await action(revoked,'cancel');
  // A failing import batch rolls back every Submission and item, then records bounded recovery.
  const atomic=await job();await processOneHistoricalPreview(db,{ page:async()=>({ data:[lead('120'),lead('121')] }) });await action(atomic,'confirm');
  await db.unsafe(`CREATE FUNCTION historical_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.external_event_id='121' THEN RAISE EXCEPTION 'synthetic' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
  await db.unsafe(`CREATE TRIGGER historical_test_failure BEFORE INSERT ON source_submission FOR EACH ROW EXECUTE FUNCTION historical_test_failure()`);
  try { await processOneHistoricalImport(db);assert.equal((await detail(atomic)).errorCode,'SOURCE_HISTORICAL_DATABASE_RETRY');assert.equal((await detail(atomic)).counts.staged,2);
    assert.equal((await db`SELECT count(*)::int n FROM source_submission WHERE external_event_id IN ('120','121')`)[0]!.n,0); }
  finally { await db.unsafe('DROP TRIGGER historical_test_failure ON source_submission');await db.unsafe('DROP FUNCTION historical_test_failure()'); }
  await db`UPDATE source_historical_job SET available_at=now(),version=version+1 WHERE id=${atomic}`;await processOneHistoricalImport(db);assert.equal((await detail(atomic)).counts.imported,2);
  // Two imports with overlapping previews race under the same Connection mutex.
  const a=await job();await processOneHistoricalPreview(db,{ page:async()=>({ data:[lead('122')] }) });const b=await job();await processOneHistoricalPreview(db,{ page:async()=>({ data:[lead('122')] }) });
  await action(a,'confirm');await action(b,'confirm');await Promise.all([processOneHistoricalImport(db),processOneHistoricalImport(db)]);await processOneHistoricalImport(db);
  assert.equal((await detail(a)).counts.imported+(await detail(b)).counts.imported,1);assert.equal((await detail(a)).counts.duplicates+(await detail(b)).counts.duplicates,1);
  // Cancellation after one bounded batch preserves committed rows and leaves the rest staged.
  const partial=await job();await processOneHistoricalPreview(db,{ page:async()=>({ data:Array.from({ length:21 },(_,i)=>lead(String(200+i))) }) });await action(partial,'confirm');
  await processOneHistoricalImport(db);assert.equal((await detail(partial)).state,'IMPORTING');assert.equal((await detail(partial)).counts.imported,20);await action(partial,'cancel');
  assert.equal((await detail(partial)).counts.staged,1);assert.equal((await detail(partial)).counts.imported,20);
  // Setup grants do not confer bulk access to an Organization-wide Form history.
  const shared=(await api('POST',root,{ name:'Shared history',config:{ graphVersion:'v25.0' },credentials },'admin')).json().id;
  await api('POST',root+'/'+shared+'/discover',{ version:1 },'admin');const sharedPage=(await api('GET',root+'/'+shared+'/resources?kind=PAGE',undefined,'admin')).json().items[0];
  await api('POST',root+'/'+shared+'/discover',{ version:1,pageId:sharedPage.id },'admin');const sharedForm=(await api('GET',root+'/'+shared+'/resources?kind=FORM',undefined,'admin')).json().items[0];
  await api('PUT',`${root}/${shared}/resources/${sharedForm.id}/access/${branch}`,{ version:0,active:true,reason:'Campaign setup grant' },'admin');
  assert.equal((await api('GET',root+'/'+shared+'/historical')).statusCode,404);
  assert.equal((await api('POST',root+'/'+shared+'/historical',{ version:1,formId:sharedForm.id,requestId:randomUUID(),...range })).statusCode,404);
  // Page limit fails visibly with a resumable preview, never a false completed summary.
  const limited=await job();process.env.SOURCE_HISTORICAL_MAX_PAGES='1';
  try { await processOneHistoricalPreview(db,{ page:async()=>({ data:[],paging:{ next:'ignored',cursors:{ after:'limit' } } }) });await processOneHistoricalPreview(db,{ page:async()=>({ data:[] }) });assert.equal((await detail(limited)).errorCode,'SOURCE_HISTORICAL_PAGE_LIMIT'); }
  finally { delete process.env.SOURCE_HISTORICAL_MAX_PAGES; }
  await action(limited,'retry');await processOneHistoricalPreview(db,{ page:async()=>({ data:[] }) });await action(limited,'cancel');
  // Retry budget exhaustion is visible; recovery is explicit and separately bounded.
  const exhausted=await job();process.env.SOURCE_RETRIEVAL_MAX_FAILURES='2';
  try {
    const unavailable={ page:async()=> { throw new SourceProviderError('SOURCE_PROVIDER_UNAVAILABLE',true); } };
    await processOneHistoricalPreview(db,unavailable);await db`UPDATE source_historical_job SET available_at=now(),version=version+1 WHERE id=${exhausted}`;
    await processOneHistoricalPreview(db,unavailable);assert.equal((await detail(exhausted)).state,'FAILED');
  } finally { delete process.env.SOURCE_RETRIEVAL_MAX_FAILURES; }
  await db`UPDATE source_historical_job SET recoveries=10,version=version+1 WHERE id=${exhausted}`;
  assert.equal((await action(exhausted,'retry')).statusCode,409);await action(exhausted,'cancel');
  // Resource versions are fenced again after provider I/O; stale results have no authority.
  let releaseResource!:()=>void;let enteredResource!:()=>void;const resourceWait=new Promise<void>((r)=>releaseResource=r);const resourceEntered=new Promise<void>((r)=>enteredResource=r);
  const changing=await job();const resourceRequest=processOneHistoricalPreview(db,{ page:async()=> { enteredResource();await resourceWait;return { data:[lead('123')] }; } });await resourceEntered;
  await db`UPDATE source_resource SET version=version+1 WHERE id=${form.id}`;releaseResource();await resourceRequest;
  assert.equal((await detail(changing)).errorCode,'SOURCE_HISTORICAL_CONTEXT_CHANGED');assert.equal((await detail(changing)).counts.matched,0);await action(changing,'cancel');
  const stale=await job();await db`UPDATE source_resource SET version=version+1 WHERE id=${form.id}`;await processOneHistoricalPreview(db,{ page:async()=> { unauthorizedCalls++;return { data:[] }; } });
  assert.equal((await detail(stale)).state,'BLOCKED');assert.equal((await action(stale,'retry')).statusCode,409);assert.equal(unauthorizedCalls,0);await action(stale,'cancel');
  await assert.rejects(db`UPDATE source_historical_item SET raw_payload='{}'::jsonb WHERE job_id=${first}`);
  await assert.rejects(db`UPDATE source_historical_job SET state='IMPORTING',version=version+1 WHERE id=${first}`);
  await assert.rejects(db`DELETE FROM source_historical_item WHERE job_id=${first}`);
  const safeAudit=JSON.stringify(await db`SELECT detail FROM audit_log WHERE target_type='SOURCE_HISTORICAL_JOB'`);assert.ok(!safeAudit.includes('field_data'));assert.ok(!safeAudit.includes('synthetic-page-token'));
});
