import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/security.js';
import { normalizeWeeklyHours } from '../src/working-hours.js';
import { isWithinWorkingHours } from '../src/routing.js';
const url=process.env.TEST_DATABASE_URL;if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('Operational working hours enforce current scope/session/CAS and atomically retain projections/history/Audit',async t=>{
  process.env.APP_ORIGIN='http://127.0.0.1:5173';const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
  t.after(async()=>{await app.close();await db.end();});
  await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
  const org=(await db`INSERT INTO organization(name) VALUES('Hours fixture') RETURNING id`)[0]!.id,
    branch=(await db`INSERT INTO branch(organization_id,name,timezone) VALUES(${org},'A','Europe/Paris') RETURNING id`)[0]!.id,
    other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id,
    foreign=(await db`INSERT INTO organization(name) VALUES('Foreign hours') RETURNING id`)[0]!.id;
  const users:Record<string,{id:string;session:string;cookie:string}>={};
  for(const [name,role,bid,oid] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['other','MANAGER',other,org],['foreign','SUPER_ADMIN',null,foreign]] as const){
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${oid},${bid},${role},${name},${name+'@hours.test'},'synthetic') RETURNING id`)[0]!.id,token=randomBytes(32).toString('hex'),
      session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name]={id,session,cookie:'lop_session='+token};
  }
  const api=(method:'GET'|'PUT',path:string,body?:object,who='manager')=>app.inject({method,url:path,payload:body,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}}),
    br='/api/branches/'+branch+'/working-hours',ur='/api/users/'+users.agent!.id+'/working-hours',hours=normalizeWeeklyHours({mon:[['09:00','12:00'],['13:00','24:00']]}),
    body={version:0,hours,reason:'Configured working hours <img literal>'};
  assert.equal((await api('GET',br)).json().version,0);assert.equal((await api('GET',br)).json().timezone,'Europe/Paris');
  for(const root of [br,ur]){
    assert.equal((await api('GET',root,undefined,'agent')).statusCode,403);
    assert.equal((await api('GET',root,undefined,'other')).statusCode,404);
    assert.equal((await api('PUT',root,body,'foreign')).statusCode,404);
  }
  assert.equal((await api('PUT','/api/users/'+users.manager!.id+'/working-hours',body)).statusCode,404);
  for(const invalid of [{mon:[['09:00','09:00']]},{mon:[['11:00','12:00'],['09:00','10:00']]},{mon:[['24:00','25:00']]},{mon:[['09:00','10:00']],bad:[]}])assert.equal((await api('PUT',br,{...body,hours:invalid})).statusCode,400);
  const raced=await Promise.all(Array.from({length:8},()=>api('PUT',br,body)));assert.equal(raced.filter(r=>r.statusCode===200).length,1);assert.equal(raced.filter(r=>r.statusCode===409).length,7);
  assert.deepEqual((await db`SELECT business_hours FROM branch WHERE id=${branch}`)[0]!.business_hours,hours);
  assert.equal((await db`SELECT count(*)::int AS n FROM operational_hours_history WHERE resource_id=${branch}`)[0]!.n,1);
  assert.equal((await api('PUT',ur,body)).statusCode,200);
  assert.deepEqual((await db`SELECT working_hours FROM user_account WHERE id=${users.agent!.id}`)[0]!.working_hours,hours);
  // Native and shared routing agree at opening/closing/midnight and DST repeated-hour boundaries.
  for(const at of ['2026-10-12T06:59:59Z','2026-10-12T07:00:00Z','2026-10-12T10:00:00Z','2026-10-12T11:00:00Z','2026-10-12T21:59:59Z','2026-10-12T22:00:00Z']){
    assert.equal((await db`SELECT operational_hours_open(${db.json(hours)},'Europe/Paris',${at}::timestamptz) AS open`)[0]!.open,isWithinWorkingHours(hours,'Europe/Paris',new Date(at)));
  }
  const dst=normalizeWeeklyHours({sun:[['02:00','03:00']]});for(const at of ['2026-10-25T00:30:00Z','2026-10-25T01:30:00Z'])assert.equal((await db`SELECT operational_hours_open(${db.json(dst)},'Europe/Paris',${at}::timestamptz) AS open`)[0]!.open,true);
  assert.equal((await db`SELECT operational_hours_open('{}','UTC',clock_timestamp()) AS open`)[0]!.open,true);
  assert.equal((await db`SELECT operational_hours_open('[]','UTC',clock_timestamp()) AS open`)[0]!.open,false);
  await assert.rejects(db`UPDATE branch SET business_hours='{}' WHERE id=${branch}`,/AUTHORIZED_SETUP_REQUIRED/);
  await assert.rejects(db`UPDATE user_account SET working_hours='{}' WHERE id=${users.agent!.id}`,/AUTHORIZED_SETUP_REQUIRED/);
  await assert.rejects(db`UPDATE operational_hours_policy SET version=version+1,actor_id=${users.agent!.id},session_id=${users.agent!.session} WHERE resource_id=${branch}`,/CURRENT_ACCESS_REQUIRED/);
  await assert.rejects(db`UPDATE operational_hours_policy SET hours='{}' WHERE resource_id=${branch}`,/VERSION_REQUIRED/);
  await assert.rejects(db`UPDATE operational_hours_policy SET version=version+1,actor_id=${users.foreign!.id},session_id=${users.foreign!.session} WHERE resource_id=${branch}`,/CURRENT_ACCESS_REQUIRED/);
  await assert.rejects(db`DELETE FROM operational_hours_history WHERE resource_id=${branch}`,/IMMUTABLE/);
  await db.unsafe("CREATE FUNCTION test_hours_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='WORKING_HOURS_CONFIGURED' THEN RAISE EXCEPTION 'TEST_HOURS_AUDIT_FAILURE';END IF;RETURN NEW;END $$; CREATE TRIGGER test_hours_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_hours_audit_failure()");
  try{assert.equal((await api('PUT',br,{version:1,hours:{},reason:'Atomic projection rollback'})).statusCode,500);}finally{await db.unsafe('DROP TRIGGER test_hours_audit_failure ON audit_log;DROP FUNCTION test_hours_audit_failure()');}
  assert.equal((await api('GET',br)).json().version,1);assert.deepEqual((await db`SELECT business_hours FROM branch WHERE id=${branch}`)[0]!.business_hours,hours);
  assert.equal((await api('PUT',br,{version:1,hours:{},reason:'Resume unrestricted hours'})).statusCode,200);
  const hist=(await api('GET',br+'/history?limit=1')).json();assert.equal(hist.items[0].version,2);assert.equal(hist.nextVersion,2);assert.equal(hist.items[0].session_id,undefined);
  assert.equal((await api('GET',br+'/history?before=2')).json().items[0].reason,body.reason);
  assert.equal((await db`SELECT h.created_at=p.updated_at AS native_time FROM operational_hours_history h JOIN operational_hours_policy p USING(scope,resource_id,version) WHERE p.resource_id=${branch}`)[0]!.native_time,true);
  // A Super Admin write cannot retain an old Branch lock after a target User moves.
  let parentReady!:()=>void,releaseParent!:()=>void;const parentHeld=new Promise<void>(r=>{parentReady=r;}),parentUnlocked=new Promise<void>(r=>{releaseParent=r;});
  const parentBlocker=db.begin(async tx=>{await tx`SELECT id FROM branch WHERE id=${branch} FOR UPDATE`;parentReady();await parentUnlocked;});await parentHeld;
  const staleParent=api('PUT',ur,{version:1,hours:{},reason:'Target moved after scope read'},'admin');
  try{let waiting=false;for(let i=0;i<80;i++){waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%active,timezone FROM branch%' AND pid<>pg_backend_pid()) AS waiting`)[0]!.waiting;if(waiting)break;await new Promise(r=>setTimeout(r,20));}assert.equal(waiting,true);await db`UPDATE user_account SET branch_id=${other} WHERE id=${users.agent!.id}`;}finally{releaseParent();await parentBlocker;}
  assert.equal((await staleParent).statusCode,404);await db`UPDATE user_account SET branch_id=${branch} WHERE id=${users.agent!.id}`;
  assert.equal((await api('GET',ur)).json().version,1);
  // Actual cookie session is rechecked after Branch lock acquisition.
  let ready!:()=>void,release!:()=>void;const held=new Promise<void>(r=>{ready=r;}),unlocked=new Promise<void>(r=>{release=r;});
  const blocker=db.begin(async tx=>{await tx`SELECT id FROM branch WHERE id=${branch} FOR UPDATE`;ready();await unlocked;});await held;
  const attempt=api('PUT',br,{version:2,hours:{mon:[]},reason:'Revoked while waiting'});
  try{let waiting=false;for(let i=0;i<80;i++){waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%active,timezone FROM branch%' AND pid<>pg_backend_pid()) AS waiting`)[0]!.waiting;if(waiting)break;await new Promise(r=>setTimeout(r,20));}assert.equal(waiting,true);await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;}finally{release();await blocker;}
  assert.equal((await attempt).statusCode,403);assert.equal((await api('GET',br,undefined,'admin')).json().version,2);
  await assert.rejects(db`UPDATE operational_hours_policy SET version=version+1 WHERE resource_id=${branch}`,/CURRENT_ACCESS_REQUIRED/);
});
