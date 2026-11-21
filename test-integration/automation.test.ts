import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {processOneAutomationMatch,processOneAutomationExecution} from '../src/automation.js';
import {processOneFollowUpNotification} from '../src/follow-up-notifications.js';
import {processOneInboundEvent} from '../src/messaging/inbound-events.js';
import {sealSecret} from '../src/credentials.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
async function fixture(t:TestContext){
 process.env.APP_ORIGIN='http://127.0.0.1:5173';const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
 t.after(async()=>{await app.close();await db.end();});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Automation test') RETURNING id`)[0]!.id,
  foreign=(await db`INSERT INTO organization(name) VALUES('Other organization') RETURNING id`)[0]!.id,
  branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Automation branch') RETURNING id`)[0]!.id,
  other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Other branch') RETURNING id`)[0]!.id,
  campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status,routing_method) VALUES(${org},${branch},'Automation campaign','ACTIVE','ROUND_ROBIN') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,bid,oid] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['second','AGENT',branch,org],['other','MANAGER',other,org],['foreign','SUPER_ADMIN',null,foreign]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${oid},${bid},${role},${name},${name+'@automation.test'},'synthetic') RETURNING id`)[0]!.id,
   token=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
  users[name]={id,session,cookie:'lop_session='+token};
 }
 await db`INSERT INTO campaign_agent(campaign_id,agent_id) VALUES(${campaign},${users.agent!.id})`;
 const api=(method:'GET'|'POST'|'PUT'|'PATCH',path:string,body?:object,who='manager')=>app.inject({method,url:path,payload:body,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}});
 let count=0;const create=async()=>{const r=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Automation contact',phone:'+1555400'+String(++count).padStart(4,'0')}});assert.equal(r.statusCode,201,r.body);return r.json().id as string;};
 const def={name:'Approved task <img src=x onerror=alert(1)>',enabled:true,triggerType:'LEAD_CREATED',lifecycle:'OPEN',ownerCondition:'ASSIGNED',actionType:'CREATE_FOLLOW_UP',delayMinutes:60,priority:'HIGH',note:'Synthetic internal task',reason:'Approve synthetic rule'};
 const rule=async(input:object={},who='manager')=>{const r=await api('POST','/api/automations',{...def,branchId:branch,campaignId:campaign,...input},who);assert.equal(r.statusCode,201,r.body);return r.json().id as string;};
 async function matches(){for(let i=0;i<200&&await processOneAutomationMatch(db);i++);}
 async function execute(){for(let i=0;i<200&&await processOneAutomationExecution(db);i++);}
 return {db,app,org,branch,other,campaign,users,api,def,rule,create,matches,execute};
}

test('A permitted conversation state transition admits one scoped rule and preserves its original states',async t=>{
 const {db,org,branch,api,rule,create,matches,execute}=await fixture(t);
 const lead=await create();
 const connection=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name)
  VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic conversation source') RETURNING id`)[0]!.id;
 const sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,capabilities)
  VALUES(${org},${connection},'15550001234','Synthetic conversation sender','{"text":true}') RETURNING id`)[0]!.id;
 const conversation=(await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,
  controller_type,state,needs_attention_reason)
  VALUES(${lead},${connection},${sender},'WHATSAPP','+15554000001','NONE','WAITING_FOR_HUMAN','NO_HUMAN_CONTROLLER') RETURNING id`)[0]!.id;
 const ruleId=await rule({name:'Respond to conversation state change',triggerType:'CONVERSATION_STATE_CHANGED'});
 const path='/api/conversations/'+conversation+'/takeover';
 const takeover=(version:number,actor='agent')=>api('POST',path,{version,reason:'Take over synthetic conversation'},actor);
 assert.equal((await takeover(1,'other')).statusCode,404);
 assert.equal((await db`SELECT id FROM automation_conversation_change`).length,0);
 const attempts=await Promise.all([takeover(1),takeover(1)]);
 assert.deepEqual(attempts.map(r=>r.statusCode).sort(),[200,409]);
 assert.equal((await takeover(2)).json().existing,true);
 await db`UPDATE conversation SET state=state WHERE id=${conversation}`;
 const sources=await db`SELECT s.id,c.from_state,c.to_state,s.lead_id,s.branch_id,s.notification_event_id
  FROM automation_source s JOIN automation_conversation_change c ON c.id=s.conversation_change_id
  WHERE c.conversation_id=${conversation}`;
 assert.equal(sources.length,1);
 const source=sources[0]!;
 assert.equal(source.from_state,'WAITING_FOR_HUMAN');
 assert.equal(source.to_state,'HUMAN_ACTIVE');
 assert.equal(source.lead_id,lead);
 assert.equal(source.branch_id,branch);
 assert.equal(source.notification_event_id,null);
 await assert.rejects(db`INSERT INTO automation_conversation_change(conversation_id,from_state,to_state)
  VALUES(${conversation},'WAITING_FOR_HUMAN','HUMAN_ACTIVE')`,/AUTOMATION_CONVERSATION_TRANSITION_REQUIRED/);
 await assert.rejects(db`UPDATE automation_conversation_change SET from_state='CLOSED' WHERE id=${source.id}`,
  /AUTOMATION_CONVERSATION_CHANGE_IMMUTABLE/);
 await matches();
 await execute();
 const [outcome]=await db`SELECT id,state FROM automation_execution WHERE source_id=${source.id} AND rule_id=${ruleId}`;
 assert.equal(outcome?.state,'SUCCEEDED');
 assert.equal((await db`SELECT id FROM follow_up WHERE automation_execution_id=${outcome!.id}`).length,1);
 assert.equal((await api('GET','/api/automation/sources/'+source.id+'/history',undefined,'other')).statusCode,404);
});

