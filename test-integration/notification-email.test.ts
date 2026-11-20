import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {notificationEvents,isOperationalNotification,effectiveNotificationTemplate,type NotificationTemplate} from '../src/notifications.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test'||!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw Error('Isolated loopback test database required');
async function setup(t:import('node:test').TestContext){
 process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.APP_ORIGIN='http://127.0.0.1:5173';
 const db=createDatabase(url);await db.begin(async tx=>{await tx`SET LOCAL client_min_messages=warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Synthetic Email Channel') RETURNING id`)[0]!.id,
  b=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Email Channel A') RETURNING id`)[0]!.id,
  other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Email Channel B') RETURNING id`)[0]!.id,
  foreign=(await db`INSERT INTO organization(name) VALUES('Foreign Email Channel') RETURNING id`)[0]!.id,
  actors:Record<string,{id:string;sid:string;cookie:string}>={};
 for(const [name,role,branch,organization] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',b,org],['other','MANAGER',other,org],['agent','AGENT',b,org],['foreign','SUPER_ADMIN',null,foreign]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES(${organization},${branch},${name},${role},${name+'@notification.example.test'},'synthetic') RETURNING id`)[0]!.id,
   token=randomBytes(32).toString('hex'),sid=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;
  actors[name]={id,sid,cookie:'lop_session='+token};
 }
 let checks=0,sends=0;const app=await buildApp(db,{logger:false,globalRateLimitMax:10000,operationalEmailAdapters:{SMTP:{verify:async()=>{checks++;},send:async()=>{sends++;throw Error('Configuration must not send email');}}}});
 t.after(async()=>{await app.close();await db.end();});
 const api=(method:string,path:string,payload?:object,who='manager')=>app.inject({method:method as 'GET',url:path,headers:{cookie:actors[who]!.cookie,origin:process.env.APP_ORIGIN!},...(payload?{payload}:{})});
 const create=async(who='manager',branchId:string|null|undefined=undefined,ready=true)=>{
  const r=await api('POST','/api/email/connections',{name:'Synthetic <svg onload=evil()>',settings:{host:'smtp.example.test',port:465,secure:true,username:'synthetic',fromAddress:'notices@example.test'},password:'SyntheticEmailPassword_NotReal',reason:'Synthetic channel account',...(branchId!==undefined?{branchId}:{})},who);
  assert.equal(r.statusCode,201,r.body);const c=r.json();if(ready){const p=await api('POST','/api/email/connections/'+c.id+'/test',{version:1},who);assert.equal(p.statusCode,200,p.body);}return c.id as string;
 };
 return {db,api,create,org,b,other,actors,sends:()=>sends,checks:()=>checks};
}
test('Email channel bindings require explicit scoped current approval, checked distinct accounts, CAS, immutable history and atomic Audit without sending',async t=>{
 const f=await setup(t),{db,api}=f,root='/api/notification-email/branches/'+f.b,cid=await f.create('manager',undefined,false);
 const save=(version:number,enabled:boolean,connectionId:string|null=cid,who='manager')=>api('PUT',root,{version,enabled,connectionId,reason:'Synthetic explicit channel approval'},who);
 assert.equal((await api('GET',root)).json().enabled,false);assert.equal((await save(0,true)).statusCode,409);
 assert.equal((await api('POST','/api/email/connections/'+cid+'/test',{version:1})).statusCode,200);assert.equal((await save(0,true)).statusCode,200);
 for(const who of ['other','foreign'])assert.equal((await api('GET',root,undefined,who)).statusCode,404);
 assert.equal((await api('GET',root,undefined,'agent')).statusCode,403);assert.equal((await save(1,false,cid,'agent')).statusCode,403);
 const raced=await Promise.all(Array.from({length:8},()=>save(1,false)));assert.equal(raced.filter(r=>r.statusCode===200).length,1);assert.equal(raced.filter(r=>r.statusCode===409).length,7);
 assert.equal((await save(2,true)).statusCode,200);
 for(let v=3;v<23;v++)assert.equal((await save(v,false)).statusCode,200);
 const h=(await api('GET',root+'/history')).json();assert.equal(h.items.length,20);assert.equal(h.nextVersion,4);assert.equal((await api('GET',root+'/history?before=4')).json().items.length,3);
 const shared=await f.create('admin',null),otherConnection=await f.create('other'),catalog=await api('GET',root+'/connections');
 assert.ok(!catalog.body.includes(shared));assert.ok(!catalog.body.includes('SyntheticEmailPassword'));assert.ok(!catalog.body.includes('smtp.example.test'));
 assert.equal((await save(23,true,shared)).statusCode,403);assert.equal((await save(23,true,otherConnection)).statusCode,404);
 assert.equal((await save(23,true,shared,'admin')).statusCode,200);assert.equal((await api('GET',root)).json().connection.scope,'ORGANIZATION');
 assert.equal((await api('GET','/api/email/connections/'+shared)).statusCode,404,'a Branch binding never exposes Organization credentials');
 assert.equal((await save(24,false,shared)).statusCode,200);assert.equal((await save(25,true,shared)).statusCode,403);assert.equal((await save(25,true,cid)).statusCode,200);
 await assert.rejects(db`UPDATE notification_email_binding SET connection_id=${otherConnection},version=version+1 WHERE branch_id=${f.b}`,/EMAIL_NOTIFICATION_CONNECTION_SCOPE_REQUIRED/);
 await assert.rejects(db`UPDATE notification_email_binding_history SET snapshot='{}' WHERE branch_id=${f.b}`,/EMAIL_NOTIFICATION_HISTORY_IMMUTABLE/);
 await assert.rejects(db`DELETE FROM notification_email_binding WHERE branch_id=${f.b}`,/EMAIL_NOTIFICATION_HISTORY_PRESERVED/);
 await db`CREATE FUNCTION reject_email_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='EMAIL_NOTIFICATION_BINDING_CONFIGURED' THEN RAISE EXCEPTION 'Synthetic Email Audit failure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_email_config_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_email_config_audit()`;
 try{assert.equal((await save(26,false)).statusCode,500);assert.equal((await api('GET',root)).json().version,26);assert.equal((await api('GET',root+'/history')).json().items[0].version,26);}
 finally{await db`DROP TRIGGER reject_email_config_audit ON audit_log`;await db`DROP FUNCTION reject_email_config_audit()`;}
 await db`UPDATE branch SET active=false WHERE id=${f.b}`;assert.equal((await save(26,false)).statusCode,200);assert.equal((await save(27,true)).statusCode,409);
 let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>{release=r;}),locked=new Promise<void>(r=>{ready=r;});
 const holder=db.begin(async tx=>{await tx`SELECT id FROM branch WHERE id=${f.b} FOR UPDATE`;ready();await gate;});await locked;
 const pending=save(27,false);try{
  let waiting=false;for(let i=0;i<50;i++){waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id,active FROM branch%' AND query LIKE '%FOR UPDATE%') yes`)[0]!.yes;if(waiting)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(waiting,true,'the genuine API waits on Branch lock before current-session check');await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${f.actors.manager!.sid}`;
 }finally{release();await holder;}
 assert.equal((await pending).statusCode,403);assert.equal((await api('GET',root,undefined,'admin')).json().version,27);assert.equal(f.sends(),0);
});
test('Email preferences are personal explicit opt-in with persisted language, per-event CAS/history, strict types and real current-session fences, preserving IN_APP',async t=>{
 const f=await setup(t),{db,api}=f,root='/api/notification-email/preferences',event='AI_HANDOFF_REQUESTED';
 const initial=(await api('GET',root,undefined,'agent')).json();assert.equal(initial.recipient,'agent@notification.example.test');assert.equal(initial.items.length,11);assert.ok(initial.items.every((p:{enabled:boolean;version:number})=>!p.enabled&&p.version===0));
 const save=(version:number,extra:object={})=>api('PUT',root+'/'+event,{version,enabled:true,language:'fr',...extra},'agent');
 assert.equal((await save(0)).statusCode,200);const oldInApp=(await api('GET','/api/notification-preferences',undefined,'agent')).json();assert.equal(oldInApp.enabled,true);assert.equal(oldInApp.version,0);
 const raced=await Promise.all(Array.from({length:8},()=>save(1)));assert.equal(raced.filter(r=>r.statusCode===200).length,1);assert.equal(raced.filter(r=>r.statusCode===409).length,7);
 assert.equal((await save(2,{enabled:'true'})).statusCode,400);assert.equal((await save(2,{language:'xx'})).statusCode,400);assert.equal((await save(2,{recipient:'arbitrary@example.test'})).statusCode,400);assert.equal((await save(2,{userId:f.actors.other!.id})).statusCode,400);
 assert.equal((await api('PUT',root+'/INVALID',{version:0,enabled:true,language:'en'},'agent')).statusCode,400);
 for(let v=2;v<23;v++)assert.equal((await save(v,{enabled:false})).statusCode,200);
 const h=(await api('GET',root+'/'+event+'/history',undefined,'agent')).json();assert.equal(h.items.length,20);assert.equal(h.nextVersion,4);assert.equal((await api('GET',root+'/'+event+'/history?before=4',undefined,'agent')).json().items.length,3);
 assert.ok((await api('GET',root,undefined,'manager')).json().items.every((p:{version:number})=>p.version===0));
 for(const e of notificationEvents.filter(e=>e!==event))assert.equal((await api('PUT',root+'/'+e,{version:0,enabled:true,language:'en'},'agent')).statusCode,isOperationalNotification(e)?403:200);
 await assert.rejects(db`UPDATE notification_email_preference SET session_id=${f.actors.manager!.sid},version=version+1 WHERE user_id=${f.actors.agent!.id} AND event_type=${event}`,/EMAIL_NOTIFICATION_CURRENT_SESSION_REQUIRED/);
 await assert.rejects(db`UPDATE notification_email_preference_history SET snapshot='{}' WHERE user_id=${f.actors.agent!.id}`,/EMAIL_NOTIFICATION_HISTORY_IMMUTABLE/);
 await assert.rejects(db`DELETE FROM notification_email_preference WHERE user_id=${f.actors.agent!.id}`,/EMAIL_NOTIFICATION_HISTORY_PRESERVED/);
 await assert.rejects(db`INSERT INTO notification_email_preference_history(user_id,event_type,version,snapshot,created_at) VALUES(${f.actors.agent!.id},${event},999,'{}',clock_timestamp())`,/EMAIL_NOTIFICATION_FRESH_HISTORY_REQUIRED/);
 await db`CREATE FUNCTION reject_email_preference_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='EMAIL_NOTIFICATION_PREFERENCE_CONFIGURED' THEN RAISE EXCEPTION 'Synthetic preference Audit failure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_email_preference_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_email_preference_audit()`;
 try{assert.equal((await save(23)).statusCode,500);assert.equal((await api('GET',root,undefined,'agent')).json().items.find((p:{eventType:string})=>p.eventType===event).version,23);}
 finally{await db`DROP TRIGGER reject_email_preference_audit ON audit_log`;await db`DROP FUNCTION reject_email_preference_audit()`;}
 let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>{release=r;}),locked=new Promise<void>(r=>{ready=r;});
 const holder=db.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended(${f.actors.agent!.id+':email-notification:'+event},0))`;ready();await gate;});await locked;
 const pending=save(23);try{
  let waiting=false;for(let i=0;i<50;i++){waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%') yes`)[0]!.yes;if(waiting)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(waiting,true,'the genuine preference API waits on its real advisory lock');await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${f.actors.agent!.sid}`;
 }finally{release();await holder;}
 assert.equal((await pending).statusCode,403);assert.equal((await api('GET',root,undefined,'agent')).statusCode,401);assert.equal(f.sends(),0);assert.equal(f.checks(),0);
});
test('Email wording shares trusted scope/fallback and immutable native Audit while keeping channel/language history distinct and rejecting subject injection',async t=>{
 const f=await setup(t),{db,api}=f,root='/api/notification-email/templates/BRANCH/'+f.b+'/en',oldRoot='/api/notification-templates/BRANCH/'+f.b+'/en';
 const body={version:0,active:true,title:'Email {{campaign}}',body:'Hello {{owner}} <svg onload=evil()>',reason:'Synthetic approved email wording'};
 assert.equal((await api('GET',root,undefined,'agent')).statusCode,403);assert.equal((await api('GET',root,undefined,'other')).statusCode,404);assert.equal((await api('GET',root,undefined,'foreign')).statusCode,404);
 assert.equal((await api('PUT',root,body)).statusCode,200);assert.equal((await api('GET',root)).json().channel,'EMAIL');assert.equal((await api('GET',oldRoot)).json().version,0);
 assert.equal((await api('PUT',root,{...body,version:1,title:'Header\r\nBcc: injected@example.test'})).statusCode,400);assert.equal((await api('PUT',root,{...body,version:1,body:'{{secret}}'})).statusCode,400);assert.equal((await api('PUT',root,{...body,version:1,active:'true'})).statusCode,400);assert.equal((await api('PUT',root,body)).statusCode,409);
 const global='/api/notification-email/templates/GLOBAL/'+f.org+'/en';assert.equal((await api('PUT',global,body)).statusCode,403);assert.equal((await api('PUT',global,{...body,title:'Organization {{campaign}}'},'admin')).statusCode,200);
 const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES(${f.org},${f.b},'Synthetic Campaign') RETURNING id`)[0]!.id;
 const campaignRoot='/api/notification-email/templates/CAMPAIGN/'+campaign+'/en';assert.equal((await api('PUT',campaignRoot,{...body,title:'Campaign {{campaign}}'})).statusCode,200);
 const effective=async()=>effectiveNotificationTemplate(await db`SELECT scope,resource_id,branch_id,title,body,version,active,event_type FROM notification_template WHERE organization_id=${f.org} AND channel='EMAIL' AND language='en'` as NotificationTemplate[],f.org,f.b,campaign,'en');
 assert.equal((await effective()).source,'CAMPAIGN');assert.equal((await api('PUT',campaignRoot,{...body,version:1,active:false})).statusCode,200);assert.equal((await effective()).source,'BRANCH');
 assert.equal((await api('PUT',root,{...body,version:1,active:false})).statusCode,200);assert.equal((await effective()).source,'GLOBAL');
 assert.equal((await api('PUT',global,{...body,version:1,active:false},'admin')).statusCode,200);assert.equal((await effective()).source,'DEFAULT');
 for(const event of notificationEvents.filter(e=>e!=='AI_HANDOFF_REQUESTED')){
  const wording=isOperationalNotification(event)?{...body,title:'Operational alert',body:'Review integration settings.'}:body;
  assert.equal((await api('PUT','/api/notification-email/templates/'+event+'/BRANCH/'+f.b+'/fr',wording)).statusCode,200);
 }
 await assert.rejects(db`UPDATE notification_template SET title=E'Header\nInjected',version=version+1 WHERE scope='BRANCH' AND resource_id=${f.b} AND channel='EMAIL' AND language='en'`,/notification_email_subject_check/);
 await assert.rejects(db`UPDATE notification_template_history SET snapshot='{}' WHERE resource_id=${f.b} AND channel='EMAIL'`,/NOTIFICATION_HISTORY_IMMUTABLE/);
 assert.ok((await api('GET',root+'/history')).json().items.some((h:{body:string})=>h.body.includes('<svg')));assert.equal((await api('GET',oldRoot+'/history')).json().items.length,0);
 const [audit]=await db`SELECT count(*)::int n FROM audit_log WHERE action='EMAIL_NOTIFICATION_TEMPLATE_CONFIGURED'`;assert.ok(audit!.n>0);
 await db`CREATE FUNCTION reject_email_wording_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='EMAIL_NOTIFICATION_TEMPLATE_CONFIGURED' THEN RAISE EXCEPTION 'Synthetic wording Audit failure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_email_wording_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_email_wording_audit()`;
 try{assert.equal((await api('PUT',root,{...body,version:2})).statusCode,500);assert.equal((await api('GET',root)).json().version,2);assert.equal((await api('GET',root+'/history')).json().items.length,2);}
 finally{await db`DROP TRIGGER reject_email_wording_audit ON audit_log`;await db`DROP FUNCTION reject_email_wording_audit()`;}
 assert.equal(f.sends(),0);assert.equal(f.checks(),0);
});
