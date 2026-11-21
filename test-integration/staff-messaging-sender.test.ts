import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealSecret } from '../src/credentials.js';
import { sha256 } from '../src/security.js';
import { processOneStaffMessagingPublication } from '../src/staff-messaging-outbox.js';
import { processOneStaffMessagingDispatch, type StaffMessagingTransports } from '../src/staff-messaging-dispatch.js';
import { ProviderSendError } from '../src/messaging/providers.js';

const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test'||!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))
 throw Error('Isolated local TEST_DATABASE_URL required');

test('Staff sender reservations isolate callbacks and authorize only scoped static templates and consenting preferences',async t=>{
 const origin='http://127.0.0.1:5173';
 process.env.APP_ORIGIN=origin;
 process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
 t.after(async()=>{await app.close();await db.end();});
 await db.begin(async tx=>{
  await tx`SET LOCAL client_min_messages TO warning`;
  await tx`TRUNCATE background_job CASCADE`;
  await tx`TRUNCATE organization CASCADE`;
 });
 const {id:org}=(await db`INSERT INTO organization(name) VALUES('Staff sender org') RETURNING id`)[0]!;
 const {id:branch}=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Staff branch') RETURNING id`)[0]!;
 const {id:other}=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Other branch') RETURNING id`)[0]!;
 const cookies:Record<string,string>={};
 const accounts:Record<string,string>={};
 for(const [name,role,scope] of [['manager','MANAGER',branch],['other','MANAGER',other],['agent','AGENT',branch]] as const){
  const {id}=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
   VALUES(${org},${scope},${role},${name},${name+'@staff-sender.test'},'synthetic') RETURNING id`)[0]!;
  const token=randomBytes(32).toString('hex');
  await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour')`;
  cookies[name]='lop_session='+token;
  accounts[name]=id;
 }
 const api=(method:'GET'|'POST'|'PATCH'|'PUT',path:string,actor='manager',payload?:object)=>
  app.inject({method,url:path,headers:{origin,cookie:cookies[actor]!},payload});
 const {id:connection}=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config)
  VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic Staff Connection','CONNECTED',
   '{"wabaId":"4242424242","graphVersion":"v25.0"}') RETURNING id`)[0]!;
 const {id:aliasConnection}=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name)
  VALUES(${org},${other},'MESSAGING','META_WHATSAPP_CLOUD','Alias synthetic connection') RETURNING id`)[0]!;
 const secret='synthetic-notification-only-app-secret';
 const sealed=sealSecret(connection,JSON.stringify({appSecret:secret,accessToken:'synthetic-token',verifyToken:'synthetic-verify'}));
 await db`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag) VALUES(${connection},${sealed.ciphertext},${sealed.nonce},${sealed.authTag})`;
 const sender=async(external:string,conn=connection)=>(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,capabilities)
  VALUES(${org},${conn},${external},'Synthetic sender','HEALTHY','{"text":true,"template":true}') RETURNING id`)[0]!.id as string;
 const customer=await sender('15550555001'),staff=await sender('15550555002'),shared=await sender('15550555003');
 await sender('15550555003',aliasConnection);
 await db`UPDATE branch SET default_sender_id=${customer} WHERE id=${branch}`;
 const reserve=(id:string,actor='manager',version=1)=>api('POST',`/api/messaging/senders/${id}/reserve-for-staff`,actor,{version,reason:'Dedicated synthetic staff notifications'});
 assert.equal((await reserve(customer)).json().error,'STAFF_SENDER_CUSTOMER_USE');
 assert.equal((await reserve(shared)).json().error,'STAFF_SENDER_EXTERNAL_ID_SHARED');
 assert.equal((await reserve(staff,'other')).statusCode,404);
 assert.equal((await reserve(staff,'agent')).statusCode,403);
 const results=await Promise.all(Array.from({length:4},()=>reserve(staff)));
 assert.equal(results.filter(r=>r.statusCode===201).length,1);
 assert.equal(results.filter(r=>r.statusCode===409).length,3);
 assert.equal((await reserve(staff,'manager',2)).statusCode,409);
 assert.equal((await api('PATCH','/api/messaging/senders/'+staff,'manager',{version:2,operatorEnabled:true})).statusCode,409);
 await assert.rejects(db`UPDATE messaging_sender SET operator_enabled=true WHERE id=${staff}`,/STAFF_SENDER_CUSTOMER_USE/);
 await assert.rejects(db`UPDATE branch SET default_sender_id=${staff} WHERE id=${branch}`,/STAFF_SENDER_CUSTOMER_USE/);
 await assert.rejects(sender('15550555002',aliasConnection),/STAFF_SENDER_EXTERNAL_ID_RESERVED/);
 const branchConfig=(await api('GET',`/api/messaging/branches/${branch}/senders`)).json().items;
 assert.equal(branchConfig.some((row:{id:string})=>row.id===staff),false);
 assert.equal(branchConfig.some((row:{id:string})=>row.id===customer),true);
 const list=(await api('GET',`/api/messaging/connections/${connection}/senders`)).json().items;
 assert.equal(list.find((row:{id:string})=>row.id===staff).staff_only,true);
 assert.equal(list.find((row:{id:string})=>row.id===staff).operator_enabled,false);

 const time=String(Math.floor(Date.now()/1000));
 const changes=(number:string,suffix:string,status=false)=>({field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:number},
  messages:[{id:'wamid.synthetic-'+suffix,from:'15550090105',timestamp:time,type:'text',text:{body:'private synthetic staff reply'}}],
  ...(status?{statuses:[{id:'wamid.synthetic-receipt',status:'delivered',timestamp:time,recipient_id:'15550090105'}]}:{}),
 }});
 const raw=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'4242424242',changes:[
  changes('15550555002','staff',true),changes('15550555001','customer'),
 ]}]});
 const webhook=(valid:boolean)=>app.inject({method:'POST',url:'/api/webhooks/messaging/meta/'+connection,payload:raw,headers:{
  'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',valid?secret:'invalid').update(raw).digest('hex'),
 }});
 assert.equal((await webhook(false)).statusCode,403);
 assert.equal((await webhook(true)).json().created,3);
 assert.equal((await webhook(true)).json().created,0);
 const receipts=await db`SELECT * FROM staff_messaging_webhook_receipt`;
 assert.equal(receipts.length,2);
 assert.doesNotMatch(JSON.stringify(receipts),/15550090105|private synthetic staff reply|wamid/);
 assert.equal((await db`SELECT count(*)::int AS count FROM integration_event WHERE connection_id=${connection}`)[0]!.count,1);
 assert.equal((await db`SELECT count(*)::int AS count FROM audit_log WHERE target_id=${staff} AND action='STAFF_MESSAGING_SENDER_RESERVED'`)[0]!.count,1);

 const template=async(externalId:string,language:string,body:string,conn=connection,status='APPROVED')=>
  (await db`INSERT INTO provider_message_template(connection_id,external_template_id,name,language,status,components)
   VALUES(${conn},${externalId},${externalId},${language},${status},${db.json([{type:'BODY',text:body}])}) RETURNING id`)[0]!.id as string;
 const staticCopy='A staff alert is available in the platform.';
 const good=await template('staff_notice','en_US',staticCopy);
 const dynamic=await template('dynamic_staff_notice','en_US','This text includes {{1}}.');
 const otherLanguage=await template('french_staff_notice','fr','Une alerte interne.');
 const otherConnection=await template('other_staff_notice','en_US',staticCopy,aliasConnection);
 const pending=await template('pending_staff_notice','en_US',staticCopy,connection,'PENDING');
 const binding=`/api/notification-messaging/branches/${branch}/bindings/LEAD_ASSIGNED/en`;
 const update={version:0,enabled:true,senderId:staff,templateId:good,reason:'Approve the staff alert'};
 assert.equal((await api('GET',binding+'/options','other')).statusCode,404);
 assert.equal((await api('GET',binding+'/options','agent')).statusCode,403);
 const catalog=(await api('GET',binding+'/options')).json();
 assert.deepEqual(catalog.items.map((row:{templateId:string;preview:string})=>[row.templateId,row.preview]),[[good,staticCopy]]);
 for(const templateId of [dynamic,otherLanguage,otherConnection,pending]){
  const rejected=await api('PUT',binding,'manager',{...update,templateId});
  assert.equal(rejected.statusCode,409,rejected.body);
 }
 assert.equal((await api('PUT',binding,'manager',{...update,senderId:customer})).statusCode,409);
 const changesRace=await Promise.all(Array.from({length:4},()=>api('PUT',binding,'manager',update)));
 assert.equal(changesRace.filter(r=>r.statusCode===200).length,1);
 assert.equal(changesRace.filter(r=>r.statusCode===409).length,3);
 assert.equal((await api('GET',binding)).json().binding.templateCurrent,true);
 await db`UPDATE provider_message_template SET components='[{"type":"BODY","text":"New static wording"}]' WHERE id=${good}`;
 assert.equal((await api('GET',binding)).json().binding.templateCurrent,false);
 assert.equal((await api('PUT',binding,'manager',{...update,version:1,enabled:false})).statusCode,200);
 assert.equal((await api('GET',binding+'/history')).json().items.length,2);
 await assert.rejects(db`DELETE FROM staff_messaging_configuration_history`,/STAFF_MESSAGING_CONFIGURATION_HISTORY_IMMUTABLE/);

 const personal='/api/notification-messaging/preferences';
 const settings={version:0,enabled:true,language:'en'};
 assert.equal((await api('GET',personal,'agent')).json().items.length,11);
 assert.equal((await api('PUT',personal+'/SYSTEM_ALERT','agent',settings)).statusCode,403);
 assert.equal((await api('PUT',personal+'/LEAD_ASSIGNED','agent',settings)).statusCode,409);
 const syntheticPhone='+15550090105';
 assert.equal((await api('PUT',`/api/users/${accounts.agent}/notification-messaging-destination`,'manager',{version:0,phone:syntheticPhone})).statusCode,200);
 assert.equal((await api('PUT','/api/notification-messaging/destination','agent',{version:1,enabled:true,phone:syntheticPhone})).statusCode,200);
 assert.equal((await api('PUT',personal+'/LEAD_ASSIGNED','agent',settings)).statusCode,200);
 assert.equal((await api('PUT',personal+'/LEAD_ASSIGNED','agent',settings)).statusCode,409);
 assert.equal((await api('GET',personal+'/LEAD_ASSIGNED/history','agent')).json().items[0].snapshot.enabled,true);
 assert.equal((await api('GET',personal+'/LEAD_ASSIGNED/history','manager')).json().items.length,0);

 // Real Lead assignment writes the event; subsequent routing and preference changes still fence the outbox.
 assert.equal((await api('PUT',binding,'manager',{...update,version:2})).statusCode,200);
 const campaignResponse=await api('POST','/api/campaigns','manager',{branchId:branch,name:'Staff publication campaign',routingMethod:'MANUAL'});
 assert.equal(campaignResponse.statusCode,201,campaignResponse.body);
 const campaign=campaignResponse.json().id;
 assert.equal((await api('POST',`/api/campaigns/${campaign}/activate`)).statusCode,200);
 const createLead=async(name:string,phone:string)=>{
  const create=await api('POST','/api/leads','manager',{branchId:branch,campaignId:campaign,contact:{name,phone}});
  assert.equal(create.statusCode,201,create.body);
  return create.json().id as string;
 };
 const target=await createLead('First publication','+15550678001');
 const assign=(id:string,version:number,agentId:string|null)=>api('POST',`/api/leads/${id}/assignment`,'manager',
  {version,agentId,reason:'Staff publication fixture'});
 assert.equal((await assign(target,1,accounts.agent!)).statusCode,200);
 const outbox='/api/notification-messaging/outbox';
 assert.deepEqual((await api('GET',outbox,'agent')).json().items,[]);
 await db`CREATE FUNCTION fail_staff_audience_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.action='STAFF_MESSAGING_AUDIENCE_PREPARED' THEN RAISE EXCEPTION 'Synthetic Audit failure'; END IF; RETURN NEW; END $$`;
 await db`CREATE TRIGGER fail_staff_audience_audit_fixture BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION fail_staff_audience_audit_fixture()`;
 try {
  assert.equal(await processOneStaffMessagingPublication(db),true);
  assert.equal((await db`SELECT failures FROM staff_messaging_publication`)[0]!.failures,1);
  assert.equal((await db`SELECT count(*)::int n FROM staff_messaging_outbox`)[0]!.n,0);
 } finally {
  await db`DROP TRIGGER fail_staff_audience_audit_fixture ON audit_log`;
  await db`DROP FUNCTION fail_staff_audience_audit_fixture()`;
 }
 await delay(1100);
 const copies=await Promise.all(Array.from({length:5},()=>processOneStaffMessagingPublication(db)));
 assert.equal(copies.filter(Boolean).length,1);
 const [prepared]=(await api('GET',outbox,'agent')).json().items;
 assert.equal(prepared.eventType,'LEAD_ASSIGNED');
 assert.equal(prepared.language,'en');
 assert.equal(prepared.state,'PREPARED');
 assert.doesNotMatch(JSON.stringify(prepared),/15550090105|First publication/);
 assert.deepEqual((await api('GET',outbox,'manager')).json().items,[]);
 assert.equal((await api('PUT','/api/notification-messaging/destination','agent',{version:2,enabled:false,phone:null})).statusCode,200);
 assert.equal((await api('GET',outbox,'agent')).json().items[0].state,'SUPPRESSED');
 let sends=0;
 const adapters:StaffMessagingTransports={META_WHATSAPP_CLOUD:async()=>{sends++;return {providerMessageId:'wamid.synthetic-staff'};}};
 assert.equal(await processOneStaffMessagingDispatch(db,adapters),true);
 assert.equal(sends,0);
 assert.equal((await assign(target,2,null)).statusCode,200);
 assert.deepEqual((await api('GET',outbox,'agent')).json().items,[]);

 const later=await createLead('After the consent withdrawal','+15550678002');
 assert.equal((await assign(later,1,accounts.agent!)).statusCode,200);
 assert.equal((await api('PUT','/api/notification-messaging/destination','agent',{version:3,enabled:true,phone:syntheticPhone})).statusCode,200);
 assert.equal(await processOneStaffMessagingPublication(db),true);
 assert.deepEqual((await api('GET',outbox,'agent')).json().items,[],'Late consent cannot prepare a historical event');
 assert.equal((await db`SELECT count(*)::int n FROM staff_messaging_outbox`)[0]!.n,1);
 const stale=await createLead('Binding cancelled before materialization','+15550678003');
 assert.equal((await assign(stale,1,accounts.agent!)).statusCode,200);
 assert.equal((await api('PUT',binding,'manager',{...update,version:3,enabled:false})).statusCode,200);
 assert.equal(await processOneStaffMessagingPublication(db),true);
 assert.equal((await db`SELECT count(*)::int n FROM staff_messaging_publication WHERE state='SUPPRESSED'`)[0]!.n,1);

 assert.equal((await api('PUT',binding,'manager',{...update,version:4})).statusCode,200);
 async function queue(name:string,phone:string){
  const lead=await createLead(name,phone);
  assert.equal((await assign(lead,1,accounts.agent!)).statusCode,200);
  assert.equal(await processOneStaffMessagingPublication(db),true);
  return (await api('GET',outbox,'agent')).json().items[0].id as string;
 }
 const accepted=await queue('Customer data must stay private','+15550678004');
 assert.equal(await processOneStaffMessagingDispatch(db,null),false);
 const provider:StaffMessagingTransports={META_WHATSAPP_CLOUD:async input=>{
  sends++;
  assert.equal(input.recipient,syntheticPhone);
  assert.equal(input.externalSenderId,'15550555002');
  assert.equal(input.templateName,'staff_notice');
  assert.equal(input.templateLanguage,'en_US');
  assert.equal(input.bodyParameters,undefined);
  assert.doesNotMatch(JSON.stringify(input),/Customer data|15550678004/);
  assert.equal((await db`SELECT state FROM staff_messaging_dispatch WHERE event_id=${accepted}`)[0]!.state,'SENDING');
  return {providerMessageId:'wamid.synthetic-staff-accepted'};
 }};
 const claimed=await Promise.all(Array.from({length:5},()=>processOneStaffMessagingDispatch(db,provider)));
 assert.equal(claimed.filter(Boolean).length,1);
 assert.equal(sends,1);
 const acceptedHistory=await api('GET',`${outbox}/${accepted}/history`,'agent');
 assert.deepEqual(acceptedHistory.json().items.map((r:{state:string})=>r.state),['ACCEPTED','SENDING','WAITING']);
 assert.doesNotMatch(acceptedHistory.body,/wamid|15550090105/);
 assert.equal((await api('GET',`${outbox}/${accepted}/history`,'manager')).statusCode,404);

 const lost=await queue('Ambiguous acknowledgement','+15550678005');
 assert.equal(await processOneStaffMessagingDispatch(db,{META_WHATSAPP_CLOUD:async()=>{sends++;throw Error('synthetic acknowledgement loss');}}),true);
 assert.equal((await api('GET',outbox,'agent')).json().items.find((r:{id:string})=>r.id===lost).state,'UNKNOWN');
 assert.equal(await processOneStaffMessagingDispatch(db,adapters),false);
 await assert.rejects(db`UPDATE staff_messaging_dispatch SET version=version+1,state='WAITING' WHERE event_id=${lost}`,
  /STAFF_MESSAGING_DISPATCH_TRANSITION_INVALID/);
 assert.equal(sends,2);

 const limited=await queue('Provider rate limit','+15550678006');
 assert.equal(await processOneStaffMessagingDispatch(db,{META_WHATSAPP_CLOUD:async()=>{
  sends++;throw new ProviderSendError('RETRYABLE','PROVIDER_RATE_LIMITED',1);
 }}),true);
 assert.equal(await processOneStaffMessagingDispatch(db,adapters),false);
 assert.equal((await api('GET',outbox,'agent')).json().items.find((r:{id:string})=>r.id===limited).state,'RETRYING');
 await delay(1150);
 assert.equal(await processOneStaffMessagingDispatch(db,adapters),true);
 assert.equal((await api('GET',outbox,'agent')).json().items.find((r:{id:string})=>r.id===limited).state,'ACCEPTED');
 assert.equal((await db`SELECT attempts FROM staff_messaging_dispatch WHERE event_id=${limited}`)[0]!.attempts,2);
 assert.equal(sends,4);
});
