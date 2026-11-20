import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';

const url=process.env.TEST_DATABASE_URL;
if(!url || new URL(url).pathname!=='/lead_operations_test' || !['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))
 throw Error('Isolated local TEST_DATABASE_URL required');
const origin='http://127.0.0.1:5173';

test('Staff messaging destination requires scoped administration and personal consent, with native retention and no customer writes',async t=>{
 process.env.APP_ORIGIN=origin;
 const db=createDatabase(url);
 const app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
 t.after(async()=>{await app.close();await db.end();});
 await db.begin(async tx=>{
  await tx`SET LOCAL client_min_messages TO warning`;
  await tx`TRUNCATE background_job CASCADE`;
  await tx`TRUNCATE organization CASCADE`;
 });
 const {id:org}=(await db`INSERT INTO organization(name) VALUES('Staff messaging') RETURNING id`)[0]!;
 const {id:foreignOrg}=(await db`INSERT INTO organization(name) VALUES('Foreign staff messaging') RETURNING id`)[0]!;
 const {id:a}=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!;
 const {id:b}=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!;
 const actors=new Map<string,{id:string;sid:string;cookie:string}>();
 for(const [name,role,branch,organization] of [
  ['admin','SUPER_ADMIN',null,org],['foreign','SUPER_ADMIN',null,foreignOrg],['manager','MANAGER',a,org],
  ['other','MANAGER',b,org],['agent','AGENT',a,org],['second','AGENT',a,org],
 ] as const){
  const {id}=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
   VALUES(${organization},${branch},${role},${name},${name+'@staff.example.test'},'synthetic') RETURNING id`)[0]!;
  const token=randomBytes(32).toString('hex');
  const {id:sid}=(await db`INSERT INTO user_session(user_id,token_hash,expires_at)
   VALUES(${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!;
  actors.set(name,{id,sid,cookie:'lop_session='+token});
 }
 const api=(method:'GET'|'PUT'|'PATCH',path:string,who:string,payload?:object)=>app.inject({method,url:path,
  headers:{origin,cookie:actors.get(who)!.cookie},payload});
 const agent=actors.get('agent')!,manager=actors.get('manager')!;
 const staff=(name:string)=>'/api/users/'+actors.get(name)!.id+'/notification-messaging-destination';
 const self='/api/notification-messaging/destination';
 const phone='+15552341021',replacement='+15552341039';
 assert.equal((await api('GET',staff('agent'),'agent')).statusCode,403);
 for(const who of ['other','foreign']){
  assert.equal((await api('GET',staff('agent')+'/history',who)).statusCode,404);
  assert.equal((await api('PUT',staff('agent'),who,{version:0,phone})).statusCode,404);
 }
 assert.equal((await api('PUT',staff('manager'),'manager',{version:0,phone})).statusCode,404);
 assert.equal((await api('PUT',staff('agent'),'manager',{version:'0',phone})).statusCode,400);
 assert.equal((await api('PUT',staff('agent'),'manager',{version:0,phone:'5552341021'})).statusCode,400);
 assert.equal((await api('PUT',staff('agent'),'manager',{version:0,phone,enabled:true})).statusCode,400);

 const setup=await Promise.all(Array.from({length:6},()=>api('PUT',staff('agent'),'manager',{version:0,phone})));
 assert.equal(setup.filter(r=>r.statusCode===200).length,1);
 assert.equal(setup.filter(r=>r.statusCode===409).length,5);
 assert.deepEqual(setup.find(r=>r.statusCode===200)!.json(),{version:1,phoneLast4:'1021',consented:false,canActivate:true});
 assert.equal((await api('PUT',staff('second'),'manager',{version:0,phone})).statusCode,409);
 await assert.rejects(db`UPDATE staff_messaging_destination SET operation='GRANT',version=2,actor_id=${manager.id},session_id=${manager.sid}
  WHERE user_id=${agent.id}`,/STAFF_DESTINATION_ACCESS_DENIED/);
 await assert.rejects(db`UPDATE staff_messaging_destination SET operation='ACCOUNT_CHANGED',version=2,actor_id=NULL,session_id=NULL
  WHERE user_id=${agent.id}`,/STAFF_DESTINATION_ACCOUNT_CHANGE_REQUIRED/);
 assert.equal((await api('PUT',self,'agent',{version:1,phone:replacement,enabled:true})).statusCode,409);
 assert.equal((await api('PUT',self,'agent',{version:1,phone,enabled:'true'})).statusCode,400);
 assert.equal((await api('PUT',self,'agent',{version:1,phone,enabled:true})).json().consented,true);
 assert.equal((await api('PUT',self,'agent',{version:1,phone:null,enabled:false})).statusCode,409);
 assert.equal((await api('PUT',self,'agent',{version:2,phone:null,enabled:false})).json().consented,false);
 assert.equal((await api('PUT',self,'agent',{version:3,phone,enabled:true})).json().consented,true);
 assert.equal((await api('PUT',staff('agent'),'manager',{version:4,phone:replacement})).json().consented,false);
 assert.equal((await api('PUT',self,'agent',{version:5,phone:replacement,enabled:true})).json().consented,true);
 const history=await api('GET',staff('agent')+'/history?limit=2','admin');
 assert.equal(history.statusCode,200);
 assert.deepEqual(history.json().items.map((r:{operation:string})=>r.operation),['GRANT','SET']);
 assert.equal(history.json().nextVersion,5);
 assert.equal((await api('GET',self+'/history?before=5','agent')).json().items.length,4);
 assert.doesNotMatch(history.body,/15552341021|15552341039/);
 await assert.rejects(db`UPDATE staff_messaging_destination_history SET consented=true WHERE user_id=${agent.id}`,/STAFF_DESTINATION_HISTORY_IMMUTABLE/);

 const status='/api/users/'+agent.id+'/status';
 assert.equal((await api('PATCH',status,'manager',{active:false})).statusCode,200);
 assert.notEqual((await api('GET',self,'agent')).statusCode,200);
 assert.deepEqual((await api('GET',staff('agent'),'manager')).json(),{version:7,phoneLast4:null,consented:false,canActivate:false});
 assert.equal((await api('PATCH',status,'manager',{active:true})).statusCode,200);
 assert.deepEqual((await api('GET',staff('agent'),'manager')).json(),{version:7,phoneLast4:null,consented:false,canActivate:true});
 const [audit]=(await db`SELECT count(*)::int n,jsonb_agg(detail)::text all_details FROM audit_log WHERE
  target_id=${agent.id} AND action='STAFF_MESSAGING_DESTINATION_CHANGED'`);
 assert.equal(audit?.n,7);
 assert.doesNotMatch(audit?.all_details,/15552341021|15552341039/);
 const [counts]=(await db`SELECT (SELECT count(*)::int FROM notification_event) event,
  (SELECT count(*)::int FROM contact) contact,(SELECT count(*)::int FROM conversation_message) message`);
 assert.deepEqual({...counts},{event:0,contact:0,message:0});
});
