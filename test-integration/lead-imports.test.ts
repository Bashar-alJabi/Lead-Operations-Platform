import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import * as XLSX from 'xlsx';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {localMediaStorage} from '../src/media/storage.js';
import {clamAvScanner} from '../src/media/scanner.js';
import {processOneImportFile,cleanupImportStorage} from '../src/imports/service.js';
import {processOneImportReview} from '../src/imports/review.js';
const url=process.env.TEST_DATABASE_URL;if(!url||new URL(url).pathname!=='/lead_operations_test')throw Error('Isolated test database required');
async function fixture(t:TestContext){
 process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const root=await mkdtemp(resolve('.local/import-test-')),storage=localMediaStorage(root),db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000,mediaStorage:storage});
 const cleanup:(()=>Promise<void>)[]=[];t.after(async()=>{try{for(const fn of cleanup)await fn();}finally{await app.close();await db.end();if(!resolve(root).startsWith(resolve('.local/import-test-')))throw Error('Unsafe cleanup path');await rm(root,{recursive:true,force:true});}});
 app.addHook('onError',async(_q,_r,e)=>{if(!('statusCode'in e)||Number(e.statusCode)>=500)t.diagnostic('Synthetic import error: '+e.message);});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Import synthetic') RETURNING id`)[0]!.id,foreignOrg=(await db`INSERT INTO organization(name) VALUES('Foreign') RETURNING id`)[0]!.id;
 const branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Import A') RETURNING id`)[0]!.id,other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Import B') RETURNING id`)[0]!.id;
 const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES(${org},${branch},'Import target') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,bid] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['agent','AGENT',branch],['other','MANAGER',other],['foreign','SUPER_ADMIN',null]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${name==='foreign'?foreignOrg:org},${bid},${role},${name},${name+'@import.test'},'synthetic') RETURNING id`)[0]!.id,
   token=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={id,session,cookie:'lop_session='+token};
 }
 const api=(method:'GET'|'POST'|'PUT'|'PATCH',path:string,payload?:object,who='manager')=>app.inject({method,url:path,payload,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}});
 const input={branchId:branch,campaignId:campaign,label:'test.csv',format:'CSV',delimiter:',',requestId:randomUUID()};
 const bytes=Buffer.from('name,phone\r\n"<img src=x onerror=alert(1)>",001234\r\n=untrusted,+331234');
 const upload=(overrides:Record<string,string>={},data:Buffer=bytes,who='manager')=>app.inject({method:'POST',url:'/api/lead-imports?'+new URLSearchParams({...input,...overrides}),payload:data,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!,'content-type':'application/octet-stream'}});
 const scan={scan:async()=>({clean:true,version:'SyntheticScanner/test'})};
 const work=(options:Parameters<typeof processOneImportFile>[1]={})=>processOneImportFile(db,{storage,scanner:scan,...options});
 const status=async(id:string,who='manager')=>{const r=await api('GET','/api/lead-imports/'+id,undefined,who);assert.equal(r.statusCode,200,r.body);return r.json();};
 const create=async(overrides:Record<string,string>={},data:Buffer=bytes)=>{const r=await upload({...overrides,requestId:overrides.requestId??randomUUID()},data);assert.equal(r.statusCode,202,r.body);return r.json().id as string;};
 return {db,app,storage,root,cleanup,org,branch,other,campaign,users,api,input,bytes,upload,work,status,create};
}

