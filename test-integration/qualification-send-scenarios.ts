import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/db.js';
import { emptyQualification, type QualificationDefinition } from '../src/ai/qualification.js';
import { processOneAICustomerProposal } from '../src/ai/customer-worker.js';
import { collectAIQualificationAnswer, processOneAIQualificationAction } from '../src/ai/customer-qualification.js';
import { enqueueAICustomerReply, processOneAICustomerSend } from '../src/ai/customer-send.js';
import { processOneAIHumanHandoff } from '../src/ai/customer-handoff.js';

type API = (method: 'GET'|'PUT'|'POST', path: string, payload?: object, who?: string) => Promise<{ statusCode: number; body: string; json: () => any }>;
export async function verifyQualificationSend(db: Database, f: { api: API; branch: string; campaign: string; lead: string; cv: string; sender: string;
  agent: string; second: string; source: () => Promise<any>; dispatch: () => Promise<boolean> }) {
  const { api, branch, campaign, lead, cv, sender } = f, root = '/api/ai/campaigns/' + campaign;
  const fieldResponse = await api('POST', '/api/fields', { scope: 'CAMPAIGN', branchId: branch, campaignId: campaign, key: 'reply_interest', label: 'Synthetic private interest',
    fieldType: 'BOOLEAN', valueMode: 'MANUAL', options: [], validation: {} }); assert.equal(fieldResponse.statusCode, 201, fieldResponse.body);
  const field = fieldResponse.json().id;
  const binding = { active: true, position: 0, requiredStage: 'NONE', visibleToAgent: true, editableByAgent: true, visibleToManager: true, editableByManager: true,
    showInTable: false, showInDetails: true, filterable: false, usableByAutomation: false, usableByAi: true };
  const rebind = async (visible: boolean) => {
    const version = (await db`SELECT version FROM campaign_field WHERE campaign_id=${campaign} AND field_id=${field}`)[0]!.version;
    const r = await api('PUT', '/api/campaigns/' + campaign + '/fields/' + field, { ...binding, version, visibleToAgent: visible, editableByAgent: visible });
    assert.equal(r.statusCode, 200, r.body);
  };
  assert.equal((await api('PUT', '/api/campaigns/' + campaign + '/fields/' + field, binding)).statusCode, 200);
  const first = randomUUID(), next = randomUUID(), prompt = 'Next approved question <img src=x onerror=alert(1)>?';
  const definition: QualificationDefinition = { ...emptyQualification(), enabled: true, questions: [
    { id: first, fieldId: field, prompt: 'Interest?', required: true }, { id: next, fieldId: null, prompt, required: true }] };
  const config = async (d = definition) => { const v = (await api('GET', root + '/qualification')).json().version;
    const r = await api('PUT', root + '/qualification', { version: v, definition: d, reason: 'Trusted ordered continuation questions' }); assert.equal(r.statusCode, 200, r.body); };
  const tools = async (names = ['updateQualificationField','sendConversationMessage','requestHumanHandoff']) => { const v = (await api('GET', root + '/tool-policy')).json().version;
    const r = await api('PUT', root + '/tool-policy', { version: v, definition: { allowedTools: names }, reason: 'Explicit continuation tool policy' }); assert.equal(r.statusCode, 200, r.body); };
  const proposal = async (value: unknown = false, qid = first) => {
    // A real signed inbound is queued first. Only the synthetic inference adapter supplies this result.
    const p = await f.source();
    assert.equal(await processOneAICustomerProposal(db, { adapters: { OPENAI: { simulate: async () => null, proposeCustomer: async () => ({
      decision: 'QUALIFICATION', referenceIds: [], questionId: qid, answerValue: value, sourceQuote: 'What is the approved price?', handoffReason: null,
    }) } } }), true);
    return p;
  };
  const receipt = async (value: unknown = false, qid = first) => {
    const p = await proposal(value, qid); assert.equal(await processOneAIQualificationAction(db), true);
    assert.equal((await db`SELECT state FROM ai_customer_action WHERE proposal_id=${p.id}`)[0]?.state, 'APPLIED');
    return (await db`SELECT * FROM ai_customer_proposal WHERE id=${p.id}`)[0]!;
  };
  const child = async (pid: string) => (await db`SELECT * FROM ai_qualification_send_source WHERE proposal_id=${pid}`)[0];
  const action = async (pid: string) => (await db`SELECT * FROM ai_customer_send_action WHERE proposal_id=${pid}`)[0];
  await config(); await tools(['updateQualificationField']);
  const old = await receipt(); assert.equal(await child(old.id), undefined);
  await tools(); assert.equal(await processOneAICustomerSend(db), false);
  const oldAction = (await db`SELECT id FROM ai_customer_action WHERE proposal_id=${old.id}`)[0]!.id;
  await assert.rejects(db`INSERT INTO ai_qualification_send_source(proposal_id,qualification_action_id,context,outcome,question)
    VALUES(${old.id},${oldAction},${db.json(old.context)},'{}',${db.json(definition.questions[1]!)})`, /FRESH_WRITE_REQUIRED/);
  await assert.rejects(db`INSERT INTO ai_customer_send_job(proposal_id) VALUES(${old.id})`, /FRESH_RESULT_REQUIRED/);
  const p = await receipt(), s = (await child(p.id))!; assert.ok(s);
  assert.equal(s.outcome.complete, false); assert.equal(s.outcome.handoff, false); assert.equal(s.question.id, next);
  assert.deepEqual(s.context, (await db`SELECT ai_qualification_handoff_expected(${s.qualification_action_id}) AS ctx`)[0]!.ctx);
  assert.notDeepEqual(s.context, p.context); assert.equal(p.result.decision, 'QUALIFICATION');
  assert.equal((await db`SELECT ai_inbound_send_admission_context(${p.id}) AS ctx`)[0]!.ctx, null);
  assert.deepEqual((await db`SELECT ai_customer_send_admission_context(${p.id}) AS ctx`)[0]!.ctx, s.context);
  assert.equal((await db`SELECT ai_local_action_context_current(${p.id},'SEND') AS current`)[0]!.current, true);
  for (const command of [db`UPDATE ai_qualification_send_source SET context='{}' WHERE proposal_id=${p.id}`, db`DELETE FROM ai_qualification_send_source WHERE proposal_id=${p.id}`]) await assert.rejects(command, /IMMUTABLE/);
  await assert.rejects(db`INSERT INTO ai_qualification_send_source(proposal_id,qualification_action_id,context,outcome,question)
    VALUES(${p.id},${s.qualification_action_id},${db.json(s.context)},${db.json(s.outcome)},${db.json(s.question)})`, /FRESH_WRITE_REQUIRED/);
  await assert.rejects(db.begin(async tx => { await enqueueAICustomerReply(tx, p.id); await tx`UPDATE lead SET version=version+1 WHERE id=${lead}`; }), /ATOMIC_OUTBOX_REQUIRED/);
  assert.equal(await action(p.id), undefined);
  const workers = await Promise.all(Array.from({ length: 8 }, () => processOneAICustomerSend(db))); assert.equal(workers.filter(Boolean).length, 1);
  const sent = (await action(p.id))!; assert.equal(sent.state, 'APPLIED'); assert.equal(sent.qualification_action_id, s.qualification_action_id);
  assert.equal(sent.content.questionId, next); assert.equal(sent.content.decision, 'QUESTION'); assert.ok(sent.content.body.endsWith(prompt));
  assert.equal((await db.begin(tx => enqueueAICustomerReply(tx, p.id))).duplicate, true);
  assert.ok((await db`SELECT ai_customer_send_dispatch_context(${sent.id}) AS ctx`)[0]!.ctx);
  await f.dispatch(); assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${sent.message_id}`)[0]!.delivery_state, 'SENT');
  const dto = (await api('GET', '/api/conversations/' + cv + '/ai-customer-executions', undefined, 'agent')).json().items.find((e: any) => e.id === p.id);
  assert.deepEqual(dto.toolsExecuted, ['updateQualificationField','sendConversationMessage']); assert.equal(dto.proposal.decision, 'QUALIFICATION');
  assert.equal(dto.action.messageId, null); assert.equal(dto.action.deliveryState, null); assert.equal(dto.actions[1].messageId, sent.message_id);
  assert.equal(dto.actions[1].qualificationActionId, dto.action.id); assert.equal(dto.actions[1].deliveryState, 'SENT');
  assert.equal(JSON.stringify(dto).includes('answerValue'), false); assert.equal(JSON.stringify(dto).includes('question_snapshot'), false);
  assert.equal((await api('GET', '/api/conversations/' + cv + '/ai-customer-executions', undefined, 'second')).statusCode, 404);
  assert.equal((await db`SELECT detail->>'qualificationActionId' AS id FROM audit_log WHERE target_id=${sent.id} AND action='AI_CUSTOMER_SEND_QUEUED'`)[0]!.id, s.qualification_action_id);
  // Hidden Field values do not become multi-action metadata. The actual sent question remains customer history.
  await rebind(false);
  const hidden = (await api('GET', '/api/conversations/' + cv + '/ai-customer-executions', undefined, 'agent')).json();
  assert.equal(JSON.stringify(hidden).includes('Synthetic private interest'), false); assert.equal(JSON.stringify(hidden).includes('answerValue'), false);
  await rebind(true);
  // The child is created inside the answer's transaction. A later history failure rolls back all owned writes and queue admission.
  const atomic = await proposal(), beforeAtomic = (await db`SELECT
    (SELECT count(*)::int FROM ai_customer_action) AS actions,(SELECT count(*)::int FROM ai_qualification_send_source) AS sources,
    (SELECT count(*)::int FROM ai_customer_send_job) AS jobs,(SELECT count(*)::int FROM lead_qualification_answer_history) AS history,
    (SELECT version FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}) AS field_version`)[0]!;
  await db`CREATE FUNCTION reject_qualification_child_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SyntheticQualificationChildRollback';END $$`;
  await db`CREATE TRIGGER zz_reject_qualification_child_fixture AFTER INSERT ON lead_qualification_answer_history FOR EACH ROW EXECUTE FUNCTION reject_qualification_child_fixture()`;
  try { await assert.rejects(db.begin(tx => collectAIQualificationAnswer(tx, atomic.id)), /SyntheticQualificationChildRollback/); }
  finally { await db`DROP TRIGGER zz_reject_qualification_child_fixture ON lead_qualification_answer_history`; await db`DROP FUNCTION reject_qualification_child_fixture()`; }
  assert.deepEqual((await db`SELECT
    (SELECT count(*)::int FROM ai_customer_action) AS actions,(SELECT count(*)::int FROM ai_qualification_send_source) AS sources,
    (SELECT count(*)::int FROM ai_customer_send_job) AS jobs,(SELECT count(*)::int FROM lead_qualification_answer_history) AS history,
    (SELECT version FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}) AS field_version`)[0]!, beforeAtomic);
  assert.equal(await processOneAIQualificationAction(db), true); assert.ok(await child(atomic.id));
  await processOneAICustomerSend(db); await f.dispatch();
  // Only the one owned answer delta is tolerated. All other current changes block, without reverting the saved answer.
  for (const [name, change, undo] of [
    ['owner', () => db`UPDATE lead SET assigned_agent_id=${f.second},version=version+1 WHERE id=${lead}`, () => db`UPDATE lead SET assigned_agent_id=${f.agent},version=version+1 WHERE id=${lead}`],
    ['tool-revoke', () => tools(['updateQualificationField']), () => tools()],
    ['definition', () => config(), async () => {}],
    ['field-binding', () => db`UPDATE campaign_field SET version=version+1 WHERE campaign_id=${campaign} AND field_id=${field}`, async () => {}],
    ['sender', () => db`UPDATE messaging_sender SET operator_enabled=false WHERE id=${sender}`, () => db`UPDATE messaging_sender SET operator_enabled=true WHERE id=${sender}`],
    ['human', () => db`UPDATE conversation SET controller_type='HUMAN',controller_user_id=${f.agent},state='HUMAN_ACTIVE' WHERE id=${cv}`, async () => {}],
  ] as const) {
    const q = await receipt(); assert.ok(await child(q.id)); await change(); assert.equal(await processOneAICustomerSend(db), true, name);
    assert.equal((await action(q.id))!.state, 'BLOCKED', name); assert.equal((await action(q.id))!.message_id, null);
    const blockedDTO = (await api('GET', '/api/conversations/' + cv + '/ai-customer-executions')).json().items.find((e: any) => e.id === q.id);
    assert.equal(blockedDTO.action.errorCode, null); assert.equal(blockedDTO.action.messageId, null); assert.ok(blockedDTO.actions[1].errorCode);
    assert.equal((await db`SELECT state FROM ai_customer_action WHERE proposal_id=${q.id}`)[0]!.state, 'APPLIED'); await undo();
  }
  // Fresh enqueue followed by an unrelated typed Field edit before dispatch cannot use the old child.
  const stale = await receipt(); await processOneAICustomerSend(db); const staleAction = (await action(stale.id))!;
  await db`UPDATE lead_field_value SET value='true',source='MANUAL',updated_by=${f.agent},version=version+1 WHERE lead_id=${lead} AND field_id=${field}`;
  await f.dispatch(); assert.equal((await db`SELECT delivery_state,last_error_code FROM conversation_message WHERE id=${staleAction.message_id}`)[0]!.last_error_code, 'AI_SEND_DISPATCH_CONTEXT_CHANGED');
  // Actual concurrent parent edit is observed after the sender worker acquires its fence.
  const raced = await receipt(); let enter!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { release = r; });
  const edit = db.begin(async tx => { await tx`SELECT id FROM branch WHERE id=${branch} FOR SHARE`; await tx`SELECT id FROM lead WHERE id=${lead} FOR UPDATE`;
    enter(); await held; await tx`UPDATE lead SET assigned_agent_id=${f.second},version=version+1 WHERE id=${lead}`; });
  await ready; const worker = processOneAICustomerSend(db); release(); await edit; await worker;
  assert.equal((await action(raced.id))!.state, 'BLOCKED'); await db`UPDATE lead SET assigned_agent_id=${f.agent},version=version+1 WHERE id=${lead}`;
  // Handoff wins even if send is granted and handoff itself is not; no question can bypass the configured stop.
  await config({ ...definition, handoff: { onCompletion: false, match: 'ALL', conditions: [{ questionId: first, operator: 'ANSWERED', value: null }] } });
  await tools(['updateQualificationField','sendConversationMessage']); const priority = await receipt(); assert.equal(await child(priority.id), undefined);
  assert.equal(await processOneAICustomerSend(db), false);
  // Qualification completion with no Handoff does not generate an invented completion message or ask optional questions.
  await config({ ...definition, questions: [definition.questions[0]!, { ...definition.questions[1]!, required: false }] });
  const complete = await receipt(); assert.equal(await child(complete.id), undefined);
  // A new actual final answer creates the existing Handoff child, not a send child.
  await config({ ...definition, handoff: { onCompletion: true, match: 'ALL', conditions: [] } }); await tools();
  const final = await receipt('Confirmed availability', next); assert.equal(await child(final.id), undefined);
  assert.equal((await db`SELECT ai_local_action_context_current(${final.id},'HANDOFF') AS current`)[0]!.current, true);
  assert.equal(await processOneAIHumanHandoff(db), true);
  assert.equal((await db`SELECT state FROM ai_customer_handoff_action WHERE proposal_id=${final.id}`)[0]!.state, 'APPLIED');
  assert.equal(await processOneAICustomerSend(db), false);
  assert.equal((await db`SELECT result->>'decision' AS decision FROM ai_customer_proposal WHERE id=${p.id}`)[0]!.decision, 'QUALIFICATION');
}