test('Only a freshly attached authenticated customer message admits a scoped Message Received rule',async t=>{
 const {db,app,org,branch,campaign,users,api,rule,create,matches,execute}=await fixture(t);
 process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const lead=await create();
 const connection=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config)
  VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic automation source','CONNECTED',
   '{"graphVersion":"v25.0","wabaId":"123456789"}') RETURNING id`)[0]!.id;
 const secret=sealSecret(connection,JSON.stringify({accessToken:'synthetic-token',appSecret:'synthetic-signature-key',verifyToken:'synthetic-verification'}));
 await db`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag)
  VALUES(${connection},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
 const sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
  VALUES(${org},${connection},'15550001111','Synthetic sender','HEALTHY',true,'{"text":true}') RETURNING id`)[0]!.id;
 await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
 const conversation=(await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
  VALUES(${lead},${connection},${sender},'WHATSAPP','+15554000001','HUMAN',${users.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
 const approved=await rule({name:'Receive customer reply',triggerType:'MESSAGE_RECEIVED'});
 const body='Synthetic message text must remain in the conversation';
 const message={id:'wamid.autoreceived.'+randomUUID(),from:'15554000001',type:'text',text:{body},timestamp:String(Math.floor(Date.now()/1000))};
 const post=(candidate:typeof message,key='synthetic-signature-key')=>{
  const payload=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'123456789',changes:[{field:'messages',value:{
   messaging_product:'whatsapp',metadata:{phone_number_id:'15550001111'},messages:[candidate],
  }}]}]});
  return app.inject({method:'POST',url:'/api/webhooks/messaging/meta/'+connection,payload,headers:{
   'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',key).update(payload).digest('hex'),
  }});
 };
 const sources=()=>db`SELECT * FROM automation_source WHERE trigger_type='MESSAGE_RECEIVED'`;
 assert.equal((await post(message,'wrong-key')).statusCode,403);
 assert.equal((await post(message)).json().created,1);
 assert.equal((await sources()).length,0,'a signature alone does not resolve the destination');
 assert.deepEqual((await Promise.all([processOneInboundEvent(db),processOneInboundEvent(db)])).sort(),[false,true]);
 assert.equal((await post(message)).json().created,0);
 const results=await sources();
 assert.equal(results.length,1);
 const source=results[0]!;
 const attached=(await db`SELECT id,source_event_id FROM conversation_message WHERE conversation_id=${conversation} AND provider_message_id=${message.id}`)[0]!;
 assert.equal(source.id,attached.source_event_id);
 assert.equal(source.inbound_message_id,attached.id);
 assert.equal(source.notification_event_id,null);
 assert.equal(source.lead_id,lead);
 assert.deepEqual(source.causal_rule_ids,[]);
 await assert.rejects(db`INSERT INTO automation_source(id,inbound_message_id) VALUES(${randomUUID()},${attached.id})`,/AUTOMATION_TRUSTED_SOURCE_REQUIRED/);
 const unrelated={...message,id:'wamid.unmatched.'+randomUUID(),from:'15559998888'};
 assert.equal((await post(unrelated)).json().created,1);
 assert.equal(await processOneInboundEvent(db),true);
 const unsigned={...message,id:'wamid.unsigned.'+randomUUID()};
 const event=(await db`INSERT INTO integration_event(connection_id,provider_event_id,event_kind,sender_id,participant_ref,payload)
  VALUES(${connection},${randomUUID()},'INBOUND_MESSAGE',${sender},'+15554000001',${db.json({senderExternalId:'15550001111',message:unsigned})}) RETURNING id`)[0]!.id;
 assert.equal(await processOneInboundEvent(db),true);
 assert.equal((await db`SELECT state FROM integration_event WHERE id=${event}`)[0]!.state,'PROCESSED');
 assert.equal((await sources()).length,1);
 await rule({name:'Future approval cannot match',triggerType:'MESSAGE_RECEIVED'});
 await matches();
 await execute();
 const applied=await db`SELECT id,rule_id,state FROM automation_execution WHERE source_id=${source.id}`;
 assert.equal(applied.length,1);
 assert.equal(applied[0]!.rule_id,approved);
 assert.equal(applied[0]!.state,'SUCCEEDED');
 assert.equal((await db`SELECT id FROM follow_up WHERE automation_execution_id=${applied[0]!.id} AND lead_id=${lead}`).length,1);
 const history='/api/automation/sources/'+source.id+'/history';
 for(const actor of ['other','foreign']) assert.equal((await api('GET',history,undefined,actor)).statusCode,404);
 assert.equal((await api('GET',history,undefined,'agent')).statusCode,403);
 const processing=await api('GET','/api/automation/sources?limit=50');
 assert.equal(processing.statusCode,200);
 assert.ok(processing.json().items.some((item:{id:string})=>item.id===source.id));
 assert.equal(processing.body.includes(body),false);
 assert.equal(processing.body.includes(message.id),false);
 assert.equal((await db`SELECT id FROM audit_log WHERE action='AUTOMATION_ACTION_APPLIED' AND detail->>'ruleId'=${approved}`).length,1);
});

test('Follow-up due automation preserves task causation and skips a repeated rule in the same chain',async t=>{
 const {db,api,rule,create,matches,execute}=await fixture(t);
 const origin=await rule({name:'Open the first follow-up',delayMinutes:0});
 const due=await rule({name:'Create one follow-up after the task is due',triggerType:'FOLLOW_UP_DUE',delayMinutes:0});
 const lead=await create();
 await matches();await execute();
 const rows=()=>db`SELECT e.id,e.rule_id,e.state,e.result_code,s.parent_execution_id,s.causal_rule_ids
  FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${lead} ORDER BY cardinality(s.causal_rule_ids)`;
 const initial=(await rows())[0]!;
 assert.equal(initial.rule_id,origin);
 assert.equal(await processOneFollowUpNotification(db),true);
 await matches();await execute();
 const firstDue=(await rows())[1]!;
 assert.equal(firstDue.rule_id,due);
 assert.equal(firstDue.state,'SUCCEEDED');
 assert.equal(firstDue.parent_execution_id,initial.id);
 assert.deepEqual(firstDue.causal_rule_ids,[origin]);

 assert.equal(await processOneFollowUpNotification(db),true);
 await matches();await execute();
 const final=await rows();
 assert.equal(final.length,3);
 const skipped=final[2]!;
 assert.equal(skipped.rule_id,due);
 assert.equal(skipped.state,'SKIPPED');
 assert.equal(skipped.result_code,'AUTOMATION_CAUSAL_REPEAT');
 assert.equal(skipped.parent_execution_id,firstDue.id);
 assert.deepEqual(skipped.causal_rule_ids,[origin,due]);
 assert.equal((await db`SELECT count(*)::int n FROM follow_up WHERE lead_id=${lead}`)[0]!.n,2);
 assert.equal(await processOneFollowUpNotification(db),false);
 assert.equal(await processOneAutomationMatch(db),false);
 assert.equal(await processOneAutomationExecution(db),false);
 const checked=await api('GET',`/api/automation/executions/${skipped.id}/history`);
 assert.equal(checked.statusCode,200,checked.body);
 assert.equal(checked.json().items[0].result_code,'AUTOMATION_CAUSAL_REPEAT');
 assert.equal((await api('GET',`/api/automation/executions/${skipped.id}/history`,undefined,'other')).statusCode,404);
});

test('Automation uses committed versioned approvals and trusted durable sources, scoped CAS and exactly-once typed internal effects',async t=>{
 const {db,org,branch,other,campaign,users,api,def,rule,create,matches,execute}=await fixture(t);
 for(const who of ['agent','other','foreign']){
  assert.equal((await api('POST','/api/automations',{...def,branchId:branch,campaignId:campaign},who)).statusCode,who==='agent'?403:404);
 }
 assert.equal((await api('POST','/api/automations',{...def,branchId:null,campaignId:null})).statusCode,404);
 assert.equal((await api('POST','/api/automations',{...def,branchId:branch,campaignId:campaign,sql:'DELETE FROM lead'})).statusCode,400);
 assert.equal((await api('POST','/api/automations',{...def,branchId:branch,campaignId:campaign,actionType:'CONFIRM_PAYMENT'})).statusCode,400);
 const r=await rule(),notice=await rule({name:'Internal attention',actionType:'SEND_IN_APP_NOTIFICATION',delayMinutes:0,priority:'NORMAL',note:'Plain <img src=x onerror=alert(1)> text'});
 const lead=await create();assert.equal((await db`SELECT count(*)::int AS n FROM follow_up`)[0]!.n,0);
 const future=await rule({name:'Do not backfill earlier sources'});
 await Promise.all(Array.from({length:8},()=>matches()));await Promise.all(Array.from({length:8},()=>execute()));
 const ex=await db`SELECT e.* FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${lead}`;
 assert.equal(ex.length,2);assert.ok(ex.every(e=>e.state==='SUCCEEDED'));assert.ok(ex.every(e=>e.rule_id!==future));
 const task=(await db`SELECT f.*,f.due_at=s.captured_at+interval '60 minutes' AS correct_due FROM follow_up f
  JOIN automation_execution e ON e.id=f.automation_execution_id JOIN automation_source s ON s.id=e.source_id WHERE f.lead_id=${lead}`)[0]!;
 assert.equal(task.kind,'AUTOMATION');assert.equal(task.created_by,null);assert.equal(task.owner_user_id,users.agent!.id);assert.equal(task.correct_due,true);assert.equal(task.priority,'HIGH');
 assert.equal((await db`SELECT actor_user_id,event_type FROM follow_up_history WHERE follow_up_id=${task.id}`)[0]!.event_type,'AUTOMATION_CREATED');
 const feed=(await api('GET','/api/notifications?language=en&limit=50',undefined,'agent')).json().items,alert=feed.find((n:any)=>n.eventType==='AUTOMATION_NOTICE');
 assert.equal(alert.automation.ruleId,notice);assert.match(alert.automation.note,/<img/);assert.equal(alert.automation.ruleVersion,1);
 assert.equal((await db`SELECT count(*)::int AS n FROM automation_source WHERE trigger_type='AUTOMATION_NOTICE'`)[0]!.n,0);
 assert.equal((await db`SELECT count(*)::int AS n FROM conversation`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int AS n FROM payment_record`)[0]!.n,0);
 const page=(await api('GET','/api/automations?limit=1')).json();assert.equal(page.items.length,1);assert.ok(page.nextCursor);
 assert.ok((await api('GET','/api/automations?limit=1&cursor='+encodeURIComponent(page.nextCursor))).json().items.every((x:any)=>x.id!==page.items[0].id));
 assert.equal((await api('GET','/api/automations',undefined,'agent')).statusCode,403);
 for(const who of ['other','foreign']){
  assert.equal((await api('GET','/api/automations',undefined,who)).json().items.length,0);
  assert.equal((await api('GET','/api/automations/'+r+'/history',undefined,who)).statusCode,404);
  assert.equal((await api('GET','/api/automation/executions/'+ex[0]!.id+'/history',undefined,who)).statusCode,404);
 }
 const h=(await api('GET','/api/automations/'+r+'/history')).json().items[0];assert.equal(h.version,1);assert.ok(!('session_id'in h.definition));assert.ok(!('approval_xid'in h.definition));
 const changes=await Promise.all(Array.from({length:8},()=>api('PUT','/api/automations/'+r,{...def,version:1,enabled:false,reason:'Explicitly stop pending rules'})));
 assert.equal(changes.filter(x=>x.statusCode===200).length,1);assert.equal(changes.filter(x=>x.statusCode===409).length,7);
 assert.equal((await api('GET','/api/automations/'+r+'/history')).json().items.length,2);
 const source=(await db`SELECT id FROM automation_source WHERE lead_id=${lead} AND trigger_type='LEAD_CREATED'`)[0]!.id;
 await assert.rejects(db`INSERT INTO automation_source(id) VALUES(${source})`,/TRUSTED_SOURCE/);
 await assert.rejects(db`UPDATE automation_source SET trigger_type='LEAD_ASSIGNED' WHERE id=${source}`,/IMMUTABLE/);
 await assert.rejects(db`INSERT INTO automation_execution(source_id,rule_id,rule_version) VALUES(${source},${r},1)`,/MATCHED_SOURCE/);
 await assert.rejects(db`UPDATE automation_execution SET version=version+1,operation='EXECUTE' WHERE id=${ex[0]!.id}`,/NOT_READY/);
 await assert.rejects(db`INSERT INTO follow_up(automation_execution_id) VALUES(${ex[0]!.id})`,/APPROVED_ACTION/);
 await assert.rejects(db`UPDATE follow_up SET automation_execution_id=NULL WHERE id=${task.id}`,/PROVENANCE/);
 await assert.rejects(db`INSERT INTO notification_event(event_type,automation_execution_id) VALUES('AUTOMATION_NOTICE',${ex[0]!.id})`,/APPROVED_ACTION/);
 await assert.rejects(db`UPDATE automation_rule_version SET snapshot='{}' WHERE rule_id=${r}`,/IMMUTABLE/);
 await assert.rejects(db`UPDATE automation_processing_history SET snapshot='{}' WHERE resource_id=${ex[0]!.id}`,/IMMUTABLE/);
 await assert.rejects(db`UPDATE automation_rule SET branch_id=${other},version=version+1 WHERE id=${r}`,/IDENTITY/);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
 assert.equal((await api('PUT','/api/automations/'+r,{...def,version:2})).statusCode,401);
 assert.equal((await api('GET','/api/automation/sources')).statusCode,401);
 // The original source is still immutable, distinct from a notification's read state.
 assert.equal((await db`SELECT organization_id FROM automation_source WHERE id=${source}`)[0]!.organization_id,org);
});

