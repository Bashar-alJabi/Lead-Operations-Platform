import assert from 'node:assert/strict';
import type {FastifyInstance} from 'fastify';
import type {Database} from '../src/db.js';
export async function verifyHandoffNotifications(db:Database,app:FastifyInstance,f:{org:string;branch:string;other:string;campaign:string;lead:string;cv:string;action:string;users:Record<string,{id:string;session:string;cookie:string}>}) {
 const {org,branch,other,campaign,lead,cv,action,users}=f,api=(method:'GET'|'PUT',path:string,body?:object,who='manager')=>app.inject({method,url:path,payload:body,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}}),feed='/api/notifications?language=en',
  event=(await db`SELECT id FROM notification_event WHERE source_id=${action}`)[0]!.id,root='/api/notifications/'+event,br='/api/notification-templates/BRANCH/'+branch+'/en',cr='/api/notification-templates/CAMPAIGN/'+campaign+'/en',gr='/api/notification-templates/GLOBAL/'+org+'/en';
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_event WHERE source_id=${action}`)[0]!.n,1);
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_event e JOIN ai_customer_handoff_action a ON a.id=e.source_id WHERE a.state<>'APPLIED'`)[0]!.n,0);
 for(const who of ['manager','agent','admin']){const r=await api('GET',feed,undefined,who);assert.equal(r.statusCode,200,r.body);assert.ok(r.json().items.some((n:any)=>n.id===event));}
 for(const who of ['agent','manager'])assert.equal((await api('GET','/api/notifications/indicator',undefined,who)).json().hasUnread,true);
 for(const who of ['second','other','foreign'])assert.equal((await api('GET','/api/notifications/indicator',undefined,who)).json().hasUnread,false);
 for(const who of ['second','other','foreign']){assert.deepEqual((await api('GET',feed,undefined,who)).json().items,[]);assert.equal((await api('PUT',root+'/state',{version:0,isRead:true},who)).statusCode,404);assert.equal((await api('GET',root+'/history',undefined,who)).statusCode,404);}
 assert.equal((await api('GET','/api/notifications?limit=51')).statusCode,400);assert.equal((await api('GET','/api/notifications?language=xx')).statusCode,400);assert.equal((await api('GET','/api/notifications?cursor=bad')).statusCode,400);
 const page=(await api('GET',feed+'&limit=1')).json();assert.ok(page.nextCursor);const older=(await api('GET',feed+'&limit=1&cursor='+encodeURIComponent(page.nextCursor))).json();assert.notEqual(page.items[0].id,older.items[0].id);
 assert.equal((await api('PUT',root+'/state',{version:0,isRead:true,userId:users.agent!.id})).statusCode,400);
 const race=await Promise.all(Array.from({length:8},()=>api('PUT',root+'/state',{version:0,isRead:true},'agent')));assert.equal(race.filter(r=>r.statusCode===200).length,1);assert.equal(race.filter(r=>r.statusCode===409).length,7);
 assert.equal((await api('GET',feed,undefined,'agent')).json().items.find((n:any)=>n.id===event).isRead,true);assert.equal((await api('GET',feed)).json().items.find((n:any)=>n.id===event).isRead,false);
 assert.equal((await api('GET',feed+'&unreadOnly=true',undefined,'agent')).json().items.some((n:any)=>n.id===event),false);
 assert.equal((await api('PUT',root+'/state',{version:1,isRead:false},'agent')).statusCode,200);
 const h=(await api('GET',root+'/history?limit=1',undefined,'agent')).json();assert.equal(h.items[0].version,2);assert.equal(h.items[0].session_id,undefined);assert.ok(h.nextVersion);assert.equal((await api('GET',root+'/history?before='+h.nextVersion,undefined,'agent')).json().items[0].is_read,true);
 assert.equal((await api('PUT','/api/notification-preferences',{version:0,enabled:false},'agent')).statusCode,200);assert.deepEqual((await api('GET',feed,undefined,'agent')).json().items,[]);
 assert.equal((await api('GET','/api/notifications/indicator',undefined,'agent')).json().hasUnread,false);
 assert.ok((await api('GET',feed)).json().items.length);assert.equal((await api('PUT','/api/notification-preferences',{version:1,enabled:true},'agent')).statusCode,200);
 assert.equal((await api('GET',feed,undefined,'agent')).json().items.find((n:any)=>n.id===event).version,2);
 // Same-language scoped fallback, current template trace and no hidden conversation/Fields/credentials in DTO.
 const word={title:'Global {{campaign}}',body:'Owner {{owner}} <img src=x>',active:true,version:0,reason:'Trusted in-app wording'};
 assert.equal((await api('PUT',gr,word,'admin')).statusCode,200);
 assert.equal((await api('GET',feed)).json().items[0].templateSource,'GLOBAL');
 assert.equal((await api('PUT',br,{...word,title:'Branch {{campaign}}'})).statusCode,200);assert.equal((await api('GET',feed)).json().items[0].templateSource,'BRANCH');
 assert.equal((await api('PUT',cr,{...word,title:'Campaign {{campaign}}'})).statusCode,200);const dto=(await api('GET',feed)).json().items[0];assert.equal(dto.templateSource,'CAMPAIGN');assert.equal(dto.templateVersion,1);assert.match(dto.body,/<img/);
 assert.equal(dto.customer_question,undefined);assert.equal(dto.contact_name,undefined);assert.equal(dto.context,undefined);assert.equal(dto.session_id,undefined);
 assert.equal((await api('GET','/api/notifications?language=fr')).json().items[0].templateSource,'DEFAULT');
 assert.equal((await api('PUT',cr,{...word,version:1,active:false})).statusCode,200);assert.equal((await api('GET',feed)).json().items[0].templateSource,'BRANCH');
 await assert.rejects(db`UPDATE notification_event SET event_type='AI_HANDOFF_REQUESTED' WHERE id=${event}`,/IMMUTABLE/);await assert.rejects(db`DELETE FROM notification_event WHERE id=${event}`,/IMMUTABLE/);
 await assert.rejects(db`INSERT INTO notification_event(event_type,source_id) VALUES('AI_HANDOFF_REQUESTED',${action})`,/FRESH_HANDOFF_REQUIRED/);
 await assert.rejects(db`INSERT INTO notification_state(user_id,event_id,is_read,version,session_id) VALUES(${users.second!.id},${event},true,1,${users.second!.session})`,/CURRENT_ACCESS_REQUIRED/);
 await assert.rejects(db`UPDATE notification_state SET version=version+1,session_id=${users.manager!.session} WHERE user_id=${users.agent!.id} AND event_id=${event}`,/CURRENT_SESSION_REQUIRED/);
 await assert.rejects(db`UPDATE notification_user_history SET snapshot='{}' WHERE user_id=${users.agent!.id} AND kind='STATE'`,/IMMUTABLE/);
 await assert.rejects(db`DELETE FROM notification_state WHERE user_id=${users.agent!.id} AND event_id=${event}`,/HISTORY_PRESERVED/);
 await db`CREATE FUNCTION reject_notification_state_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IN_APP_NOTIFICATION_STATE_CHANGED' THEN RAISE EXCEPTION 'NOTIFICATION_STATE_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_notification_state_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_notification_state_fixture()`;
 try{assert.equal((await api('PUT',root+'/state',{version:2,isRead:true},'agent')).statusCode,500);}finally{await db`DROP TRIGGER reject_notification_state_fixture ON audit_log`;await db`DROP FUNCTION reject_notification_state_fixture()`;}
 assert.equal((await db`SELECT version FROM notification_state WHERE user_id=${users.agent!.id} AND event_id=${event}`)[0]!.version,2);
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_user_history WHERE user_id=${users.agent!.id} AND kind='STATE' AND resource_id=${event}`)[0]!.n,2);
 // Existing assignment service changes audience without changing event/history or controller.
 const lv=(await db`SELECT version FROM lead WHERE id=${lead}`)[0]!.version;
 const moved=await app.inject({method:'POST',url:'/api/leads/'+lead+'/assignment',payload:{version:lv,agentId:users.second!.id,reason:'Authorized notification audience change'},headers:{cookie:users.manager!.cookie,origin:process.env.APP_ORIGIN!}});assert.equal(moved.statusCode,200,moved.body);
 assert.deepEqual((await api('GET',feed,undefined,'agent')).json().items,[]);assert.equal((await api('GET',root+'/history',undefined,'agent')).statusCode,404);assert.equal((await api('PUT',root+'/state',{version:2,isRead:true},'agent')).statusCode,404);
 assert.equal((await api('GET','/api/notifications/indicator',undefined,'agent')).json().hasUnread,false);
 assert.ok((await api('GET',feed,undefined,'second')).json().items.length);assert.equal((await api('GET',feed,undefined,'second')).json().items.find((n:any)=>n.id===event).version,0);
 assert.equal((await db`SELECT controller_type FROM conversation WHERE id=${cv}`)[0]!.controller_type,'NONE');
 // Scope move during initial feed selection cannot leak a transferred Lead, even to Super Admin.
 const target=(await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES(${org},${other},'Notification transfer','ACTIVE') RETURNING id`)[0]!.id;
 let ready!:()=>void,release!:()=>void;const locked=new Promise<void>(r=>{ready=r;}),unlock=new Promise<void>(r=>{release=r;});
 const held=db.begin(async tx=>{await tx`SELECT id FROM lead WHERE id=${lead} FOR UPDATE`;ready();await unlock;await tx`UPDATE lead SET branch_id=${other},campaign_id=${target},assigned_agent_id=NULL,version=version+1 WHERE id=${lead}`;});await locked;
 const readMoving=api('GET',feed,undefined,'admin');
 try{let waiting=false;for(let i=0;i<80;i++){waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM lead WHERE id IN%' AND pid<>pg_backend_pid()) AS yes`)[0]!.yes;if(waiting)break;await new Promise(r=>setTimeout(r,25));}assert.equal(waiting,true);}finally{release();await held;}
 assert.deepEqual((await readMoving).json().items,[]);assert.equal((await api('GET',root+'/history',undefined,'admin')).statusCode,404);
 await db`UPDATE lead SET branch_id=${branch},campaign_id=${campaign},assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
 // Current cookie must still exist after waiting for a source lock.
 let r2!:()=>void,go!:()=>void;const l2=new Promise<void>(r=>{r2=r;}),u2=new Promise<void>(r=>{go=r;});
 const blocker=db.begin(async tx=>{await tx`SELECT id FROM branch WHERE id=${branch} FOR UPDATE`;r2();await u2;});await l2;
 const stale=api('PUT',root+'/state',{version:2,isRead:true},'agent');
 try{let waiting=false;for(let i=0;i<80;i++){waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM branch WHERE id=%FOR SHARE%' AND pid<>pg_backend_pid()) AS yes`)[0]!.yes;if(waiting)break;await new Promise(r=>setTimeout(r,25));}assert.equal(waiting,true);await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.agent!.session}`;}finally{go();await blocker;}
 assert.equal((await stale).statusCode,403);await assert.rejects(db`UPDATE notification_state SET version=version+1 WHERE user_id=${users.agent!.id} AND event_id=${event}`,/CURRENT_SESSION_REQUIRED/);
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_event WHERE source_id=${action}`)[0]!.n,1);
}
