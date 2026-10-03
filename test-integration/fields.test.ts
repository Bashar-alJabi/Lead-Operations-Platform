import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { passwordHash } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('TEST_DATABASE_URL must target lead_operations_test');

test('dynamic field definitions, bindings, values, history, and role scope', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  const db = createDatabase(url);
  const app = await buildApp(db, { logger: false });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE organization CASCADE`; });
  const send = async (method: 'GET'|'POST'|'PUT'|'PATCH', path: string, payload?: Record<string, unknown>, cookie?: string) => app.inject({
    method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, ...(cookie ? { cookie } : {}) },
  });
  const login = async (email: string) => {
    const response = await send('POST', '/api/auth/login', { email, password: 'Field test password 123!' });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.headers['set-cookie'];
    return (Array.isArray(cookie) ? cookie[0]! : cookie!).split(';')[0]!;
  };
  const bootstrap = await send('POST', '/api/setup/bootstrap', { token: process.env.BOOTSTRAP_TOKEN, organizationName: 'Fields',
    name: 'Owner', email: 'owner@example.test', password: 'Field test password 123!' });
  assert.equal(bootstrap.statusCode, 201, bootstrap.body);
  const admin = await login('owner@example.test');
  const branchA = (await send('POST', '/api/branches', { name: 'A', timezone: 'UTC' }, admin)).json().id as string;
  const branchB = (await send('POST', '/api/branches', { name: 'B', timezone: 'UTC' }, admin)).json().id as string;
  const organizationId = (await db`SELECT id FROM organization LIMIT 1`)[0]!.id as string;
  const hashed = await passwordHash('Field test password 123!');
  await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash)
    VALUES (${organizationId}, ${branchA}, 'MANAGER', 'Manager A', 'manager-a@example.test', ${hashed}),
      (${organizationId}, ${branchB}, 'MANAGER', 'Manager B', 'manager-b@example.test', ${hashed}),
      (${organizationId}, ${branchA}, 'AGENT', 'Agent A', 'agent-a@example.test', ${hashed})`;
  const managerA = await login('manager-a@example.test');
  const managerB = await login('manager-b@example.test');
  const agent = await login('agent-a@example.test');
  const campaign = (await send('POST', '/api/campaigns', { branchId: branchA, name: 'Field campaign', routingMethod: 'ROUND_ROBIN' }, managerA)).json().id as string;
  const agentId = (await db`SELECT id FROM user_account WHERE email = 'agent-a@example.test'`)[0]!.id as string;
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/agents`, { agentId }, managerA)).statusCode, 200);
  assert.equal((await send('POST', `/api/campaigns/${campaign}/activate`, undefined, managerA)).statusCode, 200);

  const globalInput = { scope: 'GLOBAL', key: 'company_source', label: 'Company source', fieldType: 'TEXT', valueMode: 'MANUAL', options: [], validation: {} };
  assert.equal((await send('POST', '/api/fields', globalInput, managerA)).statusCode, 403);
  assert.equal((await send('POST', '/api/fields', globalInput, admin)).statusCode, 201);
  const branchInput = { scope: 'BRANCH', branchId: branchA, key: 'internal_note', label: 'Internal note', fieldType: 'TEXT', valueMode: 'MANUAL', options: [], validation: {} };
  assert.equal((await send('POST', '/api/fields', branchInput, managerB)).statusCode, 403);
  const branchField = await send('POST', '/api/fields', branchInput, managerA);
  assert.equal(branchField.statusCode, 201, branchField.body);
  assert.equal((await send('POST', '/api/fields', branchInput, managerA)).statusCode, 409);
  assert.ok(!(await send('GET', '/api/fields', undefined, managerB)).json().items.some((item: { id: string }) => item.id === branchField.json().id));
  const scratch = await send('POST', '/api/fields', { ...branchInput, key: 'scratch', label: 'Scratch' }, managerA);
  assert.equal(scratch.statusCode, 201, scratch.body);
  const scratchId = scratch.json().id as string;
  const retyped = await send('PATCH', `/api/fields/${scratchId}`, { version: 1, label: 'Scratch number', options: [], validation: {}, active: true,
    fieldType: 'NUMBER', valueMode: 'MANUAL', calculation: null }, managerA);
  assert.equal(retyped.statusCode, 200, retyped.body);
  assert.equal((await send('PATCH', `/api/fields/${scratchId}`, { version: 1, label: 'Stale', options: [], validation: {}, active: true }, managerA)).statusCode, 409);
  const hiddenId = branchField.json().id as string;
  const selectInput = { scope: 'CAMPAIGN', branchId: branchA, campaignId: campaign, key: 'interest', label: 'Interest',
    fieldType: 'SINGLE_SELECT', valueMode: 'MANUAL', options: [{ value: 'high', label: 'High', active: true }], validation: {} };
  const selectField = await send('POST', '/api/fields', selectInput, managerA);
  assert.equal(selectField.statusCode, 201, selectField.body);
  const selectId = selectField.json().id as string;
  const calculationInput = { scope: 'CAMPAIGN', branchId: branchA, campaignId: campaign, key: 'lead_age_days', label: 'Lead age',
    fieldType: 'CALCULATED', valueMode: 'CALCULATED', options: [], validation: {}, calculation: { kind: 'LEAD_AGE_DAYS' } };
  const calculatedId = (await send('POST', '/api/fields', calculationInput, managerA)).json().id as string;
  assert.equal((await send('GET', `/api/fields?campaignId=${campaign}`, undefined, managerB)).statusCode, 404);
  assert.equal((await send('GET', `/api/fields?campaignId=${campaign}`, undefined, agent)).statusCode, 403);
  const binding = { active: true, position: 1, requiredStage: 'NONE', visibleToAgent: true, editableByAgent: true,
    visibleToManager: true, editableByManager: true, showInTable: true, showInDetails: true, filterable: true,
    usableByAutomation: false, usableByAi: false };
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${selectId}`, binding, managerB)).statusCode, 403);
  const bound = await send('PUT', `/api/campaigns/${campaign}/fields/${selectId}`, binding, managerA);
  assert.equal(bound.statusCode, 200, bound.body);
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${selectId}`, binding, managerA)).statusCode, 409);
  assert.equal((await send('PATCH', `/api/fields/${selectId}`, { version: 1, label: 'Changed type', options: [], validation: {}, active: true,
    fieldType: 'TEXT', valueMode: 'MANUAL', calculation: null }, managerA)).statusCode, 409);
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${hiddenId}`,
    { ...binding, position: 2, visibleToAgent: false, editableByAgent: false }, managerA)).statusCode, 200);
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${calculatedId}`,
    { ...binding, position: 3, editableByAgent: false, editableByManager: false }, managerA)).statusCode, 200);
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${calculatedId}`, { ...binding, version: 1 }, managerA)).statusCode, 400);

  const lead = await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Field lead', phone: '+15550000123' } }, managerA);
  assert.equal(lead.statusCode, 201, lead.body);
  const leadId = lead.json().id as string;
  const agentFields = await send('GET', `/api/leads/${leadId}/fields`, undefined, agent);
  assert.equal(agentFields.statusCode, 200, agentFields.body);
  assert.deepEqual(new Set(agentFields.json().items.map((field: { id: string }) => field.id)), new Set([selectId, calculatedId]));
  const calculated = agentFields.json().items.find((field: { id: string }) => field.id === calculatedId);
  assert.equal(calculated.value, 0);
  assert.equal(calculated.editable, false);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${hiddenId}`, { value: 'Secret' }, agent)).statusCode, 404);
  assert.equal((await send('GET', `/api/leads/${leadId}/fields/${hiddenId}/history`, undefined, agent)).statusCode, 404);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${calculatedId}`, { value: 99 }, managerA)).statusCode, 403);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${selectId}`, { value: 'invalid' }, agent)).statusCode, 400);
  const firstValue = await send('PUT', `/api/leads/${leadId}/fields/${selectId}`, { value: 'high' }, agent);
  assert.equal(firstValue.statusCode, 200, firstValue.body);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${selectId}`, { value: 'high' }, agent)).statusCode, 409);
  const nextValue = await send('PUT', `/api/leads/${leadId}/fields/${selectId}`, { value: null, version: firstValue.json().version }, agent);
  assert.equal(nextValue.statusCode, 200, nextValue.body);
  const valueRace = await Promise.all([1, 2].map(() => send('PUT', `/api/leads/${leadId}/fields/${selectId}`,
    { value: 'high', version: nextValue.json().version }, agent)));
  assert.deepEqual(valueRace.map((response) => response.statusCode).sort(), [200, 409]);
  const history = await send('GET', `/api/leads/${leadId}/fields/${selectId}/history?limit=1`, undefined, agent);
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items.length, 1);
  assert.ok(history.json().nextCursor);
  assert.equal((await send('GET', `/api/leads/${leadId}/fields/${selectId}/history?limit=1&cursor=${history.json().nextCursor}`, undefined, agent)).json().items.length, 1);
  assert.equal((await send('PATCH', `/api/fields/${selectId}`, { version: 1, label: 'Interest', options: [{ value: 'low', label: 'Low', active: true }],
    validation: {}, active: true }, managerA)).statusCode, 409);
  assert.equal((await send('GET', `/api/leads/${leadId}/fields`, undefined, managerB)).statusCode, 404);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${selectId}`, { value: 'high', version: nextValue.json().version }, managerB)).statusCode, 404);
  assert.equal((await db`SELECT count(*)::integer AS count FROM field_value_history WHERE lead_id = ${leadId} AND field_id = ${selectId}`)[0]!.count, 3);

  const required = await send('POST', '/api/fields', { scope: 'CAMPAIGN', branchId: branchA, campaignId: campaign,
    key: 'registration_code', label: 'Registration code', fieldType: 'TEXT', valueMode: 'MANUAL', options: [], validation: { minLength: 3 } }, managerA);
  assert.equal(required.statusCode, 201, required.body);
  const requiredId = required.json().id as string;
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${requiredId}`,
    { ...binding, position: 4, requiredStage: 'LEAD_CREATION' }, managerA)).statusCode, 200);
  assert.equal((await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Missing required', phone: '+15550000124' } }, managerA)).statusCode, 409);
  const populated = await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Populated', phone: '+15550000124' }, fields: [{ fieldId: requiredId, value: 'ABC' }] }, managerA);
  assert.equal(populated.statusCode, 201, populated.body);
  assert.equal((await db`SELECT value FROM lead_field_value WHERE lead_id = ${populated.json().id} AND field_id = ${requiredId}`)[0]!.value, 'ABC');
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${requiredId}`, { value: 'x' }, agent)).statusCode, 400);
  const emailCandidate = await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Email candidate', email: 'fields-review@example.test' }, fields: [{ fieldId: requiredId, value: 'EMAIL' }] }, managerA);
  assert.equal(emailCandidate.statusCode, 201, emailCandidate.body);
  const review = await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Ambiguous fields', phone: '+15550000124', email: 'fields-review@example.test' },
    fields: [{ fieldId: requiredId, value: 'REVIEW' }] }, managerA);
  assert.equal(review.statusCode, 202, review.body);
  const reviewContactId = (await db`SELECT contact_id FROM lead WHERE id = ${populated.json().id}`)[0]!.contact_id as string;
  const reviewed = await send('POST', `/api/contact-reviews/${review.json().reviewId}/resolve`, { contactId: reviewContactId }, managerA);
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal((await db`SELECT value FROM lead_field_value WHERE lead_id = ${reviewed.json().id} AND field_id = ${requiredId}`)[0]!.value, 'REVIEW');

  const closeRequired = await send('POST', '/api/fields', { scope: 'CAMPAIGN', branchId: branchA, campaignId: campaign,
    key: 'outcome', label: 'Outcome', fieldType: 'TEXT', valueMode: 'MANUAL', options: [], validation: {} }, managerA);
  const closeId = closeRequired.json().id as string;
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${closeId}`,
    { ...binding, position: 5, requiredStage: 'CLOSE' }, managerA)).statusCode, 200);
  assert.equal((await send('POST', `/api/leads/${leadId}/lifecycle`, { lifecycle: 'CLOSED' }, managerA)).statusCode, 409);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${closeId}`, { value: 'Qualified' }, agent)).statusCode, 200);
  assert.equal((await send('POST', `/api/leads/${leadId}/lifecycle`, { lifecycle: 'CLOSED' }, managerA)).statusCode, 200);
  assert.equal((await send('PUT', `/api/leads/${leadId}/fields/${closeId}`, { value: null, version: 1 }, agent)).statusCode, 409);

  const metricIds: Record<string, string> = {};
  for (const [key, kind] of [['ai_attempts','AI_CONTACT_ATTEMPTS'], ['human_attempts','HUMAN_CONTACT_ATTEMPTS'],
    ['human_response_seconds','HUMAN_RESPONSE_SECONDS']] as const) {
    const created = await send('POST', '/api/fields', { scope: 'CAMPAIGN', branchId: branchA, campaignId: campaign,
      key, label: key, fieldType: 'CALCULATED', valueMode: 'CALCULATED', options: [], validation: {}, calculation: { kind } }, managerA);
    assert.equal(created.statusCode, 201, created.body);
    metricIds[key] = created.json().id;
    assert.equal((await send('PUT', `/api/campaigns/${campaign}/fields/${metricIds[key]}`,
      { ...binding, position: 10, editableByAgent: false, editableByManager: false }, managerA)).statusCode, 200);
  }
  const connection = await db`INSERT INTO integration_connection (organization_id, branch_id, kind, provider, name, status)
    VALUES (${organizationId}, ${branchA}, 'MESSAGING', 'FAKE', 'Test', 'CONNECTED') RETURNING id`;
  const sender = await db`INSERT INTO messaging_sender (organization_id, connection_id, external_sender_id, display_name)
    VALUES (${organizationId}, ${connection[0]!.id}, 'test-sender', 'Test sender') RETURNING id`;
  const conversation = await db`INSERT INTO conversation (lead_id, connection_id, sender_id, channel, participant_ref, controller_type,
    controller_user_id, state) VALUES (${leadId}, ${connection[0]!.id}, ${sender[0]!.id}, 'TEST', 'participant', 'HUMAN', ${agentId}, 'HUMAN_ACTIVE') RETURNING id`;
  const base = Date.now();
  const firstAi = new Date(base - 3 * 3600_000);
  const firstHuman = new Date(base - 2 * 3600_000);
  const inbound = new Date(base - 3600_000);
  const reply = new Date(base - 3000_000);
  await db`INSERT INTO conversation_message (conversation_id, connection_id, sender_id, direction, author_type, body, delivery_state, sent_at)
    VALUES (${conversation[0]!.id}, ${connection[0]!.id}, ${sender[0]!.id}, 'OUTBOUND', 'AI', 'AI initial', 'SENT', ${firstAi}),
      (${conversation[0]!.id}, ${connection[0]!.id}, ${sender[0]!.id}, 'OUTBOUND', 'HUMAN', 'Human initial', 'SENT', ${firstHuman}),
      (${conversation[0]!.id}, ${connection[0]!.id}, ${sender[0]!.id}, 'OUTBOUND', 'HUMAN', 'Human reply', 'SENT', ${reply})`;
  await db`INSERT INTO conversation_message (conversation_id, connection_id, sender_id, direction, author_type, body, delivery_state, received_at)
    VALUES (${conversation[0]!.id}, ${connection[0]!.id}, ${sender[0]!.id}, 'INBOUND', 'CUSTOMER', 'Question', 'RECEIVED', ${inbound})`;
  const metrics = (await send('GET', `/api/leads/${leadId}/fields`, undefined, agent)).json().items;
  assert.equal(metrics.find((item: { id: string }) => item.id === metricIds.ai_attempts).value, 1);
  assert.equal(metrics.find((item: { id: string }) => item.id === metricIds.human_attempts).value, 2);
  assert.equal(metrics.find((item: { id: string }) => item.id === metricIds.human_response_seconds).value, 600);
});