test('Automation evaluates current scope, owner, conditions and approver without borrowing an expired human session or replaying old rule versions',async t=>{
 const {db,org,branch,campaign,users,api,def,rule,create,matches,execute}=await fixture(t);
 const r=await rule();const lead=await create();await matches();
 await api('PUT','/api/automations/'+r,{...def,version:1,enabled:false});await execute();
 assert.equal((await db`SELECT result_code FROM automation_execution WHERE rule_id=${r}`)[0]!.result_code,'RULE_CHANGED');
 await api('PUT','/api/automations/'+r,{...def,version:2,enabled:true});
 const moved=await create();await matches();const assignment=await api('POST','/api/leads/'+moved+'/assignment',{version:1,agentId:users.second!.id});assert.equal(assignment.statusCode,200,assignment.body);
 // Logout is not deauthorization of a persisted approved rule; current account role/scope still apply.
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
 await execute();assert.equal((await db`SELECT owner_user_id FROM follow_up WHERE lead_id=${moved}`)[0]!.owner_user_id,users.second!.id);
 // Create further real manual intake through a separately authorized Super Admin.
 const fresh=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Authority revoked',phone:'+15554001234'}},'admin');assert.equal(fresh.statusCode,201,fresh.body);await matches();
 await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;await execute();
 assert.equal((await db`SELECT e.result_code FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${fresh.json().id} AND e.rule_id=${r}`)[0]!.result_code,'APPROVAL_REVOKED');
 assert.equal((await db`SELECT count(*)::int AS n FROM follow_up WHERE lead_id=${fresh.json().id}`)[0]!.n,0);
 const cond=await rule({ownerCondition:'UNASSIGNED'},'admin'),condLead=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Conditions',phone:'+15554001235'}},'admin');await matches();await execute();
 assert.equal((await db`SELECT e.result_code FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${condLead.json().id} AND e.rule_id=${cond}`)[0]!.result_code,'CONDITIONS_NOT_MET');
 // An approval started earlier but still uncommitted at capture is never retrospectively admitted.
 let release!:()=>void,ready!:()=>void;const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>ready=r);let invisibleRule='';
 const pending=db.begin(async tx=>{invisibleRule=(await tx`INSERT INTO automation_rule(organization_id,name,version,enabled,trigger_type,lifecycle,owner_condition,action_type,delay_minutes,priority,note,actor_id,session_id,reason)
  VALUES(${org},'Uncommitted global approval',1,true,'LEAD_CREATED','OPEN','ASSIGNED','CREATE_FOLLOW_UP',0,'NORMAL','Synthetic',${users.admin!.id},${users.admin!.session},'Synthetic pending approval') RETURNING id`)[0]!.id;ready();await wait;});
 await started;
 try{const before=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Before commit',phone:'+15554001236'}},'admin');assert.equal(before.statusCode,201,before.body);release();await pending;await matches();await execute();
  assert.equal((await db`SELECT count(*)::int AS n FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${before.json().id} AND e.rule_id=${invisibleRule}`)[0]!.n,0);
 }finally{release();await pending;}
 // Scope drift fences an already-admitted action, and its old source is not exposed through new-scope history.
 const scopeRule=await rule({},'admin'),last=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Changed scope',phone:'+15554001237'}},'admin');await matches();
 const e=(await db`SELECT e.id,e.source_id FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE e.rule_id=${scopeRule} AND s.lead_id=${last.json().id}`)[0]!;
 const newCampaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES(${org},${branch},'New scope','ACTIVE') RETURNING id`)[0]!.id;
 await db`UPDATE lead SET campaign_id=${newCampaign} WHERE id=${last.json().id}`;await execute();
 assert.equal((await db`SELECT result_code FROM automation_execution WHERE id=${e.id}`)[0]!.result_code,'SCOPE_CHANGED');
 assert.equal((await api('GET','/api/automation/executions/'+e.id+'/history',undefined,'admin')).statusCode,404);
 assert.equal((await db`SELECT count(*)::int AS n FROM follow_up WHERE lead_id=${last.json().id}`)[0]!.n,0);
});

test('Automation bounds database failures, rolls back partial actions, recovers with current scoped CAS and resumes through the compiled durable worker',async t=>{
 const {db,users,api,rule,create,matches}=await fixture(t);const r=await rule(),lead=await create();await matches();
 const e=(await db`SELECT e.id FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE e.rule_id=${r} AND s.lead_id=${lead}`)[0]!;
 await db`CREATE FUNCTION reject_automation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AUTOMATION_ACTION_APPLIED' THEN RAISE EXCEPTION 'SYNTHETIC_AUTOMATION_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_automation_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_automation_fixture()`;
 try{for(let n=1;n<=5;n++){
  if(n>1){const next=(await db`SELECT next_run_at FROM automation_execution WHERE id=${e.id}`)[0]!.next_run_at;await new Promise(resolve=>setTimeout(resolve,Math.max(0,+next-Date.now())+35));}
  assert.equal(await processOneAutomationExecution(db),true);
  assert.equal((await db`SELECT failure_count FROM automation_execution WHERE id=${e.id}`)[0]!.failure_count,n);
  assert.equal((await db`SELECT count(*)::int AS n FROM follow_up WHERE lead_id=${lead}`)[0]!.n,0);
 }}finally{await db`DROP TRIGGER reject_automation_fixture ON audit_log`;await db`DROP FUNCTION reject_automation_fixture()`;}
 const dead=(await db`SELECT * FROM automation_execution WHERE id=${e.id}`)[0]!;assert.equal(dead.state,'DEAD_LETTER');assert.equal(dead.version,6);
 const root='/api/automation/executions/'+e.id;assert.equal((await api('GET',root+'/history')).json().items.length,6);
 for(const who of ['agent','other','foreign'])assert.equal((await api('POST',root+'/retry',{version:6},who)).statusCode,who==='agent'?403:404);
 const attempts=await Promise.all(Array.from({length:8},()=>api('POST',root+'/retry',{version:6})));
 assert.equal(attempts.filter(x=>x.statusCode===200).length,1);assert.equal(attempts.filter(x=>x.statusCode===409).length,7);
 const worker=spawn(process.execPath,[fileURLToPath(new URL('../src/automation-worker.js',import.meta.url))],{env:{...process.env,DATABASE_URL:url!,AUTOMATION_WORKER_BATCH:'1',AUTOMATION_WORKER_POLL_MS:'250'},stdio:['ignore','pipe','pipe']});
 let output='';worker.stdout.on('data',d=>output+=String(d));worker.stderr.on('data',()=>{});
 try{const until=Date.now()+12000;while(Date.now()<until&&(await db`SELECT state FROM automation_execution WHERE id=${e.id}`)[0]!.state!=='SUCCEEDED')await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal((await db`SELECT state FROM automation_execution WHERE id=${e.id}`)[0]!.state,'SUCCEEDED');assert.match(output,/automation_worker_started/);
 }finally{worker.kill();await new Promise<void>(resolve=>{if(worker.exitCode!==null)resolve();else worker.once('exit',()=>resolve());});}
 assert.equal((await db`SELECT count(*)::int AS n FROM follow_up WHERE automation_execution_id=${e.id}`)[0]!.n,1);
 assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='AUTOMATION_ACTION_APPLIED' AND target_id=${e.id}`)[0]!.n,1);
 assert.equal((await api('POST',root+'/retry',{version:8})).statusCode,409);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;assert.equal((await api('GET',root+'/history')).statusCode,401);
 assert.equal((await db`SELECT count(*)::int AS n FROM conversation_message`)[0]!.n,0);
});

