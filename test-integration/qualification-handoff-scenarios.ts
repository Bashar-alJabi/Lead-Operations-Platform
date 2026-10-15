import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { emptyQualification, evaluateQualification, type QualificationDefinition } from '../src/ai/qualification.js';
import { processOneAICustomerProposal } from '../src/ai/customer-worker.js';
import { collectAIQualificationAnswer, processOneAIQualificationAction } from '../src/ai/customer-qualification.js';
import { requestAIHumanHandoff, processOneAIHumanHandoff } from '../src/ai/customer-handoff.js';
import type { AIInferenceRegistry } from '../src/ai/inference-provider.js';

export async function verifyQualificationHandoff(db: Database, app: FastifyInstance, f: {
  branch: string; campaign: string; lead: string; cv: string; field: string; question: string; sender: string;
  users: Record<string, { id: string; session: string; cookie: string }>;
  inbound: (id: string, body?: string) => Promise<any>; activate: () => Promise<unknown>;
}) {
  const { branch, campaign, lead, cv, field, question, sender, users } = f;
  const api = (method: 'GET' | 'PUT', path: string, body?: Record<string, unknown>, who = 'manager') => app.inject({ method, url: path, payload: body,
    headers: { cookie: users[who]!.cookie, origin: 'http://127.0.0.1:5173' } });
  const root = '/api/ai/campaigns/' + campaign, original = (await api('GET', root + '/qualification')).json().definition;
  const definition: QualificationDefinition = { ...emptyQualification(), enabled: true,
    questions: [{ id: question, prompt: 'Interest?', fieldId: field, required: true }], handoff: { onCompletion: true, match: 'ALL', conditions: [] } };
  const config = async (d = definition) => { const current = (await api('GET', root + '/qualification')).json();
    const r = await api('PUT', root + '/qualification', { version: current.version, definition: d, reason: 'Trusted qualification handoff test policy' }); assert.equal(r.statusCode, 200, r.body); };
  const tools = async (names = ['updateQualificationField', 'requestHumanHandoff']) => { const current = (await api('GET', root + '/tool-policy')).json();
    const r = await api('PUT', root + '/tool-policy', { version: current.version, definition: { allowedTools: names }, reason: 'Explicit scoped child action approval' }); assert.equal(r.statusCode, 200, r.body); };
  const registry = (value: unknown = true, qid = question): AIInferenceRegistry => ({ OPENAI: { simulate: async () => null, proposeCustomer: async () => ({
    decision: 'QUALIFICATION', referenceIds: [], questionId: qid, answerValue: value, sourceQuote: 'Current answer', handoffReason: null,
  }) } });
  const pending = async (value: unknown = true, qid = question) => {
    await f.activate(); const p = await f.inbound(randomUUID(), 'Current answer');
    assert.equal(await processOneAICustomerProposal(db, { adapters: registry(value, qid) }), true); return p;
  };
  const qualified = async (value: unknown = true, qid = question) => { const p = await pending(value, qid);
    assert.equal(await processOneAIQualificationAction(db), true); return p; };
  const countSource = async (pid: string) => (await db`SELECT count(*)::integer AS n FROM ai_qualification_handoff_source WHERE proposal_id=${pid}`)[0]!.n;
  await config(); await tools();
  // Native completion is identical to the shared Application rules, including false/zero/empty/ALL/ANY and non-vacuous required questions.
  const free = randomUUID(), base: QualificationDefinition = { ...definition, questions: [...definition.questions, { id: free, prompt: 'Detail?', fieldId: null, required: false }] };
  for (const d of [base, { ...base, completion: { mode: 'CONDITIONS' as const, match: 'ANY' as const, conditions: [{ questionId: question, operator: 'EQUALS' as const, value: false }, { questionId: free, operator: 'ANSWERED' as const, value: null }] } },
    { ...base, handoff: { onCompletion: false, match: 'ALL' as const, conditions: [{ questionId: free, operator: 'EQUALS' as const, value: 'human' }] } }, emptyQualification()]) {
    for (const answers of [{}, { [question]: false }, { [question]: 0 }, { [question]: '' }, { [question]: [] }, { [free]: 'human' }, { [question]: true, [free]: 'human' }]) {
      const { previewOnly: _, ...expected } = evaluateQualification(d, answers);
      assert.deepEqual((await db`SELECT ai_qualification_outcome(${db.json(d)},${db.json(answers)}) AS outcome`)[0]!.outcome, expected);
    }
  }
  const p = await qualified(), source = (await db`SELECT * FROM ai_qualification_handoff_source WHERE proposal_id=${p.id}`)[0]!;
  assert.ok(source); assert.equal(source.outcome.complete, true); assert.equal(source.outcome.handoff, true);
  assert.notDeepEqual(source.context, p.context); assert.equal((await db`SELECT ai_customer_action_context(${p.id}) AS context`)[0]!.context, null);
  assert.deepEqual((await db`SELECT ai_customer_handoff_context(${p.id}) AS context`)[0]!.context, source.context);
  const workers = await Promise.all(Array.from({ length: 8 }, () => processOneAIHumanHandoff(db))); assert.equal(workers.filter(Boolean).length, 1);
  const handoff = (await db`SELECT * FROM ai_customer_handoff_action WHERE proposal_id=${p.id}`)[0]!;
  assert.equal(handoff.state, 'APPLIED'); assert.equal(handoff.handoff_reason, 'QUALIFICATION'); assert.equal(handoff.qualification_action_id, source.qualification_action_id);
  assert.equal((await db`SELECT controller_type FROM conversation WHERE id=${cv}`)[0]!.controller_type, 'NONE');
  assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${lead}`)[0]!.assigned_agent_id, users.agent!.id);
  assert.equal((await db`SELECT count(*)::integer AS n FROM notification_event WHERE source_id=${handoff.id}`)[0]!.n, 1);
  assert.equal((await db`SELECT count(*)::integer AS n FROM ai_handoff_sla_timer WHERE action_id=${handoff.id}`)[0]!.n, 1);
  assert.equal((await db.begin(tx => requestAIHumanHandoff(tx, p.id))).duplicate, true);
  const dto = (await api('GET', '/api/conversations/' + cv + '/ai-customer-executions', undefined, 'agent')).json().items.find((e: any) => e.id === p.id);
  assert.deepEqual(dto.toolsExecuted, ['updateQualificationField', 'requestHumanHandoff']); assert.equal(dto.actions.length, 2);
  assert.equal(dto.action.tool, 'updateQualificationField'); assert.equal(JSON.stringify(dto.actions).includes('context'), false);
  assert.equal((await api('GET', '/api/conversations/' + cv + '/ai-handoffs', undefined, 'agent')).json().items[0].qualification_action_id, source.qualification_action_id);
  for (const who of ['second', 'other', 'foreign']) assert.equal((await api('GET', '/api/conversations/' + cv + '/ai-handoffs', undefined, who)).statusCode, 404);
  await assert.rejects(db`UPDATE ai_qualification_handoff_source SET context='{}' WHERE proposal_id=${p.id}`, /IMMUTABLE/);
  await assert.rejects(db`DELETE FROM ai_qualification_handoff_source WHERE proposal_id=${p.id}`, /IMMUTABLE/);
  await assert.rejects(db`INSERT INTO ai_qualification_handoff_source(proposal_id,qualification_action_id,context,outcome)
    VALUES(${p.id},${source.qualification_action_id},${db.json(source.context)},${db.json(source.outcome)})`, /FRESH_WRITE_REQUIRED/);
  // Explicit grant absence never turns an answer or an older receipt into a Handoff source, even after a later grant.
  await tools(['updateQualificationField']); const denied = await qualified(); assert.equal(await countSource(denied.id), 0);
  await tools(); assert.equal(await processOneAIHumanHandoff(db), false); assert.equal(await countSource(denied.id), 0);
  // Campaign conditions are evaluated from trusted typed current values; false is an actual answer.
  await config({ ...definition, handoff: { onCompletion: false, match: 'ALL', conditions: [{ questionId: question, operator: 'EQUALS', value: false }] } });
  const noMatch = await qualified(true); assert.equal(await countSource(noMatch.id), 0);
  const condition = await qualified(false); assert.equal(await countSource(condition.id), 1); assert.equal(await processOneAIHumanHandoff(db), true);
  assert.equal((await db`SELECT value FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}`)[0]!.value, false);
  await config();
  // Every non-owned context delta still blocks the child. Persisted Qualification is not rolled back by a later denial.
  for (const [name, change, undo] of [
    ['owner', () => db`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`, () => db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`],
    ['policy', () => tools(['updateQualificationField']), () => tools()],
    ['configuration', () => config(), async () => {}],
    ['binding', () => db`UPDATE campaign_field SET version=version+1 WHERE campaign_id=${campaign} AND field_id=${field}`, async () => {}],
    ['branch', () => db`UPDATE branch SET active=false WHERE id=${branch}`, () => db`UPDATE branch SET active=true WHERE id=${branch}`],
    ['sender', () => db`UPDATE messaging_sender SET operator_enabled=false WHERE id=${sender}`, () => db`UPDATE messaging_sender SET operator_enabled=true WHERE id=${sender}`],
    ['field-value', () => db`UPDATE lead_field_value SET value='false',source='MANUAL',updated_by=${users.agent!.id},version=version+1 WHERE lead_id=${lead} AND field_id=${field}`, async () => {}],
    ['controller', () => db`UPDATE conversation SET controller_type='HUMAN',controller_user_id=${users.agent!.id},state='HUMAN_ACTIVE' WHERE id=${cv}`, async () => {}],
  ] as const) {
    const queued = await qualified(); assert.equal(await countSource(queued.id), 1); await change(); assert.equal(await processOneAIHumanHandoff(db), true, name);
    const blocked = (await db`SELECT state,error_code FROM ai_customer_handoff_action WHERE proposal_id=${queued.id}`)[0]!;
    assert.equal(blocked.state, 'BLOCKED', name); assert.equal(blocked.error_code, 'AI_HANDOFF_CONTEXT_CHANGED');
    assert.equal((await db`SELECT state FROM ai_customer_action WHERE proposal_id=${queued.id}`)[0]!.state, 'APPLIED'); await undo();
  }
  // A concurrent Owner edit commits while the queued worker waits for the parent fence.
  const raced = await qualified(); let enter!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { release = r; });
  const edit = db.begin(async tx => { await tx`SELECT id FROM branch WHERE id=${branch} FOR SHARE`; await tx`SELECT id FROM lead WHERE id=${lead} FOR UPDATE`;
    enter(); await held; await tx`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`; });
  await ready; const racingWorker = processOneAIHumanHandoff(db); release(); await edit; assert.equal(await racingWorker, true);
  assert.equal((await db`SELECT state FROM ai_customer_handoff_action WHERE proposal_id=${raced.id}`)[0]!.state, 'BLOCKED');
  await db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
  // A transition cannot consume a receipt after an unrelated write inside that same transaction.
  const fresh = await qualified(); const currentSource = (await db`SELECT context FROM ai_qualification_handoff_source WHERE proposal_id=${fresh.id}`)[0]!.context;
  await assert.rejects(db`INSERT INTO ai_customer_handoff_action(proposal_id,lead_id,campaign_id,conversation_id,state,context)
    VALUES(${fresh.id},${lead},${campaign},${cv},'APPLIED',${db.json(fresh.context)})`, /SOURCE_REQUIRED/);
  await assert.rejects(db.begin(async tx => {
    const a = (await tx`INSERT INTO ai_customer_handoff_action(proposal_id,lead_id,campaign_id,conversation_id,state,context)
      VALUES(${fresh.id},${lead},${campaign},${cv},'APPLIED',${tx.json(currentSource)}) RETURNING id`)[0]!;
    await tx`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`;
    await tx`UPDATE conversation SET ai_handoff_action_id=${a.id},state='WAITING_FOR_HUMAN',controller_type='NONE',controller_user_id=NULL,needs_attention_reason='AI_HUMAN_HANDOFF_REQUESTED',version=version+1 WHERE id=${cv}`;
  }), /TRANSITION_PROOF_REQUIRED/);
  // Audit failure preserves the queued child and already committed answer; restart/retry remains exactly once.
  await db`CREATE FUNCTION reject_qualification_handoff_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='AI_HUMAN_HANDOFF_APPLIED' THEN RAISE EXCEPTION 'synthetic child handoff audit failure';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER reject_qualification_handoff_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_qualification_handoff_audit()`;
  try { await assert.rejects(processOneAIHumanHandoff(db), /synthetic child handoff audit failure/);
    assert.equal((await db`SELECT state FROM ai_customer_handoff_job WHERE proposal_id=${fresh.id}`)[0]!.state, 'QUEUED');
    assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_handoff_action WHERE proposal_id=${fresh.id}`)[0]!.n, 0);
  } finally { await db`DROP TRIGGER reject_qualification_handoff_audit ON audit_log`; await db`DROP FUNCTION reject_qualification_handoff_audit()`; }
  assert.equal(await processOneAIHumanHandoff(db), true);
  // No caller can add an unrelated version delta while producing the source receipt.
  const atomic = await pending();
  await assert.rejects(db.begin(async tx => {
    await collectAIQualificationAnswer(tx, atomic.id);
    await tx`INSERT INTO ai_qualification_handoff_source(proposal_id,qualification_action_id,context,outcome)
      SELECT proposal_id,qualification_action_id,jsonb_set(context,'{lead,version}','999999'),outcome FROM ai_qualification_handoff_source WHERE proposal_id=${atomic.id}`;
  }), /EXACT_CONTEXT_REQUIRED/);
  assert.equal((await db`SELECT state FROM ai_customer_action_job WHERE proposal_id=${atomic.id}`)[0]!.state, 'QUEUED');
  assert.equal(await processOneAIQualificationAction(db), true); assert.equal(await processOneAIHumanHandoff(db), true);
  // Every mandatory provider decision follows the existing approved path; an explicit [] stops safely without bypassing tool permission.
  for (const reason of ['CUSTOMER_REQUEST','UNKNOWN_ANSWER','OUT_OF_SCOPE','COMPLAINT','SENSITIVE_SCENARIO','PRICING_EXCEPTION','LEGAL_EXCEPTION','PAYMENT_ISSUE','LOW_CONFIDENCE']) {
    await f.activate(); const event = await f.inbound(randomUUID(), 'Synthetic mandatory handoff');
    const adapters: AIInferenceRegistry = { OPENAI: { simulate: async () => null, proposeCustomer: async () => ({ decision: 'HANDOFF', referenceIds: [], questionId: null, answerValue: null, sourceQuote: null, handoffReason: reason }) } };
    assert.equal(await processOneAICustomerProposal(db, { adapters }), true); assert.equal(await processOneAIHumanHandoff(db), true);
    assert.equal((await db`SELECT handoff_reason FROM ai_customer_handoff_action WHERE proposal_id=${event.id}`)[0]!.handoff_reason, reason);
  }
  await tools([]); await f.activate(); const stopped = await f.inbound(randomUUID(), 'Unknown commercial fact');
  assert.equal(await processOneAICustomerProposal(db, { adapters: { OPENAI: { simulate: async () => null, proposeCustomer: async () => ({ decision: 'HANDOFF', referenceIds: [], questionId: null, answerValue: null, sourceQuote: null, handoffReason: 'UNKNOWN_ANSWER' }) } } }), true);
  assert.equal(await processOneAIHumanHandoff(db), false);
  assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_HANDOFF_REQUIRED'); assert.equal(await countSource(stopped.id), 0);
  await config(original); await tools(['updateQualificationField']); await f.activate();
}
