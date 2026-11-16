import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {processOneFollowUpNotification} from '../src/follow-up-notifications.js';
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

 const preview=async(ids=leads.slice(0,2),who='manager',ownerUserId?:string)=>{const r=await api('POST','/api/leads/bulk/followups/preview',{ids,ownerUserId},who);assert.equal(r.statusCode,200,r.body);return r.json().items as {id:string;leadVersion:number;ownerUserId:string;status:string;error?:string}[];};
 const body=async(ids=leads.slice(0,2),who='manager',ownerUserId?:string)=>({requestId:randomUUID(),confirmed:true,dueAt:'2099-11-16T09:30:00.123456Z',note:'  Call <img src=x onerror=alert(1)>  ',priority:'HIGH',ownerUserId,items:(await preview(ids,who,ownerUserId)).filter(i=>i.status==='ELIGIBLE').map(({status,error,...i})=>i)});
 return {db,app,org,branch,other,users,campaigns,leads,api,preview,body,cleanup};
}

test('Bulk Follow-ups create once under eight concurrent requests and never revive completed or cancelled tasks',async t=>{
 const {db,api,body}=await fixture(t),input=await body();
 const rs=await Promise.all(Array.from({length:8},()=>api('POST','/api/leads/bulk/followups',input)));assert.ok(rs.every(r=>r.statusCode===200),rs.map(r=>r.body).join('\n'));
 assert.equal(rs.flatMap(r=>r.json().results).filter((r:any)=>r.status==='CREATED').length,2);
 assert.equal((await db`SELECT count(*)::int n FROM bulk_follow_up_receipt`)[0]!.n,2);assert.equal((await db`SELECT count(*)::int n FROM follow_up_notification_queue`)[0]!.n,2);
 const tasks=await db`SELECT *,due_at::text AS exact_due FROM follow_up ORDER BY lead_id`;assert.equal(tasks.length,2);for(const f of tasks){assert.equal(f.kind,'HUMAN');assert.equal(f.priority,'HIGH');assert.equal(f.note,'Call <img src=x onerror=alert(1)>');assert.ok(f.exact_due.includes('.123456'));}
 assert.equal((await api('PATCH','/api/followups/'+tasks[0]!.id,{version:1,status:'COMPLETED'})).statusCode,200);
 assert.equal((await api('PATCH','/api/followups/'+tasks[1]!.id,{version:1,status:'CANCELLED'})).statusCode,200);
 const retry=await api('POST','/api/leads/bulk/followups',input);assert.equal(retry.statusCode,200,retry.body);assert.ok(retry.json().results.every((r:any)=>r.status==='REPLAYED'));
 assert.deepEqual(new Set(retry.json().results.map((r:any)=>r.followUpId)),new Set(tasks.map(f=>f.id)));assert.equal((await db`SELECT count(*)::int n FROM follow_up`)[0]!.n,2);
 const history=await api('GET','/api/followups/'+tasks[0]!.id+'/history');assert.equal(history.statusCode,200);assert.ok(history.json().items.some((r:any)=>r.event_type==='CREATED'&&r.detail.priority==='HIGH'&&r.detail.note===tasks[0]!.note));
 assert.equal((await api('POST','/api/leads/bulk/followups',{...input,dueAt:'2099-01-01T00:00:00Z'})).statusCode,409);
 assert.equal((await db`SELECT count(*)::int n FROM conversation_message`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM payment_record`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int n FROM enrollment`)[0]!.n,0);
});

