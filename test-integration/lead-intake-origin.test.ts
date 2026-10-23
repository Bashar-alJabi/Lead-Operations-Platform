import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type postgres from 'postgres';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/security.js';
import { routeLead } from '../src/routing.js';
import { recordLeadIntakeOrigin } from '../src/lead-intake-origin.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Actual Lead intake retains immutable fresh post-routing origin with real authorization, legacy/replay denial, atomicity and scoped historical reads', async t => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  const db = createDatabase(url), app = await buildApp(db, { logger: false, globalRateLimitMax: 10000 });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async tx => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
  const org = (await db`INSERT INTO organization(name) VALUES('Intake origin') RETURNING id`)[0]!.id,
    foreign = (await db`INSERT INTO organization(name) VALUES('Foreign') RETURNING id`)[0]!.id,
    branch = (await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,
    other = (await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id,
    campaign = (await db`INSERT INTO campaign(organization_id,branch_id,name,status,routing_method) VALUES(${org},${branch},'A','ACTIVE','ROUND_ROBIN') RETURNING id`)[0]!.id;
  const users: Record<string, { id: string; session: string; cookie: string }> = {};
  for (const [name, role, bid, oid] of [['manager','MANAGER',branch,org],['racing','MANAGER',branch,org],['agent','AGENT',branch,org],['second','AGENT',branch,org],['other','MANAGER',other,org],['foreign','SUPER_ADMIN',null,foreign]] as const) {
    const id = (await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES(${oid},${bid},${name},${role},${name+'@intake-origin.test'},'synthetic') RETURNING id`)[0]!.id;
    const token = randomBytes(32).toString('hex'), session = (await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name] = { id, session, cookie: 'lop_session='+token };
  }
  await db`INSERT INTO campaign_agent(campaign_id,agent_id) VALUES(${campaign},${users.agent!.id})`;
  const api = (method: 'GET'|'POST', path: string, payload?: object, who = 'manager') => app.inject({ method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, cookie: users[who]!.cookie } });
  let n = 0;
  const create = (contact: object = {}, who = 'manager') => api('POST', '/api/leads', { branchId: branch, campaignId: campaign, contact: { name: 'Synthetic intake', phone: '+1555777'+String(++n).padStart(4,'0'), ...contact } }, who);
  const made = await create(); assert.equal(made.statusCode, 201, made.body); const lead = made.json().id;
  const receipt = (await db`SELECT * FROM lead_intake_receipt WHERE lead_id=${lead}`)[0]!;
  assert.equal(receipt.origin_kind, 'HUMAN_MANUAL'); assert.equal(receipt.actor_id, users.manager!.id); assert.equal(receipt.session_id, users.manager!.session);
  assert.equal(receipt.context.routing.ownerId, users.agent!.id); assert.equal(receipt.context.routing.method, 'ROUND_ROBIN');
  const root = '/api/leads/'+lead+'/intake-origin', dto = (await api('GET', root, undefined, 'agent')).json();
  assert.equal(dto.origin.id, receipt.id); assert.equal(dto.origin.routing.ownerId, users.agent!.id); assert.equal(dto.origin.sourceKind, 'MANUAL');
  for (const hidden of ['session','context','raw_payload','actor_id','contactId']) assert.equal(JSON.stringify(dto).includes(hidden), false);
  for (const who of ['second','other','foreign']) assert.equal((await api('GET', root, undefined, who)).statusCode, 404);
  // A pre-receipt/fixture Lead is readable, but no source is inferred or backfilled from mutable current attributes.
  const legacy = (await db`INSERT INTO lead(organization_id,branch_id,campaign_id,source_kind) VALUES(${org},${branch},${campaign},'MANUAL') RETURNING id`)[0]!.id;
  assert.deepEqual((await api('GET', '/api/leads/'+legacy+'/intake-origin')).json(), { origin: null });
  for (const q of [db`UPDATE lead_intake_birth SET source_kind='META' WHERE lead_id=${lead}`, db`DELETE FROM lead_intake_birth WHERE lead_id=${lead}`,
    db`UPDATE lead_intake_receipt SET context='{}' WHERE id=${receipt.id}`, db`DELETE FROM lead_intake_receipt WHERE id=${receipt.id}`]) await assert.rejects(q, /IMMUTABLE/);
  // Updating an old Lead or appending new routing history does not make the immutable birth fresh again.
  await assert.rejects(db.begin(async tx => { await tx`UPDATE lead SET version=version+1 WHERE id=${lead}`;
    await recordLeadIntakeOrigin(tx, lead, receipt.submission_id, { kind: 'HUMAN_MANUAL', actorId: users.manager!.id, sessionId: users.manager!.session }); }), /FRESH_BIRTH_REQUIRED/);
  await assert.rejects(db`INSERT INTO lead_intake_birth(lead_id) VALUES(${lead})`, /INSERT_REQUIRED/);
  // Native callers cannot turn new rows into manual authority without the exact real current Session and scope.
  const candidate = async (tx: postgres.TransactionSql, sourceKind = 'MANUAL') => {
    const l = (await tx`INSERT INTO lead(organization_id,branch_id,campaign_id,source_kind) VALUES(${org},${branch},${campaign},${sourceKind}) RETURNING id`)[0]!.id;
    const s = (await tx`INSERT INTO source_submission(organization_id,branch_id,campaign_id,lead_id,source_kind,state,raw_payload) VALUES(${org},${branch},${campaign},${l},${sourceKind},'PROCESSED','{}') RETURNING id`)[0]!.id;
    await routeLead(tx, campaign, branch, 'ROUND_ROBIN', 'UTC', l); return { l, s };
  };
  for (const who of ['agent','other','foreign']) await assert.rejects(db.begin(async tx => {
    const { l, s } = await candidate(tx); await recordLeadIntakeOrigin(tx, l, s, { kind: 'HUMAN_MANUAL', actorId: users[who]!.id, sessionId: users[who]!.session });
  }), /CURRENT_SESSION_REQUIRED/);
  await assert.rejects(db.begin(async tx => { const { l, s } = await candidate(tx); await recordLeadIntakeOrigin(tx, l, s, { kind: 'HUMAN_MANUAL', actorId: users.manager!.id, sessionId: randomUUID() }); }), /CURRENT_SESSION_REQUIRED/);
  await assert.rejects(db.begin(async tx => { const { l, s } = await candidate(tx, 'META'); await recordLeadIntakeOrigin(tx, l, s, { kind: 'SOURCE' }); }), /PROCESSED_SOURCE_REQUIRED/);
  await assert.rejects(db.begin(async tx => { const { l, s } = await candidate(tx); await recordLeadIntakeOrigin(tx, l, s, { kind: 'HUMAN_MANUAL', actorId: users.manager!.id, sessionId: users.manager!.session });
    await tx`UPDATE lead SET version=version+1 WHERE id=${l}`; }), /ATOMIC_CONTEXT_REQUIRED/);
  const counts = async () => (await db`SELECT (SELECT count(*)::int FROM lead) AS leads,(SELECT count(*)::int FROM contact) AS contacts,
    (SELECT count(*)::int FROM source_submission) AS sources,(SELECT count(*)::int FROM lead_intake_birth) AS births,(SELECT count(*)::int FROM lead_intake_receipt) AS receipts`)[0]!;
  const before = await counts();
  await db`CREATE FUNCTION reject_intake_origin_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='LEAD_INTAKE_RECORDED' THEN RAISE EXCEPTION 'SyntheticIntakeAuditRollback';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER reject_intake_origin_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_intake_origin_fixture()`;
  try { const failed = await create(); assert.equal(failed.statusCode, 500); assert.equal(failed.body.includes('SyntheticIntakeAuditRollback'), false); assert.deepEqual(await counts(), before); }
  finally { await db`DROP TRIGGER reject_intake_origin_fixture ON audit_log`; await db`DROP FUNCTION reject_intake_origin_fixture()`; }
  const batch = await Promise.all(Array.from({ length: 8 }, () => create())); assert.ok(batch.every(r => r.statusCode === 201));
  const ids = batch.map(r => r.json().id); assert.equal((await db`SELECT count(*)::int AS n FROM lead_intake_receipt WHERE lead_id IN ${db(ids)}`)[0]!.n, 8);
  // Contact ambiguity is reviewed once; the old submission is finalized with a NEW birth and the real reviewer Session.
  const emailLead = await create({ email: 'separate@intake-origin.test' }); assert.equal(emailLead.statusCode, 201);
  const originalPhone = (await db`SELECT c.phone_normalized FROM lead l JOIN contact c ON c.id=l.contact_id WHERE l.id=${lead}`)[0]!.phone_normalized;
  const review = await create({ phone: originalPhone, email: 'separate@intake-origin.test' }); assert.equal(review.statusCode, 202, review.body);
  const contact = (await db`SELECT contact_id FROM lead WHERE id=${lead}`)[0]!.contact_id;
  const beforeReview = await counts();
  await db`UPDATE campaign SET status='DRAFT',version=version+1 WHERE id=${campaign}`;
  assert.equal((await api('POST', '/api/contact-reviews/'+review.json().reviewId+'/resolve', { contactId: contact })).statusCode, 409);
  await db`UPDATE campaign SET status='ACTIVE',version=version+1 WHERE id=${campaign}`;
  await db`UPDATE branch SET active=false WHERE id=${branch}`;
  assert.equal((await api('POST', '/api/contact-reviews/'+review.json().reviewId+'/resolve', { contactId: contact })).statusCode, 409);
  await db`UPDATE branch SET active=true WHERE id=${branch}`;
  assert.deepEqual(await counts(), beforeReview);
  const resolved = await api('POST', '/api/contact-reviews/'+review.json().reviewId+'/resolve', { contactId: contact }); assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal((await db`SELECT submission_id FROM lead_intake_receipt WHERE lead_id=${resolved.json().id}`)[0]!.submission_id, review.json().reviewId);
  assert.equal((await api('POST', '/api/contact-reviews/'+review.json().reviewId+'/resolve', { contactId: contact })).json().id, resolved.json().id);
  // Historical origin survives reassignment, but current Agent permissions are rechecked.
  const version = (await db`SELECT version FROM lead WHERE id=${lead}`)[0]!.version;
  assert.equal((await api('POST', '/api/leads/'+lead+'/assignment', { version, agentId: users.second!.id, reason: 'New current owner' })).statusCode, 200);
  assert.equal((await api('GET', root, undefined, 'agent')).statusCode, 404);
  const moved = (await api('GET', root, undefined, 'second')).json(); assert.equal(moved.origin.id, receipt.id); assert.equal(moved.origin.routing.ownerId, users.agent!.id);
  // A session revoked while intake waits on its parent lock cannot create a new trusted source.
  let enter!: () => void, release!: () => void; const ready = new Promise<void>(r => { enter=r; }), held = new Promise<void>(r => { release=r; });
  const blocker = db.begin(async tx => { await tx`SELECT id FROM branch WHERE id=${branch} FOR UPDATE`; enter(); await held;
    await tx`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.racing!.session}`; });
  await ready; const racing = create({}, 'racing'); let waiting = false;
  try { for (let i=0;i<100;i++) { waiting = (await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM branch WHERE id =%') AS ok`)[0]!.ok;
      if (waiting) break; await delay(20); } assert.equal(waiting, true); }
  finally { release(); await blocker; }
  const rejected = await racing; assert.equal(rejected.statusCode, 403, rejected.body);
  assert.equal((await db`SELECT count(*)::int AS n FROM conversation_message`)[0]!.n, 0);
  assert.equal((await db`SELECT count(*)::int AS n FROM ai_customer_proposal`)[0]!.n, 0);
  assert.equal((await db`SELECT count(*)::int AS n FROM payment_record`)[0]!.n, 0);
  assert.equal((await db`SELECT count(*)::int AS n FROM background_job`)[0]!.n, 0);
});
