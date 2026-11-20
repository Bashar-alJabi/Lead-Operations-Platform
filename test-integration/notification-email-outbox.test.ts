import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {processOneEmailPublication} from '../src/notification-email-outbox.js';
import {processOneNotificationEmail} from '../src/notification-email-dispatch.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test'||!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw Error('Isolated loopback test database required');
async function setup(t:import('node:test').TestContext){
 process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.APP_ORIGIN='http://127.0.0.1:5173';
 const db=createDatabase(url);await db.begin(async tx=>{await tx`SET LOCAL client_min_messages=warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Synthetic queued Email') RETURNING id`)[0]!.id,
  b=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Email A') RETURNING id`)[0]!.id,
  other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Email B') RETURNING id`)[0]!.id,
  foreign=(await db`INSERT INTO organization(name) VALUES('Foreign queue') RETURNING id`)[0]!.id,
  campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status,routing_method) VALUES(${org},${b},'Synthetic <svg onload=evil()>','ACTIVE','ROUND_ROBIN') RETURNING id`)[0]!.id,
  actors:Record<string,{id:string;sid:string;cookie:string}>={};
 async function actor(name:string,role='MANAGER',branch:string|null=b,organization=org){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES(${organization},${branch},${name},${role},${name+'@outbox.example.test'},'synthetic') RETURNING id`)[0]!.id,
   token=randomBytes(32).toString('hex'),sid=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;
  return actors[name]={id,sid,cookie:'lop_session='+token};
 }
 await actor('manager');await actor('agent','AGENT');await actor('second','AGENT');await actor('admin','SUPER_ADMIN',null);await actor('other','MANAGER',other);await actor('foreign','SUPER_ADMIN',null,foreign);
 await db`INSERT INTO campaign_agent(campaign_id,agent_id) VALUES(${campaign},${actors.agent!.id})`;
 let sends=0;const app=await buildApp(db,{logger:false,globalRateLimitMax:10000,operationalEmailAdapters:{SMTP:{verify:async()=>{},send:async()=>{sends++;throw Error('Publication must never send');}}}});
 t.after(async()=>{await app.close();await db.end();});
 const api=(method:string,path:string,payload?:object,who='manager')=>app.inject({method:method as 'GET',url:path,headers:{cookie:actors[who]!.cookie,origin:process.env.APP_ORIGIN!},...(payload?{payload}:{})});
 let counter=0;async function create(){const r=await api('POST','/api/leads',{branchId:b,campaignId:campaign,contact:{name:'Synthetic queued Lead',phone:'+1555888'+String(++counter).padStart(4,'0')}});assert.equal(r.statusCode,201,r.body);return r.json().id as string;}
 async function channel(){const made=await api('POST','/api/email/connections',{name:'Synthetic queue account',settings:{host:'smtp.example.test',port:465,secure:true,username:'synthetic',fromAddress:'notices@example.test'},password:'SyntheticEmail_NotReal',reason:'Synthetic queued notification channel'});assert.equal(made.statusCode,201,made.body);const cid=made.json().id;
  assert.equal((await api('POST','/api/email/connections/'+cid+'/test',{version:1})).statusCode,200);
  assert.equal((await api('PUT','/api/notification-email/branches/'+b,{version:0,enabled:true,connectionId:cid,reason:'Explicit synthetic activation'})).statusCode,200);return cid as string;}
 async function opt(who='manager',version=0,enabled=true,language='en'){const r=await api('PUT','/api/notification-email/preferences/LEAD_CREATED',{version,enabled,language},who);assert.equal(r.statusCode,200,r.body);}
 async function drain(){let n=0;while(await processOneEmailPublication(db)){if(++n>200)throw Error('Unexpected unbounded materialization');}return n;}
 return {db,api,create,channel,opt,drain,actor,actors,org,b,other,campaign,sends:()=>sends};
}

