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
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Customer proposal worker uses authenticated autonomous scope, current fences, leased retries, native guards and safe history without actions', async t => {
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
  // Default worker blocks before credential decryption/HTTP; an old BLOCKED result cannot be revived.
  const first = (await inbound('default-off'))!; assert.equal(first.state, 'QUEUED');
  const environment = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { await assert.rejects(run(), /AI_TEST_TRANSPORT_REQUIRES_ISOLATED_DATABASE/); } finally { process.env.NODE_ENV = environment; }
  const locked = await Promise.all(Array.from({ length: 8 }, () => db.begin(tx => tx`SELECT ai_customer_proposal_locked_context(${first.event_id}) AS ctx`)));
  assert.ok(locked.every(rows => rows[0]?.ctx?.scope?.leadId === lead));
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY; process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  assert.equal(await processOneAICustomerProposal(db), true); process.env.CREDENTIAL_ENCRYPTION_KEY = key;
  assert.equal((await query(first.id))[0]!.error_code, 'AI_LIVE_DATA_TRANSFER_DISABLED'); assert.equal(calls, 0); assert.equal(fetchCalls, 0);
  await assert.rejects(db`UPDATE ai_customer_proposal SET state='QUEUED',error_code=NULL,version=version+1 WHERE id=${first.id}`, /TERMINAL/);
  // Publishing employee session is not the autonomous execution authority.
  assert.equal((await receive('deduplicated')).statusCode, 200);
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => receive('deduplicated'))); assert.ok(duplicates.every(r => r.statusCode === 200 && r.json().created === 0));
  assert.deepEqual((await Promise.all(Array.from({ length: 4 }, () => processOneInboundEvent(db)))).sort(), [false, false, false, true]);
  const p = (await db`SELECT * FROM ai_customer_proposal WHERE state='QUEUED'`)[0]!;
  await db`UPDATE user_session SET revoked_at=now() WHERE id=${users.manager!.session}`;
  assert.deepEqual((await Promise.all(Array.from({ length: 4 }, () => run()))).sort(), [false, false, false, true]);
  assert.equal(calls, 1); assert.equal((await query(p.id))[0]!.state, 'PROPOSED');
  const audit = (await db`SELECT actor_user_id,detail FROM audit_log WHERE target_id=${p.id} AND action='AI_CUSTOMER_PROPOSAL_PROPOSED'`)[0]!;
  assert.equal(audit.actor_user_id, null); assert.equal(JSON.stringify(audit.detail).includes('Approved amount'), false);
  const history = await api('GET', root, undefined, 'agent'); assert.equal(history.statusCode, 200, history.body);
  const item = history.json().items.find((e: { id: string }) => e.id === p.id); assert.equal(item.proposal.answer, content.sections.prices); assert.equal(item.providerInvoked, true); assert.equal(item.sendAllowed, false); assert.equal(item.mutationsAllowed, false);
  assert.equal((await api('GET', root, undefined, 'second')).statusCode, 404); assert.equal((await api('GET', root, undefined, 'foreign')).statusCode, 404);
  assert.equal((await api('POST', root, { source: 'AI', tools: ['SQL'] }, 'agent')).statusCode, 404);
  assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_proposal_history WHERE proposal_id=${p.id}`)[0]!.n, 3);
  // Refresh management authority only for later setup edits; worker success above used no Human session.
  const managementToken = randomBytes(32).toString('hex');
  users.manager!.session = (await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${users.manager!.id},${sha256(managementToken)},now()+interval '1 hour') RETURNING id`)[0]!.id;
  users.manager!.cookie = 'lop_session=' + managementToken;
  await assert.rejects(db`UPDATE ai_customer_proposal_history SET state='QUEUED' WHERE proposal_id=${p.id}`, /HISTORY_IMMUTABLE/);
  await assert.rejects(db`UPDATE ai_customer_proposal SET context='{}',version=version+1 WHERE id=${p.id}`, /IMMUTABLE_CONTEXT/);
  await assert.rejects(db`INSERT INTO ai_customer_proposal(organization_id,branch_id,campaign_id,lead_id,conversation_id,event_id,message_id,context,context_hash)
    VALUES(${org},${other},${campaign},${lead},${cv},${p.event_id},${p.message_id},${db.json(p.context)},'')`, /SOURCE_REQUIRED/);
  // Production Responses HTTP adapter is exercised against a bounded synthetic HTTP mock.
  let http = 0; globalThis.fetch = async (_url, init) => { http++; const body = JSON.parse(init!.body as string); assert.equal(body.text.format.name, 'customer_proposal'); assert.equal(body.store, false); assert.deepEqual(body.tools, []);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(handoff) }] }] })); };
  const unknown = (await inbound('unknown', 'Unknown campaign price <img onerror=alert(1)>'))!; assert.equal(await run(aiInferenceAdapters), true); assert.equal(http, 1); assert.equal((await query(unknown.id))[0]!.result.handoffReason, 'UNKNOWN_ANSWER');
  globalThis.fetch = async () => { fetchCalls++; throw Error('Unexpected external call'); };
  // Candidate extraction uses current Campaign questions/typed Fields and exact source evidence, never actual capture yet.
  const question = (await db`SELECT definition->'questions'->0->>'id' AS id FROM ai_qualification_config WHERE campaign_id=${campaign}`)[0]!.id;
  const capture = (await inbound('qualification', 'Yes, interested'))!;
  assert.equal(await run({ OPENAI: { ...adapters.OPENAI!, proposeCustomer: async () => ({ ...handoff, decision: 'QUALIFICATION', questionId: question, answerValue: true, sourceQuote: 'Yes, interested', handoffReason: null }) } }), true);
  assert.equal((await query(capture.id))[0]!.state, 'PROPOSED');
  const candidateDTO = (await api('GET', root, undefined, 'agent')).json().items.find((e: { id: string }) => e.id === capture.id); assert.deepEqual(candidateDTO.proposal, { decision: 'QUALIFICATION', handoffReason: null, answer: null });
  const currencyField = (await db`INSERT INTO field_definition(organization_id,branch_id,campaign_id,key,label,field_type,validation) VALUES(${org},${branch},${campaign},'budget','Budget','CURRENCY','{"currency":"EUR"}') RETURNING id`)[0]!.id;
  await db`INSERT INTO campaign_field(campaign_id,field_id,usable_by_ai) VALUES(${campaign},${currencyField},true)`;
  const currentDefinition = (await db`SELECT version,definition FROM ai_qualification_config WHERE campaign_id=${campaign}`)[0]!, currencyQuestion = randomUUID();
  assert.equal((await api('PUT', '/api/ai/campaigns/' + campaign + '/qualification', { version: currentDefinition.version, definition: { ...currentDefinition.definition, questions: [...currentDefinition.definition.questions, { id: currencyQuestion, prompt: 'Budget?', fieldId: currencyField, required: false }] }, reason: 'Typed Currency proposal contract' })).statusCode, 200);
  const currency = (await inbound('currency', 'Budget 120.25 EUR'))!;
  assert.equal(await run({ OPENAI: { ...adapters.OPENAI!, proposeCustomer: async () => ({ ...handoff, decision: 'QUALIFICATION', questionId: currencyQuestion, answerValue: { amount: 120.25, currency: 'EUR' }, sourceQuote: '120.25 EUR', handoffReason: null }) } }), true);
  assert.equal((await query(currency.id))[0]!.state, 'PROPOSED'); assert.deepEqual((await query(currency.id))[0]!.result.answerValue, { amount: 120.25, currency: 'EUR' });
  // Native completion requires a current unexpired lease and the exact current source/context.
  const guarded = (await inbound('native-guard'))!, lease = randomUUID();
  await db`UPDATE ai_customer_proposal SET state='RUNNING',attempt_count=1,lease_token=${lease},lease_until=clock_timestamp()+interval '60 seconds',version=version+1 WHERE id=${guarded.id}`;
  const proof = { ...answer, protocolVersion: 1, toolsExecuted: [], sendAllowed: false, mutationsAllowed: false };
  await assert.rejects(db`UPDATE ai_customer_proposal SET state='PROPOSED',result=${db.json(proof)},provider_invoked=true,completed_lease_token=${randomUUID()},lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=${guarded.id}`, /LEASE_REQUIRED/);
  for (const forged of [{ ...proof, referenceIds: ['foreign'] }, { ...proof, toolsExecuted: ['confirmPayment'] }, { ...proof, sendAllowed: true },
    { ...proof, decision: null, referenceIds: [], questionId: question, answerValue: true, sourceQuote: 'What' }])
    await assert.rejects(db`UPDATE ai_customer_proposal SET state='PROPOSED',result=${db.json(forged)},provider_invoked=true,completed_lease_token=${lease},lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=${guarded.id}`, /RESULT_REQUIRED/);
  await db`UPDATE ai_customer_proposal SET state='BLOCKED',error_code='SYNTHETIC_NATIVE_GUARD_TEST',completed_lease_token=${lease},lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=${guarded.id}`;
  // Provider failures have bounded retries and never expose private provider errors.
  const failed = (await inbound('retry'))!;
  const unavailable: AIInferenceRegistry = { OPENAI: { ...adapters.OPENAI!, proposeCustomer: async () => { throw new AIInferenceError('AI_RATE_LIMITED', true); } } };
  for (let n = 0; n < 5; n++) assert.equal(await run(unavailable), true);
  assert.equal((await query(failed.id))[0]!.state, 'FAILED'); assert.equal((await query(failed.id))[0]!.attempt_count, 5);
  const malformed = (await inbound('malformed'))!; assert.equal(await run({ OPENAI: { ...adapters.OPENAI!, proposeCustomer: async () => ({ ...answer, referenceIds: ['other-campaign'], tool: 'SQL' }) } }), true); assert.equal((await query(malformed.id))[0]!.error_code, 'AI_RESPONSE_INVALID');
  const sensitive = (await inbound('sensitive', 'card_number=٤١١١١١١١١١١١١١١١'))!; const beforeSensitive = calls; assert.equal(await run(), true); assert.equal(calls, beforeSensitive); assert.equal((await query(sensitive.id))[0]!.error_code, 'AI_SENSITIVE_INPUT_OMITTED');
  // Expired lease response cannot win after a successor reclaims it.
  const lost = (await inbound('lease-loss'))!; let entered!: () => void, resolve!: (p: object) => void; const ready = new Promise<void>(r => { entered = r; });
  const slow: AIInferenceRegistry = { OPENAI: { ...adapters.OPENAI!, proposeCustomer: async () => { entered(); return new Promise(r => { resolve = r; }); } } };
  const old = run(slow, 0.1); await ready; await new Promise(r => setTimeout(r, 160)); assert.equal(await run(), true); resolve(handoff); await old;
  assert.equal((await query(lost.id))[0]!.state, 'PROPOSED'); assert.equal((await query(lost.id))[0]!.result.decision, 'ANSWER'); assert.equal((await query(lost.id))[0]!.attempt_count, 2);
  // Human takeover during HTTP succeeds immediately and prevents the old proposal from completing.
  const takeover = (await inbound('takeover'))!; let started!: () => void, finish!: (p: object) => void; const active = new Promise<void>(r => { started = r; });
  const mid = run({ OPENAI: { ...adapters.OPENAI!, proposeCustomer: async () => { started(); return new Promise(r => { finish = r; }); } } }); await active;
  const version = (await db`SELECT version FROM conversation WHERE id=${cv}`)[0]!.version;
  assert.equal((await api('POST', '/api/conversations/' + cv + '/takeover', { version, reason: 'Human control during inference' }, 'agent')).statusCode, 200); finish(answer); await mid;
  assert.equal((await query(takeover.id))[0]!.state, 'BLOCKED'); assert.equal((await query(takeover.id))[0]!.error_code, 'AI_CUSTOMER_CONTEXT_REVOKED_OR_CHANGED');
  assert.equal(await inbound('human-message'), undefined);
  // Current configuration, sender, branch, Field, new inbound and Published knowledge all fence queued work.
  await db`UPDATE conversation SET controller_type='AI',controller_user_id=NULL,state='AI_ACTIVE',needs_attention_reason=NULL WHERE id=${cv}`;
  for (const [name, change, undo] of [
    ['disabled-campaign', () => db`UPDATE campaign SET ai_config='{"enabled":false}' WHERE id=${campaign}`, () => db`UPDATE campaign SET ai_config='{"enabled":true}' WHERE id=${campaign}`],
    ['disabled-profile', () => db`UPDATE ai_model_profile SET active=false,session_id=${users.manager!.session},version=version+1 WHERE id=${profile}`, () => db`UPDATE ai_model_profile SET active=true,session_id=${users.manager!.session},version=version+1 WHERE id=${profile}`],
    ['invalid-pin', () => db`UPDATE messaging_sender SET operator_enabled=false WHERE id=${sender}`, () => db`UPDATE messaging_sender SET operator_enabled=true WHERE id=${sender}`],
    ['disabled-branch', () => db`UPDATE branch SET active=false WHERE id=${branch}`, () => db`UPDATE branch SET active=true WHERE id=${branch}`],
    ['field-scope', () => db`UPDATE campaign_field SET usable_by_ai=false,version=version+1 WHERE campaign_id=${campaign} AND field_id=${field}`, () => db`UPDATE campaign_field SET usable_by_ai=true,version=version+1 WHERE campaign_id=${campaign} AND field_id=${field}`],
  ] as const) {
    const current = (await inbound(name))!; const before: number = calls; await change(); assert.equal(await run(), true); assert.equal(calls, before); assert.equal((await query(current.id))[0]!.state, 'BLOCKED'); await undo();
  }
  const earlier = (await inbound('older-inbound'))!; const newer = (await inbound('newer-inbound'))!; assert.equal(await run(), true); assert.equal((await query(earlier.id))[0]!.state, 'BLOCKED'); assert.equal(await run(), true); assert.equal((await query(newer.id))[0]!.state, 'PROPOSED');
  const oldVersion = (await inbound('old-publication'))!;
  // Use a new authorized manager session to publish; its lifetime does not define autonomous authority.
  const tok = randomBytes(32).toString('hex'); await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${users.manager!.id},${sha256(tok)},now()+interval '1 hour')`; users.manager!.cookie = 'lop_session=' + tok;
  assert.equal((await api('PUT', kr + '/draft', { version: 1, content: { ...content, sections: { ...content.sections, prices: 'New approved published price' } }, reason: 'Publish current version' })).statusCode, 200);
  assert.equal((await api('POST', kr + '/publish', { version: 2, requestId: randomUUID(), reason: 'Second current publication' })).statusCode, 201);
  assert.equal(await run(), true); assert.equal((await query(oldVersion.id))[0]!.state, 'BLOCKED'); const fresh = (await inbound('current-publication'))!; assert.equal(await run(), true); assert.equal((await query(fresh.id))[0]!.context.knowledge.version, 2); assert.equal((await query(p.id))[0]!.context.knowledge.version, 1);
  // Configured approval is traced but never turns a proposal into action authority. Changes fence work before/after HTTP.
  const policyRoot = '/api/ai/campaigns/' + campaign + '/tool-policy', toolPending = (await inbound('tool-policy-pending'))!, beforeTools = calls;
  assert.equal((await api('PUT', policyRoot, { version: 0, definition: { allowedTools: ['requestHumanHandoff','updateQualificationField'] }, reason: 'Explicit future customer action approval' })).statusCode, 200);
  assert.equal(await run(), true); assert.equal(calls, beforeTools); assert.equal((await query(toolPending.id))[0]!.state, 'BLOCKED');
  const toolFresh = (await inbound('tool-policy-current'))!; assert.equal(toolFresh.context.toolPolicy.campaignVersion, 1); assert.deepEqual(toolFresh.context.toolPolicy.allowedTools, ['requestHumanHandoff','updateQualificationField']); assert.deepEqual(toolFresh.context.approvedTools, []);
  assert.equal(await run(), true); assert.equal((await query(toolFresh.id))[0]!.state, 'PROPOSED'); assert.deepEqual((await query(toolFresh.id))[0]!.result.toolsExecuted, []);
  const policyInFlight = (await inbound('tool-policy-inflight'))!; let policyEntered!: () => void, policyRelease!: (p: object) => void; const policyReady = new Promise<void>(r => { policyEntered = r; });
  const policyWork = run({ OPENAI: { ...adapters.OPENAI!, proposeCustomer: async () => { policyEntered(); return new Promise(r => { policyRelease = r; }); } } }); await policyReady;
  assert.equal((await api('PUT', policyRoot, { version: 1, definition: { allowedTools: [] }, reason: 'Revoke pending customer action approval' })).statusCode, 200);
  policyRelease(answer); await policyWork; assert.equal((await query(policyInFlight.id))[0]!.state, 'BLOCKED'); assert.equal((await query(toolFresh.id))[0]!.context.toolPolicy.campaignVersion, 1);
  // Audit failure is atomic, leaving a lease recoverable without tool/send replay.
  const atomic = (await inbound('atomic'))!;
  await db`CREATE FUNCTION proposal_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_CUSTOMER_PROPOSAL_PROPOSED' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER proposal_test_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION proposal_test_audit_failure()`;
  try { await assert.rejects(run(adapters, 0.1), /SYNTHETIC_AUDIT_FAILURE/); assert.equal((await query(atomic.id))[0]!.state, 'RUNNING'); }
  finally { await db`DROP TRIGGER proposal_test_audit ON audit_log`; await db`DROP FUNCTION proposal_test_audit_failure()`; }
  await new Promise(r => setTimeout(r, 160)); assert.equal(await run(), true); assert.equal((await query(atomic.id))[0]!.state, 'PROPOSED');
  // Backpressure retains every accepted message; it does not turn old BLOCKED traces into work.
  for (let n = 0; n < 11; n++) await inbound('burst-' + n);
  assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_proposal WHERE conversation_id=${cv} AND state='QUEUED'`)[0]!.n, 10);
  assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE action='AI_CUSTOMER_PROPOSAL_BACKPRESSURE' AND target_id=${cv}`)[0]!.n, 1);
  const beforeBurst = calls; for (let n = 0; n < 10; n++) assert.equal(await run(), true); assert.equal(calls, beforeBurst);
  const paged = (await api('GET', root + '?limit=2', undefined, 'agent')).json(); assert.equal(paged.items.length, 2); assert.ok(paged.nextCursor); assert.equal((await api('GET', root + '?cursor=' + encodeURIComponent(paged.nextCursor), undefined, 'agent')).statusCode, 200);
  // Valid large qualification schemas can exceed the AI snapshot bound. Core inbound must still commit.
  const options = Array.from({ length: 100 }, (_, n) => ({ value: String(n).padStart(3, '0') + 'x'.repeat(97), label: 'Label' + 'x'.repeat(195), active: true }));
  const largeQuestions = [];
  for (let n = 0; n < 40; n++) {
    const f = (await db`INSERT INTO field_definition(organization_id,branch_id,campaign_id,key,label,field_type,options) VALUES(${org},${branch},${campaign},${'large_' + n},'Large valid options','SINGLE_SELECT',${db.json(options)}) RETURNING id`)[0]!.id;
    await db`INSERT INTO campaign_field(campaign_id,field_id,usable_by_ai) VALUES(${campaign},${f},true)`; largeQuestions.push({ id: randomUUID(), prompt: 'Choose option ' + n, fieldId: f, required: true });
  }
  const largeVersion = (await db`SELECT version FROM ai_qualification_config WHERE campaign_id=${campaign}`)[0]!.version;
  assert.equal((await api('PUT', '/api/ai/campaigns/' + campaign + '/qualification', { version: largeVersion, definition: { ...emptyQualification(), enabled: true, questions: largeQuestions }, reason: 'Valid large Campaign qualification' })).statusCode, 200);
  assert.equal(await inbound('large-context'), undefined);
  assert.equal((await db`SELECT state FROM integration_event WHERE payload->'message'->>'id'='large-context'`)[0]!.state, 'PROCESSED');
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message WHERE provider_message_id='large-context'`)[0]!.n, 1);
  assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE action='AI_CUSTOMER_CONTEXT_BLOCKED' AND detail->>'errorCode'='AI_CUSTOMER_CONTEXT_TOO_LARGE'`)[0]!.n, 1);
  const attention = (await api('GET', '/api/conversations/' + cv, undefined, 'agent')).json().conversation;
  assert.equal(attention.needs_attention_reason, 'AI_CUSTOMER_CONTEXT_TOO_LARGE');
  assert.equal((await api('POST', '/api/conversations/' + cv + '/takeover', { version: attention.version, reason: 'Human recovery of oversized AI context' }, 'agent')).statusCode, 200);
  assert.equal((await db`SELECT needs_attention_reason FROM conversation WHERE id=${cv}`)[0]!.needs_attention_reason, null);
  for (const table of ['payment_record', 'enrollment', 'lead_qualification_answer', 'lead_field_value']) assert.equal((await db.unsafe('SELECT count(*)::integer AS n FROM ' + table))[0]!.n, 0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message WHERE direction='OUTBOUND'`)[0]!.n, 0);
});

