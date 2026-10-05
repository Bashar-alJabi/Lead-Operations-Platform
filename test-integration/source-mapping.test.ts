import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes,randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import type { MappingEntry } from '../src/sources/field-mapping.js';
const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('Source Mapping draft/publication/preview preserve raw records, versions, required stages, field permissions and catalog/grant failure boundaries',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=> { await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Mapping') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['other','MANAGER',otherBranch],['agent','AGENT',branch]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${org},${scope},${name},${role},${name+'@mapping.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
    users[name]={ id,cookie:'lop_session='+token };
  }
  const campaign=(await db`INSERT INTO campaign (organization_id,branch_id,name,source_kind) VALUES (${org},${branch},'Mapped','META') RETURNING id`)[0]!.id;
  const conn=(await db`INSERT INTO integration_connection (organization_id,kind,provider,name,status) VALUES (${org},'META','META_LEAD_ADS','Shared','WARNING') RETURNING id`)[0]!.id;
  const page=(await db`INSERT INTO source_resource (connection_id,resource_kind,external_id,name,connection_version) VALUES (${conn},'PAGE','10','Page',1) RETURNING id`)[0]!.id;
  const questions=['full_name','phone','email','score','choice','enabled','amount','__proto__'].map((key)=>({ key,externalId:null,label:'Question '+key,type:'CUSTOM',options:[] }));
  questions.push({ key:null as unknown as string,externalId:null,label:'No key',type:'CUSTOM',options:[] });
  const form=(await db`INSERT INTO source_resource (connection_id,resource_kind,parent_id,external_id,name,connection_version,questions)
    VALUES (${conn},'FORM',${page},'11','Form',1,${db.json(questions)}) RETURNING id`)[0]!.id;
  await db`INSERT INTO source_resource_access (resource_id,branch_id,updated_by,change_reason) VALUES (${form},${branch},${users.admin!.id},'Test grant')`;
  let address=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.0.${address++}` });
  const binding=(await api('POST','/api/sources/campaigns/'+campaign+'/bindings',{ connectionId:conn,formId:form,requestId:randomUUID(),connectionVersion:1,
    externalCampaignId:null,externalAdSetId:null,externalAdId:null,active:true,reason:'Mapping binding' })).json().id;
  const base=`/api/sources/campaigns/${campaign}/bindings/${binding}/mapping`;
  const fieldIds:Record<string,string>={};
  for (const [key,type,mode,visible,editable,stage] of [['score','NUMBER','SOURCE',true,false,'LEAD_CREATION'],['choice','SINGLE_SELECT','SOURCE',true,false,'NONE'],
    ['enabled','BOOLEAN','SOURCE',true,false,'CLOSE'],['amount','CURRENCY','SOURCE',true,false,'ENROLLMENT'],['hidden','TEXT','MANUAL',false,false,'NONE'],
    ['locked','TEXT','MANUAL',true,false,'NONE'],['system','TEXT','SYSTEM',true,false,'NONE'],['calculated','CALCULATED','CALCULATED',true,false,'NONE']] as const) {
    const id=(await db`INSERT INTO field_definition (organization_id,branch_id,campaign_id,key,label,field_type,value_mode,validation,options,calculation)
      VALUES (${org},${branch},${campaign},${key},${key},${type},${mode},${db.json(type==='CURRENCY' ? { currency:'USD' } : {})},
        ${db.json(type==='SINGLE_SELECT' ? [{ value:'a',label:'Allowed',active:true }] : [])},${type==='CALCULATED' ? db.json({ kind:'LEAD_AGE_DAYS' }) : null}) RETURNING id`)[0]!.id;
    await db`INSERT INTO campaign_field (campaign_id,field_id,required_stage,visible_to_manager,editable_by_manager,editable_by_agent)
      VALUES (${campaign},${id},${stage},${visible},${editable},false)`;fieldIds[key]=id;
  }
  const entry=(key:string,kind:MappingEntry['kind']='LEAD_FIELD',transform:MappingEntry['transform']='TEXT'):MappingEntry=>({ sourceKey:key,kind,
    ...(kind==='LEAD_FIELD' ? { fieldId:fieldIds[key] } : {}),transform,optionMap:[] });
  const entries=[entry('full_name','CONTACT_NAME'),entry('phone','CONTACT_PHONE'),entry('email','CONTACT_EMAIL'),entry('score','LEAD_FIELD','NUMBER'),
    { ...entry('choice'),optionMap:[{ source:'Provider A',target:'a' }] },entry('enabled','LEAD_FIELD','BOOLEAN'),entry('amount','LEAD_FIELD','CURRENCY')];
  const versions={ bindingVersion:1,connectionVersion:1,resourceVersion:1 };const save={ ...versions,version:0,entries,status:'PUBLISHED',reason:'Publish approved mappings' };
  assert.equal((await api('GET',base,undefined,'agent')).statusCode,403);assert.equal((await api('GET',base,undefined,'other')).statusCode,404);
  for (const route of ['', '/targets','/history']) assert.equal((await api('GET',base+route,undefined,'agent')).statusCode,403);
  assert.equal((await api('PUT',base,save,'agent')).statusCode,403);assert.equal((await api('POST',base+'/preview',{ ...versions,entries,values:[] },'agent')).statusCode,403);
  const targets=(await api('GET',base+'/targets')).json();assert.equal(targets.items.length,4);assert.ok(!JSON.stringify(targets).includes('hidden'));assert.ok(!JSON.stringify(targets).includes('calculated'));
  assert.ok(targets.suggestions.some((s:{ sourceKey:string;kind:string })=>s.sourceKey==='score' && s.kind==='LEAD_FIELD'));
  const targetPage=(await api('GET',base+'/targets?limit=1')).json();assert.ok(targetPage.nextAfter);assert.notEqual((await api('GET',base+'/targets?limit=1&after='+targetPage.nextAfter)).json().items[0].id,targetPage.items[0].id);
  for (const key of ['hidden','locked','system','calculated']) {
    const invalid={ ...entry('score'),fieldId:fieldIds[key] };assert.equal((await api('PUT',base,{ ...save,entries:[invalid] })).statusCode,404);
  }
  assert.equal((await api('PUT',base,{ ...save,entries:[entry('score','LEAD_FIELD','TEXT')] })).statusCode,400);
  assert.equal((await api('PUT',base,{ ...save,entries:[entry('absent','CONTACT_NAME')] })).statusCode,400);
  assert.equal((await api('PUT',base,{ ...save,entries:[] })).json().error,'SOURCE_MAPPING_REQUIRED_FIELD_UNMAPPED');
  const draft=await api('PUT',base,{ ...save,status:'DRAFT',entries:[] });assert.equal(draft.statusCode,200);assert.ok(draft.json().warnings.includes('SOURCE_MAPPING_REQUIRED_FIELD_UNMAPPED'));
  const first=(await api('GET',base)).json();assert.equal(first.publishedVersion,null);assert.equal(first.latest.version,1);assert.ok(first.draftWarnings.includes('SOURCE_MAPPING_REQUIRED_FIELD_UNMAPPED'));
  assert.equal((await api('PUT',base,save)).json().error,'SOURCE_MAPPING_VERSION_CONFLICT');
  const races=await Promise.all([api('PUT',base,{ ...save,version:1 }),api('PUT',base,{ ...save,version:1 })]);assert.deepEqual(races.map((r)=>r.statusCode).sort(),[200,409]);
  const published=(await api('GET',base)).json();assert.equal(published.publishedVersion,2);assert.equal(published.configured,true);assert.equal(published.intakeReady,false);
  const bindings=(await api('GET',`/api/sources/campaigns/${campaign}/bindings`)).json();assert.equal(bindings.items[0].mapping_configured,true);
  assert.ok(!bindings.items[0].issues.includes('SOURCE_MAPPING_NOT_CONFIGURED'));assert.ok(bindings.items[0].issues.includes('SOURCE_PAGE_SUBSCRIPTION_REQUIRED'));
  const values=[{ key:'full_name',values:['<img src=x>'] },{ key:'phone',values:['+1 (555) 000-1111'] },{ key:'email',values:[' USER@EXAMPLE.COM '] },
    { key:'score',values:['5.50'] },{ key:'choice',values:['Provider A'] },{ key:'enabled',values:['false'] },{ key:'amount',values:['99.00'] }];
  const preview=await api('POST',base+'/preview',{ ...versions,entries,values });assert.equal(preview.statusCode,200);assert.equal(preview.json().valid,true);
  assert.deepEqual(preview.json().contact,{ name:'<img src=x>',phone:'+15550001111',email:'user@example.com' });assert.equal(preview.json().fields.length,4);
  assert.ok(preview.json().warnings.includes('SOURCE_QUESTION_KEY_MISSING'));
  const invalidPreview=await api('POST',base+'/preview',{ ...versions,entries,values:[{ key:'score',values:['bad'] }] });assert.equal(invalidPreview.statusCode,200);assert.equal(invalidPreview.json().valid,false);
  assert.ok(invalidPreview.json().errors.some((e:{ code:string })=>e.code==='SOURCE_REQUIRED_VALUE_MISSING'));
  assert.equal((await api('POST',base+'/preview',{ ...versions,entries,values:[{ key:'score',values:['1'] },{ key:'score',values:['2'] }] })).statusCode,400);
  const raw={ source:'original',field_data:[{ name:'score',values:['untouched'] }] };const submission=(await db`INSERT INTO source_submission (organization_id,source_kind,connection_id,external_event_id,raw_payload)
    VALUES (${org},'META',${conn},'original-test-submission',${db.json(raw)}) RETURNING id`)[0]!.id;
  assert.equal((await api('PUT',base,{ ...save,version:2,status:'DRAFT',entries:[],reason:'Draft does not replace published' })).statusCode,200);
  assert.equal((await api('GET',base)).json().publishedVersion,2);assert.equal((await api('GET',base)).json().configured,true);
  assert.deepEqual((await db`SELECT raw_payload FROM source_submission WHERE id=${submission}`)[0]!.raw_payload,raw);
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead`)[0]!.n,0);assert.equal((await db`SELECT count(*)::integer AS n FROM lead_field_value`)[0]!.n,0);
  const history=(await api('GET',base+'/history?limit=1')).json();assert.equal(history.items[0].version,3);assert.equal(history.nextBefore,3);
  assert.equal((await api('GET',base+'/history?beforeVersion=3')).json().items.length,2);
  await assert.rejects(db`UPDATE source_mapping_revision SET reason='rewrite' WHERE binding_id=${binding}`);await assert.rejects(db`DELETE FROM source_mapping_revision WHERE binding_id=${binding}`);
  await db`UPDATE field_definition SET validation='{"min":10}'::jsonb,version=version+1 WHERE id=${fieldIds.score!}`;
  assert.ok((await api('GET',base)).json().issues.includes('SOURCE_MAPPING_TARGET_CHANGED'));
  assert.equal((await api('GET',`/api/sources/campaigns/${campaign}/bindings`)).json().items[0].mapping_configured,false);
  assert.equal((await api('POST',base+'/preview',{ ...versions,entries,values })).json().valid,false,'preview uses current validation, not a stale published snapshot');
  await db`UPDATE field_definition SET validation='{}'::jsonb,version=version+1 WHERE id=${fieldIds.score!}`;
  assert.equal((await api('PUT',base,{ ...save,version:3 })).statusCode,200);
  await db`UPDATE source_resource SET version=version+1 WHERE id=${form}`;
  assert.equal((await api('GET',base)).json().configured,true,'identical catalog resync does not invalidate semantic mapping');
  assert.equal((await api('PUT',base,{ ...save,version:4 })).json().error,'SOURCE_MAPPING_CONFIGURATION_CHANGED');
  await db`UPDATE source_resource SET questions=questions || '[{"key":"new","externalId":null,"label":"New","type":"CUSTOM","options":[]}]'::jsonb,version=version+1 WHERE id=${form}`;
  assert.ok((await api('GET',base)).json().issues.includes('SOURCE_MAPPING_CATALOG_CHANGED'));
  assert.equal((await api('POST',base+'/preview',{ ...versions,entries,values })).json().error,'SOURCE_MAPPING_CONFIGURATION_CHANGED');
  assert.equal((await api('PUT',base,{ ...save,version:4,resourceVersion:3 })).statusCode,200);
  await db`UPDATE campaign_field SET visible_to_manager=false,version=version+1 WHERE campaign_id=${campaign} AND field_id=${fieldIds.choice!}`;
  const redacted=(await api('GET',base)).json();assert.equal(redacted.latest.redacted,true);assert.ok(!JSON.stringify(redacted.latest).includes(fieldIds.choice!));
  const redactedHistory=await api('GET',base+'/history');assert.ok(!redactedHistory.body.includes(fieldIds.choice!));
  assert.equal((await api('GET',base,undefined,'admin')).json().latest.redacted,false);
  const resourceRoot=`/api/sources/meta/connections/${conn}/resources/${form}/access/${branch}`;
  assert.equal((await api('PUT',resourceRoot,{ version:1,active:false,reason:'Revoke mapped Form' },'admin')).statusCode,200);
  assert.equal((await api('GET',base)).statusCode,404);assert.equal((await api('GET',base+'/history')).statusCode,404);
  assert.equal((await api('POST',base+'/preview',{ ...versions,resourceVersion:3,entries,values })).statusCode,404);
  assert.equal((await api('PUT',resourceRoot,{ version:2,active:true,reason:'Restore mapped Form' },'admin')).statusCode,200);
  await db`UPDATE integration_connection SET status='AUTH_EXPIRED' WHERE id=${conn}`;
  assert.equal((await api('PUT',base,{ ...save,version:5,resourceVersion:3,bindingVersion:2 },'admin')).json().error,'SOURCE_MAPPING_RESOURCE_NOT_AVAILABLE');
  assert.equal((await api('PUT',base,{ ...save,version:5,resourceVersion:3,bindingVersion:2,status:'DRAFT' },'admin')).statusCode,200,'draft can be repaired while source health is unavailable');
  const audit=await db`SELECT action,detail FROM audit_log WHERE target_id=${binding}`;assert.ok(audit.some((a)=>a.action==='SOURCE_MAPPING_PUBLISHED'));assert.ok(audit.some((a)=>a.action==='SOURCE_MAPPING_DRAFT'));
  assert.ok(!JSON.stringify(audit).includes('USER@EXAMPLE.COM'));assert.ok(!JSON.stringify(audit).includes('untouched'));
});
