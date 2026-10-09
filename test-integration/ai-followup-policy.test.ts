import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/security.js';
import { emptyAIFollowupPolicy } from '../src/ai/followup-policy.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('Campaign AI Follow-up policy enforces current scope/session/native shape/version/Audit history and deterministic write-free current-clock timing without runtime activation',async t=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';const db=createDatabase(url),app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async tx=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Followup policy') RETURNING id`)[0]!.id,foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Other') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id,otherBranch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'A') RETURNING id`)[0]!.id,campaignB=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;session:string;cookie:string }>={};
  for(const [name,role,b,o] of [['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['other','MANAGER',otherBranch,org],['admin','SUPER_ADMIN',null,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES (${o},${b},${role},${name},${name+'@followuppolicy.test'},'synthetic-only') RETURNING id`)[0]!.id,token=randomBytes(32).toString('hex');
    const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at) VALUES (${id},${sha256(token)},now()-interval '1 hour',now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={ id,session,cookie:'lop_session='+token };
  }
  const root='/api/ai/campaigns/'+campaign+'/followup-policy',effective='/api/ai/campaigns/'+campaign+'/effective-configuration';
  const api=(method:'GET'|'PUT'|'POST',path:string,payload?:object,actor='manager')=>app.inject({ method,url:path,payload,headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie } });
  const definition={ ...emptyAIFollowupPolicy(),enabled:true,initialDelaySeconds:5,delaysSeconds:[10,20],finalAction:'HANDOFF' as const },body={ version:0,definition,reason:'Configure current followup timing <img literal>' };
  assert.equal((await api('GET',root)).json().version,0);const originalHash=(await api('GET',effective)).json().hash;
  for(const who of ['agent','other','foreign']) { assert.equal((await api('GET',root,undefined,who)).statusCode,who==='agent' ? 403 : 404);assert.equal((await api('PUT',root,body,who)).statusCode,who==='agent' ? 403 : 404); }
  for(const bad of [{ ...definition,delaysSeconds:[] },{ ...definition,delaysSeconds:[0] },{ ...definition,stopOnHumanTakeover:false },{ ...definition,finalAction:'MARK_PAID' }])assert.equal((await api('PUT',root,{ ...body,definition:bad })).statusCode,400);
  assert.equal((await db`SELECT ai_followup_policy_valid(${db.json({ ...definition,stopOnReply:null })}) AS valid`)[0]!.valid,false);
  const raced=await Promise.all(Array.from({ length:4 },()=>api('PUT',root,body)));assert.deepEqual(raced.map(r=>r.statusCode).sort(),[200,409,409,409]);
  const changed=(await api('GET',effective)).json();assert.notEqual(changed.hash,originalHash);assert.equal(changed.followup.version,1);assert.deepEqual(changed.followup.definition,definition);assert.equal(changed.followup.maxAttempts,2);assert.equal(changed.assistantReady,false);assert.equal(changed.allowedTools.length,0);assert.ok(changed.blockers.includes('AI_FOLLOWUP_RUNTIME_NOT_IMPLEMENTED'));
  assert.equal((await api('GET','/api/ai/campaigns/'+campaignB+'/effective-configuration')).json().followup.version,0);
  const preview={ version:1,definition,anchorAt:new Date(Date.now()-60000).toISOString(),attemptsSent:0,hasInboundReply:false,leadLifecycle:'OPEN',controllerType:'AI',conversationState:'AI_WAITING_FOR_LEAD' };
  const due=await api('POST',root+'/preview',preview);assert.equal(due.statusCode,200,due.body);assert.equal(due.json().decision,'DUE');assert.equal(due.json().sendAllowed,false);assert.equal(due.json().previewOnly,true);assert.equal(due.json().mandatoryStops.humanTakeover,true);assert.ok(due.json().initialEligibleAt);
  assert.equal((await api('POST',root+'/preview',{ ...preview,anchorAt:new Date(Date.now()+60000).toISOString() })).json().decision,'WAIT');
  for(const changed of [{ controllerType:'HUMAN' },{ controllerType:'NONE' },{ leadLifecycle:'CLOSED' },{ leadLifecycle:'ARCHIVED' },{ conversationState:'WAITING_FOR_HUMAN' },{ conversationState:'CLOSED' },{ hasInboundReply:true }])assert.equal((await api('POST',root+'/preview',{ ...preview,...changed,attemptsSent:2 })).json().decision,'STOPPED');
  assert.equal((await api('POST',root+'/preview',{ ...preview,attemptsSent:2 })).json().decision,'HANDOFF');assert.equal((await api('POST',root+'/preview',{ ...preview,definition:{ ...definition,finalAction:'COMPLETE' },attemptsSent:2 })).json().decision,'COMPLETE');
  assert.equal((await api('POST',root+'/preview',{ ...preview,definition:{ ...definition,stopOnReply:false },hasInboundReply:true })).json().decision,'DUE');
  assert.equal((await api('POST',root+'/preview',{ ...preview,version:0 })).statusCode,409);assert.equal((await api('POST',root+'/preview',{ ...preview,controllerType:'SUPER_ADMIN' })).statusCode,400);
  assert.equal((await db`SELECT count(*)::integer AS n FROM follow_up`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM background_job`)[0]!.n,0);
  await assert.rejects(db`UPDATE ai_followup_policy SET version=version+2 WHERE campaign_id=${campaign}`,/VERSION_REQUIRED/);await assert.rejects(db`DELETE FROM ai_followup_policy WHERE campaign_id=${campaign}`,/HISTORY_RETAINED/);await assert.rejects(db`UPDATE ai_followup_policy_history SET definition='{}' WHERE campaign_id=${campaign}`,/HISTORY_IMMUTABLE/);
  await assert.rejects(db`UPDATE ai_followup_policy SET version=version+1,definition=${db.json({ ...definition,delaysSeconds:[-1] })} WHERE campaign_id=${campaign}`,/AI_FOLLOWUP_INVALID/);
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
  await assert.rejects(db`UPDATE ai_followup_policy SET version=version+1 WHERE campaign_id=${campaign}`,/CURRENT_ACCESS_REQUIRED/);assert.equal((await api('GET',root)).statusCode,401);await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.manager!.session}`;
  await db`UPDATE user_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${users.manager!.session}`;await assert.rejects(db`UPDATE ai_followup_policy SET version=version+1 WHERE campaign_id=${campaign}`,/CURRENT_ACCESS_REQUIRED/);await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=${users.manager!.session}`;
  await db`CREATE FUNCTION synthetic_followup_policy_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_FOLLOWUP_POLICY_CONFIGURED' THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER synthetic_followup_policy_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_followup_policy_audit_failure()`;
  try { assert.equal((await api('PUT',root,{ ...body,version:1,definition:{ ...definition,enabled:false } })).statusCode,500);assert.equal((await api('GET',root)).json().version,1);assert.equal((await api('GET',root+'/history')).json().items.length,1); }
  finally { await db`DROP TRIGGER synthetic_followup_policy_audit ON audit_log`;await db`DROP FUNCTION synthetic_followup_policy_audit_failure()`; }
  assert.equal((await api('PUT',root,{ ...body,version:1,definition:{ ...definition,enabled:false },reason:'Disable while retaining original delays' })).statusCode,200);
  assert.deepEqual((await api('GET',root+'/versions/1')).json().definition,definition);assert.equal((await api('GET',root+'/history?limit=1')).json().nextVersion,2);assert.equal((await api('GET',root+'/history?before=2')).json().items[0].version,1);
  await db`UPDATE branch SET active=false WHERE id=${branch}`;assert.equal((await api('PUT',root,{ ...body,version:2 })).statusCode,409);assert.equal((await api('GET',root+'/versions/1')).statusCode,200);await assert.rejects(db`UPDATE ai_followup_policy SET version=version+1 WHERE campaign_id=${campaign}`,/CURRENT_ACCESS_REQUIRED/);
});
