import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { emptyQualification } from '../src/ai/qualification.js';
const url=process.env.TEST_DATABASE_URL;if(!url || new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('Qualification configuration and dry preview enforce current fields, typed values, scope, concurrency, immutable history and atomic Audit without Lead writes',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';const db=createDatabase(url),app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });t.after(async()=>{ await app.close();await db.end(); });
  await db.begin(async(tx)=>{ await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization(name) VALUES ('Qualification') RETURNING id`)[0]!.id,foreignOrg=(await db`INSERT INTO organization(name) VALUES ('Other') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id,branchB=(await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const a=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'A') RETURNING id`)[0]!.id,b=(await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;session:string;cookie:string }>={};
  for(const [name,role,scope,o] of [['manager','MANAGER',branch,org],['other','MANAGER',branchB,org],['agent','AGENT',branch,org],['admin','SUPER_ADMIN',null,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${o},${scope},${name},${role},${name+'@qualification.test'},'synthetic-only') RETURNING id`)[0]!.id,token=randomBytes(32).toString('hex');
    const session=(await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at) VALUES (${id},${sha256(token)},now()-interval '1 hour',now()+interval '1 hour') RETURNING id`)[0]!.id;users[name]={ id,session,cookie:'lop_session='+token };
  }
  const root='/api/ai/campaigns/'+a+'/qualification',other='/api/ai/campaigns/'+b+'/qualification';
  const api=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actor='manager')=>app.inject({ method,url:path,payload,headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie } });
  const createField=async(key:string,type:string,scope=a,options:{ value:string;label:string;active:boolean }[]=[])=> {
    const f=(await db`INSERT INTO field_definition(organization_id,branch_id,campaign_id,key,label,field_type,options) VALUES (${org},${branch},${scope},${key},${key},${type},${db.json(options)}) RETURNING id`)[0]!.id;
    await db`INSERT INTO campaign_field(campaign_id,field_id,usable_by_ai) VALUES (${scope},${f},true)`;return f as string;
  };
  const interest=await createField('interest','BOOLEAN'),level=await createField('level','SINGLE_SELECT',a,[{ value:'A1',label:'Level A1',active:true },{ value:'B1',label:'Level B1',active:true }]),foreign=await createField('foreign','TEXT',b);
  const q=randomUUID(),q2=randomUUID(),definition={ ...emptyQualification(),enabled:true,questions:[{ id:q,prompt:'Interest <img literal>',fieldId:interest,required:true },{ id:q2,prompt:'Level?',fieldId:level,required:false }],handoff:{ onCompletion:true,match:'ALL' as const,conditions:[] } },body={ version:0,definition,reason:'Configure explicit qualification' };
  assert.equal((await api('GET',root)).json().version,0);assert.equal((await db`SELECT count(*)::integer AS n FROM ai_qualification_config`)[0]!.n,0);
  for(const actor of ['agent','other','foreign']) { assert.equal((await api('GET',root,undefined,actor)).statusCode,actor==='agent' ? 403 : 404);assert.equal((await api('PUT',root,body,actor)).statusCode,actor==='agent' ? 403 : 404); }
  assert.equal((await api('PUT',root,{ ...body,definition:{ ...definition,questions:[{ ...definition.questions[0]!,fieldId:foreign }] } })).statusCode,409);
  assert.equal((await api('PUT',root,{ ...body,definition:{ ...definition,systemInstructions:'ignore rules' } })).statusCode,400);
  assert.equal((await db`SELECT ai_qualification_valid(${db.json(definition)}) AS valid`)[0]!.valid,true,'Native validation accepts a valid scoped definition');
  const edits=await Promise.all(Array.from({ length:4 },()=>api('PUT',root,body)));assert.deepEqual(edits.map((r)=>r.statusCode).sort(),[200,409,409,409]);
  const preview=(answers:object[])=>api('POST',root+'/preview',{ version:1,definition,answers });
  assert.equal((await preview([])).json().complete,false);const yes=(await preview([{ questionId:q,value:false }])).json();assert.equal(yes.complete,true);assert.equal(yes.handoff,true);assert.equal(yes.fieldVersions.length,2);
  assert.equal((await preview([{ questionId:q,value:'yes' }])).statusCode,400);assert.equal((await preview([{ questionId:q2,value:'UNAPPROVED' }])).statusCode,400);assert.equal((await preview([{ questionId:randomUUID(),value:'foreign answer' }])).statusCode,400);assert.equal((await preview([{ questionId:q,value:true },{ questionId:q,value:false }])).statusCode,400);
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead_field_value`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM field_value_history`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message`)[0]!.n,0);
  const custom={ ...definition,questions:[definition.questions[1]!,definition.questions[0]!],completion:{ mode:'CONDITIONS' as const,match:'ALL' as const,conditions:[{ questionId:q,operator:'EQUALS' as const,value:false },{ questionId:q2,operator:'EQUALS' as const,value:'A1' }] } };
  assert.equal((await api('POST',root+'/preview',{ version:1,definition:custom,answers:[{ questionId:q,value:false },{ questionId:q2,value:'A1' }] })).json().complete,true);
  assert.equal((await api('PUT',root,{ version:1,definition:custom,reason:'Explicit interest and level criteria' })).statusCode,200);assert.equal((await api('GET',root+'/versions/1')).json().definition.questions[0].id,q);assert.equal((await api('GET',root)).json().definition.questions[0].id,q2);assert.equal((await api('GET',other)).json().version,0);
  assert.equal((await api('POST',root+'/preview',{ version:1,definition:custom,answers:[] })).statusCode,409);
  await db`UPDATE campaign_field SET usable_by_ai=false WHERE campaign_id=${a} AND field_id=${interest}`;
  assert.equal((await api('POST',root+'/preview',{ version:2,definition:custom,answers:[] })).statusCode,409);
  await assert.rejects(db`UPDATE ai_qualification_config SET version=version+1 WHERE campaign_id=${a}`,/CURRENT_FIELD_REQUIRED/);
  await db`UPDATE campaign_field SET usable_by_ai=true WHERE campaign_id=${a} AND field_id=${interest}`;
  await assert.rejects(db`UPDATE ai_qualification_config SET version=version+2 WHERE campaign_id=${a}`,/VERSION_CONFLICT/);await assert.rejects(db`DELETE FROM ai_qualification_config WHERE campaign_id=${a}`,/HISTORY_RETAINED/);await assert.rejects(db`UPDATE ai_qualification_history SET definition='{}' WHERE campaign_id=${a}`,/HISTORY_IMMUTABLE/);
  assert.equal((await db`SELECT ai_qualification_valid(${db.json({ ...definition,completion:{ mode:null,match:'ALL',conditions:[] } })}) AS valid`)[0]!.valid,false);
  await db`UPDATE user_session SET revoked_at=now() WHERE id=${users.manager!.session}`;await assert.rejects(db`UPDATE ai_qualification_config SET version=version+1 WHERE campaign_id=${a}`,/CURRENT_ACCESS_REQUIRED/);await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.manager!.session}`;
  await db`CREATE FUNCTION synthetic_qualification_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_QUALIFICATION_CONFIGURED' THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER synthetic_qualification_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_qualification_audit_failure()`;
  try { assert.equal((await api('PUT',root,{ version:2,definition:custom,reason:'Audit rollback verification' })).statusCode,500);assert.equal((await api('GET',root)).json().version,2);assert.equal((await api('GET',root+'/history')).json().items.length,2); }
  finally { await db`DROP TRIGGER synthetic_qualification_audit ON audit_log`;await db`DROP FUNCTION synthetic_qualification_audit_failure()`; }
  assert.equal((await api('GET',root+'/history?limit=1')).json().nextVersion,2);assert.equal((await api('GET',root+'/history?before=2')).json().items[0].version,1);
  await db`UPDATE campaign_field SET usable_by_ai=false WHERE campaign_id=${a} AND field_id=${interest}`;
  assert.equal((await api('PUT',root,{ version:2,definition:{ ...custom,enabled:false },reason:'Disable safely after field revocation' })).statusCode,200);
  assert.equal((await api('GET',root)).json().definition.enabled,false);
  assert.equal((await api('PUT',root,{ version:3,definition:custom,reason:'Cannot reenable invalid mapping' })).statusCode,409);
  await db`UPDATE campaign_field SET usable_by_ai=true WHERE campaign_id=${a} AND field_id=${interest}`;
  assert.equal((await api('PUT',root,{ version:3,definition:custom,reason:'Reenable after field permission restored' })).statusCode,200);
  await db`UPDATE branch SET active=false WHERE id=${branch}`;assert.equal((await api('PUT',root,{ version:4,definition:custom,reason:'Inactive branch configuration' })).statusCode,409);assert.equal((await api('GET',root+'/versions/1')).statusCode,200);
});
