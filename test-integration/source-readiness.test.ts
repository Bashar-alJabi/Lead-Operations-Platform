import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHmac } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { processOneSourceRetrieval } from '../src/sources/retrieval-worker.js';
import { processOneSourceEvaluation } from '../src/sources/evaluation.js';
import { processOneSourceIntake } from '../src/sources/intake.js';
const url=process.env.TEST_DATABASE_URL;if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('Source readiness requires current operational setup and activation fences configuration/requesters before real mocked intake',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);let subscribed=true;let calls=0;
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,
    leadSourceCatalogAdapter:{ discoverPages:async()=>[{ externalId:'11',name:'Page',accessToken:'synthetic-page-token' }],
      discoverForms:async()=>[{ externalId:'22',name:'Form',status:'ACTIVE',questions:['phone','score'].map((key)=>({ key,externalId:null,type:'CUSTOM',label:key,options:[] })) }] },
    leadSourceSubscriptionAdapter:{ check:async()=> { calls++;return { subscribed }; } },
  });t.after(async()=> { await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Readiness') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const other=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const foreignOrg=(await db`INSERT INTO organization (name) VALUES ('Foreign') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope,userOrg] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['other','MANAGER',other,org],['agent','AGENT',branch,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${userOrg},${scope},${name},${role},${name+'@readiness.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;users[name]={ id,cookie:'lop_session='+token };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT'|'PATCH',path:string,body?:object,actor='manager')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.2.${ip++}` });
  const created=await api('POST','/api/campaigns',{ branchId:branch,name:'Source',sourceKind:'META' });assert.equal(created.statusCode,201,created.body);
  const campaign=created.json().id as string;const camp='/api/campaigns/'+campaign;
  const ready=async()=>(await api('GET',camp+'/readiness')).json();const activate=()=>api('POST',camp+'/activate');
  assert.ok((await ready()).issues.includes('SOURCE_BINDING_NOT_READY'));assert.equal((await activate()).statusCode,409);
  assert.equal((await api('POST',camp+'/activate',undefined,'agent')).statusCode,403);assert.equal((await api('POST',camp+'/activate',undefined,'other')).statusCode,403);
  assert.equal((await api('POST',camp+'/activate',undefined,'foreign')).statusCode,404);
  const root='/api/sources/meta/connections';const credentials={ accessToken:'synthetic-root-token',appSecret:'synthetic-app-secret',verifyToken:'synthetic-verify-token' };
  const connection=(await api('POST',root,{ name:'Shared',config:{ graphVersion:'v25.0',appId:'777' },credentials },'admin')).json().id as string;const base=root+'/'+connection;
  assert.equal((await api('POST',base+'/discover',{ version:1 },'admin')).statusCode,200);
  let page=(await api('GET',base+'/resources?kind=PAGE',undefined,'admin')).json().items[0];
  assert.equal((await api('POST',base+'/discover',{ version:1,pageId:page.id },'admin')).statusCode,200);
  const form=(await api('GET',base+'/resources?kind=FORM',undefined,'admin')).json().items[0];
  assert.equal((await api('PUT',`${base}/resources/${form.id}/access/${branch}`,{ version:0,active:true,reason:'Shared source authorized' },'admin')).statusCode,200);
  const bindingBase=`/api/sources/campaigns/${campaign}/bindings`;
  const bound=await api('POST',bindingBase,{ connectionId:connection,formId:form.id,connectionVersion:1,requestId:randomUUID(),externalCampaignId:'100',externalAdSetId:null,externalAdId:null,active:true,reason:'Approved' });
  assert.equal(bound.statusCode,201,bound.body);const binding=bound.json().id;const mapping=bindingBase+'/'+binding+'/mapping';
  const field=(await db`INSERT INTO field_definition (organization_id,branch_id,campaign_id,key,label,field_type,value_mode)
    VALUES (${org},${branch},${campaign},'score','Score','NUMBER','SOURCE') RETURNING id`)[0]!.id;
  await db`INSERT INTO campaign_field (campaign_id,field_id,required_stage) VALUES (${campaign},${field},'LEAD_CREATION')`;
  const entries=[{ sourceKey:'phone',kind:'CONTACT_PHONE',transform:'TEXT',optionMap:[] },{ sourceKey:'score',kind:'LEAD_FIELD',fieldId:field,transform:'NUMBER',optionMap:[] }];
  const publish=async(status='PUBLISHED')=> {
    const current=(await api('GET',mapping)).json();const saved=await api('PUT',mapping,{ version:current.latest?.version ?? 0,bindingVersion:current.bindingVersion,
      connectionVersion:current.connectionVersion,resourceVersion:current.resourceVersion,entries,status,reason:'Approved current mapping' });assert.equal(saved.statusCode,200,saved.body);
  };
  assert.ok((await ready()).issues.includes('SOURCE_MAPPING_NOT_CONFIGURED'));await publish();
  let status=await ready();assert.ok(status.issues.includes('SOURCE_WEBHOOK_HANDSHAKE_REQUIRED'));assert.ok(status.issues.includes('SOURCE_PAGE_SUBSCRIPTION_REQUIRED'));
  const handshake=await app.inject({ method:'GET',url:`/api/webhooks/sources/meta/${connection}?hub.mode=subscribe&hub.verify_token=${credentials.verifyToken}&hub.challenge=challenge` });assert.equal(handshake.statusCode,200);
  const subscription=async()=> {
    page=(await api('GET',base+'/resources?kind=PAGE',undefined,'admin')).json().items[0];
    const response=await api('POST',base+'/subscription',{ version:1,pageId:page.id,pageVersion:page.version,subscribe:false },'admin');assert.equal(response.statusCode,200,response.body);
  };
  await subscription();assert.equal((await ready()).ready,true);assert.equal((await api('GET',bindingBase)).json().items[0].ready,true);
  const safe=(await api('GET',bindingBase)).body;assert.ok(!safe.includes(credentials.accessToken));assert.ok(!safe.includes(field));assert.ok(!safe.includes('ciphertext'));
  await publish('DRAFT');assert.equal((await ready()).ready,true,'Draft cannot replace a valid published mapping');
  assert.equal((await api('GET',base+'/webhook',undefined,'admin')).json().intakeReady,false,'ready setup is not an ACTIVE campaign');
  subscribed=false;await subscription();assert.equal((await ready()).ready,false);subscribed=true;await subscription();
  await db`UPDATE field_definition SET value_mode='SYSTEM' WHERE id=${field}`;assert.ok((await ready()).issues.includes('SOURCE_MAPPING_NOT_CONFIGURED'));
  await db`UPDATE field_definition SET value_mode='SOURCE' WHERE id=${field}`;assert.equal((await ready()).ready,true);
  const patchCampaign=async(messaging=false,ai=false)=> {
    const detail=(await api('GET',camp)).json().campaign;const response=await api('PATCH',camp,{ version:detail.version,name:detail.name,sourceKind:'META',routingMethod:'MANUAL',messagingEnabled:messaging,aiEnabled:ai,conversion:null });
    assert.equal(response.statusCode,200,response.body);
  };
  await patchCampaign(true);assert.ok((await ready()).issues.includes('MESSAGING_CONFIGURATION_NOT_READY'));assert.equal((await activate()).statusCode,409);
  await patchCampaign(false,true);assert.ok((await ready()).issues.includes('AI_CONFIGURATION_NOT_READY'));await patchCampaign();
  // Resync changes the Page credential version; previous subscription proof must be refreshed.
  await api('POST',base+'/discover',{ version:1 },'admin');assert.ok((await ready()).issues.includes('SOURCE_PAGE_SUBSCRIPTION_REQUIRED'));await subscription();assert.equal((await ready()).ready,true);
  async function connectionLock() {
    let unlock!:()=>void;let acquired!:()=>void;const held=new Promise<void>((r)=> { acquired=r; });const released=new Promise<void>((r)=> { unlock=r; });
    const work=db.begin(async(tx)=> { await tx`SELECT id FROM integration_connection WHERE id=${connection} FOR UPDATE`;acquired();await released; });await held;
    return { unlock,work };
  }
  async function waitActivation() {
    for (let i=0;i<100;i++) {
      if ((await db`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT c.id FROM integration_connection%'`).length) return;
      await new Promise((r)=>setTimeout(r,10));
    }throw new Error('Activation did not wait for Connection fence');
  }
  const held=await connectionLock();const changing=activate();
  try { await waitActivation();await db`UPDATE field_definition SET version=version+1 WHERE id=${field}`; }
  finally { held.unlock();await held.work; }
  assert.equal((await changing).statusCode,409);assert.equal((await db`SELECT status FROM campaign WHERE id=${campaign}`)[0]!.status,'DRAFT');await publish();
  const actorHeld=await connectionLock();const disabled=activate();
  try { await waitActivation();await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`; }
  finally { actorHeld.unlock();await actorHeld.work; }
  assert.equal((await disabled).statusCode,403);await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;
  const activated=await Promise.all([activate(),activate()]);assert.ok(activated.every((r)=>r.statusCode===200));
  assert.equal(activated[0]!.json().version,activated[1]!.json().version);assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE target_id=${campaign} AND action='CAMPAIGN_ACTIVATED'`)[0]!.n,1);
  assert.equal((await api('GET',base+'/webhook',undefined,'admin')).json().intakeReady,true);assert.equal((await api('GET',mapping)).json().intakeReady,true);
  const raw=JSON.stringify({ object:'page',entry:[{ id:'11',time:1700000000,changes:[{ field:'leadgen',value:{ page_id:'11',form_id:'22',leadgen_id:'33',created_time:1699999999 } }] }] });
  const receipt=()=>app.inject({ method:'POST',url:'/api/webhooks/sources/meta/'+connection,payload:raw,
    headers:{ 'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',credentials.appSecret).update(raw).digest('hex') } });
  assert.equal((await receipt()).statusCode,200);assert.equal(await processOneSourceRetrieval(db,{ retrieve:async()=>({ id:'33',form_id:'22',campaign_id:'100',created_time:'2023-11-14T22:13:19+0000',field_data:[{ name:'phone',values:['+15550001111'] },{ name:'score',values:['0'] }] }) }),true);
  assert.equal(await processOneSourceEvaluation(db),true);assert.equal(await processOneSourceIntake(db),true);
  const result=(await db`SELECT s.*,p.state AS processing_state FROM source_submission s JOIN source_processing p ON p.submission_id=s.id`)[0]!;
  assert.equal(result.processing_state,'PROCESSED');assert.ok(result.lead_id);assert.equal((await api('GET','/api/leads/'+result.lead_id)).statusCode,200);
  assert.equal((await receipt()).statusCode,200);assert.equal(await processOneSourceRetrieval(db,{ retrieve:async()=> { throw new Error('duplicate provider call'); } }),false);
  assert.equal(await processOneSourceIntake(db),false);assert.equal((await db`SELECT count(*)::integer AS n FROM lead`)[0]!.n,1);
  assert.equal((await api('POST',camp+'/deactivate')).statusCode,200);assert.equal((await api('GET',base+'/webhook',undefined,'admin')).json().intakeReady,false);
  assert.equal((await api('POST',base+'/disable',{ version:1 },'admin')).statusCode,200);assert.ok((await ready()).issues.includes('SOURCE_CONNECTION_NOT_AVAILABLE'));assert.equal((await activate()).statusCode,409);
  assert.ok(calls>=4);
});
