import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { processOneSourceEvaluation } from '../src/sources/evaluation.js';
import { processOneSourceIntake } from '../src/sources/intake.js';
const url=process.env.TEST_DATABASE_URL;if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('Source intake atomically creates scoped Leads, matches optional Contacts, preserves typed provenance, routes, reviews ambiguity and survives concurrency/failure',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=> { await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Intake') RETURNING id`)[0]!.id;
  const foreignOrg=(await db`INSERT INTO organization (name) VALUES ('Foreign') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope,userOrg] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',otherBranch,org],
    ['agent','AGENT',branch,org],['second','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${userOrg},${scope},${name},${role},${name+'@intake.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
    users[name]={ id,cookie:'lop_session='+token };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT'|'PATCH',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.1.${ip++}` });
  const campaign=(await db`INSERT INTO campaign (organization_id,branch_id,name,source_kind,routing_method)
    VALUES (${org},${branch},'Source','META','ROUND_ROBIN') RETURNING id`)[0]!.id;
  await db`INSERT INTO campaign_agent (campaign_id,agent_id) VALUES (${campaign},${users.agent!.id}),(${campaign},${users.second!.id})`;
  const otherCampaign=(await db`INSERT INTO campaign (organization_id,branch_id,name,source_kind,status,routing_method)
    VALUES (${org},${otherBranch},'Other','META','ACTIVE','MANUAL') RETURNING id`)[0]!.id;
  const fields:Record<string,string>={};
  for (const [key,type,mode,required] of [['score','NUMBER','SOURCE','LEAD_CREATION'],['flag','BOOLEAN','SOURCE','NONE'],['label','TEXT','MANUAL','NONE']] as const) {
    const id=(await db`INSERT INTO field_definition (organization_id,branch_id,campaign_id,key,label,field_type,value_mode)
      VALUES (${org},${branch},${campaign},${key},${key},${type},${mode}) RETURNING id`)[0]!.id;
    await db`INSERT INTO campaign_field (campaign_id,field_id,required_stage,editable_by_manager) VALUES (${campaign},${id},${required},${mode==='MANUAL'})`;fields[key]=id;
  }
  const questions=['name','phone','email','score','flag','label'].map((key)=>({ key,externalId:null,label:key,type:'CUSTOM',options:[] }));
  const entries=[...['name','phone','email'].map((key)=>({ sourceKey:key,kind:'CONTACT_'+key.toUpperCase(),transform:'TEXT',optionMap:[] })),
    ...Object.entries(fields).map(([key,id])=>({ sourceKey:key,kind:'LEAD_FIELD',fieldId:id,transform:key==='score' ? 'NUMBER' : key==='flag' ? 'BOOLEAN' : 'TEXT',optionMap:[] }))];
  const setup=async()=> {
    const conn=(await db`INSERT INTO integration_connection (organization_id,kind,provider,name,status)
      VALUES (${org},'META','META_LEAD_ADS','Shared','WARNING') RETURNING id`)[0]!.id;
    const page=(await db`INSERT INTO source_resource (connection_id,resource_kind,external_id,name,connection_version)
      VALUES (${conn},'PAGE','10','Page',1) RETURNING id`)[0]!.id;
    const form=(await db`INSERT INTO source_resource (connection_id,resource_kind,parent_id,external_id,name,connection_version,questions)
      VALUES (${conn},'FORM',${page},'20','Form',1,${db.json(questions)}) RETURNING id`)[0]!.id;
    await db`INSERT INTO source_resource_access (resource_id,branch_id,updated_by,change_reason) VALUES (${form},${branch},${users.admin!.id},'Approved')`;
    const bound=await api('POST',`/api/sources/campaigns/${campaign}/bindings`,{ connectionId:conn,formId:form,requestId:randomUUID(),connectionVersion:1,
      externalCampaignId:'100',externalAdSetId:null,externalAdId:null,active:true,reason:'Approved context' });assert.equal(bound.statusCode,201,bound.body);
    const binding=bound.json().id as string;const mapping=`/api/sources/campaigns/${campaign}/bindings/${binding}/mapping`;
    const publish=async()=> {
      const current=(await api('GET',mapping)).json();const mapped=await api('PUT',mapping,{ entries,status:'PUBLISHED',reason:'Published intake mapping',
        version:current.latest?.version ?? 0,bindingVersion:current.bindingVersion,connectionVersion:current.connectionVersion,resourceVersion:current.resourceVersion });
      assert.equal(mapped.statusCode,200,mapped.body);
    };await publish();return { conn,form,binding,publish };
  };
  const first=await setup();let sequence=1000;
  const submit=async(values:Record<string,string>,connection=first.conn,externalCampaignId='100')=> {
    const id=String(sequence++);const raw={ context:{ pageId:'10',formId:'20',leadId:id },notification:{ pageId:'10',change:{ value:{} } },
      lead:{ id,form_id:'20',campaign_id:externalCampaignId,created_time:'2023-11-14T22:13:19+0000',field_data:Object.entries({ score:'0',flag:'false',label:'original label',...values }).map(([name,value])=>({ name,values:[value] })) } };
    const s=(await db`INSERT INTO source_submission (organization_id,source_kind,connection_id,external_event_id,raw_payload,source_timestamp)
      VALUES (${org},'META',${connection},${id},${db.json(raw)},'2023-11-14T22:13:19Z') RETURNING id`)[0]!.id as string;
    assert.equal(await processOneSourceEvaluation(db),true);return { id:s,raw };
  };
  const row=async(id:string)=>(await db`SELECT p.*,s.lead_id,s.resolution_contact_id,s.raw_payload,s.source_timestamp FROM source_processing p JOIN source_submission s ON s.id=p.submission_id WHERE p.submission_id=${id}`)[0]!;
  const reprocess=async(id:string)=> { const r=await api('POST',`/api/sources/submissions/${id}/reprocess`,{ version:(await row(id)).version,reason:'Current setup repaired' });assert.equal(r.statusCode,200,r.body);assert.equal(await processOneSourceEvaluation(db),true); };
  const inactive=await submit({});assert.equal(await processOneSourceIntake(db),true);assert.equal((await row(inactive.id)).error_code,'SOURCE_CAMPAIGN_INACTIVE');
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead`)[0]!.n,0);
  // ACTIVE is a deliberate domain fixture; public readiness remains a separate guarded setup dependency.
  await db`UPDATE campaign SET status='ACTIVE' WHERE id=${campaign}`;await reprocess(inactive.id);
  const racing=await Promise.all([processOneSourceIntake(db),processOneSourceIntake(db)]);assert.deepEqual(racing.sort(),[false,true]);
  const empty=await row(inactive.id);assert.equal(empty.state,'PROCESSED');assert.equal(empty.resolution_contact_id,null);assert.ok(empty.lead_id);
  assert.deepEqual(empty.raw_payload,inactive.raw);assert.equal(empty.source_timestamp.toISOString(),'2023-11-14T22:13:19.000Z');
  assert.equal((await db`SELECT count(*)::integer AS n FROM contact`)[0]!.n,0);
  const values=await db`SELECT * FROM lead_field_value WHERE lead_id=${empty.lead_id}`;assert.equal(values.length,3);
  assert.equal(values.find((v)=>v.field_id===fields.score)!.value,0);assert.equal(values.find((v)=>v.field_id===fields.flag)!.value,false);
  assert.ok(values.every((v)=>v.source==='SOURCE' && v.source_submission_id===inactive.id && v.source_binding_id===first.binding && v.source_mapping_version===1));
  assert.equal((await db`SELECT count(*)::integer AS n FROM field_value_history WHERE lead_id=${empty.lead_id} AND source='SOURCE'`)[0]!.n,3);
  assert.equal((await db`SELECT count(*)::integer AS n FROM assignment_history WHERE lead_id=${empty.lead_id}`)[0]!.n,1);
  const assigned=(await db`SELECT assigned_agent_id FROM lead WHERE id=${empty.lead_id}`)[0]!.assigned_agent_id;
  const owner=assigned===users.agent!.id ? 'agent' : 'second';const nonowner=owner==='agent' ? 'second' : 'agent';
  assert.equal((await api('GET','/api/leads/'+empty.lead_id,undefined,owner)).statusCode,200);assert.equal((await api('GET','/api/leads/'+empty.lead_id,undefined,nonowner)).statusCode,404);
  assert.equal((await api('PUT',`/api/leads/${empty.lead_id}/fields/${fields.score}`,{ value:9,version:1 },owner)).statusCode,403);
  const edited=await api('PUT',`/api/leads/${empty.lead_id}/fields/${fields.label}`,{ value:'operational correction',version:1 });assert.equal(edited.statusCode,200,edited.body);
  const label=(await db`SELECT * FROM lead_field_value WHERE lead_id=${empty.lead_id} AND field_id=${fields.label!}`)[0]!;
  assert.equal(label.source,'MANUAL');assert.equal(label.source_submission_id,null);assert.equal((await db`SELECT source_submission_id FROM field_value_history WHERE lead_id=${empty.lead_id} AND field_id=${fields.label!} ORDER BY id LIMIT 1`)[0]!.source_submission_id,inactive.id);
  assert.equal((await api('POST',`/api/sources/submissions/${inactive.id}/reprocess`,{ version:empty.version,reason:'duplicate' })).statusCode,409);
  await assert.rejects(db`UPDATE source_submission SET lead_id=NULL WHERE id=${inactive.id}`,/SOURCE_INTAKE_LINK_IMMUTABLE/);
  await assert.rejects(db`UPDATE source_processing SET state='PENDING',version=version+1 WHERE submission_id=${inactive.id}`,/SOURCE_INTAKE_RESULT_IMMUTABLE/);
  const nameOnly=await submit({ name:'Same name' });await processOneSourceIntake(db);const nameAgain=await submit({ name:'Same name' });await processOneSourceIntake(db);
  assert.notEqual((await row(nameOnly.id)).resolution_contact_id,(await row(nameAgain.id)).resolution_contact_id,'names are not matching identities');
  const nameContact=(await row(nameOnly.id)).resolution_contact_id;
  assert.equal((await api('PATCH','/api/contacts/'+nameContact,{ version:1,name:'Corrected name only' })).statusCode,200);
  assert.equal((await api('PATCH','/api/contacts/'+nameContact,{ version:2,name:'' })).json().error,'CONTACT_DATA_REQUIRED');
  const phoneOnly=await submit({ phone:'+1 (555) 000-7777' });await processOneSourceIntake(db);const contactId=(await row(phoneOnly.id)).resolution_contact_id;
  const originalContact=(await db`SELECT * FROM contact WHERE id=${contactId}`)[0]!;assert.equal(originalContact.name,'');assert.equal(originalContact.phone_normalized,'+15550007777');
  assert.equal((await api('PATCH','/api/contacts/'+contactId,{ version:1,name:'',phone:'+15550007777' })).statusCode,200);
  const repeat=await submit({ name:'Do not overwrite',phone:'+15550007777',email:'new@example.test' });await processOneSourceIntake(db);
  assert.equal((await row(repeat.id)).resolution_contact_id,contactId);assert.deepEqual((await db`SELECT * FROM contact WHERE id=${contactId}`)[0],originalContact);
  // The person may be shared across campaigns/branches; no prior Lead data is exposed by matching.
  await db`INSERT INTO source_resource_access (resource_id,branch_id,updated_by,change_reason) VALUES (${first.form},${otherBranch},${users.admin!.id},'Other branch')`;
  const b=await api('POST',`/api/sources/campaigns/${otherCampaign}/bindings`,{ connectionId:first.conn,formId:first.form,requestId:randomUUID(),connectionVersion:1,
    externalCampaignId:'101',externalAdSetId:null,externalAdId:null,active:true,reason:'Other context' },'admin');assert.equal(b.statusCode,201,b.body);
  const base=`/api/sources/campaigns/${otherCampaign}/bindings/${b.json().id}/mapping`;const current=(await api('GET',base,undefined,'admin')).json();
  assert.equal((await api('PUT',base,{ version:0,bindingVersion:1,connectionVersion:1,resourceVersion:current.resourceVersion,entries:entries.slice(0,3),status:'PUBLISHED',reason:'Contact only' },'admin')).statusCode,200);
  const shared=await submit({ phone:'+15550007777' },first.conn,'101');await processOneSourceIntake(db);const sharedRow=await row(shared.id);
  assert.equal(sharedRow.resolution_contact_id,contactId);assert.equal((await api('GET','/api/leads/'+sharedRow.lead_id)).statusCode,404);
  assert.equal((await api('GET','/api/leads/'+sharedRow.lead_id,undefined,'other')).statusCode,200);
  assert.equal((await api('PATCH','/api/contacts/'+contactId,{ version:1,name:'blocked edit' })).statusCode,403);
  // Current identity matching is ambiguous; only explicit scoped review may choose a person.
  const makeContact=async(name:string,phone:string|null,email:string|null,scope=branch)=> {
    const c=(await db`INSERT INTO contact (organization_id,name,phone,phone_normalized,email,email_normalized) VALUES (${org},${name},${phone},${phone},${email},${email}) RETURNING id`)[0]!.id;
    await db`INSERT INTO lead (organization_id,branch_id,campaign_id,contact_id,source_kind) VALUES (${org},${scope},${scope===branch ? campaign : otherCampaign},${c},'MANUAL')`;return c as string;
  };
  const a=await makeContact('Local A','+15550006666',null);const c=await makeContact('Local B',null,'b@example.test');
  const ambiguous=await submit({ name:'<img src=x> incoming',phone:'+15550006666',email:'B@EXAMPLE.TEST' });await processOneSourceIntake(db);
  assert.equal((await row(ambiguous.id)).error_code,'CONTACT_AMBIGUOUS');assert.equal((await row(ambiguous.id)).lead_id,null);
  const reviewPath=`/api/sources/submissions/${ambiguous.id}/contact-review`;const resolvePath=`/api/sources/submissions/${ambiguous.id}/resolve-contact`;
  assert.equal((await api('GET',reviewPath,undefined,'agent')).statusCode,403);assert.equal((await api('GET',reviewPath,undefined,'other')).statusCode,404);assert.equal((await api('GET',reviewPath,undefined,'foreign')).statusCode,404);
  const candidates=(await api('GET',reviewPath+'?limit=1')).json();assert.equal(candidates.items.length,1);assert.ok(candidates.nextAfter);assert.equal(candidates.adminRequired,false);
  const next=(await api('GET',reviewPath+'?after='+candidates.nextAfter)).json();assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,candidates.items[0].id);
  const choice={ version:candidates.version,fingerprint:candidates.fingerprint,contactId:a,reason:'Validated customer identity' };
  assert.equal((await api('POST',resolvePath,{ ...choice,contactId:contactId })).json().error,'SOURCE_CONTACT_MATCH_CHANGED');
  assert.equal((await api('POST',resolvePath,{ ...choice,version:1 })).json().error,'SOURCE_PROCESSING_VERSION_CONFLICT');
  assert.equal((await api('POST',resolvePath,{ ...choice,reason:'   ' })).statusCode,400);
  await first.publish();assert.equal((await api('POST',resolvePath,choice)).json().error,'SOURCE_CONTACT_MATCH_CHANGED');
  const fresh=(await api('GET',reviewPath)).json();const resolutions=await Promise.all([api('POST',resolvePath,{ ...choice,fingerprint:fresh.fingerprint }),api('POST',resolvePath,{ ...choice,fingerprint:fresh.fingerprint })]);
  assert.deepEqual(resolutions.map((r)=>r.statusCode).sort(),[200,409]);assert.equal((await row(ambiguous.id)).resolution_contact_id,a);
  assert.equal((await db`SELECT count(*)::integer AS n FROM source_processing_history WHERE submission_id=${ambiguous.id} AND state='PROCESSED'`)[0]!.n,1);
  const hidden=await makeContact('SECRET other branch',null,'hidden@example.test',otherBranch);
  const restricted=await submit({ phone:'+15550006666',email:'hidden@example.test' });await processOneSourceIntake(db);
  const restrictedPath=`/api/sources/submissions/${restricted.id}`;const visible=await api('GET',restrictedPath+'/contact-review');const hiddenReview=visible.json();
  assert.equal(hiddenReview.adminRequired,true);assert.equal(hiddenReview.items.length,1);assert.ok(!visible.body.includes(hidden));assert.ok(!visible.body.includes('SECRET'));
  assert.equal((await api('POST',restrictedPath+'/resolve-contact',{ version:hiddenReview.version,fingerprint:hiddenReview.fingerprint,contactId:a,reason:'not authorized' })).statusCode,403);
  const adminReview=(await api('GET',restrictedPath+'/contact-review',undefined,'admin')).json();assert.equal(adminReview.items.length,2);
  const adminResolved=await api('POST',restrictedPath+'/resolve-contact',{ version:adminReview.version,fingerprint:adminReview.fingerprint,contactId:hidden,reason:'Admin approved exact person' },'admin');assert.equal(adminResolved.statusCode,200,adminResolved.body);
  // A database failure after Contact/Lead/fields were written rolls back the entire transaction and retries exactly once.
  const rollback=await submit({ phone:'+15550005555',name:'rollback candidate' });const before=await row(rollback.id);
  await db`CREATE FUNCTION test_intake_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='SOURCE_LEAD_CREATED' THEN RAISE EXCEPTION 'synthetic failure' USING ERRCODE='40001'; END IF; RETURN NEW; END; $$`;
  await db`CREATE TRIGGER test_intake_failure BEFORE INSERT ON lead_activity FOR EACH ROW EXECUTE FUNCTION test_intake_failure()`;
  try { await assert.rejects(processOneSourceIntake(db),/synthetic failure/); }
  finally { await db`DROP TRIGGER test_intake_failure ON lead_activity`;await db`DROP FUNCTION test_intake_failure()`; }
  assert.equal((await row(rollback.id)).version,before.version);assert.equal((await row(rollback.id)).state,'VALIDATED');
  assert.equal((await db`SELECT count(*)::integer AS n FROM contact WHERE phone_normalized='+15550005555'`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead_field_value WHERE source_submission_id=${rollback.id}`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE target_id=${rollback.id} AND action='SOURCE_INTAKE_EXECUTED'`)[0]!.n,0);
  assert.equal(await processOneSourceIntake(db),true);assert.equal(await processOneSourceIntake(db),false);assert.deepEqual((await row(rollback.id)).raw_payload,rollback.raw);
  const second=await setup();const concurrentA=await submit({ phone:'+15550003333' });const concurrentB=await submit({ phone:'+15550003333' },second.conn);
  assert.deepEqual(await Promise.all([processOneSourceIntake(db),processOneSourceIntake(db)]),[true,true]);
  assert.equal((await row(concurrentA.id)).resolution_contact_id,(await row(concurrentB.id)).resolution_contact_id);
  assert.equal((await db`SELECT count(*)::integer AS n FROM contact WHERE phone_normalized='+15550003333'`)[0]!.n,1);
  // Identity-first Contact edit locks prevent a source match from using an identity removed concurrently.
  const editingContact=(await row(concurrentA.id)).resolution_contact_id;
  const editRace=await submit({ phone:'+15550003333' });
  let unlock!:()=>void;let held!:()=>void;const locked=new Promise<void>((r)=> { held=r; });const release=new Promise<void>((r)=> { unlock=r; });
  const holder=db.begin(async(tx)=> { await tx`SELECT pg_advisory_xact_lock(hashtextextended(${org+':phone:+15550003333'},0))`;held();await release; });await locked;
  const editPromise=api('PATCH','/api/contacts/'+editingContact,{ version:1,name:'Edited person',phone:'+15550003232' });
  for (let i=0;i<100;i++) {
    const waiting=(await db`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%'`).length;
    if (waiting) break;if (i===99) { unlock();await holder;throw new Error('Contact edit did not reach identity lock'); }await new Promise((r)=>setTimeout(r,10));
  }
  const intakePromise=processOneSourceIntake(db);unlock();await holder;
  const editResult=await editPromise;assert.equal(editResult.statusCode,200,editResult.body);assert.equal(await intakePromise,true);
  assert.notEqual((await row(editRace.id)).resolution_contact_id,editingContact);
  assert.equal((await db`SELECT phone_normalized FROM contact WHERE id=${editingContact}`)[0]!.phone_normalized,'+15550003232');
  // A requester disabled while waiting for the Connection lock cannot resolve a review using an earlier principal.
  const waitingReview=await submit({ phone:'+15550006666',email:'b@example.test' });await processOneSourceIntake(db);
  const waitingPath=`/api/sources/submissions/${waitingReview.id}`;const waitingCandidates=(await api('GET',waitingPath+'/contact-review')).json();
  let unlockConnection!:()=>void;let connectionHeld!:()=>void;const connectionLocked=new Promise<void>((r)=> { connectionHeld=r; });const connectionRelease=new Promise<void>((r)=> { unlockConnection=r; });
  const connectionHolder=db.begin(async(tx)=> { await tx`SELECT id FROM integration_connection WHERE id=${first.conn} FOR UPDATE`;connectionHeld();await connectionRelease; });await connectionLocked;
  const waitingRequest=api('POST',waitingPath+'/resolve-contact',{ version:waitingCandidates.version,fingerprint:waitingCandidates.fingerprint,contactId:a,reason:'Request made before disable' });
  for (let i=0;i<100;i++) {
    const waiting=(await db`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM integration_connection%'`).length;
    if (waiting) break;if (i===99) { unlockConnection();await connectionHolder;throw new Error('Review did not reach Connection lock'); }await new Promise((r)=>setTimeout(r,10));
  }
  await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;unlockConnection();await connectionHolder;
  assert.equal((await waitingRequest).statusCode,403);assert.equal((await row(waitingReview.id)).lead_id,null);
  await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;
  // Fresh mapping/connection/campaign/required fields are enforced at dispatch, not only during evaluation.
  const changed=await submit({ phone:'+15550002222' });await db`UPDATE field_definition SET version=version+1 WHERE id=${fields.score!}`;
  await processOneSourceIntake(db);assert.equal((await row(changed.id)).error_code,'SOURCE_MAPPING_TARGET_CHANGED');assert.equal((await row(changed.id)).lead_id,null);
  await first.publish();await reprocess(changed.id);await db`UPDATE campaign SET status='INACTIVE' WHERE id=${campaign}`;await processOneSourceIntake(db);
  assert.equal((await row(changed.id)).error_code,'SOURCE_CAMPAIGN_INACTIVE');await db`UPDATE campaign SET status='ACTIVE' WHERE id=${campaign}`;
  await reprocess(changed.id);await db`UPDATE integration_connection SET status='DISABLED' WHERE id=${first.conn}`;await processOneSourceIntake(db);
  assert.equal((await row(changed.id)).error_code,'SOURCE_CONNECTION_NOT_AVAILABLE');await db`UPDATE integration_connection SET status='WARNING' WHERE id=${first.conn}`;
  await reprocess(changed.id);await db`UPDATE source_resource_access SET active=false,version=version+1,updated_by=${users.admin!.id},change_reason='Revoked' WHERE resource_id=${first.form} AND branch_id=${branch}`;
  await processOneSourceIntake(db);assert.equal((await row(changed.id)).error_code,'SOURCE_BINDING_UNMATCHED');
  assert.equal((await api('GET',`/api/sources/submissions/${changed.id}/history`)).statusCode,404);
  assert.equal((await api('GET',`/api/sources/submissions?connectionId=${first.conn}`,undefined,'agent')).statusCode,403);
  const safe=(await api('GET',`/api/sources/submissions?connectionId=${second.conn}`)).body;assert.ok(!safe.includes('15550003333'));assert.ok(!safe.includes('raw_payload'));
  assert.ok(c); // The second candidate remains an independent person; no automatic merge or overwrite.
});