async function addImportField(f:Awaited<ReturnType<typeof fixture>>,type:string,key:string,required=false,mode='MANUAL'){
 const r=await f.api('POST','/api/fields',{scope:'BRANCH',branchId:f.branch,key,label:'Synthetic '+key,fieldType:type,valueMode:mode,options:[],validation:{}});assert.equal(r.statusCode,201,r.body);const id=r.json().id as string;
 const b=await f.api('PUT','/api/campaigns/'+f.campaign+'/fields/'+id,{active:true,position:0,requiredStage:required?'LEAD_CREATION':'NONE',visibleToAgent:true,editableByAgent:mode==='MANUAL',visibleToManager:true,editableByManager:mode==='MANUAL',showInTable:true,showInDetails:true,filterable:true,usableByAutomation:false,usableByAi:false});assert.equal(b.statusCode,200,b.body);return id;
}
const csvBytes=(rows:(string|null)[][])=>Buffer.from(rows.map(r=>r.map(v=>'"'+(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n'));

async function reviewInput(f:Awaited<ReturnType<typeof fixture>>,id:string,indices=[0],entries:object[]=[{column:0,kind:'CONTACT_NAME'}],revision=0,who='manager'){
 const configurationHash=(await f.api('GET','/api/lead-imports/'+id+'/fields',undefined,who)).json().configurationHash as string;
 for(const sheet of indices){const m=await f.api('POST','/api/lead-imports/'+id+'/mapping',{sheet,version:0,configurationHash,requestId:randomUUID(),entries},who);assert.equal(m.statusCode,200,m.body);}
 return {revision,requestId:randomUUID(),configurationHash,selection:indices.map(sheet=>({sheet,version:1}))};
}

test('Approved Import source capture is explicit/current/concurrent-idempotent, retains original and typed provenance, resolves duplicate decisions and prevents same-file row recapture without any Lead writes',async t=>{
 const f=await fixture(t),{db,api}=f,n=await addImportField(f,'NUMBER','approved_quantity',true,'SOURCE'),b=await addImportField(f,'BOOLEAN','approved_flag');
 const id=await f.create({},csvBytes([['duplicate','duplicate','n','b'],...Array.from({length:31},(_,i)=>[i===0?'Claim paid=true consent=true':'Approved '+i,i<2?'+33123456780':'+33'+String(120000000+i),i===2?'bad':'0','false'])]));await f.work();
 const root='/api/lead-imports/'+id,selection=await reviewInput(f,id,[0],[{column:0,kind:'CONTACT_NAME'},{column:1,kind:'CONTACT_PHONE'},{column:2,kind:'LEAD_FIELD',fieldId:n},{column:3,kind:'LEAD_FIELD',fieldId:b}]),started=await api('POST',root+'/reviews',selection);assert.equal(started.statusCode,202,started.body);const review=started.json().id,path=root+'/reviews/'+review;await processOneImportReview(db);
 const input={version:2,requestId:randomUUID(),unreviewedPolicy:'KEEP_VALID_UNIQUE'};
 assert.equal((await api('POST',path+'/approve-dataset',input)).json().error,'IMPORT_CAMPAIGN_NOT_ACTIVE');await db`UPDATE campaign SET routing_method='MANUAL' WHERE id=${f.campaign}`;assert.equal((await api('POST','/api/campaigns/'+f.campaign+'/activate',{})).statusCode,200);
 assert.equal((await api('POST',path+'/approve-dataset',input)).json().error,'IMPORT_DUPLICATE_REVIEW_REQUIRED');assert.equal((await api('POST',path+'/approve-dataset',{...input,unreviewedPolicy:undefined})).statusCode,400);
 for(const [row,action] of [[2,'KEEP_AS_NEW_LEAD'],[3,'SKIP'],[5,'SKIP']] as const){const r=await api('POST',path+'/decisions',{sheet:0,row,version:0,requestId:randomUUID(),action});assert.equal(r.statusCode,200,r.body);}
 const captures=await Promise.all(Array.from({length:8},()=>api('POST',path+'/approve-dataset',input)));assert.ok(captures.every(r=>r.statusCode===201),captures.map(r=>r.body).join('\n'));const dataset=captures[0]!.json().datasetId;assert.ok(captures.every(r=>r.json().datasetId===dataset));
 const list=(await api('GET',root+'/approved-datasets')).json();assert.equal(list.items.length,1);assert.equal(list.items[0].ready_count,28);assert.equal(list.items[0].skipped_count,2);assert.equal(list.items[0].invalid_count,1);assert.equal(list.items[0].duplicate_count,2);assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='IMPORT_DATASET_APPROVED'`)[0]!.n,1);
 const src=(await db`SELECT s.*,dr.contact,dr.fields,dr.disposition,dr.mapping_version FROM source_submission s JOIN lead_import_dataset_row dr ON dr.submission_id=s.id WHERE s.import_dataset_id=${dataset} AND s.import_row_number=2`)[0]!;
 assert.equal(src.source_kind,'IMPORT_CSV');assert.equal(src.state,'RECEIVED');assert.equal(src.raw_payload.schema,2);assert.equal(src.raw_payload.fileId,id);assert.equal(src.raw_payload.datasetId,dataset);assert.equal(src.raw_payload.row.cells[0],'Claim paid=true consent=true');assert.equal(src.raw_payload.row.cells[1],'+33123456780');assert.equal(src.raw_payload.mappingVersion,1);assert.deepEqual(src.fields.map((v:any)=>v.value),[0,false]);assert.equal(src.disposition,'READY_FOR_INTAKE');assert.equal(src.mapping_version,1);
 const manifest=(await db`SELECT * FROM lead_import_dataset_sheet WHERE dataset_id=${dataset}`)[0]!;assert.deepEqual(manifest.headers,['duplicate','duplicate','n','b']);assert.equal(manifest.mapping_version,1);assert.equal(manifest.row_count,31);assert.ok(!JSON.stringify(src.raw_payload).includes('entries'));await assert.rejects(db`UPDATE lead_import_dataset_sheet SET headers='["forged"]'::jsonb WHERE dataset_id=${dataset}`,/IMPORT_DATASET_SHEET_IMMUTABLE/);
 const page=await api('GET',root+'/approved-datasets/'+dataset+'/rows');assert.equal(page.statusCode,200,page.body);assert.equal(page.headers['cache-control'],'no-store');assert.equal(page.json().items.length,25);const cursor=page.json().next;assert.equal((await api('GET',root+'/approved-datasets/'+dataset+'/rows?afterSheet='+cursor.sheet+'&afterRow='+cursor.row)).json().items.length,6);assert.ok(!page.body.includes('Claim paid'));assert.ok(!page.body.includes(n));assert.ok(!page.body.includes('contact'));
 assert.equal((await api('POST',path+'/approve-dataset',{...input,version:3})).statusCode,409);assert.equal((await api('POST',path+'/approve-dataset',{...input,requestId:randomUUID()})).json().error,'IMPORT_DATASET_ALREADY_APPROVED');
 // Later review choices cannot rewrite the retained source decision.
 assert.equal((await api('POST',path+'/decisions',{sheet:0,row:2,version:1,requestId:randomUUID(),action:'SKIP'})).statusCode,200);assert.equal((await db`SELECT disposition,decision_version FROM lead_import_dataset_row WHERE submission_id=${src.id}`)[0]!.decision_version,1);
 const next=await api('POST',root+'/reviews',{...selection,revision:1,requestId:randomUUID()});assert.equal(next.statusCode,202,next.body);await processOneImportReview(db);const again=await api('POST',root+'/reviews/'+next.json().id+'/approve-dataset',{...input,requestId:randomUUID()});assert.equal(again.statusCode,409,again.body);assert.equal(again.json().error,'IMPORT_SOURCE_ROW_ALREADY_APPROVED');
 for(const who of ['admin','agent','other','foreign'])for(const route of [root+'/approved-datasets',root+'/approved-datasets/'+dataset+'/rows'])assert.equal((await api('GET',route,undefined,who)).statusCode,404);
 await assert.rejects(db`UPDATE lead_import_dataset SET ready_count=0 WHERE id=${dataset}`,/IMPORT_DATASET_IMMUTABLE/);await assert.rejects(db`DELETE FROM lead_import_dataset_row WHERE dataset_id=${dataset}`,/IMPORT_DATASET_ROW_IMMUTABLE/);await assert.rejects(db`UPDATE source_submission SET state='PROCESSED' WHERE id=${src.id}`,/IMPORT_SOURCE_IMMUTABLE/);
 const file=await f.status(id);assert.equal((await api('POST',root+'/cancel',{version:file.version})).statusCode,200);assert.equal((await db`SELECT count(*)::int n FROM lead_import_row WHERE file_id=${id}`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM source_submission WHERE import_dataset_id=${dataset}`)[0]!.n,31);assert.equal((await api('POST',path+'/approve-dataset',input)).statusCode,201);assert.equal((await api('GET',root+'/approved-datasets/'+dataset+'/rows')).statusCode,200);
 const business=(await db`SELECT (SELECT count(*) FROM lead)::int leads,(SELECT count(*) FROM contact)::int contacts,(SELECT count(*) FROM payment_record)::int payments,(SELECT count(*) FROM enrollment)::int enrollments,(SELECT count(*) FROM lead_intake_receipt)::int receipts`)[0]!;assert.deepEqual({...business},{leads:0,contacts:0,payments:0,enrollments:0,receipts:0});
});

test('Approved Import capture is atomic under mid-source and Audit failures, requires native complete capture/current session and cannot be forged or amended after commit',async t=>{
 const f=await fixture(t),{db,api,users}=f,id=await f.create({},csvBytes([['name'],...Array.from({length:31},(_,i)=>['Original '+i])]));await f.work();const root='/api/lead-imports/'+id,started=await api('POST',root+'/reviews',await reviewInput(f,id));assert.equal(started.statusCode,202,started.body);const review=started.json().id,path=root+'/reviews/'+review;await processOneImportReview(db);await db`UPDATE campaign SET routing_method='MANUAL' WHERE id=${f.campaign}`;assert.equal((await api('POST','/api/campaigns/'+f.campaign+'/activate',{})).statusCode,200);
 const configurationHash=(await db`SELECT configuration_hash FROM lead_import_review WHERE id=${review}`)[0]!.configuration_hash;
 await assert.rejects(db.begin(async tx=>{const dataset=randomUUID(),requestId=randomUUID();await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(${f.org},${f.branch},${users.manager!.id},'IMPORT_DATASET_APPROVED','LEAD_IMPORT_DATASET',${dataset},${tx.json({sessionId:users.manager!.session,requestId,reviewId:review,reviewVersion:2,configurationHash,unreviewedPolicy:'KEEP_VALID_UNIQUE'})})`;
  await tx`INSERT INTO lead_import_dataset(id,file_id,review_id,request_key,review_version,session_id,unreviewed_policy,configuration_hash,total,ready_count,skipped_count,invalid_count,duplicate_count)
   VALUES(${dataset},${id},${review},${requestId},2,${users.manager!.session},'KEEP_VALID_UNIQUE',${configurationHash},31,31,0,0,0)`;}),/IMPORT_DATASET_COMPLETE_CAPTURE_REQUIRED/);
 await assert.rejects(db`INSERT INTO source_submission(organization_id,branch_id,campaign_id,source_kind,raw_payload) VALUES(${f.org},${f.branch},${f.campaign},'IMPORT_CSV','{}'::jsonb)`,/IMPORT_SOURCE_CAPTURE_PROOF/);
 await db`CREATE FUNCTION test_import_capture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.import_row_number=22 THEN RAISE EXCEPTION 'Synthetic source capture failure';END IF;RETURN NEW;END $$`;await db`CREATE TRIGGER test_import_capture_failure BEFORE INSERT ON source_submission FOR EACH ROW EXECUTE FUNCTION test_import_capture_failure()`;
 f.cleanup.push(async()=>{await db`DROP TRIGGER IF EXISTS test_import_capture_failure ON source_submission`;await db`DROP FUNCTION IF EXISTS test_import_capture_failure()`;await db`DROP TRIGGER IF EXISTS test_import_capture_audit ON audit_log`;await db`DROP FUNCTION IF EXISTS test_import_capture_audit()`;});
 const input={version:2,requestId:randomUUID(),unreviewedPolicy:'KEEP_VALID_UNIQUE'};assert.equal((await api('POST',path+'/approve-dataset',input)).statusCode,500);assert.equal((await db`SELECT count(*)::int n FROM source_submission`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM lead_import_dataset`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='IMPORT_DATASET_APPROVED'`)[0]!.n,0);await db`DROP TRIGGER test_import_capture_failure ON source_submission`;
 await db`CREATE FUNCTION test_import_capture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IMPORT_DATASET_APPROVED' THEN RAISE EXCEPTION 'Synthetic capture Audit failure';END IF;RETURN NEW;END $$`;await db`CREATE TRIGGER test_import_capture_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_import_capture_audit()`;
 assert.equal((await api('POST',path+'/approve-dataset',input)).statusCode,500);assert.equal((await db`SELECT count(*)::int n FROM source_submission`)[0]!.n,0);await db`DROP TRIGGER test_import_capture_audit ON audit_log`;
 assert.equal((await api('POST',path+'/approve-dataset',input)).statusCode,201);const source=(await db`SELECT id FROM source_submission LIMIT 1`)[0]!.id;await assert.rejects(db`UPDATE source_submission SET raw_payload='{}'::jsonb WHERE id=${source}`,/IMPORT_SOURCE_IMMUTABLE|SOURCE_ORIGINAL/);await assert.rejects(db`DELETE FROM source_submission WHERE id=${source}`,/IMPORT_SOURCE_RETAINED|SOURCE_ORIGINAL/);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;assert.equal((await api('POST',path+'/approve-dataset',input)).statusCode,401);assert.equal((await api('GET',root+'/approved-datasets')).statusCode,401);
});

test('Super Admin captures only explicitly selected Excel sheets and retains original SourceSubmissions/acknowledgement after raw-file DB-clock expiry without exposing captured cell values',async t=>{
 const f=await fixture(t),{db,api}=f,previous=process.env.IMPORT_RETENTION_SECONDS;f.cleanup.push(async()=>{if(previous===undefined)delete process.env.IMPORT_RETENTION_SECONDS;else process.env.IMPORT_RETENTION_SECONDS=previous;});process.env.IMPORT_RETENTION_SECONDS='4';
 const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['name'],['Not selected']]),'First');XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['name'],['Private retained original'],['Another original']]),'Second');
 const upload=await f.upload({label:'approval.xlsx',format:'XLSX',requestId:randomUUID()},XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer,'admin');assert.equal(upload.statusCode,202,upload.body);const id=upload.json().id,root='/api/lead-imports/'+id;await f.work();const started=await api('POST',root+'/reviews',await reviewInput(f,id,[1],[{column:0,kind:'CONTACT_NAME'}],0,'admin'),'admin');assert.equal(started.statusCode,202,started.body);await processOneImportReview(db);await db`UPDATE campaign SET routing_method='MANUAL' WHERE id=${f.campaign}`;assert.equal((await api('POST','/api/campaigns/'+f.campaign+'/activate',{},'admin')).statusCode,200);
 const path=root+'/reviews/'+started.json().id+'/approve-dataset',input={version:2,requestId:randomUUID(),unreviewedPolicy:'KEEP_VALID_UNIQUE'},approved=await api('POST',path,input,'admin');assert.equal(approved.statusCode,201,approved.body);const dataset=approved.json().datasetId;
 const sources=await db`SELECT source_kind,import_sheet_index,raw_payload FROM source_submission WHERE import_dataset_id=${dataset} ORDER BY import_row_number`;assert.equal(sources.length,2);assert.ok(sources.every(s=>s.source_kind==='IMPORT_EXCEL'&&s.import_sheet_index===1&&s.raw_payload.sheetIndex===1));assert.equal(sources[0]!.raw_payload.row.cells[0],'Private retained original');assert.equal((await db`SELECT name FROM lead_import_dataset_sheet WHERE dataset_id=${dataset}`)[0]!.name,'Second');
 await new Promise(resolve=>setTimeout(resolve,4100));await f.work();assert.equal((await db`SELECT count(*)::int n FROM lead_import_row WHERE file_id=${id}`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM lead_import_review_row WHERE file_id=${id}`)[0]!.n,0);
 assert.equal((await api('POST',path,input,'admin')).statusCode,201);const list=await api('GET',root+'/approved-datasets',undefined,'admin'),rows=await api('GET',root+'/approved-datasets/'+dataset+'/rows',undefined,'admin');assert.equal(list.statusCode,200,list.body);assert.equal(rows.statusCode,200,rows.body);assert.equal(rows.json().items.length,2);assert.ok(!rows.body.includes('Private retained'));assert.ok(!rows.body.includes('fields'));assert.equal((await api('GET',root+'/approved-datasets')).statusCode,404);
 assert.equal((await db`SELECT count(*)::int n FROM source_submission WHERE import_dataset_id=${dataset}`)[0]!.n,2);assert.equal((await db`SELECT count(*)::int n FROM lead`)[0]!.n,0);
});

test('Whole-file review validates bounded atomic chunks across selected sheets, survives logout/restart, finds identity duplicates and preserves explicit concurrent decisions without intake writes',async t=>{
 const f=await fixture(t),{db,api}=f,n=await addImportField(f,'NUMBER','whole_quantity'),book=XLSX.utils.book_new();
 for(let s=0;s<2;s++)XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['name','phone','email','quantity'],...Array.from({length:61+s},(_,i)=>[s===0&&i===0?'<svg onload=untrusted>':'Synthetic '+s+':'+i,i===0?'+33123456780':'+33'+String(120000000+s*1000+i),'IMPORT'+s+'_'+i+'@EXAMPLE.TEST',s===0&&i===1?'bad':'0'])]),'Sheet '+s);
 const id=await f.create({label:'whole.xlsx',format:'XLSX'},XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer);await f.work();const root='/api/lead-imports/'+id+'/reviews',body=await reviewInput(f,id,[0,1],[{column:0,kind:'CONTACT_NAME'},{column:1,kind:'CONTACT_PHONE'},{column:2,kind:'CONTACT_EMAIL'},{column:3,kind:'LEAD_FIELD',fieldId:n}]);
 const start=await Promise.all(Array.from({length:8},()=>api('POST',root,body)));assert.ok(start.every(r=>r.statusCode===202),start.map(r=>r.body).join('\n'));const review=start[0]!.json().id as string,path=root+'/'+review;assert.ok(start.every(r=>r.json().id===review));
 assert.equal((await db`SELECT count(*)::int n FROM lead_import_review`)[0]!.n,1);assert.equal((await api('POST',root,{...body,selection:[{sheet:0,version:1}]})).statusCode,409);
 assert.equal((await api('GET',path+'/rows')).statusCode,409);assert.equal(await processOneImportReview(db),true);
 const partial=(await api('GET',path)).json();assert.equal(partial.processed,100);assert.equal(partial.state,'VALIDATING');assert.equal(partial.total,123);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${f.users.manager!.session}`;assert.equal((await api('GET',path)).statusCode,401);
 await Promise.all(Array.from({length:8},()=>processOneImportReview(db)));assert.equal((await db`SELECT state FROM lead_import_review WHERE id=${review}`)[0]!.state,'READY');
 const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${f.users.manager!.id},${sha256(token)},clock_timestamp()+interval '1 hour')`;f.users.manager!.cookie='lop_session='+token;
 const done=(await api('GET',path)).json();assert.equal(done.processed,123);assert.equal(done.valid,122);assert.equal(done.invalid,1);assert.equal(done.summary.duplicates,2);assert.equal(done.summary.unreviewed,123);assert.equal(done.history.length,3);
 const first=await api('GET',path+'/rows');assert.equal(first.statusCode,200,first.body);assert.equal(first.json().items.length,25);assert.equal(first.json().items[0].fields[0].value,0);assert.equal(first.json().targets[0].label,'Synthetic whole_quantity');assert.equal(first.json().items[0].contact.emailNormalized,'import0_0@example.test');
 const keys=new Set<string>();let next:null|{sheet:number;row:number}=null;do{const r=await api('GET',path+'/rows'+(next?'?afterSheet='+next.sheet+'&afterRow='+next.row:''));for(const item of r.json().items){const key=item.sheet_index+':'+item.row_number;assert.ok(!keys.has(key));keys.add(key);}next=r.json().next;}while(next);assert.equal(keys.size,123);
 const duplicates=(await api('GET',path+'/rows?filter=DUPLICATE')).json();assert.deepEqual(duplicates.items.map((r:any)=>[r.sheet_index,r.row_number]),[[0,2],[1,2]]);
 assert.equal((await api('GET',path+'/rows?filter=INVALID')).json().items.length,1);assert.equal((await api('GET',path+'/rows?afterSheet=0')).statusCode,400);
 const decision={sheet:0,row:2,version:0,requestId:randomUUID(),action:'KEEP_AS_NEW_LEAD'};const decisions=await Promise.all(Array.from({length:8},()=>api('POST',path+'/decisions',decision)));assert.ok(decisions.every(r=>r.statusCode===200),decisions.map(r=>r.body).join('\n'));
 assert.equal((await db`SELECT count(*)::int n FROM lead_import_review_decision`)[0]!.n,1);assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='IMPORT_REVIEW_DECIDED'`)[0]!.n,1);
 assert.equal((await api('POST',path+'/decisions',{...decision,action:'SKIP'})).statusCode,409);
 const races=await Promise.all(Array.from({length:2},()=>api('POST',path+'/decisions',{...decision,version:1,requestId:randomUUID(),action:'SKIP'})));assert.deepEqual(races.map(r=>r.statusCode).sort(),[200,409]);
 assert.equal((await api('POST',path+'/decisions',{...decision,row:3,requestId:randomUUID()})).statusCode,409);
 for(let version=2;version<27;version++){const r=await api('POST',path+'/decisions',{...decision,version,requestId:randomUUID()});assert.equal(r.statusCode,200,r.body);}
 const history=(await api('GET',path+'/decisions?sheet=0&row=2')).json();assert.equal(history.items.length,25);assert.equal((await api('GET',path+'/decisions?sheet=0&row=2&before='+history.nextVersion)).json().items.length,2);
 assert.equal((await api('GET',path)).json().summary.kept,1);assert.equal((await api('GET',path)).json().summary.unreviewed,122);
 for(const who of ['admin','agent','other','foreign'])for(const suffix of ['', '/rows','/decisions?sheet=0&row=2'])assert.equal((await api('GET',path+suffix,undefined,who)).statusCode,404);
 const business=(await db`SELECT (SELECT count(*) FROM lead)::int leads,(SELECT count(*) FROM contact)::int contacts,(SELECT count(*) FROM source_submission)::int sources,(SELECT count(*) FROM payment_record)::int payments,(SELECT count(*) FROM enrollment)::int enrollments`)[0]!;assert.deepEqual({...business},{leads:0,contacts:0,sources:0,payments:0,enrollments:0});
 await assert.rejects(db`UPDATE lead_import_review_row SET valid=false WHERE review_id=${review}`,/IMPORT_REVIEW_ROW_IMMUTABLE/);await assert.rejects(db`DELETE FROM lead_import_review_row WHERE review_id=${review}`,/IMPORT_REVIEW_ROWS_RETAINED/);
 await assert.rejects(db`UPDATE lead_import_review_decision SET action='SKIP' WHERE review_id=${review}`,/IMPORT_REVIEW_DECISION_IMMUTABLE/);
 const file=await f.status(id);assert.equal((await api('POST','/api/lead-imports/'+id+'/cancel',{version:file.version})).statusCode,200);assert.equal((await api('GET',path+'/rows')).statusCode,410);
 assert.equal((await db`SELECT count(*)::int n FROM lead_import_review_row WHERE review_id=${review}`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM lead_import_review_decision WHERE review_id=${review}`)[0]!.n,27);
});

test('Whole-file review invalidates partial and ready values on current config/mapping/role changes; new selections use CAS and never reuse stale validation',async t=>{
 const f=await fixture(t),{db,api}=f,n=await addImportField(f,'NUMBER','stale_quantity'),id=await f.create({},csvBytes([['name','n'],...Array.from({length:105},(_,i)=>['Row '+i,'0'])]));await f.work();
 const root='/api/lead-imports/'+id+'/reviews',input=await reviewInput(f,id,[0],[{column:0,kind:'CONTACT_NAME'},{column:1,kind:'LEAD_FIELD',fieldId:n}]);const r=await api('POST',root,input);assert.equal(r.statusCode,202,r.body);const path=root+'/'+r.json().id;await processOneImportReview(db);
 await db`UPDATE campaign_field SET visible_to_manager=false,editable_by_manager=false,version=version+1 WHERE campaign_id=${f.campaign} AND field_id=${n}`;
 const stale=await api('GET',path+'/rows');assert.equal(stale.statusCode,409,stale.body);assert.ok(!stale.body.includes(n));assert.equal((await api('GET',path)).json().state,'STALE');
 await processOneImportReview(db);assert.equal((await db`SELECT count(*)::int n FROM lead_import_review_row`)[0]!.n,0);assert.equal((await db`SELECT state FROM lead_import_review`)[0]!.state,'STALE');
 const current=(await api('GET','/api/lead-imports/'+id+'/fields')).json().configurationHash;
 const mapping={sheet:0,version:1,configurationHash:current,requestId:randomUUID(),entries:[{column:0,kind:'CONTACT_NAME'}]};assert.equal((await api('POST','/api/lead-imports/'+id+'/mapping',mapping)).statusCode,200);
 const next={...input,revision:1,requestId:randomUUID(),configurationHash:current,selection:[{sheet:0,version:2}]};const races=await Promise.all(Array.from({length:2},()=>api('POST',root,{...next,requestId:randomUUID()})));assert.deepEqual(races.map(r=>r.statusCode).sort(),[202,409]);const fresh=races.find(r=>r.statusCode===202)!.json().id as string;
 await processOneImportReview(db);await processOneImportReview(db);assert.equal((await api('GET',root+'/'+fresh)).json().state,'READY');
 assert.equal((await api('POST','/api/lead-imports/'+id+'/mapping',{...mapping,version:2,requestId:randomUUID()})).statusCode,200);
 assert.equal((await api('GET',root+'/'+fresh+'/rows')).statusCode,409);assert.equal((await api('POST',root+'/'+fresh+'/decisions',{sheet:0,row:2,version:0,requestId:randomUUID(),action:'SKIP'})).statusCode,409);
 await db`UPDATE user_account SET branch_id=${f.other} WHERE id=${f.users.manager!.id}`;assert.equal((await api('GET',root)).statusCode,403);
});

test('Whole-file review rolls back partially inserted chunks on failure, exhausts bounded retries, requires real-session CAS recovery and rejects native forgeries/Audit failure',async t=>{
 const f=await fixture(t),{db,api,users}=f,id=await f.create({},csvBytes([['name'],...Array.from({length:2101},(_,i)=>['Failure row '+i])]));await f.work();const root='/api/lead-imports/'+id+'/reviews',input=await reviewInput(f,id),r=await api('POST',root,input);assert.equal(r.statusCode,202,r.body);const review=r.json().id as string,path=root+'/'+review;
 await db`CREATE FUNCTION test_import_review_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.row_number=22 THEN RAISE EXCEPTION 'Synthetic private row failure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER test_import_review_failure BEFORE INSERT ON lead_import_review_row FOR EACH ROW EXECUTE FUNCTION test_import_review_failure()`;
 f.cleanup.push(async()=>{await db`DROP TRIGGER IF EXISTS test_import_review_failure ON lead_import_review_row`;await db`DROP FUNCTION IF EXISTS test_import_review_failure()`;await db`DROP TRIGGER IF EXISTS test_import_review_audit ON audit_log`;await db`DROP FUNCTION IF EXISTS test_import_review_audit()`;});
 for(let i=0;i<5;i++)await processOneImportReview(db,{retryDelaySeconds:0});const failed=(await api('GET',path)).json();assert.equal(failed.state,'FAILED');assert.equal(failed.processed,0);assert.equal(failed.errorCode,'IMPORT_REVIEW_PROCESSING_FAILED');assert.ok(!JSON.stringify(failed).includes('Synthetic private'));
 assert.equal((await db`SELECT count(*)::int n FROM lead_import_review_row`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='IMPORT_REVIEW_PROGRESS'`)[0]!.n,0);
 await db`DROP TRIGGER test_import_review_failure ON lead_import_review_row`;
 const retries=await Promise.all(Array.from({length:8},()=>api('POST',path+'/retry',{version:failed.version})));assert.equal(retries.filter(r=>r.statusCode===200).length,1);assert.equal(retries.filter(r=>r.statusCode===409).length,7);
 for(let chunk=0;chunk<22;chunk++)assert.equal(await processOneImportReview(db),true);const completed=(await api('GET',path)).json();assert.equal(completed.state,'READY');assert.equal(completed.processed,2101);assert.equal(completed.history.length,25);assert.equal((await api('GET',path+'?before='+completed.nextVersion)).json().history.length,4);
 await assert.rejects(db`UPDATE lead_import_review SET state='VALIDATING',version=version+1 WHERE id=${review}`,/IMPORT_REVIEW_TRANSITION/);
 await assert.rejects(db`UPDATE lead_import_review SET total=1,version=version+1 WHERE id=${review}`,/IMPORT_REVIEW_IMMUTABLE/);
 await assert.rejects(db`DELETE FROM lead_import_review_history WHERE review_id=${review}`,/IMPORT_REVIEW_HISTORY_IMMUTABLE/);
 await assert.rejects(db`INSERT INTO lead_import_review_decision(review_id,sheet_index,row_number,version,request_key,session_id,action) VALUES(${review},0,2,1,${randomUUID()},${users.manager!.session},'SKIP')`,/IMPORT_REVIEW_DECISION_PROOF/);
 await db`CREATE FUNCTION test_import_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IMPORT_REVIEW_DECIDED' THEN RAISE EXCEPTION 'Synthetic review Audit failure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER test_import_review_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_import_review_audit()`;
 const decision={sheet:0,row:2,version:0,requestId:randomUUID(),action:'SKIP'};assert.equal((await api('POST',path+'/decisions',decision)).statusCode,500);assert.equal((await db`SELECT count(*)::int n FROM lead_import_review_decision`)[0]!.n,0);await db`DROP TRIGGER test_import_review_audit ON audit_log`;assert.equal((await api('POST',path+'/decisions',decision)).statusCode,200);
 const version=(await api('GET',path)).json().version;await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;assert.equal((await api('POST',path+'/cancel',{version})).statusCode,401);
});

test('Whole-file validation cannot continue after account revocation or raw-file DB-clock expiry; cancellation purges derived values and preserves metadata',async t=>{
 const f=await fixture(t),{db,api}=f,id=await f.create({},csvBytes([['name'],...Array.from({length:105},(_,i)=>['Revoked '+i])]));await f.work();const root='/api/lead-imports/'+id+'/reviews',input=await reviewInput(f,id),r=await api('POST',root,input);assert.equal(r.statusCode,202,r.body);await processOneImportReview(db);
 await db`UPDATE user_account SET active=false WHERE id=${f.users.manager!.id}`;await processOneImportReview(db);assert.equal((await db`SELECT state FROM lead_import_review WHERE id=${r.json().id}`)[0]!.state,'STALE');assert.equal((await db`SELECT count(*)::int n FROM lead_import_review_row`)[0]!.n,0);await db`UPDATE user_account SET active=true WHERE id=${f.users.manager!.id}`;
 const previous=process.env.IMPORT_RETENTION_SECONDS;f.cleanup.push(async()=>{if(previous===undefined)delete process.env.IMPORT_RETENTION_SECONDS;else process.env.IMPORT_RETENTION_SECONDS=previous;});process.env.IMPORT_RETENTION_SECONDS='3';
 const expiring=await f.create({},Buffer.from('name\nExpires')),expiredRoot='/api/lead-imports/'+expiring+'/reviews';await f.work();const exp=await api('POST',expiredRoot,await reviewInput(f,expiring));assert.equal(exp.statusCode,202,exp.body);await processOneImportReview(db);
 await new Promise(resolve=>setTimeout(resolve,3100));assert.equal((await api('GET',expiredRoot+'/'+exp.json().id+'/rows')).statusCode,410);await f.work();assert.equal((await db`SELECT count(*)::int n FROM lead_import_review_row WHERE file_id=${expiring}`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM lead_import_review_history WHERE review_id=${exp.json().id}`)[0]!.n,2);
});

