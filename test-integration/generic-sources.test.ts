import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { processOneSourceEvaluation } from '../src/sources/evaluation.js';
import { processOneSourceIntake } from '../src/sources/intake.js';

const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Generic Webhook setup isolates real sessions and preserves one current signed test across rotation, retries and failure', async t=>{
  process.env.APP_ORIGIN='http://127.0.0.1:5173';
  process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
  t.after(async()=>{await app.close();await db.end();});
  await db.begin(async tx=>{
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`;
    await tx`TRUNCATE organization CASCADE`;
  });
  const [org]=await db`INSERT INTO organization(name) VALUES('Generic test scope') RETURNING id`;
  const [foreignOrg]=await db`INSERT INTO organization(name) VALUES('Generic foreign scope') RETURNING id`;
  const [branch,other]=await db`INSERT INTO branch(organization_id,name)
    VALUES(${org!.id},'Generic Branch'),(${org!.id},'Other Generic Branch') RETURNING id`;
  async function user(role:string,branchId:string|null,organizationId=org!.id) {
    const [actor]=await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
      VALUES(${organizationId},${branchId},${role},'Synthetic user',${randomUUID()+'@generic.test'},'fixture') RETURNING id`;
    const token=randomBytes(32).toString('hex');
    const [session]=await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES
      (${actor!.id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`;
    return {cookie:'lop_session='+token,session:session!.id};
  }
  const manager=await user('MANAGER',branch!.id), otherManager=await user('MANAGER',other!.id);
  const agent=await user('AGENT',branch!.id), foreign=await user('SUPER_ADMIN',null,foreignOrg!.id);
  const root='/api/sources/generic/connections';
  const api=(method:'GET'|'POST',suffix:string,payload?:object,actor=manager)=>app.inject({
    method,url:root+suffix,payload,headers:{cookie:actor.cookie,origin:process.env.APP_ORIGIN!},
  });
  const input={branchId:branch!.id,name:'Synthetic webhook',reason:'Authorize synthetic signing setup'};
  assert.equal((await api('POST','',input,agent)).statusCode,403);
  assert.equal((await api('POST','',{...input,branchId:other!.id})).statusCode,404);
  const created=await api('POST','',input);
  assert.equal(created.statusCode,201,created.body);
  assert.equal(created.headers['cache-control'],'no-store');
  const {id,signingSecret,callbackPath}=created.json() as {id:string;signingSecret:string;callbackPath:string};
  assert.match(signingSecret,/^[0-9a-f]{64}$/);
  const [encrypted]=await db`SELECT ciphertext,nonce,auth_tag FROM connection_secret WHERE connection_id=${id}`;
  assert.equal(encrypted!.ciphertext.equals(Buffer.from(signingSecret)),false);
  const listed=await api('GET','');
  assert.equal(listed.statusCode,200,listed.body);
  assert.ok(!listed.body.includes(signingSecret));
  assert.equal(listed.json().items[0].status,'NOT_CONFIGURED');
  assert.deepEqual((await api('GET','',undefined,otherManager)).json().items,[]);
  assert.deepEqual((await api('GET','',undefined,foreign)).json().items,[]);
  assert.equal((await api('GET','/'+id+'/tests',undefined,foreign)).statusCode,404);
  assert.equal((await api('POST','/'+id+'/rotate',{version:1,reason:'Foreign access'},otherManager)).statusCode,404);
  assert.equal((await api('GET','',undefined,agent)).statusCode,403);
  await assert.rejects(db`UPDATE integration_connection SET status='CONNECTED' WHERE id=${id}`,/GENERIC_SOURCE_CONNECTION_PROOF_REQUIRED/);
  await assert.rejects(db`UPDATE connection_secret SET ciphertext=decode(repeat('00',64),'hex') WHERE connection_id=${id}`,
    /GENERIC_SOURCE_SECRET_ROTATION_REQUIRED/);

  const clock=async()=>(await db`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS seconds`)[0]!.seconds as string;
  async function probe(body:string,secret=signingSecret,timestamp?:string,replaceBody?:string) {
    const seconds=timestamp??await clock();
    const signature=createHmac('sha256',Buffer.from(secret,'hex'))
      .update(`lead-operations.generic-source:test:v1\n${id}\n${seconds}\n`).update(body).digest('hex');
    return app.inject({method:'POST',url:callbackPath,payload:replaceBody??body,
      headers:{'content-type':'application/json','x-source-timestamp':seconds,'x-source-signature':'v1='+signature}});
  }
  const testId=randomUUID(),sample=JSON.stringify({testId});
  assert.equal((await probe(sample,randomBytes(32).toString('hex'))).statusCode,401);
  assert.equal((await probe(sample,signingSecret,String(Number(await clock())-301))).statusCode,401);
  assert.equal((await probe(sample,signingSecret,undefined,sample+' ')).statusCode,401);
  assert.equal((await probe(JSON.stringify({testId,lead:{name:'Forbidden synthetic payload'}}))).statusCode,400);
  const duplicate=await Promise.all(Array.from({length:7},()=>probe(sample)));
  assert.deepEqual(duplicate.map(result=>result.statusCode).sort(),[200,200,200,200,200,200,202]);
  assert.equal((await probe(sample+' ')).statusCode,409);
  const history=await api('GET','/'+id+'/tests');
  assert.deepEqual(history.json().items.map((row:{testId:string;current:boolean})=>[row.testId,row.current]),[[testId,true]]);
  assert.ok(!history.body.includes(signingSecret));
  await assert.rejects(db`DELETE FROM generic_source_test_receipt WHERE connection_id=${id}`,/GENERIC_SOURCE_TEST_IMMUTABLE/);
  assert.equal((await db`SELECT count(*)::int n FROM audit_log WHERE action='GENERIC_SOURCE_TEST_VERIFIED'`)[0]!.n,1);

  const rotate='/'+id+'/rotate';
  const raced=await Promise.all(Array.from({length:4},()=>api('POST',rotate,{version:1,reason:'Rotate the key'})));
  assert.deepEqual(raced.map(result=>result.statusCode).sort(),[200,409,409,409]);
  const rotated=raced.find(result=>result.statusCode===200)!.json().signingSecret as string;
  assert.notEqual(rotated,signingSecret);
  assert.equal((await probe(JSON.stringify({testId:randomUUID()}))).statusCode,401);
  assert.equal((await probe(sample,rotated)).statusCode,409);
  assert.equal((await api('GET','/'+id+'/tests')).json().items[0].current,false);
  const fresh=JSON.stringify({testId:randomUUID()});
  await db`CREATE FUNCTION test_generic_probe_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='GENERIC_SOURCE_TEST_VERIFIED' THEN RAISE EXCEPTION 'Synthetic probe persistence failure';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER test_generic_probe_audit_failure BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION test_generic_probe_audit_failure()`;
  try {
    assert.equal((await probe(fresh,rotated)).statusCode,500);
    assert.equal((await api('GET','')).json().items[0].status,'NOT_CONFIGURED');
    assert.equal((await api('GET','/'+id+'/tests')).json().items.length,1);
  } finally {
    await db`DROP TRIGGER test_generic_probe_audit_failure ON audit_log`;
    await db`DROP FUNCTION test_generic_probe_audit_failure()`;
  }
  assert.equal((await probe(fresh,rotated)).statusCode,202);
  assert.equal((await api('POST','/'+id+'/disable',{version:2,reason:'Disable synthetic source'})).statusCode,200);
  assert.equal((await probe(JSON.stringify({testId:randomUUID()}),rotated)).statusCode,401);
  assert.equal((await db`SELECT count(*)::int n FROM source_submission`)[0]!.n,0);
  assert.equal((await db`SELECT count(*)::int n FROM lead`)[0]!.n,0);
  assert.deepEqual((await db`SELECT operation FROM generic_source_setup_revision WHERE connection_id=${id} ORDER BY version`).map(row=>row.operation),
    ['CREATE','ROTATE','DISABLE']);
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${manager.session}`;
  assert.equal((await api('POST',rotate,{version:3,reason:'Expired scope'})).statusCode,401);
});

test('Generic Webhook creates one scoped lead through shared mapping and intake, with bounded admission and authorized recovery', async t=>{
  process.env.APP_ORIGIN='http://127.0.0.1:5173';
  process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
  t.after(async()=>{await app.close();await db.end();});
  await db.begin(async tx=>{
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`;
    await tx`TRUNCATE organization CASCADE`;
  });
  const [org]=await db`INSERT INTO organization(name) VALUES('Webhook mapping test') RETURNING id`;
  const [branch,foreign]=await db`INSERT INTO branch(organization_id,name)
    VALUES(${org!.id},'Webhook scope'),(${org!.id},'Other branch') RETURNING id`;
  const [manager,other]=await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES
    (${org!.id},${branch!.id},'MANAGER','Scoped manager','manager@webhook.test','fixture'),
    (${org!.id},${foreign!.id},'MANAGER','Other manager','other@webhook.test','fixture') RETURNING id`;
  async function session(id:string) {
    const token=randomBytes(32).toString('hex');
    await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},clock_timestamp()+interval '1 hour')`;
    return 'lop_session='+token;
  }
  const cookie=await session(manager!.id), otherCookie=await session(other!.id);
  const request=(method:'GET'|'POST'|'PUT',path:string,payload?:object,actingCookie=cookie)=>app.inject({
    method,url:path,payload,headers:{cookie:actingCookie,origin:process.env.APP_ORIGIN!},
  });
  const [campaign,second]=await db`INSERT INTO campaign(organization_id,branch_id,source_kind,name) VALUES
    (${org!.id},${branch!.id},'GENERIC_SOURCE','Webhook campaign'),(${org!.id},${branch!.id},'GENERIC_SOURCE','Second campaign') RETURNING id`;
  const create=await request('POST','/api/sources/generic/connections',{branchId:branch!.id,name:'Mapped webhook',reason:'Authorize mapping'});
  assert.equal(create.statusCode,201,create.body);
  const {id,signingSecret,callbackPath}=create.json();
  const schemaPath='/api/sources/generic/connections/'+id+'/schema';
  const input={version:0,connectionVersion:1,keys:['name','email'],reason:'Declare webhook field keys'};
  assert.equal((await request('PUT',schemaPath,input)).json().error,'GENERIC_SOURCE_TEST_REQUIRED');
  assert.equal((await request('GET',schemaPath,undefined,otherCookie)).statusCode,404);
  const body=JSON.stringify({testId:randomUUID()}),seconds=Math.floor(Date.now()/1000);
  const signed=createHmac('sha256',Buffer.from(signingSecret,'hex'))
    .update(`lead-operations.generic-source:test:v1\n${id}\n${seconds}\n`).update(body).digest('hex');
  const probe=await app.inject({method:'POST',url:callbackPath,payload:body,
    headers:{'content-type':'application/json','x-source-timestamp':String(seconds),'x-source-signature':'v1='+signed}});
  assert.equal(probe.statusCode,202,probe.body);
  assert.equal((await request('PUT',schemaPath,{...input,keys:['name','name']})).statusCode,400);
  const concurrent=await Promise.all(Array.from({length:5},()=>request('PUT',schemaPath,input)));
  assert.deepEqual(concurrent.map(result=>result.statusCode).sort(),[200,409,409,409,409]);
  const catalog=(await request('GET',schemaPath)).json().schema;
  assert.equal(catalog.current,true);
  assert.deepEqual(catalog.questions.map((question:{key:string})=>question.key),input.keys);
  await assert.rejects(db`UPDATE source_resource SET version=version+1 WHERE id=${catalog.id}`,/GENERIC_SOURCE_SCHEMA_REVISION_REQUIRED/);

  const root='/api/sources/campaigns/'+campaign!.id;
  assert.deepEqual((await request('GET',root+'/connections')).json().items.map((row:{id:string})=>row.id),[id]);
  const resources=await request('GET',root+'/connections/'+id+'/resources?kind=WEBHOOK_SCHEMA');
  assert.equal(resources.json().items[0].id,catalog.id);
  const bindingInput={connectionId:id,formId:catalog.id,requestId:randomUUID(),connectionVersion:1,
    active:true,externalCampaignId:null,externalAdSetId:null,externalAdId:null,reason:'Bind only the designated campaign'};
  assert.equal((await request('POST',root+'/bindings',{...bindingInput,externalCampaignId:'123'})).statusCode,400);
  const bound=await request('POST',root+'/bindings',bindingInput);
  assert.equal(bound.statusCode,201,bound.body);
  const binding=bound.json().id;
  assert.equal((await request('POST','/api/sources/campaigns/'+second!.id+'/bindings',{...bindingInput,requestId:randomUUID()})).json().error,
    'SOURCE_BINDING_CONTEXT_CONFLICT');
  await assert.rejects(db`UPDATE source_campaign_binding SET version=version+1,generic_session_id=NULL WHERE id=${binding}`,
    /SOURCE_BINDING_SESSION_REQUIRED/);
  const mapping=root+'/bindings/'+binding+'/mapping';
  const versions={bindingVersion:1,connectionVersion:1,resourceVersion:1};
  const entries=[{sourceKey:'name',kind:'CONTACT_NAME',transform:'TEXT',optionMap:[]},
    {sourceKey:'email',kind:'CONTACT_EMAIL',transform:'TEXT',optionMap:[]}];
  const preview=await request('POST',mapping+'/preview',{...versions,entries,values:[{key:'name',values:['Synthetic preview']}]});
  assert.equal(preview.statusCode,200,preview.body);
  assert.equal(preview.json().contact.name,'Synthetic preview');
  const publish=await request('PUT',mapping,{...versions,entries,version:0,status:'PUBLISHED',reason:'Approve source mapping'});
  assert.equal(publish.statusCode,200,publish.body);
  assert.equal((await request('GET',mapping)).json().configured,true);
  assert.equal((await request('GET',mapping,undefined,otherCookie)).statusCode,404);
  const campaignPath='/api/campaigns/'+campaign!.id;
  assert.equal((await request('GET',campaignPath+'/readiness')).json().ready,true);
  async function postEvent(payload:string,purpose='intake') {
    const timestamp=Math.floor(Date.now()/1000);
    const signature=createHmac('sha256',Buffer.from(signingSecret,'hex'))
      .update(`lead-operations.generic-source:${purpose}:v1\n${id}\n${timestamp}\n`).update(payload).digest('hex');
    return app.inject({method:'POST',url:'/api/webhooks/sources/generic/'+id+'/leads',payload,
      headers:{'content-type':'application/json','x-source-timestamp':String(timestamp),'x-source-signature':'v1='+signature}});
  }
  const eventId=randomUUID(),first=JSON.stringify({eventId,fields:{name:'Synthetic Webhook Lead',email:'lead@webhook.test'}});
  assert.equal((await postEvent(first)).statusCode,409);
  const activate=await request('POST',campaignPath+'/activate');
  assert.equal(activate.statusCode,200,activate.body);
  assert.equal((await postEvent(first,'test')).statusCode,401);
  assert.equal((await postEvent(JSON.stringify({eventId,fields:{name:'Invalid',payment:'claimed'}}))).statusCode,400);
  const burst=await Promise.all(Array.from({length:6},()=>postEvent(first)));
  assert.deepEqual(burst.map(response=>response.statusCode).sort(),[200,200,200,200,200,202],burst.map(response=>response.body).join('\n'));
  const submission=burst[0]!.json().id as string;
  assert.equal((await postEvent(first+' ')).statusCode,409);
  assert.equal((await db`SELECT count(*)::int AS n FROM lead`)[0]!.n,0);
  assert.equal(await processOneSourceEvaluation(db),true);
  assert.equal(await processOneSourceIntake(db),true);
  assert.equal(await processOneSourceIntake(db),false);
  const [lead]=await db`SELECT l.id,l.campaign_id,l.source_kind,c.email FROM lead l JOIN contact c ON c.id=l.contact_id`;
  assert.equal(lead!.campaign_id,campaign!.id);
  assert.equal(lead!.source_kind,'GENERIC_SOURCE');
  assert.equal(lead!.email,'lead@webhook.test');
  const origin=await request('GET','/api/leads/'+lead!.id+'/intake-origin');
  assert.equal(origin.json().origin.sourceKind,'GENERIC_SOURCE');
  assert.equal((await request('GET','/api/sources/submissions/'+submission+'/history')).json().items[0].state,'PROCESSED');
  assert.equal((await request('GET','/api/sources/submissions/'+submission+'/history',undefined,otherCookie)).statusCode,404);
  assert.equal((await db`SELECT count(*)::int AS n FROM payment_record`)[0]!.n,0);
  await assert.rejects(db`UPDATE source_submission SET raw_payload='{}'::jsonb WHERE id=${submission}`,/SOURCE_SUBMISSION_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM generic_source_intake_receipt WHERE submission_id=${submission}`,/GENERIC_SOURCE_INTAKE_RECEIPT_IMMUTABLE/);
  const invalid=await postEvent(JSON.stringify({eventId:randomUUID(),fields:{name:'Invalid data',email:'not-an-email'}}));
  assert.equal(invalid.statusCode,202,invalid.body);
  assert.equal(await processOneSourceEvaluation(db),true);
  assert.equal(await processOneSourceIntake(db),false);
  const review=await request('GET','/api/sources/submissions?campaignId='+campaign!.id+'&state=NEEDS_ATTENTION');
  assert.deepEqual(review.json().items.map((item:{error_code:string;external_event_id:string})=>item.error_code),['SOURCE_MAPPING_VALUE_INVALID']);
  const next=await postEvent(JSON.stringify({eventId:randomUUID(),fields:{name:'Synthetic delayed lead',email:'delayed@webhook.test'}}));
  assert.equal(next.statusCode,202,next.body);
  const delayed=next.json().id as string;
  assert.equal((await request('PUT',schemaPath,{...input,version:1,reason:'Reauthorize the current schema'})).statusCode,200);
  assert.equal((await request('GET',mapping)).json().configured,false);
  assert.equal((await request('PUT',mapping,{...versions,entries,version:1,status:'PUBLISHED',reason:'Stale schema'})).json().error,
    'SOURCE_MAPPING_CONFIGURATION_CHANGED');
  assert.equal((await request('GET',mapping+'/history')).json().items[0].reason,'Approve source mapping');
  assert.equal(await processOneSourceEvaluation(db),true);
  const [stale]=await db`SELECT version,state FROM source_processing WHERE submission_id=${delayed}`;
  assert.equal(stale!.state,'NEEDS_ATTENTION');
  const republish=await request('PUT',mapping,{...versions,resourceVersion:2,entries,version:1,status:'PUBLISHED',reason:'Approve refreshed schema'});
  assert.equal(republish.statusCode,200,republish.body);
  await assert.rejects(db`UPDATE source_processing SET version=version+1,state='PENDING',actor_user_id=${manager!.id} WHERE submission_id=${delayed}`,
    /SOURCE_REPROCESS_SESSION_REQUIRED/);
  const retry=await request('POST','/api/sources/submissions/'+delayed+'/reprocess',{version:stale!.version,reason:'Use the approved schema revision'});
  assert.equal(retry.statusCode,200,retry.body);
  assert.equal(await processOneSourceEvaluation(db),true);
  assert.equal(await processOneSourceIntake(db),true);
  assert.equal((await db`SELECT count(*)::int AS n FROM lead`)[0]!.n,2);
});