test('Bulk Follow-ups enforce current Agent, Branch, Organization and task-owner authority before historical replay with bounded validated snapshots',async t=>{
 const {db,leads,users,api,preview,body}=await fixture(t),input=await body();
 assert.deepEqual((await preview(leads,'agent')).map(i=>i.status),['ELIGIBLE','FAILED','FAILED']);
 const hidden=[leads[2]!,randomUUID()];assert.deepEqual(await preview(hidden),hidden.map(id=>({id,status:'FAILED',error:'LEAD_OR_OWNER_NOT_AVAILABLE'})));
 assert.ok((await preview(leads,'foreign')).every(i=>i.status==='FAILED'));assert.ok((await preview(leads,'other')).slice(0,2).every(i=>i.status==='FAILED'));
 assert.equal((await api('POST','/api/leads/bulk/followups',{...input,confirmed:false})).statusCode,400);
 assert.equal((await api('POST','/api/leads/bulk/followups',{...input,items:[input.items[0],input.items[0]]})).statusCode,400);
 assert.equal((await api('POST','/api/leads/bulk/followups',{...input,dueAt:'tomorrow'})).statusCode,400);
 assert.equal((await api('POST','/api/leads/bulk/followups/preview',{ids:Array.from({length:51},()=>randomUUID())})).statusCode,400);
 const agentInput=await body([leads[0]!],'agent'),created=await api('POST','/api/leads/bulk/followups',agentInput,'agent');assert.equal(created.statusCode,200,created.body);assert.equal(created.json().results[0].status,'CREATED');
 const delegated=await api('POST','/api/leads/bulk/followups',{...agentInput,requestId:randomUUID(),ownerUserId:users.second!.id,items:agentInput.items.map(i=>({...i,ownerUserId:users.second!.id}))},'agent');assert.equal(delegated.json().results[0].error,'FOLLOW_UP_OWNER_DENIED');
 const ownerChanged=await api('POST','/api/leads/bulk/followups',{...input,requestId:randomUUID(),items:[{...input.items[0],ownerUserId:users.manager!.id}]});assert.equal(ownerChanged.statusCode,200,ownerChanged.body);assert.equal(ownerChanged.json().results[0].error,'FOLLOW_UP_OWNER_CHANGED');
 const changedLead=await api('POST','/api/leads/'+leads[0]+'/assignment',{version:1,agentId:null});assert.equal(changedLead.statusCode,200,changedLead.body);
 const replay=await api('POST','/api/leads/bulk/followups',agentInput,'agent');assert.equal(replay.json().results[0].error,'LEAD_NOT_FOUND');
 const stale=await api('POST','/api/leads/bulk/followups',input);assert.equal(stale.statusCode,200,stale.body);assert.equal(stale.json().results[0].error,'LEAD_VERSION_CONFLICT');assert.equal(stale.json().results[1].status,'CREATED');
 await db`UPDATE user_account SET active=false WHERE id=${users.second!.id}`;const inactive=await api('POST','/api/leads/bulk/followups',input);assert.equal(inactive.json().results[1].error,'FOLLOW_UP_OWNER_NOT_ELIGIBLE');
 assert.ok((await api('POST','/api/leads/bulk/followups',input,'foreign')).json().results.every((r:any)=>r.error==='LEAD_NOT_FOUND'));
 assert.ok((await preview([leads[2]!],'admin')).every(i=>i.status==='FAILED'),'Admin has no implicit eligible branch owner');
 assert.equal((await preview([leads[2]!],'admin',users.other!.id))[0]!.status,'ELIGIBLE');
 await db`UPDATE user_session SET revoked_at=now() WHERE id=${users.manager!.session}`;assert.equal((await api('POST','/api/leads/bulk/followups',input)).statusCode,401);
});

test('Bulk Follow-up item Audit failure rolls back task and due queue, resumes independent receipts, and native history cannot be forged or rewritten',async t=>{
 const {db,api,leads,body,cleanup}=await fixture(t),input=await body();
 await db.unsafe(`CREATE FUNCTION test_bulk_followup_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='BULK_FOLLOW_UP_CREATED' AND NEW.detail->>'leadId'='${leads[1]}' THEN RAISE EXCEPTION 'synthetic private error';END IF;RETURN NEW;END $$`);
 await db`CREATE TRIGGER test_bulk_followup_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_bulk_followup_failure()`;
 cleanup.push(async()=>{await db`DROP TRIGGER IF EXISTS test_bulk_followup_failure ON audit_log`;await db`DROP FUNCTION IF EXISTS test_bulk_followup_failure()`;});
 const failed=await api('POST','/api/leads/bulk/followups',input);assert.equal(failed.statusCode,500,failed.body);assert.ok(!failed.body.includes('synthetic private'));
 assert.equal((await db`SELECT count(*)::int n FROM follow_up`)[0]!.n,1);assert.equal((await db`SELECT count(*)::int n FROM follow_up_notification_queue`)[0]!.n,1);assert.equal((await db`SELECT count(*)::int n FROM follow_up_history`)[0]!.n,1);
 await db`DROP TRIGGER test_bulk_followup_failure ON audit_log`;const resumed=await api('POST','/api/leads/bulk/followups',input);assert.equal(resumed.statusCode,200,resumed.body);assert.deepEqual(resumed.json().results.map((r:any)=>r.status),['REPLAYED','CREATED']);
 await assert.rejects(db`UPDATE bulk_follow_up_batch SET item_count=1`,/BULK_BATCH_IMMUTABLE/);await assert.rejects(db`DELETE FROM bulk_follow_up_receipt`,/BULK_RECEIPT_IMMUTABLE/);
 await assert.rejects(db`UPDATE follow_up_history SET detail='{}'::jsonb`,/BULK_HISTORY_IMMUTABLE/);
 await assert.rejects(db`INSERT INTO bulk_follow_up_receipt SELECT batch_id,lead_id,branch_id,campaign_id,session_id,lead_version,owner_user_id,follow_up_id,history_id,clock_timestamp() FROM bulk_follow_up_receipt LIMIT 1`,/BULK_RECEIPT_PROOF/);
 const f=(await db`SELECT id FROM follow_up LIMIT 1`)[0]!;assert.equal((await api('PATCH','/api/followups/'+f.id,{version:1,note:'Edited task',priority:'LOW'})).statusCode,200);assert.equal((await db`SELECT version FROM follow_up WHERE id=${f.id}`)[0]!.version,2);
 const original=await api('POST','/api/leads/bulk/followups',input);assert.ok(original.json().results.every((r:any)=>r.status==='REPLAYED'));assert.equal((await db`SELECT count(*)::int n FROM follow_up`)[0]!.n,2);
});