test('Import mapping has native immutable revisions, concurrent same-key/CAS safety and paged typed preview without intake authority',async t=>{
 const f=await fixture(t),{db,api}=f,n=await addImportField(f,'NUMBER','quantity',true),b=await addImportField(f,'BOOLEAN','available'),tags=await addImportField(f,'TAGS','tags');
 const rows=Array.from({length:31},(_,i)=>['Synthetic '+i,'+33 1 23 45 67 89','UPPER@EXAMPLE.TEST',i===1?'1e2':'0',i===1?'yes':'false','["x","y"]']);
 const id=await f.create({},csvBytes([['duplicate','duplicate','__proto__','quantity','boolean','tags'],...rows]));await f.work();
 const fields=await api('GET','/api/lead-imports/'+id+'/fields');assert.equal(fields.statusCode,200,fields.body);
 const input={sheet:0,version:0,configurationHash:fields.json().configurationHash,requestId:randomUUID(),entries:[{column:0,kind:'CONTACT_NAME'},{column:1,kind:'CONTACT_PHONE'},{column:2,kind:'CONTACT_EMAIL'},{column:3,kind:'LEAD_FIELD',fieldId:n},{column:4,kind:'LEAD_FIELD',fieldId:b},{column:5,kind:'LEAD_FIELD',fieldId:tags}]};
 const responses=await Promise.all(Array.from({length:8},()=>api('POST','/api/lead-imports/'+id+'/mapping',input)));assert.ok(responses.every(r=>r.statusCode===200),responses.map(r=>r.body).join('\n'));
 assert.equal((await db`SELECT count(*)::int n FROM lead_import_mapping_revision`)[0]!.n,1);assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='IMPORT_MAPPING_SAVED'`)[0]!.n,1);
 const preview=await api('GET','/api/lead-imports/'+id+'/validation?sheet=0&version=1');assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().items.length,25);assert.equal(preview.json().items[0].valid,true);assert.equal(preview.json().items[0].contact.phoneNormalized,'+33123456789');assert.equal(preview.json().items[0].contact.emailNormalized,'upper@example.test');assert.deepEqual(preview.json().items[0].fields.map((v:any)=>v.value),[0,false,['x','y']]);assert.equal(preview.json().items[1].valid,false);assert.equal(preview.json().items[1].errors.length,3);
 const next=await api('GET','/api/lead-imports/'+id+'/validation?sheet=0&version=1&after='+preview.json().nextRow);assert.equal(next.json().items.length,6);
 assert.equal((await api('POST','/api/lead-imports/'+id+'/mapping',{...input,entries:[{column:0,kind:'CONTACT_EMAIL'}]})).statusCode,409);
 const races=await Promise.all(Array.from({length:2},()=>api('POST','/api/lead-imports/'+id+'/mapping',{...input,version:1,requestId:randomUUID()})));assert.deepEqual(races.map(r=>r.statusCode).sort(),[200,409]);
 assert.equal((await api('GET','/api/lead-imports/'+id+'/validation?sheet=0&version=1')).statusCode,409);
 for(let version=2;version<27;version++){const r=await api('POST','/api/lead-imports/'+id+'/mapping',{...input,version,requestId:randomUUID()});assert.equal(r.statusCode,200,r.body);}
 const m=await api('GET','/api/lead-imports/'+id+'/mapping?sheet=0');assert.equal(m.json().history.length,25);assert.ok(m.json().nextVersion);const more=await api('GET','/api/lead-imports/'+id+'/mapping?sheet=0&before='+m.json().nextVersion);assert.equal(more.json().history.length,2);
 await assert.rejects(db`UPDATE lead_import_mapping_revision SET entries='[]'::jsonb`,/IMPORT_MAPPING_IMMUTABLE/);await assert.rejects(db`DELETE FROM lead_import_mapping_revision`,/IMPORT_MAPPING_IMMUTABLE/);
 await assert.rejects(db`INSERT INTO lead_import_mapping_revision SELECT file_id,sheet_index,28,${randomUUID()},session_id,entries,configuration_hash,clock_timestamp() FROM lead_import_mapping_revision LIMIT 1`,/IMPORT_MAPPING_CURRENT_PROOF/);
 const totals=(await db`SELECT (SELECT count(*) FROM lead)::int leads,(SELECT count(*) FROM contact)::int contacts,(SELECT count(*) FROM source_submission)::int sources,(SELECT count(*) FROM payment_record)::int payments,(SELECT count(*) FROM enrollment)::int enrollments`)[0]!;assert.deepEqual({...totals},{leads:0,contacts:0,sources:0,payments:0,enrollments:0});
});

test('Import mapping current Field/Session/owner scope prevents stale replay and hides unavailable targets/required fields with bounded catalogs',async t=>{
 const f=await fixture(t),{db,api,campaign,users}=f,id=await f.create({},Buffer.from('a,b\r\n1,synthetic'));await f.work();
 const ids:string[]=[];for(let i=0;i<27;i++)ids.push(await addImportField(f,'NUMBER','paged_'+i,i===0));const source=await addImportField(f,'TEXT','source_value',false,'SOURCE');
 const catalog=await api('GET','/api/lead-imports/'+id+'/fields');assert.equal(catalog.statusCode,200,catalog.body);assert.equal(catalog.json().items.length,25);const next=await api('GET','/api/lead-imports/'+id+'/fields?after='+catalog.json().nextId);assert.equal(next.json().items.length,3);assert.equal(new Set([...catalog.json().items,...next.json().items].map((v:any)=>v.id)).size,28);
 const input={sheet:0,version:0,configurationHash:catalog.json().configurationHash,requestId:randomUUID(),entries:[{column:1,kind:'LEAD_FIELD',fieldId:source}]};
 assert.equal((await api('POST','/api/lead-imports/'+id+'/mapping',input)).statusCode,200);const p=await api('GET','/api/lead-imports/'+id+'/validation?sheet=0&version=1');assert.deepEqual(p.json().items[0].errors,[{column:null,code:'IMPORT_REQUIRED_VALUE_MISSING'}]);assert.ok(!p.body.includes(ids[0]!));
 await db`UPDATE campaign_field SET visible_to_manager=false,editable_by_manager=false,version=version+1 WHERE campaign_id=${campaign} AND field_id=${source}`;
 assert.equal((await api('GET','/api/lead-imports/'+id+'/validation?sheet=0&version=1')).statusCode,409);assert.equal((await api('POST','/api/lead-imports/'+id+'/mapping',input)).statusCode,409);
 const m=await api('GET','/api/lead-imports/'+id+'/mapping?sheet=0');assert.equal(m.json().configurationChanged,true);assert.deepEqual(m.json().entries,[]);assert.deepEqual(m.json().targets,[]);assert.ok(!m.body.includes(source));
 const hidden=await api('POST','/api/lead-imports/'+id+'/mapping',{...input,version:1,requestId:randomUUID(),configurationHash:m.json().configurationHash});assert.equal(hidden.statusCode,404,hidden.body);
 for(const who of ['agent','admin','other','foreign'])for(const path of ['/fields','/mapping?sheet=0','/validation?sheet=0&version=1'])assert.equal((await api('GET','/api/lead-imports/'+id+path,undefined,who)).statusCode,404);
 await db`UPDATE user_session SET revoked_at=now() WHERE id=${users.manager!.session}`;assert.equal((await api('POST','/api/lead-imports/'+id+'/mapping',input)).statusCode,401);
});

test('Import normalized current-contact advice masks cross-branch/shared identities and never merges or changes existing records',async t=>{
 const f=await fixture(t),{db,api,org,branch,other,campaign}=f;
 const otherCampaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES(${org},${other},'Other import scope') RETURNING id`)[0]!.id;
 const contacts:string[]=[];for(let i=0;i<6;i++){
  const phone=i===4?'+33123456783':'+3312345678'+i;
  const c=(await db`INSERT INTO contact(organization_id,name,phone,phone_normalized) VALUES(${org},${i===1?'Hidden other-only':i===2?'Hidden shared':'Visible '+i},${phone},${phone}) RETURNING id`)[0]!.id;contacts.push(c);
  if(i!==5)await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,source_kind) VALUES(${org},${i===1?other:branch},${i===1?otherCampaign:campaign},${c},'MANUAL')`;
  if(i===2)await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,source_kind) VALUES(${org},${other},${otherCampaign},${c},'MANUAL')`;
 }
 const id=await f.create({},csvBytes([['phone'],...Array.from({length:7},(_,i)=>['+33 1 23 45 67 8'+i])]));await f.work();const catalog=await api('GET','/api/lead-imports/'+id+'/fields');
 const body={sheet:0,version:0,configurationHash:catalog.json().configurationHash,requestId:randomUUID(),entries:[{column:0,kind:'CONTACT_PHONE'}]};assert.equal((await api('POST','/api/lead-imports/'+id+'/mapping',body)).statusCode,200);
 const p=await api('GET','/api/lead-imports/'+id+'/validation?sheet=0&version=1');assert.equal(p.statusCode,200,p.body);assert.deepEqual(p.json().items.map((r:any)=>r.match.state),['MATCH','RESTRICTED','RESTRICTED','AMBIGUOUS','NONE','RESTRICTED','NONE']);
 for(const hidden of [contacts[1],contacts[2],contacts[5],'Hidden other-only','Hidden shared'])assert.ok(!p.body.includes(hidden!));
 assert.equal(p.json().items[0].match.candidates[0].id,contacts[0]);assert.equal(p.json().items[3].match.candidates.length,2);
 assert.equal((await db`SELECT count(*)::int n FROM contact`)[0]!.n,6);assert.equal((await db`SELECT count(*)::int n FROM lead`)[0]!.n,6);assert.equal((await db`SELECT count(*)::int n FROM source_submission`)[0]!.n,0);
 // Super Admin uses their own private upload and real session; global review never opens another uploader's file.
 const saUpload=await f.upload({requestId:randomUUID()},csvBytes([['phone'],...Array.from({length:7},(_,i)=>['+33 1 23 45 67 8'+i])]),'admin');assert.equal(saUpload.statusCode,202,saUpload.body);const saId=saUpload.json().id;await f.work();
 const saConfig=await api('GET','/api/lead-imports/'+saId+'/fields',undefined,'admin');assert.equal(saConfig.statusCode,200,saConfig.body);
 const saSave=await api('POST','/api/lead-imports/'+saId+'/mapping',{...body,configurationHash:saConfig.json().configurationHash,requestId:randomUUID()},'admin');assert.equal(saSave.statusCode,200,saSave.body);
 const saPreview=await api('GET','/api/lead-imports/'+saId+'/validation?sheet=0&version=1',undefined,'admin');assert.equal(saPreview.statusCode,200,saPreview.body);assert.deepEqual(saPreview.json().items.map((r:any)=>r.match.state),['MATCH','MATCH','MATCH','AMBIGUOUS','NONE','MATCH','NONE']);assert.ok(saPreview.body.includes(contacts[1]!));assert.ok(saPreview.body.includes(contacts[2]!));assert.ok(saPreview.body.includes(contacts[5]!));
 assert.equal((await api('GET','/api/lead-imports/'+saId+'/validation?sheet=0&version=1')).statusCode,404);
 const cancel=await api('POST','/api/lead-imports/'+id+'/cancel',{version:(await f.status(id)).version});assert.equal(cancel.statusCode,200,cancel.body);assert.equal((await api('GET','/api/lead-imports/'+id+'/validation?sheet=0&version=1')).statusCode,410);assert.equal((await db`SELECT count(*)::int n FROM lead_import_mapping_revision WHERE file_id=${id}`)[0]!.n,1);
});

