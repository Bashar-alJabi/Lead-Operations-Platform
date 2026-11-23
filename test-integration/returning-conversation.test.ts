import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { emptyAIBehaviorPolicy } from '../src/ai/behavior-policy.js';
import { sealSecret } from '../src/credentials.js';
import { createDatabase } from '../src/db.js';
import { processOneIntegrationEvent } from '../src/messaging/event-processing.js';
import { processInboundEvent, processOneInboundEvent } from '../src/messaging/inbound-events.js';
import { sha256 } from '../src/security.js';

const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Signed returning messages honor campaign policy, attribution and closure history without resuming AI',async t=>{
  const origin='http://127.0.0.1:5173';
  process.env.APP_ORIGIN=origin;
  process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);
  const app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
  t.after(async()=>{await app.close();await db.end();});
  await db.begin(async tx=>{
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`;
    await tx`TRUNCATE organization CASCADE`;
  });
  const org=(await db`INSERT INTO organization(name) VALUES('Returning test') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id;
  const other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{id:string;cookie:string}>={};
  for(const [key,role,scope] of [['manager','MANAGER',branch],['agent','AGENT',branch],['other','MANAGER',other]]){
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash)
      VALUES(${org},${scope},${key!},${role!},${key+'@returning.test'},'test-only') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');
    await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour')`;
    users[key!]={id,cookie:`lop_session=${token}`};
  }
  const scoped=async(method:'GET'|'POST'|'PUT',path:string,actor:string,payload?:object)=>app.inject({method,url:path,payload,
    headers:{origin,cookie:users[actor]!.cookie}});
  const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status,messaging_config)
    VALUES(${org},${branch},'Returning','ACTIVE','{"enabled":true}') RETURNING id`)[0]!.id;
  const connection=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config)
    VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Returning','CONNECTED','{"graphVersion":"v25.0","wabaId":"123456789"}') RETURNING id`)[0]!.id;
  const credentials={accessToken:'synthetic-only',appSecret:'returning-test-signing-key',verifyToken:'test-only'};
  const secret=sealSecret(connection,JSON.stringify(credentials));
  await db`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag)
    VALUES(${connection},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
  const sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
    VALUES(${org},${connection},'15550001111','Returning','HEALTHY',true,'{"text":true}') RETURNING id`)[0]!.id;
  await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
  const phone='+15550002222';
  const contact=(await db`INSERT INTO contact(organization_id,name,phone,phone_normalized) VALUES(${org},'Customer',${phone},${phone}) RETURNING id`)[0]!.id;
  async function closedThread(){
    const lead=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,source_kind,assigned_agent_id)
      VALUES(${org},${branch},${campaign},${contact},'MANUAL',${users.agent!.id}) RETURNING id`)[0]!.id;
    const cv=(await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state,closed_at)
      VALUES(${lead},${connection},${sender},'WHATSAPP',${phone},'NONE','CLOSED',clock_timestamp()-interval '10 seconds') RETURNING id`)[0]!.id;
    const reference='wamid.previous.'+randomUUID();
    await db`INSERT INTO conversation_message(conversation_id,connection_id,sender_id,direction,author_type,body,provider_message_id,delivery_state)
      VALUES(${cv},${connection},${sender},'INBOUND','CUSTOMER','Previous thread message',${reference},'RECEIVED')`;
    return {lead,cv,reference};
  }
  const old=await closedThread();
  const read=async(id:string)=>(await db`SELECT state,failure_code,lead_id,conversation_id FROM integration_event WHERE id=${id}`)[0]!;
  const snapshot=async(id:string)=>(await db`SELECT state,controller_type,controller_user_id,version,closed_at::text AS closed_at,sender_id
    FROM conversation WHERE id=${id}`)[0]!;
  const before=await snapshot(old.cv);
  const textMessage=(contextId?:string,secondsAgo=0)=>({id:'wamid.returning.'+randomUUID(),from:phone.slice(1),type:'text',
    timestamp:String(Math.floor(Date.now()/1000)-secondsAgo),text:{body:'Synthetic returning customer'},
    ...(contextId ? {context:{id:contextId}} : {})});
  async function webhook(message:ReturnType<typeof textMessage>,valid=true){
    const raw=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'123456789',changes:[{field:'messages',value:{
      messaging_product:'whatsapp',metadata:{phone_number_id:'15550001111'},messages:[message]}}]}]});
    return app.inject({method:'POST',url:`/api/webhooks/messaging/meta/${connection}`,payload:raw,headers:{
      'content-type':'application/json','x-hub-signature-256':`sha256=${createHmac('sha256',valid?credentials.appSecret:'wrong-test-key').update(raw).digest('hex')}`}});
  }
  async function received(message:ReturnType<typeof textMessage>){
    const response=await webhook(message);
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().created,1);
    return (await db`SELECT id FROM integration_event WHERE connection_id=${connection} AND payload->'message'->>'id'=${message.id}`)[0]!.id as string;
  }
  assert.equal((await webhook(textMessage(old.reference),false)).statusCode,403);
  const review=await received(textMessage(old.reference));
  assert.equal(await processOneInboundEvent(db),true);
  assert.equal((await read(review)).failure_code,'CLOSED_CONVERSATION');
  const reviewPath=`/api/messaging/connections/${connection}/inbound-review/${review}`;
  assert.equal((await scoped('GET',reviewPath,'other')).statusCode,404);
  assert.equal((await scoped('POST',reviewPath+'/resolve','manager',{leadId:old.lead})).json().reason,'CLOSED_CONVERSATION');

  const config=await scoped('PUT',`/api/ai/campaigns/${campaign}/behavior-policy`,'manager',{version:0,reason:'Explicit return rule',
    definition:{...emptyAIBehaviorPolicy(),returningContact:{closedConversation:'REOPEN_EXISTING',closedLead:'REVIEW'}}});
  assert.equal(config.statusCode,200,config.body);
  const previouslySent=await received(textMessage(old.reference,60));
  await processOneInboundEvent(db);
  assert.equal((await read(previouslySent)).failure_code,'RETURNING_INBOUND_STALE');
  const unsigned=textMessage(old.reference);
  const unsignedEvent=(await db`INSERT INTO integration_event(connection_id,provider_event_id,event_kind,sender_id,participant_ref,payload)
    VALUES(${connection},${unsigned.id},'INBOUND_MESSAGE',${sender},${phone},${db.json({senderExternalId:'15550001111',message:unsigned})}) RETURNING id`)[0]!.id;
  await processOneInboundEvent(db);
  assert.equal((await read(unsignedEvent)).failure_code,'RETURNING_INBOUND_AUTHENTICATION_REQUIRED');
  assert.deepEqual(await snapshot(old.cv),before);

  const fallback=textMessage();
  const fallbackEvent=await received(fallback);
  await processOneIntegrationEvent(db,'INBOUND_MESSAGE',async(tx,id)=>{
    assert.equal(id,fallbackEvent);
    const result=await processInboundEvent(tx,id);
    assert.equal(result.state,'PROCESSED');
    throw new Error('Synthetic rollback after attachment');
  });
  assert.deepEqual(await snapshot(old.cv),before);
  assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='CONVERSATION_REOPENED_BY_INBOUND'`)[0]!.n,0);
  await db`UPDATE integration_event SET processing_available_at=now() WHERE id=${fallbackEvent}`;
  assert.deepEqual((await Promise.all([processOneInboundEvent(db),processOneInboundEvent(db)])).sort(),[false,true]);
  assert.deepEqual(await read(fallbackEvent),{state:'PROCESSED',failure_code:null,lead_id:old.lead,conversation_id:old.cv});
  assert.equal((await webhook(fallback)).json().created,0);
  assert.deepEqual(await snapshot(old.cv),{...before,state:'WAITING_FOR_HUMAN',version:before.version+1});
  const messages=await db`SELECT body FROM conversation_message WHERE conversation_id=${old.cv} ORDER BY created_at`;
  assert.deepEqual(messages.map(row=>row.body),['Previous thread message','Synthetic returning customer']);

  const target=await closedThread();
  const competing=await closedThread();
  const taken=await scoped('POST',`/api/conversations/${old.cv}/takeover`,'agent',{version:before.version+1,reason:'Review returning person'});
  assert.equal(taken.statusCode,200,taken.body);
  const close=await scoped('POST',`/api/conversations/${old.cv}/close`,'agent',{version:taken.json().version,reason:'Conversation completed'});
  assert.equal(close.statusCode,200,close.body);
  const ambiguous=await received(textMessage());
  await processOneInboundEvent(db);
  assert.equal((await read(ambiguous)).failure_code,'MULTIPLE_RETURNING_CONVERSATIONS');
  const exact=await received(textMessage(target.reference));
  await processOneInboundEvent(db);
  assert.equal((await read(exact)).conversation_id,target.cv);
  assert.equal((await snapshot(competing.cv)).state,'CLOSED');
  const archived=await scoped('POST',`/api/leads/${competing.lead}/lifecycle`,'manager',{lifecycle:'ARCHIVED'});
  assert.equal(archived.statusCode,200,archived.body);
  const archiveEvent=await received(textMessage(competing.reference));
  await processOneInboundEvent(db);
  assert.equal((await read(archiveEvent)).failure_code,'ARCHIVED_LEAD_REQUIRES_REVIEW');
  assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='CONVERSATION_REOPENED_BY_INBOUND'`)[0]!.n,2);
  assert.equal((await db`SELECT count(*)::int AS n FROM lead_activity WHERE event_type='CONVERSATION_REOPENED_BY_INBOUND'`)[0]!.n,2);
  assert.equal((await db`SELECT count(*)::int AS n FROM conversation_message WHERE direction='OUTBOUND'`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::int AS n FROM ai_customer_proposal`)[0]!.n,0);
});
