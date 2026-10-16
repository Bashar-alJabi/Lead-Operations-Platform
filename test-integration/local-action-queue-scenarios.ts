import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { admitLegacyLocalAIActions, type LocalAIActionKind } from '../src/ai/local-action-queue.js';
import { processOneInboundEvent } from '../src/messaging/inbound-events.js';
import { processOneAIQualificationAction, collectAIQualificationAnswer } from '../src/ai/customer-qualification.js';
import { processOneAIHumanHandoff, requestAIHumanHandoff } from '../src/ai/customer-handoff.js';

export async function verifyLocalAIActionQueue(db: Database, app: FastifyInstance, kind: LocalAIActionKind, f: {
  org: string; branch: string; campaign: string; lead: string; cv: string;
  users: Record<string, { id: string; session: string; cookie: string }>;
  pending: () => Promise<any>; run: () => Promise<boolean>; activate: () => Promise<unknown>;
}) {
  assert.equal((await db`SELECT current_database() AS name`)[0]!.name, 'lead_operations_test');
  const { org, branch, campaign, lead, cv, users } = f, root = '/api/conversations/' + cv + '/ai-action-jobs';
  const worker = () => kind === 'QUALIFICATION' ? processOneAIQualificationAction(db) : processOneAIHumanHandoff(db);
  const service = (pid: string) => db.begin(tx => kind === 'QUALIFICATION' ? collectAIQualificationAnswer(tx, pid) : requestAIHumanHandoff(tx, pid));
  const api = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, who = 'manager', cookie?: string) => app.inject({ method, url: path, payload: body,
    headers: { cookie: cookie ?? users[who]!.cookie, origin: process.env.APP_ORIGIN! } });
  const queue = async (pid: string) => (await db`SELECT * FROM ai_local_action_queue WHERE proposal_id=${pid} AND kind=${kind}`)[0]!;
  const receiptCount = async (pid: string) => (kind === 'QUALIFICATION' ? await db`SELECT count(*)::integer AS n FROM ai_customer_action WHERE proposal_id=${pid}` : await db`SELECT count(*)::integer AS n FROM ai_customer_handoff_action WHERE proposal_id=${pid}`)[0]!.n;
  await db`CREATE TABLE test_local_action_clock(at_time timestamptz NOT NULL)`;
  await db`INSERT INTO test_local_action_clock VALUES(clock_timestamp())`;
  await db`CREATE OR REPLACE FUNCTION ai_local_action_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT at_time FROM test_local_action_clock $$`;
  await db`CREATE TABLE test_local_action_failure(proposal_id uuid PRIMARY KEY,fail_step boolean NOT NULL DEFAULT true,fail_recovery boolean NOT NULL DEFAULT false)`;
  await db`CREATE FUNCTION test_reject_local_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_TABLE_NAME='lead_qualification_answer_history' THEN
      IF EXISTS(SELECT 1 FROM ai_customer_action a JOIN test_local_action_failure f ON f.proposal_id=a.proposal_id WHERE a.id=(NEW.snapshot->>'ai_action_id')::uuid AND f.fail_step) THEN RAISE EXCEPTION 'NeverPersistSensitiveSQL_123';END IF;
    ELSIF TG_TABLE_NAME='notification_event' THEN
      IF EXISTS(SELECT 1 FROM ai_customer_handoff_action a JOIN test_local_action_failure f ON f.proposal_id=a.proposal_id WHERE a.id=NEW.source_id AND f.fail_step) THEN RAISE EXCEPTION 'NeverPersistSensitiveSQL_123';END IF;
    ELSE
      IF NEW.action='AI_LOCAL_ACTION_RECOVERY_REQUESTED' AND EXISTS(SELECT 1 FROM test_local_action_failure f WHERE f.proposal_id=(NEW.detail->>'proposalId')::uuid AND f.fail_recovery) THEN RAISE EXCEPTION 'SyntheticRecoveryAuditFailure';END IF;
    END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER zz_test_reject_local_action BEFORE INSERT ON lead_qualification_answer_history FOR EACH ROW EXECUTE FUNCTION test_reject_local_action()`;
  await db`CREATE TRIGGER zz_test_reject_local_action BEFORE INSERT ON notification_event FOR EACH ROW EXECUTE FUNCTION test_reject_local_action()`;
  await db`CREATE TRIGGER zz_test_reject_local_action BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_reject_local_action()`;
  try {
    const p = await f.pending(), q = await queue(p.id);
    await db`INSERT INTO test_local_action_failure(proposal_id) VALUES(${p.id})`;
    const snapshot = async () => ({ cv: (await db`SELECT version,state,controller_type,ai_handoff_action_id FROM conversation WHERE id=${cv}`)[0],
      fields: await db`SELECT field_id,value,source,version FROM lead_field_value WHERE lead_id=${lead} ORDER BY field_id`, answers: await db`SELECT question_id,value,source,version FROM lead_qualification_answer WHERE lead_id=${lead} ORDER BY question_id` });
    const before = await snapshot();
    assert.equal(await worker(), true); assert.equal((await queue(p.id)).failure_count, 1); assert.equal(await worker(), false);
    assert.equal((await db`SELECT available_at-updated_at=interval '2 seconds' AS exact FROM ai_local_action_queue WHERE id=${q.id}`)[0]!.exact, true);
    await assert.rejects(service(p.id), /DUE_JOB_REQUIRED/);
    // Another Conversation's eligible job advances while the original job is backing off.
    const ct = (await db`INSERT INTO contact(organization_id,name,phone_normalized) VALUES(${org},'Independent synthetic queue customer','+15559998888') RETURNING id`)[0]!.id;
    const sibling = (await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,assigned_agent_id,source_kind) VALUES(${org},${branch},${campaign},${ct},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id;
    const source = (await db`SELECT cv.connection_id,cv.sender_id,s.external_sender_id,ic.config,m.body FROM conversation cv JOIN messaging_sender s ON s.id=cv.sender_id
      JOIN integration_connection ic ON ic.id=cv.connection_id JOIN conversation_message m ON m.id=${p.message_id} WHERE cv.id=${cv}`)[0]!;
    const siblingCV = (await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state)
      VALUES(${sibling},${source.connection_id},${source.sender_id},'WHATSAPP','+15559998888','AI','AI_ACTIVE') RETURNING id`)[0]!.id;
    const messageId = randomUUID(), raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: source.config.wabaId, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: source.external_sender_id }, messages: [{ id: messageId, from: '15559998888', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: source.body } }],
    } }] }] });
    const received = await app.inject({ method: 'POST', url: '/api/webhooks/messaging/meta/' + source.connection_id, payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'synthetic-hmac-secret').update(raw).digest('hex') } });
    assert.equal(received.statusCode, 200); assert.equal(await processOneInboundEvent(db), true); assert.equal(await f.run(), true);
    assert.equal(await worker(), true); assert.equal((await db`SELECT state FROM ai_local_action_queue WHERE conversation_id=${siblingCV} AND kind=${kind}`)[0]!.state, 'COMPLETED');
    assert.equal((await queue(p.id)).failure_count, 1);
    for (let failure = 2; failure <= 5; failure++) {
      await db`UPDATE test_local_action_clock SET at_time=at_time+interval '60 seconds'`;
      const races = await Promise.all(Array.from({ length: 8 }, worker)); assert.equal(races.filter(Boolean).length, 1);
      const failed = await queue(p.id); assert.equal(failed.failure_count, failure); assert.equal(await receiptCount(p.id), 0); assert.deepEqual(await snapshot(), before);
    }
    const dead = await queue(p.id); assert.equal(dead.state, 'DEAD_LETTER'); assert.equal(dead.version, 6); assert.equal(dead.error_code, 'AI_LOCAL_ACTION_FAILED');
    assert.equal(await worker(), false); await assert.rejects(service(p.id), /DUE_JOB_REQUIRED/);
    assert.equal((await db`SELECT count(*)::integer AS n FROM ai_local_action_queue_history WHERE queue_id=${q.id}`)[0]!.n, 6);
    assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE target_id=${q.id} AND action='AI_LOCAL_ACTION_DEAD_LETTER'`)[0]!.n, 1);
    const dto = (await api('GET', root)).json().items.find((j: any) => j.id === q.id); assert.equal(dto.canRetry, true); assert.equal(dto.nextRunAt, null);
    const agent = (await api('GET', root, undefined, 'agent')).json().items.find((j: any) => j.id === q.id); assert.equal(agent.canRetry, false);
    for (const who of ['second', 'other', 'foreign']) assert.equal((await api('GET', root, undefined, who)).statusCode, 404);
    assert.equal((await api('POST', root + '/' + q.id + '/retry', { version: 6, reason: 'Not allowed' }, 'agent')).statusCode, 403);
    for (const who of ['other', 'foreign']) assert.equal((await api('POST', root + '/' + q.id + '/retry', { version: 6, reason: 'Other scope' }, who)).statusCode, 404);
    const history = await api('GET', root + '/' + q.id + '/history?limit=1'); assert.equal(history.json().items[0].failure_count, 5); assert.equal(history.json().items[0].session_id, undefined);
    assert.equal((await api('GET', root + '/' + q.id + '/history?before=' + history.json().nextVersion)).json().items[0].version, 5);
    assert.equal(JSON.stringify([dto, history.json()]).includes('NeverPersistSensitiveSQL'), false);
    await assert.rejects(db`UPDATE ai_local_action_queue_history SET snapshot='{}' WHERE queue_id=${q.id}`, /IMMUTABLE/);
    await assert.rejects(db`INSERT INTO ai_local_action_queue_history(queue_id,version,snapshot,created_at) VALUES(${q.id},99,'{}',now())`, /FRESH_HISTORY_REQUIRED/);
    await assert.rejects(db`UPDATE ai_local_action_queue SET operation='COMPLETE',version=version+1 WHERE id=${q.id}`, /FRESH_RECEIPT_REQUIRED/);
    await assert.rejects(db`UPDATE ai_local_action_queue SET operation='FAILURE',version=version+1,available_at=now()-interval '1 day',failure_count=0 WHERE id=${q.id}`, /DUE_JOB_REQUIRED/);
    await assert.rejects(db`UPDATE ai_local_action_queue SET operation='HUMAN_RETRY',version=version+1,actor_id=${users.agent!.id},session_id=${users.agent!.session},reason='Forged Agent repair' WHERE id=${q.id}`, /CURRENT_RECOVERY_REQUIRED/);
    for (const body of [{ version: '6', reason: 'Wrong type' }, { version: 6, reason: '  ' }, { version: 6, reason: 'bad\u0000text' }]) assert.equal((await api('POST', root + '/' + q.id + '/retry', body)).statusCode, 400);
    // Revalidate the actual cookie after waiting on the queue, without revoking the shared fixture session.
    const token = randomBytes(32).toString('hex'), session = (await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${users.manager!.id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;
    let entered!: () => void, release!: () => void; const ready = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    const blocker = db.begin(async tx => { await tx`SELECT id FROM ai_local_action_queue WHERE id=${q.id} FOR UPDATE`; entered(); await hold; });
    await ready; const waiting = api('POST', root + '/' + q.id + '/retry', { version: 6, reason: 'Cookie must remain current' }, 'manager', 'lop_session=' + token);
    try {
      let locked = false; for (let n = 0; n < 80; n++) { locked = (await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT q.* FROM ai_local_action_queue%' AND pid<>pg_backend_pid()) AS yes`)[0]!.yes; if (locked) break; await new Promise(r => setTimeout(r, 50)); }
      assert.equal(locked, true); await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${session}`;
    } finally { release(); await blocker; }
    assert.equal((await waiting).statusCode, 403); assert.equal((await queue(p.id)).version, 6);
    // Recovery Audit is atomic, then an eight-way CAS admits exactly one human repair.
    await db`UPDATE test_local_action_failure SET fail_step=false,fail_recovery=true WHERE proposal_id=${p.id}`;
    assert.equal((await api('POST', root + '/' + q.id + '/retry', { version: 6, reason: 'Audit must succeed first' })).statusCode, 500);
    assert.equal((await queue(p.id)).version, 6);
    await db`UPDATE test_local_action_failure SET fail_recovery=false WHERE proposal_id=${p.id}`;
    const retries = await Promise.all(Array.from({ length: 8 }, () => api('POST', root + '/' + q.id + '/retry', { version: 6, reason: 'Repair <img literal> after local failure' })));
    assert.equal(retries.filter(r => r.statusCode === 200).length, 1); assert.equal(retries.filter(r => r.statusCode === 409).length, 7);
    assert.equal(await worker(), true); assert.equal(await receiptCount(p.id), 1); assert.equal((await queue(p.id)).state, 'COMPLETED');
    assert.equal((await queue(p.id)).version, 8); assert.equal(await worker(), false);
    assert.equal((await api('GET', root)).json().items.some((j: any) => j.id === q.id), false);
    const completed = (await api('GET', root + '?includeCompleted=true')).json().items.find((j: any) => j.id === q.id); assert.equal(completed.canRetry, false);
    assert.equal((await api('POST', root + '/' + q.id + '/retry', { version: 8, reason: 'No terminal replay' })).statusCode, 409);
    // A source revoked after a technical failure cannot be repaired into authority; automatic recheck terminates BLOCKED.
    const stale = await f.pending(); await db`INSERT INTO test_local_action_failure(proposal_id) VALUES(${stale.id})`; assert.equal(await worker(), true);
    const staleQ = await queue(stale.id); await db`UPDATE lead SET assigned_agent_id=${users.second!.id},version=version+1 WHERE id=${lead}`;
    assert.equal((await api('POST', root + '/' + staleQ.id + '/retry', { version: staleQ.version, reason: 'Old context is not authority' })).statusCode, 409);
    await db`UPDATE test_local_action_clock SET at_time=at_time+interval '60 seconds'`; assert.equal(await worker(), true);
    assert.equal((await queue(stale.id)).state, 'COMPLETED');
    const blocked = kind === 'QUALIFICATION' ? await db`SELECT state FROM ai_customer_action WHERE proposal_id=${stale.id}` : await db`SELECT state FROM ai_customer_handoff_action WHERE proposal_id=${stale.id}`;
    assert.equal(blocked[0]!.state, 'BLOCKED'); await db`UPDATE lead SET assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
    // A real Organization Super Admin can repair an eligible source, but cannot see/revive old-scope jobs after a transfer.
    const saId = (await db`INSERT INTO user_account(organization_id,name,role,email,password_hash) VALUES(${org},'Queue synthetic SA','SUPER_ADMIN',${randomUUID()+'@synthetic.test'},'Synthetic-only') RETURNING id`)[0]!.id;
    const saToken = randomBytes(32).toString('hex'), saSession = (await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${saId},${sha256(saToken)},clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;
    const admin = (method: 'GET'|'POST', path: string, body?: Record<string, unknown>) => api(method,path,body,'manager','lop_session='+saToken);
    const saSource = await f.pending(); await db`INSERT INTO test_local_action_failure(proposal_id) VALUES(${saSource.id})`; assert.equal(await worker(),true);
    const saQueue = await queue(saSource.id); await db`UPDATE test_local_action_failure SET fail_step=false WHERE proposal_id=${saSource.id}`;
    assert.equal((await admin('POST',root+'/'+saQueue.id+'/retry',{version:saQueue.version,reason:'Organization admin repairs current source'})).statusCode,200);
    assert.equal(await worker(),true); assert.equal((await queue(saSource.id)).state,'COMPLETED');
    const transferred = await f.pending(); await db`INSERT INTO test_local_action_failure(proposal_id) VALUES(${transferred.id})`; assert.equal(await worker(),true);
    const movedQueue = await queue(transferred.id), otherBranch = (await db`SELECT id FROM branch WHERE organization_id=${org} AND id<>${branch} ORDER BY id LIMIT 1`)[0]!.id;
    const movedCampaign = (await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES(${org},${otherBranch},'Queue scope transfer','ACTIVE') RETURNING id`)[0]!.id;
    await db`UPDATE lead SET branch_id=${otherBranch},campaign_id=${movedCampaign},assigned_agent_id=NULL,version=version+1 WHERE id=${lead}`;
    assert.equal((await api('GET',root)).statusCode,404); assert.deepEqual((await admin('GET',root)).json().items,[]);
    assert.equal((await admin('GET',root+'/'+movedQueue.id+'/history')).statusCode,404);
    assert.equal((await admin('POST',root+'/'+movedQueue.id+'/retry',{version:movedQueue.version,reason:'Do not migrate source scope'})).statusCode,404);
    await assert.rejects(db`UPDATE ai_local_action_queue SET operation='HUMAN_RETRY',version=version+1,actor_id=${saId},session_id=${saSession},reason='No old-scope repair' WHERE id=${movedQueue.id}`,/CURRENT_RECOVERY_REQUIRED/);
    await db`UPDATE lead SET branch_id=${branch},campaign_id=${campaign},assigned_agent_id=${users.agent!.id},version=version+1 WHERE id=${lead}`;
    await db`UPDATE test_local_action_clock SET at_time=at_time+interval '60 seconds'`; assert.equal(await worker(),true); assert.equal((await queue(transferred.id)).state,'COMPLETED');
    // Bounded legacy startup admission is unique and accepts only an existing pending original Job.
    if (kind === 'QUALIFICATION') await db`ALTER TABLE ai_customer_action_job DISABLE TRIGGER ai_local_qualification_queue_sync`;
    else await db`ALTER TABLE ai_customer_handoff_job DISABLE TRIGGER ai_local_handoff_queue_sync`;
    let legacy: any; try { legacy = await f.pending(); } finally {
      if (kind === 'QUALIFICATION') await db`ALTER TABLE ai_customer_action_job ENABLE TRIGGER ai_local_qualification_queue_sync`;
      else await db`ALTER TABLE ai_customer_handoff_job ENABLE TRIGGER ai_local_handoff_queue_sync`;
    }
    assert.equal(await queue(legacy.id), undefined); assert.equal(await worker(), false);
    const sweeps = await Promise.all(Array.from({ length: 4 }, () => admitLegacyLocalAIActions(db, kind, null, 1)));
    assert.ok(await queue(legacy.id)); assert.equal((await admitLegacyLocalAIActions(db, kind, sweeps[0]!.nextCursor, 1)).done, true);
    assert.equal(await worker(), true); assert.equal(await receiptCount(legacy.id), 1); assert.equal((await admitLegacyLocalAIActions(db, kind, null)).done, true);
    await assert.rejects(admitLegacyLocalAIActions(db, kind, null, 0), /Invalid local AI action admission capacity/);
    await assert.rejects(db`INSERT INTO ai_local_action_queue(proposal_id,kind,operation) VALUES(${randomUUID()},${kind},'ADMIT')`, /JOB_SOURCE_REQUIRED/);
    // Both kinds can share a proposal ID; cursor identity is the Queue UUID and preserves native microseconds.
    const page = (await api('GET', root + '?includeCompleted=true&limit=1')).json(); assert.ok(page.nextCursor);
    const secondPage = (await api('GET', root + '?includeCompleted=true&limit=1&cursor=' + encodeURIComponent(page.nextCursor))).json();
    assert.equal((await db`SELECT a.updated_at=b.updated_at AS tied FROM ai_local_action_queue a,ai_local_action_queue b WHERE a.id=${movedQueue.id} AND b.proposal_id=${legacy.id} AND b.kind=${kind}`)[0]!.tied,true);
    assert.deepEqual(new Set([page.items[0].id,secondPage.items[0].id]),new Set([movedQueue.id,(await queue(legacy.id)).id]));
  } finally {
    await db`CREATE OR REPLACE FUNCTION ai_local_action_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() $$`;
    await db`DROP TRIGGER zz_test_reject_local_action ON lead_qualification_answer_history`; await db`DROP TRIGGER zz_test_reject_local_action ON notification_event`; await db`DROP TRIGGER zz_test_reject_local_action ON audit_log`;
    await db`DROP FUNCTION test_reject_local_action()`; await db`DROP TABLE test_local_action_failure`; await db`DROP TABLE test_local_action_clock`;
    await f.activate();
  }
}