test('Bulk Follow-up rechecks real session after Lead lock wait and pauses bounded work for safe recovery',async t=>{
 const {db,users,leads,api,body,cleanup}=await fixture(t),input=await body();
 let unlock!:()=>void,locked!:()=>void;const ready=new Promise<void>(r=>{locked=r;}),release=new Promise<void>(r=>{unlock=r;});
 const held=db.begin(async tx=>{await tx`SELECT id FROM lead WHERE id=${leads[0]!} FOR UPDATE`;locked();await release;});await ready;
 let pending:ReturnType<typeof api>|undefined;
 try{pending=api('POST','/api/leads/bulk/followups',input);let exists=false;for(let i=0;i<30&&!exists;i++){exists=!!(await db`SELECT 1 FROM bulk_follow_up_batch WHERE request_key=${input.requestId}`).length;if(!exists)await new Promise(r=>setTimeout(r,10));}assert.ok(exists);await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;}finally{unlock();await held;}
 const revoked=await pending!;assert.equal(revoked.statusCode,200,revoked.body);assert.ok(revoked.json().results.every((r:any)=>r.error==='BULK_ACCESS_REVOKED'));assert.equal((await db`SELECT count(*)::int n FROM follow_up`)[0]!.n,0);
 await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.manager!.session}`;
 const prior=process.env.BULK_FOLLOW_UP_REQUEST_BUDGET_MS;cleanup.push(async()=>{if(prior===undefined)delete process.env.BULK_FOLLOW_UP_REQUEST_BUDGET_MS;else process.env.BULK_FOLLOW_UP_REQUEST_BUDGET_MS=prior;await db`DROP TRIGGER IF EXISTS test_bulk_followup_budget ON audit_log`;await db`DROP FUNCTION IF EXISTS test_bulk_followup_budget()`;});
 await db`CREATE FUNCTION test_bulk_followup_budget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='BULK_FOLLOW_UP_CREATED' THEN PERFORM pg_sleep(0.15);END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER test_bulk_followup_budget BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_bulk_followup_budget()`;
 process.env.BULK_FOLLOW_UP_REQUEST_BUDGET_MS='100';const paused=await api('POST','/api/leads/bulk/followups',input);assert.equal(paused.statusCode,200,paused.body);assert.deepEqual(paused.json().results.map((r:any)=>r.status),['CREATED','FAILED']);assert.equal(paused.json().results[1].error,'BULK_REQUEST_PAUSED');
 await db`DROP TRIGGER test_bulk_followup_budget ON audit_log`;if(prior===undefined)delete process.env.BULK_FOLLOW_UP_REQUEST_BUDGET_MS;else process.env.BULK_FOLLOW_UP_REQUEST_BUDGET_MS=prior;
 const resumed=await api('POST','/api/leads/bulk/followups',input);assert.deepEqual(resumed.json().results.map((r:any)=>r.status),['REPLAYED','CREATED']);assert.equal((await db`SELECT count(*)::int n FROM follow_up`)[0]!.n,2);
});

test('Fifty actual bulk tasks use the ordinary due worker and current notification ACL with no repeated reminders on request replay',async t=>{
 const {db,org,branch,campaigns,users,api,body}=await fixture(t),ids:string[]=[];
 for(let i=0;i<50;i++)ids.push((await db`INSERT INTO lead(organization_id,branch_id,campaign_id,assigned_agent_id,source_kind)
  VALUES(${org},${branch},${campaigns[0]!},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id);
 const input={...await body(ids),dueAt:'2001-11-16T09:30:00.123456Z'},r=await api('POST','/api/leads/bulk/followups',input);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().results.filter((i:any)=>i.status==='CREATED').length,50);
 for(let i=0;i<50;i++)assert.equal(await processOneFollowUpNotification(db),true);assert.equal(await processOneFollowUpNotification(db),false);
 const feed=await api('GET','/api/notifications?language=en&limit=50',undefined,'agent');assert.equal(feed.statusCode,200,feed.body);assert.equal(feed.json().items.filter((n:any)=>n.eventType==='FOLLOW_UP_DUE').length,50);
 assert.equal((await api('GET','/api/notifications?language=en&limit=50',undefined,'second')).json().items.filter((n:any)=>n.eventType==='FOLLOW_UP_DUE').length,0);
 assert.ok((await api('POST','/api/leads/bulk/followups',input)).json().results.every((i:any)=>i.status==='REPLAYED'));assert.equal(await processOneFollowUpNotification(db),false);
 assert.equal((await db`SELECT count(*)::int n FROM follow_up_due_observation`)[0]!.n,50);assert.equal((await db`SELECT count(*)::int n FROM follow_up`)[0]!.n,50);
});
