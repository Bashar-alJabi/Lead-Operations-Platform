import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {processOneExport,exportActor,exportVisible,exportPage,exportCellPage,exportCellHeader,exportInput,type ExportJob} from '../src/exports/service.js';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const url=process.env.TEST_DATABASE_URL;if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated test database required');
async function fixture(t:TestContext){
 process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000}),cleanup:(()=>Promise<void>)[]=[];t.after(async()=>{try{for(const fn of cleanup)await fn();}finally{await app.close();await db.end();}});
 app.addHook('onError',async(_q,_r,error)=>{if(!('statusCode'in error)||Number(error.statusCode)>=500)t.diagnostic('Synthetic Bulk fixture error: '+error.message);});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Bulk fields') RETURNING id`)[0]!.id,branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Bulk A') RETURNING id`)[0]!.id,other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Bulk B') RETURNING id`)[0]!.id,
  foreignOrg=(await db`INSERT INTO organization(name) VALUES('Foreign bulk') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,bid] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['agent','AGENT',branch],['second','AGENT',branch],['other','MANAGER',other],['foreign','SUPER_ADMIN',null]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${name==='foreign'?foreignOrg:org},${bid},${role},${name},${name+'@bulk.test'},'synthetic') RETURNING id`)[0]!.id,token=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={id,session,cookie:'lop_session='+token};
 }
 const campaigns:string[]=[];for(const b of [branch,other])campaigns.push((await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES(${org},${b},'Bulk operations','ACTIVE') RETURNING id`)[0]!.id);
 const leads:string[]=[];for(const [b,c,owner] of [[branch,campaigns[0],users.agent!.id],[branch,campaigns[0],users.second!.id],[other,campaigns[1],null]] as const)leads.push((await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind) VALUES(${org},${b},${c!},${owner},'MANUAL') RETURNING id`)[0]!.id);
 const api=(method:'GET'|'POST'|'PUT'|'PATCH',path:string,payload?:object,who='manager')=>app.inject({method,url:path,payload,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}});


 const fields:Record<string,string>={};
 for(const [key,type,mode] of [['visible','TEXT','MANUAL'],['hidden','TEXT','MANUAL'],['calculated','CALCULATED','CALCULATED']] as const){
  const made=await api('POST','/api/fields',{scope:'CAMPAIGN',branchId:branch,campaignId:campaigns[0],key:'export_'+key,label:key==='visible'?'=Visible <img src=x>':key,fieldType:type,valueMode:mode,options:[],validation:{},...(type==='CALCULATED'?{calculation:{kind:'AI_CONTACT_ATTEMPTS'}}:{})});assert.equal(made.statusCode,201,made.body);fields[key]=made.json().id;
  const bind=await api('PUT','/api/campaigns/'+campaigns[0]+'/fields/'+fields[key],{active:true,position:0,requiredStage:'NONE',visibleToAgent:key!=='hidden',editableByAgent:key==='visible',visibleToManager:key!=='hidden',editableByManager:key==='visible',showInTable:true,showInDetails:true,filterable:true,usableByAutomation:false,usableByAi:false});assert.equal(bind.statusCode,200,bind.body);
 }
 for(const [i,id] of leads.slice(0,2).entries()){const contact=(await db`INSERT INTO contact(organization_id,name,phone,phone_normalized) VALUES(${org},${i===0?'=HYPERLINK(\"https://invalid.test\")':'Second synthetic'},${'+1555888990'+i},${'+1555888990'+i}) RETURNING id`)[0]!.id;await db`UPDATE lead SET contact_id=${contact} WHERE id=${id}`;const secret=await api('PUT','/api/leads/'+id+'/fields/'+fields.hidden,{value:'SENSITIVE-SYNTHETIC-HIDDEN'},'admin');assert.equal(secret.statusCode,200,secret.body);const v=await api('PUT','/api/leads/'+id+'/fields/'+fields.visible,{value:'=CUSTOMER_FORMULA'});assert.equal(v.statusCode,200,v.body);}
 const input=(overrides:object={})=>({filters:{campaignId:campaigns[0],sort:'CREATED_ASC'},columns:['contact','campaign'],fieldIds:[fields.visible,fields.calculated],selectedIds:[],requestId:randomUUID(),confirmed:true,...overrides});
 const create=async(body:object=input(),who='manager')=>{const r=await api('POST','/api/lead-exports',body,who);assert.equal(r.statusCode,202,r.body);return r.json().id as string;};
 const status=async(id:string,who='manager')=>{const r=await api('GET','/api/lead-exports/'+id,undefined,who);assert.equal(r.statusCode,200,r.body);return r.json();};
 return {db,app,org,branch,other,users,campaigns,leads,api,fields,input,create,status,cleanup};
}

