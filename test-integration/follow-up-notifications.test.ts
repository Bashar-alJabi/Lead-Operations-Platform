import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {processOneFollowUpNotification} from '../src/follow-up-notifications.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

async function fixture(){
 process.env.APP_ORIGIN='http://127.0.0.1:5173';
 const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Due notices') RETURNING id`)[0]!.id,
  foreign=(await db`INSERT INTO organization(name) VALUES('Foreign due notices') RETURNING id`)[0]!.id,
  branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,
  other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id,
  campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status,routing_method) VALUES(${org},${branch},'Due <img src=x onerror=alert(1)>','ACTIVE','ROUND_ROBIN') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,bid,oid] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['second','AGENT',branch,org],['other','MANAGER',other,org],['foreign','SUPER_ADMIN',null,foreign]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${oid},${bid},${role},${name},${name+'@due-notice.test'},'synthetic') RETURNING id`)[0]!.id,
   token=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
  users[name]={id,session,cookie:'lop_session='+token};
 }
 await db`INSERT INTO campaign_agent(campaign_id,agent_id) VALUES(${campaign},${users.agent!.id})`;
 const api=(method:'GET'|'POST'|'PUT'|'PATCH',path:string,body?:object,who='manager')=>app.inject({method,url:path,payload:body,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}});
 const made=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Synthetic task customer',phone:'+15552347891'}});
 assert.equal(made.statusCode,201,made.body);const lead=made.json().id as string;
 const past=new Date(Date.now()-3600000).toISOString(),future=new Date(Date.now()+3600000).toISOString();
 const task=async(dueAt=past,ownerUserId=users.agent!.id)=>{const r=await api('POST','/api/leads/'+lead+'/followups',{dueAt,ownerUserId,note:'Synthetic internal task'});assert.equal(r.statusCode,201,r.body);return r.json().id as string;};
 const feed=async(who='manager')=>{const r=await api('GET','/api/notifications?language=en&limit=50',undefined,who);assert.equal(r.statusCode,200,r.body);return r.json().items.filter((n:any)=>n.eventType==='FOLLOW_UP_DUE') as {id:string;version:number;followUp:{id:string;currentlyDue:boolean;status:string;observedDueAt:string};body:string;title:string}[];};
 const queue=async(id:string)=>(await api('GET','/api/followups/'+id+'/notification')).json();
 return {db,app,org,branch,campaign,users,api,lead,past,future,task,feed,queue,close:async()=>{await app.close();await db.end();}};
}

test('Follow-up due notifications use DB-clock current tasks, durable idempotency, scoped owner access, preferences, wording and immutable history',async t=>{
 const f=await fixture();t.after(f.close);const {db,api,task,feed,queue,users,lead,past,future,branch}=f;
 const due=await task(),upcoming=await task(future),completed=await task(),cancelled=await task(),rescheduled=await task();
 for(const [id,body] of [[completed,{status:'COMPLETED'}],[cancelled,{status:'CANCELLED'}],[rescheduled,{dueAt:future}]] as const)
  assert.equal((await api('PATCH','/api/followups/'+id,{version:1,...body})).statusCode,200);
 assert.equal((await queue(due)).queue.state,'WAITING');assert.equal((await queue(completed)).queue.state,'CANCELLED');
 const work=await Promise.all(Array.from({length:8},()=>processOneFollowUpNotification(db)));
 assert.equal(work.filter(Boolean).length,1);assert.equal(await processOneFollowUpNotification(db),false);
 const notices=await feed();assert.equal(notices.length,1);const notice=notices[0]!;assert.equal(notice.followUp.id,due);assert.equal(notice.followUp.currentlyDue,true);assert.match(notice.title,/Follow-up due/);
 assert.equal((await queue(due)).queue.state,'RECORDED');assert.equal((await queue(due)).history.length,2);
 assert.equal((await feed('agent')).length,1);for(const who of ['second','other','foreign']){
  assert.equal((await feed(who)).length,0);assert.equal((await api('GET','/api/notifications/'+notice.id+'/history',undefined,who)).statusCode,404);
  assert.equal((await api('GET','/api/followups/'+due+'/notification',undefined,who)).statusCode,404);
 }
 // Current task owner is required in addition to the current Lead owner for Agent delivery.
 const managerTask=await task(past,users.manager!.id);assert.equal(await processOneFollowUpNotification(db),true);
 assert.equal((await feed('agent')).length,1);assert.equal((await feed()).length,2);
 assert.equal((await api('GET','/api/followups/'+managerTask+'/notification',undefined,'agent')).statusCode,404);
 const pref='/api/notification-preferences/FOLLOW_UP_DUE';assert.equal((await api('PUT',pref,{version:0,enabled:false},'agent')).statusCode,200);
 assert.equal((await feed('agent')).length,0);assert.equal((await feed()).length,2);
 assert.equal((await api('PUT',pref,{version:1,enabled:true},'agent')).statusCode,200);
 const root='/api/notification-templates/FOLLOW_UP_DUE/BRANCH/'+branch+'/en',wording={version:0,title:'Due {{campaign}}',body:'Task owner {{owner}} <script>literal</script>',active:true,reason:'Approved due wording'};
 assert.equal((await api('PUT',root,wording,'agent')).statusCode,403);assert.equal((await api('PUT',root,wording,'other')).statusCode,404);
 assert.equal((await api('PUT',root,wording)).statusCode,200);assert.match((await feed())[0]!.body,/Task owner manager/);
 assert.equal((await api('GET',root+'/history')).json().items.length,1);
 assert.match((await api('GET','/api/notifications?language=fr')).json().items.find((n:any)=>n.id===notice.id).title,/échéance/);
 const reads=await Promise.all(Array.from({length:8},()=>api('PUT','/api/notifications/'+notice.id+'/state',{version:0,isRead:true},'agent')));
 assert.equal(reads.filter(r=>r.statusCode===200).length,1);assert.equal(reads.filter(r=>r.statusCode===409).length,7);
 assert.equal((await api('GET','/api/notifications/'+notice.id+'/history',undefined,'agent')).json().items.length,1);
 // Note/priority/owner versions do not create a second reminder for the same due instant.
 assert.equal((await api('PATCH','/api/followups/'+due,{version:1,note:'Changed internal note',priority:'HIGH'})).statusCode,200);
 assert.equal(await processOneFollowUpNotification(db),false);
 assert.equal((await api('PATCH','/api/followups/'+due,{version:2,dueAt:future})).statusCode,200);
 assert.equal((await feed('agent'))[0]!.followUp.currentlyDue,false);
 const secondPast=new Date(Date.now()-1800000).toISOString();assert.equal((await api('PATCH','/api/followups/'+due,{version:3,dueAt:secondPast})).statusCode,200);
 assert.equal(await processOneFollowUpNotification(db),true);assert.equal((await feed('agent')).length,2);
 // Returning to an already-observed instant retains its original event, never replays it.
 assert.equal((await api('PATCH','/api/followups/'+due,{version:4,dueAt:past})).statusCode,200);assert.equal(await processOneFollowUpNotification(db),false);
 assert.equal((await api('POST','/api/leads/'+lead+'/assignment',{version:1,agentId:users.second!.id,reason:'Move owner and tasks'})).statusCode,200);
 assert.equal((await feed('agent')).length,0);assert.equal((await feed('second')).length,2);
 assert.equal((await api('PUT','/api/notifications/'+notice.id+'/state',{version:1,isRead:false},'agent')).statusCode,404);
 assert.equal((await api('GET','/api/notifications/'+notice.id+'/history',undefined,'agent')).statusCode,404);
 assert.equal((await api('GET','/api/followups/'+due+'/notification',undefined,'agent')).statusCode,404);
 assert.equal((await api('PATCH','/api/followups/'+due,{version:6,status:'COMPLETED'},'second')).statusCode,200);
 assert.ok((await feed('second')).every(n=>!n.followUp.currentlyDue&&n.followUp.status==='COMPLETED'));
 await assert.rejects(db`INSERT INTO follow_up_due_observation(follow_up_id,due_at,created_at) VALUES(${upcoming},${past},${past})`,/CURRENT_DUE_REQUIRED/);
 await assert.rejects(db`INSERT INTO notification_event(event_type,follow_up_due_id) VALUES('FOLLOW_UP_DUE',${randomUUID()})`,/FRESH_OPERATION_REQUIRED/);
 await assert.rejects(db`UPDATE follow_up_due_observation SET due_at=clock_timestamp() WHERE follow_up_id=${due}`,/IMMUTABLE/);
 await assert.rejects(db`DELETE FROM follow_up_due_observation WHERE follow_up_id=${due}`,/IMMUTABLE/);
 await assert.rejects(db`UPDATE follow_up_notification_queue SET version=version+1,operation='SOURCE' WHERE follow_up_id=${upcoming}`,/FRESH_TASK_REQUIRED/);
 await assert.rejects(db`UPDATE follow_up_notification_history SET snapshot='{}' WHERE follow_up_id=${due}`,/IMMUTABLE/);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
 assert.equal((await api('GET','/api/followups/'+due+'/notification')).statusCode,401);
 for(const table of ['conversation','conversation_message','payment_record','enrollment','background_job'])assert.equal((await db.unsafe('SELECT count(*)::int AS n FROM '+table))[0]!.n,0);
});

test('Follow-up observation failure rolls back event/Audit atomically, persists bounded retries, and permits only authorized current-session recovery',async t=>{
 const f=await fixture();t.after(f.close);const {db,api,task,queue,feed,users}=f;const due=await task();
 await db`CREATE FUNCTION reject_due_notice_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IN_APP_NOTIFICATION_RECORDED' AND NEW.target_type='FOLLOW_UP' THEN RAISE EXCEPTION 'DUE_NOTICE_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_due_notice_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_due_notice_fixture()`;
 try{
  for(let count=1;count<=5;count++){
   if(count>1)await delay(2**(count-2)*1000+30);
   assert.equal(await processOneFollowUpNotification(db),true);
   assert.equal((await queue(due)).queue.failureCount,count);assert.equal((await feed()).length,0);
   assert.equal((await db`SELECT count(*)::int AS n FROM follow_up_due_observation`)[0]!.n,0);
  }
 }finally{await db`DROP TRIGGER reject_due_notice_fixture ON audit_log`;await db`DROP FUNCTION reject_due_notice_fixture()`;}
 const status=await queue(due);assert.equal(status.queue.state,'DEAD_LETTER');assert.equal(status.queue.nextRunAt,null);assert.equal(status.history.length,6);
 assert.equal(await processOneFollowUpNotification(db),false);const path='/api/followups/'+due+'/notification/retry';
 assert.equal((await api('POST',path,{version:status.queue.version},'agent')).statusCode,403);
 for(const who of ['other','foreign'])assert.equal((await api('POST',path,{version:status.queue.version},who)).statusCode,404);
 await assert.rejects(db`UPDATE follow_up_notification_queue SET version=version+1,operation='RETRY',actor_id=${users.agent!.id},session_id=${users.agent!.session} WHERE follow_up_id=${due}`,/RETRY_DENIED/);
 const retries=await Promise.all(Array.from({length:8},()=>api('POST',path,{version:status.queue.version})));
 assert.equal(retries.filter(r=>r.statusCode===200).length,1);assert.equal(retries.filter(r=>r.statusCode===409).length,7);
 assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='FOLLOW_UP_NOTIFICATION_RETRY'`)[0]!.n,1);
 // Exercise the actual compiled worker entrypoint against durable pending work after process startup.
 const child=spawn(process.execPath,[fileURLToPath(new URL('../src/notification-worker.js',import.meta.url))],{env:{...process.env,DATABASE_URL:url,NOTIFICATION_WORKER_POLL_MS:'250'},stdio:['ignore','pipe','pipe']});
 const done=new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});let output='';child.stdout.on('data',b=>{output+=b.toString();});child.stderr.on('data',b=>{output+=b.toString();});
 try{for(let n=0;n<80 && (await queue(due)).queue.state!=='RECORDED';n++)await delay(100);assert.equal((await queue(due)).queue.state,'RECORDED',output);}
 finally{child.kill();await done;}
 assert.equal((await feed()).length,1);assert.equal(await processOneFollowUpNotification(db),false);
 assert.equal((await api('POST',path,{version:(await queue(due)).queue.version})).statusCode,409);
});

