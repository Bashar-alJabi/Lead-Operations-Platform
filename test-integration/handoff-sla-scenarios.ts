import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import type {FastifyInstance} from 'fastify';
import type {Database} from '../src/db.js';import {sha256} from '../src/security.js';import {processOneHandoffSLATimer,admitLegacyHandoffSLATimers} from '../src/ai/handoff-sla.js';
type User={id:string;session:string;cookie:string};
export async function verifyHandoffSLATimers(db:Database,app:FastifyInstance,f:{org:string;branch:string;other:string;campaign:string;lead:string;cv:string;action:string;users:Record<string,User>;newHandoff:()=>Promise<string>}){
 const {org,branch,other,campaign,lead,cv}=f,users={...f.users},root='/api/conversations/'+cv+'/handoff-sla',configRoot='/api/ai/campaigns/'+campaign+'/configuration',clockRoot='/api/ai/campaigns/'+campaign+'/handoff-clock';
 const session=async(name:string)=>{const token=randomBytes(32).toString('hex');const sid=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${users[name]!.id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={...users[name]!,session:sid,cookie:'lop_session='+token};};await session('agent');
 const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,who='manager')=>app.inject({method,url:path,payload,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}});
 const advance=async(seconds:number)=>{assert.ok(Number.isInteger(seconds)&&seconds>=0);await db.unsafe(`CREATE OR REPLACE FUNCTION ai_handoff_sla_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp()+interval '${seconds} seconds' $$`);};
 let action=f.action;const timer=async()=>(await db`SELECT * FROM ai_handoff_sla_timer WHERE action_id=${action}`)[0]!;
 const step=()=>db`UPDATE ai_handoff_sla_timer SET version=version+1 WHERE action_id=${action}`;
 const drain=async(predicate:()=>Promise<boolean>)=>{for(let i=0;i<50&&!await predicate();i++)assert.equal(await processOneHandoffSLATimer(db),true);assert.equal(await predicate(),true);};
 try{
  assert.equal((await timer()).state,'UNCONFIGURED');assert.equal((await api('GET',root,undefined,'agent')).statusCode,200);
  for(const who of['second','other','foreign']){assert.equal((await api('GET',root,undefined,who)).statusCode,404);assert.equal((await api('GET',root+'/history',undefined,who)).statusCode,404);}
  const cfg=(await api('GET',configRoot)).json();assert.equal((await api('PUT',configRoot,{version:cfg.version,definition:{...cfg.definition,handoffSlaMinutes:1},reason:'Actual response target'})).statusCode,200);
  const slaEvent='AI_HANDOFF_SLA_EXCEEDED',slaPref='/api/notification-preferences/'+slaEvent,slaTemplate='/api/notification-templates/'+slaEvent+'/CAMPAIGN/'+campaign+'/en';
  for(const who of['agent','other','foreign'])assert.equal((await api('GET',slaTemplate,undefined,who)).statusCode,who==='agent'?403:404);
  const originalWording=(await api('GET','/api/notification-templates/CAMPAIGN/'+campaign+'/en')).json();
  assert.equal((await api('PUT',slaTemplate,{version:0,title:'SLA {{campaign}} / {{owner}}',body:'Review the real waiting requirement <img literal>',active:true,reason:'Separate scoped SLA wording'})).statusCode,200);
  assert.equal((await api('GET','/api/notification-templates/CAMPAIGN/'+campaign+'/en')).json().version,originalWording.version);
  await assert.rejects(db`INSERT INTO notification_event(event_type,source_id) VALUES(${slaEvent},${action})`,/FRESH_SLA_BREACH_REQUIRED/);
  await db`UPDATE ai_handoff_sla_timer SET version=version+1,state='EXPIRED',cursor_at='6100-01-01',elapsed_microseconds=9999999999999,clock='{}',revision=999 WHERE action_id=${action}`;
  assert.equal((await timer()).state,'WAITING');assert.ok(BigInt((await timer()).elapsed_microseconds)<60_000_000n);assert.notEqual((await timer()).revision,999);
  await assert.rejects(db`UPDATE ai_handoff_sla_timer SET version=version+1,started_at=started_at-interval '1 day' WHERE action_id=${action}`,/IDENTITY_VERSION_REQUIRED/);
  await assert.rejects(db`INSERT INTO ai_handoff_sla_timer(action_id) VALUES(gen_random_uuid())`,/ACTUAL_SOURCE_REQUIRED/);
  await assert.rejects(db`DELETE FROM ai_handoff_sla_timer WHERE action_id=${action}`,/HISTORY_PRESERVED/);
  await assert.rejects(db`UPDATE ai_handoff_sla_history SET snapshot='{}' WHERE action_id=${action}`,/HISTORY_IMMUTABLE/);
  await assert.rejects(db`INSERT INTO ai_handoff_sla_history SELECT * FROM ai_handoff_sla_history WHERE action_id=${action} LIMIT 1`,/FRESH_HISTORY_REQUIRED/);
  await assert.rejects(db`INSERT INTO ai_handoff_sla_breach(action_id) VALUES(${action})`,/FRESH_EXPIRY_REQUIRED/);
  await Promise.all(Array.from({length:8},()=>db`INSERT INTO ai_handoff_sla_timer(action_id) VALUES(${action}) ON CONFLICT(action_id) DO NOTHING`));assert.equal((await db`SELECT count(*)::int AS n FROM ai_handoff_sla_timer WHERE action_id=${action}`)[0]!.n,1);
  const c=(await api('GET',clockRoot)).json();assert.equal((await api('PUT',clockRoot,{version:c.version,definition:{mode:'WORKING_HOURS',timezone:'UTC',calendar:{mon:[],tue:[],wed:[],thu:[],fri:[],sat:[],sun:[]}},reason:'Closed response calendar'})).statusCode,200);
  await advance(7200);await step();assert.equal((await timer()).state,'WAITING');assert.equal(BigInt((await timer()).elapsed_microseconds),0n);const revision=(await timer()).revision;
  const quietHistory=(await db`SELECT count(*)::int AS n FROM ai_handoff_sla_history WHERE action_id=${action}`)[0]!.n;await advance(7260);await step();assert.equal((await db`SELECT count(*)::int AS n FROM ai_handoff_sla_history WHERE action_id=${action}`)[0]!.n,quietHistory);
  // Reconfigure the pending clock from the original source; it never silently restarts the waiting requirement.
  await advance(0);assert.equal((await api('PUT',clockRoot,{version:c.version+1,definition:{mode:'ELAPSED',timezone:'UTC',calendar:{}},reason:'Restore elapsed response clock'})).statusCode,200);await step();assert.ok((await timer()).revision>revision);assert.equal((await timer()).state,'WAITING');
  await db`UPDATE branch SET active=false WHERE id=${branch}`;await step();assert.equal((await timer()).state,'PAUSED');await db`UPDATE branch SET active=true WHERE id=${branch}`;await step();assert.equal((await timer()).state,'WAITING');
  await advance(120);await assert.rejects(db.begin(async tx=>{await tx`UPDATE ai_handoff_sla_timer SET version=version+1 WHERE action_id=${action}`;await tx`UPDATE branch SET active=false WHERE id=${branch}`;await tx`SET CONSTRAINTS ai_handoff_sla_final_expiry IMMEDIATE`;}),/FINAL_EXPIRY_PROOF_REQUIRED/);await advance(0);assert.equal((await timer()).state,'WAITING');
  await assert.rejects(db`UPDATE ai_handoff_sla_queue_history SET snapshot='{}' WHERE action_id=${action}`,/HISTORY_IMMUTABLE/);
  const before=(await timer()).version;
  await db`CREATE FUNCTION reject_sla_expiry_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_HANDOFF_SLA_EXCEEDED' THEN RAISE EXCEPTION 'SYNTHETIC_SLA_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER reject_sla_expiry_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_sla_expiry_fixture()`;
  try{for(let count=1;count<=5;count++){await advance(120+count*60);await drain(async()=>(await db`SELECT failure_count FROM ai_handoff_sla_queue WHERE action_id=${action}`)[0]!.failure_count===count);}
   assert.equal((await timer()).version,before);assert.equal((await db`SELECT count(*)::int AS n FROM ai_handoff_sla_breach WHERE action_id=${action}`)[0]!.n,0);
   assert.equal(await processOneHandoffSLATimer(db),false);const failed=(await api('GET',root)).json().timer;assert.equal(failed.queue.failureCount,5);assert.equal(failed.canRetry,true);
   assert.equal((await api('POST',root+'/retry',{version:failed.queue.version,reason:'Agent cannot repair system queue'},'agent')).statusCode,403);
   for(const who of['other','foreign'])assert.equal((await api('POST',root+'/retry',{version:failed.queue.version,reason:'Foreign recovery'},who)).statusCode,404);
   assert.equal((await api('POST',root+'/retry',{version:failed.queue.version-1,reason:'Stale queue recovery'})).statusCode,409);
   await assert.rejects(db`UPDATE ai_handoff_sla_queue SET version=version+1,operation='HUMAN_RETRY',actor_id=${users.agent!.id},session_id=${users.agent!.session},reason='Native Agent recovery' WHERE action_id=${action}`,/CURRENT_RECOVERY_REQUIRED/);
   await assert.rejects(db`UPDATE ai_handoff_sla_queue SET version=version+1,operation='STEP' WHERE action_id=${action}`,/FRESH_STEP_REQUIRED/);
   // Revocation after initial authentication and while waiting for the queue lock must win.
   let ready!:()=>void,release!:()=>void;const held=new Promise<void>(r=>{ready=r;}),unlock=new Promise<void>(r=>{release=r;});
   const blocked=db.begin(async tx=>{await tx`SELECT action_id FROM ai_handoff_sla_queue WHERE action_id=${action} FOR UPDATE`;ready();await unlock;});await held;
   const pending=api('POST',root+'/retry',{version:failed.queue.version,reason:'Current cookie recovery'});
   try{let waiting=false;for(let i=0;i<80;i++){waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT q.action_id,q.version%' AND pid<>pg_backend_pid()) AS ok`)[0]!.ok;if(waiting)break;await new Promise(r=>setTimeout(r,25));}assert.equal(waiting,true);await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;}finally{release();await blocked;}
   assert.equal((await pending).statusCode,403);await session('manager');
  }finally{await db`DROP TRIGGER reject_sla_expiry_fixture ON audit_log`;await db`DROP FUNCTION reject_sla_expiry_fixture()`;}
  const queue=(await api('GET',root)).json().timer.queue;
  assert.equal((await api('POST',root+'/retry',{version:queue.version,reason:'Reviewed synthetic failure <img literal>'})).statusCode,200);
  // Notification Audit failure must roll back expiry, breach, event and progress together.
  await db`CREATE FUNCTION reject_sla_notification_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IN_APP_NOTIFICATION_RECORDED' AND NEW.detail->>'eventType'='AI_HANDOFF_SLA_EXCEEDED' THEN RAISE EXCEPTION 'SYNTHETIC_SLA_NOTIFICATION_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;await db`CREATE TRIGGER reject_sla_notification_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_sla_notification_fixture()`;
  try{assert.equal(await processOneHandoffSLATimer(db),true);assert.equal((await timer()).state,'WAITING');assert.equal((await db`SELECT count(*)::int AS n FROM notification_event WHERE source_id=${action} AND event_type=${slaEvent}`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int AS n FROM ai_handoff_sla_breach WHERE action_id=${action}`)[0]!.n,0);}finally{await db`DROP TRIGGER reject_sla_notification_fixture ON audit_log`;await db`DROP FUNCTION reject_sla_notification_fixture()`;}
  const retryQueue=(await api('GET',root)).json().timer.queue;assert.equal((await api('POST',root+'/retry',{version:retryQueue.version,reason:'Notification Audit recovered'})).statusCode,200);
  const cvBefore=(await db`SELECT version,state,controller_type,ai_handoff_action_id FROM conversation WHERE id=${cv}`)[0]!,ownerBefore=(await db`SELECT assigned_agent_id FROM lead WHERE id=${lead}`)[0]!.assigned_agent_id;
  await Promise.all(Array.from({length:8},()=>processOneHandoffSLATimer(db)));assert.equal((await timer()).state,'EXPIRED');
  assert.equal((await db`SELECT count(*)::int AS n FROM ai_handoff_sla_breach WHERE action_id=${action}`)[0]!.n,1);assert.deepEqual((await db`SELECT version,state,controller_type,ai_handoff_action_id FROM conversation WHERE id=${cv}`)[0],cvBefore);assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${lead}`)[0]!.assigned_agent_id,ownerBefore);
  await assert.rejects(step(),/TERMINAL/);await assert.rejects(db`UPDATE ai_handoff_sla_breach SET snapshot='{}' WHERE action_id=${action}`,/BREACH_IMMUTABLE/);
  assert.equal((await db`SELECT next_run_at='infinity' AS terminal FROM ai_handoff_sla_queue WHERE action_id=${action}`)[0]!.terminal,true);
  const feed='/api/notifications?language=en',notice=(await api('GET',feed,undefined,'agent')).json().items.find((n:any)=>n.eventType===slaEvent&&n.leadId===lead);assert.ok(notice);assert.match(notice.title,/^SLA /);assert.match(notice.body,/<img literal>/);assert.equal(notice.templateSource,'CAMPAIGN');
  assert.equal((await api('GET',feed)).json().items.some((n:any)=>n.id===notice.id),true);for(const who of['second','other','foreign']){assert.equal((await api('GET',feed,undefined,who)).json().items.some((n:any)=>n.id===notice.id),false);assert.equal((await api('PUT','/api/notifications/'+notice.id+'/state',{version:0,isRead:true},who)).statusCode,404);}
  const primaryPref=(await api('GET','/api/notification-preferences',undefined,'agent')).json(),prefRace=await Promise.all(Array.from({length:8},()=>api('PUT',slaPref,{version:0,enabled:false},'agent')));assert.equal(prefRace.filter(r=>r.statusCode===200).length,1);assert.equal(prefRace.filter(r=>r.statusCode===409).length,7);
  assert.equal((await api('GET',feed,undefined,'agent')).json().items.some((n:any)=>n.id===notice.id),false);assert.equal((await api('GET',feed)).json().items.some((n:any)=>n.id===notice.id),true);assert.deepEqual((await api('GET','/api/notification-preferences',undefined,'agent')).json(),primaryPref);
  assert.equal((await db`SELECT count(*)::int AS n FROM notification_user_history WHERE user_id=${users.agent!.id} AND kind='PREFERENCE' AND version=1`)[0]!.n,2);
  assert.equal((await api('PUT',slaPref,{version:1,enabled:true},'agent')).statusCode,200);const states=await Promise.all(Array.from({length:8},()=>api('PUT','/api/notifications/'+notice.id+'/state',{version:0,isRead:true},'agent')));assert.equal(states.filter(r=>r.statusCode===200).length,1);assert.equal(states.filter(r=>r.statusCode===409).length,7);
  assert.equal((await api('GET','/api/notifications/'+notice.id+'/history',undefined,'agent')).json().items[0].is_read,true);assert.equal((await api('GET',feed)).json().items.find((n:any)=>n.id===notice.id).isRead,false);
  await assert.rejects(db`INSERT INTO notification_event(event_type,source_id) VALUES(${slaEvent},${action})`,/FRESH_SLA_BREACH_REQUIRED/);
  assert.equal((await db`SELECT count(*)::int AS n FROM notification_event WHERE source_id=${action} AND event_type=${slaEvent}`)[0]!.n,1);
  const page=(await api('GET',root+'/history?limit=1')).json();assert.equal(page.items.length,1);assert.ok(page.nextVersion);assert.ok((await api('GET',root+'/history?before='+page.nextVersion)).json().items[0].version<page.items[0].version);assert.equal(page.items[0].session_id,undefined);
  // A real new trusted Handoff is required for another timer; human acceptance cancels rather than reactivates AI.
  action=await f.newHandoff();const version=(await db`SELECT version FROM conversation WHERE id=${cv}`)[0]!.version;
  assert.equal((await api('POST','/api/conversations/'+cv+'/takeover',{version,reason:'Accept before SLA timer'})).statusCode,200);await advance(900);await drain(async()=>(await timer()).state==='CANCELLED');assert.equal((await api('GET',root)).json().timer.waiting,false);
  action=await f.newHandoff();const moved=(await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES(${org},${other},'SLA moved','ACTIVE') RETURNING id`)[0]!.id;
  await db`UPDATE lead SET branch_id=${other},campaign_id=${moved},assigned_agent_id=NULL,version=version+1 WHERE id=${lead}`;await advance(1200);await drain(async()=>(await timer()).state==='CANCELLED');assert.equal((await timer()).reason_code,'SOURCE_SCOPE_CHANGED');assert.equal((await api('GET',root,undefined,'admin')).json().timer,null);
  await db`UPDATE lead SET branch_id=${branch},campaign_id=${campaign},assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
  // Simulate a real receipt predating the admission trigger, keeping the original trusted Handoff guards active.
  await db`ALTER TABLE ai_handoff_reception_event DISABLE TRIGGER ai_handoff_sla_admission`;
  try{action=await f.newHandoff();}finally{await db`ALTER TABLE ai_handoff_reception_event ENABLE TRIGGER ai_handoff_sla_admission`;}
  assert.equal((await db`SELECT count(*)::int AS n FROM ai_handoff_sla_timer WHERE action_id=${action}`)[0]!.n,0);
  await Promise.all(Array.from({length:4},()=>admitLegacyHandoffSLATimers(db,null,1)));assert.equal((await db`SELECT count(*)::int AS n FROM ai_handoff_sla_timer WHERE action_id=${action}`)[0]!.n,1);
  assert.equal((await admitLegacyHandoffSLATimers(db,null,1)).done,true);await assert.rejects(admitLegacyHandoffSLATimers(db,null,0),/Invalid SLA admission batch/);
  // Two alerts sharing the exact microsecond must remain reachable through keyset pages.
  await db`CREATE OR REPLACE FUNCTION ai_handoff_sla_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT '2030-01-01T00:00:00.123456Z'::timestamptz $$`;
  const tied:string[]=[];for(let n=0;n<2;n++){action=await f.newHandoff();if(n===1)await db`UPDATE lead SET assigned_agent_id=NULL,version=version+1 WHERE id=${lead}`;await step();tied.push((await db`SELECT id FROM notification_event WHERE source_id=${action} AND event_type=${slaEvent}`)[0]!.id);}
  const firstPage=(await api('GET',feed+'&limit=1')).json(),secondPage=(await api('GET',feed+'&limit=1&cursor='+encodeURIComponent(firstPage.nextCursor))).json();assert.deepEqual(new Set([firstPage.items[0].id,secondPage.items[0].id]),new Set(tied));
  assert.equal((await api('GET',feed,undefined,'agent')).json().items.some((n:any)=>tied.includes(n.id)),false);assert.equal((await db`SELECT snapshot->'ownerAtObservation' AS owner FROM ai_handoff_sla_breach WHERE action_id=${action}`)[0]!.owner,null);
  await db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
 }finally{await db`CREATE OR REPLACE FUNCTION ai_handoff_sla_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() $$`;}
}