test('Durable export captures authorized membership once across concurrent creation/workers, then streams current typed values and calculated facts with CSV protection',async t=>{
 const {db,api,input,create,status,fields,leads}=await fixture(t),body=input();
 const jobs=await Promise.all(Array.from({length:8},()=>create(body)));assert.equal(new Set(jobs).size,1);const id=jobs[0]!;
 assert.equal((await api('GET','/api/lead-exports/'+id+'/download')).statusCode,409);
 await Promise.all(Array.from({length:8},()=>processOneExport(db)));const state=await status(id);assert.equal(state.state,'DONE');assert.equal(state.rowCount,2);
 assert.equal((await db`SELECT count(*)::int n FROM lead_export_member WHERE job_id=${id}`)[0]!.n,2);assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='LEAD_EXPORT_REQUESTED'`)[0]!.n,1);
 assert.equal((await api('POST','/api/lead-exports',{...body,columns:['id']})).statusCode,409);
 const changed=await api('PUT','/api/leads/'+leads[0]+'/fields/'+fields.visible,{version:1,value:'=CURRENT_VALUE'});assert.equal(changed.statusCode,200,changed.body);
 const file=await api('GET','/api/lead-exports/'+id+'/download');assert.equal(file.statusCode,200,file.body);assert.match(file.headers['content-disposition'] as string,/attachment; filename="leads-[a-f0-9-]+.csv"/);assert.equal(file.headers['cache-control'],'no-store');
 assert.ok(file.body.startsWith('\uFEFF'));assert.ok(file.body.includes('"\t=Visible <img src=x> (export_visible)"'));assert.ok(file.body.includes('"\t=CURRENT_VALUE"'));assert.ok(file.body.includes('"0"'));assert.ok(!file.body.includes('=CUSTOMER_FORMULA')||file.body.includes('"\t=CUSTOMER_FORMULA"'));
 assert.ok(!file.body.includes('export_hidden'));assert.ok(!file.body.includes('SENSITIVE-SYNTHETIC-HIDDEN'));assert.equal((await create(body)),id);assert.equal(await processOneExport(db),false);
 for(const table of ['conversation_message','payment_record','enrollment'])assert.equal((await db.unsafe('SELECT count(*)::int n FROM '+table))[0]!.n,0);
 // A field may be authorized for filters without being a displayed/exportable column.
 await db`UPDATE campaign_field SET show_in_details=false,show_in_table=false,version=version+1 WHERE field_id=${fields.visible!}`;
 const filtered=await create(input({filters:{campaignId:body.filters.campaignId,fieldId:fields.visible,fieldValue:JSON.stringify('=CUSTOMER_FORMULA')},fieldIds:[],columns:['contact']}));
 await processOneExport(db);assert.equal((await status(filtered)).rowCount,1);assert.equal((await api('GET','/api/lead-exports/'+filtered+'/download')).statusCode,200);
 assert.equal((await api('POST','/api/lead-exports',input())).statusCode,404);
});

test('Shared export cell projection preserves literal/long values and calculated zero with current field visibility, without CSV encoding leaking into Google payloads',async t=>{
 const {db,api,create,input,fields,leads,branch,campaigns}=await fixture(t);
 const made=await api('POST','/api/fields',{scope:'CAMPAIGN',branchId:branch,campaignId:campaigns[0],key:'long_export',label:'=Long export',fieldType:'LONG_TEXT',valueMode:'MANUAL',options:[],validation:{}});assert.equal(made.statusCode,201,made.body);const longId=made.json().id;
 const bound=await api('PUT','/api/campaigns/'+campaigns[0]+'/fields/'+longId,{active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:true,visibleToManager:true,editableByManager:true,showInTable:true,showInDetails:true,filterable:true,usableByAutomation:false,usableByAi:false});assert.equal(bound.statusCode,200,bound.body);
 const id=await create(input({fieldIds:[longId,fields.calculated]}));await processOneExport(db);
 const text='=RAW()\n'+ 'ع'.repeat(19993),changed=await api('PUT','/api/leads/'+leads[0]+'/fields/'+longId,{value:text});assert.equal(changed.statusCode,200,changed.body);
 await db.begin(async tx=>{
  const j=(await tx`SELECT *,expires_at<=clock_timestamp() expired FROM lead_export_job WHERE id=${id}`)[0] as ExportJob,actor=await exportActor(tx,j),visible=await exportVisible(tx,actor,j);
  const header=exportCellHeader(exportInput(j),visible),page=await exportCellPage(tx,actor,j,null,visible);assert.equal(page.count,2);assert.equal(header[4],'=Long export (long_export)');
  assert.equal(page.cells[0]![0],'=HYPERLINK("https://invalid.test")');assert.equal(page.cells[0]![4],text);assert.equal(page.cells[0]![5],0);assert.ok(!JSON.stringify(page.cells).includes('SENSITIVE-SYNTHETIC-HIDDEN'));
  const csv=await exportPage(tx,actor,j,null,visible);assert.ok(csv.csv.includes('"\t=RAW()'));assert.equal(page.cells[0]![4],text,'CSV encoder never mutates raw cells');assert.equal((await exportCellPage(tx,actor,j,page.next,visible)).count,0);
 });
 await db`UPDATE campaign_field SET visible_to_manager=false,editable_by_manager=false,version=version+1 WHERE field_id=${longId}`;
 await assert.rejects(db.begin(async tx=>{const j=(await tx`SELECT *,expires_at<=clock_timestamp() expired FROM lead_export_job WHERE id=${id}`)[0] as ExportJob,actor=await exportActor(tx,j);return exportCellPage(tx,actor,j,null,[]);}),/EXPORT_FIELDS_NOT_AVAILABLE/);
});

test('Export denies hidden fields and foreign scope, respects current Agent ownership before processing/download/replay, and fails closed on session and role changes',async t=>{
 const {db,api,input,create,status,users,leads,fields,other}=await fixture(t);
 const hidden=await api('POST','/api/lead-exports/preview',input({fieldIds:[fields.hidden]})),unknown=await api('POST','/api/lead-exports/preview',input({fieldIds:[randomUUID()]}));
 // Preview schema deliberately rejects creation-only properties; actual previews use the typed contract.
 assert.equal(hidden.statusCode,400);assert.equal(unknown.statusCode,400);
 function preview(overrides:object={}){const {requestId,confirmed,...b}=input(overrides);return api('POST','/api/lead-exports/preview',b);}
 const h=await preview({fieldIds:[fields.hidden]}),u=await preview({fieldIds:[randomUUID()]});assert.equal(h.statusCode,404,h.body);assert.equal(u.statusCode,404,u.body);assert.deepEqual(h.json(),u.json());
 assert.equal((await preview({filters:{branchId:other},fieldIds:[]})).statusCode,403);
 assert.equal((await api('POST','/api/lead-exports',{...input(),confirmed:false})).statusCode,400);
 const body=input({selectedIds:[leads[0],leads[1],leads[2],randomUUID()]}),id=await create(body,'agent');
 await processOneExport(db);assert.equal((await status(id,'agent')).rowCount,1);
 const plain=await create(input({columns:['contact'],fieldIds:[],selectedIds:[leads[0]!]}),'agent');await processOneExport(db);
 for(const who of ['manager','other','foreign','second'])assert.equal((await api('GET','/api/lead-exports/'+id+'/download',undefined,who)).statusCode,404);
 const move=await api('POST','/api/leads/'+leads[0]+'/assignment',{version:1,agentId:null});assert.equal(move.statusCode,200,move.body);
 assert.equal((await db`SELECT lead_export_lead_visible(j,l) AS ok FROM lead_export_job j JOIN lead l ON l.id=${leads[0]!} WHERE j.id=${plain}`)[0]!.ok,false);
 assert.equal((await api('GET','/api/lead-exports/'+plain+'/download',undefined,'agent')).statusCode,403);
 const forged=await create(input({columns:['id'],fieldIds:[],selectedIds:[leads[0]!]}),'agent');
 await assert.rejects(db`INSERT INTO lead_export_member(job_id,lead_id,branch_id,campaign_id,lead_created_at,page_version)
  SELECT ${forged},id,branch_id,campaign_id,created_at,2 FROM lead WHERE id=${leads[0]!}`,/EXPORT_CURRENT_MEMBER_PROOF/);
 assert.equal((await api('POST','/api/lead-exports/'+forged+'/cancel',{version:1},'agent')).statusCode,200);
 assert.equal((await api('GET','/api/lead-exports/'+id+'/download',undefined,'agent')).statusCode,404,'Selected Campaign fields no longer readable without any owned Lead');
 assert.equal((await api('POST','/api/lead-exports',body,'agent')).statusCode,404);assert.ok(!(await api('GET','/api/lead-exports',undefined,'agent')).body.includes('row_count'));
 const manager=await create();await processOneExport(db);
 await db`UPDATE user_account SET role='AGENT' WHERE id=${users.manager!.id}`;assert.equal((await api('GET','/api/lead-exports/'+manager+'/download')).statusCode,403);
 await db`UPDATE user_account SET role='MANAGER' WHERE id=${users.manager!.id}`;
 const pending=await create();
 await db`UPDATE campaign_field SET visible_to_manager=false,editable_by_manager=false,version=version+1 WHERE field_id=${fields.visible!}`;
 assert.equal((await api('GET','/api/lead-exports/'+manager+'/download')).statusCode,404);await processOneExport(db);assert.equal((await db`SELECT state FROM lead_export_job WHERE id=${pending}`)[0]!.state,'REVOKED');
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;assert.equal((await api('GET','/api/lead-exports/'+manager+'/download')).statusCode,401);
});

test('Export page Audit failure rolls back membership/progress, persists bounded failure state, and current-session recovery resumes without duplicating rows',async t=>{
 const {db,api,create,status,cleanup}=await fixture(t),id=await create();
 await db`CREATE FUNCTION test_export_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='LEAD_EXPORT_STATE_CHANGED' AND NEW.detail->>'state'='DONE' THEN RAISE EXCEPTION 'Synthetic private export failure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER test_export_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_export_audit_failure()`;
 cleanup.push(async()=>{await db`DROP TRIGGER IF EXISTS test_export_audit_failure ON audit_log`;await db`DROP FUNCTION IF EXISTS test_export_audit_failure()`;});
 for(let i=0;i<5;i++){
  if(i)await new Promise(r=>setTimeout(r,2**(i-1)*1000+30));assert.equal(await processOneExport(db),true);
  assert.equal((await db`SELECT count(*)::int n FROM lead_export_member WHERE job_id=${id}`)[0]!.n,0);
 }
 const failed=await status(id);assert.equal(failed.state,'DEAD_LETTER');assert.equal(failed.errorCode,'EXPORT_PROCESSING_FAILED');assert.ok(!JSON.stringify(failed).includes('Synthetic private'));
 await db`DROP TRIGGER test_export_audit_failure ON audit_log`;
 const recovery=await Promise.all(Array.from({length:8},()=>api('POST','/api/lead-exports/'+id+'/retry',{version:failed.version})));assert.equal(recovery.filter(r=>r.statusCode===200).length,1);assert.equal(recovery.filter(r=>r.statusCode===409).length,7);
 assert.equal(await processOneExport(db),true);assert.equal((await status(id)).rowCount,2);
 const done=await status(id);await assert.rejects(db`UPDATE lead_export_job SET filters='{}'::jsonb,version=version+1 WHERE id=${id}`,/EXPORT_ENVELOPE_IMMUTABLE/);
 await assert.rejects(db`UPDATE lead_export_member SET branch_id=branch_id WHERE job_id=${id}`,/EXPORT_MEMBERSHIP_IMMUTABLE/);
 await assert.rejects(db`DELETE FROM lead_export_history WHERE job_id=${id}`,/EXPORT_HISTORY_IMMUTABLE/);
 const deleted=await api('POST','/api/lead-exports/'+id+'/cancel',{version:done.version});assert.equal(deleted.statusCode,200,deleted.body);assert.equal((await db`SELECT count(*)::int n FROM lead_export_member WHERE job_id=${id}`)[0]!.n,0);
 assert.equal((await api('GET','/api/lead-exports/'+id+'/download')).statusCode,410);assert.ok((await db`SELECT count(*)::int n FROM lead_export_history WHERE job_id=${id}`)[0]!.n>0);
});

