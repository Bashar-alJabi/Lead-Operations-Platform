import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {sealSecret} from '../src/credentials.js';
import {emptyKnowledge} from '../src/ai/knowledge.js';
import {emptyAIOperationalConfig} from '../src/ai/operational-config.js';
import {emptyAIBehaviorPolicy} from '../src/ai/behavior-policy.js';
import {processOneAIInitialContact,applyInitialContact} from '../src/ai/initial-contact.js';
import {processOneAIFollowupSchedule,processOneAIFollowupFinalization} from '../src/ai/followup-schedule.js';
import {processOneAIFollowupSend} from '../src/ai/followup-send.js';
import {processOneMessagingJob} from '../src/messaging/send-worker.js';
import {metaWhatsAppSendAdapter} from '../src/messaging/providers.js';
import {processOneInboundEvent} from '../src/messaging/inbound-events.js';
import {processOneAICustomerProposal} from '../src/ai/customer-worker.js';
import {processOneAICustomerSend} from '../src/ai/customer-send.js';
import {processOneSourceEvaluation} from '../src/sources/evaluation.js';
import {processOneSourceIntake} from '../src/sources/intake.js';
import {processOneAutomationExecution,processOneAutomationMatch} from '../src/automation.js';
const url=process.env.TEST_DATABASE_URL;if(!url||new URL(url).pathname!=='/lead_operations_test')throw Error('Isolated test DB required');
test('Initial contact config to actual trusted intake, durable worker, central policy, native outbox, mocked template delivery and signed customer reply',async t=>{
 process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000,aiConnectionAdapters:{OPENAI:{listModels:async()=>['synthetic-initial-model']}}});
 const savedFetch=globalThis.fetch;let sends=0,mode='ACK';globalThis.fetch=async(input,options)=>{assert.equal(String(input),'https://graph.facebook.com/v25.0/15550001111/messages');sends++;const body=JSON.parse(String(options?.body));assert.equal(body.type,'template');assert.equal(body.template.name,'initial_campaign');if(mode==='UNKNOWN')throw Error('Synthetic network loss');return new Response(JSON.stringify({messages:[{id:'initial-'+randomUUID()}]}));};
 t.after(async()=>{globalThis.fetch=savedFetch;await app.close();await db.end();});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Initial flow') RETURNING id`)[0]!.id,branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,
 campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status,routing_method,messaging_config,ai_config) VALUES(${org},${branch},'Initial campaign','ACTIVE','MANUAL','{"enabled":true}','{"enabled":true}') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;cookie:string}>={};for(const [name,role]of[['manager','MANAGER'],['agent','AGENT'],['second','AGENT']]as const){const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES(${org},${branch},${name},${role},${name+'@initialflow.test'},'synthetic-only') RETURNING id`)[0]!.id,token=randomBytes(32).toString('hex');await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},clock_timestamp()+interval '1 hour')`;users[name]={id,cookie:'lop_session='+token};}
 const api=(method:'GET'|'PUT'|'POST',path:string,payload?:object,who='manager')=>app.inject({method,url:path,payload,headers:{origin:process.env.APP_ORIGIN!,cookie:users[who]!.cookie}});
 const kr='/api/ai/campaigns/'+campaign+'/knowledge',knowledge={...emptyKnowledge(),sections:{...emptyKnowledge().sections,prices:'Campaign price is 100 EUR'}};
 assert.equal((await api('PUT',kr+'/draft',{version:0,content:knowledge,reason:'Approved synthetic campaign knowledge'})).statusCode,200);assert.equal((await api('POST',kr+'/publish',{version:1,requestId:randomUUID(),reason:'Publish campaign knowledge'})).statusCode,201);
 const ac=await api('POST','/api/ai/connections',{name:'Synthetic AI',branchId:branch,provider:'OPENAI',credential:'synthetic-fixture-only',reason:'Synthetic setup'});assert.equal(ac.statusCode,201);assert.equal((await api('POST','/api/ai/connections/'+ac.json().id+'/test',{version:1})).statusCode,200);
 const pr=await api('POST','/api/ai/profiles',{connectionId:ac.json().id,name:'Conversation',task:'CONVERSATION',modelId:'synthetic-initial-model',maxOutputTokens:1024,active:true,reason:'Scoped conversation profile'});assert.equal(pr.statusCode,201);
 assert.equal((await api('PUT','/api/ai/campaigns/'+campaign+'/configuration',{version:0,definition:{...emptyAIOperationalConfig(),profiles:{...emptyAIOperationalConfig().profiles,CONVERSATION:pr.json().id},language:{supported:['en'],preferred:'en',detect:true}},reason:'Scoped initial context'})).statusCode,200);
 const disclosure='I am the campaign AI assistant';assert.equal((await api('PUT','/api/ai/campaigns/'+campaign+'/behavior-policy',{version:0,definition:{...emptyAIBehaviorPolicy(),disclosure:{mode:'FIRST_AI_MESSAGE',text:disclosure},handoff:{initialContactWithoutAgent:true,transitionMessage:null,misunderstandingLimit:null}},reason:'Explicit unassigned attention fallback'})).statusCode,200);
 assert.equal((await api('PUT','/api/ai/campaigns/'+campaign+'/tool-policy',{version:0,definition:{allowedTools:['sendConversationMessage','requestHumanHandoff']},reason:'Explicit approved initial tools'})).statusCode,200);
 const mc=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config) VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic WhatsApp','CONNECTED','{"graphVersion":"v25.0","wabaId":"123456789"}') RETURNING id`)[0]!.id,
 sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities) VALUES(${org},${mc},'15550001111','Synthetic','HEALTHY',true,'{"text":true,"template":true,"requiresTemplate":false}') RETURNING id`)[0]!.id;
 await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;const secret=sealSecret(mc,JSON.stringify({accessToken:'synthetic-token',appSecret:'synthetic-initial-hmac',verifyToken:'synthetic-only'}));await db`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag) VALUES(${mc},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
 const template=(await db`INSERT INTO provider_message_template(connection_id,external_template_id,name,language,status,components) VALUES(${mc},'initial-1','initial_campaign','en','APPROVED',${db.json([{type:'BODY',text:disclosure+'. Welcome to Initial campaign. {{1}}'}])}) RETURNING id`)[0]!.id;
 assert.equal((await api('PUT','/api/messaging/campaigns/'+campaign+'/templates/'+template,{version:0,bound:true})).statusCode,200);
 const root='/api/ai/campaigns/'+campaign+'/initial-message',definition={templateId:template,bodyParameters:['Campaign price is 100 EUR'],headerParameter:null,urlParameter:null};
 assert.equal((await api('PUT',root,{version:0,definition,reason:'Manager approves campaign-specific first message'})).statusCode,200);
 assert.equal((await api('POST','/api/campaigns/'+campaign+'/deactivate')).statusCode,200);assert.equal((await api('POST','/api/campaigns/'+campaign+'/activate')).statusCode,200,'Verified initial configuration can activate through the real managed route');
 assert.equal((await api('GET',root)).json().ready,true);assert.equal((await api('PUT',root,{version:0,definition,reason:'Stale request'})).statusCode,409);
 assert.equal((await api('PUT',root,{version:1,definition,reason:'Forbidden Agent'},'agent')).statusCode,404);
 const followupRoot='/api/ai/campaigns/'+campaign+'/followup-message';
 const followupDefinition={...definition,bodyParameters:['Approved campaign follow-up']};
 const approval={version:0,definition:followupDefinition,reason:'Approve separate follow-up content'};
 assert.equal((await api('GET',followupRoot)).json().version,0);
 assert.equal((await api('GET',followupRoot,undefined,'agent')).statusCode,403);
 assert.equal((await api('PUT',followupRoot,approval,'agent')).statusCode,404);
 const revisions=await Promise.all(Array.from({length:4},()=>api('PUT',followupRoot,approval)));
 assert.deepEqual(revisions.map(result=>result.statusCode).sort(),[200,409,409,409],revisions.map(result=>result.body).join('\n'));
 const configured=(await api('GET',followupRoot)).json();
 assert.equal(configured.ready,true);assert.ok(configured.preview.includes('Approved campaign follow-up'));
 assert.ok((await api('GET',root)).json().preview.includes('Campaign price is 100 EUR'));
 assert.equal((await api('GET',followupRoot+'/history')).json().items[0].reason,approval.reason);
 assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='AI_FOLLOWUP_MESSAGE_CONFIGURED' AND target_id=${campaign}`)[0]!.n,1);
 await assert.rejects(db`UPDATE ai_followup_message_history SET snapshot='{}' WHERE campaign_id=${campaign}`,/AI_FOLLOWUP_MESSAGE_HISTORY_IMMUTABLE/);
 await assert.rejects(db`UPDATE ai_followup_message_policy SET version=2,actor_id=${users.agent!.id} WHERE campaign_id=${campaign}`,/AI_FOLLOWUP_MESSAGE_CURRENT_ACCESS_REQUIRED/);
 assert.equal((await api('PUT',followupRoot,{version:1,definition:{...followupDefinition,templateId:null,bodyParameters:[]},reason:'Clear independent approval'})).statusCode,200);
 assert.equal((await api('GET',followupRoot)).json().ready,false);
 assert.equal((await api('PUT',followupRoot,{...approval,version:2})).statusCode,200);
 assert.equal((await db`SELECT count(*)::int AS n FROM conversation_message`)[0]!.n,0);
 const timing=await api('PUT','/api/ai/campaigns/'+campaign+'/followup-policy',{version:0,
  definition:{enabled:true,initialDelaySeconds:0,delaysSeconds:[1],stopOnReply:true,finalAction:'COMPLETE'},reason:'Enable synthetic follow-up timing'});
 assert.equal(timing.statusCode,200,timing.body);
 let n=0;const intake=async(status='GRANTED')=>{const phone='+1555888'+String(++n).padStart(4,'0'),ct=(await db`INSERT INTO contact(organization_id,name,phone_normalized) VALUES(${org},'Synthetic customer',${phone}) RETURNING id`)[0]!.id;
   await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,source_kind,lifecycle) VALUES(${org},${branch},${campaign},${ct},'MANUAL','CLOSED')`;
   if(status==='GRANTED')await db`INSERT INTO messaging_consent(contact_id,channel,status,source,evidence) VALUES(${ct},'WHATSAPP','GRANTED','Trusted synthetic consent','Synthetic explicit opt-in record')`;
   const made=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Synthetic customer',phone}});assert.equal(made.statusCode,201,made.body);const lead=made.json().id;
   const a=(await db`SELECT a.* FROM ai_initial_admission a JOIN lead_intake_receipt r ON r.id=a.receipt_id WHERE r.lead_id=${lead}`)[0]!;assert.equal(a.state,'ADMITTED');assert.equal((await db`SELECT state FROM ai_initial_job WHERE admission_id=${a.id}`)[0]!.state,'WAITING');return{lead,admission:a.id,phone};};
 const first=await intake();
 // Call the real application service directly once so unexpected native failures are surfaced by this test.
 await db.begin(async tx=>{await applyInitialContact(tx,first.admission);});
 const action=(await db`SELECT * FROM ai_initial_send_action WHERE admission_id=${first.admission}`)[0]!;assert.equal(action.state,'APPLIED');
 assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${first.lead}`)[0]!.assigned_agent_id,null);
 assert.equal(await processOneAIInitialContact(db),false);assert.equal(sends,0);
 assert.equal((await api('GET','/api/leads/'+first.lead+'/ai-followups')).json().items.length,0);
 const dispatch=()=>processOneMessagingJob(db,{...metaWhatsAppSendAdapter},{syntheticAI:true});assert.equal(await dispatch(),true);assert.equal(sends,1);
 assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${action.message_id}`)[0]!.delivery_state,'SENT');assert.equal((await db`SELECT state FROM conversation WHERE id=${action.conversation_id}`)[0]!.state,'AI_WAITING_FOR_LEAD');
 const schedulePath='/api/leads/'+first.lead+'/ai-followups',waiting=(await api('GET',schedulePath)).json().items[0];
 assert.equal(waiting.state,'WAITING');assert.equal(Date.parse(waiting.dueAt)-Date.parse(waiting.anchoredAt),1000);
 assert.equal((await api('GET',schedulePath,undefined,'second')).statusCode,404);
 await assert.rejects(db`INSERT INTO ai_followup_schedule(acknowledged_attempt_id) SELECT acknowledged_attempt_id FROM ai_followup_schedule WHERE id=${waiting.id}`,/AI_FOLLOWUP_ACK_REQUIRED/);
 await assert.rejects(db`UPDATE ai_followup_schedule SET due_at=clock_timestamp() WHERE id=${waiting.id}`,/AI_FOLLOWUP_SCHEDULE_RETAINED/);
 await delay(1100);
 const due=await Promise.all(Array.from({length:5},()=>processOneAIFollowupSchedule(db)));
 assert.equal(due.filter(Boolean).length,1);
 assert.equal((await api('GET',schedulePath)).json().items[0].state,'READY');
 assert.equal((await db`SELECT count(*)::int AS n FROM conversation_message WHERE conversation_id=${action.conversation_id}`)[0]!.n,1);
 const dto=(await api('GET','/api/leads/'+first.lead+'/intake-origin')).json().origin.initialAI;assert.equal(dto.runtime.deliveryState,'SENT');assert.equal(dto.runtimeStarted,true);assert.equal((await api('GET','/api/leads/'+first.lead+'/intake-origin',undefined,'second')).statusCode,404);
 // Real signed inbound continues through the existing isolated AI reply pipeline, without fabricated initial inbound.
 const payload=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'123456789',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'15550001111'},messages:[{id:'reply-'+randomUUID(),from:first.phone.slice(1),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'What is the campaign price?'}}]}}]}]});
 assert.equal((await app.inject({method:'POST',url:'/api/webhooks/messaging/meta/'+mc,payload,headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','synthetic-initial-hmac').update(payload).digest('hex')}})).statusCode,200);assert.equal(await processOneInboundEvent(db),true);
 assert.equal((await api('GET',schedulePath)).json().items[0].reason,'CUSTOMER_REPLIED');
 assert.equal((await api('GET',schedulePath)).json().items[0].state,'STOPPED');
 assert.equal(await processOneAIFollowupSend(db),false);
 assert.equal(await processOneAICustomerProposal(db,{adapters:{OPENAI:{simulate:async()=>null,proposeCustomer:async()=>({decision:'ANSWER',referenceIds:['section:prices'],questionId:null,answerValue:null,sourceQuote:null,handoffReason:null})}}}),true);
 assert.equal(await processOneAICustomerSend(db),true);assert.equal((await db`SELECT count(*)::int AS n FROM conversation_message WHERE conversation_id=${action.conversation_id} AND author_type='CUSTOMER'`)[0]!.n,1);
 // Avoid sending the follow-on text with this template-only transport fixture.
 assert.equal((await db`SELECT state FROM ai_customer_send_action WHERE conversation_id=${action.conversation_id}`)[0]!.state,'APPLIED');
 await db`UPDATE background_job SET status='DEAD' WHERE status='QUEUED' AND queue='messaging'`;
 const unknown=await intake('UNKNOWN');assert.equal(await processOneAIInitialContact(db),true);assert.equal((await db`SELECT error_code FROM ai_initial_send_action WHERE admission_id=${unknown.admission}`)[0]!.error_code,'CONSENT_REQUIRED');assert.equal(sends,1);
 const takeover=await intake();await processOneAIInitialContact(db);const ta=(await db`SELECT * FROM ai_initial_send_action WHERE admission_id=${takeover.admission}`)[0]!;
 const cv=(await db`SELECT version FROM conversation WHERE id=${ta.conversation_id}`)[0]!;assert.equal((await api('POST','/api/conversations/'+ta.conversation_id+'/takeover',{version:cv.version,reason:'Manager takes over before initial send'})).statusCode,200);await dispatch();assert.equal(sends,1);
 const uncertain=await intake();await processOneAIInitialContact(db);mode='UNKNOWN';await dispatch();assert.equal(sends,2);const ua=(await db`SELECT message_id FROM ai_initial_send_action WHERE admission_id=${uncertain.admission}`)[0]!;
 assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${ua.message_id}`)[0]!.delivery_state,'UNKNOWN');assert.equal(await dispatch(),false);assert.equal(sends,2);
 assert.equal((await api('GET','/api/leads/'+uncertain.lead+'/ai-followups')).json().items.length,0);
 // Explicit synthetic fixture reset after the separate UNKNOWN case; production never auto-clears provider health.
 await db`UPDATE messaging_sender SET health='HEALTHY' WHERE id=${sender}`;
 await db`UPDATE integration_connection SET status='CONNECTED' WHERE id=${mc}`;
 // Current policy/version changes block queued original sources; workers cannot grant a new template to old admissions.
 const stale=await intake();assert.equal((await api('PUT',root,{version:1,definition,reason:'New explicit approval revision'})).statusCode,200);await processOneAIInitialContact(db);assert.equal((await db`SELECT state FROM ai_initial_send_action WHERE admission_id=${stale.admission}`)[0]!.state,'BLOCKED');
 const failed=await intake();await db`CREATE FUNCTION reject_initial_flow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_INITIAL_CONTACT_APPLIED' THEN RAISE EXCEPTION 'SyntheticInitialFlowRollback';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_initial_flow_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_initial_flow_audit()`;
 try{await processOneAIInitialContact(db);assert.equal((await db`SELECT count(*)::int AS n FROM conversation WHERE lead_id=${failed.lead}`)[0]!.n,0);assert.equal((await db`SELECT failure_count FROM ai_initial_job WHERE admission_id=${failed.admission}`)[0]!.failure_count,1);}
 finally{await db`DROP TRIGGER reject_initial_flow_audit ON audit_log`;await db`DROP FUNCTION reject_initial_flow_audit()`;}
 await delay(2100);await processOneAIInitialContact(db);assert.equal((await db`SELECT state FROM ai_initial_send_action WHERE admission_id=${failed.admission}`)[0]!.state,'APPLIED');
 // Missing native action/outbox cannot commit even when the source is currently admitted.
 const forged=await intake();await assert.rejects(db.begin(async tx=>{const a=(await tx`SELECT context FROM ai_initial_admission WHERE id=${forged.admission}`)[0]!.context;
   await tx`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state,ai_initial_admission_id) VALUES(${forged.lead},${mc},${sender},'WHATSAPP',${forged.phone},'AI','AI_ACTIVE',${forged.admission})`;
 }),/ATOMIC_CONVERSATION_REQUIRED/);await processOneAIInitialContact(db);
 const concurrent=await Promise.all(Array.from({length:4},()=>intake()));for(let i=0;i<5;i++)await Promise.all(Array.from({length:4},()=>processOneAIInitialContact(db)));
 assert.equal((await db`SELECT count(*)::int AS n FROM ai_initial_send_action WHERE admission_id IN ${db(concurrent.map(x=>x.admission))}`)[0]!.n,4);
 assert.equal((await db`SELECT count(*)::int AS n FROM payment_record`)[0]!.n,0);
 await assert.rejects(db`UPDATE ai_initial_send_action SET content='{}' WHERE id=${action.id}`,/IMMUTABLE/);
 await assert.rejects(db`INSERT INTO ai_initial_job(admission_id) VALUES(${first.admission})`,/FRESH_JOB_SOURCE_REQUIRED/);
 await t.test('A scoped operator can recover only an unchanged initial job that exhausted local processing before any send', {timeout:60_000},async()=>{
  const recovery=await intake(),staleRecovery=await intake();
  const admissions=[recovery.admission,staleRecovery.admission];
  const sendsBefore=sends;
  await db`CREATE FUNCTION reject_initial_recovery_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.action='AI_INITIAL_CONTACT_APPLIED' THEN RAISE EXCEPTION 'Synthetic initial local failure'; END IF; RETURN NEW; END $$`;
  await db`CREATE TRIGGER reject_initial_recovery_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_initial_recovery_fixture()`;
  try{
   for(let attempt=1;attempt<=5;attempt++){
    for(const _admission of admissions)assert.equal(await processOneAIInitialContact(db),true);
    const jobs=await db`SELECT state,failure_count,ceil(extract(epoch FROM (available_at-clock_timestamp()))*1000)::int AS wait_ms
      FROM ai_initial_job WHERE admission_id IN ${db(admissions)}`;
    assert.equal(jobs.length,2);
    assert.ok(jobs.every(job=>job.failure_count===attempt&&job.state===(attempt===5?'DEAD_LETTER':'WAITING')));
    if(attempt<5)await delay(Math.max(0,...jobs.map(job=>job.wait_ms))+25);
   }
  }finally{
   await db`DROP TRIGGER reject_initial_recovery_fixture ON audit_log`;
   await db`DROP FUNCTION reject_initial_recovery_fixture()`;
  }
  assert.equal(sends,sendsBefore);
  assert.equal((await db`SELECT count(*)::int AS n FROM ai_initial_send_action WHERE admission_id IN ${db(admissions)}`)[0]!.n,0);
  const originPath=(lead:string)=>'/api/leads/'+lead+'/intake-origin';
  const retryPath=(target:{lead:string;admission:string})=>originPath(target.lead)+'/initial-ai/'+target.admission+'/retry';
  const runtime=(await api('GET',originPath(recovery.lead))).json().origin.initialAI.runtime;
  assert.equal(runtime.jobState,'DEAD_LETTER');assert.equal(runtime.canRequestRecovery,true);
  const input={version:runtime.jobVersion,reason:'Verified the local incident is resolved'};
  const path=retryPath(recovery);
  assert.equal((await api('POST',path,input,'agent')).statusCode,403);
  const [foreignBranch]=await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Foreign recovery branch') RETURNING id`;
  const [foreignManager]=await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
   VALUES(${org},${foreignBranch!.id},'MANAGER','Foreign recovery Manager','foreign@initialflow.test','synthetic-only') RETURNING id`;
  const foreignToken=randomBytes(32).toString('hex');
  await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${foreignManager!.id},${sha256(foreignToken)},clock_timestamp()+interval '1 hour')`;
  users.foreignRecovery={id:foreignManager!.id,cookie:'lop_session='+foreignToken};
  assert.equal((await api('POST',path,input,'foreignRecovery')).statusCode,404);
  assert.equal((await api('POST',path,{...input,version:String(input.version)})).statusCode,400);
  assert.equal((await api('POST',path,{...input,reason:' 😀🙂 '})).statusCode,400);
  assert.equal((await api('POST',path,{...input,version:input.version-1})).json().error,'AI_INITIAL_RECOVERY_VERSION_CONFLICT');
  assert.equal((await api('POST',retryPath({...recovery,admission:staleRecovery.admission}),input)).statusCode,404);
  const unknownVersion=(await api('GET',originPath(uncertain.lead))).json().origin.initialAI.runtime.jobVersion;
  assert.equal((await api('POST',retryPath(uncertain),{...input,version:unknownVersion})).json().error,'AI_INITIAL_RECOVERY_UNAVAILABLE');
  await assert.rejects(db`UPDATE ai_initial_job SET state='WAITING',failure_count=0,version=version+1 WHERE admission_id=${recovery.admission}`,
   /AI_INITIAL_JOB_RECOVERY_PROOF_REQUIRED/);
  await assert.rejects(db`INSERT INTO ai_initial_job_recovery(admission_id,job_version,actor_id,session_id,reason)
   SELECT ${recovery.admission},${input.version},${users.manager!.id},id,${input.reason} FROM user_session WHERE user_id=${users.agent!.id}`,
   /AI_INITIAL_RECOVERY_ACCESS_REVOKED/);
  await db`CREATE FUNCTION reject_recovery_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.action='AI_INITIAL_JOB_RECOVERED' THEN RAISE EXCEPTION 'Synthetic recovery Audit failure'; END IF; RETURN NEW; END $$`;
  await db`CREATE TRIGGER reject_recovery_audit_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_recovery_audit_fixture()`;
  try{
   assert.equal((await api('POST',path,input)).statusCode,500);
   assert.equal((await db`SELECT state FROM ai_initial_job WHERE admission_id=${recovery.admission}`)[0]!.state,'DEAD_LETTER');
   assert.equal((await db`SELECT count(*)::int AS n FROM ai_initial_job_recovery WHERE admission_id=${recovery.admission}`)[0]!.n,0);
  }finally{
   await db`DROP TRIGGER reject_recovery_audit_fixture ON audit_log`;
   await db`DROP FUNCTION reject_recovery_audit_fixture()`;
  }
  const raced=await Promise.all(Array.from({length:4},()=>api('POST',path,input)));
  assert.deepEqual(raced.map(result=>result.statusCode).sort(),[200,409,409,409],raced.map(result=>result.body).join('\n'));
  const [proof]=await db`SELECT job_version,actor_id,reason FROM ai_initial_job_recovery WHERE admission_id=${recovery.admission}`;
  assert.deepEqual(proof,{job_version:input.version,actor_id:users.manager!.id,reason:input.reason});
  await assert.rejects(db`DELETE FROM ai_initial_job_recovery WHERE admission_id=${recovery.admission}`,/AI_INITIAL_RECOVERY_HISTORY_RETAINED/);
  assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE target_id=${recovery.lead} AND action='AI_INITIAL_JOB_FAILED'`)[0]!.n,5);
  assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE target_id=${recovery.lead} AND action='AI_INITIAL_JOB_RECOVERED'`)[0]!.n,1);
  assert.equal((await db`SELECT count(*)::int AS n FROM ai_initial_send_action WHERE admission_id=${recovery.admission}`)[0]!.n,0);
  assert.equal(await processOneAIInitialContact(db),true);
  const [queued]=await db`SELECT j.state,m.delivery_state FROM ai_initial_job j
   JOIN ai_initial_send_action a ON a.admission_id=j.admission_id JOIN conversation_message m ON m.id=a.message_id
   WHERE j.admission_id=${recovery.admission}`;
  assert.deepEqual(queued,{state:'DONE',delivery_state:'QUEUED'});
  assert.equal(await processOneAIInitialContact(db),false);
  assert.equal(sends,sendsBefore);

  const current=(await api('GET',root)).json();
  const refreshed=await api('PUT',root,{version:current.version,definition,reason:'Approve a new initial contact revision'});
  assert.equal(refreshed.statusCode,200,refreshed.body);
  const staleAttempt=await api('POST',retryPath(staleRecovery),input);
  assert.equal(staleAttempt.statusCode,409,staleAttempt.body);
  assert.equal(staleAttempt.json().error,'AI_INITIAL_RECOVERY_CONTEXT_CHANGED');
 });
 // Real Source evaluation/intake uses the same fresh post-Routing source, with no Human session or fabricated customer message.
 await db`UPDATE background_job SET status='DEAD' WHERE status='QUEUED' AND queue='messaging'`;mode='ACK';
 await db`UPDATE campaign SET source_kind='META',version=version+1 WHERE id=${campaign}`;
 const sc=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status) VALUES(${org},${branch},'META','META_LEAD_ADS','Synthetic intake source','WARNING') RETURNING id`)[0]!.id,
 page=(await db`INSERT INTO source_resource(connection_id,resource_kind,external_id,name,connection_version) VALUES(${sc},'PAGE','10','Synthetic page',1) RETURNING id`)[0]!.id,
 form=(await db`INSERT INTO source_resource(connection_id,resource_kind,parent_id,external_id,name,connection_version,questions) VALUES(${sc},'FORM',${page},'20','Synthetic form',1,${db.json(['name','phone'].map(key=>({key,externalId:null,label:key,type:'CUSTOM',options:[]})))}) RETURNING id`)[0]!.id;
 const binding=await api('POST','/api/sources/campaigns/'+campaign+'/bindings',{connectionId:sc,formId:form,requestId:randomUUID(),connectionVersion:1,externalCampaignId:'100',externalAdSetId:null,externalAdId:null,active:true,reason:'Synthetic approved source scope'});assert.equal(binding.statusCode,201,binding.body);
 const mr='/api/sources/campaigns/'+campaign+'/bindings/'+binding.json().id+'/mapping',mapping=(await api('GET',mr)).json();
 assert.equal((await api('PUT',mr,{version:0,bindingVersion:mapping.bindingVersion,connectionVersion:mapping.connectionVersion,resourceVersion:mapping.resourceVersion,status:'PUBLISHED',reason:'Publish source contact mapping',entries:['name','phone'].map(key=>({sourceKey:key,kind:'CONTACT_'+key.toUpperCase(),transform:'TEXT',optionMap:[]}))})).statusCode,200);
 const sourcePhone='+15559992222',sourceContact=(await db`INSERT INTO contact(organization_id,name,phone_normalized) VALUES(${org},'Source customer',${sourcePhone}) RETURNING id`)[0]!.id;
 await db`INSERT INTO messaging_consent(contact_id,channel,status,source,evidence) VALUES(${sourceContact},'WHATSAPP','GRANTED','Synthetic trusted opt-in','Explicit dedicated synthetic consent')`;
 const submission=(await db`INSERT INTO source_submission(organization_id,source_kind,connection_id,external_event_id,raw_payload,source_timestamp) VALUES(${org},'META',${sc},'999',${db.json({context:{pageId:'10',formId:'20',leadId:'999'},notification:{pageId:'10',field:'leadgen',change:{value:{}}},lead:{id:'999',form_id:'20',campaign_id:'100',created_time:'2023-11-14T22:13:19+0000',field_data:[{name:'name',values:['Source customer']},{name:'phone',values:[sourcePhone]}]}})},'2023-11-14T22:13:19Z') RETURNING id`)[0]!.id;
 assert.equal(await processOneSourceEvaluation(db),true);assert.equal(await processOneSourceIntake(db),true);
 const processed=(await db`SELECT s.lead_id,p.state,p.error_code FROM source_submission s JOIN source_processing p ON p.submission_id=s.id WHERE s.id=${submission}`)[0]!;assert.equal(processed.state,'PROCESSED',processed.error_code);
 const sourceAdmission=(await db`SELECT a.*,r.origin_kind,r.actor_id,r.session_id FROM ai_initial_admission a JOIN lead_intake_receipt r ON r.id=a.receipt_id WHERE r.lead_id=${processed.lead_id}`)[0]!;
 assert.equal(sourceAdmission.origin_kind,'SOURCE');assert.equal(sourceAdmission.actor_id,null);assert.equal(sourceAdmission.session_id,null);assert.equal(sourceAdmission.state,'ADMITTED');
 await processOneAIInitialContact(db);const sa=(await db`SELECT * FROM ai_initial_send_action WHERE admission_id=${sourceAdmission.id}`)[0]!;assert.equal(sa.state,'APPLIED');assert.equal(await dispatch(),true);assert.equal(sends,3);
 const sourceSchedule='/api/leads/'+processed.lead_id+'/ai-followups';
 assert.equal((await api('GET',sourceSchedule)).json().items[0].state,'WAITING');
 await delay(1100);
 assert.equal(await processOneAIFollowupSchedule(db),true);
 await assert.rejects(db`INSERT INTO ai_followup_send_action(schedule_id,message_id,content)
   SELECT id,gen_random_uuid(),jsonb_build_object('body','Forged follow-up') FROM ai_followup_schedule WHERE lead_id=${processed.lead_id}`,
  /AI_FOLLOWUP_APPROVED_CONTENT_REQUIRED/);
 const queued=await Promise.all(Array.from({length:5},()=>processOneAIFollowupSend(db)));
 assert.equal(queued.filter(Boolean).length,1);
 assert.equal((await api('GET',sourceSchedule)).json().items[0].state,'QUEUED');
 const [followup]=await db`SELECT m.id,m.body,m.delivery_state,ob.job_id FROM conversation_message m
  JOIN ai_followup_send_action a ON a.id=m.ai_followup_action_id JOIN outbound_delivery_job ob ON ob.message_id=m.id
  WHERE m.conversation_id=${sa.conversation_id}`;
 assert.ok(followup!.body.includes('Approved campaign follow-up'));
 await assert.rejects(db`INSERT INTO outbound_send_attempt(message_id,job_id,attempt_number,state)
   VALUES(${followup!.id},${followup!.job_id},1,'PREPARED')`,/AI_SEND_CURRENT_DISPATCH_LEASE_REQUIRED/);
 assert.equal(await dispatch(),true);assert.equal(sends,4);
 assert.equal((await api('GET',sourceSchedule)).json().items[0].state,'SENT');
 assert.equal((await api('GET',sourceSchedule)).json().items[0].finalState,'PENDING');
 const finalized=await Promise.all(Array.from({length:4},()=>processOneAIFollowupFinalization(db)));
 assert.equal(finalized.filter(Boolean).length,1);
 assert.equal((await api('GET',sourceSchedule)).json().items[0].finalState,'COMPLETE');
 assert.equal((await db`SELECT lifecycle FROM lead WHERE id=${processed.lead_id}`)[0]!.lifecycle,'OPEN');

 const late=await intake();await processOneAIInitialContact(db);assert.equal(await dispatch(),true);assert.equal(sends,5);
 const [lateAction]=await db`SELECT conversation_id FROM ai_initial_send_action WHERE admission_id=${late.admission}`;
 const latePath='/api/leads/'+late.lead+'/ai-followups';
 await delay(1100);assert.equal(await processOneAIFollowupSchedule(db),true);assert.equal(await processOneAIFollowupSend(db),true);
 assert.equal((await api('GET',latePath)).json().items[0].state,'QUEUED');
 assert.equal((await api('POST','/api/conversations/'+lateAction!.conversation_id+'/takeover',{version:1,reason:'Manager ends the queued AI episode'})).statusCode,200);
 assert.equal(await dispatch(),true);assert.equal(sends,5);
 assert.equal((await api('GET',latePath)).json().items[0].reason,'AI_CONTROL_CHANGED');
 const optOut=await intake();await processOneAIInitialContact(db);assert.equal(await dispatch(),true);assert.equal(sends,6);
 const consentPath='/api/leads/'+optOut.lead+'/messaging-consent',consent=(await api('GET',consentPath)).json();
 assert.equal((await api('PUT',consentPath,{version:consent.version,status:'REVOKED',doNotContact:true,
  evidence:'Synthetic customer opted out',source:'Authorized consent review'})).statusCode,200);
 await delay(1100);assert.equal(await processOneAIFollowupSchedule(db),true);assert.equal(await processOneAIFollowupSend(db),true);
 const blocked=(await api('GET','/api/leads/'+optOut.lead+'/ai-followups')).json().items[0];
 assert.equal(blocked.state,'BLOCKED');assert.equal(blocked.reason,'DO_NOT_CONTACT');
 assert.equal(await dispatch(),false);assert.equal(sends,6);

 const recurringPolicy={enabled:true,initialDelaySeconds:0,delaysSeconds:[1,1],stopOnReply:true,finalAction:'HANDOFF'};
 assert.equal((await api('PUT','/api/ai/campaigns/'+campaign+'/followup-policy',{version:1,definition:recurringPolicy,
  reason:'Two follow-up delays followed by human escalation'})).statusCode,200);
 const sequence=await intake();await processOneAIInitialContact(db);assert.equal(await dispatch(),true);assert.equal(sends,7);
 const sequencePath='/api/leads/'+sequence.lead+'/ai-followups';
 const firstStep=(await api('GET',sequencePath)).json().items[0];assert.equal(firstStep.ordinal,1);
 for(const attemptNo of [1,2]){
  await delay(1100);assert.equal(await processOneAIFollowupSchedule(db),true);assert.equal(await processOneAIFollowupSend(db),true);
  assert.equal((await api('GET',sequencePath)).json().items[0].state,'QUEUED');
  assert.equal(await dispatch(),true);assert.equal(sends,7+attemptNo);
 }
 const [lastStep,priorStep]=(await api('GET',sequencePath)).json().items;
 assert.equal(lastStep.ordinal,2);assert.equal(lastStep.state,'SENT');assert.equal(lastStep.finalState,'PENDING');
 assert.equal(priorStep.id,firstStep.id);assert.equal(priorStep.state,'SENT');
 assert.equal(await processOneAIFollowupFinalization(db),true);
 assert.equal((await api('GET',sequencePath)).json().items[0].finalState,'HANDOFF');
 const [seqCv]=await db`SELECT cv.state,cv.controller_type FROM conversation cv WHERE cv.lead_id=${sequence.lead}`;
 assert.deepEqual(seqCv,{state:'WAITING_FOR_HUMAN',controller_type:'NONE'});
 assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${sequence.lead}`)[0]!.assigned_agent_id,null);
 assert.equal(await processOneAIFollowupSchedule(db),false);

 assert.equal((await api('PUT','/api/ai/campaigns/'+campaign+'/followup-policy',{version:2,
  definition:{...recurringPolicy,delaysSeconds:[1]},reason:'Verify a late signed reply before finalization'})).statusCode,200);
 const answered=await intake();await processOneAIInitialContact(db);assert.equal(await dispatch(),true);assert.equal(sends,10);
 await delay(1100);assert.equal(await processOneAIFollowupSchedule(db),true);assert.equal(await processOneAIFollowupSend(db),true);
 assert.equal(await dispatch(),true);assert.equal(sends,11);
 const answeredPath='/api/leads/'+answered.lead+'/ai-followups';
 assert.equal((await api('GET',answeredPath)).json().items[0].finalState,'PENDING');
 const answeredBody=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'123456789',changes:[{field:'messages',value:{
  messaging_product:'whatsapp',metadata:{phone_number_id:'15550001111'},messages:[{id:'late-reply-'+randomUUID(),
   from:answered.phone.slice(1),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'I can respond now'}}]}}]}]});
 assert.equal((await app.inject({method:'POST',url:'/api/webhooks/messaging/meta/'+mc,payload:answeredBody,headers:{
  'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','synthetic-initial-hmac').update(answeredBody).digest('hex')}})).statusCode,200);
 assert.equal(await processOneInboundEvent(db),true);assert.equal(await processOneAIFollowupFinalization(db),true);
 const [answeredAction]=(await api('GET',answeredPath)).json().items;
 assert.equal(answeredAction.finalState,'STOPPED');assert.equal(answeredAction.finalReason,'CUSTOMER_REPLIED');
 assert.equal((await db`SELECT controller_type FROM conversation WHERE lead_id=${answered.lead}`)[0]!.controller_type,'AI');

 const deferred=await intake();await processOneAIInitialContact(db);assert.equal(await dispatch(),true);assert.equal(sends,12);
 const messagingPolicy='/api/messaging/campaigns/'+campaign+'/policy';
 const policyVersion=async()=>(await api('GET',messagingPolicy)).json().version as number;
 const hour=(new Date().getUTCHours()+4)%24;
 const window={start:String(hour).padStart(2,'0')+':00',end:String((hour+1)%24).padStart(2,'0')+':00'};
 assert.equal((await api('PUT',messagingPolicy,{version:await policyVersion(),sendingWindow:window,maxAttempts:null,minIntervalSeconds:null})).statusCode,200);
 await delay(1100);assert.equal(await processOneAIFollowupSchedule(db),true);assert.equal(await processOneAIFollowupSend(db),true);
 const deferredPath='/api/leads/'+deferred.lead+'/ai-followups';
 const saved=(await api('GET',deferredPath)).json().items[0];
 assert.equal(saved.reason,'OUTSIDE_SENDING_WINDOW');assert.ok(Date.parse(saved.nextCheckAt)>Date.now()+60000);
 const [job]=await db`SELECT ob.job_id FROM ai_followup_schedule s JOIN ai_followup_send_action a ON a.schedule_id=s.id
  JOIN outbound_delivery_job ob ON ob.message_id=a.message_id WHERE s.lead_id=${deferred.lead}`;
 assert.equal(await dispatch(),false);
 // An early claim must revalidate the current policy instead of consuming a provider attempt.
 async function advanceTestQueue(){await db`UPDATE background_job SET run_after=clock_timestamp() WHERE id=${job!.job_id}`;}
 await advanceTestQueue();assert.equal(await dispatch(),true);assert.equal(sends,12);
 assert.equal((await api('GET',deferredPath)).json().items[0].reason,'OUTSIDE_SENDING_WINDOW');
 assert.equal((await api('PUT',messagingPolicy,{version:await policyVersion(),sendingWindow:null,maxAttempts:null,minIntervalSeconds:180})).statusCode,200);
 await advanceTestQueue();assert.equal(await dispatch(),true);assert.equal(sends,12);
 assert.equal((await api('GET',deferredPath)).json().items[0].reason,'FREQUENCY_LIMIT');
 assert.equal((await db`SELECT attempts FROM background_job WHERE id=${job!.job_id}`)[0]!.attempts,0);
 assert.equal((await db`SELECT count(*)::int AS n FROM outbound_send_attempt WHERE job_id=${job!.job_id}`)[0]!.n,0);
 assert.equal((await api('PUT',messagingPolicy,{version:await policyVersion(),sendingWindow:null,maxAttempts:null,minIntervalSeconds:null})).statusCode,200);
 await advanceTestQueue();assert.equal(await dispatch(),true);assert.equal(sends,13);
 assert.equal((await api('GET',deferredPath)).json().items[0].state,'SENT');
 assert.equal(await processOneAIFollowupFinalization(db),true);

 const interrupted=await intake();await processOneAIInitialContact(db);assert.equal(await dispatch(),true);assert.equal(sends,14);
 await delay(1100);assert.equal(await processOneAIFollowupSchedule(db),true);assert.equal(await processOneAIFollowupSend(db),true);
 mode='UNKNOWN';assert.equal(await dispatch(),true);assert.equal(sends,15);
 const interruption=(await api('GET','/api/leads/'+interrupted.lead+'/ai-followups')).json().items;
 assert.equal(interruption.length,1);assert.equal(interruption[0].state,'UNKNOWN');assert.equal(interruption[0].finalState,null);
 assert.equal(await dispatch(),false);assert.equal(await processOneAIFollowupFinalization(db),false);
 assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE target_id=${first.lead} AND action IN ('AI_FOLLOWUP_WAITING','AI_FOLLOWUP_READY','AI_FOLLOWUP_STOPPED')`)[0]!.n,3);

 await t.test('Automation starts one follow-up from a genuine acknowledgement and retains approval through the sequence',async()=>{
  const rule={name:'Start approved AI follow-up',enabled:true,triggerType:'LEAD_CREATED',lifecycle:'OPEN',ownerCondition:'ANY',
   actionType:'START_AI_FOLLOWUP',delayMinutes:0,priority:'NORMAL',note:'',reason:'Approve follow-up for synthetic intake'};
  assert.equal((await api('POST','/api/automations',{...rule,branchId:branch,campaignId:campaign},'agent')).statusCode,403);
  const approvals=await Promise.all([rule,{...rule,name:'Second rule for the same acknowledgement'}].map(definition=>
   api('POST','/api/automations',{...definition,branchId:branch,campaignId:campaign})));
  for(const approval of approvals)assert.equal(approval.statusCode,201,approval.body);
  const timingPath='/api/ai/campaigns/'+campaign+'/followup-policy';
  assert.equal((await api('PUT',timingPath,{version:3,definition:{...recurringPolicy,enabled:false},reason:'Pause automatic follow-up scheduling'})).statusCode,200);
  await db`UPDATE messaging_sender SET health='HEALTHY' WHERE id=${sender}`;
  await db`UPDATE integration_connection SET status='CONNECTED' WHERE id=${mc}`;
  const eligible=await intake(),replyLead=await intake(),uncertainLead=await intake();
  for(const [index,item] of [eligible,replyLead,uncertainLead].entries()){
   assert.equal(await processOneAIInitialContact(db),true);
   mode=index===2?'UNKNOWN':'ACK';
   assert.equal(await dispatch(),true);
   assert.equal((await api('GET','/api/leads/'+item.lead+'/ai-followups')).json().items.length,0);
  }
  mode='ACK';
  await db`UPDATE messaging_sender SET health='HEALTHY' WHERE id=${sender}`;
  await db`UPDATE integration_connection SET status='CONNECTED' WHERE id=${mc}`;
  const enabled=await api('PUT',timingPath,{version:4,definition:{...recurringPolicy,delaysSeconds:[1,1]},reason:'Enable the two approved follow-up steps'});
  assert.equal(enabled.statusCode,200,enabled.body);
  for(let index=0;index<200&&await processOneAutomationMatch(db);index++);
  await Promise.all(Array.from({length:4},()=>processOneAutomationExecution(db)));
  for(let index=0;index<200&&await processOneAutomationExecution(db);index++);
  const read=(lead:string)=>api('GET','/api/leads/'+lead+'/ai-followups');
  const [scheduled]=(await read(eligible.lead)).json().items;
  assert.equal(scheduled.state,'WAITING');assert.equal(scheduled.startedByAutomation,true);
  assert.equal(Date.parse(scheduled.dueAt)-Date.parse(scheduled.anchoredAt),1000);
  assert.equal((await api('GET','/api/leads/'+eligible.lead+'/ai-followups',undefined,'second')).statusCode,404);
  assert.equal((await read(uncertainLead.lead)).json().items.length,0);
  const results=await db`SELECT result_code FROM automation_execution e JOIN automation_source s ON s.id=e.source_id
   WHERE s.lead_id=${eligible.lead} OR s.lead_id=${uncertainLead.lead} ORDER BY result_code`;
  assert.deepEqual(results.map(row=>row.result_code).sort(),['APPLIED','AUTOMATION_FOLLOWUP_ALREADY_SCHEDULED',
   'AUTOMATION_FOLLOWUP_CONTEXT_UNAVAILABLE','AUTOMATION_FOLLOWUP_CONTEXT_UNAVAILABLE'].sort());
  const [proof]=await db`SELECT s.automation_execution_id,e.rule_id,s.acknowledged_attempt_id,s.conversation_id FROM ai_followup_schedule s
   JOIN automation_execution e ON e.id=s.automation_execution_id WHERE s.id=${scheduled.id}`;
  assert.ok(proof);
  await assert.rejects(db`INSERT INTO ai_followup_schedule(automation_execution_id,acknowledged_attempt_id)
   VALUES(${proof.automation_execution_id},${proof.acknowledged_attempt_id})`,/AI_FOLLOWUP_ACK_REQUIRED/);
  assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='AI_FOLLOWUP_WAITING'
   AND detail->>'automationExecutionId'=${proof.automation_execution_id}`)[0]!.n,1);

  const response=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'123456789',changes:[{field:'messages',value:{
   messaging_product:'whatsapp',metadata:{phone_number_id:'15550001111'},messages:[{id:'automation-reply-'+randomUUID(),
    from:replyLead.phone.slice(1),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'I have a question'}}]}}]}]});
  assert.equal((await app.inject({method:'POST',url:'/api/webhooks/messaging/meta/'+mc,payload:response,headers:{
   'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','synthetic-initial-hmac').update(response).digest('hex')}})).statusCode,200);
  assert.equal(await processOneInboundEvent(db),true);
  assert.equal((await read(replyLead.lead)).json().items[0].reason,'CUSTOMER_REPLIED');

  await delay(1100);
  assert.equal(await processOneAIFollowupSchedule(db),true);assert.equal(await processOneAIFollowupSend(db),true);
  const beforeSend=sends;
  assert.equal(await dispatch(),true);assert.equal(sends,beforeSend+1);
  const steps=(await read(eligible.lead)).json().items;
  assert.deepEqual(steps.map((row:{ordinal:number;state:string;startedByAutomation:boolean})=>[row.ordinal,row.state,row.startedByAutomation]),
   [[2,'WAITING',true],[1,'SENT',true]]);
  await delay(1100);
  assert.equal(await processOneAIFollowupSchedule(db),true);assert.equal(await processOneAIFollowupSend(db),true);
  assert.equal((await read(eligible.lead)).json().items[0].state,'QUEUED');
  assert.equal((await api('PUT','/api/automations/'+proof.rule_id,{...rule,version:1,enabled:false,reason:'Revoke follow-up approval'})).statusCode,200);
  assert.equal(await dispatch(),true);assert.equal(sends,beforeSend+1);
  assert.equal((await read(eligible.lead)).json().items[0].reason,'AUTOMATION_FOLLOWUP_APPROVAL_CHANGED');
 });
});
