import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sealSecret } from '../src/credentials.js';
import { sha256 } from '../src/security.js';
import { processOneSourceEvaluation } from '../src/sources/evaluation.js';
import { processOneSourceIntake } from '../src/sources/intake.js';
import { processInboundEvent,processOneInboundEvent } from '../src/messaging/inbound-events.js';
import { processOneIntegrationEvent } from '../src/messaging/event-processing.js';

const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('signed source references resolve proven campaign context without guessing, retain history, enforce scope/pins and survive concurrency/failure',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('References') RETURNING id`)[0]!.id;
  const foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Other organization') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope,userOrg] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',otherBranch,org],
    ['agent','AGENT',branch,org],['second','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash)
      VALUES (${userOrg},${scope},${name},${role},${name+'@references.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session(user_id,token_hash,expires_at)
      VALUES (${id},${sha256(token)},now()+interval '1 hour')`;users[name]={ id,cookie:'lop_session='+token };
  }
  const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie } });
  const source=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status)
    VALUES (${org},${branch},'META','META_LEAD_ADS','Source','WARNING') RETURNING id`)[0]!.id;
  const page=(await db`INSERT INTO source_resource(connection_id,resource_kind,external_id,name,connection_version)
    VALUES (${source},'PAGE','10','Page',1) RETURNING id`)[0]!.id;
  const camps:string[]=[];const leads:string[]=[];const submissions:string[]=[];
  for (let i=0;i<2;i++) {
    const camp=(await db`INSERT INTO campaign(organization_id,branch_id,name,source_kind,status,routing_method)
      VALUES (${org},${branch},${'Campaign '+i},'META','ACTIVE','MANUAL') RETURNING id`)[0]!.id as string;camps.push(camp);
    const form=(await db`INSERT INTO source_resource(connection_id,resource_kind,parent_id,external_id,name,connection_version,questions)
      VALUES (${source},'FORM',${page},${String(20+i)},'Form',1,'[{"key":"phone","externalId":null,"label":"Phone","type":"CUSTOM","options":[]}]'::jsonb) RETURNING id`)[0]!.id;
    const bound=await api('POST',`/api/sources/campaigns/${camp}/bindings`,{ connectionId:source,formId:form,requestId:randomUUID(),connectionVersion:1,
      externalCampaignId:String(100+i),externalAdSetId:null,externalAdId:String(900+i),active:true,reason:'Verified Ad context' });
    assert.equal(bound.statusCode,201,bound.body);const binding=bound.json().id;
    const mappingPath=`/api/sources/campaigns/${camp}/bindings/${binding}/mapping`;
    const current=(await api('GET',mappingPath)).json();
    const mapped=await api('PUT',mappingPath,{ entries:[{ sourceKey:'phone',kind:'CONTACT_PHONE',transform:'TEXT',optionMap:[] }],status:'PUBLISHED',reason:'Published',version:0,
        bindingVersion:1,connectionVersion:1,resourceVersion:current.resourceVersion });assert.equal(mapped.statusCode,200,mapped.body);
    const id=String(1000+i);const raw={ context:{ pageId:'10',formId:String(20+i),leadId:id },lead:{ id,form_id:String(20+i),campaign_id:String(100+i),
      ad_id:String(900+i),created_time:'2023-11-14T22:13:19+0000',field_data:[{ name:'phone',values:['+15550002222'] }] } };
    const submission=(await db`INSERT INTO source_submission(organization_id,source_kind,connection_id,external_event_id,raw_payload,source_timestamp)
      VALUES (${org},'META',${source},${id},${db.json(raw)},'2023-11-14T22:13:19Z') RETURNING id`)[0]!.id as string;submissions.push(submission);
    assert.equal(await processOneSourceEvaluation(db),true);assert.equal(await processOneSourceIntake(db),true);
    const result=(await db`SELECT state,lead_id FROM source_submission WHERE id=${submission}`)[0]!;assert.equal(result.state,'PROCESSED');leads.push(result.lead_id);
    await db`UPDATE lead SET assigned_agent_id=${users.agent!.id} WHERE id=${result.lead_id}`;
  }
  assert.equal((await db`SELECT count(*)::integer n FROM contact`)[0]!.n,1);
  const conn=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config)
    VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Messages','CONNECTED',
      '{"graphVersion":"v25.0","wabaId":"123456789"}'::jsonb) RETURNING id`)[0]!.id;
  const secret=sealSecret(conn,JSON.stringify({ accessToken:'test-token',appSecret:'test-secret',verifyToken:'test-verify' }));
  await db`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag) VALUES (${conn},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
  const sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
    VALUES (${org},${conn},'15550001111','Sender','HEALTHY',true,'{"text":true}'::jsonb) RETURNING id`)[0]!.id;
  await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
  let sequence=0;
  const webhook=async(message:object)=> {
    const payload=JSON.stringify({ object:'whatsapp_business_account',entry:[{ id:'123456789',changes:[{ field:'messages',value:{ messaging_product:'whatsapp',
      metadata:{ phone_number_id:'15550001111' },messages:[message] } }] }] });
    return app.inject({ method:'POST',url:`/api/webhooks/messaging/meta/${conn}`,payload,
      headers:{ 'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','test-secret').update(payload).digest('hex') } });
  };
  const receive=async(referral?:unknown,context?:string,participant='15550002222')=> {
    const message={ id:'wamid.reference.'+sequence++,from:participant,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{ body:'Source customer message' },
      ...(referral!==undefined ? { referral } : {}),...(context ? { context:{ id:context } } : {}) };
    assert.equal((await webhook(message)).json().created,1);
    const event=(await db`SELECT id FROM integration_event WHERE connection_id=${conn} AND payload->'message'->>'id'=${message.id}`)[0]!;
    return { id:event.id as string,message };
  };
  const referral=(id='900',type='ad')=>({ source_type:type,source_id:id,headline:'<img src=x onerror=alert(1)>',body:'Approved source metadata',
    source_url:'http://127.0.0.1/never-fetch',ctwa_clid:'not-a-contact' });
  const eventRow=async(id:string)=>(await db`SELECT * FROM integration_event WHERE id=${id}`)[0]!;
  const review=(id:string)=>`/api/messaging/connections/${conn}/inbound-review/${id}`;
  const first=await receive(referral());
  const sameIdentity=await receive(referral());
  assert.deepEqual(await Promise.all([processOneInboundEvent(db),processOneInboundEvent(db)]),[true,true]);
  const a=await eventRow(first.id);assert.equal(a.state,'PROCESSED');assert.equal(a.lead_id,leads[0]);
  assert.equal((await eventRow(sameIdentity.id)).conversation_id,a.conversation_id);
  assert.equal((await db`SELECT count(*)::integer n FROM conversation WHERE lead_id=${leads[0]!}`)[0]!.n,1);
  assert.equal(await processOneInboundEvent(db),false);
  assert.equal((await webhook(first.message)).json().created,0);
  assert.equal((await db`SELECT count(*)::integer n FROM conversation_message WHERE source_event_id=${first.id}`)[0]!.n,1);
  const stored=(await db`SELECT * FROM conversation_message WHERE source_event_id=${first.id}`)[0]!;
  assert.deepEqual(stored.source_reference,{ namespace:'META_AD',externalId:'900',headline:referral().headline,description:referral().body });
  assert.equal((await db`SELECT detail FROM audit_log WHERE action='INBOUND_MESSAGE_ATTACHED' AND target_id=${stored.id}`)[0]!.detail.sourceEvidence.evidence_id,submissions[0]);
  await assert.rejects(db`UPDATE conversation_message SET source_reference=NULL WHERE id=${stored.id}`,/MESSAGE_SOURCE_REFERENCE_IMMUTABLE/);
  await assert.rejects(db`UPDATE conversation_message SET source_event_id=NULL WHERE id=${stored.id}`,/MESSAGE_SOURCE_REFERENCE_IMMUTABLE/);
  await assert.rejects(db`UPDATE integration_event SET payload='{}'::jsonb WHERE id=${first.id}`,/MESSAGING_EVENT_IDENTITY_IMMUTABLE/);
  await assert.rejects(db`UPDATE integration_event SET lead_id=${leads[1]!} WHERE id=${first.id}`,/MESSAGING_EVENT_RESOLUTION_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM integration_event WHERE id=${first.id}`,/MESSAGING_EVENT_HISTORY_RETAINED/);
  const second=await receive(referral('901'));await processOneInboundEvent(db);const b=await eventRow(second.id);
  assert.equal(b.lead_id,leads[1]);assert.notEqual(b.conversation_id,a.conversation_id);
  const unknown=await receive(referral('999'));await processOneInboundEvent(db);assert.equal((await eventRow(unknown.id)).failure_code,'SOURCE_REFERENCE_UNRESOLVED');
  const detail=(await api('GET',review(unknown.id))).json();assert.equal(detail.event.sourceReference.externalId,'999');assert.equal(detail.event.sourceReferenceInvalid,false);
  assert.equal(JSON.stringify(detail).includes('never-fetch'),false);assert.equal(JSON.stringify(detail).includes('not-a-contact'),false);
  assert.equal((await api('GET',review(unknown.id),undefined,'other')).statusCode,404);
  assert.equal((await api('GET',review(unknown.id),undefined,'foreign')).statusCode,404);
  assert.equal((await api('GET',review(unknown.id),undefined,'agent')).statusCode,403);
  const resolved=await api('POST',review(unknown.id)+'/resolve',{ leadId:leads[0] });assert.equal(resolved.statusCode,200,resolved.body);
  assert.equal((await api('POST',review(unknown.id)+'/resolve',{ leadId:leads[1] })).statusCode,409);
  const noRef=await receive();await processOneInboundEvent(db);assert.equal((await eventRow(noRef.id)).failure_code,'MULTIPLE_ACTIVE_CONVERSATIONS');
  const conflict=await receive(referral('901'),first.message.id);await processOneInboundEvent(db);
  assert.equal((await eventRow(conflict.id)).failure_code,'SOURCE_REFERENCE_TARGET_CONFLICT');
  assert.equal((await api('POST',review(conflict.id)+'/resolve',{ conversationId:a.conversation_id })).statusCode,409);
  assert.equal((await api('POST',review(conflict.id)+'/resolve',{ conversationId:b.conversation_id })).statusCode,409,'reply context cannot be overridden');
  const invalid=await receive({ source_type:'ad',source_id:'900',headline:{} });await processOneInboundEvent(db);
  assert.equal((await eventRow(invalid.id)).failure_code,'INBOUND_SOURCE_REFERENCE_INVALID');assert.equal((await api('GET',review(invalid.id))).json().event.sourceReferenceInvalid,true);
  assert.equal((await api('POST',review(invalid.id)+'/resolve',{ leadId:leads[0] })).statusCode,409);
  const post=await receive(referral('900','post'));await processOneInboundEvent(db);assert.equal((await eventRow(post.id)).failure_code,'SOURCE_REFERENCE_UNRESOLVED');
  assert.equal((await api('POST',review(post.id)+'/resolve',{ conversationId:a.conversation_id })).statusCode,200);
  const threaded=await receive(referral('777'),first.message.id);await processOneInboundEvent(db);assert.equal((await eventRow(threaded.id)).conversation_id,a.conversation_id);
  const wrongPerson=await receive(referral(),first.message.id,'15550003333');await processOneInboundEvent(db);
  assert.equal((await eventRow(wrongPerson.id)).failure_code,'CONTEXT_PARTICIPANT_MISMATCH');
  // An exact configured Ad also works before a Form submission exists, without wildcard guessing.
  const configured=(await db`INSERT INTO campaign(organization_id,branch_id,name,source_kind,status,routing_method)
    VALUES (${org},${branch},'Configured Ad','META','ACTIVE','MANUAL') RETURNING id`)[0]!.id;
  const configuredForm=(await db`INSERT INTO source_resource(connection_id,resource_kind,parent_id,external_id,name,connection_version)
    VALUES (${source},'FORM',${page},'22','Configured Form',1) RETURNING id`)[0]!.id;
  const direct=await api('POST',`/api/sources/campaigns/${configured}/bindings`,{ connectionId:source,formId:configuredForm,requestId:randomUUID(),connectionVersion:1,
    externalCampaignId:null,externalAdSetId:null,externalAdId:'902',active:true,reason:'Explicit exact Ad' });assert.equal(direct.statusCode,201,direct.body);
  const contact=(await db`SELECT contact_id FROM lead WHERE id=${leads[0]!}`)[0]!.contact_id;
  const configuredLead=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,source_kind)
    VALUES (${org},${branch},${configured},${contact},'MANUAL') RETURNING id`)[0]!.id;
  const directMessage=await receive(referral('902'));await processOneInboundEvent(db);const directResult=await eventRow(directMessage.id);
  assert.equal(directResult.lead_id,configuredLead);assert.equal(directResult.state,'PROCESSED');
  const directAudit=(await db`SELECT detail FROM audit_log WHERE action='INBOUND_MESSAGE_ATTACHED' AND detail->>'eventId'=${directMessage.id}`)[0]!.detail;
  assert.equal(directAudit.sourceEvidence.evidence_kind,'SOURCE_BINDING');assert.equal(directAudit.sourceEvidence.evidence_version,1);
  // Multiple active conversations inside the referenced Campaign remain ambiguous.
  const extra=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,source_kind)
    VALUES (${org},${branch},${configured},${contact},'MANUAL') RETURNING id`)[0]!.id;
  await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state,needs_attention_reason)
    VALUES (${extra},${conn},${sender},'WHATSAPP','+15550002222','NONE','WAITING_FOR_HUMAN','NO_HUMAN_CONTROLLER')`;
  const ambiguous=await receive(referral('902'));await processOneInboundEvent(db);assert.equal((await eventRow(ambiguous.id)).failure_code,'MULTIPLE_ACTIVE_CONVERSATIONS');
  const currentBinding=(await db`SELECT version FROM source_campaign_binding WHERE id=${direct.json().id}`)[0]!;
  await db`UPDATE source_campaign_binding SET active=false,version=${currentBinding.version+1},change_reason='Disabled context' WHERE id=${direct.json().id}`;
  const disabledContext=await receive(referral('902'));await processOneInboundEvent(db);assert.equal((await eventRow(disabledContext.id)).failure_code,'SOURCE_REFERENCE_UNRESOLVED');
  // Historical Source provenance remains usable after operational Source setup is disabled.
  await db`UPDATE integration_connection SET status='DISABLED',version=version+1 WHERE id=${source}`;
  const historical=await receive(referral());await processOneInboundEvent(db);assert.equal((await eventRow(historical.id)).lead_id,leads[0]);
  // Same Campaign reference never migrates an existing pin to another sender.
  await db`UPDATE conversation SET state='CLOSED' WHERE id=${b.conversation_id}`;
  const otherSender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
    VALUES (${org},${conn},'15550001112','Other pin','HEALTHY',true,'{"text":true}'::jsonb) RETURNING id`)[0]!.id;
  await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state,needs_attention_reason)
    VALUES (${leads[1]!},${conn},${otherSender},'WHATSAPP','+15550002222','NONE','WAITING_FOR_HUMAN','NO_HUMAN_CONTROLLER')`;
  // Filter the reference before the bounded candidate limit, even for an older Lead.
  await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,source_kind)
    SELECT ${org},${branch},${camps[0]!},${contact},'MANUAL' FROM generate_series(1,102)`;
  const pinned=await receive(referral('901'));await processOneInboundEvent(db);assert.equal((await eventRow(pinned.id)).failure_code,'PINNED_SENDER_MISMATCH');
  // Current owner governs access to the same immutable reference history.
  assert.equal((await api('GET',`/api/conversations/${a.conversation_id}/messages`,undefined,'agent')).statusCode,200);
  await db`UPDATE lead SET assigned_agent_id=${users.second!.id} WHERE id=${leads[0]!}`;
  const denied=await api('GET',`/api/conversations/${a.conversation_id}/messages`,undefined,'agent');assert.equal(denied.statusCode,404);assert.equal(denied.body.includes('Approved source metadata'),false);
  assert.equal((await api('GET',`/api/conversations/${a.conversation_id}/messages`,undefined,'second')).json().items.some((m:{ source_reference:{ externalId:string }|null })=>m.source_reference?.externalId==='900'),true);
  // Waiting for a shared phone lock cannot preserve stale sender authorization.
  const waiting=await receive(referral());let release=()=>{};let ready=()=>{};
  const locked=new Promise<void>((resolve)=>{ ready=resolve; });const hold=new Promise<void>((resolve)=>{ release=resolve; });
  const blocker=db.begin(async(tx)=>{ await tx`SELECT pg_advisory_xact_lock(hashtextextended(${org+':phone:+15550002222'},0))`;ready();await hold; });
  await locked;const worker=processOneInboundEvent(db);await delay(40);await db`UPDATE messaging_sender SET operator_enabled=false,version=version+1 WHERE id=${sender}`;
  release();await blocker;await worker;assert.equal((await eventRow(waiting.id)).failure_code,'SENDER_DISABLED');
  await db`UPDATE messaging_sender SET operator_enabled=true,version=version+1 WHERE id=${sender}`;
  const failed=await receive(referral());const before=(await db`SELECT count(*)::integer n FROM conversation_message`)[0]!.n;
  await processOneIntegrationEvent(db,'INBOUND_MESSAGE',async(tx,id)=>{ await processInboundEvent(tx,id);throw new Error('unsafe-secret'); });
  assert.equal((await db`SELECT count(*)::integer n FROM conversation_message`)[0]!.n,before);
  assert.equal((await eventRow(failed.id)).state,'NEEDS_ATTENTION');assert.equal((await eventRow(failed.id)).processing_last_error,'EVENT_PROCESSING_FAILED');
  await db`UPDATE integration_event SET processing_available_at=now() WHERE id=${failed.id}`;await processOneInboundEvent(db);
  assert.equal((await eventRow(failed.id)).state,'PROCESSED');
  // A historical thread cannot bypass current Branch isolation after a Lead transfer.
  const transferredCampaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status)
    VALUES (${org},${otherBranch},'Transferred','ACTIVE') RETURNING id`)[0]!.id;
  await db`UPDATE lead SET branch_id=${otherBranch},campaign_id=${transferredCampaign},assigned_agent_id=NULL WHERE id=${leads[0]!}`;
  const moved=await receive(referral(),first.message.id);await processOneInboundEvent(db);
  assert.equal((await eventRow(moved.id)).failure_code,'CONVERSATION_NOT_AVAILABLE');
  assert.equal((await api('GET',`/api/conversations/${a.conversation_id}/messages`)).statusCode,404);
  assert.equal((await api('GET',`/api/conversations/${a.conversation_id}/messages`,undefined,'other')).statusCode,200);
});
