import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { HttpError, type Principal } from '../src/security.js';
import { processOneAICustomerProposal } from '../src/ai/customer-worker.js';
import { checkOutboundAuthorityPolicy, lockOutboundAuthority } from '../src/messaging/authority.js';

// Reuse the real signed inbound fixture. Policy inspection is deliberately not an action or customer send.
export async function verifyAIOutboundAuthority(db: Database, app: FastifyInstance, f: {
  org: string; branch: string; other: string; campaign: string; lead: string; contact: string; cv: string; sender: string;
  users: Record<string, { id: string; cookie: string }>;
  activate: () => Promise<unknown>; inbound: (id: string, body?: string) => Promise<any>;
}) {
  const { org, branch, campaign, lead, cv, users } = f, tools = '/api/ai/campaigns/' + campaign + '/tool-policy';
  const api = (method: 'GET'|'PUT'|'POST', path: string, payload?: object, who = 'manager') => app.inject({ method, url: path, payload,
    headers: { origin: process.env.APP_ORIGIN!, cookie: users[who]!.cookie } });
  const grant = async (allowedTools: string[]) => {
    const current = (await api('GET', tools)).json();
    const r = await api('PUT', tools, { version: current.version, definition: { allowedTools }, reason: 'Synthetic explicit outbound tool approval' });
    assert.equal(r.statusCode, 200, r.body);
  };
  const consent = async (status: 'GRANTED'|'REVOKED'|'UNKNOWN', doNotContact = false) => {
    const path = '/api/leads/' + lead + '/messaging-consent', current = (await api('GET', path)).json();
    const r = await api('PUT', path, { version: current.version, status, doNotContact,
      evidence: status === 'GRANTED' ? 'Synthetic explicit consent evidence' : null, source: 'Synthetic test fixture' });
    assert.equal(r.statusCode, 200, r.body);
  };
  const drain = async () => { for (let i = 0; i < 30 && await processOneAICustomerProposal(db); i++); };
  const source = async () => { await drain(); await f.activate(); return f.inbound(randomUUID(), 'Synthetic approved price?'); };
  const inspect = (pid: string, conversationId = cv) => db.begin(async tx => {
    const locked = await lockOutboundAuthority(tx, { kind: 'AI_ADMISSION', proposalId: pid }, conversationId);
    assert.equal(locked.scope.organization_id, org); assert.equal(locked.scope.branch_id, branch);
    assert.equal(locked.scope.campaign_id, campaign); assert.equal(locked.scope.lead_id, lead);
    return checkOutboundAuthorityPolicy(tx, locked);
  });
  const stale = (pid: string, conversationId = cv) => assert.rejects(inspect(pid, conversationId),
    (e: unknown) => e instanceof HttpError && e.statusCode === 409 && e.code === 'AI_SEND_ADMISSION_CONTEXT_CHANGED');
  await db`UPDATE campaign SET messaging_config='{"enabled":true}',messaging_policy='{}',version=version+1 WHERE id=${campaign}`;
  await consent('UNKNOWN');
  await grant(['requestHumanHandoff']);
  const old = await source(); assert.ok(old);
  assert.equal((await db`SELECT count(*)::int AS n FROM ai_customer_send_admission WHERE proposal_id=${old.id}`)[0]!.n, 0);
  await grant(['requestHumanHandoff','sendConversationMessage']);
  await assert.rejects(db`INSERT INTO ai_customer_send_admission(proposal_id,event_id,context) VALUES(${old.id},${old.event_id},${db.json(old.context)})`, /NEW_ACTIVE_SOURCE_REQUIRED/);
  await stale(old.id); await stale(randomUUID());
  const first = await source(); assert.ok(first);
  const admitted = (await db`SELECT * FROM ai_customer_send_admission WHERE proposal_id=${first.id}`)[0]!;
  assert.deepEqual(admitted.context, first.context); assert.equal(admitted.event_id, first.event_id);
  assert.deepEqual(await inspect(first.id), { allowed: false, reason: 'CONSENT_REQUIRED' });
  await stale(first.id, randomUUID());
  await assert.rejects(db`UPDATE ai_customer_send_admission SET context='{}' WHERE proposal_id=${first.id}`, /IMMUTABLE/);
  await assert.rejects(db`DELETE FROM ai_customer_send_admission WHERE proposal_id=${first.id}`, /IMMUTABLE/);
  await assert.rejects(db`INSERT INTO ai_customer_send_admission(proposal_id,event_id,context) VALUES(${randomUUID()},${first.event_id},${db.json(first.context)})`, /NEW_ACTIVE_SOURCE_REQUIRED/);
  // Consent must be current, including after a revoke/restore. A prior snapshot cannot gain the new grant.
  await consent('GRANTED'); await stale(first.id);
  const active = await source(); assert.ok((await inspect(active.id)).allowed);
  const eight = await Promise.all(Array.from({ length: 8 }, () => inspect(active.id))); assert.equal(eight.filter(r => r.allowed).length, 8);
  assert.equal((await db`SELECT count(*)::int AS n FROM ai_customer_send_admission WHERE proposal_id=${active.id}`)[0]!.n, 1);
  await consent('REVOKED'); await stale(active.id); const revoked = await source(); assert.equal(revoked, undefined);
  await consent('GRANTED', true); const dnc = await source(); assert.equal(dnc, undefined);
  await consent('GRANTED'); await stale(active.id);
  // An AI source is not a foreign Lead grant or a Human employee identity.
  const principal: Principal = { id: users.agent!.id, organizationId: org, branchId: branch, role: 'AGENT', name: 'Synthetic Agent', email: 'agent@synthetic.test' };
  const humanPolicy = () => db.begin(async tx => checkOutboundAuthorityPolicy(tx,
    await lockOutboundAuthority(tx, { kind: 'HUMAN', principal }, cv)));
  const p = await source(); assert.ok((await inspect(p.id)).allowed);
  assert.deepEqual(await humanPolicy(), { allowed: false, reason: 'HUMAN_CONTROLLER_REQUIRED' });
  for (const who of ['second','other','foreign']) {
    const row = (await db`SELECT * FROM user_account WHERE id=${users[who]!.id}`)[0]!;
    const restricted: Principal = { id: row.id, organizationId: row.organization_id, branchId: row.branch_id, role: row.role, name: row.name, email: row.email };
    await assert.rejects(db.begin(tx => lockOutboundAuthority(tx, { kind: 'HUMAN', principal: restricted }, cv)),
      (e: unknown) => e instanceof HttpError && e.statusCode === 404);
  }
  const version = (await db`SELECT version FROM conversation WHERE id=${cv}`)[0]!.version;
  assert.equal((await api('POST', '/api/conversations/' + cv + '/takeover', { version, reason: 'Synthetic explicit takeover' }, 'agent')).statusCode, 200);
  await stale(p.id); assert.ok((await humanPolicy()).allowed);
  // Returning to AI does not revive an earlier episode or action context.
  await f.activate(); await stale(p.id);
  const moved = await source();
  await db`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`; await stale(moved.id);
  await db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`; await stale(moved.id);
  // Sender disable and restoration are a current-context change; never choose another Sender silently.
  const pinned = await source(); await db`UPDATE messaging_sender SET operator_enabled=false WHERE id=${f.sender}`; await stale(pinned.id);
  await db`UPDATE messaging_sender SET operator_enabled=true WHERE id=${f.sender}`;
  // Approved tool revocation and reapproval advance the policy version; old sources remain stale.
  const tool = await source(); await grant(['requestHumanHandoff']); await stale(tool.id);
  await grant(['requestHumanHandoff','sendConversationMessage']); await stale(tool.id);
  // Same central timezone/window policy is evaluated against PostgreSQL's clock for AI and Human.
  const minute = (await db`SELECT extract(hour FROM clock_timestamp() AT TIME ZONE timezone)::int*60+extract(minute FROM clock_timestamp() AT TIME ZONE timezone)::int AS m FROM branch WHERE id=${branch}`)[0]!.m;
  const hhmm = (m: number) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const start = (minute + 120) % 1440, end = (minute + 180) % 1440;
  await db`UPDATE campaign SET messaging_policy=${db.json({ sendingWindow: { start: hhmm(start), end: hhmm(end) } })},version=version+1 WHERE id=${campaign}`;
  const outside = await source(); assert.deepEqual(await inspect(outside.id), { allowed: false, reason: 'OUTSIDE_SENDING_WINDOW' });
  await db`UPDATE campaign SET messaging_policy='{}',version=version+1 WHERE id=${campaign}`; await stale(outside.id);
  // Attempts are queried from actual history across the Lead's conversations, never from model counters.
  // Historical fixtures roll back and cannot leave a send intent or be picked up by a worker.
  const rollback = new Error('Rollback synthetic historical policy fixture');
  for (const [policy, reason] of [[{ maxAttempts: 1 }, 'MAX_ATTEMPTS'], [{ minIntervalSeconds: 3600 }, 'FREQUENCY_LIMIT']] as const) {
    await db`UPDATE campaign SET messaging_policy=${db.json(policy)},version=version+1 WHERE id=${campaign}`;
    const current = await source(); assert.ok((await inspect(current.id)).allowed);
    await assert.rejects(db.begin(async tx => {
      const historical = (await tx`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state)
        SELECT lead_id,connection_id,sender_id,channel,participant_ref,'NONE','CLOSED' FROM conversation WHERE id=${cv} RETURNING id`)[0]!.id;
      await tx`INSERT INTO conversation_message(conversation_id,connection_id,sender_id,direction,author_type,body,delivery_state)
        SELECT ${historical},connection_id,sender_id,'OUTBOUND','FOLLOW_UP','Synthetic historical attempt','SENT' FROM conversation WHERE id=${cv}`;
      const locked = await lockOutboundAuthority(tx, { kind: 'AI_ADMISSION', proposalId: current.id }, cv);
      assert.deepEqual(await checkOutboundAuthorityPolicy(tx, locked), { allowed: false, reason });
      throw rollback;
    }), (e: unknown) => e === rollback);
  }
  await db`UPDATE campaign SET messaging_policy='{}',version=version+1 WHERE id=${campaign}`;
  // The original Send-only runtime is still diagnostic: policy admission must not turn it on.
  await grant(['sendConversationMessage']); const diagnostic = await source(); assert.ok(diagnostic);
  assert.equal((await db`SELECT count(*)::int AS n FROM ai_customer_send_admission WHERE proposal_id=${diagnostic.id}`)[0]!.n, 0);
  await grant(['requestHumanHandoff','sendConversationMessage']); await stale(diagnostic.id);
  const liveOff = await source(); assert.ok((await inspect(liveOff.id)).allowed); await drain(); await stale(liveOff.id);
  assert.equal((await db`SELECT state FROM ai_customer_proposal WHERE id=${liveOff.id}`)[0]!.state, 'BLOCKED');
  assert.equal((await db`SELECT count(*)::int AS n FROM conversation_message WHERE direction='OUTBOUND'`)[0]!.n, 0);
  assert.equal((await db`SELECT count(*)::int AS n FROM background_job WHERE kind='SEND_MESSAGE'`)[0]!.n, 0);
}