test('A task rescheduled while its worker waits for the parent lock is rechecked without emitting a stale due event',async t=>{
 const f=await fixture();t.after(f.close);const {db,api,task,branch,future,feed,queue}=f;const due=await task();
 let release!:()=>void,locked!:()=>void;const held=new Promise<void>(r=>{locked=r;}),gate=new Promise<void>(r=>{release=r;});
 // SHARE conflicts with this lock, while FK KEY SHARE checks for the actual task writer can proceed.
 const writer=db.begin(async tx=>{await tx`SELECT id FROM branch WHERE id=${branch} FOR NO KEY UPDATE`;locked();await gate;});await held;
 const worker=processOneFollowUpNotification(db);try{
  await delay(75);assert.equal((await api('PATCH','/api/followups/'+due,{version:1,dueAt:future})).statusCode,200);
 }finally{release();await writer;}
 assert.equal(await worker,false);assert.equal((await feed()).length,0);assert.equal((await queue(due)).queue.state,'WAITING');
});

test('Editing a task without a new due time preserves PostgreSQL microseconds and cannot produce a second due notification',async t=>{
 const f=await fixture();t.after(f.close);const due=await f.task(f.past.replace(/\.\d{3}Z$/,'.123456Z'));
 const before=(await f.db`SELECT due_at::text AS due FROM follow_up WHERE id=${due}`)[0]!.due;
 assert.equal(await processOneFollowUpNotification(f.db),true);
 assert.equal((await f.api('PATCH','/api/followups/'+due,{version:1,note:'Only change internal note',priority:'HIGH'})).statusCode,200);
 assert.equal((await f.db`SELECT due_at::text AS due FROM follow_up WHERE id=${due}`)[0]!.due,before);
 assert.equal((await f.queue(due)).queue.state,'RECORDED');assert.equal(await processOneFollowUpNotification(f.db),false);assert.equal((await f.feed()).length,1);
});
