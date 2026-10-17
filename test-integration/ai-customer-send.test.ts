import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/security.js';
import { sealSecret } from '../src/credentials.js';
import { emptyKnowledge } from '../src/ai/knowledge.js';
import { emptyQualification } from '../src/ai/qualification.js';
import { emptyAIOperationalConfig } from '../src/ai/operational-config.js';
import { emptyAIBehaviorPolicy } from '../src/ai/behavior-policy.js';
import { processOneInboundEvent } from '../src/messaging/inbound-events.js';
import { processOneAICustomerProposal } from '../src/ai/customer-worker.js';
import { enqueueAICustomerReply, processOneAICustomerSend } from '../src/ai/customer-send.js';
import { processOneMessagingJob } from '../src/messaging/send-worker.js';
import { metaWhatsAppSendAdapter, ProviderSendError, type MessagingSendAdapter } from '../src/messaging/providers.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Authenticated AI replies preserve native content/action/outbox proof, current dispatch policy, bounded local failures and safe unknown outcomes', async t => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173'; process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const db = createDatabase(url), app = await buildApp(db, { logger: false, globalRateLimitMax: 10000,
    aiConnectionAdapters: { OPENAI: { listModels: async () => ['synthetic-send-model'] } } });
  const savedFetch = globalThis.fetch; let calls = 0, mode = 'ACK', observedBody = '';
  globalThis.fetch = async (input, options) => {
    assert.equal(String(input), 'https://graph.facebook.com/v25.0/15550001111/messages'); calls++;
    const payload = JSON.parse(String(options?.body)); assert.equal(payload.to, '15557770000'); assert.equal(payload.type, 'text');
    observedBody = payload.text.body;
    if (mode === 'UNKNOWN') throw Error('Synthetic transport loss');
    return new Response(JSON.stringify({ messages: [{ id: 'synthetic-ai-out-' + randomUUID() }] }), { status: 200 });
  };
  t.after(async () => { globalThis.fetch = savedFetch; await app.close(); await db.end(); });
  await db.begin(async tx => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
  const org = (await db`INSERT INTO organization(name) VALUES('AI send synthetic') RETURNING id`)[0]!.id,
    branch = (await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,
    campaign = (await db`INSERT INTO campaign(organization_id,branch_id,name,status,messaging_config) VALUES(${org},${branch},'A','ACTIVE','{"enabled":true}') RETURNING id`)[0]!.id;
  const users: Record<string, { id: string; cookie: string }> = {};
  for (const [name, role] of [['manager','MANAGER'],['agent','AGENT'],['second','AGENT']] as const) {
    const id = (await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES(${org},${branch},${name},${role},${name + '@send.test'},'synthetic-only') RETURNING id`)[0]!.id, token = randomBytes(32).toString('hex');
    await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},clock_timestamp()+interval '1 hour')`;
    users[name] = { id, cookie: 'lop_session=' + token };
  }
  const contact = (await db`INSERT INTO contact(organization_id,name,phone_normalized) VALUES(${org},'Synthetic Customer','+15557770000') RETURNING id`)[0]!.id,
    lead = (await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,assigned_agent_id,source_kind) VALUES(${org},${branch},${campaign},${contact},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id,
    mc = (await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config) VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic','CONNECTED','{"wabaId":"123456789","graphVersion":"v25.0"}') RETURNING id`)[0]!.id,
    sender = (await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities) VALUES(${org},${mc},'15550001111','Synthetic','HEALTHY',true,'{"text":true}') RETURNING id`)[0]!.id;
  await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
  const sealed = sealSecret(mc, JSON.stringify({ appSecret: 'synthetic-send-hmac', accessToken: 'synthetic-messaging-only', verifyToken: 'synthetic-verify-only' }));
  await db`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag) VALUES(${mc},${sealed.ciphertext},${sealed.nonce},${sealed.authTag})`;
  const cv = (await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state) VALUES(${lead},${mc},${sender},'WHATSAPP','+15557770000','AI','AI_ACTIVE') RETURNING id`)[0]!.id;
  const api = (method: 'GET'|'PUT'|'POST', path: string, payload?: object, who = 'manager') => app.inject({ method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, cookie: users[who]!.cookie } });
  const kr = '/api/ai/campaigns/' + campaign + '/knowledge', root = '/api/conversations/' + cv + '/ai-customer-executions';
  const published = { ...emptyKnowledge(), sections: { ...emptyKnowledge().sections, prices: 'Approved price 100 EUR <img src=x onerror=alert(1)>' } };
  assert.equal((await api('PUT', kr + '/draft', { version: 0, content: published, reason: 'Synthetic approved knowledge' })).statusCode, 200);
  assert.equal((await api('POST', kr + '/publish', { version: 1, requestId: randomUUID(), reason: 'Synthetic publication' })).statusCode, 201);
  const ac = await api('POST', '/api/ai/connections', { name: 'Synthetic AI', branchId: branch, provider: 'OPENAI', credential: 'synthetic-only-ai', reason: 'Synthetic dedicated fixture' }); assert.equal(ac.statusCode, 201, ac.body);
  assert.equal((await api('POST', '/api/ai/connections/' + ac.json().id + '/test', { version: 1 })).statusCode, 200);
  const profile = await api('POST', '/api/ai/profiles', { connectionId: ac.json().id, name: 'Conversation', task: 'CONVERSATION', modelId: 'synthetic-send-model', maxOutputTokens: 1024, active: true, reason: 'Synthetic profile' }); assert.equal(profile.statusCode, 201, profile.body);
  assert.equal((await api('PUT', '/api/ai/campaigns/' + campaign + '/configuration', { version: 0, definition: { ...emptyAIOperationalConfig(), profiles: { ...emptyAIOperationalConfig().profiles, CONVERSATION: profile.json().id } }, reason: 'Synthetic send context' })).statusCode, 200);
  const question = randomUUID();
  assert.equal((await api('PUT', '/api/ai/campaigns/' + campaign + '/qualification', { version: 0, definition: { ...emptyQualification(), enabled: true, questions: [{ id: question, prompt: 'Approved availability question?', fieldId: null, required: true }] }, reason: 'Synthetic question scope' })).statusCode, 200);
  const consent = async (status: 'UNKNOWN'|'GRANTED'|'REVOKED') => {
    const path = '/api/leads/' + lead + '/messaging-consent', v = (await api('GET', path)).json().version;
    assert.equal((await api('PUT', path, { version: v, status, doNotContact: false, evidence: status === 'GRANTED' ? 'Synthetic explicit evidence' : null, source: 'Synthetic fixture' })).statusCode, 200);
  };
  const tools = '/api/ai/campaigns/' + campaign + '/tool-policy';
  assert.equal((await api('PUT', tools, { version: 0, definition: { allowedTools: ['sendConversationMessage'] }, reason: 'Explicit send approval' })).statusCode, 200);
  await db`UPDATE campaign SET ai_config='{"enabled":true}' WHERE id=${campaign}`; // Synthetic fixture; no product activation.
  const receive = async (id: string) => {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '123456789', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '15550001111' }, messages: [{ id, from: '15557770000', timestamp: String(Math.floor(Date.now()/1000)), type: 'text', text: { body: 'What is the approved price?' } }] } }] }] });
    return app.inject({ method: 'POST', url: '/api/webhooks/messaging/meta/' + mc, payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'synthetic-send-hmac').update(payload).digest('hex') } });
  };
  const activate = () => db`UPDATE conversation SET controller_type='AI',controller_user_id=NULL,state='AI_ACTIVE',needs_attention_reason=NULL WHERE id=${cv}`;
  let decision = 'ANSWER';
  const adapters = { OPENAI: { simulate: async () => null, proposeCustomer: async () => ({ decision, referenceIds: decision === 'ANSWER' ? ['section:prices'] : [], questionId: decision === 'QUESTION' ? question : null, answerValue: null, sourceQuote: null, handoffReason: null }) } };
  const source = async () => { await activate(); const id = randomUUID(); assert.equal((await receive(id)).statusCode, 200); assert.equal(await processOneInboundEvent(db), true);
    const p = (await db`SELECT p.* FROM ai_customer_proposal p JOIN integration_event e ON e.id=p.event_id WHERE e.payload->'message'->>'id'=${id}`)[0]!;
    assert.ok(p); assert.equal(await processOneAICustomerProposal(db, { adapters }), true); assert.equal((await db`SELECT state FROM ai_customer_proposal WHERE id=${p.id}`)[0]!.state, 'PROPOSED'); return p; };
  const action = async (pid: string) => (await db`SELECT * FROM ai_customer_send_action WHERE proposal_id=${pid}`)[0]!;
  const msg = async (id: string) => (await db`SELECT * FROM conversation_message WHERE id=${id}`)[0]!;
  const dispatch = (adapter: MessagingSendAdapter = { ...metaWhatsAppSendAdapter }) => processOneMessagingJob(db, adapter, { syntheticAI: true });
  await consent('UNKNOWN'); const noConsent = await source(); assert.equal(await processOneAICustomerSend(db), true);
  assert.equal((await action(noConsent.id)).state, 'BLOCKED'); assert.equal((await action(noConsent.id)).error_code, 'CONSENT_REQUIRED'); assert.equal(calls, 0);
  assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_HANDOFF_REQUIRED');
  await consent('GRANTED'); const first = await source();
  // Independently forged content and an omitted outbox fail natively and leave the original Job usable.
  for (const forged of [true, false]) await assert.rejects(db.begin(async tx => {
    const id = randomUUID(), mid = randomUUID(), content = (await tx`SELECT ai_customer_send_content(${first.id}) AS content`)[0]!.content;
    await tx`INSERT INTO ai_customer_send_action(id,proposal_id,lead_id,campaign_id,conversation_id,state,message_id,context,content)
      VALUES(${id},${first.id},${lead},${campaign},${cv},'APPLIED',${mid},${tx.json(first.context)},${tx.json(content)})`;
    await tx`INSERT INTO conversation_message(id,conversation_id,connection_id,sender_id,direction,author_type,body,delivery_state,idempotency_key,ai_send_action_id)
      VALUES(${mid},${cv},${mc},${sender},'OUTBOUND','AI',${forged ? 'Invented unsupported claim' : content.body},'QUEUED',${id},${id})`;
  }), forged ? /FRESH_MESSAGE_PROOF_REQUIRED/ : /ATOMIC_OUTBOX_REQUIRED/);
  await assert.rejects(db.begin(async tx => {
    await enqueueAICustomerReply(tx, first.id);
    await tx`UPDATE lead SET version=version+1 WHERE id=${lead}`;
  }), /ATOMIC_OUTBOX_REQUIRED/); // Own Message is the only permitted delta, not arbitrary writes in the same transaction.
  assert.equal(await action(first.id), undefined);
  const eight = await Promise.all(Array.from({ length: 8 }, () => processOneAICustomerSend(db))); assert.equal(eight.filter(Boolean).length, 1);
  const firstAction = await action(first.id), firstMessage = await msg(firstAction.message_id);
  assert.equal(firstAction.state, 'APPLIED'); assert.equal(firstMessage.body, published.sections.prices); assert.equal(firstMessage.author_user_id, null); assert.equal(firstMessage.delivery_state, 'QUEUED');
  assert.equal((await db.begin(tx => enqueueAICustomerReply(tx, first.id))).duplicate, true);
  assert.equal((await db`SELECT ai_customer_send_admission_context(${first.id}) AS ctx`)[0]!.ctx, null);
  assert.ok((await db`SELECT ai_customer_send_dispatch_context(${firstAction.id}) AS ctx`)[0]!.ctx);
  await assert.rejects(db`UPDATE ai_customer_send_action SET content='{}' WHERE id=${firstAction.id}`, /IMMUTABLE/);
  await assert.rejects(db`UPDATE conversation_message SET ai_send_action_id=NULL WHERE id=${firstMessage.id}`, /PROOF_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM outbound_delivery_job WHERE message_id=${firstMessage.id}`, /OUTBOX_IMMUTABLE/);
  await assert.rejects(db`INSERT INTO conversation_message(conversation_id,connection_id,sender_id,direction,author_type,body,delivery_state) VALUES(${cv},${mc},${sender},'OUTBOUND','AI','Forged','QUEUED')`, /FRESH_MESSAGE_PROOF_REQUIRED/);
  assert.equal(await dispatch(), true); assert.equal(calls, 1); assert.equal(observedBody, published.sections.prices); assert.equal((await msg(firstMessage.id)).delivery_state, 'SENT');
  assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_WAITING_FOR_LEAD'); assert.equal(await dispatch(), false);
  const history = (await api('GET', root, undefined, 'agent')).json().items.find((r: any) => r.id === first.id);
  assert.deepEqual(history.toolsExecuted, ['sendConversationMessage']); assert.equal(history.action.deliveryState, 'SENT'); assert.equal(history.action.messageId, firstMessage.id); assert.equal(history.context, undefined);
  assert.equal((await api('GET', root, undefined, 'second')).statusCode, 404);
  // A claimant blocked on parents cannot dispatch after its lease loses the HTTP safety margin.
  const fenced = await source(); await processOneAICustomerSend(db); const fencedAction = await action(fenced.id);
  const fencedJob = (await db`SELECT job_id FROM outbound_delivery_job WHERE message_id=${fencedAction.message_id}`)[0]!.job_id;
  await assert.rejects(db`INSERT INTO outbound_send_attempt(message_id,job_id,attempt_number,state) VALUES(${fencedAction.message_id},${fencedJob},1,'PREPARED')`, /CURRENT_DISPATCH_LEASE_REQUIRED/);
  let unlock!: () => void, entered!: () => void;
  const release = new Promise<void>(r => { unlock = r; }), ready = new Promise<void>(r => { entered = r; });
  const blocker = db.begin(async tx => { await tx`SELECT id FROM branch WHERE id=${branch} FOR UPDATE`; entered(); await release; });
  await ready; let unsafeCalls = 0;
  const staleWorker = dispatch({ sendText: async () => { unsafeCalls++; return { providerMessageId: 'must-not-dispatch' }; } });
  try {
    let claimed = false;
    for (let i = 0; i < 100; i++) { if ((await db`SELECT status FROM background_job WHERE id=${fencedJob}`)[0]!.status === 'RUNNING') { claimed = true; break; } await new Promise(r => setTimeout(r, 10)); }
    assert.equal(claimed, true);
    await db`UPDATE background_job SET locked_until=clock_timestamp()+interval '5 seconds' WHERE id=${fencedJob}`;
    await db`UPDATE sender_outbound_lease SET locked_until=clock_timestamp()+interval '5 seconds' WHERE job_id=${fencedJob}`;
  } finally { unlock(); await blocker; }
  await staleWorker; assert.equal(unsafeCalls, 0); assert.equal((await msg(fencedAction.message_id)).last_error_code, 'AI_SEND_DISPATCH_LEASE_EXPIRED');
  assert.equal((await db`SELECT count(*)::int AS n FROM outbound_send_attempt WHERE message_id=${fencedAction.message_id}`)[0]!.n, 0);
  // Configured disclosure is derived by the application, never generated by the model.
  const behaviorPath = '/api/ai/campaigns/' + campaign + '/behavior-policy';
  const behavior = (await api('GET', behaviorPath)).json();
  assert.equal((await api('PUT', behaviorPath, { version: behavior.version, definition: { ...emptyAIBehaviorPolicy(), disclosure: { mode: 'EVERY_AI_MESSAGE', text: 'Synthetic configured AI identity' } }, reason: 'Synthetic disclosure' })).statusCode, 200);
  decision = 'QUESTION'; const q = await source(); await processOneAICustomerSend(db); const qa = await action(q.id); assert.equal((await msg(qa.message_id)).body, 'Synthetic configured AI identity\n\nApproved availability question?'); await dispatch();
  // A new Customer message invalidates the queued reply, rather than permitting a reply to the old source.
  decision = 'ANSWER'; const outdated = await source(); await processOneAICustomerSend(db); const oldAction = await action(outdated.id);
  assert.equal((await receive(randomUUID())).statusCode, 200); await processOneInboundEvent(db);
  const before = calls; await dispatch(); assert.equal(calls, before); assert.equal((await msg(oldAction.message_id)).delivery_state, 'FAILED');
  assert.equal((await msg(oldAction.message_id)).last_error_code, 'AI_SEND_DISPATCH_CONTEXT_CHANGED');
  // Drain the new proposal without granting an action, then prove revocation before dispatch.
  await processOneAICustomerProposal(db); await consent('GRANTED'); const revoke = await source(); await processOneAICustomerSend(db); const revokeAction = await action(revoke.id);
  await consent('REVOKED'); await dispatch(); assert.equal(calls, before); assert.equal((await msg(revokeAction.message_id)).delivery_state, 'FAILED'); await consent('GRANTED');
  const human = await source(); await processOneAICustomerSend(db); const humanAction = await action(human.id), v = (await db`SELECT version FROM conversation WHERE id=${cv}`)[0]!.version;
  assert.equal((await api('POST', '/api/conversations/' + cv + '/takeover', { version: v, reason: 'Synthetic Human takeover' }, 'agent')).statusCode, 200);
  await dispatch(); assert.equal(calls, before); assert.equal((await msg(humanAction.message_id)).delivery_state, 'FAILED'); assert.equal((await db`SELECT controller_type FROM conversation WHERE id=${cv}`)[0]!.controller_type, 'HUMAN');
  const inflight = await source(); await processOneAICustomerSend(db); const inflightAction = await action(inflight.id);
  await dispatch({ sendText: async () => {
    const currentVersion = (await db`SELECT version FROM conversation WHERE id=${cv}`)[0]!.version;
    assert.equal((await api('POST', '/api/conversations/' + cv + '/takeover', { version: currentVersion, reason: 'Human takeover during provider response' }, 'agent')).statusCode, 200);
    return { providerMessageId: 'synthetic-inflight-' + randomUUID() };
  } });
  assert.equal((await msg(inflightAction.message_id)).delivery_state, 'SENT');
  assert.equal((await db`SELECT controller_type FROM conversation WHERE id=${cv}`)[0]!.controller_type, 'HUMAN');
  // A known safe rejection retries the same immutable message; an ambiguous write never replays.
  const retry = await source(); await processOneAICustomerSend(db); const retryAction = await action(retry.id);
  await dispatch({ sendText: async () => { throw new ProviderSendError('RETRYABLE', 'PROVIDER_RATE_LIMITED', 1); } });
  assert.equal((await msg(retryAction.message_id)).delivery_state, 'QUEUED');
  await db`UPDATE integration_connection SET cooldown_until=NULL WHERE id=${mc}`; await db`UPDATE messaging_sender SET cooldown_until=NULL WHERE id=${sender}`;
  await db`UPDATE background_job SET run_after=clock_timestamp()-interval '1 second' WHERE id=(SELECT job_id FROM outbound_delivery_job WHERE message_id=${retryAction.message_id})`;
  await dispatch(); assert.equal((await msg(retryAction.message_id)).delivery_state, 'SENT');
  const unknown = await source(); await processOneAICustomerSend(db); const unknownAction = await action(unknown.id); mode = 'UNKNOWN'; await dispatch();
  assert.equal((await msg(unknownAction.message_id)).delivery_state, 'UNKNOWN'); const unknownCalls = calls;
  assert.equal((await receive(randomUUID())).statusCode, 200); assert.equal(await processOneInboundEvent(db), true);
  const heldAttention = (await db`SELECT needs_attention_reason,state FROM conversation WHERE id=${cv}`)[0]!;
  assert.equal(heldAttention.needs_attention_reason, 'SEND_OUTCOME_UNKNOWN'); assert.equal(heldAttention.state, 'AI_HANDOFF_REQUIRED');
  for (let i = 0; i < 3; i++) assert.equal(await dispatch(), false); assert.equal(calls, unknownCalls);
  assert.equal((await db.begin(tx => enqueueAICustomerReply(tx, unknown.id))).duplicate, true);
  // Repair only the synthetic Connection for a new episode. The uncertain historical intent stays terminal.
  await db`UPDATE integration_connection SET status='CONNECTED',version=version+1 WHERE id=${mc}`;
  assert.equal((await msg(unknownAction.message_id)).delivery_state, 'UNKNOWN'); assert.equal(await dispatch(), false);
  // Default transport remains off before decryption, even with a valid queued Action and synthetic credentials.
  mode = 'ACK'; const off = await source(); await processOneAICustomerSend(db); const offAction = await action(off.id), key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = 'not-a-key'; try { assert.equal(await processOneMessagingJob(db), true); } finally { process.env.CREDENTIAL_ENCRYPTION_KEY = key; }
  assert.equal((await msg(offAction.message_id)).last_error_code, 'AI_LIVE_DATA_TRANSFER_DISABLED'); assert.equal(calls, unknownCalls);
  await assert.rejects(processOneMessagingJob(db, metaWhatsAppSendAdapter, { syntheticAI: true }), /EXPLICIT_TEST_ADAPTER_REQUIRED/);
  const nodeEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'production'; try { await assert.rejects(dispatch(), /ISOLATED_DATABASE/); } finally { if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv; }
  // No partial Message, job or action may survive Audit failure. Bounded local retry uses the same source.
  const atomic = await source();
  const beforeAtomic = (await db`SELECT (SELECT count(*)::int FROM conversation_message) AS messages,(SELECT count(*)::int FROM background_job) AS jobs`)[0]!;
  await db`CREATE FUNCTION reject_ai_send_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_CUSTOMER_SEND_QUEUED' THEN RAISE EXCEPTION 'SyntheticSendAuditFailure';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER reject_ai_send_audit_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_ai_send_audit_fixture()`;
  try { assert.equal(await processOneAICustomerSend(db), true); assert.equal(await action(atomic.id), undefined);
    assert.equal((await db`SELECT failure_count FROM ai_local_action_queue WHERE kind='SEND' AND proposal_id=${atomic.id}`)[0]!.failure_count, 1);
    const afterAtomic = (await db`SELECT (SELECT count(*)::int FROM conversation_message) AS messages,(SELECT count(*)::int FROM background_job) AS jobs`)[0]!;
    assert.deepEqual(afterAtomic, beforeAtomic);
  } finally { await db`DROP TRIGGER reject_ai_send_audit_fixture ON audit_log`; await db`DROP FUNCTION reject_ai_send_audit_fixture()`; }
  const queue = (await api('GET', '/api/conversations/' + cv + '/ai-action-jobs')).json().items.find((r: any) => r.proposalId === atomic.id); assert.equal(queue.kind, 'SEND'); assert.equal(queue.canRetry, true);
  assert.equal((await api('POST', '/api/conversations/' + cv + '/ai-action-jobs/' + queue.id + '/retry', { version: queue.version, reason: 'Synthetic repair completed' })).statusCode, 200);
  assert.equal(await processOneAICustomerSend(db), true); assert.equal((await action(atomic.id)).state, 'APPLIED'); await dispatch();
  assert.equal((await db`SELECT count(*)::int AS n FROM payment_record`)[0]!.n, 0);
  assert.equal((await db`SELECT count(*)::int AS n FROM enrollment`)[0]!.n, 0);
  assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${lead}`)[0]!.assigned_agent_id, users.agent!.id);
});
