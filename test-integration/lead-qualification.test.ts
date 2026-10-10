import { test } from 'node:test';
import type postgres from 'postgres';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { emptyQualification } from '../src/ai/qualification.js';
import { effectiveConfigHash } from '../src/ai/operational-config.js';
import { collectHumanQualificationAnswer } from '../src/ai/human-qualification.js';
import type { Principal } from '../src/security.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Actual Human qualification uses current authorized Fields, typed idempotent concurrent capture, native proof/history/Audit and safe results without conversation or financial mutation', async t => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  const db = createDatabase(url), app = await buildApp(db, { logger: false, globalRateLimitMax: 10000 });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async tx => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
  const org = (await db`INSERT INTO organization(name) VALUES ('Actual qualification') RETURNING id`)[0]!.id,
    foreignOrg = (await db`INSERT INTO organization(name) VALUES ('Other') RETURNING id`)[0]!.id;
  const branch = (await db`INSERT INTO branch(organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id,
    branchB = (await db`INSERT INTO branch(organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const campaign = (await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES (${org},${branch},'A') RETURNING id`)[0]!.id;
  const users: Record<string, { id: string; session: string; cookie: string }> = {};
  for (const [name, role, scope, o] of [['manager', 'MANAGER', branch, org], ['other', 'MANAGER', branchB, org], ['agent', 'AGENT', branch, org], ['second', 'AGENT', branch, org], ['admin', 'SUPER_ADMIN', null, org], ['foreign', 'SUPER_ADMIN', null, foreignOrg]] as const) {
    const id = (await db`INSERT INTO user_account(organization_id,branch_id,name,role,email,password_hash) VALUES (${o},${scope},${name},${role},${name + '@actualqualification.test'},'synthetic-only') RETURNING id`)[0]!.id,
      token = randomBytes(32).toString('hex');
    const session = (await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at) VALUES (${id},${sha256(token)},now()-interval '1 hour',now()+interval '1 hour') RETURNING id`)[0]!.id;
    users[name] = { id, session, cookie: 'lop_session=' + token };
  }
  const contact = (await db`INSERT INTO contact(organization_id,name) VALUES (${org},'Actual Lead') RETURNING id`)[0]!.id;
  const lead = (await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,assigned_agent_id,source_kind)
    VALUES (${org},${branch},${campaign},${contact},${users.agent!.id},'MANUAL') RETURNING id`)[0]!.id as string;
  const field = (await db`INSERT INTO field_definition(organization_id,branch_id,campaign_id,key,label,field_type) VALUES (${org},${branch},${campaign},'interest','Interest','BOOLEAN') RETURNING id`)[0]!.id as string;
  await db`INSERT INTO campaign_field(campaign_id,field_id,usable_by_ai,editable_by_agent) VALUES (${campaign},${field},true,true)`;
  const q = randomUUID(), free = randomUUID(), definition = { ...emptyQualification(), enabled: true,
    questions: [{ id: q, prompt: 'Interest?', fieldId: field, required: true }, { id: free, prompt: 'Availability <img literal>?', fieldId: null, required: true }],
    handoff: { onCompletion: true, match: 'ALL' as const, conditions: [] } };
  const root = '/api/leads/' + lead + '/qualification', config = '/api/ai/campaigns/' + campaign + '/qualification';
  const api = (method: 'GET' | 'PUT', path: string, payload?: object, actor = 'agent') => app.inject({ method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, cookie: users[actor]!.cookie } });
  assert.equal((await api('PUT', config, { version: 0, definition, reason: 'Define actual collection' }, 'manager')).statusCode, 200);
  const input = (value: postgres.JSONValue, answerVersion = 0, fieldValueVersion: number | null = 0, definitionVersion = 1) => ({ requestId: randomUUID(), definitionVersion, answerVersion, fieldValueVersion, value });
  const put = (question: string, body: object, actor = 'agent') => api('PUT', root + '/answers/' + question, body, actor);
  const read = () => api('GET', root);
  const claimedLead = { id: lead, campaign_id: campaign as string, branch_id: branch as string, lifecycle: 'OPEN' };
  const human: Principal = { id: users.agent!.id, organizationId: org, branchId: branch, role: 'AGENT', name: 'agent', email: 'agent@actualqualification.test' };
  // The application service must enforce source authority even when bypassing the HTTP handler.
  await assert.rejects(db.begin(tx => collectHumanQualificationAnswer(tx, { ...human, role: 'SUPER_ADMIN', branchId: null }, claimedLead, users.agent!.session, q, input(false))), /QUALIFICATION_ACCESS_REVOKED/);
  await assert.rejects(db.begin(tx => collectHumanQualificationAnswer(tx, human, claimedLead, randomUUID(), q, input(false))), /QUALIFICATION_ACCESS_REVOKED/);
  await assert.rejects(db.begin(tx => collectHumanQualificationAnswer(tx, { ...human, id: users.second!.id }, claimedLead, users.second!.session, q, input(false))), /QUALIFICATION_ACCESS_REVOKED/);
  await assert.rejects(db.begin(tx => collectHumanQualificationAnswer(tx, human, { ...claimedLead, branch_id: branchB }, users.agent!.session, q, input(false))), /QUALIFICATION_ACCESS_REVOKED/);
  assert.equal((await read()).json().result.complete, false);
  for (const actor of ['second', 'other', 'foreign']) {
    assert.equal((await api('GET', root, undefined, actor)).statusCode, 404);
    assert.equal((await put(q, input(false), actor)).statusCode, 404);
  }
  assert.equal((await put(q, { ...input(false), source: 'AI' })).statusCode, 400);
  const invalidTyped = await put(q, input('yes')); assert.equal(invalidTyped.statusCode, 400, invalidTyped.body);
  assert.equal((await put(q, input(false, 0, null))).statusCode, 409);
  assert.equal((await put(randomUUID(), input('foreign', 0, null))).statusCode, 404);
  const first = input(false), repeated = await Promise.all(Array.from({ length: 8 }, () => put(q, first)));
  for (const response of repeated) assert.equal(response.statusCode, 200, response.body);
  assert.equal(repeated.filter(r => !r.json().duplicate).length, 1);
  const directDuplicates = await Promise.all(Array.from({ length: 8 }, () => db.begin(tx => collectHumanQualificationAnswer(tx, human, claimedLead, users.agent!.session, q, first))));
  assert.ok(directDuplicates.every(r => r.duplicate));
  assert.equal((await db`SELECT count(*)::integer AS n FROM field_value_history WHERE lead_id=${lead}`)[0]!.n, 1);
  assert.equal((await put(q, { ...first, value: true })).statusCode, 409);
  const collected = input(' Available <img literal> ', 0, null), freeResponse = await put(free, collected);
  assert.equal(freeResponse.statusCode, 200, freeResponse.body); assert.equal(freeResponse.json().result.complete, true); assert.equal(freeResponse.json().result.handoff, true);
  assert.equal(freeResponse.json().questions.find((item: { id: string }) => item.id === q).value, false);
  assert.equal((await db`SELECT source FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}`)[0]!.source, 'MANUAL');
  assert.equal((await db`SELECT source FROM lead_qualification_answer WHERE lead_id=${lead} AND question_id=${free}`)[0]!.source, 'HUMAN');
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message`)[0]!.n, 0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM payment_record`)[0]!.n, 0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM enrollment`)[0]!.n, 0);
  // Ordinary Field edits remain authoritative; immutable captured answers do not replace them.
  assert.equal((await api('PUT', '/api/leads/' + lead + '/fields/' + field, { value: true, version: 1 })).statusCode, 200);
  assert.equal((await read()).json().questions.find((item: { id: string }) => item.id === q).value, true);
  assert.equal((await api('GET', root + '/answers/' + q + '/history')).json().items[0].value, false);
  assert.equal((await put(q, input(false, 1, 1))).statusCode, 409);
  const edits = await Promise.all(Array.from({ length: 4 }, () => put(q, input(false, 1, 2))));
  assert.deepEqual(edits.map(r => r.statusCode).sort(), [200, 409, 409, 409]);
  const history = (await api('GET', root + '/answers/' + q + '/history?limit=1')).json();
  assert.equal(history.items[0].version, 2); assert.equal(history.nextVersion, 2);
  assert.equal((await api('GET', root + '/answers/' + q + '/history?before=2')).json().items[0].version, 1);
  assert.equal((await db`SELECT count(*)::integer AS n FROM lead_qualification_request WHERE lead_id=${lead}`)[0]!.n, 3);
  await assert.rejects(db`UPDATE lead_qualification_answer SET value='true' WHERE lead_id=${lead} AND question_id=${q}`, /VERSION_REQUIRED/);
  await assert.rejects(db`UPDATE lead_qualification_answer SET version=version+1 WHERE lead_id=${lead} AND question_id=${q}`, /REQUEST_PROOF_REQUIRED/);
  await assert.rejects(db`UPDATE lead_qualification_answer_history SET snapshot='{}' WHERE lead_id=${lead}`, /HISTORY_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM lead_qualification_answer WHERE lead_id=${lead}`, /HISTORY_RETAINED/);
  await assert.rejects(db`UPDATE lead_qualification_request SET request_hash=${'a'.repeat(64)} WHERE lead_id=${lead}`, /REQUEST_IMMUTABLE/);
  const nativeReceipt = async (question = free, value: unknown = 'native', actor = 'agent', definitionVersion = 1) => db`INSERT INTO lead_qualification_request
    (lead_id,actor_id,session_id,request_id,request_hash,question_id,qualification_version,answer_version,field_value_version,question_snapshot,value)
    VALUES (${lead},${users[actor]!.id},${users[actor]!.session},${randomUUID()},${effectiveConfigHash(value)},${question},${definitionVersion},${question === free ? 2 : 3},${question === free ? null : 3},
    ${db.json(definition.questions.find(item => item.id === question)!)},${db.json(value as postgres.JSONValue)})`;
  await assert.rejects(nativeReceipt(), /ATOMIC_PROOF_REQUIRED/);
  await assert.rejects(nativeReceipt(free, 'native', 'second'), /CURRENT_ACCESS_REQUIRED/);
  await assert.rejects(nativeReceipt(free, 'bad\u0001'), /TEXT_INVALID/);
  await db`UPDATE campaign_field SET editable_by_agent=false WHERE campaign_id=${campaign} AND field_id=${field}`;
  assert.equal((await put(q, input(true, 2, 3))).statusCode, 403);
  await assert.rejects(nativeReceipt(q, true), /CURRENT_FIELD_REQUIRED/);
  await db`UPDATE campaign_field SET visible_to_agent=false WHERE campaign_id=${campaign} AND field_id=${field}`;
  const privateRead = await read(); assert.equal(privateRead.json().result, null); assert.equal(privateRead.json().questions.length, 1);
  assert.ok(!privateRead.body.includes(field)); assert.ok(!privateRead.body.includes('Interest?'));
  assert.deepEqual((await api('GET', root + '/answers/' + q + '/history')).json().items, []);
  assert.equal((await put(q, input(true, 2, 3))).statusCode, 404);
  assert.equal((await api('GET', root, undefined, 'manager')).json().result.complete, true);
  await db`UPDATE campaign_field SET visible_to_agent=true,editable_by_agent=true WHERE campaign_id=${campaign} AND field_id=${field}`;
  await db`UPDATE field_definition SET field_type='NUMBER',version=version+1 WHERE id=${field}`;
  assert.equal((await read()).json().result, null);
  assert.equal((await read()).json().questions.find((item: { id: string }) => item.id === q).editable, true, 'Current invalid value can be corrected by an authorized Human');
  assert.equal((await put(q, input('invalid number', 2, 3))).statusCode, 400);
  await db`UPDATE field_definition SET field_type='BOOLEAN',version=version+1 WHERE id=${field}`;
  await db`UPDATE campaign_field SET usable_by_ai=false WHERE campaign_id=${campaign} AND field_id=${field}`;
  assert.equal((await read()).json().result, null); assert.equal((await put(q, input(true, 2, 3))).statusCode, 403);
  await db`UPDATE campaign_field SET usable_by_ai=true WHERE campaign_id=${campaign} AND field_id=${field}`;
  await db`CREATE FUNCTION synthetic_answer_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='QUALIFICATION_ANSWER_COLLECTED' THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER synthetic_answer_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_answer_audit_failure()`;
  try {
    assert.equal((await put(q, input(true, 2, 3))).statusCode, 500);
    assert.equal((await db`SELECT version FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}`)[0]!.version, 3);
    assert.equal((await db`SELECT count(*)::integer AS n FROM lead_qualification_request WHERE lead_id=${lead}`)[0]!.n, 3);
    assert.equal((await api('GET', root + '/answers/' + q + '/history')).json().items.length, 2);
  } finally { await db`DROP TRIGGER synthetic_answer_audit ON audit_log`; await db`DROP FUNCTION synthetic_answer_audit_failure()`; }
  // Current configuration changes never reinterpret an old free-text answer silently.
  const next = { ...definition, questions: [definition.questions[0]!, { ...definition.questions[1]!, prompt: 'Changed meaning?' }] };
  assert.equal((await api('PUT', config, { version: 1, definition: next, reason: 'Change question meaning' }, 'manager')).statusCode, 200);
  assert.equal((await read()).json().result.complete, false);
  assert.equal((await read()).json().questions.find((item: { id: string }) => item.id === free).value, null);
  assert.equal((await put(free, input('new', 1, null))).statusCode, 409);
  assert.equal((await put(free, collected)).json().duplicate, true, 'Durable retry after configuration change does not mutate current answers');
  assert.equal((await put(free, input('new current', 1, null, 2))).statusCode, 200);
  assert.equal((await api('GET', root + '/answers/' + free + '/history')).json().items[1].value, 'Available <img literal>');
  const reordered = { ...next, questions: [...next.questions].reverse() };
  assert.equal((await api('PUT', config, { version: 2, definition: reordered, reason: 'Reorder without changing question meaning' }, 'manager')).statusCode, 200);
  assert.equal((await read()).json().result.complete, true);
  assert.equal((await read()).json().questions.find((item: { id: string }) => item.id === free).collectedDefinitionVersion, 2);
  assert.equal((await api('PUT', config, { version: 3, definition: { ...reordered, enabled: false }, reason: 'Disable preserves collected answers' }, 'manager')).statusCode, 200);
  assert.equal((await read()).json().questions.find((item: { id: string }) => item.id === free).value, 'new current');
  assert.equal((await put(free, input('new', 2, null, 4))).statusCode, 409);
  assert.equal((await api('GET', root + '/answers/' + free + '/history')).json().items.length, 2);
  assert.equal((await api('PUT', config, { version: 4, definition: reordered, reason: 'Reenable identical question snapshots' }, 'manager')).statusCode, 200);
  assert.equal((await read()).json().result.complete, true);
  await db`UPDATE user_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${users.agent!.session}`;
  assert.equal((await read()).statusCode, 401); await assert.rejects(nativeReceipt(free, 'native', 'agent', 2), /CURRENT_ACCESS_REQUIRED/);
  await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=${users.agent!.session}`;
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.agent!.session}`;
  assert.equal((await read()).statusCode, 401); await assert.rejects(nativeReceipt(free, 'native', 'agent', 2), /CURRENT_ACCESS_REQUIRED/);
  await db`UPDATE user_session SET revoked_at=NULL WHERE id=${users.agent!.session}`;
  await db`UPDATE lead SET assigned_agent_id=${users.second!.id} WHERE id=${lead}`;
  assert.equal((await put(free, collected)).statusCode, 404); assert.equal((await api('GET', root + '/answers/' + free + '/history')).statusCode, 404);
  await db`UPDATE lead SET assigned_agent_id=${users.agent!.id} WHERE id=${lead}`;
  const fieldRace = await Promise.all([
    api('PUT', '/api/leads/' + lead + '/fields/' + field, { value: true, version: 3 }),
    put(q, input(true, 2, 3, 5)),
  ]);
  assert.deepEqual(fieldRace.map(r => r.statusCode).sort(), [200, 409], 'Ordinary Field and Qualification concurrent writes share the same current-value CAS');
  assert.equal((await db`SELECT version FROM lead_field_value WHERE lead_id=${lead} AND field_id=${field}`)[0]!.version, 4);
  await db`UPDATE branch SET active=false WHERE id=${branch}`;
  assert.equal((await read()).json().result, null); assert.equal((await put(free, input('new', 2, null, 2))).statusCode, 409);
  await assert.rejects(nativeReceipt(free, 'native', 'agent', 2), /CURRENT_ACCESS_REQUIRED/);
  assert.ok((await db`SELECT detail FROM audit_log WHERE action='QUALIFICATION_ANSWER_COLLECTED'` ).every(row => !Object.hasOwn(row.detail, 'value')));
  // Qualification must support the platform's actual LONG_TEXT limit, including UTF-8 byte expansion.
  await db`UPDATE branch SET active=true WHERE id=${branch}`;
  const longField = (await db`INSERT INTO field_definition(organization_id,branch_id,campaign_id,key,label,field_type) VALUES (${org},${branch},${campaign},'long_answer','Long answer','LONG_TEXT') RETURNING id`)[0]!.id;
  await db`INSERT INTO campaign_field(campaign_id,field_id,usable_by_ai,editable_by_agent) VALUES (${campaign},${longField},true,true)`;
  const longQuestion = randomUUID(), withLong = { ...reordered, questions: [...reordered.questions, { id: longQuestion, prompt: 'Long collected detail?', fieldId: longField, required: false }] };
  assert.equal((await api('PUT', config, { version: 5, definition: withLong, reason: 'Allow valid platform long text' }, 'manager')).statusCode, 200);
  const longResponse = await put(longQuestion, input('ع'.repeat(20000), 0, 0, 6));
  assert.equal(longResponse.statusCode, 200, longResponse.body);
  assert.equal((await db`SELECT value FROM lead_field_value WHERE lead_id=${lead} AND field_id=${longField}`)[0]!.value.length, 20000);
  assert.equal((await put(longQuestion, input('x'.repeat(20001), 1, 1, 6))).statusCode, 400);
  assert.equal((await put(longQuestion, input('bad\u0000', 1, 1, 6))).statusCode, 400);
  assert.equal((await put(longQuestion, input('\ud800', 1, 1, 6))).statusCode, 400);
  assert.equal((await put(longQuestion, input('x'.repeat(140000), 1, 1, 6))).statusCode, 413);
});