test('Email publication excludes historical and late opt-in events, prepares only current recipients without sessions or SMTP, and has native immutable receipt proofs',async t=>{
 const f=await setup(t),{db,api}=f,old=await f.create();assert.equal((await db`SELECT count(*)::int n FROM notification_email_publication`)[0]!.n,0);
 await f.channel();for(const who of ['manager','agent','second','other','foreign'])await f.opt(who);
 const activated=(await db`SELECT enabled_since::text at FROM notification_email_preference WHERE user_id=${f.actors.manager!.id}`)[0]!.at;
 const lead=await f.create();await f.opt('admin');await f.opt('manager',1,true,'fr');
 assert.equal((await db`SELECT enabled_since::text at FROM notification_email_preference WHERE user_id=${f.actors.manager!.id}`)[0]!.at,activated);
 // Background opt-in authority survives logout, but never bypasses current account/Lead scope.
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${f.actors.agent!.sid}`;
 assert.equal(await f.drain(),2);
 const rows=await db`SELECT o.*,e.lead_id FROM notification_email_outbox o JOIN notification_event e ON e.id=o.event_id ORDER BY o.user_id`;
 assert.equal(rows.length,2);assert.deepEqual(rows.map(x=>x.user_id).sort(),[f.actors.manager!.id,f.actors.agent!.id].sort());assert.ok(rows.every(x=>x.lead_id===lead&&x.state==='WAITING'));
 assert.equal(rows.find(x=>x.user_id===f.actors.manager!.id)!.language,'fr');assert.equal(await f.drain(),0);assert.equal(f.sends(),0);
 const feed=(await api('GET','/api/notification-email/deliveries')).json();assert.equal(feed.items.length,1);assert.equal(feed.items[0].leadId,lead);assert.ok(!JSON.stringify(feed).includes('smtp.example.test'));
 assert.equal((await api('GET','/api/notification-email/deliveries?userId='+f.actors.agent!.id)).statusCode,400);
 for(const who of ['second','admin','other','foreign'])assert.equal((await api('GET','/api/notification-email/deliveries',undefined,who)).json().items.length,0);
 const older=(await db`SELECT id FROM notification_event WHERE lead_id=${old} LIMIT 1`)[0]!.id;
 await assert.rejects(db`INSERT INTO notification_email_publication(event_id) VALUES(${older})`,/EMAIL_FRESH_NOTIFICATION_REQUIRED/);
 await assert.rejects(db`UPDATE notification_email_outbox SET language='ar' WHERE id=${rows[0]!.id}`,/EMAIL_OUTBOX_IMMUTABLE/);
 await assert.rejects(db`DELETE FROM notification_email_outbox WHERE id=${rows[0]!.id}`,/EMAIL_OUTBOX_IMMUTABLE/);
 await assert.rejects(db`UPDATE notification_email_publication SET cursor_user_id=NULL WHERE event_id=${rows[0]!.event_id}`,/EMAIL_FRESH_MATERIALIZATION_REQUIRED/);
 await assert.rejects(db`DELETE FROM notification_email_materialization WHERE event_id=${rows[0]!.event_id}`,/EMAIL_MATERIALIZATION_IMMUTABLE/);
 const another=await f.create(),event=(await db`SELECT id FROM notification_event WHERE lead_id=${another} AND event_type='LEAD_CREATED'`)[0]!.id;
 await assert.rejects(db`INSERT INTO notification_email_outbox(event_id,user_id,page_id) VALUES(${event},${f.actors.foreign!.id},${randomUUID()})`,/EMAIL_CURRENT_RECIPIENT_REQUIRED/);
 await assert.rejects(db`INSERT INTO notification_email_outbox(event_id,user_id,page_id) VALUES(${event},${f.actors.manager!.id},${rows[0]!.page_id})`,/EMAIL_FRESH_OUTBOX_PAGE_REQUIRED/);
 assert.equal((await db`SELECT count(*)::int n FROM notification_email_outbox WHERE event_id=${event}`)[0]!.n,0);
 await f.opt('manager',2,false);await f.opt('manager',3,true);await f.drain();
 assert.equal((await db`SELECT count(*)::int n FROM notification_email_outbox WHERE event_id=${event} AND user_id=${f.actors.manager!.id}`)[0]!.n,0);
 assert.equal(f.sends(),0);
});

test('SMTP dispatch commits exactly one attempt before the adapter and retains provider acceptance and ambiguity without replay',async t=>{
 const f=await setup(t),{db,api}=f;
 await f.channel();
 await f.opt();
 const acceptedLead=await f.create();
 const uncertainLead=await f.create();
 await f.drain();
 await f.opt('manager',1,true,'fr');
 const setWording=await api('PUT','/api/notification-email/templates/LEAD_CREATED/BRANCH/'+f.b+'/fr',{
  version:0,active:true,title:'Alerte {{campaign}}',body:'Vérifiez {{owner}}',reason:'Synthetic Email dispatch wording',
 });
 assert.equal(setWording.statusCode,200,setWording.body);
 const jobs=await db`SELECT o.id,e.lead_id FROM notification_email_outbox o JOIN notification_event e ON e.id=o.event_id
  JOIN notification_email_dispatch d ON d.outbox_id=o.id ORDER BY d.run_at,d.outbox_id`;
 assert.deepEqual(jobs.map(j=>j.lead_id),[acceptedLead,uncertainLead]);
 const first=jobs[0]!.id,second=jobs[1]!.id;
 await assert.rejects(db`UPDATE notification_email_dispatch SET state='SENDING' WHERE outbox_id=${first}`,/EMAIL_DISPATCH_TRANSITION_INVALID/);
 await assert.rejects(db`INSERT INTO notification_email_attempt(outbox_id) VALUES(${first})`,/EMAIL_COMMITTED_DISPATCH_REQUIRED/);
 let calls=0;
 const adapter:Parameters<typeof processOneNotificationEmail>[1]=async(settings,password,message)=>{
  const id=++calls===1?first:second;
  const [attempt]=await db`SELECT a.language,a.template_version,a.template_scope,d.state FROM notification_email_attempt a
    JOIN notification_email_dispatch d USING(outbox_id) WHERE a.outbox_id=${id}`;
  assert.deepEqual({...attempt},{language:'fr',template_version:1,template_scope:'BRANCH',state:'SENDING'});
  assert.equal(settings.fromAddress,'notices@example.test');
  assert.equal(password,'SyntheticEmail_NotReal');
  assert.equal(message.to,'manager@outbox.example.test');
  assert.match(message.subject,/^Alerte Synthetic/);
  assert.doesNotMatch(message.text,/Synthetic queued Lead|SyntheticEmail_NotReal/);
  assert.equal(await processOneNotificationEmail(db,async()=>assert.fail('Concurrent same-connection attempt')),false);
  if(id===second)throw Error('Synthetic lost SMTP acknowledgement');
 };
 assert.equal(await processOneNotificationEmail(db,adapter),true);
 assert.equal(await processOneNotificationEmail(db,adapter),true);
 assert.equal(await processOneNotificationEmail(db,adapter),false);
 assert.equal(calls,2);
 const [accepted,unknown]=await Promise.all([first,second].map(async id=>(await db`SELECT state,version FROM notification_email_dispatch WHERE outbox_id=${id}`)[0]!));
 assert.equal(accepted!.state,'ACCEPTED');
 assert.equal(unknown!.state,'UNKNOWN');
 assert.equal((await api('POST','/api/notification-email/deliveries/'+second+'/retry',{version:unknown!.version})).statusCode,409);
 assert.equal((await api('POST','/api/notification-email/deliveries/'+second+'/retry',{version:unknown!.version},'other')).statusCode,404);
 await assert.rejects(db`UPDATE notification_email_dispatch SET state='WAITING' WHERE outbox_id=${second}`,/EMAIL_DISPATCH_TRANSITION_INVALID/);
 await assert.rejects(db`DELETE FROM notification_email_attempt WHERE outbox_id=${second}`,/EMAIL_ATTEMPT_IMMUTABLE/);
 const feed=(await api('GET','/api/notification-email/deliveries')).json();
 assert.equal(feed.items.length,2);
 assert.deepEqual(feed.items.find((x:{id:string})=>x.id===second).history.map((x:{state:string})=>x.state),['UNKNOWN','SENDING']);
 assert.doesNotMatch(JSON.stringify(feed),/manager@|SyntheticEmail_NotReal|lost SMTP/);
});

test('SMTP dispatch suppresses a recipient whose opt-in was revoked after preparation',async t=>{
 const f=await setup(t);
 await f.channel();
 await f.opt();
 await f.create();
 await f.drain();
 await f.opt('manager',1,false);
 assert.equal(await processOneNotificationEmail(f.db,async()=>assert.fail('Revoked email escaped')),true);
 assert.equal((await f.db`SELECT state FROM notification_email_dispatch`)[0]!.state,'SUPPRESSED');
 assert.equal((await f.db`SELECT count(*)::int AS count FROM notification_email_attempt`)[0]!.count,0);
});

test('Email preparation stops after bounded failures and only scoped current sessions recover unsent work',async t=>{
 const f=await setup(t),{db,api}=f;
 await f.channel();
 await f.opt();
 await f.create();
 await f.drain();
 const [delivery]=await db`SELECT outbox_id FROM notification_email_dispatch`;
 const later=await f.create();
 const [event]=await db`SELECT id FROM notification_event WHERE lead_id=${later} AND event_type='LEAD_CREATED'`;
 await db`CREATE FUNCTION test_email_retry_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.action='EMAIL_NOTIFICATION_AUDIENCE_PREPARED' AND EXISTS (
   SELECT 1 FROM notification_event e WHERE e.id::text=NEW.detail->>'eventId' AND e.event_type='LEAD_CREATED'
  ) THEN RAISE EXCEPTION 'Synthetic email page unavailable'; END IF;
  RETURN NEW; END $$`;
 await db`CREATE TRIGGER test_email_retry_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_email_retry_audit_failure()`;
 const validKey=process.env.CREDENTIAL_ENCRYPTION_KEY;
 process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const noSend=async()=>assert.fail('Preparation failure started SMTP');
 try{
  for(let failure=1;failure<=5;failure++){
   assert.equal(await processOneEmailPublication(db),true);
   assert.equal(await processOneNotificationEmail(db,noSend),true);
   if(failure===1)assert.equal(await processOneEmailPublication(db),true); // The distinct assignment event can finish during backoff.
   const [page]=await db`SELECT max(failures) AS failures FROM notification_email_page_retry WHERE event_id=${event!.id}`;
   assert.equal(page!.failures,failure);
   if(failure<5)await db`SELECT pg_sleep(${2**(failure-1)+0.05})`;
  }
  assert.equal(await processOneEmailPublication(db),false);
  assert.equal(await processOneNotificationEmail(db,noSend),false);
 }finally{
  process.env.CREDENTIAL_ENCRYPTION_KEY=validKey;
  await db`DROP TRIGGER test_email_retry_audit_failure ON audit_log`;
  await db`DROP FUNCTION test_email_retry_audit_failure()`;
 }
 const [job]=await db`SELECT state,failures,version FROM notification_email_dispatch WHERE outbox_id=${delivery!.outbox_id}`;
 assert.equal(job!.state,'DEAD_LETTER');
 assert.equal(job!.failures,5);
 assert.equal((await db`SELECT count(*)::int n FROM notification_email_attempt`)[0]!.n,0);
 const pages=(await api('GET','/api/notification-email/page-failures')).json().items;
 assert.equal(pages.length,1);
 assert.equal(pages[0].id,event!.id);
 assert.equal((await api('GET','/api/notification-email/page-failures',undefined,'agent')).statusCode,403);
 assert.deepEqual((await api('GET','/api/notification-email/page-failures',undefined,'other')).json().items,[]);
 const pageRetry='/api/notification-email/page-failures/'+event!.id+'/retry';
 assert.equal((await api('POST',pageRetry,{version:pages[0].version},'other')).statusCode,404);
 const requests=await Promise.all([api('POST',pageRetry,{version:pages[0].version}),api('POST',pageRetry,{version:pages[0].version})]);
 assert.deepEqual(requests.map(r=>r.statusCode).sort(),[200,409]);
 const retry='/api/notification-email/deliveries/'+delivery!.outbox_id+'/retry';
 assert.equal((await api('POST',retry,{version:job!.version-1})).statusCode,409);
 assert.equal((await api('POST',retry,{version:job!.version})).statusCode,200);
 assert.equal((await api('POST',retry,{version:job!.version})).statusCode,409);
 assert.equal(await f.drain(),1);
 let calls=0;
 while(await processOneNotificationEmail(db,async()=>{calls++;})){}
 assert.equal(calls,2);
 assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='EMAIL_NOTIFICATION_PAGE_RETRIED'`)[0]!.n,1);
});

