import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { passwordHash, sha256 } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw Error('Isolated TEST_DATABASE_URL required');

test('Staff scope changes revoke prior sessions, preserve assignments and audit, and fence concurrent login',async t=>{
  process.env.APP_ORIGIN='http://127.0.0.1:5173';
  const db=createDatabase(url), app=await buildApp(db,{logger:false});
  t.after(async()=>{await app.close();await db.end();});
  await db.begin(async tx=>{
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`;
    await tx`TRUNCATE organization CASCADE`;
  });
  const [org,foreignOrg]=await db`INSERT INTO organization(name) VALUES('Staff scope tests'),('Foreign scope') RETURNING id`;
  const [original,destination,foreignBranch]=await db`INSERT INTO branch(organization_id,name)
    VALUES(${org!.id},'Original'),(${org!.id},'Destination'),(${foreignOrg!.id},'Foreign') RETURNING id`;
  const password='SyntheticPassword-'+randomUUID(), hash=await passwordHash(password);
  async function session(role:string,organizationId:string,branchId:string|null){
    const email=randomUUID()+'@scope.test',token=randomBytes(32).toString('hex');
    const [user]=await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
      VALUES(${organizationId},${branchId},${role},${role},${email},${hash}) RETURNING id`;
    const [s]=await db`INSERT INTO user_session(user_id,token_hash,expires_at)
      VALUES(${user!.id},${sha256(token)},now()+interval '1 hour') RETURNING id`;
    return {id:user!.id,email,cookie:'lop_session='+token,session:s!.id};
  }
  const admin=await session('SUPER_ADMIN',org!.id,null), foreign=await session('SUPER_ADMIN',foreignOrg!.id,null);
  const agent=await session('AGENT',org!.id,original!.id), manager=await session('MANAGER',org!.id,original!.id);
  const root=`/api/users/${agent.id}/operational-scope`;
  const api=(method:'GET'|'POST'|'PUT'|'PATCH',path:string,payload?:object,actor=admin)=>app.inject({
    method,url:path,payload,headers:{cookie:actor.cookie,origin:process.env.APP_ORIGIN!},
  });
  const [campaign]=await db`INSERT INTO campaign(organization_id,branch_id,name,status)
    VALUES(${org!.id},${original!.id},'Owned workload','ACTIVE') RETURNING id,version`;
  await db`INSERT INTO campaign_agent(campaign_id,agent_id) VALUES(${campaign!.id},${agent.id})`;
  const [lead]=await db`INSERT INTO lead(organization_id,branch_id,campaign_id,source_kind,assigned_agent_id)
    VALUES(${org!.id},${original!.id},${campaign!.id},'MANUAL',${agent.id}) RETURNING id,version`;
  const payload={branchId:destination!.id,role:'MANAGER',version:0,reason:'Transfer a staff account'};
  assert.equal((await api('GET',root,undefined,manager)).statusCode,403);
  assert.equal((await api('PUT',root,payload,manager)).statusCode,403);
  assert.equal((await api('PUT',root,payload,foreign)).statusCode,404);
  assert.equal((await api('PUT',root,{...payload,branchId:foreignBranch!.id})).statusCode,400);
  assert.equal((await api('PUT',root,{...payload,role:'SUPER_ADMIN'})).statusCode,400);
  assert.equal((await api('PUT',root,payload)).json().error,'STAFF_SCOPE_REASSIGN_WORK');
  assert.equal((await api('GET','/api/auth/me',undefined,agent)).statusCode,200);
  assert.equal((await api('POST',`/api/leads/${lead!.id}/assignment`,{version:lead!.version,agentId:null})).statusCode,200);
  const followup=await api('POST',`/api/leads/${lead!.id}/followups`,{ownerUserId:agent.id,dueAt:new Date(Date.now()+3600000).toISOString()});
  assert.equal(followup.statusCode,201,followup.body);
  assert.equal((await api('PUT',root,payload)).json().error,'STAFF_SCOPE_REASSIGN_WORK');
  const cancelled=await api('PATCH',`/api/followups/${followup.json().id}`,{version:1,status:'CANCELLED'});
  assert.equal(cancelled.statusCode,200,cancelled.body);
  const [connection]=await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status)
    VALUES(${org!.id},${original!.id},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic staff scope','CONNECTED') RETURNING id`;
  const [sender]=await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name)
    VALUES(${org!.id},${connection!.id},'15550000002','Scope fixture sender') RETURNING id`;
  const [conversation]=await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
    VALUES(${lead!.id},${connection!.id},${sender!.id},'WHATSAPP','+15550000003','HUMAN',${agent.id},'HUMAN_ACTIVE') RETURNING id`;
  assert.equal((await api('PUT',root,payload)).json().error,'STAFF_SCOPE_REASSIGN_WORK');
  const takeover=await api('POST',`/api/conversations/${conversation!.id}/takeover`,{version:1,reason:'Release old staff control'},manager);
  assert.equal(takeover.statusCode,200,takeover.body);
  assert.equal((await api('GET',root)).json().version,0);

  await assert.rejects(db.begin(async tx=>{
    await tx`CREATE FUNCTION fail_staff_scope_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='STAFF_OPERATIONAL_SCOPE_CHANGED' THEN RAISE EXCEPTION 'SIMULATED_STAFF_SCOPE_AUDIT_FAILURE'; END IF;
      RETURN NEW; END $$`;
    await tx`CREATE TRIGGER fail_staff_scope_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_staff_scope_audit()`;
    await tx`SELECT change_staff_operational_scope(${agent.id},0,${destination!.id},'MANAGER',${admin.id},${admin.session},'Rollback scope changes')`;
  }),/SIMULATED_STAFF_SCOPE_AUDIT_FAILURE/);
  assert.equal((await api('GET',root)).json().version,0);
  assert.equal((await api('GET','/api/auth/me',undefined,agent)).statusCode,200);
  assert.equal((await db`SELECT active FROM campaign_agent WHERE campaign_id=${campaign!.id} AND agent_id=${agent.id}`)[0]!.active,true);
  const raced=await Promise.all(Array.from({length:4},()=>api('PUT',root,payload)));
  assert.deepEqual(raced.map(result=>result.statusCode).sort(),[200,409,409,409],raced.map(result=>result.body).join('\n'));
  assert.equal((await api('GET','/api/auth/me',undefined,agent)).statusCode,401);
  assert.equal((await api('PATCH','/api/users/'+agent.id+'/status',{active:false},manager)).statusCode,403);
  const history=(await api('GET',root)).json();
  assert.equal(history.items[0].previousBranch,'Original');
  assert.equal(history.items[0].role,'MANAGER');
  assert.equal((await db`SELECT active FROM campaign_agent WHERE campaign_id=${campaign!.id} AND agent_id=${agent.id}`)[0]!.active,false);
  assert.equal((await db`SELECT version FROM campaign WHERE id=${campaign!.id}`)[0]!.version,campaign!.version+1);
  assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='STAFF_OPERATIONAL_SCOPE_CHANGED' AND target_id=${agent.id}`)[0]!.n,2);
  await assert.rejects(db`UPDATE staff_operational_scope_history SET reason='Edited' WHERE user_id=${agent.id}`,/STAFF_SCOPE_HISTORY_IMMUTABLE/);

  let locked!:()=>void, release!:()=>void;
  const held=new Promise<void>(resolve=>{locked=resolve;});
  const proceed=new Promise<void>(resolve=>{release=resolve;});
  const moveBack=db.begin(async tx=>{
    await tx`SELECT id FROM user_account WHERE id=${agent.id} FOR UPDATE`;
    locked(); await proceed;
    await tx`SELECT change_staff_operational_scope(${agent.id},1,${original!.id},'AGENT',${admin.id},${admin.session},'Restore initial staff scope')`;
  });
  await held;
  const login=api('POST','/api/auth/login',{email:agent.email,password});
  try {
    let waiting=false;
    for(let attempt=0;attempt<160 && !waiting;attempt++) {
      waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%operational_scope_version%FOR SHARE%' AND pid<>pg_backend_pid()) AS waiting`)[0]!.waiting;
      if(!waiting) await delay(25);
    }
    assert.equal(waiting,true);
  } finally { release(); await moveBack; }
  assert.equal((await login).statusCode,401);
  const fresh=await api('POST','/api/auth/login',{email:agent.email,password});
  assert.equal(fresh.statusCode,200,fresh.body);
  const cookie=String(fresh.headers['set-cookie']).split(';')[0]!;
  const principal=await api('GET','/api/auth/me',undefined,{...agent,cookie});
  assert.equal(principal.json().branchId,original!.id);
  assert.equal(principal.json().role,'AGENT');
  assert.equal((await db`SELECT active FROM campaign_agent WHERE campaign_id=${campaign!.id} AND agent_id=${agent.id}`)[0]!.active,false);
});
