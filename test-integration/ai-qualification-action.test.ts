import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/security.js';
import { sealSecret } from '../src/credentials.js';
import { processOneInboundEvent } from '../src/messaging/inbound-events.js';
import { emptyKnowledge } from '../src/ai/knowledge.js';
import { emptyAIOperationalConfig } from '../src/ai/operational-config.js';
import { emptyQualification } from '../src/ai/qualification.js';
import { processOneAICustomerProposal } from '../src/ai/customer-worker.js';
import { AIInferenceError, aiInferenceAdapters, type AIInferenceRegistry } from '../src/ai/inference-provider.js';
import { collectAIQualificationAnswer, processOneAIQualificationAction } from '../src/ai/customer-qualification.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Actual AI Qualification uses fresh active admission, typed current action authority, atomic provenance and durable concurrency guards', async t => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173'; process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const db = createDatabase(url), app = await buildApp(db, { logger: false, globalRateLimitMax: 10000, aiConnectionAdapters: { OPENAI: { listModels: async () => ['synthetic-conversation-model'] } } });
  const oldFetch = globalThis.fetch; let fetchCalls = 0; globalThis.fetch = async () => { fetchCalls++; throw new Error('No external requests permitted'); };
  t.after(async () => { globalThis.fetch = oldFetch; await app.close(); await db.end(); });
  await db.begin(async tx => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
  const org = (await db`INSERT INTO organization(name) VALUES ('Customer provenance') RETURNING id`)[0]!.id,
    foreign = (await db`INSERT INTO organization(name) VALUES ('Foreign synthetic') RETURNING id`)[0]!.id,
    branch = (await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id,
    other = (await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id,
    campaign = (await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES (${org},${branch},'A','ACTIVE') RETURNING id`)[0]!.id;
  const users: Record<string, { id: string; session: string; cookie: string }> = {};
  for (const [name, role, bid, oid] of [['manager', 'MANAGER', branch, org], ['agent', 'AGENT', branch, org], ['second', 'AGENT', branch, org], ['other', 'MANAGER', other, org], ['foreign', 'SUPER_ADMIN', null, foreign]] as const) {
    const id = (await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${oid},${bid},${name},${role},${name + '@customerai.test'},'synthetic-only') RETURNING id`)[0]!.id, token = randomBytes(32).toString('hex');
    const session = (await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name] = { id, session, cookie: 'lop_session=' + token };
  }
  const contact = (await db`INSERT INTO contact(organization_id,name,phone_normalized) VALUES (${org},'Synthetic Customer','+15557770000') RETURNING id`)[0]!.id,
    lead = (await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,assigned_agent_id,source_kind) VALUES (${org},${branch},${campaign},${contact},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id,
    mc = (await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config) VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Fixture','CONNECTED','{"wabaId":"123456789","graphVersion":"v25.0"}') RETURNING id`)[0]!.id,
    sender = (await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities) VALUES (${org},${mc},'15550001111','Fixture','HEALTHY',true,'{"text":true}') RETURNING id`)[0]!.id;
  await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
  const secret = sealSecret(mc, JSON.stringify({ appSecret: 'synthetic-hmac-secret', accessToken: 'synthetic-only-token', verifyToken: 'synthetic-only-verification' }));
  await db`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag) VALUES (${mc},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
  const cv = (await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state) VALUES (${lead},${mc},${sender},'WHATSAPP','+15557770000','AI','AI_ACTIVE') RETURNING id`)[0]!.id,
    root = '/api/conversations/' + cv + '/ai-customer-executions', kr = '/api/ai/campaigns/' + campaign + '/knowledge';
  const api = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object, actor = 'manager') => app.inject({ method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, cookie: users[actor]!.cookie } });
  const content = { ...emptyKnowledge(), sections: { ...emptyKnowledge().sections, prices: 'Synthetic approved amount <img literal>' } };
  assert.equal((await api('PUT', kr + '/draft', { version: 0, content, reason: 'Approved synthetic knowledge' })).statusCode, 200);
  assert.equal((await api('POST', kr + '/publish', { version: 1, requestId: randomUUID(), reason: 'Synthetic publication' })).statusCode, 201);
  const made = await api('POST', '/api/ai/connections', { name: 'Synthetic AI', branchId: branch, provider: 'OPENAI', credential: 'synthetic-no-live-key', reason: 'Dedicated synthetic fixture' });
  assert.equal(made.statusCode, 201, made.body); const aiConnection = made.json().id;
  assert.equal((await api('POST', '/api/ai/connections/' + aiConnection + '/test', { version: 1 })).statusCode, 200);
  const madeProfile = await api('POST', '/api/ai/profiles', { connectionId: aiConnection, name: 'Conversation', task: 'CONVERSATION', modelId: 'synthetic-conversation-model', maxOutputTokens: 1024, active: true, reason: 'Synthetic Conversation scope' });
  assert.equal(madeProfile.statusCode, 201, madeProfile.body); const profile = madeProfile.json().id;
  const cfg = { ...emptyAIOperationalConfig(), profiles: { ...emptyAIOperationalConfig().profiles, CONVERSATION: profile } };
  assert.equal((await api('PUT', '/api/ai/campaigns/' + campaign + '/configuration', { version: 0, definition: cfg, reason: 'Synthetic current config' })).statusCode, 200);
  const field = (await db`INSERT INTO field_definition(organization_id,branch_id,campaign_id,key,label,field_type) VALUES (${org},${branch},${campaign},'interest','Interest','BOOLEAN') RETURNING id`)[0]!.id;
  await db`INSERT INTO campaign_field(campaign_id,field_id,usable_by_ai) VALUES (${campaign},${field},true)`;
  assert.equal((await api('PUT', '/api/ai/campaigns/' + campaign + '/qualification', { version: 0, definition: { ...emptyQualification(), enabled: true, questions: [{ id: randomUUID(), prompt: 'Interest?', fieldId: field, required: true }] }, reason: 'Native field provenance' })).statusCode, 200);
  // Synthetic fixture only: production Campaign activation remains blocked until the complete tool/runtime baseline.
  await db`UPDATE campaign SET ai_config='{"enabled":true}' WHERE id=${campaign}`;
  const raw = (id: string, body = 'What is the approved price?') => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '123456789', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '15550001111' }, messages: [{ id, from: '15557770000', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }] } }] }] });
  const receive = (id: string, body?: string) => { const payload = raw(id, body); return app.inject({ method: 'POST', url: '/api/webhooks/messaging/meta/' + mc, payload,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'synthetic-hmac-secret').update(payload).digest('hex') } }); };
  const inbound = async (id: string, body?: string) => { assert.equal((await receive(id, body)).statusCode, 200); assert.equal(await processOneInboundEvent(db), true); return (await db`SELECT * FROM ai_customer_proposal WHERE event_id=(SELECT id FROM integration_event WHERE payload->'message'->>'id'=${id})`)[0]; };
  const query = (id: string) => db`SELECT * FROM ai_customer_proposal WHERE id=${id}`;
  const answer = { decision: 'ANSWER', referenceIds: ['section:prices'], questionId: null, answerValue: null, sourceQuote: null, handoffReason: null };
  const handoff = { decision: 'HANDOFF', referenceIds: [], questionId: null, answerValue: null, sourceQuote: null, handoffReason: 'UNKNOWN_ANSWER' };
  let calls = 0;
  const adapters: AIInferenceRegistry = { OPENAI: { simulate: async () => { throw Error('Wrong AI operation'); }, proposeCustomer: async input => { calls++; assert.equal(input.model, 'synthetic-conversation-model');
    const data = input.data as Record<string, any>; assert.ok(data.messages.length); assert.ok(data.references.length); assert.equal(JSON.stringify(data).includes('organizationId'), false); assert.equal(JSON.stringify(data).includes('synthetic-no-live-key'), false);
    return answer; } } };
  const run = (registry = adapters, leaseSeconds = 60) => processOneAICustomerProposal(db, { adapters: registry, retryDelaySeconds: 0, leaseSeconds });
  const question = (await db`SELECT definition->'questions'->0->>'id' AS id FROM ai_qualification_config WHERE campaign_id=${campaign}`)[0]!.id;
  const toolRoot = '/api/ai/campaigns/' + campaign + '/tool-policy';
  const grant = async (allowed = true) => {
    const v = (await api('GET', toolRoot)).json().version;
    const r = await api('PUT', toolRoot, { version: v, definition: { allowedTools: allowed ? ['updateQualificationField'] : [] }, reason: 'Explicit synthetic Qualification tool approval' });
    assert.equal(r.statusCode, 200, r.body);
  };
  const activate = () => db`UPDATE conversation SET controller_type='AI',controller_user_id=NULL,state='AI_ACTIVE',needs_attention_reason=NULL WHERE id=${cv}`;
  const qualify = (qid = question, value: unknown = true, quote = 'Yes, interested'): AIInferenceRegistry => ({ OPENAI: { ...adapters.OPENAI!, proposeCustomer: async () => ({ ...handoff, decision: 'QUALIFICATION', questionId: qid, answerValue: value, sourceQuote: quote, handoffReason: null }) } });
  await grant();
  // Live-off/default and diagnostic attention never authorize an action.
  const off = (await inbound('live-off', 'Yes, interested'))!;
  assert.equal(await processOneAICustomerProposal(db), true); assert.equal((await query(off.id))[0]!.state, 'BLOCKED');
  assert.equal(await processOneAIQualificationAction(db), false);
  await activate();
  const first = (await inbound('action-first', 'Yes, interested'))!;
  assert.equal((await db`SELECT state,needs_attention_reason FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_ACTIVE');
  assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_action_admission WHERE proposal_id=${first.id}`)[0]!.n, 1);
  await Promise.all(Array.from({ length: 8 }, () => receive('action-first', 'Yes, interested')));
  assert.equal(await processOneInboundEvent(db), false);
  assert.equal(await run(qualify()), true);
  const workers = await Promise.all(Array.from({ length: 4 }, () => processOneAIQualificationAction(db))); assert.equal(workers.filter(Boolean).length, 1);
  const action = (await db`SELECT * FROM ai_customer_action WHERE proposal_id=${first.id}`)[0]!;
  assert.equal(action.state, 'APPLIED'); assert.equal(action.tool, 'updateQualificationField');
  assert.equal((await db`SELECT state FROM ai_customer_action_job WHERE proposal_id=${first.id}`)[0]!.state, 'DONE');
  await assert.rejects(db`UPDATE ai_customer_action_job SET state='QUEUED',completed_at=NULL WHERE proposal_id=${first.id}`, /RECEIPT_REQUIRED/);
  const saved = (await db`SELECT * FROM lead_qualification_answer WHERE lead_id=${lead} AND question_id=${question}`)[0]!;
  assert.equal(saved.source, 'AI'); assert.equal(saved.value, true); assert.equal(saved.actor_id, null); assert.equal(saved.session_id, null); assert.equal(saved.request_id, null); assert.equal(saved.ai_action_id, action.id);
  const fv = (await db`SELECT * FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}`)[0]!;
  assert.equal(fv.source, 'AI'); assert.equal(fv.updated_by, null); assert.equal(fv.version, 1);
  assert.equal((await db`SELECT count(*)::integer AS n FROM field_value_history WHERE ai_action_id=${action.id}`)[0]!.n, 1);
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead_qualification_request`)[0]!.n, 0);
  assert.equal((await db`SELECT actor_user_id FROM audit_log WHERE target_id=${action.id} AND action='AI_CUSTOMER_TOOL_APPLIED'`)[0]!.actor_user_id, null);
  assert.equal((await db.begin(tx => collectAIQualificationAnswer(tx, first.id))).duplicate, true);
  const dto = (await api('GET', root, undefined, 'agent')).json().items.find((e: any) => e.id === first.id);
  assert.equal(dto.action.state, 'APPLIED'); assert.deepEqual(dto.toolsExecuted, ['updateQualificationField']); assert.equal(dto.sendAllowed, false); assert.equal(dto.action.value, undefined); assert.equal(dto.action.questionId, undefined);
  for (const who of ['second', 'other', 'foreign']) assert.equal((await api('GET', root, undefined, who)).statusCode, 404);
  assert.equal((await api('POST', root, { source: 'AI', tool: 'updateQualificationField' }, 'agent')).statusCode, 404);
  await assert.rejects(db`UPDATE ai_customer_action SET state='BLOCKED',error_code='AI_ACTION_CONTEXT_CHANGED' WHERE id=${action.id}`, /IMMUTABLE/);
  await assert.rejects(db`DELETE FROM ai_customer_action_admission WHERE proposal_id=${first.id}`, /IMMUTABLE/);
  await assert.rejects(db`UPDATE field_value_history SET new_value='false' WHERE ai_action_id=${action.id}`, /PROOF_REQUIRED/);
  await assert.rejects(db`UPDATE lead_field_value SET value='false',version=version+1 WHERE lead_id=${lead} AND field_id=${field}`, /CURRENT_ACTION_REQUIRED/);
  await assert.rejects(db`UPDATE lead_qualification_answer SET version=version+1 WHERE lead_id=${lead} AND question_id=${question}`, /CURRENT_ACTION_REQUIRED/);
  // Human captures after an autonomous answer keep real Human permission/session checks and immutable AI history.
  const qr = '/api/leads/' + lead + '/qualification', state = (await api('GET', qr, undefined, 'agent')).json();
  assert.equal(state.questions[0].source, 'AI');
  const human = await api('PUT', qr + '/answers/' + question, { requestId: randomUUID(), definitionVersion: state.definitionVersion, answerVersion: 1, fieldValueVersion: 1, value: false }, 'agent');
  assert.equal(human.statusCode, 200, human.body);
  assert.equal((await db`SELECT ai_action_id FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}`)[0]!.ai_action_id, null);
  assert.equal((await db`SELECT source,ai_action_id FROM lead_qualification_answer WHERE lead_id=${lead} AND question_id=${question}`)[0]!.source, 'HUMAN');
  assert.equal((await db`SELECT snapshot->>'source' AS source FROM lead_qualification_answer_history WHERE lead_id=${lead} AND question_id=${question} AND version=1`)[0]!.source, 'AI');
  // Unmapped typed text is an actual answer, also source AI; no Field or financial state is invented.
  const current = (await api('GET', '/api/ai/campaigns/' + campaign + '/qualification')).json(), textQuestion = randomUUID();
  assert.equal((await api('PUT', '/api/ai/campaigns/' + campaign + '/qualification', { version: current.version, definition: { ...current.definition, questions: [...current.definition.questions, { id: textQuestion, prompt: 'Availability?', fieldId: null, required: false }] }, reason: 'Unmapped autonomous answer' })).statusCode, 200);
  await activate(); const text = (await inbound('unmapped', 'Evening <img literal>'))!; await run(qualify(textQuestion, 'Evening <img literal>', 'Evening <img literal>')); assert.equal(await processOneAIQualificationAction(db), true);
  const textDTO = (await api('GET', qr, undefined, 'agent')).json().questions.find((q: any) => q.id === textQuestion); assert.equal(textDTO.source, 'AI'); assert.equal(textDTO.value, 'Evening <img literal>');
  assert.equal((await db`SELECT state FROM ai_customer_action WHERE proposal_id=${text.id}`)[0]!.state, 'APPLIED');
  // Old proposals/diagnostic attention cannot acquire new admission after approval or explicit controller reset.
  await grant(false); await activate(); const diagnostic = (await inbound('diagnostic', 'Yes, interested'))!; await run(qualify());
  await grant(); await activate();
  await assert.rejects(db`INSERT INTO ai_customer_action_admission(proposal_id,event_id,context) VALUES(${diagnostic.id},${diagnostic.event_id},${db.json(diagnostic.context)})`, /NEW_ACTIVE_SOURCE_REQUIRED/);
  assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_action_admission WHERE proposal_id=${diagnostic.id}`)[0]!.n, 0);
  // Current dependency changes between proposal and local execution block, rather than silently applying an old result.
  for (const [name, change, undo] of [
    ['human', () => db`UPDATE conversation SET controller_type='HUMAN',controller_user_id=${users.agent!.id},state='HUMAN_ACTIVE' WHERE id=${cv}`, activate],
    ['owner', () => db`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`, () => db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`],
    ['field', () => db`UPDATE campaign_field SET usable_by_ai=false,version=version+1 WHERE campaign_id=${campaign} AND field_id=${field}`, () => db`UPDATE campaign_field SET usable_by_ai=true,version=version+1 WHERE campaign_id=${campaign} AND field_id=${field}`],
    ['policy', () => grant(false), () => grant()],
    ['sender', () => db`UPDATE messaging_sender SET operator_enabled=false WHERE id=${sender}`, () => db`UPDATE messaging_sender SET operator_enabled=true WHERE id=${sender}`],
    ['branch', () => db`UPDATE branch SET active=false WHERE id=${branch}`, () => db`UPDATE branch SET active=true WHERE id=${branch}`],
    ['profile', () => db`UPDATE ai_model_profile SET active=false,session_id=${users.manager!.session},version=version+1 WHERE id=${profile}`, () => db`UPDATE ai_model_profile SET active=true,session_id=${users.manager!.session},version=version+1 WHERE id=${profile}`],
  ] as const) {
    await activate(); const pending = (await inbound('fence-' + name, 'Yes, interested'))!; await run(qualify()); const before = (await db`SELECT version FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}`)[0]!.version;
    await change(); assert.equal(await processOneAIQualificationAction(db), true); assert.equal((await db`SELECT state,error_code FROM ai_customer_action WHERE proposal_id=${pending.id}`)[0]!.error_code, 'AI_ACTION_CONTEXT_CHANGED');
    assert.equal((await db`SELECT version FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}`)[0]!.version, before); await undo();
  }
  await activate(); const publication = (await inbound('new-publication', 'Yes, interested'))!; await run(qualify());
  const draft = (await api('GET', kr)).json().draft;
  assert.equal((await api('PUT', kr + '/draft', { version: draft.version, content: { ...draft.content, sections: { ...draft.content.sections, prices: 'New current approved price' } }, reason: 'Publish fences the pending action' })).statusCode, 200);
  assert.equal((await api('POST', kr + '/publish', { version: draft.version + 1, requestId: randomUUID(), reason: 'New published knowledge before tool action' })).statusCode, 201);
  assert.equal(await processOneAIQualificationAction(db), true); assert.equal((await db`SELECT state FROM ai_customer_action WHERE proposal_id=${publication.id}`)[0]!.state, 'BLOCKED');
  assert.equal((await query(publication.id))[0]!.context.knowledge.version, 1);
  // A competing current Human edit wins; the old proposal cannot overwrite it after waiting for parent locks.
  await activate(); const concurrent = (await inbound('concurrent-human', 'Yes, interested'))!; await run(qualify());
  let entered!: () => void, release!: () => void; const ready = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
  const humanWrite = db.begin(async tx => { await tx`SELECT id FROM branch WHERE id=${branch} FOR SHARE`; await tx`SELECT id FROM lead WHERE id=${lead} FOR UPDATE`; entered(); await wait;
    await tx`UPDATE lead_field_value SET value='false',source='MANUAL',updated_by=${users.agent!.id},version=version+1 WHERE lead_id=${lead} AND field_id=${field}`; });
  await ready; const race = processOneAIQualificationAction(db); release(); await humanWrite; assert.equal(await race, true); assert.equal((await db`SELECT state FROM ai_customer_action WHERE proposal_id=${concurrent.id}`)[0]!.state, 'BLOCKED');
  // APPLIED without the atomic answer/Field proof cannot commit, even through native SQL.
  await activate(); const atomic = (await inbound('atomic-proof', 'Yes, interested'))!; await run(qualify());
  await assert.rejects(db`INSERT INTO ai_customer_action(proposal_id,lead_id,campaign_id,conversation_id,state,context) VALUES(${atomic.id},${randomUUID()},${campaign},${cv},'APPLIED',${db.json(atomic.context)})`, /SCOPE_REQUIRED/);
  await assert.rejects(db`INSERT INTO ai_customer_action(proposal_id,lead_id,campaign_id,conversation_id,state,context) VALUES(${atomic.id},${lead},${campaign},${cv},'APPLIED',${db.json(atomic.context)})`, /ATOMIC_ANSWER_REQUIRED/);
  await db`CREATE FUNCTION reject_synthetic_ai_action_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_CUSTOMER_TOOL_APPLIED' THEN RAISE EXCEPTION 'synthetic action audit failure';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER reject_synthetic_ai_action_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_synthetic_ai_action_audit()`;
  try { await assert.rejects(processOneAIQualificationAction(db), /synthetic action audit failure/); assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_action WHERE proposal_id=${atomic.id}`)[0]!.n, 0); }
  finally { await db`DROP TRIGGER reject_synthetic_ai_action_audit ON audit_log`; await db`DROP FUNCTION reject_synthetic_ai_action_audit()`; }
  assert.equal(await processOneAIQualificationAction(db), true); assert.equal((await db`SELECT state FROM ai_customer_action WHERE proposal_id=${atomic.id}`)[0]!.state, 'APPLIED');
  // Native typing rejects forged values independently; shared normalization covers full application semantics.
  assert.equal((await db`SELECT ai_qualification_value_valid('"true"'::jsonb,fd) AS valid FROM field_definition fd WHERE id=${field}`)[0]!.valid, false);
  const budget = (await db`INSERT INTO field_definition(organization_id,branch_id,campaign_id,key,label,field_type,validation) VALUES(${org},${branch},${campaign},'budget','Budget','CURRENCY','{"currency":"EUR","min":0,"max":1000}') RETURNING id`)[0]!.id;
  await db`INSERT INTO campaign_field(campaign_id,field_id,usable_by_ai) VALUES(${campaign},${budget},true)`;
  const budgetQuestion = randomUUID(), qcfg = (await api('GET', '/api/ai/campaigns/' + campaign + '/qualification')).json();
  assert.equal((await api('PUT', '/api/ai/campaigns/' + campaign + '/qualification', { version: qcfg.version, definition: { ...qcfg.definition, questions: [...qcfg.definition.questions, { id: budgetQuestion, prompt: 'Budget?', fieldId: budget, required: false }] }, reason: 'Actual typed currency extraction' })).statusCode, 200);
  for (const invalid of [{ amount: 1, currency: 'USD' }, { amount: 1001, currency: 'EUR' }, { amount: -1, currency: 'EUR' }, { amount: 0.1234567, currency: 'EUR' }])
    assert.equal((await db`SELECT ai_qualification_value_valid(${db.json(invalid)},fd) AS valid FROM field_definition fd WHERE id=${budget}`)[0]!.valid, false);
  await activate(); const currency = (await inbound('actual-currency', 'Budget 120.25 EUR'))!; await run(qualify(budgetQuestion, { amount: 120.25, currency: 'EUR' }, '120.25 EUR')); assert.equal(await processOneAIQualificationAction(db), true);
  assert.equal((await db`SELECT state FROM ai_customer_action WHERE proposal_id=${currency.id}`)[0]!.state, 'APPLIED');
  assert.deepEqual((await db`SELECT value FROM lead_field_value WHERE lead_id=${lead} AND field_id=${budget}`)[0]!.value, { amount: 120.25, currency: 'EUR' });
  // A delayed older provider message is retained but cannot overwrite the current newer answer.
  await activate(); const beforeOlder = (await db`SELECT version FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}`)[0]!.version;
  const oldInput = JSON.parse(raw('delayed-older', 'Yes, interested'));
  oldInput.entry[0].changes[0].value.messages[0].timestamp = String(Math.floor(Date.now() / 1000) - 3600);
  const oldRaw = JSON.stringify(oldInput);
  assert.equal((await app.inject({ method: 'POST', url: '/api/webhooks/messaging/meta/' + mc, payload: oldRaw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'synthetic-hmac-secret').update(oldRaw).digest('hex') } })).statusCode, 200);
  assert.equal(await processOneInboundEvent(db), true);
  const older = (await db`SELECT * FROM ai_customer_proposal WHERE event_id=(SELECT id FROM integration_event WHERE payload->'message'->>'id'='delayed-older')`)[0]!;
  assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_action_admission WHERE proposal_id=${older.id}`)[0]!.n, 0);
  await run(qualify()); assert.equal(await processOneAIQualificationAction(db), false);
  assert.equal((await db`SELECT version FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}`)[0]!.version, beforeOlder);
  assert.equal((await db`SELECT source,version FROM lead_field_value WHERE lead_id=${lead} AND field_id=${budget}`)[0]!.version, 1);
  // First consent INSERT on a shared Contact is fenced even through another Lead.
  const siblingCampaign = (await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES(${org},${branch},'Shared Contact scope','ACTIVE') RETURNING id`)[0]!.id;
  const sibling = (await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,source_kind) VALUES(${org},${branch},${siblingCampaign},${contact},'MANUAL') RETURNING id`)[0]!.id;
  await activate(); const contactRace = (await inbound('shared-consent-first', 'Yes, interested'))!; await run(qualify());
  let contextHeld!: () => void, releaseContext!: () => void, rivalEntered!: () => void;
  const heldContext = new Promise<void>(r => { contextHeld = r; }), releaseWait = new Promise<void>(r => { releaseContext = r; }), enteredRival = new Promise<void>(r => { rivalEntered = r; });
  const contextWriter = db.begin(async tx => { await tx`SELECT proposal_id FROM ai_customer_action_job WHERE proposal_id=${contactRace.id} FOR UPDATE`;
    assert.ok((await tx`SELECT ai_customer_action_context(${contactRace.id}) AS context`)[0]!.context); contextHeld(); await releaseWait; return collectAIQualificationAnswer(tx, contactRace.id); });
  await heldContext; let consentCommitted = false;
  const consentWriter = db.begin(async tx => { await tx`SELECT id FROM lead WHERE id=${sibling} FOR SHARE`; rivalEntered(); await tx`SELECT id FROM contact WHERE id=${contact} FOR UPDATE`;
    await tx`INSERT INTO messaging_consent(contact_id,channel,status,do_not_contact,source,updated_by) VALUES(${contact},'WHATSAPP','REVOKED',true,'Synthetic current contact revocation',${users.manager!.id})`; }).then(() => { consentCommitted = true; });
  await enteredRival; await new Promise(r => setTimeout(r, 75)); assert.equal(consentCommitted, false); releaseContext();
  assert.equal((await contextWriter).state, 'APPLIED'); await consentWriter; assert.equal(consentCommitted, true);
  assert.equal((await db`SELECT ai_customer_proposal_context(${contactRace.event_id}) AS context`)[0]!.context, null);
  // Hidden Field values never leak through action metadata or completion/history DTOs.
  await db`UPDATE campaign_field SET visible_to_agent=false,editable_by_agent=false,version=version+1 WHERE campaign_id=${campaign} AND field_id=${field}`;
  const hidden = (await api('GET', qr, undefined, 'agent')).json(); assert.equal(hidden.questions.some((q: any) => q.id === question), false); assert.equal(hidden.result, null);
  const history = (await api('GET', root, undefined, 'agent')).json(); assert.equal(JSON.stringify(history).includes('question_snapshot'), false); assert.equal(JSON.stringify(history).includes('answerValue'), false);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message WHERE direction='OUTBOUND'`)[0]!.n, 0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_record`)[0]!.n, 0); assert.equal((await db`SELECT count(*)::integer AS n FROM enrollment`)[0]!.n, 0); assert.equal(fetchCalls, 0);
});
