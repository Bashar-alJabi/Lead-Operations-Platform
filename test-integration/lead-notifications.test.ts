import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Lead and assignment notifications use fresh trusted sources, current access, independent preferences, immutable history and atomic Audit',async t=>{
 process.env.APP_ORIGIN='http://127.0.0.1:5173';
 const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});t.after(async()=>{await app.close();await db.end();});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Lead notifications') RETURNING id`)[0]!.id,
  foreign=(await db`INSERT INTO organization(name) VALUES('Foreign notices') RETURNING id`)[0]!.id,
  branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,
  other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id,
  campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status,routing_method) VALUES(${org},${branch},'Campaign <img src=x onerror=alert(1)>','ACTIVE','ROUND_ROBIN') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,bid,oid] of [['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['second','AGENT',branch,org],['other','MANAGER',other,org],['foreign','SUPER_ADMIN',null,foreign]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${oid},${bid},${role},${name},${name+'@lead-notice.test'},'synthetic') RETURNING id`)[0]!.id,token=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
  users[name]={id,session,cookie:'lop_session='+token};
 }
 await db`INSERT INTO campaign_agent(campaign_id,agent_id) VALUES(${campaign},${users.agent!.id})`;
 const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,who='manager')=>app.inject({method,url:path,payload:body,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}});
 let counter=0;const create=()=>api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Synthetic notice',phone:'+1555444'+String(++counter).padStart(4,'0')}});
 const made=await create();assert.equal(made.statusCode,201,made.body);const lead=made.json().id;
 const feed=async(who='manager')=>(await api('GET','/api/notifications?language=en&limit=50',undefined,who)).json().items as {id:string;eventType:string;leadId:string;title:string;body:string;conversationId:null;version:number;isRead:boolean}[];
 const notices=await feed();assert.deepEqual(notices.map(n=>n.eventType).sort(),['LEAD_ASSIGNED','LEAD_CREATED']);assert.ok(notices.every(n=>n.conversationId===null));
 assert.equal((await feed('agent')).length,2);for(const who of ['second','other','foreign'])assert.equal((await feed(who)).length,0);
 assert.equal((await api('GET','/api/notifications/indicator',undefined,'agent')).json().hasUnread,true);
 const receipt=(await db`SELECT id FROM lead_intake_receipt WHERE lead_id=${lead}`)[0]!.id,event=notices.find(n=>n.eventType==='LEAD_CREATED')!;
 for(const who of ['second','other','foreign']){
  assert.equal((await api('GET','/api/notifications/'+event.id+'/history',undefined,who)).statusCode,404);
  assert.equal((await api('PUT','/api/notifications/'+event.id+'/state',{version:0,isRead:true},who)).statusCode,404);
 }
 const states=await Promise.all(Array.from({length:8},()=>api('PUT','/api/notifications/'+event.id+'/state',{version:0,isRead:true},'agent')));
 assert.equal(states.filter(r=>r.statusCode===200).length,1);assert.equal(states.filter(r=>r.statusCode===409).length,7);
 assert.equal((await api('GET','/api/notifications/'+event.id+'/history',undefined,'agent')).json().items[0].is_read,true);
 const pref='/api/notification-preferences/LEAD_CREATED';assert.equal((await api('PUT',pref,{version:0,enabled:false},'agent')).statusCode,200);
 assert.deepEqual((await feed('agent')).map(n=>n.eventType),['LEAD_ASSIGNED']);assert.equal((await feed()).length,2);
 const root='/api/notification-templates/LEAD_CREATED/BRANCH/'+branch+'/en',wording={version:0,title:'New {{campaign}}',body:'Current owner {{owner}} <script>literal</script>',active:true,reason:'Approved operational wording'};
 assert.equal((await api('PUT',root,wording,'agent')).statusCode,403);assert.equal((await api('PUT',root,wording,'other')).statusCode,404);
 assert.equal((await api('PUT',root,wording)).statusCode,200);assert.match((await feed()).find(n=>n.id===event.id)!.title,/<img/);
 assert.match((await feed()).find(n=>n.id===event.id)!.body,/<script>/);assert.equal((await api('GET',root+'/history')).json().items.length,1);
 assert.match((await api('GET','/api/notifications?language=fr')).json().items.find((n:any)=>n.id===event.id).title,/Nouveau prospect/);
 const assignment='/api/leads/'+lead+'/assignment';
 assert.equal((await api('POST',assignment,{version:1,agentId:users.second!.id},'agent')).statusCode,403);
 const races=await Promise.all(Array.from({length:8},()=>api('POST',assignment,{version:1,agentId:users.second!.id,reason:'Explicit reassignment'})));
 assert.equal(races.filter(r=>r.statusCode===200).length,1);assert.equal(races.filter(r=>r.statusCode===409).length,7);
 assert.equal((await feed('agent')).length,0);assert.equal((await api('PUT','/api/notifications/'+event.id+'/state',{version:1,isRead:false},'agent')).statusCode,404);
 assert.deepEqual((await feed('second')).map(n=>n.eventType).sort(),['LEAD_ASSIGNED','LEAD_CREATED','LEAD_REASSIGNED']);
 assert.equal((await feed('second')).find(n=>n.id===event.id)!.version,0);assert.equal((await api('POST',assignment,{version:2,agentId:users.second!.id})).statusCode,200);
 assert.equal((await feed()).length,3); // A no-op assignment emits nothing.
 assert.equal((await api('POST',assignment,{version:2,agentId:null,reason:'Manager unassigns'})).statusCode,200);assert.equal((await feed('second')).length,0);assert.equal((await feed()).length,4);
 await assert.rejects(db`INSERT INTO notification_event(event_type,intake_receipt_id) VALUES('LEAD_CREATED',${receipt})`,/FRESH_OPERATION_REQUIRED/);
 await assert.rejects(db`INSERT INTO notification_event(event_type,source_id,lead_id) VALUES('LEAD_REASSIGNED',${randomUUID()},${lead})`,/FRESH_OPERATION_REQUIRED/);
 await assert.rejects(db`UPDATE notification_event SET lead_id=${lead} WHERE id=${event.id}`,/IMMUTABLE/);
 await assert.rejects(db`DELETE FROM notification_event WHERE id=${event.id}`,/IMMUTABLE/);
 // Failure of the notification Audit rolls back the source Lead/receipt/assignment together.
 await db`CREATE FUNCTION reject_lead_notice_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IN_APP_NOTIFICATION_RECORDED' AND NEW.target_type='LEAD' THEN RAISE EXCEPTION 'NOTICE_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_lead_notice_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_lead_notice_fixture()`;
 const before=(await db`SELECT count(*)::int AS n FROM lead`)[0]!.n;
 try{assert.equal((await create()).statusCode,500);assert.equal((await api('POST',assignment,{version:3,agentId:users.agent!.id})).statusCode,500);}
 finally{await db`DROP TRIGGER reject_lead_notice_fixture ON audit_log`;await db`DROP FUNCTION reject_lead_notice_fixture()`;}
 assert.equal((await db`SELECT count(*)::int AS n FROM lead`)[0]!.n,before);assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${lead}`)[0]!.assigned_agent_id,null);assert.equal((await feed()).length,4);
 // Fresh API intake concurrency yields one immutable event per receipt/assignment, never per recipient.
 const created=await Promise.all(Array.from({length:4},()=>create()));assert.ok(created.every(r=>r.statusCode===201));
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_event WHERE event_type='LEAD_CREATED'`)[0]!.n,5);
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_event WHERE event_type='LEAD_ASSIGNED'`)[0]!.n,5);
 const page=(await api('GET','/api/notifications?limit=2')).json();assert.equal(page.items.length,2);assert.ok(page.nextCursor);
 assert.ok((await api('GET','/api/notifications?limit=2&cursor='+encodeURIComponent(page.nextCursor))).json().items.every((n:any)=>!page.items.some((p:any)=>p.id===n.id)));
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;assert.equal((await api('GET','/api/notifications')).statusCode,401);
 assert.equal((await db`SELECT count(*)::int AS n FROM conversation`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int AS n FROM background_job`)[0]!.n,0);
});