test('Import mapping Audit rollback and native current proof deny fabricated field/session/column recipes',async t=>{
 const f=await fixture(t),{db,api,cleanup,users}=f,id=await f.create();await f.work();const config=(await api('GET','/api/lead-imports/'+id+'/fields')).json().configurationHash;
 const body={sheet:0,version:0,configurationHash:config,requestId:randomUUID(),entries:[{column:0,kind:'CONTACT_NAME'}]};
 await db.unsafe(`CREATE FUNCTION test_import_mapping_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IMPORT_MAPPING_SAVED' THEN RAISE EXCEPTION 'synthetic mapping secret';END IF;RETURN NEW;END $$`);await db`CREATE TRIGGER test_import_mapping_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_import_mapping_failure()`;
 cleanup.push(async()=>{await db`DROP TRIGGER IF EXISTS test_import_mapping_failure ON audit_log`;await db`DROP FUNCTION IF EXISTS test_import_mapping_failure()`;});
 const failed=await api('POST','/api/lead-imports/'+id+'/mapping',body);assert.equal(failed.statusCode,500,failed.body);assert.ok(!failed.body.includes('synthetic mapping secret'));assert.equal((await db`SELECT count(*)::int n FROM lead_import_mapping_revision`)[0]!.n,0);
 await db`DROP TRIGGER test_import_mapping_failure ON audit_log`;assert.equal((await api('POST','/api/lead-imports/'+id+'/mapping',body)).statusCode,200);
 for(const entries of [[{column:63,kind:'CONTACT_NAME'}],[{column:0,kind:'LEAD_FIELD',fieldId:randomUUID()}],[{column:0,kind:'CONTACT_NAME',unexpected:'forged'}]]){
  await assert.rejects(db.begin(async tx=>{const request=randomUUID();await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(${f.org},${f.branch},${users.manager!.id},'IMPORT_MAPPING_SAVED','LEAD_IMPORT_FILE',${id},${tx.json({version:2,sheet:0,sessionId:users.manager!.session,requestId:request,configurationHash:config})})`;
   await tx`INSERT INTO lead_import_mapping_revision(file_id,sheet_index,version,request_key,session_id,entries,configuration_hash) VALUES(${id},0,2,${request},${users.manager!.session},${tx.json(entries)},${config})`;}),/IMPORT_MAPPING_(COLUMN|FIELD|ENTRY)/);
 }
 assert.equal((await api('POST','/api/lead-imports/'+id+'/mapping',{...body,version:1,requestId:randomUUID(),entries:[{column:0,kind:'CONTACT_NAME'},{column:1,kind:'CONTACT_NAME'}]})).statusCode,400);
});
test('Private upload replay is immutable and concurrency safe; durable scan/parse exposes only paginated escaped raw rows without creating business records',async t=>{
 const {db,api,upload,work,status}=await fixture(t);
 const parallel=await Promise.all(Array.from({length:8},()=>upload()));const accepted=parallel.filter(r=>r.statusCode===202);assert.ok(accepted.length>=1);assert.ok(parallel.every(r=>r.statusCode===202||r.statusCode===429));
 const id=accepted[0]!.json().id;assert.ok(accepted.every(r=>r.json().id===id));assert.equal((await db`SELECT count(*)::int n FROM lead_import_file`)[0]!.n,1);
 assert.equal((await api('GET','/api/lead-imports/'+id+'/rows?sheet=0')).statusCode,409);
 assert.equal(await work(),true);const d=await status(id);assert.equal(d.state,'REVIEW');assert.equal(d.rowCount,2);assert.equal(d.sheets.length,1);
 const p=await api('GET','/api/lead-imports/'+id+'/rows?sheet=0');assert.equal(p.statusCode,200,p.body);assert.deepEqual(p.json().items[0].cells,['<img src=x onerror=alert(1)>','001234']);assert.equal(p.json().items[1].cells[0],'=untrusted');
 assert.ok(!(await status(id)).storage_key);assert.ok(!p.body.includes('lease_token'));assert.equal((await upload()).json().id,id);
 const business=(await db`SELECT (SELECT count(*) FROM lead)::int leads,(SELECT count(*) FROM contact)::int contacts,(SELECT count(*) FROM payment_record)::int payments`)[0]!;assert.deepEqual({...business},{leads:0,contacts:0,payments:0});
});
test('Import enforces current Manager/SA branch and private owner scope, rejects forged file/row/history changes and denies revoked sessions',async t=>{
 const {db,api,upload,create,work,status,users,branch,other,campaign,input}=await fixture(t),id=await create();
 assert.equal((await upload({},undefined,'agent')).statusCode,403);assert.equal((await upload({branchId:other})).statusCode,403);
 assert.equal((await upload({campaignId:randomUUID()})).statusCode,404);
 assert.equal((await upload({requestId:input.requestId},Buffer.from('a\nx'))).statusCode,202);
 assert.equal((await upload({requestId:input.requestId},Buffer.from('a\ny'))).statusCode,409);
 await db`INSERT INTO campaign(organization_id,branch_id,name) SELECT organization_id,${branch},'Paged import '||i FROM branch CROSS JOIN generate_series(1,30) i WHERE id=${branch}`;
 const catalog=await api('GET','/api/lead-imports/catalog?kind=CAMPAIGN&branchId='+branch);assert.equal(catalog.statusCode,200,catalog.body);assert.equal(catalog.json().items.length,25);assert.ok(catalog.json().nextId);
 const next=await api('GET','/api/lead-imports/catalog?kind=CAMPAIGN&branchId='+branch+'&after='+catalog.json().nextId);assert.equal(next.json().items.length,6);assert.equal(new Set([...catalog.json().items,...next.json().items].map((r:any)=>r.id)).size,31);
 assert.equal((await api('GET','/api/lead-imports/catalog?kind=CAMPAIGN&branchId='+other)).json().items.length,0);assert.equal((await api('GET','/api/lead-imports/catalog?kind=BRANCH')).json().items.length,1);
 for(const who of ['admin','agent','other','foreign']){assert.equal((await api('GET','/api/lead-imports/'+id,undefined,who)).statusCode,who==='agent'?404:404);assert.equal((await api('GET','/api/lead-imports/'+id+'/rows?sheet=0',undefined,who)).statusCode,404);}
 await work();assert.equal((await status(id)).state,'REVIEW');
 await assert.rejects(db`UPDATE lead_import_file SET branch_id=${other},version=version+1 WHERE id=${id}`,/IMPORT_FILE_IMMUTABLE/);
 await assert.rejects(db`UPDATE lead_import_row SET cells='["forged","x"]'::jsonb WHERE file_id=${id}`,/IMPORT_ROWS_IMMUTABLE/);
 await assert.rejects(db`DELETE FROM lead_import_row WHERE file_id=${id}`,/IMPORT_ROWS_RETAINED/);
 await assert.rejects(db`DELETE FROM lead_import_file_history WHERE file_id=${id}`,/IMPORT_HISTORY_IMMUTABLE/);
 await assert.rejects(db`INSERT INTO lead_import_sheet(file_id,sheet_index,name,headers,header_row,row_count) VALUES(${id},1,'forged','["a"]'::jsonb,1,1)`,/IMPORT_PARSED_WRITE_PROOF/);
 await db`UPDATE user_account SET branch_id=${other} WHERE id=${users.manager!.id}`;assert.equal((await api('GET','/api/lead-imports/'+id)).statusCode,403);assert.equal((await api('GET','/api/lead-imports')).json().items.length,0);
 await db`UPDATE user_account SET branch_id=${branch} WHERE id=${users.manager!.id}`;await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
 assert.equal((await api('GET','/api/lead-imports/'+id)).statusCode,401);
 assert.ok(campaign);
});
test('Scanner failures have bounded retries, Audit failure rolls back all parsed rows, CAS recovery and cancel/purge preserve only immutable history',async t=>{
 const {db,api,create,work,status,storage,cleanup}=await fixture(t),id=await create();
 for(let i=0;i<5;i++)await work({scanner:{scan:async()=>{throw Error('Synthetic secret scanner unavailable');}},retryDelaySeconds:0});
 const dead=await status(id);assert.equal(dead.state,'DEAD_LETTER');assert.equal(dead.errorCode,'IMPORT_PROCESSING_UNAVAILABLE');assert.ok(!JSON.stringify(dead).includes('Synthetic secret'));
 const retry=await Promise.all(Array.from({length:8},()=>api('POST','/api/lead-imports/'+id+'/retry',{version:dead.version})));assert.equal(retry.filter(r=>r.statusCode===200).length,1);assert.equal(retry.filter(r=>r.statusCode===409).length,7);
 for(let i=0;i<5;i++)await work({scanner:{scan:async()=>{throw Error('Synthetic repeated outage');}},retryDelaySeconds:0});
 const secondDead=await status(id);assert.equal(secondDead.state,'DEAD_LETTER');assert.equal((await api('POST','/api/lead-imports/'+id+'/retry',{version:secondDead.version})).statusCode,200);
 await db`CREATE FUNCTION test_import_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IMPORT_FILE_STATE' AND NEW.detail->>'state'='REVIEW' THEN RAISE EXCEPTION 'Synthetic private parse failure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER test_import_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_import_audit_failure()`;
 cleanup.push(async()=>{await db`DROP TRIGGER IF EXISTS test_import_audit_failure ON audit_log`;await db`DROP FUNCTION IF EXISTS test_import_audit_failure()`;});
 await work({retryDelaySeconds:0});assert.equal((await status(id)).state,'WAITING');assert.equal((await db`SELECT count(*)::int n FROM lead_import_row WHERE file_id=${id}`)[0]!.n,0);
 await db`DROP TRIGGER test_import_audit_failure ON audit_log`;await work();const done=await status(id);assert.equal(done.state,'REVIEW');
 const key=(await db`SELECT storage_key FROM lead_import_file WHERE id=${id}`)[0]!.storage_key;
 assert.equal((await api('POST','/api/lead-imports/'+id+'/cancel',{version:done.version})).statusCode,200);assert.equal((await api('GET','/api/lead-imports/'+id+'/rows?sheet=0')).statusCode,410);
 assert.equal(await cleanupImportStorage(db,storage),true);await assert.rejects(storage.get(key,8388608));assert.equal((await status(id)).purged,true);
 assert.equal((await db`SELECT count(*)::int n FROM lead_import_row WHERE file_id=${id}`)[0]!.n,0);const recent=await status(id);assert.equal(recent.history.length,25);assert.ok(recent.nextVersion);
 const older=await api('GET','/api/lead-imports/'+id+'?before='+recent.nextVersion);assert.equal(older.statusCode,200,older.body);assert.ok(older.json().history.length>0);assert.ok(older.json().history.every((h:any)=>h.version<recent.nextVersion));
});
test('Cancellation, expired leases, disabled actors and DB-clock expiry cannot publish scanned data under obsolete authority; original login is not a fake worker session',async t=>{
 const {db,api,create,work,status,users,cleanup,storage}=await fixture(t);const id=await create();
 let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r;}),wait=new Promise<void>(r=>{release=r;});
 const processing=work({scanner:{scan:async()=>{ready();await wait;return {clean:true,version:'Delayed/test'};}}});await started;
 const running=await status(id);assert.equal(running.state,'RUNNING');assert.equal((await api('POST','/api/lead-imports/'+id+'/cancel',{version:running.version})).statusCode,200);release();await processing;
 assert.equal((await status(id)).state,'CANCELLED');assert.equal((await db`SELECT count(*)::int n FROM lead_import_row`)[0]!.n,0);await cleanupImportStorage(db,storage);
 const revoked=await create();await work({scanner:{scan:async()=>{await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;return {clean:true,version:'Delayed/test'};}}});
 assert.equal((await db`SELECT state FROM lead_import_file WHERE id=${revoked}`)[0]!.state,'REVOKED');await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;await cleanupImportStorage(db,storage);
 const stale=await create();await work({leaseSeconds:0.1,scanner:{scan:async()=>{await new Promise(r=>setTimeout(r,150));return {clean:true,version:'Delayed/test'};}}});assert.equal((await status(stale)).state,'RUNNING');
 await work();assert.equal((await status(stale)).state,'REVIEW');
 const previous=process.env.IMPORT_RETENTION_SECONDS;cleanup.push(async()=>{if(previous===undefined)delete process.env.IMPORT_RETENTION_SECONDS;else process.env.IMPORT_RETENTION_SECONDS=previous;});process.env.IMPORT_RETENTION_SECONDS='2';
 const expiring=await create();await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;await work();assert.equal((await db`SELECT state FROM lead_import_file WHERE id=${expiring}`)[0]!.state,'REVIEW');
 assert.equal((await api('GET','/api/lead-imports/'+expiring+'/rows?sheet=0')).statusCode,401);
 const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${users.manager!.id},${sha256(token)},clock_timestamp()+interval '1 hour')`;users.manager!.cookie='lop_session='+token;
 const ms=(await db`SELECT ceil(extract(epoch FROM expires_at-clock_timestamp())*1000)::int n FROM lead_import_file WHERE id=${expiring}`)[0]!.n;await new Promise(r=>setTimeout(r,Math.max(0,ms)+30));
 assert.equal((await api('GET','/api/lead-imports/'+expiring+'/rows?sheet=0')).statusCode,410);await work();assert.equal((await status(expiring)).state,'EXPIRED');await work();assert.equal((await status(expiring)).purged,true);
});
test('Compiled import worker scans with real local ClamAV, paginates XLSX and rejects EICAR and disguised archives before any business writes',async t=>{
 const {db,api,create,work,status,root}=await fixture(t),book=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['name','phone'],...Array.from({length:125},(_,i)=>['Synthetic '+i,'001'+i])]),'Leads');XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['name'],['Second sheet']]),'Other');
 const id=await create({label:'test.xlsx',format:'XLSX'},XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true}) as Buffer);
 const child=spawn(process.execPath,[resolve('dist/src/import-worker.js')],{windowsHide:true,env:{...process.env,DATABASE_URL:url,MEDIA_STORAGE_BACKEND:'local',MEDIA_LOCAL_ROOT:root,CLAMAV_HOST:'127.0.0.1',CLAMAV_PORT:'3310',IMPORT_WORKER_ONCE:'1',IMPORT_WORKER_BATCH:'1'},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',d=>{log+=String(d);});child.stderr.on('data',d=>{log+=String(d);});assert.equal(await new Promise(r=>child.once('exit',r)),0,log);assert.ok(!log.includes('cycle_failed'),log);
 assert.equal((await status(id)).state,'REVIEW');assert.equal((await status(id)).rowCount,126);let cursor=1,seen=0;
 do{const r=await api('GET','/api/lead-imports/'+id+'/rows?sheet=0&after='+cursor);assert.equal(r.statusCode,200,r.body);assert.ok(r.json().items.length<=25);seen+=r.json().items.length;cursor=r.json().nextRow;}while(cursor);assert.equal(seen,125);
 const eicar='X5O!P%@AP[4'+String.fromCharCode(92)+'PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
 const infected=await create({label:'eicar.csv'},Buffer.from(eicar));await work({scanner:clamAvScanner('127.0.0.1',3310)});assert.equal((await status(infected)).state,'REJECTED');assert.equal((await status(infected)).errorCode,'IMPORT_CONTENT_REJECTED');
 await work();const bad=await create({label:'bad.xlsx',format:'XLSX'},Buffer.from('PK\x03\x04bad archive'));await work();assert.equal((await status(bad)).state,'REJECTED');assert.equal((await api('GET','/api/lead-imports/'+bad+'/rows?sheet=0')).statusCode,409);
 assert.equal((await db`SELECT count(*)::int n FROM lead`)[0]!.n,0);
});
test('Upload authenticates before parsing, enforces origin/body/format limits, uses generated private keys and rejects storage tampering without partial preview',async t=>{
 const {app,db,upload,create,api,input,users,work,status,storage}=await fixture(t);
 assert.equal((await app.inject({method:'POST',url:'/api/lead-imports?'+new URLSearchParams(input),payload:Buffer.from('x'),headers:{'content-type':'application/octet-stream'}})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url:'/api/lead-imports?'+new URLSearchParams(input),payload:Buffer.from('x'),headers:{cookie:users.manager!.cookie,origin:'https://foreign.test','content-type':'application/octet-stream'}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/lead-imports?'+new URLSearchParams(input)+'&branchId='+input.branchId,payload:Buffer.from('x'),headers:{cookie:users.admin!.cookie,origin:process.env.APP_ORIGIN!,'content-type':'application/octet-stream'}})).statusCode,400);
 assert.equal((await upload({label:'bad.exe'})).statusCode,400);assert.equal((await upload({label:'bad.xlsx',format:'XLSX'})).statusCode,400);
 assert.equal((await upload({},Buffer.from([255,254]))).statusCode,400);assert.equal((await upload({},Buffer.alloc(8388609,65))).statusCode,413);
 const id=await create({label:'../../untrusted.csv'}),j=(await db`SELECT * FROM lead_import_file WHERE id=${id}`)[0]!;
 assert.match(j.storage_key,/^[a-f0-9-]{36}-[a-f0-9]{64}$/);assert.ok(!j.storage_key.includes('untrusted'));
 await work({storage:{...storage,get:async()=>Buffer.from('tampered')}});assert.equal((await status(id)).state,'REJECTED');assert.equal((await status(id)).errorCode,'IMPORT_STORAGE_INTEGRITY_FAILED');assert.equal((await api('GET','/api/lead-imports/'+id+'/rows?sheet=0')).statusCode,409);
 const valid=await create();await work({storage:{...storage,remove:async()=>{throw Error('Synthetic private storage outage');}}});assert.equal((await status(valid)).state,'REVIEW','One failed deletion must not block another inspection');
 const rejected=await status(id);assert.equal(rejected.cleanupError,'IMPORT_FILE_PURGE_FAILED');const backoff=(await db`SELECT cleanup_next_run_at>clock_timestamp() AS future FROM lead_import_file WHERE id=${id}`)[0]!;assert.equal(backoff.future,true);
 await assert.rejects(db`UPDATE lead_import_file SET cleanup_next_run_at=clock_timestamp() WHERE id=${id}`,/IMPORT_CLEANUP_BACKOFF_PROOF/);
});