test('Email audience preparation is bounded, concurrent and atomic with Audit, preserves current opt-in and suppresses a revoked binding without replay',async t=>{
 const f=await setup(t),{db}=f;await f.channel();await f.opt();
 for(let n=0;n<55;n++){const name='extra'+n;await f.actor(name);await f.opt(name);}
 const lead=await f.create(),eid=(await db`SELECT id FROM notification_event WHERE lead_id=${lead} AND event_type='LEAD_CREATED'`)[0]!.id;
 await db`CREATE FUNCTION test_email_page_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='EMAIL_NOTIFICATION_AUDIENCE_PREPARED' THEN RAISE EXCEPTION 'SyntheticPrivateAuditFailure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER test_email_page_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_email_page_audit_failure()`;
 try{assert.equal(await processOneEmailPublication(db),true);assert.equal((await db`SELECT count(*)::int n FROM notification_email_outbox`)[0]!.n,0);assert.equal((await db`SELECT version FROM notification_email_publication WHERE event_id=${eid}`)[0]!.version,1);
  assert.equal((await db`SELECT failures FROM notification_email_page_retry WHERE event_id=${eid}`)[0]!.failures,1);}
 finally{await db`DROP TRIGGER test_email_page_audit_failure ON audit_log`;await db`DROP FUNCTION test_email_page_audit_failure()`;}
 await db`SELECT pg_sleep(1.05)`;
 await Promise.all(Array.from({length:8},()=>processOneEmailPublication(db)));await f.drain();
 const j=(await db`SELECT * FROM notification_email_publication WHERE event_id=${eid}`)[0]!;
 assert.equal(j.state,'DONE');assert.equal(j.scanned,56);assert.equal(j.enqueued,56);assert.equal(j.version,4);
 const pages=await db`SELECT scanned,enqueued FROM notification_email_materialization WHERE event_id=${eid} ORDER BY version`;
 assert.deepEqual(pages.map(x=>x.scanned),[25,25,6]);assert.deepEqual(pages.map(x=>x.enqueued),[25,25,6]);assert.equal((await db`SELECT count(DISTINCT user_id)::int n FROM notification_email_outbox WHERE event_id=${eid}`)[0]!.n,56);
 const later=await f.create();const binding=(await f.api('GET','/api/notification-email/branches/'+f.b)).json();
 assert.equal((await f.api('PUT','/api/notification-email/branches/'+f.b,{version:binding.version,enabled:false,connectionId:binding.connectionId,reason:'Revoke queued audience activation'})).statusCode,200);
 await f.drain();assert.ok((await db`SELECT state FROM notification_email_publication j JOIN notification_event e ON e.id=j.event_id WHERE e.lead_id=${later}`).every(x=>x.state==='SUPPRESSED'));
 assert.equal((await db`SELECT count(*)::int n FROM notification_email_outbox o JOIN notification_event e ON e.id=o.event_id WHERE e.lead_id=${later}`)[0]!.n,0);assert.equal(f.sends(),0);
});

