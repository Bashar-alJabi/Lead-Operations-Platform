import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealSecret } from '../src/credentials.js';
import { sha256 } from '../src/security.js';

const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test'||!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))
 throw Error('Isolated local TEST_DATABASE_URL required');

test('Staff sender reservations enforce branch scope, preserve customer pins and receive signed callbacks separately',async t=>{
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
 for(const [name,role,scope] of [['manager','MANAGER',branch],['other','MANAGER',other],['agent','AGENT',branch]] as const){
  const {id}=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
   VALUES(${org},${scope},${role},${name},${name+'@staff-sender.test'},'synthetic') RETURNING id`)[0]!;
  const token=randomBytes(32).toString('hex');
  await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour')`;
  cookies[name]='lop_session='+token;
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
});