test('Automation matching is bounded per source, survives failures and concurrent recovery, and never admits future approvals or loses batch boundaries',async t=>{
 const {db,api,rule,create}=await fixture(t);
 for(let i=0;i<51;i++)await rule({name:'Bounded matching rule '+i});
 const lead=await create(),source=(await db`SELECT id FROM automation_source WHERE lead_id=${lead} AND trigger_type='LEAD_CREATED'`)[0]!.id;
 // Drain the unrelated assigned source, without fabricating a queue result or event timestamp.
 await db`CREATE FUNCTION reject_match_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AUTOMATION_MATCH' THEN RAISE EXCEPTION 'SYNTHETIC_MATCH_FAILURE';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_match_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_match_fixture()`;
 try{for(let n=1;n<=5;n++){
  if(n>1){const when=(await db`SELECT next_run_at FROM automation_match_queue WHERE source_id=${source}`)[0]!.next_run_at;await new Promise(resolve=>setTimeout(resolve,Math.max(0,+when-Date.now())+35));}
  for(let drain=0;drain<5;drain++){
   await processOneAutomationMatch(db);if((await db`SELECT failure_count FROM automation_match_queue WHERE source_id=${source}`)[0]!.failure_count===n)break;
  }
  assert.equal((await db`SELECT failure_count FROM automation_match_queue WHERE source_id=${source}`)[0]!.failure_count,n);
  assert.equal((await db`SELECT count(*)::int AS n FROM automation_execution WHERE source_id=${source}`)[0]!.n,0);
 }}finally{await db`DROP TRIGGER reject_match_fixture ON audit_log`;await db`DROP FUNCTION reject_match_fixture()`;}
 const q=(await db`SELECT state,version FROM automation_match_queue WHERE source_id=${source}`)[0]!;assert.equal(q.state,'DEAD_LETTER');
 const root='/api/automation/sources/'+source;
 assert.equal((await api('POST',root+'/retry',{version:q.version},'agent')).statusCode,403);
 const retries=await Promise.all(Array.from({length:8},()=>api('POST',root+'/retry',{version:q.version})));
 assert.equal(retries.filter(r=>r.statusCode===200).length,1);assert.equal(retries.filter(r=>r.statusCode===409).length,7);
 const future=await rule({name:'Approval committed after capture'});
 // At most 50 matches are admitted in a single source transition; the second page has exactly one.
 for(let n=0;n<5;n++){
  await processOneAutomationMatch(db);const count=(await db`SELECT count(*)::int AS n FROM automation_execution WHERE source_id=${source}`)[0]!.n;
  if(count){assert.equal(count,50);break;}
 }
 assert.equal((await db`SELECT state FROM automation_match_queue WHERE source_id=${source}`)[0]!.state,'QUEUED');
 await Promise.all(Array.from({length:8},()=>processOneAutomationMatch(db)));
 assert.equal((await db`SELECT state FROM automation_match_queue WHERE source_id=${source}`)[0]!.state,'DONE');
 assert.equal((await db`SELECT count(*)::int AS n FROM automation_execution WHERE source_id=${source}`)[0]!.n,51);
 assert.equal((await db`SELECT count(*)::int AS n FROM automation_execution WHERE source_id=${source} AND rule_id=${future}`)[0]!.n,0);
 assert.ok((await api('GET',root+'/history')).json().items.length>=8);
 const first=(await api('GET','/api/automation/executions?limit=2')).json();assert.equal(first.items.length,2);assert.ok(first.nextCursor);
 assert.ok((await api('GET','/api/automation/executions?limit=2&cursor='+encodeURIComponent(first.nextCursor))).json().items.every((x:any)=>!first.items.some((f:any)=>f.id===x.id)));
});
