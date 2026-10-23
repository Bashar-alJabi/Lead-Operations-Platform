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
import {processOneMessagingJob} from '../src/messaging/send-worker.js';
import {metaWhatsAppSendAdapter} from '../src/messaging/providers.js';
import {processOneInboundEvent} from '../src/messaging/inbound-events.js';
import {processOneAICustomerProposal} from '../src/ai/customer-worker.js';
import {processOneAICustomerSend} from '../src/ai/customer-send.js';
import {processOneSourceEvaluation} from '../src/sources/evaluation.js';
import {processOneSourceIntake} from '../src/sources/intake.js';
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
 const dispatch=()=>processOneMessagingJob(db,{...metaWhatsAppSendAdapter},{syntheticAI:true});assert.equal(await dispatch(),true);assert.equal(sends,1);
 assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${action.message_id}`)[0]!.delivery_state,'SENT');assert.equal((await db`SELECT state FROM conversation WHERE id=${action.conversation_id}`)[0]!.state,'AI_WAITING_FOR_LEAD');
 const dto=(await api('GET','/api/leads/'+first.lead+'/intake-origin')).json().origin.initialAI;assert.equal(dto.runtime.deliveryState,'SENT');assert.equal(dto.runtimeStarted,true);assert.equal((await api('GET','/api/leads/'+first.lead+'/intake-origin',undefined,'second')).statusCode,404);
 // Real signed inbound continues through the existing isolated AI reply pipeline, without fabricated initial inbound.
 const payload=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'123456789',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'15550001111'},messages:[{id:'reply-'+randomUUID(),from:first.phone.slice(1),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'What is the campaign price?'}}]}}]}]});
 assert.equal((await app.inject({method:'POST',url:'/api/webhooks/messaging/meta/'+mc,payload,headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','synthetic-initial-hmac').update(payload).digest('hex')}})).statusCode,200);assert.equal(await processOneInboundEvent(db),true);
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
});
