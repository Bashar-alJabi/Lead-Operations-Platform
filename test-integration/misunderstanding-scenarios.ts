import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import type { AIInferenceRegistry } from '../src/ai/inference-provider.js';
import { processOneAICustomerProposal } from '../src/ai/customer-worker.js';
import { processOneAIHumanHandoff } from '../src/ai/customer-handoff.js';
import { emptyAIBehaviorPolicy, evaluateAIBehaviorPolicy } from '../src/ai/behavior-policy.js';
import { validateCustomerProposal } from '../src/ai/customer-proposal.js';
import { processOneInboundEvent } from '../src/messaging/inbound-events.js';

export async function verifyMisunderstanding(db: Database, app: FastifyInstance, f: {
  org: string; branch: string; other: string; campaign: string; lead: string; cv: string;
  users: Record<string, { id: string; cookie: string }>; adapters: AIInferenceRegistry;
  activate: () => Promise<unknown>; grant: (allowed?: boolean) => Promise<unknown>;
  inbound: (id: string, body?: string) => Promise<any>;
  receive: (id: string, body?: string) => PromiseLike<{ statusCode: number }>;
}) {
  const { org, branch, campaign, lead, cv, users } = f, root = '/api/conversations/' + cv + '/ai-customer-executions';
  const api = (method: 'GET'|'POST'|'PUT', path: string, payload?: object, who = 'manager') => app.inject({ method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, cookie: users[who]!.cookie } });
  const saved = f.adapters.OPENAI!.proposeCustomer!;
  const proposal = (data: any) => ({ decision: 'HANDOFF', referenceIds: [], questionId: null, answerValue: null,
    sourceQuote: data.messages.find((m: any) => m.id === data.currentMessageId).text.slice(0, 500), handoffReason: 'REPEATED_MISUNDERSTANDING' });
  const run = (leaseSeconds = 60) => processOneAICustomerProposal(db, { adapters: f.adapters, leaseSeconds });
  const row = async (pid: string) => (await db`SELECT * FROM ai_misunderstanding_observation WHERE proposal_id=${pid}`)[0];
  // Explicit test-only activation starts a new current-version episode; product activation remains disabled.
  const episode = async () => { await f.activate(); await db`UPDATE conversation SET version=version+1 WHERE id=${cv}`; };
  const sourceBody = 'Repeated confusion <img src=x onerror="window.__misunderstanding=1">';
  const fresh = () => f.inbound(randomUUID(), sourceBody);
  const policy = async (scope: 'BRANCH'|'CAMPAIGN', limit: number | null, inherit = false) => {
    const path = scope === 'BRANCH' ? '/api/ai/branches/' + branch + '/behavior-defaults' : '/api/ai/campaigns/' + campaign + '/behavior-policy';
    const current = (await api('GET', path)).json();
    const definition = { ...emptyAIBehaviorPolicy(), handoff: inherit ? null : { initialContactWithoutAgent: false, transitionMessage: null, misunderstandingLimit: limit } };
    const r = await api('PUT', path, { version: current.version, definition, reason: 'Synthetic observed misunderstanding policy' }); assert.equal(r.statusCode, 200, r.body);
    return definition;
  };
  try {
    f.adapters.OPENAI!.proposeCustomer = async i => proposal(i.data);
    const definition = await policy('BRANCH', 3); await policy('CAMPAIGN', null, true); await f.grant(); await episode();
    const originalVersion = (await db`SELECT version FROM conversation WHERE id=${cv}`)[0]!.version;
    const sources: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const sourceId = randomUUID(), p = await f.inbound(sourceId, sourceBody); sources.push(p.id);
      if (n === 1) { for (const duplicate of await Promise.all(Array.from({ length: 8 }, () => f.receive(sourceId, sourceBody)))) assert.equal(duplicate.statusCode, 200); assert.equal(await processOneInboundEvent(db), false); }
      const results = await Promise.all(Array.from({ length: 8 }, () => run())); assert.equal(results.filter(Boolean).length, 1);
      const o = (await row(p.id))!; assert.equal(o.ordinal, String(n)); assert.equal(o.threshold, 3); assert.equal(o.handoff_required, n === 3); assert.equal(o.conversation_version, originalVersion);
      assert.equal(evaluateAIBehaviorPolicy(definition, { leadLifecycle: 'OPEN', controllerType: 'AI', conversationState: 'AI_ACTIVE', resolution: 'UNIQUE', explicitCampaignReference: false,
        requiredLeadData: false, disclosureAlreadySent: false, humanAvailable: true, trigger: 'REPEATED_MISUNDERSTANDING', misunderstandingCount: n, qualificationHandoffRequired: false }).handoff.reason === 'REPEATED_MISUNDERSTANDING', o.handoff_required);
      const dto = (await api('GET', root, undefined, 'agent')).json().items.find((e: any) => e.id === p.id);
      assert.deepEqual(dto.misunderstanding, { count: String(n), threshold: 3, handoffRequired: n === 3, conversationVersion: originalVersion });
      assert.equal(dto.misunderstanding.sourceQuote, undefined); assert.equal(dto.misunderstanding.context, undefined);
      assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_handoff_job WHERE proposal_id=${p.id}`)[0]!.n, n === 3 ? 1 : 0);
      if (n < 3) {
        assert.equal(await processOneAIHumanHandoff(db), false);
        await assert.rejects(db`INSERT INTO ai_customer_handoff_job(proposal_id) VALUES(${p.id})`, /JOB_SOURCE_REQUIRED/);
        assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_ACTIVE');
      }
    }
    const processed = await Promise.all(Array.from({ length: 8 }, () => processOneAIHumanHandoff(db))); assert.equal(processed.filter(Boolean).length, 1);
    assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'WAITING_FOR_HUMAN');
    const action = (await db`SELECT * FROM ai_customer_handoff_action WHERE proposal_id=${sources[2]!}`)[0]!;
    assert.equal(action.state, 'APPLIED'); assert.equal(action.handoff_reason, 'REPEATED_MISUNDERSTANDING');
    assert.equal((await db`SELECT count(*)::integer AS n FROM notification_event WHERE source_id=${action.id}`)[0]!.n, 1);
    assert.equal((await db`SELECT count(*)::integer AS n FROM ai_misunderstanding_observation WHERE conversation_id=${cv}`)[0]!.n, 3);
    await assert.rejects(db`INSERT INTO ai_misunderstanding_observation(proposal_id,ordinal,threshold,handoff_required) VALUES(${sources[0]!},999,1,true)`, /FRESH_SOURCE_REQUIRED/);
    await assert.rejects(db`UPDATE ai_misunderstanding_observation SET ordinal=999 WHERE proposal_id=${sources[0]!}`, /IMMUTABLE/);
    await assert.rejects(db`DELETE FROM ai_misunderstanding_observation WHERE proposal_id=${sources[0]!}`, /IMMUTABLE/);
    for (const who of ['second','other','foreign']) assert.equal((await api('GET', root, undefined, who)).statusCode, 404);
    // Scope transfer hides historical classification even from the same-Organization Super Admin.
    const transferredCampaign = (await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES(${org},${f.other},'Observation scope transfer','ACTIVE') RETURNING id`)[0]!.id;
    await db`UPDATE lead SET branch_id=${f.other},campaign_id=${transferredCampaign},assigned_agent_id=NULL,version=version+1 WHERE id=${lead}`;
    assert.equal((await api('GET', root)).statusCode, 404); assert.deepEqual((await api('GET', root, undefined, 'admin')).json().items, []);
    await db`UPDATE lead SET branch_id=${branch},campaign_id=${campaign},assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
    // New controller version starts at one. Campaign handoff object overrides the whole Branch object.
    await policy('CAMPAIGN', 2); await episode(); const next = await fresh(); await run(); assert.equal((await row(next.id))!.ordinal, '1'); assert.equal((await row(next.id))!.threshold, 2);
    assert.equal((await row(next.id))!.handoff_required, false);
    const threshold = await fresh(); await run(); assert.equal((await row(threshold.id))!.handoff_required, true);
    await policy('CAMPAIGN', 4); assert.equal(await processOneAIHumanHandoff(db), true);
    assert.equal((await db`SELECT state FROM ai_customer_handoff_action WHERE proposal_id=${threshold.id}`)[0]!.state, 'BLOCKED');
    assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_HANDOFF_REQUIRED');
    assert.equal((await row(threshold.id))!.threshold, 2); // Historical criterion is not rewritten after config changes.
    // Null limit preserves the existing preview's early Handoff behavior, without inventing a default count.
    await policy('CAMPAIGN', null); await episode(); const early = await fresh(); await run();
    assert.equal((await row(early.id))!.ordinal, '1'); assert.equal((await row(early.id))!.threshold, null); assert.equal((await row(early.id))!.handoff_required, true);
    assert.equal(await processOneAIHumanHandoff(db), true);
    // A newly approved tool cannot retroactively admit the original denied source.
    await f.grant(false); await episode(); const denied = await fresh(); await run(); assert.equal(await row(denied.id), undefined);
    assert.equal((await db`SELECT state FROM ai_customer_proposal WHERE id=${denied.id}`)[0]!.state, 'PROPOSED');
    await assert.rejects(db`INSERT INTO ai_misunderstanding_observation(proposal_id) VALUES(${denied.id})`, /FRESH_SOURCE_REQUIRED/);
    assert.equal(await processOneAIHumanHandoff(db), false); await f.grant();
    await assert.rejects(db`INSERT INTO ai_customer_handoff_job(proposal_id) VALUES(${denied.id})`, /JOB_SOURCE_REQUIRED/);
    // Atomic observation Audit failure rolls back proposal completion, ordinal and job admission together.
    await episode(); const atomic = await fresh();
    await db`CREATE FUNCTION reject_misunderstanding_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_MISUNDERSTANDING_OBSERVED' THEN RAISE EXCEPTION 'SyntheticObservationAuditFailure';END IF;RETURN NEW;END $$`;
    await db`CREATE TRIGGER reject_misunderstanding_audit_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_misunderstanding_audit_fixture()`;
    try { await assert.rejects(run(1), /SyntheticObservationAuditFailure/); assert.equal(await row(atomic.id), undefined);
      assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_handoff_job WHERE proposal_id=${atomic.id}`)[0]!.n, 0);
      assert.equal((await db`SELECT state FROM ai_customer_proposal WHERE id=${atomic.id}`)[0]!.state, 'RUNNING');
    } finally { await db`DROP TRIGGER reject_misunderstanding_audit_fixture ON audit_log`; await db`DROP FUNCTION reject_misunderstanding_audit_fixture()`; }
    await new Promise(r => setTimeout(r, 1100)); await run(); assert.equal((await row(atomic.id))!.ordinal, '1'); assert.equal(await processOneAIHumanHandoff(db), true);
    // Model output with a fabricated counter or unsupported quote grants neither an observation nor a job.
    for (const mode of ['counter','quote']) {
      await episode(); const invalid = await fresh();
      f.adapters.OPENAI!.proposeCustomer = async i => mode === 'counter' ? { ...proposal(i.data), count: 999 } : { ...proposal(i.data), sourceQuote: 'No matching source' };
      await run(); assert.equal(await row(invalid.id), undefined); assert.equal((await db`SELECT state FROM ai_customer_proposal WHERE id=${invalid.id}`)[0]!.state, 'FAILED');
      const canonical = { ...proposal({ messages: invalid.context.messages, currentMessageId: invalid.context.source.messageId }), protocolVersion: 1, toolsExecuted: [], sendAllowed: false, mutationsAllowed: false };
      assert.equal((await db`SELECT ai_customer_proposal_result_valid(${db.json(canonical)},${db.json(invalid.context)}) AS yes`)[0]!.yes, true);
      const raw = mode === 'counter' ? { ...canonical, count: 999 } : { ...canonical, sourceQuote: 'No matching source' };
      assert.equal((await db`SELECT ai_customer_proposal_result_valid(${db.json(raw)},${db.json(invalid.context)}) AS yes`)[0]!.yes, false);
      assert.throws(() => validateCustomerProposal(mode === 'counter' ? { ...proposal({ messages: invalid.context.messages, currentMessageId: invalid.context.source.messageId }), count: 999 } : { ...proposal({ messages: invalid.context.messages, currentMessageId: invalid.context.source.messageId }), sourceQuote: 'No matching source' },
        { ...invalid.context, sourceMessageId: invalid.context.source.messageId }));
    }
    // Human takeover while inference is in flight invalidates the source before a count can be recorded.
    await episode(); const stale = await fresh(); f.adapters.OPENAI!.proposeCustomer = async i => {
      const current = (await db`SELECT version FROM conversation WHERE id=${cv}`)[0]!;
      const takeover = await api('POST', '/api/conversations/' + cv + '/takeover', { version: current.version, reason: 'Human took over before inference returned' }, 'agent'); assert.equal(takeover.statusCode, 200, takeover.body); return proposal(i.data);
    };
    await run(); assert.equal(await row(stale.id), undefined); assert.equal((await db`SELECT state FROM ai_customer_proposal WHERE id=${stale.id}`)[0]!.state, 'BLOCKED');
    assert.equal((await db`SELECT controller_type FROM conversation WHERE id=${cv}`)[0]!.controller_type, 'HUMAN');
  } finally { f.adapters.OPENAI!.proposeCustomer = saved; }
}
