import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import {setup} from './google-export.fixture.js';import test from 'node:test';
import type postgres from 'postgres';import type {FastifyRequest} from 'fastify';import {createDatabase,type Database} from '../src/db.js';import type {Principal} from '../src/security.js';
import {approveGoogleExportDelivery,getGoogleExportDelivery,changeGoogleExportDelivery} from '../src/google/export-delivery.js';
import {processOneGoogleExportDelivery} from '../src/google/export-delivery-worker.js';import {googleSheetsAdapter} from '../src/google/sheets.js';
test('Google export delivery native contracts require genuine independent approval, one durable attempt, matching typed reads and current scoped runtime without replay',async t=>{
 const f=await setup(t),{db}=f,original=(await db`SELECT to_regclass('google_export_delivery') present`)[0]!.present;
 const source=await f.source(),prepared=await f.create(source);for(let i=0;i<4;i++)if(!await f.worker())break;
 const before=f.calls();let assertions=0;
 try{await db.begin(async tx=>{
  if(!original)await tx.unsafe(await readFile('migrations/195_google_export_delivery.sql','utf8'));
  const j=(await tx`SELECT * FROM google_export_job WHERE id=${prepared.id}`)[0]!,c=(await tx`SELECT * FROM integration_connection WHERE id=${j.connection_id}`)[0]!,id=randomUUID(),request=randomUUID();assert.equal(j.state,'READY');assertions++;
  // Bind services to genuine PostgreSQL savepoints so unapplied DDL stays private to this rollback.
  // Authentication uses the actual fixture session, not a fabricated runtime identity.
  try{await tx.savepoint(async q=>{
   const scoped={begin:(work:(sql:postgres.TransactionSql)=>Promise<unknown>)=>q.savepoint(work)} as unknown as Database;
   const actor=(await q`SELECT id,organization_id AS "organizationId",branch_id AS "branchId",role,name,email FROM user_account WHERE id=${f.actors.manager!.id}`)[0] as Principal;
   const request={cookies:{lop_session:f.actors.manager!.cookie.slice('lop_session='.length)}} as unknown as FastifyRequest,input={version:j.version,requestId:randomUUID(),reason:'Explicit synthetic transfer approval',confirmed:true as const};
   await assert.rejects(approveGoogleExportDelivery(scoped,actor,request,j.id,{...input,confirmed:false} as never),/GOOGLE_EXPORT_DELIVERY_CONFIRMATION_REQUIRED/);
   const first=await approveGoogleExportDelivery(scoped,actor,request,j.id,input),again=await approveGoogleExportDelivery(scoped,actor,request,j.id,input);assert.equal(first.id,again.id);assert.equal(first.attempted,false);
   await assert.rejects(approveGoogleExportDelivery(scoped,actor,request,j.id,{...input,reason:'Changed transfer intent'}),/GOOGLE_EXPORT_DELIVERY_INTENT_CONFLICT/);
   await assert.rejects(approveGoogleExportDelivery(scoped,actor,request,j.id,{...input,requestId:randomUUID()}),/GOOGLE_EXPORT_DELIVERY_ALREADY_APPROVED/);
   const history=await getGoogleExportDelivery(scoped,actor,request,j.id);assert.equal(history.delivery!.id,first.id);assert.equal(history.history.length,1);
   await assert.rejects(changeGoogleExportDelivery(scoped,actor,request,j.id,{version:first.version+1,reason:'Stale cancellation'},true),/GOOGLE_EXPORT_DELIVERY_VERSION_CONFLICT/);
   const cancelled=await changeGoogleExportDelivery(scoped,actor,request,j.id,{version:first.version,reason:'Cancel before transfer'},true);assert.equal(cancelled.state,'CANCELLED');assert.equal(cancelled.attempted,false);assertions+=8;
   throw Error('ROLLBACK_SERVICE_CASE');
  });}catch(e){if((e as Error).message!=='ROLLBACK_SERVICE_CASE')throw e;}
  const insert=async(q:typeof tx)=>q`INSERT INTO google_export_delivery(id,job_id,actor_id,approval_session_id,request_id,request_hash,payload_version,payload_sha256,reason) SELECT ${id},id,actor_id,${f.actors.manager!.sid},${request},decode(repeat('01',32),'hex'),version,sha256(convert_to(google_export_expected_grid(id,0,expected_rows+1)::text,'UTF8')),'Explicit synthetic delivery approval' FROM google_export_job WHERE id=${j.id} RETURNING *`;
  await assert.rejects(tx.savepoint(async q=>{await insert(q);}),/GOOGLE_EXPORT_DELIVERY_APPROVAL_REQUIRED/);assertions++;
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(${j.organization_id},${j.branch_scope},${j.actor_id},'GOOGLE_EXPORT_DELIVERY_APPROVED','GOOGLE_EXPORT_DELIVERY',${id},${tx.json({preparedId:j.id,requestId:request,sessionId:f.actors.manager!.sid})})`;
  let d=(await insert(tx))[0]!;
  await assert.rejects(tx.savepoint(async q=>{await q`UPDATE google_export_delivery SET state='DONE',version=version+1 WHERE id=${id}`;}),/GOOGLE_EXPORT_/);assertions++;
  await tx`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${f.actors.manager!.sid}`;
  assert.equal((await tx`SELECT google_export_delivery_allowed(d) ok,google_export_delivery_allowed(d,true) approval FROM google_export_delivery d WHERE id=${id}`)[0]!.ok,true);assert.equal((await tx`SELECT google_export_delivery_allowed(d,true) approval FROM google_export_delivery d WHERE id=${id}`)[0]!.approval,false);assertions+=2;
  const lease=randomUUID();d=(await tx`UPDATE google_export_delivery SET state='SENDING',version=version+1,lease_token=${lease},lease_until=clock_timestamp()+interval '60 seconds',active_grant_id=${c.capabilities.grantId} WHERE id=${id} RETURNING *`)[0]!;
  // Genuine export delegation uses the historical approval only as a trace, never a session.
  try{await tx.savepoint(async q=>{
   const op=randomUUID();await q`INSERT INTO google_oauth_operation(id,connection_id,connection_version,kind,actor_id,session_id,actor_role,actor_branch_id,previous_operation_id,export_delivery_id,export_lease,state) VALUES(${op},${c.id},${c.version},'RUNTIME',${j.actor_id},${d.approval_session_id},${j.actor_role},${j.branch_scope},${c.capabilities.grantId},${id},${lease},'RUNNING')`;
   await q`UPDATE google_oauth_operation SET state='UNKNOWN',version=version+1,error_code='GOOGLE_RESULT_UNKNOWN' WHERE id=${op}`;
   await assert.rejects(q.savepoint(async q2=>{await q2`INSERT INTO google_oauth_operation(connection_id,connection_version,kind,actor_id,session_id,actor_role,actor_branch_id,previous_operation_id,export_delivery_id,export_lease,state) VALUES(${c.id},${c.version},'RUNTIME',${j.actor_id},${d.approval_session_id},${j.actor_role},${j.branch_scope},${c.capabilities.grantId},${id},${lease},'RUNNING')`;}),/GOOGLE_NEW_AUTHORIZATION_REQUIRED/);assertions++;
   throw Error('ROLLBACK_RUNTIME_CASE');
  });}catch(e){if((e as Error).message!=='ROLLBACK_RUNTIME_CASE')throw e;}
  const attempt=(await tx`INSERT INTO google_export_write_attempt(delivery_id,lease_token,grant_id,payload_sha256,metadata_sha256) VALUES(${id},${lease},${c.capabilities.grantId},${d.payload_sha256},decode(repeat('02',32),'hex')) RETURNING created_at::text at`)[0]!;
  d=(await tx`UPDATE google_export_delivery SET attempt_at=${attempt.at}::text::timestamptz,version=version+1 WHERE id=${id} RETURNING *`)[0]!;
  await assert.rejects(tx.savepoint(async q=>{await q`UPDATE google_export_delivery SET state='WAITING',version=version+1,lease_token=NULL,lease_until=NULL WHERE id=${id}`;}),/GOOGLE_EXPORT_DELIVERY_TRANSITION_INVALID/);assertions++;
  await assert.rejects(tx.savepoint(async q=>{await q`DELETE FROM google_export_write_attempt WHERE delivery_id=${id}`;}),/GOOGLE_EXPORT_ATTEMPT_IMMUTABLE/);assertions++;
  d=(await tx`UPDATE google_export_delivery SET state='VERIFYING',version=version+1,lease_token=NULL,lease_until=NULL WHERE id=${id} RETURNING *`)[0]!;
  const readLease=randomUUID();d=(await tx`UPDATE google_export_delivery SET state='READING',version=version+1,lease_token=${readLease},lease_until=clock_timestamp()+interval '60 seconds' WHERE id=${id} RETURNING *`)[0]!;
  await assert.rejects(tx.savepoint(async q=>{await q`INSERT INTO google_export_read_receipt(delivery_id,start_row,row_count,delivery_version,lease_token,grant_id,cells_sha256) VALUES(${id},0,${j.expected_rows+1},${d.version+1},${readLease},${c.capabilities.grantId},decode(repeat('03',32),'hex'))`;}),/GOOGLE_EXPORT_MATCHING_READ_REQUIRED/);assertions++;
  await tx`INSERT INTO google_export_read_receipt(delivery_id,start_row,row_count,delivery_version,lease_token,grant_id,cells_sha256) VALUES(${id},0,${j.expected_rows+1},${d.version+1},${readLease},${c.capabilities.grantId},sha256(convert_to(google_export_expected_grid(${j.id},0,${j.expected_rows+1})::text,'UTF8')))`;
  d=(await tx`UPDATE google_export_delivery SET state='DONE',verified_rows=${j.expected_rows+1},version=version+1,lease_token=NULL,lease_until=NULL WHERE id=${id} RETURNING *`)[0]!;assert.equal(d.state,'DONE');assertions++;
  await assert.rejects(tx.savepoint(async q=>{await q`UPDATE google_export_read_receipt SET row_count=1 WHERE delivery_id=${id}`;}),/GOOGLE_EXPORT_READ_IMMUTABLE/);assertions++;
  await assert.rejects(tx.savepoint(async q=>{await q`UPDATE google_export_delivery_history SET reason='forged' WHERE delivery_id=${id}`;}),/GOOGLE_EXPORT_DELIVERY_HISTORY_IMMUTABLE/);assertions++;
  await tx`SET CONSTRAINTS ALL IMMEDIATE`;assertions++;
  throw Error('EXPECTED_NATIVE195_ROLLBACK');
 });}catch(e){if((e as Error).message!=='EXPECTED_NATIVE195_ROLLBACK')throw e;}
 assert.equal((await db`SELECT to_regclass('google_export_delivery') present`)[0]!.present,original);assert.equal(f.calls(),before);
 t.diagnostic('Native195 '+assertions+' native assertions passed; schema/actions rolled back; no provider calls');
});

async function deliveryFixture(t:import('node:test').TestContext,extra=0){
 const f=await setup(t,extra),{db,api}=f,s=await f.source(),prepared=await f.create(s);for(let i=0;i<4;i++)if(!await f.worker())break;
 const root='/api/google/exports/'+prepared.id,preview=(await api('GET',root)).json(),intent={version:preview.version,requestId:randomUUID(),reason:'Explicit synthetic external delivery',confirmed:true};
 const approved=await api('POST',root+'/delivery',intent);assert.equal(approved.statusCode,202,approved.body);const id=approved.json().id;
 const observer=createDatabase(process.env.TEST_DATABASE_URL!);t.after(async()=>{await observer.end();});
 let writes=0,reads=0,refreshes=0,loseAck=false,readFailure=false,mismatch=false,preflightHook:(()=>Promise<void>)|null=null,writeHook:(()=>Promise<void>)|null=null;
 let saved:{properties:{sheetId:number;title:string;sheetType:string;index:number;gridProperties:{rowCount:number;columnCount:number}};rows:{values:{userEnteredValue:object}[]}[]}|null=null;
 const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}}),adapter=googleSheetsAdapter(async(u,init)=>{
  const url=new URL(String(u));assert.equal(init?.redirect,'error');
  if(url.href==='https://oauth2.googleapis.com/token'){assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'),'refresh_token');refreshes++;return json({access_token:'SyntheticRuntimeExportAccess',refresh_token:'SyntheticRuntimeExportRefresh',expires_in:3600,token_type:'Bearer'});}
  if(url.href==='https://openidconnect.googleapis.com/v1/userinfo')return json({sub:'SyntheticExportSubject'});
  assert.equal(url.origin,'https://sheets.googleapis.com');
  if(url.pathname.endsWith(':batchUpdate')){
   writes++;const [durable]=await observer`SELECT d.state,d.attempt_at IS NOT NULL attempted,a.delivery_id FROM google_export_delivery d JOIN google_export_write_attempt a ON a.delivery_id=d.id WHERE d.id=${id}`;
   assert.equal(durable?.state,'SENDING');assert.equal(durable?.attempted,true);assert.equal(durable?.delivery_id,id,'independent connection sees committed attempt before the provider');
   const body=JSON.parse(String(init?.body)),properties=body.requests[0].addSheet.properties;assert.equal(body.requests[1].updateCells.fields,'userEnteredValue');assert.equal(body.requests[1].updateCells.start.sheetId,properties.sheetId);
   saved={properties:{...properties,index:1},rows:body.requests[1].updateCells.rows};if(writeHook)await writeHook();if(loseAck)throw Error('Synthetic ACK lost after write');
   return json({spreadsheetId:'SyntheticExportResource',replies:[{addSheet:{properties}},{}]});
  }
  if(url.pathname.endsWith(':getByDataFilter')){
   reads++;if(readFailure)return new Response('{}',{status:503,headers:{'content-type':'application/json'}});assert.ok(saved);const body=JSON.parse(String(init?.body)),grid=body.dataFilters[0].gridRange;assert.equal(grid.sheetId,saved.properties.sheetId);
   const rows=structuredClone(saved.rows.slice(grid.startRowIndex,grid.endRowIndex));if(mismatch)rows[0]!.values[0]!.userEnteredValue={stringValue:'Synthetic changed cell'};
   return json({spreadsheetId:'SyntheticExportResource',sheets:[{properties:saved.properties,data:[{startRow:grid.startRowIndex,startColumn:grid.startColumnIndex,rowData:rows}]}]});
  }
  assert.equal(init?.method,'GET');if(preflightHook)await preflightHook();return json({spreadsheetId:'SyntheticExportResource',properties:{title:'Synthetic export destination',locale:'en_US',timeZone:'UTC'},sheets:[{properties:{sheetId:0,title:'Existing data',index:0,sheetType:'GRID',gridProperties:{rowCount:1000,columnCount:10}}},...(saved?[{properties:saved.properties}]:[])]});
 });
 const work=()=>processOneGoogleExportDelivery(db,adapter,{batchRows:25,retryDelaySeconds:0});return {...f,id,root,intent,preview,adapter,work,stats:()=>({writes,reads,refreshes}),setLostAck:(v:boolean)=>{loseAck=v;},setReadFailure:(v:boolean)=>{readFailure=v;},setMismatch:(v:boolean)=>{mismatch=v;},onPreflight:(fn:()=>Promise<void>)=>{preflightHook=fn;},onWrite:(fn:()=>Promise<void>)=>{writeHook=fn;}};
}
test('Google export delivery commits one actual attempt before HTTP, treats ACK as pending, independently verifies typed pages and isolates private history',async t=>{
 const f=await deliveryFixture(t,60),{api}=f;const replay=await api('POST',f.root+'/delivery',f.intent);assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().id,f.id);
 assert.equal((await api('POST',f.root+'/delivery',{...f.intent,confirmed:false})).statusCode,400);assert.equal((await api('GET',f.root+'/delivery',undefined,'admin')).statusCode,404);
 await Promise.all([f.work(),f.work()]);let state=(await api('GET',f.root+'/delivery')).json();assert.equal(state.delivery.state,'VERIFYING');assert.equal(state.delivery.verifiedRows,0);assert.equal(f.stats().writes,1);
 for(let i=0;i<4;i++)await f.work();state=(await api('GET',f.root+'/delivery')).json();assert.equal(state.delivery.state,'DONE');assert.equal(state.delivery.verifiedRows,63);assert.equal(f.stats().writes,1);assert.equal(f.stats().reads,3);
 assert.equal((await api('POST',f.root+'/delivery/reconcile',{version:state.delivery.version,reason:'Cannot replay completion'})).statusCode,409);
 const exposed=JSON.stringify(state);for(const secret of ['SyntheticExportAccess','SyntheticExportRefresh','SYNTHETIC HIDDEN',f.long])assert.ok(!exposed.includes(secret));
 assert.equal((await f.db`SELECT count(*)::int n FROM google_export_write_attempt WHERE delivery_id=${f.id}`)[0]!.n,1);
});
test('Google export lost ACK is UNKNOWN without replay; fresh explicit reconciliation reads only and bounded read failure recovers without a second write',async t=>{
 const f=await deliveryFixture(t),{api}=f;f.setLostAck(true);await f.work();let d=(await api('GET',f.root+'/delivery')).json().delivery;assert.equal(d.state,'UNKNOWN');assert.equal(await f.work(),false);assert.equal(f.stats().writes,1);
 const recovery=()=>api('POST',f.root+'/delivery/reconcile',{version:d.version,reason:'Read only independent reconciliation'});assert.equal((await recovery()).statusCode,200);
 f.setReadFailure(true);for(let i=0;i<5;i++)await f.work();d=(await api('GET',f.root+'/delivery')).json().delivery;assert.equal(d.state,'DEAD_LETTER');assert.equal(d.failures,5);assert.equal(f.stats().writes,1);
 f.setReadFailure(false);assert.equal((await recovery()).statusCode,200);await f.work();d=(await api('GET',f.root+'/delivery')).json().delivery;assert.equal(d.state,'DONE');assert.equal(f.stats().writes,1);assert.equal(f.stats().reads,6);
});
test('Google export rechecks real authority after independent metadata and cannot confirm changed external cells or cancel an attempted write',async t=>{
 const f=await deliveryFixture(t),{api}=f;f.setMismatch(true);await f.work();await f.work();const d=(await api('GET',f.root+'/delivery')).json().delivery;assert.equal(d.state,'NEEDS_ATTENTION');assert.equal(d.errorCode,'GOOGLE_EXPORT_READ_MISMATCH');assert.equal(d.verifiedRows,0);
 assert.equal((await api('POST',f.root+'/delivery/cancel',{version:d.version,reason:'Cannot retract an external write'})).statusCode,409);assert.equal(f.stats().writes,1);
});
test('Google export revocation during metadata preserves core data and prevents a durable attempt or external write',async t=>{
 const f=await deliveryFixture(t);f.onPreflight(()=>f.sharing(f.a,1,false));await f.work();const [d]=await f.db`SELECT * FROM google_export_delivery WHERE id=${f.id}`;assert.equal(d!.state,'NEEDS_ATTENTION');assert.equal(d!.attempt_at,null);assert.equal(f.stats().writes,0);assert.equal((await f.api('GET',f.root+'/delivery')).statusCode,403);
});
test('Google export refresh uses its genuine delivery lease after approval-session logout without creating sessions or borrowing Connection administrator authority',async t=>{
 const f=await deliveryFixture(t),{api,db}=f;f.setTokenExpires(5);const checked=await api('POST','/api/google/connections/'+f.cid+'/test',{version:1},'admin');assert.equal(checked.statusCode,200,checked.body);f.setTokenExpires(3600);
 const before=(await db`SELECT count(*)::int n FROM user_session`)[0]!.n;await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${f.actors.manager!.sid}`;
 await f.work();const [op]=await db`SELECT * FROM google_oauth_operation WHERE export_delivery_id=${f.id}`;assert.equal(op!.kind,'RUNTIME');assert.equal(op!.state,'VERIFIED');assert.equal(op!.session_id,f.actors.manager!.sid);assert.equal(op!.actor_id,f.actors.manager!.id);assert.equal(f.stats().refreshes,1);assert.equal(f.stats().writes,0);
 assert.equal((await api('GET',f.root+'/delivery')).statusCode,401);for(let i=0;i<3;i++)await f.work();const d=(await api('GET',f.root+'/delivery',undefined,'alternate')).json().delivery;assert.equal(d.state,'DONE');assert.equal(f.stats().writes,1);assert.equal((await db`SELECT count(*)::int n FROM user_session`)[0]!.n,before);
});
test('A lost post-provider commit leaves a durable attempted lease, becomes UNKNOWN on its real expiry and never replays the write',async t=>{
 const f=await deliveryFixture(t),{db,api}=f;let installed=false;
 try{
  f.onWrite(async()=>{await db.unsafe("CREATE FUNCTION test_google_delivery_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='GOOGLE_EXPORT_DELIVERY_STATE' AND NEW.detail->>'state'='VERIFYING' THEN RAISE EXCEPTION 'Synthetic post-provider commit failure';END IF;RETURN NEW;END $$");await db.unsafe('CREATE TRIGGER test_google_delivery_commit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_google_delivery_commit_failure()');installed=true;});
  await assert.rejects(f.work(),/Synthetic post-provider commit failure/);let [d]=await db`SELECT *,GREATEST(0,ceil(extract(epoch FROM lease_until-clock_timestamp())*1000))::integer wait_ms FROM google_export_delivery WHERE id=${f.id}`;assert.equal(d!.state,'SENDING');assert.ok(d!.attempt_at);assert.equal(f.stats().writes,1);assert.equal(await f.work(),false);
  await db.unsafe('DROP TRIGGER test_google_delivery_commit_failure ON audit_log');await db.unsafe('DROP FUNCTION test_google_delivery_commit_failure()');installed=false;
  await new Promise(resolve=>setTimeout(resolve,d!.wait_ms+100));await f.work();[d]=await db`SELECT * FROM google_export_delivery WHERE id=${f.id}`;assert.equal(d!.state,'UNKNOWN');assert.equal(f.stats().writes,1);
  assert.equal((await api('POST',f.root+'/delivery/reconcile',{version:d!.version,reason:'Reconcile only after real lease expiry'})).statusCode,200);await f.work();assert.equal((await api('GET',f.root+'/delivery')).json().delivery.state,'DONE');assert.equal(f.stats().writes,1);
 }finally{if(installed){await db.unsafe('DROP TRIGGER test_google_delivery_commit_failure ON audit_log');await db.unsafe('DROP FUNCTION test_google_delivery_commit_failure()');}}
});
