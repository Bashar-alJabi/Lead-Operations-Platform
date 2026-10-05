import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { processOneSourceEvaluation } from '../src/sources/evaluation.js';
const url=process.env.TEST_DATABASE_URL;if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('Source runtime evaluates current publications atomically with scope, review, recovery, concurrency and immutable original/history boundaries',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=> { await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Evaluation') RETURNING id`)[0]!.id;
  const foreignOrg=(await db`INSERT INTO organization (name) VALUES ('Other organization') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope,userOrg] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',otherBranch,org],
    ['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${userOrg},${scope},${name},${role},${name+'@evaluation.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
    users[name]={ id,cookie:'lop_session='+token };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.0.${ip++}` });
  const campaign=(await db`INSERT INTO campaign (organization_id,branch_id,name,source_kind) VALUES (${org},${branch},'Source','META') RETURNING id`)[0]!.id;
  const conn=(await db`INSERT INTO integration_connection (organization_id,kind,provider,name,status) VALUES (${org},'META','META_LEAD_ADS','Shared','WARNING') RETURNING id`)[0]!.id;
  const page=(await db`INSERT INTO source_resource (connection_id,resource_kind,external_id,name,connection_version) VALUES (${conn},'PAGE','10','Page',1) RETURNING id`)[0]!.id;
  const questions=['full_name','phone','score'].map((key)=>({ key,externalId:null,label:key,type:'CUSTOM',options:[] }));
  const form=(await db`INSERT INTO source_resource (connection_id,resource_kind,parent_id,external_id,name,connection_version,questions)
    VALUES (${conn},'FORM',${page},'20','Form',1,${db.json(questions)}) RETURNING id`)[0]!.id;
  await db`INSERT INTO source_resource_access (resource_id,branch_id,updated_by,change_reason) VALUES (${form},${branch},${users.admin!.id},'Approved Form')`;
  const binding=(await api('POST',`/api/sources/campaigns/${campaign}/bindings`,{ connectionId:conn,formId:form,requestId:randomUUID(),connectionVersion:1,
    externalCampaignId:'40',externalAdSetId:null,externalAdId:null,active:true,reason:'Approved context' })).json().id;
  assert.ok(binding);
  const field=(await db`INSERT INTO field_definition (organization_id,branch_id,campaign_id,key,label,field_type,value_mode)
    VALUES (${org},${branch},${campaign},'score','Score','NUMBER','SOURCE') RETURNING id`)[0]!.id;
  await db`INSERT INTO campaign_field (campaign_id,field_id,required_stage,editable_by_manager,editable_by_agent)
    VALUES (${campaign},${field},'LEAD_CREATION',false,false)`;
  const entries=[{ sourceKey:'full_name',kind:'CONTACT_NAME',transform:'TEXT',optionMap:[] },{ sourceKey:'phone',kind:'CONTACT_PHONE',transform:'TEXT',optionMap:[] },
    { sourceKey:'score',kind:'LEAD_FIELD',fieldId:field,transform:'NUMBER',optionMap:[] }];
  const mappingBase=`/api/sources/campaigns/${campaign}/bindings/${binding}/mapping`;
  const publish=async(status='PUBLISHED',items=entries,actor='manager')=> {
    const current=(await api('GET',mappingBase,undefined,actor)).json();const response=await api('PUT',mappingBase,{ entries:items,status,reason:'Approved revision',
      version:current.latest?.version ?? 0,bindingVersion:current.bindingVersion,connectionVersion:current.connectionVersion,resourceVersion:current.resourceVersion },actor);
    assert.equal(response.statusCode,200,response.body);return response.json().version;
  };
  let leadId=30;
  const submit=async(options:{ score?:string[];form?:string;campaign?:string;fields?:{ name:string;values:string[] }[];conflict?:boolean }={})=> {
    const id=String(leadId++);const formId=options.form ?? '20';
    const raw={ context:{ pageId:'10',formId,leadId:id },notification:{ pageId:'10',change:{ value:{ adgroup_id:'77',...(options.conflict ? { campaign_id:'41' } : {}) } } },
      lead:{ id,form_id:formId,campaign_id:options.campaign ?? '40',created_time:'2023-11-14T22:13:19+0000',
        field_data:options.fields ?? [{ name:'full_name',values:['<img src=x> private customer'] },{ name:'phone',values:['+15550009999'] },{ name:'score',values:options.score ?? ['12.5'] }] } };
    const s=(await db`INSERT INTO source_submission (organization_id,source_kind,connection_id,external_event_id,raw_payload,source_timestamp,state,failure_code)
      VALUES (${org},'META',${conn},${id},${db.json(raw)},'2023-11-14T22:13:19Z','NEEDS_ATTENTION','SOURCE_INTAKE_NOT_CONFIGURED') RETURNING id`)[0]!.id as string;
    assert.equal((await db`SELECT state FROM source_processing WHERE submission_id=${s}`)[0]!.state,'PENDING');return { id:s,raw };
  };
  const review='/api/sources/submissions';const list=async(actor='admin')=>(await api('GET',review+'?connectionId='+conn,undefined,actor)).json();
  const row=async(id:string)=>(await db`SELECT * FROM source_processing WHERE submission_id=${id}`)[0]!;
  const reprocess=async(id:string,actor='admin')=>api('POST',`${review}/${id}/reprocess`,{ version:(await row(id)).version,reason:'Source setup repaired' },actor);
  const check=async(id:string,code:string|null)=> { assert.equal(await processOneSourceEvaluation(db),true);assert.equal((await row(id)).error_code,code); };
  const first=await submit();assert.equal((await list('manager')).items.length,0,'grant does not reveal unresolved shared submissions');
  assert.equal((await api('GET',review,undefined,'agent')).statusCode,403);assert.equal((await list('foreign')).items.length,0);
  await check(first.id,'SOURCE_MAPPING_NOT_PUBLISHED');assert.equal((await list('manager')).items.length,1);
  assert.equal((await api('GET',`${review}/${first.id}/history`,undefined,'other')).statusCode,404);
  assert.equal((await api('POST',`${review}/${first.id}/reprocess`,{ version:2,reason:'x' },'agent')).statusCode,403);
  assert.equal((await reprocess(first.id,'foreign')).statusCode,404);assert.equal((await reprocess(first.id,'other')).statusCode,404);
  assert.equal((await api('POST',`${review}/${first.id}/reprocess`,{ version:2,reason:'   ' })).statusCode,400);
  await publish();await publish('DRAFT',[]);
  const oldVersion=(await row(first.id)).version;const races=await Promise.all([reprocess(first.id,'manager'),reprocess(first.id,'manager')]);
  assert.deepEqual(races.map((r)=>r.statusCode).sort(),[200,409]);assert.equal((await reprocess(first.id)).json().error,'SOURCE_PROCESSING_PENDING');
  assert.equal((await api('POST',`${review}/${first.id}/reprocess`,{ version:oldVersion,reason:'stale' })).json().error,'SOURCE_PROCESSING_VERSION_CONFLICT');
  const workers=await Promise.all([processOneSourceEvaluation(db),processOneSourceEvaluation(db)]);assert.deepEqual(workers.sort(),[false,true]);
  let validated=await row(first.id);assert.equal(validated.state,'VALIDATED');assert.equal(validated.mapping_version,1);assert.equal(validated.mapped_fields,1);assert.equal(validated.mapped_contact_fields,2);
  assert.deepEqual((await db`SELECT raw_payload FROM source_submission WHERE id=${first.id}`)[0]!.raw_payload,first.raw);
  const original=await db`SELECT state,failure_code,source_timestamp,campaign_id,lead_id FROM source_submission WHERE id=${first.id}`;
  assert.equal(original[0]!.failure_code,'SOURCE_LEAD_CREATION_PENDING');assert.equal(original[0]!.campaign_id,null);assert.equal(original[0]!.lead_id,null);
  assert.equal(original[0]!.source_timestamp.toISOString(),'2023-11-14T22:13:19.000Z');
  const dto=await list('manager');assert.equal(dto.processingAvailable,true);assert.ok(!JSON.stringify(dto).includes('private customer'));assert.ok(!JSON.stringify(dto).includes('15550009999'));
  const history=(await api('GET',`${review}/${first.id}/history?limit=1`)).json();assert.equal(history.items[0].state,'VALIDATED');assert.ok(history.nextBefore);
  assert.ok((await api('GET',`${review}/${first.id}/history?beforeVersion=${history.nextBefore}`)).json().items.length);
  assert.ok(!JSON.stringify(history).includes('private customer'));
  await assert.rejects(db`UPDATE source_processing_history SET reason='rewrite' WHERE submission_id=${first.id}`);
  await assert.rejects(db`DELETE FROM source_processing_history WHERE submission_id=${first.id}`);
  await assert.rejects(db`UPDATE source_processing SET version=version+2 WHERE submission_id=${first.id}`);
  await assert.rejects(db`DELETE FROM source_processing WHERE submission_id=${first.id}`);
  const failures:[Parameters<typeof submit>[0],string][]=[ [{ campaign:'41' },'SOURCE_BINDING_UNMATCHED'],[{ form:'999' },'SOURCE_FORM_NOT_FOUND'],
    [{ conflict:true },'SOURCE_CONTEXT_CONFLICT'],[{ score:['invalid'] },'SOURCE_MAPPING_VALUE_INVALID'],[{ score:[] },'SOURCE_MAPPING_VALUE_INVALID'],
    [{ score:['1','2'] },'SOURCE_MAPPING_VALUE_INVALID'],[{ fields:[{ name:'score',values:['1'] },{ name:'score',values:['2'] }] },'SOURCE_MAPPING_DUPLICATE_INPUT'] ];
  for (const [input,code] of failures) { const s=await submit(input);await check(s.id,code); }
  const noIdentity=await submit({ fields:[{ name:'score',values:['0'] }] });await check(noIdentity.id,null);assert.equal((await row(noIdentity.id)).mapped_contact_fields,0,'no fixed Contact requirement');
  const paged=(await api('GET',review+'?limit=1',undefined,'admin')).json();assert.ok(paged.nextCursor);
  assert.notEqual((await api('GET',review+'?limit=1&cursor='+paged.nextCursor,undefined,'admin')).json().items[0].submission_id,paged.items[0].submission_id);
  assert.equal((await api('GET',review+'?cursor=bad')).statusCode,400);
  await db`UPDATE field_definition SET version=version+1,validation='{"min":1}'::jsonb WHERE id=${field}`;
  await reprocess(first.id);await check(first.id,'SOURCE_MAPPING_TARGET_CHANGED');
  await publish();await reprocess(first.id);await check(first.id,null);
  await db`UPDATE source_resource SET version=version+1 WHERE id=${form}`;
  await reprocess(first.id);await check(first.id,null);
  await db`UPDATE source_resource SET version=version+1,questions=questions || '[{"key":"new","externalId":null,"label":"new","type":"CUSTOM","options":[]}]'::jsonb WHERE id=${form}`;
  await reprocess(first.id);await check(first.id,'SOURCE_MAPPING_CATALOG_CHANGED');await publish();
  await db`UPDATE integration_connection SET status='DISABLED' WHERE id=${conn}`;await reprocess(first.id);await check(first.id,'SOURCE_CONNECTION_NOT_AVAILABLE');
  await db`UPDATE integration_connection SET status='WARNING' WHERE id=${conn}`;
  const access=`/api/sources/meta/connections/${conn}/resources/${form}/access/${branch}`;
  assert.equal((await api('PUT',access,{ version:1,active:false,reason:'Access revoked' },'admin')).statusCode,200);
  assert.equal((await api('GET',`${review}/${first.id}/history`)).statusCode,404);assert.equal((await reprocess(first.id,'manager')).statusCode,404);
  assert.equal((await list('manager')).items.length,0);
  await reprocess(first.id);await check(first.id,'SOURCE_BINDING_UNMATCHED');
  assert.equal((await api('PUT',access,{ version:2,active:true,reason:'Access restored' },'admin')).statusCode,200);
  const bindingVersion=(await db`SELECT version FROM source_campaign_binding WHERE id=${binding}`)[0]!.version;
  assert.equal((await api('PUT',`/api/sources/campaigns/${campaign}/bindings/${binding}`,{ version:bindingVersion,connectionVersion:1,active:true,
    externalCampaignId:'40',externalAdSetId:null,externalAdId:null,reason:'Explicit reactivation' })).statusCode,200);
  await reprocess(first.id);await check(first.id,null);assert.equal((await list('manager')).items.some((r:{ submission_id:string })=>r.submission_id===first.id),true);
  // Publication authorization is distinct from runtime authority; Admin publication may include a hidden SOURCE destination.
  await db`UPDATE campaign_field SET visible_to_manager=false,version=version+1 WHERE campaign_id=${campaign} AND field_id=${field}`;
  await publish('PUBLISHED',entries,'admin');await reprocess(first.id,'manager');await check(first.id,null);
  assert.ok(!(await api('GET',`${review}/${first.id}/history`)).body.includes(field));
  // Database failure rolls back result, immutable history, audit and Submission status together; a subsequent worker can retry safely.
  await reprocess(first.id);const beforeFailure=await row(first.id);const historyCount=(await db`SELECT count(*)::integer AS n FROM source_processing_history WHERE submission_id=${first.id}`)[0]!.n;
  await db.unsafe("CREATE FUNCTION fail_source_evaluation_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='VALIDATED' THEN RAISE EXCEPTION 'synthetic' USING ERRCODE='40001'; END IF; RETURN NEW; END $$");
  await db.unsafe('CREATE TRIGGER fail_source_evaluation_test BEFORE INSERT ON source_processing_history FOR EACH ROW EXECUTE FUNCTION fail_source_evaluation_test()');
  try { await assert.rejects(processOneSourceEvaluation(db));assert.equal((await row(first.id)).version,beforeFailure.version);
    assert.equal((await db`SELECT count(*)::integer AS n FROM source_processing_history WHERE submission_id=${first.id}`)[0]!.n,historyCount);
  } finally { await db.unsafe('DROP TRIGGER fail_source_evaluation_test ON source_processing_history');await db.unsafe('DROP FUNCTION fail_source_evaluation_test()'); }
  await check(first.id,null);assert.equal(await processOneSourceEvaluation(db),false);
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM contact`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead_field_value`)[0]!.n,0);
  const audit=await db`SELECT action,detail FROM audit_log WHERE target_type='SOURCE_SUBMISSION'`;assert.ok(audit.some((a)=>a.action==='SOURCE_REPROCESS_REQUESTED'));
  assert.ok(!JSON.stringify(audit).includes('private customer'));assert.ok(!JSON.stringify(audit).includes('15550009999'));
  await assert.rejects(db`INSERT INTO source_submission (organization_id,source_kind,connection_id,external_event_id,raw_payload)
    VALUES (${foreignOrg},'META',${conn},'wrong-org','{}'::jsonb)`);
  const own=(await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status)
    VALUES (${org},${branch},'META','META_LEAD_ADS','Branch source','WARNING') RETURNING id`)[0]!.id;
  const ownSubmission=(await db`INSERT INTO source_submission (organization_id,source_kind,connection_id,external_event_id,raw_payload)
    VALUES (${org},'META',${own},'1000','{}'::jsonb) RETURNING id`)[0]!.id;
  assert.equal((await api('GET',review+'?connectionId='+own)).json().items.length,1,'Branch manager can see unresolved submissions of their own connection');
  assert.equal((await api('GET',review+'?connectionId='+own,undefined,'other')).json().items.length,0);
  await check(ownSubmission,'SOURCE_RESPONSE_INVALID');
  assert.equal((await api('GET',`${review}/${ownSubmission}/history`)).statusCode,200);
  // ACL is checked again after the connection lock, including a user disabled while waiting.
  let release!:()=>void;let entered!:()=>void;const waiting=new Promise<void>((resolve)=> { entered=resolve; });
  const blocker=db.begin(async(tx)=> { await tx`SELECT id FROM integration_connection WHERE id=${own} FOR UPDATE`;entered();await new Promise<void>((resolve)=> { release=resolve; }); });
  await waiting;const revoked=api('POST',`${review}/${ownSubmission}/reprocess`,{ version:2,reason:'Concurrent requester' });
  try {
    let locked=false;for (let i=0;i<100;i++) {
      const rows=await db`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%integration_connection%FOR UPDATE%'`;
      if (rows.length) { locked=true;break; }await new Promise((resolve)=>setTimeout(resolve,10));
    }
    assert.equal(locked,true);await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;
  } finally { release();await blocker; }
  assert.equal((await revoked).statusCode,403);assert.equal((await row(ownSubmission)).state,'NEEDS_ATTENTION');
});
