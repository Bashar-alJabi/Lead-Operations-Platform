import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('Shared AI profile use requires explicit current scoped admin grants, revokes future metadata access and retains atomic audited immutable history',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url),app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,aiConnectionAdapters:{ OPENAI:{ listModels:async()=>['Synthetic-shared-model'] } } });t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('AI shared tests') RETURNING id`)[0]!.id,foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Other') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id,branchB=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const foreignBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${foreignOrg},'Foreign') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;session:string;cookie:string }>={};
  for(const [name,role,b,o] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',branchB,org],['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${o},${b},${name},${role},${name+'@shared-ai.test'},'synthetic-only') RETURNING id`)[0]!.id,token=randomBytes(32).toString('hex');
    const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at) VALUES (${id},${sha256(token)},now()-interval '1 hour',now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={ id,session,cookie:'lop_session='+token };
  }
  const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor='admin')=>app.inject({ method,url:path,payload,headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie } });
  const secret='DedicatedSyntheticSharedAI_123';const created=await api('POST','/api/ai/connections',{ name:'Shared private credential',branchId:null,provider:'OPENAI',credential:secret,reason:'Organization shared runtime' });assert.equal(created.statusCode,201);const id=created.json().id,root='/api/ai/connections/'+id,grants=root+'/branch-use';
  assert.equal((await api('POST',root+'/test',{ version:1 })).json().state,'VERIFIED');
  for(const task of ['CONVERSATION','SUMMARIZATION'])assert.equal((await api('POST','/api/ai/profiles',{ connectionId:id,name:task,task,modelId:'Synthetic-shared-model',maxOutputTokens:1024,active:true,reason:'Admin configured shared task' })).statusCode,201);
  const usable='/api/ai/usable-profiles?branchId='+branch;
  assert.equal((await api('GET',usable,undefined,'manager')).json().items.length,0,'No implicit shared fallback');assert.equal((await api('GET',usable+'&limit=1',undefined,'agent')).statusCode,403);
  assert.equal((await api('GET','/api/ai/usable-profiles?branchId='+branchB,undefined,'manager')).statusCode,403);assert.equal((await api('GET','/api/ai/usable-profiles?branchId='+foreignBranch)).statusCode,404);
  const body={ branchId:branch,active:true,version:0,connectionVersion:1,reason:'Approve explicit shared profile use' };
  for(const actor of ['manager','other','agent'])assert.equal((await api('PUT',grants,body,actor)).statusCode,403);
  assert.equal((await api('PUT',grants,body,'foreign')).statusCode,404);assert.equal((await api('PUT',grants,{ ...body,branchId:foreignBranch })).statusCode,404);
  const races=await Promise.all(Array.from({ length:4 },()=>api('PUT',grants,body)));assert.deepEqual(races.map((r)=>r.statusCode).sort(),[200,409,409,409]);
  const page=(await api('GET',usable+'&limit=1',undefined,'manager')).json();assert.equal(page.items.length,1);assert.equal(page.items[0].grant_version,1);assert.equal(page.items[0].shared,true);assert.equal(page.items[0].catalog_available,true);assert.ok(page.nextAfter);assert.equal(page.inferenceVerified,false);
  assert.equal((await api('GET',usable+'&after='+page.nextAfter,undefined,'manager')).json().items.length,1);assert.equal(JSON.stringify(page).includes(secret),false);assert.equal(page.items[0].session_id,undefined);
  for(const method of ['GET','POST'] as const)assert.equal((await api(method,method==='GET' ? root+'/models' : root+'/test',method==='GET' ? undefined : { version:1 },'manager')).statusCode,404,'Use entitlement does not grant connection management');
  assert.equal((await api('GET','/api/ai/profiles',undefined,'manager')).json().items.length,0);assert.equal((await api('GET',usable.replace(branch,branchB),undefined,'other')).json().items.length,0);
  await assert.rejects(db`UPDATE ai_connection_branch_use SET version=version+1,actor_id=${users.manager!.id},session_id=${users.manager!.session} WHERE connection_id=${id}`,/AI_SHARED_USE_CURRENT_ADMIN_REQUIRED/);
  await assert.rejects(db`UPDATE ai_connection_branch_use_history SET snapshot='{}' WHERE connection_id=${id}`,/AI_SHARED_USE_HISTORY_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM ai_connection_branch_use WHERE connection_id=${id}`,/AI_SHARED_USE_HISTORY_RETAINED/);
  await db`UPDATE user_session SET revoked_at=now() WHERE id=${users.admin!.session}`;
  await assert.rejects(db`UPDATE ai_connection_branch_use SET version=version+1 WHERE connection_id=${id}`,/AI_SHARED_USE_CURRENT_ADMIN_REQUIRED/);await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.admin!.session}`;
  await db`CREATE FUNCTION synthetic_ai_grant_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_SHARED_USE_CONFIGURED' THEN RAISE EXCEPTION 'synthetic Audit rollback';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER synthetic_ai_grant_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_ai_grant_audit_failure()`;
  try { assert.equal((await api('PUT',grants,{ ...body,version:1,active:false })).statusCode,500);assert.equal((await api('GET',usable,undefined,'manager')).json().items.length,2);assert.equal((await api('GET',grants+'/'+branch+'/history')).json().items.length,1); }
  finally { await db`DROP TRIGGER synthetic_ai_grant_audit ON audit_log`;await db`DROP FUNCTION synthetic_ai_grant_audit_failure()`; }
  assert.equal((await api('PUT',grants,{ ...body,version:1,active:false,reason:'Revoke shared use' })).json().version,2);assert.equal((await api('GET',usable,undefined,'manager')).json().items.length,0);
  assert.equal((await api('PUT',grants,{ ...body,version:2 })).json().version,3);assert.equal((await api('POST',root+'/disable',{ version:1,reason:'Disable shared runtime' })).statusCode,200);
  assert.equal((await api('GET',usable,undefined,'manager')).json().items[0].catalog_available,false);assert.equal((await api('PUT',grants,{ ...body,version:3 })).statusCode,409);
  assert.equal((await api('POST',root+'/reconnect',{ version:2,reason:'Restore runtime' })).statusCode,200);assert.equal((await api('POST',root+'/test',{ version:3 })).json().state,'VERIFIED');
  assert.equal((await api('GET',usable,undefined,'manager')).json().items[0].catalog_available,true);assert.equal((await api('GET',grants+'/'+branch+'/history?limit=1')).json().nextVersion,3);
  assert.equal((await api('GET',grants+'/'+branch+'/history?before=3')).json().items[0].snapshot.active,false);assert.equal((await api('GET',grants+'/'+branch+'/history',undefined,'manager')).statusCode,403);
  await db`UPDATE branch SET active=false WHERE id=${branch}`;assert.equal((await api('GET',usable,undefined,'manager')).json().items[0].catalog_available,false);
  assert.equal((await api('PUT',grants,{ ...body,version:3,connectionVersion:3 })).statusCode,409);assert.equal((await api('PUT',grants,{ ...body,version:3,connectionVersion:3,active:false })).statusCode,200,'Revocation remains possible for an inactive Branch');
  assert.equal((await api('GET',usable,undefined,'manager')).json().items.length,0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE action='AI_SHARED_USE_CONFIGURED' AND target_id=${id}`)[0]!.n,4);
});
