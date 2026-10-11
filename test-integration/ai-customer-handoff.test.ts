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
import { requestAIHumanHandoff, processOneAIHumanHandoff } from '../src/ai/customer-handoff.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Approved customer AI Handoff owns current authority, durable atomic transition and scoped Human acceptance', async t => {
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
  for (const [name, role, bid, oid] of [['manager', 'MANAGER', branch, org], ['agent', 'AGENT', branch, org], ['second', 'AGENT', branch, org], ['other', 'MANAGER', other, org], ['foreign', 'SUPER_ADMIN', null, foreign], ['admin', 'SUPER_ADMIN', null, org]] as const) {
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
  const adapters: AIInferenceRegistry = { OPENAI: { simulate: async () => { throw Error('Wrong operation'); }, proposeCustomer: async () => handoff } };
  const run = () => processOneAICustomerProposal(db, { adapters, retryDelaySeconds: 0 });
  const toolRoot = '/api/ai/campaigns/' + campaign + '/tool-policy';
  const grant = async (allowed = true) => {
    const v = (await api('GET', toolRoot)).json().version;
    const r = await api('PUT', toolRoot, { version: v, definition: { allowedTools: allowed ? ['requestHumanHandoff'] : [] }, reason: 'Explicit synthetic Handoff approval' });
    assert.equal(r.statusCode, 200, r.body);
  };
  const activate = () => db`UPDATE conversation SET controller_type='AI',controller_user_id=NULL,state='AI_ACTIVE',needs_attention_reason=NULL WHERE id=${cv}`;
  const review = '/api/conversations/' + cv + '/ai-handoffs';
  await grant();
  // Handoff does not require qualification questions. No global runtime activation.
  const qc = (await api('GET', '/api/ai/campaigns/' + campaign + '/qualification')).json();
  assert.equal((await api('PUT', '/api/ai/campaigns/' + campaign + '/qualification', { version: qc.version, definition: emptyQualification(), reason: 'Handoff independent of qualification' })).statusCode, 200);
  const off = (await inbound('live-off'))!; assert.equal(await processOneAICustomerProposal(db), true); assert.equal((await query(off.id))[0]!.state, 'BLOCKED'); assert.equal(await processOneAIHumanHandoff(db), false);
  await activate();
  const first = (await inbound('handoff-first', 'I want a person <img src=x onerror=alert(1)>'))!;
  assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_ACTIVE');
  await Promise.all(Array.from({ length: 8 }, () => receive('handoff-first', 'I want a person <img src=x onerror=alert(1)>')));
  assert.equal(await processOneInboundEvent(db), false); assert.equal(await run(), true);
  assert.equal((await db`SELECT state FROM ai_customer_handoff_job WHERE proposal_id=${first.id}`)[0]!.state, 'QUEUED');
  assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_ACTIVE');
  const workers = await Promise.all(Array.from({ length: 4 }, () => processOneAIHumanHandoff(db))); assert.equal(workers.filter(Boolean).length, 1);
  const action = (await db`SELECT * FROM ai_customer_handoff_action WHERE proposal_id=${first.id}`)[0]!;
  assert.equal(action.state, 'APPLIED'); assert.equal(action.handoff_reason, 'UNKNOWN_ANSWER');
  const current = (await db`SELECT * FROM conversation WHERE id=${cv}`)[0]!;
  assert.equal(current.state, 'WAITING_FOR_HUMAN'); assert.equal(current.controller_type, 'NONE'); assert.equal(current.controller_user_id, null); assert.equal(current.needs_attention_reason, 'AI_HUMAN_HANDOFF_REQUESTED');
  assert.equal(current.ai_handoff_action_id, action.id); assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${lead}`)[0]!.assigned_agent_id, users.agent!.id);
  assert.equal((await db`SELECT state FROM ai_customer_handoff_job WHERE proposal_id=${first.id}`)[0]!.state, 'DONE');
  assert.equal((await db`SELECT requested_by FROM conversation_handoff WHERE ai_action_id=${action.id}`)[0]!.requested_by, null);
  assert.equal((await db`SELECT actor_user_id FROM audit_log WHERE target_id=${action.id} AND action='AI_HUMAN_HANDOFF_APPLIED'`)[0]!.actor_user_id, null);
  assert.equal((await db.begin(tx => requestAIHumanHandoff(tx, first.id))).duplicate, true);
  const dto = (await api('GET', root, undefined, 'agent')).json().items.find((e: any) => e.id === first.id);
  assert.deepEqual(dto.toolsExecuted, ['requestHumanHandoff']); assert.equal(dto.action.tool, 'requestHumanHandoff'); assert.equal(dto.action.context, undefined); assert.equal(dto.sendAllowed, false);
  const requested = (await api('GET', review, undefined, 'agent')).json(); assert.equal(requested.current.state, 'WAITING_FOR_HUMAN'); assert.match(requested.items[0].customer_question, /<img/);
  const queue = '/api/ai/human-handoff-queue';
  for (const who of ['manager', 'agent']) assert.equal((await api('GET', queue, undefined, who)).json().items[0].lead_id, lead);
  for (const who of ['second', 'other', 'foreign']) assert.deepEqual((await api('GET', queue, undefined, who)).json().items, []);
  assert.equal((await api('GET', queue + '?limit=51')).statusCode, 400);
  for (const who of ['second', 'other', 'foreign']) assert.equal((await api('GET', review, undefined, who)).statusCode, 404);
  assert.equal((await api('POST', review, { tool: 'requestHumanHandoff' }, 'agent')).statusCode, 404);
  await assert.rejects(db`UPDATE ai_customer_handoff_job SET state='QUEUED',completed_at=NULL WHERE proposal_id=${first.id}`, /RECEIPT_REQUIRED/);
  await assert.rejects(db`UPDATE ai_customer_handoff_action SET handoff_reason='PAYMENT_ISSUE' WHERE id=${action.id}`, /IMMUTABLE/);
  await assert.rejects(db`DELETE FROM ai_customer_handoff_admission WHERE proposal_id=${first.id}`, /IMMUTABLE/);
  await assert.rejects(db`UPDATE conversation_handoff SET reason='forged' WHERE ai_action_id=${action.id}`, /IMMUTABLE/);
  await assert.rejects(db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state,ai_handoff_action_id)
    VALUES(${lead},${mc},${sender},'WHATSAPP','+15557770000','NONE','WAITING_FOR_HUMAN',${action.id})`, /TRANSITION_PROOF_REQUIRED/);
  // Only a current authorized employee can accept; observing the queue is not control.
  assert.equal((await api('POST', '/api/conversations/' + cv + '/takeover', { version: current.version, reason: 'Unauthorized acceptance' }, 'second')).statusCode, 404);
  assert.equal((await api('POST', '/api/conversations/' + cv + '/takeover', { version: current.version - 1, reason: 'Stale acceptance' }, 'agent')).statusCode, 409);
  // Revoke the employee session after initial HTTP authentication while waiting on the Conversation lock.
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>(resolve => { ready = resolve; }), unlocked = new Promise<void>(resolve => { release = resolve; });
  const blocker = db.begin(async tx => { await tx`SELECT id FROM conversation WHERE id=${cv} FOR UPDATE`; ready(); await unlocked; });
  await held;
  const attempting = api('POST', '/api/conversations/' + cv + '/takeover', { version: current.version, reason: 'Session revoked during acceptance' }, 'agent');
  try {
    let waiting = false;
    for (let i = 0; i < 80; i++) {
      waiting = (await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%needs_attention_reason FROM conversation%' AND pid<>pg_backend_pid()) AS waiting`)[0]!.waiting;
      if (waiting) break; await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(waiting, true); await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.agent!.session}`;
  } finally { release(); await blocker; }
  assert.equal((await attempting).statusCode, 403); assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'WAITING_FOR_HUMAN');
  const replacementToken = randomBytes(32).toString('hex');
  users.agent!.session = (await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${users.agent!.id},${sha256(replacementToken)},now()+interval '1 hour') RETURNING id`)[0]!.id;
  users.agent!.cookie = 'lop_session=' + replacementToken;
  // A Super Admin cannot accept using the old active Branch lock after a concurrent parent transfer.
  const movedCampaign = (await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES(${org},${other},'Transfer target','ACTIVE') RETURNING id`)[0]!.id;
  await db`UPDATE branch SET active=false WHERE id=${other}`;
  let move!: () => void, parentReady!: () => void;
  const parentHeld = new Promise<void>(resolve => { parentReady = resolve; }), moveNow = new Promise<void>(resolve => { move = resolve; });
  const transfer = db.begin(async tx => {
    await tx`SELECT id FROM lead WHERE id=${lead} FOR UPDATE`; parentReady(); await moveNow;
    await tx`UPDATE lead SET branch_id=${other},campaign_id=${movedCampaign},assigned_agent_id=NULL,version=version+1 WHERE id=${lead}`;
  });
  await parentHeld;
  const staleParent = api('POST', '/api/conversations/' + cv + '/takeover', { version: current.version, reason: 'Parent moved during acceptance' }, 'admin');
  try {
    let waiting = false;
    for (let i = 0; i < 80; i++) {
      waiting = (await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%l.branch_id FROM conversation cv%' AND pid<>pg_backend_pid()) AS waiting`)[0]!.waiting;
      if (waiting) break; await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(waiting, true);
  } finally { move(); await transfer; }
  assert.equal((await staleParent).statusCode, 409); assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'WAITING_FOR_HUMAN');
  await db`UPDATE lead SET branch_id=${branch},campaign_id=${campaign},assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
  await db`UPDATE branch SET active=true WHERE id=${other}`;
  assert.equal((await api('POST', '/api/conversations/' + cv + '/takeover', { version: current.version, reason: 'Accept current human request' }, 'agent')).statusCode, 200);
  const accepted = (await db`SELECT * FROM conversation WHERE id=${cv}`)[0]!; assert.equal(accepted.state, 'HUMAN_ACTIVE'); assert.equal(accepted.controller_user_id, users.agent!.id); assert.equal(accepted.needs_attention_reason, null); assert.equal(accepted.ai_handoff_action_id, null);
  assert.deepEqual((await api('GET', queue)).json().items, []);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_handoff WHERE conversation_id=${cv}`)[0]!.n, 2);
  const humanInbound = (await inbound('after-human'))!; assert.equal(humanInbound, undefined); assert.equal(await processOneAIHumanHandoff(db), false);
  // Strict current fences after inference: no overwrite of Human, owner, Published, policy, sender or Field changes.
  for (const [name, change, undo] of [
    ['human', () => db`UPDATE conversation SET state='HUMAN_ACTIVE',controller_type='HUMAN',controller_user_id=${users.agent!.id},version=version+1 WHERE id=${cv}`, () => activate()],
    ['owner', () => db`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`, () => db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`],
    ['policy', () => grant(false), () => grant()],
    ['sender', () => db`UPDATE messaging_sender SET operator_enabled=false WHERE id=${sender}`, () => db`UPDATE messaging_sender SET operator_enabled=true WHERE id=${sender}`],
    ['branch', () => db`UPDATE branch SET active=false WHERE id=${branch}`, () => db`UPDATE branch SET active=true WHERE id=${branch}`],
  ] as const) {
    await activate(); const pending = (await inbound('fence-' + name))!; await run(); await change(); const before = (await db`SELECT state,version FROM conversation WHERE id=${cv}`)[0]!;
    assert.equal(await processOneAIHumanHandoff(db), true); assert.equal((await db`SELECT error_code FROM ai_customer_handoff_action WHERE proposal_id=${pending.id}`)[0]!.error_code, 'AI_HANDOFF_CONTEXT_CHANGED');
    assert.deepEqual((await db`SELECT state,version FROM conversation WHERE id=${cv}`)[0], before); await undo();
  }
  await activate(); const publication = (await inbound('publication'))!; await run(); const draft = (await api('GET', kr)).json().draft;
  assert.equal((await api('PUT', kr + '/draft', { version: draft.version, content: { ...draft.content, sections: { ...draft.content.sections, prices: 'New version' } }, reason: 'Publish before handoff' })).statusCode, 200);
  assert.equal((await api('POST', kr + '/publish', { version: draft.version + 1, requestId: randomUUID(), reason: 'Current version changed' })).statusCode, 201);
  assert.equal(await processOneAIHumanHandoff(db), true); assert.equal((await db`SELECT state FROM ai_customer_handoff_action WHERE proposal_id=${publication.id}`)[0]!.state, 'BLOCKED');
  // Fresh admission only; terminal/diagnostic proposals cannot be retrofitted after a grant.
  await grant(false); await activate(); const diagnostic = (await inbound('diagnostic'))!; await run();
  await activate(); await grant(); await assert.rejects(db`INSERT INTO ai_customer_handoff_admission(proposal_id,event_id,context) VALUES(${diagnostic.id},${diagnostic.event_id},${db.json(diagnostic.context)})`, /NEW_ACTIVE_SOURCE_REQUIRED/);
  assert.equal(await processOneAIHumanHandoff(db), false);
  // Deferred native proof rejects APPLIED without transition/history; Audit failure rolls back and durable work retries.
  await activate(); const atomic = (await inbound('atomic'))!; await run();
  await assert.rejects(db.begin(tx => tx`INSERT INTO ai_customer_handoff_action(proposal_id,lead_id,campaign_id,conversation_id,state,context)
    VALUES(${atomic.id},${lead},${campaign},${cv},'APPLIED',${tx.json(atomic.context)})`), /ATOMIC_TRANSITION_REQUIRED/);
  await assert.rejects(db.begin(tx => tx`INSERT INTO ai_customer_handoff_action(proposal_id,lead_id,campaign_id,conversation_id,state,context)
    VALUES(${atomic.id},${randomUUID()},${campaign},${cv},'APPLIED',${tx.json(atomic.context)})`), /SOURCE_REQUIRED/);
  await assert.rejects(db.begin(async tx => {
    const receipt = (await tx`INSERT INTO ai_customer_handoff_action(proposal_id,lead_id,campaign_id,conversation_id,state,context)
      VALUES(${atomic.id},${lead},${campaign},${cv},'APPLIED',${tx.json(atomic.context)}) RETURNING id`)[0]!;
    await tx`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`;
    await tx`UPDATE conversation SET state='WAITING_FOR_HUMAN',controller_type='NONE',controller_user_id=NULL,version=version+1,
      needs_attention_reason='AI_HUMAN_HANDOFF_REQUESTED',ai_handoff_action_id=${receipt.id} WHERE id=${cv}`;
  }), /TRANSITION_PROOF_REQUIRED/);
  await db`CREATE FUNCTION reject_handoff_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_HUMAN_HANDOFF_APPLIED' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER reject_handoff_audit_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_handoff_audit_fixture()`;
  try { await assert.rejects(processOneAIHumanHandoff(db), /SYNTHETIC_AUDIT_FAILURE/); } finally { await db`DROP TRIGGER reject_handoff_audit_fixture ON audit_log`; await db`DROP FUNCTION reject_handoff_audit_fixture()`; }
  assert.equal((await db`SELECT state FROM ai_customer_handoff_job WHERE proposal_id=${atomic.id}`)[0]!.state, 'QUEUED'); assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_ACTIVE');
  assert.equal(await processOneAIHumanHandoff(db), true);
  // Unassigned remains unassigned; Manager attention and acceptance require no invented Bank/AI/employee account.
  await activate(); await db`UPDATE lead SET assigned_agent_id=NULL,version=version+1 WHERE id=${lead}`;
  const unassigned = (await inbound('unassigned'))!; await run(); assert.equal(await processOneAIHumanHandoff(db), true);
  assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${lead}`)[0]!.assigned_agent_id, null);
  assert.equal((await api('GET', review, undefined, 'agent')).statusCode, 404);
  assert.equal((await api('GET', review)).json().current.controller_type, 'NONE');
  assert.equal((await api('GET', queue)).json().items[0].lead_id, lead); assert.deepEqual((await api('GET', queue, undefined, 'agent')).json().items, []);
  const waiting = (await db`SELECT version FROM conversation WHERE id=${cv}`)[0]!.version;
  await db`UPDATE branch SET active=false WHERE id=${branch}`;
  assert.equal((await api('POST', '/api/conversations/' + cv + '/takeover', { version: waiting, reason: 'Disabled Branch acceptance' })).statusCode, 409); await db`UPDATE branch SET active=true WHERE id=${branch}`;
  assert.equal((await api('POST', '/api/conversations/' + cv + '/takeover', { version: waiting, reason: 'Manager accepts attention' })).statusCode, 200);
  assert.equal((await db`SELECT state FROM ai_customer_handoff_action WHERE proposal_id=${unassigned.id}`)[0]!.state, 'APPLIED');
  // Handoff review uses current Field visibility and masks aggregate missing/completion information.
  const questionId = randomUUID(), currentQC = (await api('GET', '/api/ai/campaigns/' + campaign + '/qualification')).json();
  assert.equal((await api('PUT', '/api/ai/campaigns/' + campaign + '/qualification', { version: currentQC.version,
    definition: { ...emptyQualification(), enabled: true, questions: [{ id: questionId, prompt: 'Restricted interest?', fieldId: field, required: true }] }, reason: 'Current review Field access' })).statusCode, 200);
  await db`INSERT INTO lead_field_value(lead_id,field_id,value,source,updated_by) VALUES(${lead},${field},'true','MANUAL',${users.manager!.id})`;
  await db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
  assert.equal((await api('GET', review, undefined, 'agent')).json().qualification.questions[0].value, true);
  await db`UPDATE campaign_field SET visible_to_agent=false,editable_by_agent=false,version=version+1 WHERE campaign_id=${campaign} AND field_id=${field}`;
  const hidden = (await api('GET', review, undefined, 'agent')).json().qualification;
  assert.deepEqual(hidden.questions, []); assert.equal(hidden.result, null); assert.deepEqual(hidden.blockers, ['QUALIFICATION_RESTRICTED']);
  assert.equal((await api('GET', review)).json().qualification.questions[0].value, true);
  // An already-issued request cannot acquire fresh authority from an old action receipt.
  await activate(); await assert.rejects(db`UPDATE conversation SET state='WAITING_FOR_HUMAN',controller_type='NONE',controller_user_id=NULL,
    needs_attention_reason='AI_HUMAN_HANDOFF_REQUESTED',version=version+1,ai_handoff_action_id=${action.id} WHERE id=${cv}`, /TRANSITION_PROOF_REQUIRED/);
  const paged = (await api('GET', review + '?limit=1')).json(); assert.equal(paged.items.length, 1); assert.ok(paged.nextCursor); const older = (await api('GET', review + '?limit=1&cursor=' + encodeURIComponent(paged.nextCursor))).json(); assert.notEqual(older.items[0].id, paged.items[0].id);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message WHERE direction='OUTBOUND'`)[0]!.n, 0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_record`)[0]!.n, 0); assert.equal(fetchCalls, 0);
});