test('Email queue rechecks a disabled recipient after a real Lead lock wait; personal keyset pages and failed current sessions cannot expose another recipient',async t=>{
 const f=await setup(t),{db,api}=f;await f.channel();await f.opt('agent');const lead=await f.create();
 let release!:()=>void,ready!:()=>void;const held=new Promise<void>(r=>{ready=r;}),gate=new Promise<void>(r=>{release=r;});
 const holder=db.begin(async tx=>{await tx`SELECT id FROM lead WHERE id=${lead} FOR UPDATE`;ready();await gate;});await held;
 const pending=processOneEmailPublication(db);
 try{
  let waited=false;for(let n=0;n<100;n++){if((await db`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO notification_email_materialization%'`).length){waited=true;break;}await new Promise(r=>setTimeout(r,10));}
  assert.ok(waited,'Worker must actually wait for the Lead lock');await db`UPDATE user_account SET active=false WHERE id=${f.actors.agent!.id}`;
 }finally{release();await holder;}
 assert.equal(await pending,true);await f.drain();assert.equal((await db`SELECT count(*)::int n FROM notification_email_outbox`)[0]!.n,0);
 await f.opt();for(let n=0;n<23;n++)await f.create();await f.drain();
 const first=(await api('GET','/api/notification-email/deliveries')).json();assert.equal(first.items.length,20);assert.ok(first.nextCursor);
 const second=(await api('GET','/api/notification-email/deliveries?cursor='+encodeURIComponent(first.nextCursor))).json();assert.equal(second.items.length,3);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,23);
 assert.equal((await api('GET','/api/notification-email/deliveries',undefined,'other')).json().items.length,0);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${f.actors.manager!.sid}`;
 assert.equal((await api('GET','/api/notification-email/deliveries')).statusCode,401);assert.equal(f.sends(),0);
});
