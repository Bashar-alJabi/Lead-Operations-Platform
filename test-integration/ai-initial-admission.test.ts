import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/security.js';
import { emptyKnowledge } from '../src/ai/knowledge.js';
import { emptyAIOperationalConfig } from '../src/ai/operational-config.js';
import { emptyAIBehaviorPolicy } from '../src/ai/behavior-policy.js';
import { emptyQualification } from '../src/ai/qualification.js';
import { resolveConfiguredSender } from '../src/messaging/sender-resolution.js';
import { routeLead } from '../src/routing.js';
import { recordLeadIntakeOrigin } from '../src/lead-intake-origin.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Initial AI admission derives only from fresh real intake, snapshots current scoped configuration and grants, preserves core Lead on blockers and never sends', async t => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173'; process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  let providerCalls = 0;
  const db = createDatabase(url), app = await buildApp(db, { logger: false, globalRateLimitMax: 10000,
    aiConnectionAdapters: { OPENAI: { listModels: async () => { providerCalls++; return ['synthetic-initial-model']; } } } });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async tx => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
  const org = (await db`INSERT INTO organization(name) VALUES('Initial admission synthetic') RETURNING id`)[0]!.id,
    foreign = (await db`INSERT INTO organization(name) VALUES('Foreign') RETURNING id`)[0]!.id,
    branch = (await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,
    other = (await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id,
    campaign = (await db`INSERT INTO campaign(organization_id,branch_id,name,status,routing_method,ai_config,messaging_config)
      VALUES(${org},${branch},'Initial A','ACTIVE','ROUND_ROBIN','{"enabled":true}','{"enabled":true}') RETURNING id`)[0]!.id;
  const users: Record<string, { id: string; session: string; cookie: string }> = {};
  for (const [name, role, bid, oid] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['second','AGENT',branch,org],['other','MANAGER',other,org],['foreign','SUPER_ADMIN',null,foreign]] as const) {
    const id = (await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES(${oid},${bid},${name},${role},${name+'@initial.test'},'synthetic-only') RETURNING id`)[0]!.id,
      token = randomBytes(32).toString('hex'), session = (await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name] = { id, session, cookie: 'lop_session='+token };
  }
  await db`INSERT INTO campaign_agent(campaign_id,agent_id) VALUES(${campaign},${users.agent!.id})`;
  const api = (method: 'GET'|'PUT'|'POST', path: string, payload?: object, who = 'manager') => app.inject({ method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, cookie: users[who]!.cookie } });
  let count = 0;
  const create = async () => { const r = await api('POST', '/api/leads', { branchId: branch, campaignId: campaign, contact: { name: 'Synthetic private contact', phone: '+1555777'+String(++count).padStart(4,'0') } }); assert.equal(r.statusCode, 201, r.body); return r.json().id as string; };
  const admission = async (lid: string) => (await db`SELECT a.* FROM ai_initial_admission a JOIN lead_intake_receipt r ON r.id=a.receipt_id WHERE r.lead_id=${lid}`)[0]!;
  const current = async (id: string) => db.begin(async tx => (await tx`SELECT ai_initial_admission_current(${id}) AS ctx`)[0]!.ctx);
  const first = await create(), blocked = await admission(first);
  assert.equal(blocked.state, 'BLOCKED'); assert.ok(blocked.blockers.includes('AI_CONVERSATION_PROFILE_UNAVAILABLE')); assert.ok(blocked.blockers.includes('AI_PUBLISHED_KNOWLEDGE_REQUIRED'));
  assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${first}`)[0]!.assigned_agent_id, users.agent!.id);
  const kr = '/api/ai/campaigns/'+campaign+'/knowledge', content = { ...emptyKnowledge(), sections: { ...emptyKnowledge().sections, prices: 'PRIVATE CAMPAIGN BUSINESS CONTENT' } };
  assert.equal((await api('PUT', kr+'/draft', { version: 0, content, reason: 'Synthetic published knowledge' })).statusCode, 200);
  assert.equal((await api('POST', kr+'/publish', { version: 1, requestId: randomUUID(), reason: 'Approve synthetic knowledge' })).statusCode, 201);
  const ac = await api('POST', '/api/ai/connections', { name: 'Initial synthetic', branchId: branch, provider: 'OPENAI', credential: 'synthetic-initial-only', reason: 'Synthetic connection' }); assert.equal(ac.statusCode, 201, ac.body);
  assert.equal((await api('POST', '/api/ai/connections/'+ac.json().id+'/test', { version: 1 })).statusCode, 200);
  const pr = await api('POST', '/api/ai/profiles', { connectionId: ac.json().id, name: 'Initial conversation', task: 'CONVERSATION', modelId: 'synthetic-initial-model', maxOutputTokens: 1024, active: true, reason: 'Synthetic profile' }); assert.equal(pr.statusCode, 201, pr.body);
  const config = { ...emptyAIOperationalConfig(), profiles: { ...emptyAIOperationalConfig().profiles, CONVERSATION: pr.json().id }, language: { supported: ['en'], preferred: 'en', detect: true } };
  assert.equal((await api('PUT', '/api/ai/branches/'+branch+'/defaults', { version: 0, definition: config, reason: 'Branch defaults' })).statusCode, 200);
  const behavior = { ...emptyAIBehaviorPolicy(), disclosure: { mode: 'FIRST_AI_MESSAGE', text: 'Synthetic approved AI identity' }, handoff: { initialContactWithoutAgent: false, transitionMessage: null, misunderstandingLimit: null } };
  const br = '/api/ai/campaigns/'+campaign+'/behavior-policy';
  assert.equal((await api('PUT', br, { version: 0, definition: behavior, reason: 'Explicit availability policy' })).statusCode, 200);
  const tr = '/api/ai/campaigns/'+campaign+'/tool-policy';
  assert.equal((await api('PUT', tr, { version: 0, definition: { allowedTools: ['sendConversationMessage'] }, reason: 'Approve initial send tool' })).statusCode, 200);
  const mc = (await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config)
    VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic initial','CONNECTED','{"wabaId":"123456789","graphVersion":"v25.0"}') RETURNING id`)[0]!.id,
    sender = (await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
      VALUES(${org},${mc},'15550001111','Synthetic initial','HEALTHY',true,'{"text":true,"requiresTemplate":true,"template":true}') RETURNING id`)[0]!.id;
  await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
  const readyLead = await create(), a = await admission(readyLead); assert.equal(a.state, 'ADMITTED'); assert.deepEqual(a.blockers, []); assert.equal(a.context.kind, 'LEAD_INTAKE_INITIAL');
  assert.equal(a.context.knowledge.version, 1); assert.equal(a.context.profile.id, pr.json().id); assert.equal(a.context.availability.ownerAvailable, true);
  assert.equal(a.context.sender.reason, 'BRANCH_DEFAULT'); assert.equal(a.context.sender.capabilities.requiresTemplate, true);
  assert.equal(a.context.consent.status, 'UNKNOWN'); assert.equal(a.context.sendAuthorized, false); assert.equal(a.context.liveTransferEnabled, false);
  assert.equal(a.context.source.messageId, undefined); assert.equal(a.context.source.eventId, undefined); assert.equal(a.context.scope.conversationId, undefined);
  assert.equal(JSON.stringify(a.context).includes('PRIVATE CAMPAIGN BUSINESS CONTENT'), false); assert.equal(JSON.stringify(a.context).includes('+1555777'), false);
  assert.deepEqual(await current(a.id), a.context); assert.equal(await current(blocked.id), null); // no retroactive approval of the blocked original.
  const dto = (await api('GET', '/api/leads/'+readyLead+'/intake-origin', undefined, 'agent')).json().origin.initialAI;
  assert.equal(dto.state, 'ADMITTED'); assert.equal(dto.runtimeStarted, false); assert.equal(dto.sendAuthorized, false); assert.equal(dto.knowledgeVersion, 1);
  for (const hidden of ['context','session','credential','Synthetic private','PRIVATE CAMPAIGN','profileId','connectionId','contactId']) assert.equal(JSON.stringify(dto).includes(hidden), false);
  for (const who of ['second','other','foreign']) assert.equal((await api('GET', '/api/leads/'+readyLead+'/intake-origin', undefined, who)).statusCode, 404);
  for (const sql of [db`UPDATE ai_initial_admission SET state='ADMITTED' WHERE id=${blocked.id}`, db`DELETE FROM ai_initial_admission WHERE id=${a.id}`,
    db`INSERT INTO ai_initial_admission(receipt_id) VALUES(${blocked.receipt_id})`]) await assert.rejects(sql, /IMMUTABLE|FRESH_INTAKE_REQUIRED/);
  // Disabled at birth never grants admission later, even after configuration is enabled again.
  await db`UPDATE campaign SET ai_config='{"enabled":false}' WHERE id=${campaign}`;
  const disabled = await create(), dr = (await db`SELECT id FROM lead_intake_receipt WHERE lead_id=${disabled}`)[0]!.id;
  assert.equal(await admission(disabled), undefined); await db`UPDATE campaign SET ai_config='{"enabled":true}' WHERE id=${campaign}`;
  await assert.rejects(db`INSERT INTO ai_initial_admission(receipt_id) VALUES(${dr})`, /FRESH_INTAKE_REQUIRED/);
  const raced = await Promise.all(Array.from({ length: 8 }, () => create()));
  assert.equal((await db`SELECT count(*)::int AS n FROM ai_initial_admission a JOIN lead_intake_receipt r ON r.id=a.receipt_id WHERE r.lead_id IN ${db(raced)}`)[0]!.n, 8);
  const movedCampaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status,ai_config,messaging_config) VALUES(${org},${other},'Transferred identical version','ACTIVE','{"enabled":true}','{"enabled":true}') RETURNING id`)[0]!.id;
  const sameBranchCampaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status,ai_config,messaging_config) VALUES(${org},${branch},'Other campaign same Branch','ACTIVE','{"enabled":true}','{"enabled":true}') RETURNING id`)[0]!.id;
  for(const destination of [movedCampaign,sameBranchCampaign]){
    const lid=await create(),aa=await admission(lid);
    await assert.rejects(db.begin(async tx=>{
      await tx`UPDATE lead SET campaign_id=${destination},branch_id=${destination===movedCampaign?other:branch},assigned_agent_id=NULL WHERE id=${lid}`;
      assert.equal((await tx`SELECT ai_initial_intake_context(${aa.receipt_id},clock_timestamp()) AS ctx`)[0]!.ctx,null);
      assert.equal((await tx`SELECT ai_initial_admission_current(${aa.id}) AS ctx`)[0]!.ctx,null);throw Error('RollbackVerifiedScopeTransfer');
    }),/RollbackVerifiedScopeTransfer/);
  }
  // Current authority rejects changed Owner, policy, profile/connection, source scope and Lead version.
  for (const kind of ['OWNER','CAMPAIGN','PROFILE','CONNECTION','SENDER','CONTACT','RECIPIENT','CONSENT','LEAD_VERSION'] as const) {
    const lid = await create(), aa = await admission(lid);
    await assert.rejects(db.begin(async tx => {
      if (kind==='OWNER') await tx`UPDATE lead SET assigned_agent_id=${users.second!.id} WHERE id=${lid}`;
      if (kind==='CAMPAIGN') await tx`UPDATE campaign SET version=version+1 WHERE id=${campaign}`;
      if (kind==='PROFILE') await tx`UPDATE ai_model_profile SET active=false,version=version+1 WHERE id=${pr.json().id}`;
      if (kind==='CONNECTION') await tx`UPDATE integration_connection SET status='DISABLED',version=version+1 WHERE id=${ac.json().id}`;
      if (kind==='SENDER') await tx`UPDATE messaging_sender SET operator_enabled=false WHERE id=${sender}`;
      if (kind==='CONTACT') await tx`UPDATE lead SET contact_id=NULL WHERE id=${lid}`;
      if (kind==='RECIPIENT') await tx`UPDATE contact SET phone_normalized='+15558880000' WHERE id=(SELECT contact_id FROM lead WHERE id=${lid})`;
      if (kind==='CONSENT') await tx`INSERT INTO messaging_consent(contact_id,channel,status,source) SELECT contact_id,'WHATSAPP','REVOKED','Synthetic' FROM lead WHERE id=${lid}`;
      if (kind==='LEAD_VERSION') await tx`UPDATE lead SET version=version+1 WHERE id=${lid}`;
      assert.equal((await tx`SELECT ai_initial_admission_current(${aa.id}) AS ctx`)[0]!.ctx, null); throw Error('RollbackVerifiedDrift');
    }), /RollbackVerifiedDrift/);
  }
  // Sender resolution matches the existing central resolver, including explicit invalid override and shared ambiguity.
  const senderProbe = async (lid: string) => db.begin(async tx => {
    const native = (await tx`SELECT ai_initial_sender_context(${lid}) AS ctx`)[0]!.ctx, central = await resolveConfiguredSender(tx, { organizationId: org, branchId: branch, campaignId: campaign });
    assert.equal(native.reason, central.reason); assert.equal(native.usable, !!central.sender); return native;
  });
  await senderProbe(readyLead);
  await db`UPDATE messaging_sender SET operator_enabled=false WHERE id=${sender}`; await senderProbe(readyLead);
  assert.equal((await admission(await create())).state, 'BLOCKED'); await db`UPDATE messaging_sender SET operator_enabled=true WHERE id=${sender}`;
  await assert.rejects(db.begin(async tx => {
    await tx`UPDATE branch SET default_sender_id=NULL WHERE id=${branch}`;
    const sc=(await tx`INSERT INTO integration_connection(organization_id,kind,provider,name,status) VALUES(${org},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic shared sender','CONNECTED') RETURNING id`)[0]!.id;
    const check=async()=>{const n=(await tx`SELECT ai_initial_sender_context(${readyLead}) AS ctx`)[0]!.ctx,r=await resolveConfiguredSender(tx,{organizationId:org,branchId:branch,campaignId:campaign});assert.equal(n.reason,r.reason);assert.equal(n.usable,!!r.sender);return n;};
    assert.equal((await check()).reason,'NO_SENDER');
    for(let i=0;i<2;i++){
      const sid=(await tx`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
        VALUES(${org},${sc},${'shared-initial-'+i},'Synthetic shared','HEALTHY',true,'{"text":true}') RETURNING id`)[0]!.id;
      await tx`INSERT INTO sender_branch_binding(sender_id,branch_id,allow_shared_fallback) VALUES(${sid},${branch},true)`;
      assert.equal((await check()).reason,i===0?'SHARED_FALLBACK':'SHARED_FALLBACK_AMBIGUOUS');
    }
    await tx`UPDATE campaign SET sender_override_id=${sender} WHERE id=${campaign}`;await tx`UPDATE messaging_sender SET operator_enabled=false WHERE id=${sender}`;
    assert.equal((await check()).reason,'SENDER_DISABLED'); // no fallback from an invalid explicit override.
    throw Error('RollbackVerifiedSenderMatrix');
  }),/RollbackVerifiedSenderMatrix/);
  // Shared runtime is usable only with an actual managed Branch entitlement; revocation affects current and future admission.
  const shared = await api('POST','/api/ai/connections',{name:'Shared initial AI',branchId:null,provider:'OPENAI',credential:'synthetic-shared-initial-only',reason:'Shared synthetic runtime'},'admin');assert.equal(shared.statusCode,201);
  const sharedId=shared.json().id;assert.equal((await api('POST','/api/ai/connections/'+sharedId+'/test',{version:1},'admin')).statusCode,200);
  const sharedProfile=await api('POST','/api/ai/profiles',{connectionId:sharedId,name:'Shared initial',task:'CONVERSATION',modelId:'synthetic-initial-model',maxOutputTokens:1024,active:true,reason:'Shared synthetic task'},'admin');assert.equal(sharedProfile.statusCode,201);
  const gr='/api/ai/connections/'+sharedId+'/branch-use',grant={branchId:branch,version:0,connectionVersion:1,active:true,reason:'Explicit shared runtime entitlement'};
  assert.equal((await api('PUT',gr,grant,'admin')).statusCode,200);
  assert.equal((await api('PUT','/api/ai/branches/'+branch+'/defaults',{version:1,definition:{...config,profiles:{...config.profiles,CONVERSATION:sharedProfile.json().id}},reason:'Select entitled shared runtime'})).statusCode,200);
  const sharedAdmission=await admission(await create());assert.equal(sharedAdmission.state,'ADMITTED');assert.equal(sharedAdmission.context.profile.grantVersion,1);assert.ok(await current(sharedAdmission.id));
  assert.equal((await api('PUT',gr,{...grant,version:1,active:false,reason:'Revoke shared entitlement'},'admin')).statusCode,200);
  assert.equal(await current(sharedAdmission.id),null);assert.ok((await admission(await create())).blockers.includes('AI_CONVERSATION_PROFILE_UNAVAILABLE'));
  assert.equal((await api('PUT','/api/ai/branches/'+branch+'/defaults',{version:2,definition:config,reason:'Restore Branch runtime selection'})).statusCode,200);
  const field=(await db`INSERT INTO field_definition(organization_id,key,label,field_type) VALUES(${org},'initial_boolean','Synthetic initial Boolean','BOOLEAN') RETURNING id`)[0]!.id;
  await db`INSERT INTO campaign_field(campaign_id,field_id,usable_by_ai) VALUES(${campaign},${field},true)`;
  assert.equal((await api('PUT','/api/ai/campaigns/'+campaign+'/qualification',{version:0,definition:{...emptyQualification(),enabled:true,questions:[{id:randomUUID(),prompt:'Approved Boolean question',fieldId:field,required:true}]},reason:'Typed scoped initial qualification'})).statusCode,200);
  const qa=await admission(await create());assert.equal(qa.state,'ADMITTED');assert.equal(qa.context.qualification.fields[0].id,field);
  for(const drift of ['UNBOUND','DISABLED','FOREIGN_SCOPE'] as const)await assert.rejects(db.begin(async tx=>{
    if(drift==='UNBOUND')await tx`UPDATE campaign_field SET usable_by_ai=false,version=version+1 WHERE campaign_id=${campaign} AND field_id=${field}`;
    if(drift==='DISABLED')await tx`UPDATE field_definition SET active=false,version=version+1 WHERE id=${field}`;
    if(drift==='FOREIGN_SCOPE')await tx`UPDATE field_definition SET branch_id=${other},version=version+1 WHERE id=${field}`;
    assert.equal((await tx`SELECT ai_initial_admission_current(${qa.id}) AS ctx`)[0]!.ctx,null);
    const ctx=(await tx`SELECT ai_initial_intake_context(${qa.receipt_id},clock_timestamp()) AS ctx`)[0]!.ctx;
    assert.ok((await tx`SELECT ai_initial_admission_blockers(${tx.json(ctx)}) AS reasons`)[0]!.reasons.includes('AI_QUALIFICATION_FIELD_UNAVAILABLE'));
    throw Error('RollbackVerifiedFieldDrift');
  }),/RollbackVerifiedFieldDrift/);
  // Without an available Agent, only an explicit policy allows the Branch Manager attention fallback. No random assignment.
  await db`UPDATE campaign_agent SET active=false WHERE campaign_id=${campaign}`;
  const unassigned = await create(), ua = await admission(unassigned); assert.equal(ua.state, 'BLOCKED'); assert.ok(ua.blockers.includes('AI_INITIAL_WITHOUT_AVAILABLE_AGENT_NOT_ALLOWED'));
  assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${unassigned}`)[0]!.assigned_agent_id, null);
  const allowedBehavior = { ...behavior, handoff: { ...behavior.handoff, initialContactWithoutAgent: true } };
  assert.equal((await api('PUT', br, { version: 1, definition: allowedBehavior, reason: 'Explicit unassigned contact fallback' })).statusCode, 200);
  const allowed = await create(), fa = await admission(allowed); assert.equal(fa.state, 'ADMITTED'); assert.equal(fa.context.lead.ownerId, null);
  assert.deepEqual(fa.context.availability.fallback, { kind: 'BRANCH_MANAGER_ATTENTION', branchId: branch }); assert.equal(await current(ua.id), null);
  // Real current working-hours projection changes are captured and fence old admission.
  await db`UPDATE campaign_agent SET active=true WHERE campaign_id=${campaign}`;
  const available = await create(), av = await admission(available);
  assert.equal((await api('PUT', '/api/users/'+users.agent!.id+'/working-hours', { version: 0, hours: { mon:[],tue:[],wed:[],thu:[],fri:[],sat:[],sun:[] }, reason: 'Synthetic unavailable schedule' })).statusCode, 200);
  assert.equal(await current(av.id), null); const afterHours = await admission(await create()); assert.equal(afterHours.context.availability.ownerAvailable, false);
  assert.equal(afterHours.context.lead.ownerId, null); // Routing does not select an unavailable Agent.
  // Publishing never changes historical hashes, and a new birth uses the new version.
  const oldHash = fa.context_hash;
  assert.equal((await api('PUT', kr+'/draft', { version: 1, content: { ...content, sections: { ...content.sections, prices: 'Changed approved source' } }, reason: 'Synthetic version two' })).statusCode, 200);
  assert.equal((await api('POST', kr+'/publish', { version: 2, requestId: randomUUID(), reason: 'Publish synthetic version two' })).statusCode, 201);
  assert.equal(await current(fa.id), null); assert.equal((await admission(allowed)).context_hash, oldHash); assert.equal((await admission(await create())).context.knowledge.version, 2);
  // Removing the current original Send grant blocks new admissions and revokes old eligible ones.
  const granted = await admission(await create());
  assert.equal((await api('PUT', tr, { version: 1, definition: { allowedTools: [] }, reason: 'Revoke send authority' })).statusCode, 200);
  assert.equal(await current(granted.id), null); assert.ok((await admission(await create())).blockers.includes('AI_SEND_TOOL_NOT_APPROVED'));
  // Extra writes in the creation transaction cannot commit a stale context. Actual Audit failure rolls the whole intake back.
  await assert.rejects(db.begin(async tx => {
    const lid = (await tx`INSERT INTO lead(organization_id,branch_id,campaign_id,source_kind) VALUES(${org},${branch},${campaign},'MANUAL') RETURNING id`)[0]!.id;
    const sub = (await tx`INSERT INTO source_submission(organization_id,branch_id,campaign_id,lead_id,source_kind,state,raw_payload) VALUES(${org},${branch},${campaign},${lid},'MANUAL','PROCESSED','{}') RETURNING id`)[0]!.id;
    await routeLead(tx,campaign,branch,'ROUND_ROBIN','UTC',lid); await recordLeadIntakeOrigin(tx,lid,sub,{ kind:'HUMAN_MANUAL',actorId:users.manager!.id,sessionId:users.manager!.session });
    await tx`UPDATE campaign SET version=version+1 WHERE id=${campaign}`;
  }), /AI_INITIAL_ATOMIC_CONTEXT_REQUIRED|LEAD_INTAKE_ATOMIC_CONTEXT_REQUIRED/);
  const totals = async () => (await db`SELECT (SELECT count(*)::int FROM lead) AS leads,(SELECT count(*)::int FROM ai_initial_admission) AS admissions,(SELECT count(*)::int FROM lead_intake_receipt) AS origins`)[0]!;
  const before = await totals();
  await db`CREATE FUNCTION reject_initial_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_INITIAL_INTAKE_ASSESSED' THEN RAISE EXCEPTION 'SyntheticInitialAuditRollback';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER reject_initial_audit_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_initial_audit_fixture()`;
  try { const r = await api('POST','/api/leads',{ branchId:branch,campaignId:campaign,contact:{name:'Synthetic rollback',phone:'+15559990000'} }); assert.equal(r.statusCode,500); assert.equal(r.body.includes('SyntheticInitialAuditRollback'),false); assert.deepEqual(await totals(),before); }
  finally { await db`DROP TRIGGER reject_initial_audit_fixture ON audit_log`;await db`DROP FUNCTION reject_initial_audit_fixture()`; }
  // Actual branch lock wait followed by a configuration revocation reads the new denied grant, not cached readiness.
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(r=>{enter=r;}), held = new Promise<void>(r=>{release=r;});
  const blocker = db.begin(async tx=>{ await tx`SELECT id FROM branch WHERE id=${branch} FOR UPDATE`;enter();await held;
    await tx`UPDATE messaging_sender SET operator_enabled=false WHERE id=${sender}`; });
  await entered; const racing = create(); let waited=false;
  try { for(let i=0;i<100;i++){ waited=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM branch WHERE id =%') AS ok`)[0]!.ok;if(waited)break;await delay(20); }assert.equal(waited,true); }
  finally { release();await blocker; }
  const afterWait=await admission(await racing);assert.equal(afterWait.state,'BLOCKED');assert.equal(afterWait.context.sender.reason,'SENDER_DISABLED');
  // Connection management locks Connection before Branch. Intake already holds Branch: this real inverse-order race must not abort core intake.
  let connectionReady!:()=>void,requestBranch!:()=>void;
  const connectionHeld=new Promise<void>(r=>{connectionReady=r;}),requestBranchGate=new Promise<void>(r=>{requestBranch=r;});
  const writer=db.begin(async tx=>{await tx`SELECT id FROM integration_connection WHERE id=${ac.json().id} FOR UPDATE`;connectionReady();await requestBranchGate;await tx`SELECT id FROM branch WHERE id=${branch} FOR SHARE`;});
  const settledWriter=Promise.allSettled([writer]);await connectionHeld;
  const contended=api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Synthetic contention',phone:'+15559990001'}});
  try {for(let i=0;i<30;i++){const waiting=(await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO lead_intake_receipt%') AS ok`)[0]!.ok;if(waiting)break;await delay(5);}}
  finally{requestBranch();}
  const contentionResponse=await contended,writerResult=await settledWriter;
  assert.equal(writerResult[0]!.status,'fulfilled','Dependency lock race must not deadlock the operational writer');
  assert.equal(contentionResponse.statusCode,201,contentionResponse.body);
  const busy=await admission(contentionResponse.json().id);assert.equal(busy.state,'BLOCKED');assert.deepEqual(busy.blockers,['AI_INITIAL_DEPENDENCY_BUSY']);
  assert.equal(await current(busy.id),null);
  const busyDto=(await api('GET','/api/leads/'+contentionResponse.json().id+'/intake-origin')).json().origin.initialAI;
  assert.equal(busyDto.ownerAvailable,null);assert.equal(busyDto.knowledgeVersion,null);assert.equal(busyDto.senderReason,null);assert.equal(busyDto.sendAuthorized,false);
  await db.begin(async tx=>{await tx`SET LOCAL lock_timeout='2s'`;await tx`SELECT ai_initial_locked_context(${busy.receipt_id},clock_timestamp())`;
    assert.equal((await tx`SELECT current_setting('lock_timeout') AS timeout`)[0]!.timeout,'2s');});
  assert.equal(providerCalls,2); // Explicit managed connection tests only; intake does not call a provider.
  for(const table of ['conversation','conversation_message','ai_customer_proposal','background_job','payment_record','enrollment']) assert.equal((await db.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n,0);
  assert.ok((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='AI_INITIAL_INTAKE_ASSESSED'`)[0]!.n>0);
});
