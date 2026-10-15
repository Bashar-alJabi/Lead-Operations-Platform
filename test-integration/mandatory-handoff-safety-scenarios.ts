import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { processOneAIHumanHandoff } from '../src/ai/customer-handoff.js';

export async function verifyMandatoryHandoffSafety(db: Database, app: FastifyInstance, f: {
  org: string; branch: string; other: string; campaign: string; lead: string; cv: string;
  users: Record<string, { id: string; session: string; cookie: string }>;
  inbound: (id: string, body?: string) => Promise<any>; activate: () => Promise<unknown>; grant: (allowed?: boolean) => Promise<unknown>; run: () => Promise<boolean>;
}) {
  const { org, branch, other, campaign, lead, cv, users } = f;
  const rows = (pid: string) => db`SELECT a.*,s.action_id AS stop_id,s.conversation_version FROM ai_customer_handoff_action a LEFT JOIN ai_handoff_safety_stop s ON s.action_id=a.id WHERE a.proposal_id=${pid}`;
  const pending = async () => { await f.grant(); await f.activate(); const p = await f.inbound(randomUUID(), 'Unknown sensitive commercial detail'); assert.equal(await f.run(), true); return p; };
  await db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
  const p = await pending(); await f.grant(false);
  const before = (await db`SELECT version,state FROM conversation WHERE id=${cv}`)[0]!;
  // A failed safety audit rolls back the blocked receipt, queue completion, stop, Activity and Conversation together.
  await db`CREATE FUNCTION reject_mandatory_stop_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='AI_MANDATORY_HANDOFF_STOPPED' THEN RAISE EXCEPTION 'synthetic mandatory stop audit failure';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER reject_mandatory_stop_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_mandatory_stop_audit()`;
  try {
    await assert.rejects(processOneAIHumanHandoff(db), /synthetic mandatory stop audit failure/);
    assert.equal((await rows(p.id)).length, 0); assert.equal((await db`SELECT state FROM ai_customer_handoff_job WHERE proposal_id=${p.id}`)[0]!.state, 'QUEUED');
    assert.deepEqual((await db`SELECT version,state FROM conversation WHERE id=${cv}`)[0], before);
  } finally { await db`DROP TRIGGER reject_mandatory_stop_audit ON audit_log`; await db`DROP FUNCTION reject_mandatory_stop_audit()`; }
  const workers = await Promise.all(Array.from({ length: 8 }, () => processOneAIHumanHandoff(db))); assert.equal(workers.filter(Boolean).length, 1);
  const action = (await rows(p.id))[0]!; assert.equal(action.state, 'BLOCKED'); assert.equal(action.stop_id, action.id); assert.equal(action.conversation_version, before.version + 1);
  const current = (await db`SELECT * FROM conversation WHERE id=${cv}`)[0]!;
  assert.equal(current.state, 'AI_HANDOFF_REQUIRED'); assert.equal(current.controller_type, 'AI'); assert.equal(current.controller_user_id, null);
  assert.equal(current.ai_handoff_action_id, null); assert.equal(current.needs_attention_reason, 'AI_PROCESSING_NOT_READY');
  assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id=${lead}`)[0]!.assigned_agent_id, users.agent!.id);
  assert.equal((await db`SELECT actor_user_id FROM audit_log WHERE target_id=${action.id} AND action='AI_MANDATORY_HANDOFF_STOPPED'`)[0]!.actor_user_id, null);
  for (const relation of ['notification_event', 'ai_handoff_sla_timer', 'conversation_handoff'] as const) {
    const count = relation === 'notification_event' ? await db`SELECT count(*)::integer AS n FROM notification_event WHERE source_id=${action.id}`
      : relation === 'ai_handoff_sla_timer' ? await db`SELECT count(*)::integer AS n FROM ai_handoff_sla_timer WHERE action_id=${action.id}`
      : await db`SELECT count(*)::integer AS n FROM conversation_handoff WHERE ai_action_id=${action.id}`;
    assert.equal(count[0]!.n, 0);
  }
  const history = await app.inject({ method: 'GET', url: '/api/conversations/' + cv + '/ai-customer-executions', headers: { cookie: users.agent!.cookie } });
  const item = history.json().items.find((e: any) => e.id === p.id); assert.equal(item.action.safetyStopped, true); assert.equal(item.actions[0].safetyStopped, true); assert.deepEqual(item.toolsExecuted, []);
  assert.equal(item.action.context, undefined);
  for (const who of ['second', 'other', 'foreign']) assert.equal((await app.inject({ method: 'GET', url: '/api/conversations/' + cv + '/ai-customer-executions', headers: { cookie: users[who]!.cookie } })).statusCode, 404);
  await assert.rejects(db`DELETE FROM ai_handoff_safety_stop WHERE action_id=${action.id}`, /IMMUTABLE/);
  await assert.rejects(db`UPDATE ai_handoff_safety_stop SET conversation_version=999 WHERE action_id=${action.id}`, /IMMUTABLE/);
  await assert.rejects(db`INSERT INTO ai_handoff_safety_stop(action_id,conversation_id,conversation_version) VALUES(${action.id},${cv},${current.version})`, /CURRENT_SOURCE_REQUIRED/);
  // Subsequent inbound stays diagnostic and cannot reactivate AI or gain new action admission.
  const diagnostic = await f.inbound(randomUUID(), 'Still need a human review'); assert.equal(await f.run(), true);
  assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_handoff_admission WHERE proposal_id=${diagnostic.id}`)[0]!.n, 0);
  assert.equal(await processOneAIHumanHandoff(db), false); assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_HANDOFF_REQUIRED');
  // Explicit Human acceptance clears only the known processing blocker. It does not reactivate AI or erase the historical stop.
  const version = (await db`SELECT version FROM conversation WHERE id=${cv}`)[0]!.version;
  const accepted = await app.inject({ method: 'POST', url: '/api/conversations/' + cv + '/takeover', headers: { cookie: users.agent!.cookie, origin: 'http://127.0.0.1:5173' }, payload: { version, reason: 'Accept safety review explicitly' } });
  assert.equal(accepted.statusCode, 200, accepted.body); assert.equal((await db`SELECT needs_attention_reason FROM conversation WHERE id=${cv}`)[0]!.needs_attention_reason, null);
  assert.equal(await processOneAIHumanHandoff(db), false);
  // A newer customer message prevents a blocked old action from changing the current AI conversation.
  const old = await pending(), newest = await f.inbound(randomUUID(), 'Current source has changed');
  assert.equal(await processOneAIHumanHandoff(db), true); assert.equal((await rows(old.id))[0]!.stop_id, null);
  assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_ACTIVE');
  assert.equal(await f.run(), true); assert.equal(await processOneAIHumanHandoff(db), true); assert.equal((await rows(newest.id))[0]!.state, 'APPLIED');
  // Keep current provider attention and Human control unchanged.
  for (const [name, change] of [
    ['attention', () => db`UPDATE conversation SET needs_attention_reason='SYNTHETIC_PROVIDER_BLOCKER' WHERE id=${cv}`],
    ['human', () => db`UPDATE conversation SET controller_type='HUMAN',controller_user_id=${users.agent!.id},state='HUMAN_ACTIVE',version=version+1 WHERE id=${cv}`],
  ] as const) {
    const stale = await pending(); await change(); const protectedState = (await db`SELECT controller_type,controller_user_id,state,needs_attention_reason,version FROM conversation WHERE id=${cv}`)[0];
    assert.equal(await processOneAIHumanHandoff(db), true); assert.equal((await rows(stale.id))[0]!.stop_id, null, name);
    assert.deepEqual((await db`SELECT controller_type,controller_user_id,state,needs_attention_reason,version FROM conversation WHERE id=${cv}`)[0], protectedState);
  }
  // Native guards never stop a different Branch/Campaign after an in-flight transfer.
  const transferred = await pending(), target = (await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES(${org},${other},'Safety source boundary','ACTIVE') RETURNING id`)[0]!.id;
  await db`UPDATE lead SET branch_id=${other},campaign_id=${target},assigned_agent_id=NULL,version=version+1 WHERE id=${lead}`;
  assert.equal(await processOneAIHumanHandoff(db), true); assert.equal((await rows(transferred.id))[0]!.stop_id, null);
  assert.equal((await db`SELECT state FROM conversation WHERE id=${cv}`)[0]!.state, 'AI_ACTIVE');
  await db`UPDATE lead SET branch_id=${branch},campaign_id=${campaign},assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
  // Ordinary approved Handoff remains the source of notifications/timers; a safety record cannot be forged from APPLIED history.
  const applied = await pending(); assert.equal(await processOneAIHumanHandoff(db), true); const appliedAction = (await rows(applied.id))[0]!;
  assert.equal(appliedAction.state, 'APPLIED'); assert.equal(appliedAction.stop_id, null);
  await assert.rejects(db`INSERT INTO ai_handoff_safety_stop(action_id,conversation_id,conversation_version) VALUES(${appliedAction.id},${cv},${appliedAction.previous_conversation_version + 1})`, /CURRENT_SOURCE_REQUIRED/);
}
