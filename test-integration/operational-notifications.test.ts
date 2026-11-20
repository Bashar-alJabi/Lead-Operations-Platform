import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealSecret } from '../src/credentials.js';
import { processOneInboundEvent } from '../src/messaging/inbound-events.js';
import { processOneEmailPublication } from '../src/notification-email-outbox.js';
import { processOneNotificationEmail } from '../src/notification-email-dispatch.js';
import { processOneLeadAttentionNotification } from '../src/lead-attention-notifications.js';
import { processOneOperationalNotification } from '../src/operational-notifications.js';
import { sha256 } from '../src/security.js';

const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test'||!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))
 throw Error('Isolated local TEST_DATABASE_URL required');
const origin='http://127.0.0.1:5173';

async function fixture(t:import('node:test').TestContext){
 process.env.APP_ORIGIN=origin;
 process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const db=createDatabase(url);
 await db.begin(async tx=>{
  await tx`SET LOCAL client_min_messages TO warning`;
  await tx`TRUNCATE background_job CASCADE`;
  await tx`TRUNCATE organization CASCADE`;
 });
 const {id:org}=(await db`INSERT INTO organization(name) VALUES('Alert organization') RETURNING id`)[0]!;
 const {id:foreign}=(await db`INSERT INTO organization(name) VALUES('Foreign alert organization') RETURNING id`)[0]!;
 const {id:branch}=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Branch A') RETURNING id`)[0]!;
 const {id:other}=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Branch B') RETURNING id`)[0]!;
 const actors:Record<string,string>={};
 for(const [name,role,branchId,organizationId] of [
  ['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',other,org],
  ['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreign],
 ] as const){
  const {id}=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
   VALUES(${organizationId},${branchId},${role},${name},${name+'@ops-alert.test'},'synthetic') RETURNING id`)[0]!;
  const token=randomBytes(32).toString('hex');
  await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour')`;
  actors[name]='lop_session='+token;
 }
 const app=await buildApp(db,{logger:false,globalRateLimitMax:10000,
  operationalEmailAdapters:{SMTP:{verify:async()=>{},send:async()=>assert.fail('Production SMTP adapter called')}}});
 t.after(async()=>{await app.close();await db.end();});
 const api=(method:'GET'|'POST'|'PUT',route:string,actor='manager',payload?:object)=>app.inject({
  method,url:route,headers:{origin,cookie:actors[actor]!},payload,
 });
 async function publish(){
  for(let i=0;i<25;i++)if(!await processOneOperationalNotification(db))return;
  assert.fail('Unexpected operational publication backlog');
 }
 return {db,app,api,publish,org,branch};
}

test('Verified unmatched inbound alerts share the notification feed, current ACLs, review and scoped email delivery',async t=>{
 const {db,app,api,publish,org,branch}=await fixture(t);
 const {id:connection}=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config)
  VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Branch connection','CONNECTED','{"wabaId":"123456789","graphVersion":"v25.0"}')
  RETURNING id`)[0]!;
 const {id:organizationConnection}=(await db`INSERT INTO integration_connection(organization_id,kind,provider,name,status)
  VALUES(${org},'MESSAGING','META_WHATSAPP_CLOUD','Organization connection','CONNECTED') RETURNING id`)[0]!;
 const appSecret='synthetic-operational-alert';
 const sealed=sealSecret(connection,JSON.stringify({appSecret,accessToken:'synthetic-token',verifyToken:'synthetic-verify'}));
 await db`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag) VALUES(${connection},${sealed.ciphertext},${sealed.nonce},${sealed.authTag})`;

 const created=await api('POST','/api/email/connections','manager',{name:'Synthetic alert mail',settings:{
  host:'smtp.example.test',port:465,secure:true,username:'synthetic',fromAddress:'alerts@example.test',
 },password:'SyntheticPassword_NotReal',reason:'Synthetic alert settings'});
 assert.equal(created.statusCode,201,created.body);
 const email=created.json().id;
 assert.equal((await api('POST','/api/email/connections/'+email+'/test','manager',{version:1})).statusCode,200);
 assert.equal((await api('PUT','/api/notification-email/branches/'+branch,'manager',{version:0,enabled:true,connectionId:email,reason:'Alert email testing'})).statusCode,200);
 assert.equal((await api('PUT','/api/notification-email/preferences/INBOUND_REVIEW_REQUIRED','manager',{version:0,enabled:true,language:'fr'})).statusCode,200);

 const payload=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'123456789',changes:[{field:'messages',value:{
  messaging_product:'whatsapp',metadata:{phone_number_id:'15550000123'},messages:[{
   id:'wamid.ops-alert',from:'15550000987',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'private message body'},
  }],
 }}]}]});
 const webhook=()=>app.inject({method:'POST',url:'/api/webhooks/messaging/meta/'+connection,payload,headers:{
  'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',appSecret).update(payload).digest('hex'),
 }});
 assert.equal((await webhook()).json().created,1);
 assert.equal((await webhook()).json().created,0);
 assert.equal(await processOneOperationalNotification(db),false,'Pending receipt is not an unresolved notification');
 assert.equal(await processOneInboundEvent(db),true);
 const {id:event}=(await db`SELECT id FROM integration_event WHERE connection_id=${connection}`)[0]!;
 const {id:source}=(await db`SELECT id FROM operational_notification_source WHERE inbound_event_id=${event}`)[0]!;
 await assert.rejects(db`INSERT INTO notification_event(event_type,operational_source_id)
  VALUES('INBOUND_REVIEW_REQUIRED',${source})`,/OPERATIONAL_NOTIFICATION_PUBLICATION_REQUIRED/);
 const results=await Promise.all([processOneOperationalNotification(db),processOneOperationalNotification(db)]);
 assert.equal(results.filter(Boolean).length,1);

 // Healthy transitions close the alert and repeating a status cannot produce another occurrence.
 await db`UPDATE integration_connection SET status='ERROR',last_error_code='private provider diagnosis' WHERE id=${connection}`;
 await db`UPDATE integration_connection SET status='ERROR' WHERE id=${connection}`;
 await db`UPDATE integration_connection SET status='AUTH_EXPIRED' WHERE id=${organizationConnection}`;
 await publish();
 const list=async(actor='manager')=>(await api('GET','/api/notifications?language=en&limit=20',actor)).json().items;
 const manager=await list();
 assert.equal(manager.length,2);
 assert.equal((await list('admin')).length,3);
 for(const actor of ['other','agent','foreign'])assert.deepEqual(await list(actor),[]);
 assert.doesNotMatch(JSON.stringify(manager),/private message body|private provider diagnosis|15550000987/);
 const inbound=manager.find((item:{eventType:string})=>item.eventType==='INBOUND_REVIEW_REQUIRED');
 assert.equal(inbound.leadId,null);
 assert.equal(inbound.conversationId,null);
 assert.deepEqual(inbound.operational,{
  condition:'UNRESOLVED',current:true,connectionId:connection,inboundEventId:event,integrationKind:'MESSAGING',integrationName:'Branch connection',
 });
 assert.equal((await api('GET','/api/notifications/indicator')).json().hasUnread,true);
 const noticePath='/api/notifications/'+inbound.id;
 assert.equal((await api('PUT',noticePath+'/state','other',{version:0,isRead:true})).statusCode,404);
 assert.equal((await api('PUT',noticePath+'/state','manager',{version:0,isRead:true})).statusCode,200);
 assert.equal((await api('GET',noticePath+'/history')).json().items[0].is_read,true);

 while(await processOneEmailPublication(db)){}
 const mockMessages: {to:string;subject:string;text:string}[]=[];
 assert.equal(await processOneNotificationEmail(db,async(_settings,_password,message)=>{mockMessages.push(message);}),true);
 assert.equal(await processOneNotificationEmail(db,async()=>assert.fail('Unexpected duplicate dispatch')),false);
 assert.equal(mockMessages.length,1);
 assert.equal(mockMessages[0]!.to,'manager@ops-alert.test');
 assert.equal(mockMessages[0]!.subject,'Message entrant à examiner');
 assert.doesNotMatch(mockMessages[0]!.text,/private message body|15550000987/);
 const review='/api/messaging/connections/'+connection+'/inbound-review/'+event;
 assert.equal((await api('GET',review,'other')).statusCode,404);
 assert.equal((await api('POST',review+'/ignore','manager',{reason:'Synthetic disposition'})).statusCode,200);
 await db`UPDATE integration_connection SET status='CONNECTED' WHERE id=${connection}`;
 assert.equal((await list()).every((item:{operational:{current:boolean}})=>!item.operational.current),true);
 assert.equal((await api('PUT','/api/notification-preferences/INTEGRATION_ALERT','manager',{version:0,enabled:false})).statusCode,200);
 assert.equal((await list()).length,1);
 assert.equal((await api('GET','/api/notifications/indicator')).json().hasUnread,false);
});

test('A genuine dead-letter produces a scoped system alert and recovers publication without repeating the source',async t=>{
 const {db,api,publish,org,branch}=await fixture(t);
 const {id:campaign}=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES(${org},${branch},'Campaign') RETURNING id`)[0]!;
 await db`INSERT INTO lead(organization_id,branch_id,campaign_id,source_kind,needs_attention_reason)
  VALUES(${org},${branch},${campaign},'MANUAL','LEAD_UNASSIGNED')`;
 await db`CREATE FUNCTION reject_scoped_alert_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.event_type IN ('LEAD_NEEDS_ATTENTION','SYSTEM_ALERT') THEN RAISE EXCEPTION 'Synthetic publication failure'; END IF; RETURN NEW; END $$`;
 await db`CREATE TRIGGER reject_scoped_alert_fixture BEFORE INSERT ON notification_event FOR EACH ROW EXECUTE FUNCTION reject_scoped_alert_fixture()`;
 try{
  for(let failure=1;failure<=5;failure++){
   assert.equal(await processOneLeadAttentionNotification(db),true);
   if(failure<5)await delay(2**(failure-1)*1000+80);
  }
  for(let failure=1;failure<=5;failure++){
   assert.equal(await processOneOperationalNotification(db),true);
   if(failure<5)await delay(2**(failure-1)*1000+80);
  }
 }finally{
  await db`DROP TRIGGER reject_scoped_alert_fixture ON notification_event`;
  await db`DROP FUNCTION reject_scoped_alert_fixture()`;
 }
 const base='/api/notifications/operational/failures';
 const [failure]=(await api('GET',base)).json().items;
 assert.equal(failure.eventType,'SYSTEM_ALERT');
 assert.deepEqual((await api('GET',base,'other')).json().items,[]);
 const path=base+'/'+failure.id+'/retry';
 assert.equal((await api('POST',path,'other',{version:failure.version})).statusCode,404);
 assert.equal((await api('POST',path,'manager',{version:failure.version})).statusCode,200);
 assert.equal((await api('POST',path,'manager',{version:failure.version})).statusCode,409);
 await publish();
 const [alert]=(await api('GET','/api/notifications')).json().items;
 assert.equal(alert.eventType,'SYSTEM_ALERT');
 assert.equal(alert.leadId,null);
 assert.equal(alert.operational.current,true);
 const leadRecovery='/api/notifications/lead-attention/failures';
 const [leadFailure]=(await api('GET',leadRecovery)).json().items;
 assert.equal((await api('POST',leadRecovery+'/'+leadFailure.id+'/retry','manager',{version:leadFailure.version})).statusCode,200);
 assert.equal(await processOneLeadAttentionNotification(db),true);
 const alerts=(await api('GET','/api/notifications')).json().items;
 assert.equal(alerts.find((item:{eventType:string})=>item.eventType==='SYSTEM_ALERT').operational.current,false);
 assert.equal(await processOneOperationalNotification(db),false);
});
