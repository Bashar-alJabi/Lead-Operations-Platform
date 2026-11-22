import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';

const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw Error('Isolated TEST_DATABASE_URL required');

test('Branch timezone settings require current scoped authority and preserve versioned local schedule history',async t=>{
  process.env.APP_ORIGIN='http://127.0.0.1:5173';
  const db=createDatabase(url),app=await buildApp(db,{logger:false});
  t.after(async()=>{await app.close();await db.end();});
  await db.begin(async tx=>{
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`;
    await tx`TRUNCATE organization CASCADE`;
  });
  const [org,otherOrg]=await db`INSERT INTO organization(name) VALUES('Timezone scope'),('Other organization') RETURNING id`;
  const [branch,other]=await db`INSERT INTO branch(organization_id,name) VALUES
    (${org!.id},'Timezone branch'),(${org!.id},'Other branch') RETURNING id`;
  async function session(role:string,organizationId:string,branchId:string|null) {
    const [person]=await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
      VALUES(${organizationId},${branchId},${role},'Synthetic timezone operator',${randomUUID()+'@timezone.test'},'fixture') RETURNING id`;
    const token=randomBytes(32).toString('hex');
    const [session]=await db`INSERT INTO user_session(user_id,token_hash,expires_at)
      VALUES(${person!.id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`;
    return {cookie:'lop_session='+token,id:session!.id};
  }
  const manager=await session('MANAGER',org!.id,branch!.id),otherManager=await session('MANAGER',org!.id,other!.id);
  const agent=await session('AGENT',org!.id,branch!.id),admin=await session('SUPER_ADMIN',org!.id,null);
  const external=await session('SUPER_ADMIN',otherOrg!.id,null);
  const root='/api/branches/'+branch!.id+'/timezone';
  const send=(method:'GET'|'PUT',path:string,payload?:object,actor=manager)=>app.inject({
    method,url:path,payload,headers:{cookie:actor.cookie,origin:process.env.APP_ORIGIN!},
  });
  assert.equal((await send('GET',root)).json().timezone,'UTC');
  assert.equal((await send('GET',root,undefined,otherManager)).statusCode,404);
  assert.equal((await send('GET',root+'/history',undefined,external)).statusCode,404);
  assert.equal((await send('GET',root,undefined,agent)).statusCode,403);
  await assert.rejects(db`UPDATE branch SET timezone='Asia/Damascus' WHERE id=${branch!.id}`,/BRANCH_TIMEZONE_CHANGE_INVALID/);
  await assert.rejects(db`UPDATE branch SET timezone='Asia/Damascus',timezone_version=1 WHERE id=${branch!.id}`,/BRANCH_TIMEZONE_HISTORY_REQUIRED/);
  const edit={timezone:'Asia/Damascus',version:0,reason:'Align working hours with the branch timezone'};
  assert.equal((await send('PUT',root,{...edit,timezone:'Asia/Invalid'})).statusCode,400);
  const raced=await Promise.all(Array.from({length:5},()=>send('PUT',root,edit)));
  assert.deepEqual(raced.map(result=>result.statusCode).sort(),[200,409,409,409,409]);
  assert.equal((await send('GET','/api/branches/'+branch!.id+'/working-hours')).json().timezone,'Asia/Damascus');
  await assert.rejects(db`UPDATE branch_timezone_history SET reason='Change existing audit' WHERE branch_id=${branch!.id}`,/BRANCH_TIMEZONE_HISTORY_IMMUTABLE/);
  await db`CREATE FUNCTION fixture_branch_timezone_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='BRANCH_TIMEZONE_CHANGED' THEN RAISE EXCEPTION 'Synthetic timezone Audit outage'; END IF; RETURN NEW; END $$`;
  await db`CREATE TRIGGER fixture_branch_timezone_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW
    EXECUTE FUNCTION fixture_branch_timezone_audit_failure()`;
  try {
    const failed=await send('PUT',root,{...edit,timezone:'Europe/Paris',version:1});
    assert.equal(failed.statusCode,500);
    assert.equal((await send('GET',root)).json().timezone,'Asia/Damascus');
    assert.equal((await send('GET',root+'/history')).json().items.length,1);
  } finally {
    await db`DROP TRIGGER fixture_branch_timezone_audit_failure ON audit_log`;
    await db`DROP FUNCTION fixture_branch_timezone_audit_failure()`;
  }
  assert.equal((await send('PUT',root,{...edit,timezone:'Europe/Paris',version:1,reason:'Move future work checks to this timezone'},admin)).statusCode,200);
  const first=await send('GET',root+'/history?limit=1');
  assert.equal(first.json().items[0].previousTimezone,'Asia/Damascus');
  assert.equal(first.json().items[0].timezone,'Europe/Paris');
  assert.equal((await send('GET',root+'/history?before='+first.json().nextBefore)).json().items[0].previousTimezone,'UTC');
  assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='BRANCH_TIMEZONE_CHANGED' AND branch_id=${branch!.id}`)[0]!.n,2);
  await db`UPDATE branch SET active=false WHERE id=${branch!.id}`;
  assert.equal((await send('PUT',root,{...edit,version:2})).statusCode,409);
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${manager.id}`;
  assert.equal((await send('GET',root)).statusCode,401);
});
