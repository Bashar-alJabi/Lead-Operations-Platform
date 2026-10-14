import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('Notification settings enforce current self/administrative authority, strict wording, CAS and atomic history/Audit',async t=>{
 process.env.APP_ORIGIN='http://127.0.0.1:5173';const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});t.after(async()=>{await app.close();await db.end();});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Notification settings') RETURNING id`)[0]!.id,
  foreign=(await db`INSERT INTO organization(name) VALUES('Foreign notifications') RETURNING id`)[0]!.id,
  branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,
  other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id,
  campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES(${org},${branch},'Wording') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,bid,oid] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['other','MANAGER',other,org],['foreign','SUPER_ADMIN',null,foreign]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${oid},${bid},${role},${name},${name+'@notification.test'},'synthetic') RETURNING id`)[0]!.id,token=randomBytes(32).toString('hex'),
   session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={id,session,cookie:'lop_session='+token};
 }
 const api=(method:'GET'|'PUT',path:string,body?:object,who='manager')=>app.inject({method,url:path,payload:body,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}}),
  br='/api/notification-templates/BRANCH/'+branch+'/en',cr='/api/notification-templates/CAMPAIGN/'+campaign+'/en',gr='/api/notification-templates/GLOBAL/'+org+'/en',pref='/api/notification-preferences',
  body={version:0,title:'Handoff {{campaign}}',body:'Owner {{owner}} <img src=x onerror=alert(1)>',active:true,reason:'Operational notification wording'};
 assert.equal((await api('GET',pref,undefined,'agent')).json().enabled,true);
 assert.equal((await api('PUT',pref,{version:0,enabled:false,userId:users.manager!.id},'agent')).statusCode,400);
 const preferences=await Promise.all(Array.from({length:8},()=>api('PUT',pref,{version:0,enabled:false},'agent')));
 assert.equal(preferences.filter(r=>r.statusCode===200).length,1);assert.equal(preferences.filter(r=>r.statusCode===409).length,7);
 assert.equal((await api('GET',pref,undefined,'agent')).json().enabled,false);assert.equal((await api('GET',pref)).json().enabled,true);
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_user_history WHERE user_id=${users.agent!.id}`)[0]!.n,1);
 for(const root of [br,cr]){
  assert.equal((await api('GET',root)).json().version,0);assert.equal((await api('PUT',root,body,'agent')).statusCode,403);
  assert.equal((await api('GET',root,undefined,'other')).statusCode,404);assert.equal((await api('PUT',root,body,'foreign')).statusCode,404);
 }
 assert.equal((await api('GET',gr)).statusCode,403);assert.equal((await api('PUT',gr,body,'foreign')).statusCode,404);
 assert.equal((await api('PUT',gr,body,'admin')).statusCode,200);
 for(const bad of [{...body,title:'{{secret}}'},{...body,body:'bad{token}'},{...body,reason:'   '},{...body,body:'secret\x00text'},{...body,active:'true'},{...body,version:-1},{...body,title:'x'.repeat(161)}])assert.equal((await api('PUT',br,bad)).statusCode,400);
 const raced=await Promise.all(Array.from({length:8},()=>api('PUT',br,body)));assert.equal(raced.filter(r=>r.statusCode===200).length,1);assert.equal(raced.filter(r=>r.statusCode===409).length,7);
 assert.equal((await api('PUT',cr,body)).statusCode,200);
 const hist=(await api('GET',br+'/history?limit=1')).json();assert.equal(hist.items.length,1);assert.equal(hist.items[0].version,1);assert.equal(hist.items[0].session_id,undefined);
 assert.equal((await api('PUT',br,{...body,version:1,active:false})).statusCode,200);
 const latest=(await api('GET',br+'/history?limit=1')).json();assert.ok(latest.nextVersion);assert.equal((await api('GET',br+'/history?limit=1&before='+latest.nextVersion)).json().items[0].version,1);
 await assert.rejects(db`UPDATE notification_template SET version=version+1,actor_id=${users.agent!.id},session_id=${users.agent!.session} WHERE scope='BRANCH' AND resource_id=${branch}`,/CURRENT_ACCESS_REQUIRED/);
 await assert.rejects(db`UPDATE notification_template SET version=version+1,actor_id=${users.manager!.id},session_id=${users.agent!.session} WHERE scope='BRANCH' AND resource_id=${branch}`,/CURRENT_SESSION_REQUIRED/);
 await assert.rejects(db`UPDATE notification_template SET version=version+1,title='{{secret}}' WHERE scope='BRANCH' AND resource_id=${branch}`,/check constraint/);
 await assert.rejects(db`UPDATE notification_template_history SET snapshot='{}' WHERE resource_id=${branch}`,/IMMUTABLE/);
 await assert.rejects(db`DELETE FROM notification_template WHERE resource_id=${branch}`,/HISTORY_PRESERVED/);
 await assert.rejects(db`INSERT INTO notification_template_history SELECT scope,resource_id,event_type,channel,language,version,snapshot,created_at FROM notification_template_history WHERE resource_id=${branch} LIMIT 1`,/CURRENT_PROOF_REQUIRED/);
 await assert.rejects(db`UPDATE notification_user_history SET snapshot='{}' WHERE user_id=${users.agent!.id}`,/IMMUTABLE/);
 await assert.rejects(db`UPDATE notification_preference SET version=version+1,session_id=${users.manager!.session} WHERE user_id=${users.agent!.id}`,/CURRENT_SESSION_REQUIRED/);
 await db`CREATE FUNCTION reject_notification_settings_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IN_APP_NOTIFICATION_TEMPLATE_CONFIGURED' OR NEW.action='IN_APP_NOTIFICATION_PREFERENCE_CHANGED' THEN RAISE EXCEPTION 'NOTIFICATION_SETTINGS_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_notification_settings_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_notification_settings_fixture()`;
 try{
  assert.equal((await api('PUT',br,{...body,version:2})).statusCode,500);assert.equal((await api('PUT',pref,{version:1,enabled:true},'agent')).statusCode,500);
 }finally{await db`DROP TRIGGER reject_notification_settings_fixture ON audit_log`;await db`DROP FUNCTION reject_notification_settings_fixture()`;}
 assert.equal((await api('GET',br)).json().version,2);assert.equal((await api('GET',pref,undefined,'agent')).json().version,1);
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_template_history WHERE scope='BRANCH' AND resource_id=${branch}`)[0]!.n,2);
 // Parent campaign changes after initial scope lookup while a Super Admin waits on the old Branch.
 let ready!:()=>void,release!:()=>void;const locked=new Promise<void>(r=>{ready=r;}),unlock=new Promise<void>(r=>{release=r;});
 const held=db.begin(async tx=>{await tx`SELECT id FROM branch WHERE id=${branch} FOR UPDATE`;ready();await unlock;await tx`UPDATE campaign SET branch_id=${other} WHERE id=${campaign}`;});await locked;
 const moving=api('PUT',cr,{...body,version:1},'admin');
 try{let waiting=false;for(let i=0;i<80;i++){waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT active FROM branch%' AND pid<>pg_backend_pid()) AS yes`)[0]!.yes;if(waiting)break;await new Promise(r=>setTimeout(r,25));}assert.equal(waiting,true);}finally{release();await held;}
 assert.equal((await moving).statusCode,404);
 assert.equal((await api('GET',cr,undefined,'other')).statusCode,404);assert.equal((await api('GET',cr+'/history',undefined,'admin')).statusCode,404);
 await db`UPDATE campaign SET branch_id=${branch} WHERE id=${campaign}`;
 // Revocation after HTTP authentication but before locked current authority denies the write.
 let r2!:()=>void,go!:()=>void;const l2=new Promise<void>(r=>{r2=r;}),u2=new Promise<void>(r=>{go=r;});
 const blocker=db.begin(async tx=>{await tx`SELECT id FROM branch WHERE id=${branch} FOR UPDATE`;r2();await u2;});await l2;
 const stale=api('PUT',br,{...body,version:2});
 try{let waiting=false;for(let i=0;i<80;i++){waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT active FROM branch%' AND pid<>pg_backend_pid()) AS yes`)[0]!.yes;if(waiting)break;await new Promise(r=>setTimeout(r,25));}assert.equal(waiting,true);await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;}finally{go();await blocker;}
 assert.equal((await stale).statusCode,403);
 await assert.rejects(db`UPDATE notification_template SET version=version+1 WHERE scope='BRANCH' AND resource_id=${branch}`,/CURRENT_SESSION_REQUIRED/);
 await db`UPDATE user_account SET active=false WHERE id=${users.agent!.id}`;assert.equal((await api('PUT',pref,{version:1,enabled:true},'agent')).statusCode,401);
 await assert.rejects(db`UPDATE notification_preference SET version=version+1 WHERE user_id=${users.agent!.id}`,/CURRENT_SESSION_REQUIRED/);
});
