import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {sealSecret} from '../src/credentials.js';
import {processOneMessagingJob} from '../src/messaging/send-worker.js';
import {ProviderSendError} from '../src/messaging/providers.js';
import {processOneConversationAttentionNotification as processOne} from '../src/conversation-attention-notifications.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
async function fixture(){
 process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Attention notifications') RETURNING id`)[0]!.id,foreign=(await db`INSERT INTO organization(name) VALUES('Foreign attention') RETURNING id`)[0]!.id,
  branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id,
  campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status,messaging_config) VALUES(${org},${branch},'Attention <img literal>','ACTIVE','{"enabled":true}') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,bid,oid] of [['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['second','AGENT',branch,org],['other','MANAGER',other,org],['foreign','SUPER_ADMIN',null,foreign]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${oid},${bid},${role},${name},${name+'@attention.test'},'synthetic') RETURNING id`)[0]!.id,
   token=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={id,session,cookie:'lop_session='+token};
 }
 const connection=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config) VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic','CONNECTED','{"wabaId":"123456789","graphVersion":"v25.0"}') RETURNING id`)[0]!.id,
  secret=sealSecret(connection,JSON.stringify({accessToken:'SyntheticAttentionOnly',appSecret:'SyntheticOnly',verifyToken:'SyntheticVerify'}));
 await db`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag) VALUES(${connection},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
 const sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities) VALUES(${org},${connection},'15550001111','Synthetic sender','HEALTHY',true,'{"text":true}') RETURNING id`)[0]!.id;
 await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
 const contact=(await db`INSERT INTO contact(organization_id,name,phone,phone_normalized) VALUES(${org},'Synthetic customer','+15550002222','+15550002222') RETURNING id`)[0]!.id;
 await db`INSERT INTO messaging_consent(contact_id,channel,status,source) VALUES(${contact},'WHATSAPP','GRANTED','SYNTHETIC')`;
 const lead=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,assigned_agent_id,source_kind) VALUES(${org},${branch},${campaign},${contact},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id,
  cv=(await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state) VALUES(${lead},${connection},${sender},'WHATSAPP','+15550002222','HUMAN',${users.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
 await db`INSERT INTO conversation_message(conversation_id,connection_id,sender_id,direction,author_type,body,provider_message_id,delivery_state,received_at) VALUES(${cv},${connection},${sender},'INBOUND','CUSTOMER','Synthetic question','wamid.attention-window','RECEIVED',now()-interval '1 second')`;
 const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,who='manager')=>app.inject({method,url:path,payload:body,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}});
 let calls=0;
 const unknown=async()=>{const r=await api('POST',`/api/conversations/${cv}/messages`,{body:'Synthetic outbound',idempotencyKey:randomUUID()},'agent');assert.equal(r.statusCode,202,r.body);
  assert.equal(await processOneMessagingJob(db,{sendText:async()=>{calls++;throw new ProviderSendError('UNKNOWN','SEND_OUTCOME_UNKNOWN');}}),true);return r.json().id as string;};
 const feed=async(who='manager')=>{const r=await api('GET','/api/notifications?language=en&limit=50',undefined,who);assert.equal(r.statusCode,200,r.body);return r.json().items.filter((n:any)=>n.eventType==='CONVERSATION_NEEDS_ATTENTION') as {id:string;attention:{id:string;reasonCode:string;currentlyNeedsAttention:boolean};title:string;body:string}[];};
 const status=async(who='manager')=>{const r=await api('GET',`/api/conversations/${cv}/notification-delivery`,undefined,who);assert.equal(r.statusCode,200,r.body);return r.json();};
 return {db,app,org,branch,campaign,users,lead,cv,api,unknown,feed,status,calls:()=>calls,close:async()=>{await app.close();await db.end();}};
}
test('Conversation attention notifications observe actual UNKNOWN, preserve immutable occurrences/current status, scopes, preferences and wording without acknowledging or resending',async t=>{
 const f=await fixture();t.after(f.close);const {db,api,cv,lead,users,branch}=f,message=await f.unknown();
 assert.equal((await f.feed()).length,0);const pending=(await f.status()).items[0];assert.equal(pending.state,'QUEUED');
 const work=await Promise.all(Array.from({length:8},()=>processOne(db)));assert.equal(work.filter(Boolean).length,1);assert.equal(await processOne(db),false);
 const notice=(await f.feed())[0]!;assert.equal(notice.attention.reasonCode,'SEND_OUTCOME_UNKNOWN');assert.equal(notice.attention.currentlyNeedsAttention,true);
 assert.equal((await f.feed('agent')).length,1);
 for(const who of ['second','other','foreign']){
  assert.equal((await f.feed(who)).length,0);assert.equal((await api('GET',`/api/conversations/${cv}/notification-delivery`,undefined,who)).statusCode,404);
  assert.equal((await api('PUT','/api/notifications/'+notice.id+'/state',{version:0,isRead:true},who)).statusCode,404);
 }
 const reads=await Promise.all(Array.from({length:8},()=>api('PUT','/api/notifications/'+notice.id+'/state',{version:0,isRead:true},'agent')));
 assert.equal(reads.filter(r=>r.statusCode===200).length,1);assert.equal(reads.filter(r=>r.statusCode===409).length,7);assert.equal((await api('GET','/api/notifications/'+notice.id+'/history',undefined,'agent')).json().items.length,1);
 const pref='/api/notification-preferences/CONVERSATION_NEEDS_ATTENTION';assert.equal((await api('PUT',pref,{version:0,enabled:false},'agent')).statusCode,200);assert.equal((await f.feed('agent')).length,0);assert.equal((await f.feed()).length,1);
 assert.equal((await api('PUT',pref,{version:1,enabled:true},'agent')).statusCode,200);
 const wording='/api/notification-templates/CONVERSATION_NEEDS_ATTENTION/BRANCH/'+branch+'/en',body={version:0,title:'Review {{campaign}}',body:'Owner {{owner}} <img literal>',active:true,reason:'Approved operational wording'};
 assert.equal((await api('PUT',wording,body,'agent')).statusCode,403);assert.equal((await api('PUT',wording,body,'other')).statusCode,404);assert.equal((await api('PUT',wording,body)).statusCode,200);assert.equal((await api('GET',wording+'/history')).json().items.length,1);
 assert.match((await f.feed())[0]!.title,/Review Attention/);
 assert.equal((await db`SELECT needs_attention_reason FROM conversation WHERE id=${cv}`)[0]!.needs_attention_reason,'SEND_OUTCOME_UNKNOWN');assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${message}`)[0]!.delivery_state,'UNKNOWN');assert.equal(f.calls(),1);
 await Promise.all(Array.from({length:8},()=>db`UPDATE conversation SET needs_attention_reason=needs_attention_reason WHERE id=${cv}`));assert.equal((await f.status()).items.length,1);
 const ack=await api('POST',`/api/conversations/${cv}/attention/acknowledge`,{version:1,expectedReason:'SEND_OUTCOME_UNKNOWN',reviewNote:'Reviewed the synthetic provider outcome',reviewConfirmed:true});assert.equal(ack.statusCode,200,ack.body);
 assert.equal((await f.feed())[0]!.attention.currentlyNeedsAttention,false);assert.equal((await f.status()).items[0].state,'CLEARED');assert.equal(f.calls(),1);
 await db`UPDATE conversation SET needs_attention_reason='SEND_OUTCOME_UNKNOWN' WHERE id=${cv}`;assert.equal(await processOne(db),true);
 const repeated=await f.feed();assert.equal(repeated.length,2);assert.equal(repeated.filter(n=>n.attention.currentlyNeedsAttention).length,1);assert.equal(repeated.find(n=>n.id===notice.id)!.attention.currentlyNeedsAttention,false);
 const unsafe='NeverExposeProviderSecret <script>leak</script>';await db`UPDATE conversation SET needs_attention_reason=${unsafe} WHERE id=${cv}`;assert.equal(await processOne(db),true);
 assert.equal((await f.feed())[0]!.attention.reasonCode,'REVIEW_REQUIRED');assert.equal(JSON.stringify(await f.status()).includes(unsafe),false);
 assert.equal(JSON.stringify(await f.feed()).includes('reason_hash'),false);assert.equal((await db`SELECT count(*)::int AS n FROM conversation_attention_transition WHERE reason_code=${unsafe}`)[0]!.n,0);
 const page=(await api('GET',`/api/conversations/${cv}/notification-delivery?limit=1`)).json();assert.equal(page.items.length,1);assert.ok(page.nextCursor);
 assert.notEqual((await api('GET',`/api/conversations/${cv}/notification-delivery?limit=1&cursor=`+encodeURIComponent(page.nextCursor))).json().items[0].id,page.items[0].id);
 await assert.rejects(db`INSERT INTO conversation_attention_transition(conversation_id) VALUES(${cv})`,/FRESH_TRANSITION_REQUIRED/);
 await assert.rejects(db`INSERT INTO notification_event(event_type,conversation_attention_id) VALUES('CONVERSATION_NEEDS_ATTENTION',${pending.id})`,/FRESH_OPERATION_REQUIRED/);
 await assert.rejects(db`UPDATE conversation_attention_transition SET reason_code='DELIVERY_FAILED' WHERE id=${pending.id}`,/IMMUTABLE/);
 await assert.rejects(db`DELETE FROM conversation_attention_transition WHERE id=${pending.id}`,/IMMUTABLE/);
 await assert.rejects(db`UPDATE conversation_attention_queue SET version=version+1,operation='PUBLISH' WHERE source_id=${pending.id}`,/NOT_READY/);
 await assert.rejects(db`UPDATE conversation_attention_queue_history SET snapshot='{}' WHERE source_id=${pending.id}`,/IMMUTABLE/);
 assert.equal((await api('POST','/api/leads/'+lead+'/assignment',{version:1,agentId:users.second!.id,reason:'Change attention owner'})).statusCode,200);
 assert.equal((await f.feed('agent')).length,0);assert.equal((await f.feed('second')).length,3);assert.equal((await api('GET','/api/notifications/'+notice.id+'/history',undefined,'agent')).statusCode,404);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;assert.equal((await api('GET',`/api/conversations/${cv}/notification-delivery`)).statusCode,401);
 assert.equal(f.calls(),1);assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${message}`)[0]!.delivery_state,'UNKNOWN');
});
test('Notification publication failure leaves actual UNKNOWN durable, bounds retries and allows only current authorized recovery with one eventual event',async t=>{
 const f=await fixture();t.after(f.close);const {db,api,cv,users}=f;
 await db`CREATE FUNCTION reject_attention_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='IN_APP_NOTIFICATION_RECORDED' AND NEW.detail->>'eventType'='CONVERSATION_NEEDS_ATTENTION' THEN RAISE EXCEPTION 'NeverExposeAttentionSecret';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_attention_audit_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_attention_audit_fixture()`;
 let source:string='';
 try{
  const message=await f.unknown();source=(await f.status()).items[0].id;
  for(let n=1;n<=5;n++){
   if(n>1)await delay(2**(n-2)*1000+40);assert.equal(await processOne(db),true);assert.equal((await f.status()).items[0].failureCount,n);assert.equal((await f.feed()).length,0);
   assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${message}`)[0]!.delivery_state,'UNKNOWN');
  }
 }finally{await db`DROP TRIGGER reject_attention_audit_fixture ON audit_log`;await db`DROP FUNCTION reject_attention_audit_fixture()`;}
 const row=(await f.status()).items[0];assert.equal(row.state,'DEAD_LETTER');assert.equal(row.nextRunAt,null);assert.equal(await processOne(db),false);assert.equal(f.calls(),1);
 const root=`/api/conversations/${cv}/notification-delivery/${source}`;
 assert.equal((await api('GET',root+'/history')).json().items.length,6);
 assert.equal((await api('POST',root+'/retry',{version:row.version},'agent')).statusCode,403);
 for(const who of ['other','foreign'])assert.equal((await api('POST',root+'/retry',{version:row.version},who)).statusCode,404);
 await assert.rejects(db`UPDATE conversation_attention_queue SET version=version+1,operation='RETRY',actor_id=${users.agent!.id},session_id=${users.agent!.session} WHERE source_id=${source}`,/RETRY_DENIED/);
 const races=await Promise.all(Array.from({length:8},()=>api('POST',root+'/retry',{version:row.version})));assert.equal(races.filter(r=>r.statusCode===200).length,1);assert.equal(races.filter(r=>r.statusCode===409).length,7);
 const child=spawn(process.execPath,[fileURLToPath(new URL('../src/notification-worker.js',import.meta.url))],{env:{...process.env,DATABASE_URL:url,NOTIFICATION_WORKER_POLL_MS:'250',NOTIFICATION_WORKER_BATCH:'1'},stdio:['ignore','pipe','pipe']});
 const stopped=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});let log='';child.stdout.on('data',b=>{log+=String(b);});child.stderr.on('data',b=>{log+=String(b);});
 try{for(let n=0;n<80&&(await f.status()).items[0].state!=='RECORDED';n++)await delay(100);assert.equal((await f.status()).items[0].state,'RECORDED',log);}finally{child.kill();await stopped;}
 assert.equal((await f.feed()).length,1);assert.equal(f.calls(),1);assert.equal(await processOne(db),false);
 assert.equal((await api('POST',root+'/retry',{version:(await f.status()).items[0].version})).statusCode,409);
 assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='CONVERSATION_NOTIFICATION_RETRY'`)[0]!.n,1);
});
test('Capturing attention under a Conversation lock does not wait on the Lead lock held by actual concurrent reassignment',async t=>{
 const f=await fixture();t.after(f.close);const {db,api,cv,lead,users}=f;let release!:()=>void,ready!:()=>void;
 let conversationLocker=0;
 const gate=new Promise<void>(r=>{release=r;}),held=new Promise<void>(r=>{ready=r;});
 const writer=db.begin(async tx=>{
  await tx`SET LOCAL statement_timeout='5s'`;
  await tx`SELECT id FROM conversation WHERE id=${cv} FOR UPDATE`;
  conversationLocker=(await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid;
  ready();await gate;
  await tx`UPDATE conversation SET needs_attention_reason='DELIVERY_FAILED' WHERE id=${cv}`;
 });await held;
 const assignment=api('POST','/api/leads/'+lead+'/assignment',{version:1,agentId:users.second!.id,reason:'Actual lock-order race'});
 try{
  let waiting=false;
  for(let n=0;n<80&&!waiting;n++){
   waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
    AND wait_event_type='Lock' AND ${conversationLocker}=ANY(pg_blocking_pids(pid))) AS ok`)[0]!.ok;
   if(!waiting)await delay(25);
  }
  assert.equal(waiting,true,'Assignment must wait for the actual Conversation lock');
  await assert.rejects(db`SELECT id FROM lead WHERE id=${lead} FOR UPDATE NOWAIT`,{code:'55P03'});
 }finally{release();await writer;}
 const response=await assignment;assert.equal(response.statusCode,200,response.body);assert.equal(await processOne(db),true);
 assert.equal((await f.feed('agent')).length,0);const notices=await f.feed('second');assert.equal(notices.length,1);assert.equal(notices[0]!.attention.currentlyNeedsAttention,false);
 assert.equal((await f.status()).items.filter((s:any)=>s.state==='CLEARED').length,1);assert.equal(f.calls(),0);
 // A durable source cannot publish across a later Campaign scope change, even though the Conversation still exists.
 await db`UPDATE conversation SET needs_attention_reason='PARTICIPANT_CHANGED' WHERE id=${cv}`;
 const source=(await db`SELECT id FROM conversation_attention_transition WHERE conversation_id=${cv} ORDER BY ordinal DESC LIMIT 1`)[0]!.id;
 const replacement=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES(${f.org},${f.branch},'Changed scope') RETURNING id`)[0]!.id;
 await db`UPDATE lead SET campaign_id=${replacement} WHERE id=${lead}`;
 assert.equal(await processOne(db),true);assert.equal((await db`SELECT state FROM conversation_attention_queue WHERE source_id=${source}`)[0]!.state,'STALE_SCOPE');
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_event WHERE conversation_attention_id=${source}`)[0]!.n,0);
 assert.equal((await api('GET',`/api/conversations/${cv}/notification-delivery/${source}/history`)).statusCode,404);
});