test('Large Export runs in compiled worker across keyset pages, preserves microsecond ordering and Saved View selection without unbounded response payloads',async t=>{
 const {db,api,create,status,org,branch,campaigns,leads,users}=await fixture(t);
 await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind,created_at)
  SELECT ${org},${branch},${campaigns[0]!},${users.agent!.id},'MANUAL','2020-01-01'::timestamptz+i*interval '1 microsecond' FROM generate_series(1,2505) i`;
 const view=await api('POST','/api/lead-views',{name:'Export view',scope:'PERSONAL',filters:{campaignId:campaigns[0],sort:'CREATED_ASC'},columns:['source','created_at']});assert.equal(view.statusCode,201,view.body);
 const views=await api('GET','/api/lead-views');const saved=views.json().items.find((v:any)=>v.id===view.json().id);
 const id=await create({filters:saved.filters,columns:saved.columns,fieldIds:[],selectedIds:[],requestId:randomUUID(),confirmed:true});
 const worker=spawn(process.execPath,[resolve('dist/src/export-worker.js')],{env:{...process.env,DATABASE_URL:url,EXPORT_WORKER_ONCE:'1',EXPORT_WORKER_BATCH:'100'},windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';worker.stdout.on('data',d=>{log+=String(d);});worker.stderr.on('data',d=>{log+=String(d);});const code=await new Promise<number|null>(r=>worker.once('exit',r));assert.equal(code,0,log);assert.ok(!log.includes('cycle_failed'),log);
 const s=await status(id);assert.equal(s.state,'DONE');assert.equal(s.rowCount,2507);assert.equal(s.history.length,25);assert.ok(s.nextHistoryVersion);const older=await api('GET','/api/lead-exports/'+id+'/history?before='+s.nextHistoryVersion);assert.equal(older.statusCode,200,older.body);assert.ok(older.json().items.length>0);assert.ok(older.json().items.every((h:any)=>h.version<s.nextHistoryVersion));const file=await api('GET','/api/lead-exports/'+id+'/download');assert.equal(file.statusCode,200,file.body);assert.equal(file.body.split('\r\n').length,2509);assert.match(file.body,/00:00:00\.000001/);assert.match(file.body,/00:00:00\.002505/);
 assert.equal((await db`SELECT count(DISTINCT lead_id)::int n FROM lead_export_member WHERE job_id=${id}`)[0]!.n,2507);
 await db.begin(async tx=>{await tx`SET LOCAL TIME ZONE 'Asia/Damascus'`;
  const j=(await tx`SELECT *,created_at::text AS created_text,cursor_at::text AS cursor_text,expires_at<=clock_timestamp() AS expired FROM lead_export_job WHERE id=${id}`)[0] as ExportJob;
  const actor=await exportActor(tx,j),fields=await exportVisible(tx,actor,j),page=await exportPage(tx,actor,j,null,fields);
  assert.match(page.csv,/2020-01-01T00:00:00\.000001Z/);
 });
 assert.ok((await api('GET','/api/lead-exports?limit=1')).body.length<1500);
 const future=await create({filters:{campaignId:campaigns[0]},columns:['id'],fieldIds:[],selectedIds:[leads[0]!],requestId:randomUUID(),confirmed:true});await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;await processOneExport(db);assert.equal((await db`SELECT state FROM lead_export_job WHERE id=${future}`)[0]!.state,'REVOKED');
});

test('Export expires by actual DB clock, purges private membership and preserves history; login-session revocation grants no download but cannot impersonate a background Human session',async t=>{
 const {db,api,create,status,users,cleanup}=await fixture(t),prior=process.env.EXPORT_RETENTION_SECONDS;
 cleanup.push(async()=>{if(prior===undefined)delete process.env.EXPORT_RETENTION_SECONDS;else process.env.EXPORT_RETENTION_SECONDS=prior;});
 process.env.EXPORT_RETENTION_SECONDS='3';const id=await create();await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
 assert.equal(await processOneExport(db),true);assert.equal((await db`SELECT state FROM lead_export_job WHERE id=${id}`)[0]!.state,'DONE');
 assert.equal((await api('GET','/api/lead-exports/'+id+'/download')).statusCode,401);
 const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${users.manager!.id},${sha256(token)},clock_timestamp()+interval '1 hour')`;users.manager!.cookie='lop_session='+token;
 assert.equal((await api('GET','/api/lead-exports/'+id+'/download')).statusCode,200);const remaining=(await db`SELECT ceil(extract(epoch FROM expires_at-clock_timestamp())*1000)::int ms FROM lead_export_job WHERE id=${id}`)[0]!.ms;
 await new Promise(r=>setTimeout(r,Math.max(0,remaining)+30));assert.equal((await api('GET','/api/lead-exports/'+id+'/download')).statusCode,410);assert.equal(await processOneExport(db),true);
 assert.equal((await db`SELECT state FROM lead_export_job WHERE id=${id}`)[0]!.state,'EXPIRED');assert.equal((await db`SELECT count(*)::int n FROM lead_export_member WHERE job_id=${id}`)[0]!.n,0);assert.equal((await db`SELECT state FROM lead_export_history WHERE job_id=${id} ORDER BY version DESC LIMIT 1`)[0]!.state,'EXPIRED');
});
