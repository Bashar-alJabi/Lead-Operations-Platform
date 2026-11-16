import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
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
 for(const type of ['TAGS','STATUS','NUMBER','SOURCE']){
  const r=await api('POST','/api/fields',{scope:'BRANCH',branchId:branch,key:'bulk_'+type.toLowerCase(),label:'Bulk '+type,fieldType:type==='SOURCE'?'TEXT':type,valueMode:type==='SOURCE'?'SOURCE':'MANUAL',options:type==='STATUS'?[{value:'new',label:'New',active:true},{value:'won',label:'Won',active:true}]:[],validation:{}});assert.equal(r.statusCode,201,r.body);fields[type]=r.json().id;
  const bind=await api('PUT','/api/campaigns/'+campaigns[0]+'/fields/'+fields[type],{active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:type!=='SOURCE',visibleToManager:true,editableByManager:type!=='SOURCE',showInTable:true,showInDetails:true,filterable:true,usableByAutomation:false,usableByAi:false});assert.equal(bind.statusCode,200,bind.body);
 }
 const preview=async(fieldId=fields.TAGS!,ids=leads.slice(0,2),who='manager')=>{const r=await api('POST','/api/leads/bulk/fields/preview',{fieldId,definitionVersion:1,ids},who);assert.equal(r.statusCode,200,r.body);return r.json().items as {id:string;leadVersion:number;definitionVersion:number;bindingVersion:number;valueVersion?:number;status:string;error?:string}[];};
 const body=async(fieldId=fields.TAGS!,operation='ADD_TAGS',value:unknown=['sales'],ids=leads.slice(0,2))=>({requestId:randomUUID(),confirmed:true,fieldId,operation,value,items:(await preview(fieldId,ids)).filter(i=>i.status==='ELIGIBLE').map(({status,error,...i})=>i)});
 return {db,app,org,branch,other,users,campaigns,leads,fields,api,preview,body,cleanup};
}
test('Bulk Human Fields apply real typed tag/status changes once across concurrent retries with current previews, ordinary history and native receipts',async t=>{
 const {db,leads,fields,api,preview,body}=await fixture(t),input=await body();
 const responses=await Promise.all(Array.from({length:8},()=>api('POST','/api/leads/bulk/fields',input)));assert.ok(responses.every(r=>r.statusCode===200),responses.map(r=>r.body).join('\n'));
 assert.equal(responses.flatMap(r=>r.json().results).filter((r:any)=>r.status==='UPDATED').length,2);
 assert.equal((await db`SELECT count(*)::int AS n FROM bulk_field_batch`)[0]!.n,1);assert.equal((await db`SELECT count(*)::int AS n FROM bulk_field_receipt`)[0]!.n,2);
 assert.equal((await db`SELECT count(*)::int AS n FROM field_value_history`)[0]!.n,2);assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='BULK_FIELD_REQUESTED'`)[0]!.n,1);
 for(const [operation,value,expected] of [['ADD_TAGS',['sales','support'],['sales','support']],['REMOVE_TAGS',['sales'],['support']]] as const){const r=await api('POST','/api/leads/bulk/fields',await body(fields.TAGS!,operation,value));assert.equal(r.statusCode,200,r.body);assert.ok(r.json().results.every((i:any)=>i.status==='UPDATED'));assert.deepEqual((await db`SELECT value FROM lead_field_value WHERE lead_id=${leads[0]!} AND field_id=${fields.TAGS!}`)[0]!.value,expected);}
 const status=await api('POST','/api/leads/bulk/fields',await body(fields.STATUS!,'SET','won'));assert.equal(status.statusCode,200,status.body);assert.equal((await db`SELECT value FROM lead_field_value WHERE lead_id=${leads[0]!} AND field_id=${fields.STATUS!}`)[0]!.value,'won');
 const zero=await api('POST','/api/leads/bulk/fields',await body(fields.NUMBER!,'SET',0));assert.equal(zero.statusCode,200,zero.body);assert.equal((await db`SELECT value FROM lead_field_value WHERE lead_id=${leads[0]!} AND field_id=${fields.NUMBER!}`)[0]!.value,0);
 assert.equal((await api('POST','/api/leads/bulk/fields',{...input,value:['changed']})).statusCode,409);
 assert.ok((await api('POST','/api/leads/bulk/fields',await body(fields.NUMBER!,'ADD_TAGS',['x']))).json().results.every((i:any)=>i.error==='BULK_TAG_FIELD_REQUIRED'));
 assert.equal((await db`SELECT count(*)::int AS n FROM conversation_message`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int AS n FROM payment_record`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int AS n FROM enrollment`)[0]!.n,0);
 assert.equal((await preview(fields.TAGS!,[leads[2]!,randomUUID()]))[0]!.error,'LEAD_OR_FIELD_NOT_AVAILABLE');
});
test('Bulk Fields reject hidden/out-of-scope/stale snapshots and current ownership loss before receipt replay without widening Agent authority',async t=>{
 const {db,leads,fields,users,campaigns,api,body,preview}=await fixture(t),input=await body();
 assert.equal((await api('POST','/api/leads/bulk/fields',{...input,confirmed:false})).statusCode,400);
 assert.equal((await api('POST','/api/leads/bulk/fields',{...input,items:[input.items[0],input.items[0]]})).statusCode,400);
 assert.equal((await api('POST','/api/leads/bulk/fields/preview',{fieldId:fields.TAGS,definitionVersion:1,ids:Array.from({length:51},()=>randomUUID())})).statusCode,400);
 const hidden=(await preview(fields.TAGS!,leads,'agent')).map(i=>i.status);assert.deepEqual(hidden,['ELIGIBLE','FAILED','FAILED']);
 const agent=await api('POST','/api/leads/bulk/fields',input,'agent');assert.equal(agent.statusCode,200,agent.body);assert.deepEqual(agent.json().results.map((r:any)=>r.status),['UPDATED','FAILED']);
 const stale=await body();await api('PUT','/api/leads/'+leads[0]+'/fields/'+fields.TAGS,{version:1,value:['individual']});
 const rejected=await api('POST','/api/leads/bulk/fields',stale);assert.equal(rejected.json().results[0].error,'FIELD_VALUE_VERSION_CONFLICT');
 const move=await api('POST','/api/leads/'+leads[0]+'/assignment',{version:1,agentId:null,reason:'Revoke bulk access'});assert.equal(move.statusCode,200,move.body);
 const replay=await api('POST','/api/leads/bulk/fields',input,'agent');assert.equal(replay.json().results[0].error,'LEAD_NOT_FOUND');assert.ok(replay.json().results.every((r:any)=>r.status==='FAILED'));
 const current=await body(fields.NUMBER!,'SET',10),races=await Promise.all([api('POST','/api/leads/bulk/fields',current),api('POST','/api/leads/bulk/fields',{...current,requestId:randomUUID()})]);assert.equal(races.flatMap(r=>r.json().results).filter((r:any)=>r.status==='UPDATED').length,2);
 const oldConfig=await body(fields.NUMBER!,'SET',20);const config=await api('PATCH','/api/fields/'+fields.NUMBER,{version:1,label:'Updated number',options:[],validation:{max:100},active:true});assert.equal(config.statusCode,200,config.body);
 assert.ok((await api('POST','/api/leads/bulk/fields',oldConfig)).json().results.every((r:any)=>r.error==='BULK_FIELD_CONFIGURATION_CHANGED'));
 assert.ok((await api('POST','/api/leads/bulk/fields',{...input,requestId:randomUUID(),fieldId:fields.SOURCE,operation:'SET',value:'claim'})).json().results.every((r:any)=>r.error==='FIELD_READ_ONLY'));
 await db`UPDATE campaign_field SET visible_to_manager=false,editable_by_manager=false,version=version+1 WHERE campaign_id=${campaigns[0]!} AND field_id=${fields.TAGS!}`;
 const unavailable=await preview(fields.TAGS!,[leads[0]!]);const unknown=await preview(randomUUID(),[leads[0]!]);assert.deepEqual(unavailable,unknown);
 assert.ok((await api('POST','/api/leads/bulk/fields',input)).json().results.every((r:any)=>r.error==='FIELD_NOT_FOUND'));
 assert.ok((await api('POST','/api/leads/bulk/fields',input,'other')).json().results.every((r:any)=>r.error==='LEAD_NOT_FOUND'));
 assert.ok((await api('POST','/api/leads/bulk/fields',input,'foreign')).json().results.every((r:any)=>r.error==='LEAD_NOT_FOUND'));
 await db`UPDATE user_session SET revoked_at=now() WHERE id=${users.agent!.session}`;assert.equal((await api('POST','/api/leads/bulk/fields',input,'agent')).statusCode,401);
});
test('Bulk partial Audit failure rolls back the affected item and resumes committed work without replay; native proof and history are immutable',async t=>{
 const {db,leads,fields,api,body,cleanup}=await fixture(t),input=await body();
 await db.unsafe(`CREATE FUNCTION test_bulk_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='BULK_FIELD_UPDATED' AND NEW.target_id='${leads[1]}' THEN RAISE EXCEPTION 'synthetic private error';END IF;RETURN NEW;END $$`);
 await db`CREATE TRIGGER test_bulk_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_bulk_audit_failure()`;
 cleanup.push(async()=>{await db`DROP TRIGGER IF EXISTS test_bulk_audit_failure ON audit_log`;await db`DROP FUNCTION IF EXISTS test_bulk_audit_failure()`;});
 const failed=await api('POST','/api/leads/bulk/fields',input);assert.equal(failed.statusCode,500,failed.body);assert.ok(!failed.body.includes('synthetic private'));
 assert.equal((await db`SELECT count(*)::int AS n FROM bulk_field_receipt`)[0]!.n,1);assert.equal((await db`SELECT count(*)::int AS n FROM lead_field_value`)[0]!.n,1);
 await db`DROP TRIGGER test_bulk_audit_failure ON audit_log`;const resumed=await api('POST','/api/leads/bulk/fields',input);assert.equal(resumed.statusCode,200,resumed.body);assert.deepEqual(resumed.json().results.map((r:any)=>r.status),['REPLAYED','UPDATED']);
 assert.equal((await db`SELECT count(*)::int AS n FROM field_value_history`)[0]!.n,2);
 await assert.rejects(db`UPDATE bulk_field_batch SET item_count=1`,/BULK_BATCH_IMMUTABLE/);await assert.rejects(db`DELETE FROM bulk_field_receipt`,/BULK_RECEIPT_IMMUTABLE/);
 await assert.rejects(db`UPDATE field_value_history SET new_value='[]'::jsonb`,/BULK_HISTORY_IMMUTABLE/);
 await assert.rejects(db`INSERT INTO bulk_field_receipt SELECT batch_id,lead_id,branch_id,campaign_id,field_id,session_id,lead_version,definition_version,binding_version,result_version,history_id,clock_timestamp() FROM bulk_field_receipt LIMIT 1`,/BULK_RECEIPT_PROOF/);
 assert.deepEqual((await db`SELECT value FROM lead_field_value WHERE lead_id=${leads[0]!} AND field_id=${fields.TAGS!}`)[0]!.value,['sales']);
});
test('Bulk current session is rechecked after a real Lead lock wait before any action or receipt can be applied',async t=>{
 const {db,leads,users,api,body}=await fixture(t),input=await body();
 let unlock!:()=>void,locked!:()=>void;const ready=new Promise<void>(r=>{locked=r;}),release=new Promise<void>(r=>{unlock=r;});
 const held=db.begin(async tx=>{await tx`SELECT id FROM lead WHERE id=${leads[0]!} FOR UPDATE`;locked();await release;});await ready;
 let pending:ReturnType<typeof api>|undefined;
 try{pending=api('POST','/api/leads/bulk/fields',input);let exists=false;for(let i=0;i<30&&!exists;i++){exists=!!(await db`SELECT 1 FROM bulk_field_batch WHERE request_key=${input.requestId}`).length;if(!exists)await new Promise(r=>setTimeout(r,10));}assert.ok(exists,'Envelope must commit before the blocked action');
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
 }finally{unlock();await held;}
 const result=await pending!;assert.equal(result.statusCode,200,result.body);assert.ok(result.json().results.every((r:any)=>r.error==='BULK_ACCESS_REVOKED'));
 assert.equal((await db`SELECT count(*)::int AS n FROM lead_field_value`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int AS n FROM bulk_field_receipt`)[0]!.n,0);
});
test('Bulk request budget pauses remaining work with safe same-key resume and accepts the bounded 50-item real write path',async t=>{
 const {db,org,branch,campaigns,users,api,body,cleanup}=await fixture(t),input=await body(),prior=process.env.BULK_FIELD_REQUEST_BUDGET_MS;
 cleanup.push(async()=>{if(prior===undefined)delete process.env.BULK_FIELD_REQUEST_BUDGET_MS;else process.env.BULK_FIELD_REQUEST_BUDGET_MS=prior;await db`DROP TRIGGER IF EXISTS test_bulk_budget ON audit_log`;await db`DROP FUNCTION IF EXISTS test_bulk_budget()`;});
 await db`CREATE FUNCTION test_bulk_budget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='BULK_FIELD_UPDATED' THEN PERFORM pg_sleep(0.15);END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER test_bulk_budget BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_bulk_budget()`;
 process.env.BULK_FIELD_REQUEST_BUDGET_MS='100';const paused=await api('POST','/api/leads/bulk/fields',input);assert.equal(paused.statusCode,200,paused.body);
 assert.deepEqual(paused.json().results.map((r:any)=>r.status),['UPDATED','FAILED']);assert.equal(paused.json().results[1].error,'BULK_REQUEST_PAUSED');
 await db`DROP TRIGGER test_bulk_budget ON audit_log`;if(prior===undefined)delete process.env.BULK_FIELD_REQUEST_BUDGET_MS;else process.env.BULK_FIELD_REQUEST_BUDGET_MS=prior;
 const resumed=await api('POST','/api/leads/bulk/fields',input);assert.deepEqual(resumed.json().results.map((r:any)=>r.status),['REPLAYED','UPDATED']);assert.equal((await db`SELECT count(*)::int AS n FROM field_value_history`)[0]!.n,2);
 const rows=await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind)
  SELECT ${org}::uuid,${branch}::uuid,${campaigns[0]!}::uuid,${users.agent!.id}::uuid,'MANUAL' FROM generate_series(1,50) RETURNING id`;
 const fifty=await body(undefined,'ADD_TAGS',['bounded'],rows.map(r=>r.id as string));assert.equal(fifty.items.length,50);const written=await api('POST','/api/leads/bulk/fields',fifty);assert.equal(written.statusCode,200,written.body);assert.equal(written.json().results.filter((r:any)=>r.status==='UPDATED').length,50);assert.ok(written.body.length<30000);
});
