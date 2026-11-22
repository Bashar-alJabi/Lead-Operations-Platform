import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';

const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw Error('Isolated TEST_DATABASE_URL required');

test('Scoped Agent profile changes share routing capacity, count open ownership, and retain atomic history',async t=>{
  process.env.APP_ORIGIN='http://127.0.0.1:5173';
  const db=createDatabase(url),app=await buildApp(db,{logger:false});
  t.after(async()=>{await app.close();await db.end();});
  await db.begin(async tx=>{
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`;
    await tx`TRUNCATE organization CASCADE`;
  });
  const [org,foreignOrg]=await db`INSERT INTO organization(name) VALUES('Profile test scope'),('Other organization') RETURNING id`;
  const [branch,other]=await db`INSERT INTO branch(organization_id,name) VALUES(${org!.id},'Profile branch'),(${org!.id},'Other branch') RETURNING id`;
  async function session(role:string,organizationId:string,branchId:string|null) {
    const [user]=await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
      VALUES(${organizationId},${branchId},${role},${'Synthetic '+role},${randomUUID()+'@profile.test'},'fixture') RETURNING id`;
    const token=randomBytes(32).toString('hex');
    const [s]=await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES
      (${user!.id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`;
    return {user:user!.id,cookie:'lop_session='+token,session:s!.id};
  }
  const manager=await session('MANAGER',org!.id,branch!.id),otherManager=await session('MANAGER',org!.id,other!.id);
  const agent=await session('AGENT',org!.id,branch!.id),foreign=await session('SUPER_ADMIN',foreignOrg!.id,null);
  const admin=await session('SUPER_ADMIN',org!.id,null);
  const root='/api/users/'+agent.user+'/agent-profile';
  const send=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor=manager)=>app.inject({
    method,url:path,payload,headers:{cookie:actor.cookie,origin:process.env.APP_ORIGIN!},
  });
  assert.equal((await send('GET',root,undefined,agent)).statusCode,403);
  assert.equal((await send('GET',root,undefined,otherManager)).statusCode,404);
  assert.equal((await send('GET',root+'/history',undefined,foreign)).statusCode,404);
  assert.equal((await send('GET','/api/users/'+manager.user+'/agent-profile',undefined,admin)).statusCode,404);

  const created=await send('POST','/api/campaigns',{branchId:branch!.id,name:'Profile routing',routingMethod:'ROUND_ROBIN'});
  assert.equal(created.statusCode,201,created.body);
  const campaignId=created.json().id;
  assert.equal((await send('PUT','/api/campaigns/'+campaignId+'/agents',{agentId:agent.user})).statusCode,200);
  assert.equal((await send('POST','/api/campaigns/'+campaignId+'/activate')).statusCode,200);
  async function createLead() {
    const result=await send('POST','/api/leads',{campaignId,branchId:branch!.id,contact:{name:'Synthetic assigned prospect',email:randomUUID()+'@profile.test'}});
    assert.equal(result.statusCode,201,result.body);
    return result.json().id as string;
  }
  const existing=await createLead();
  assert.equal((await send('GET',root)).json().openLeadCount,1);
  const edit={name:'Updated Agent name',capacity:0,version:0,reason:'Pause new automatic assignments'};
  const raced=await Promise.all(Array.from({length:5},()=>send('PUT',root,edit)));
  assert.deepEqual(raced.map(result=>result.statusCode).sort(),[200,409,409,409,409]);
  const paused=await createLead();
  const owners=await db`SELECT id,assigned_agent_id FROM lead WHERE id IN (${existing},${paused})`;
  assert.equal(owners.find(row=>row.id===existing)!.assigned_agent_id,agent.user);
  assert.equal(owners.find(row=>row.id===paused)!.assigned_agent_id,null);
  assert.equal((await send('GET',root)).json().openLeadCount,1);
  await assert.rejects(db`UPDATE user_account SET capacity=7 WHERE id=${agent.user}`,/AGENT_PROFILE_VERSION_REQUIRED/);
  await assert.rejects(db`UPDATE user_account SET capacity=7,agent_profile_version=2 WHERE id=${agent.user}`,/AGENT_PROFILE_HISTORY_REQUIRED/);
  await assert.rejects(db`DELETE FROM agent_profile_history WHERE user_id=${agent.user}`,/AGENT_PROFILE_HISTORY_IMMUTABLE/);
  assert.equal((await send('PUT',root,{...edit,version:1,name:'   '})).statusCode,400);
  assert.equal((await send('PUT',root,{...edit,version:1,capacity:null,reason:'Restore routing eligibility'},admin)).statusCode,200);
  assert.equal((await send('GET',root)).json().capacity,null);
  await createLead();
  assert.equal((await send('GET',root)).json().openLeadCount,2);
  const latest=(await send('GET',root+'/history?limit=1')).json();
  assert.equal(latest.items[0].previousCapacity,0);
  assert.equal(latest.items[0].capacity,null);
  const initial=(await send('GET',root+'/history?before='+latest.nextBefore)).json();
  assert.equal(initial.items[0].previousName,'Synthetic AGENT');
  assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='AGENT_PROFILE_CHANGED' AND target_id=${agent.user}`)[0]!.n,2);
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${manager.session}`;
  assert.equal((await send('PUT',root,{...edit,version:2})).statusCode,401);
});
