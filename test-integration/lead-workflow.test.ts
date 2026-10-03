import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { passwordHash } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Lead assignment, notes, and human follow-up preserve history and permissions', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  const db = createDatabase(url);
  const app = await buildApp(db, { logger: false });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE organization CASCADE`; });
  const send = async (method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', path: string, body?: object, cookie?: string) => app.inject({
    method, url: path, payload: body, headers: { origin: process.env.APP_ORIGIN!, ...(cookie ? { cookie } : {}) },
  });
  const password = 'Test password 12345!';
  assert.equal((await send('POST', '/api/setup/bootstrap', { token: process.env.BOOTSTRAP_TOKEN,
    organizationName: 'Workflow Test', name: 'Owner', email: 'owner@example.test', password })).statusCode, 201);
  const login = async (email: string) => {
    const response = await send('POST', '/api/auth/login', { email, password });
    assert.equal(response.statusCode, 200, response.body);
    return (response.headers['set-cookie'] as string).split(';')[0]!;
  };
  const admin = await login('owner@example.test');
  const branchA = (await send('POST', '/api/branches', { name: 'A', timezone: 'UTC' }, admin)).json().id as string;
  const branchB = (await send('POST', '/api/branches', { name: 'B', timezone: 'UTC' }, admin)).json().id as string;
  const organizationId = (await db`SELECT id FROM organization LIMIT 1`)[0]!.id as string;
  const hash = await passwordHash(password);
  const createUser = async (branchId: string, role: 'MANAGER'|'AGENT', email: string) => {
    const rows = await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash)
      VALUES (${organizationId}, ${branchId}, ${role}, ${email}, ${email}, ${hash}) RETURNING id`;
    return rows[0]!.id as string;
  };
  await createUser(branchA, 'MANAGER', 'manager-a@example.test');
  await createUser(branchB, 'MANAGER', 'manager-b@example.test');
  const agent1Id = await createUser(branchA, 'AGENT', 'agent-1@example.test');
  const agent2Id = await createUser(branchA, 'AGENT', 'agent-2@example.test');
  const foreignAgentId = await createUser(branchB, 'AGENT', 'agent-b@example.test');
  const managerA = await login('manager-a@example.test');
  const managerB = await login('manager-b@example.test');
  const agent1 = await login('agent-1@example.test');
  const agent2 = await login('agent-2@example.test');
  const campaign = (await send('POST', '/api/campaigns', { branchId: branchA, name: 'Campaign', routingMethod: 'ROUND_ROBIN' }, managerA)).json().id as string;
  assert.equal((await send('PUT', `/api/campaigns/${campaign}/agents`, { agentId: agent1Id }, managerA)).statusCode, 200);
  assert.equal((await send('POST', `/api/campaigns/${campaign}/activate`, undefined, managerA)).statusCode, 200);
  const intake = await send('POST', '/api/leads', { branchId: branchA, campaignId: campaign,
    contact: { name: 'Customer', phone: '+15550001111' } }, managerA);
  assert.equal(intake.statusCode, 201, intake.body);
  const leadId = intake.json().id as string;
  assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id = ${leadId}`)[0]!.assigned_agent_id, agent1Id);

  assert.equal((await send('POST', `/api/leads/${leadId}/notes`, { text: ' <b>internal</b> ' }, agent1)).statusCode, 201);
  assert.equal((await send('POST', `/api/leads/${leadId}/notes`, { text: '   ' }, agent1)).statusCode, 400);
  assert.equal((await send('POST', `/api/leads/${leadId}/notes`, { text: 'Denied' }, agent2)).statusCode, 404);
  const activities = await send('GET', `/api/leads/${leadId}/activity?limit=1`, undefined, agent1);
  assert.equal(activities.json().items[0].detail.text, '<b>internal</b>');
  assert.ok(activities.json().nextCursor);
  assert.equal((await send('GET', `/api/leads/${leadId}/activity`, undefined, agent2)).statusCode, 404);
  const dueAt = new Date(Date.now() + 3600_000).toISOString();
  assert.equal((await send('POST', `/api/leads/${leadId}/followups`, { dueAt, ownerUserId: agent2Id }, agent1)).statusCode, 403);
  assert.equal((await send('POST', `/api/leads/${leadId}/followups`, { dueAt }, managerB)).statusCode, 404);
  const taskResponse = await send('POST', `/api/leads/${leadId}/followups`, { dueAt, note: 'Call customer', priority: 'HIGH' }, agent1);
  assert.equal(taskResponse.statusCode, 201, taskResponse.body);
  const taskId = taskResponse.json().id as string;
  assert.equal((await send('GET', '/api/followups', undefined, agent1)).json().items[0].id, taskId);
  assert.deepEqual((await send('GET', '/api/followups', undefined, agent2)).json().items, []);
  assert.deepEqual((await send('GET', '/api/followups', undefined, managerB)).json().items, []);
  assert.equal((await send('GET', `/api/leads/${leadId}/followups`, undefined, agent1)).json().items[0].priority, 'HIGH');
  assert.equal((await send('GET', '/api/leads?q=customer', undefined, managerA)).json().items[0].id, leadId);
  assert.equal((await send('GET', `/api/leads?q=${leadId}`, undefined, managerA)).json().items[0].id, leadId);
  assert.equal((await send('GET', '/api/leads?q=%2B15550001111', undefined, managerA)).json().items[0].id, leadId);
  assert.deepEqual((await send('GET', '/api/leads?q=customer', undefined, managerB)).json().items, []);
  assert.equal((await send('GET', '/api/leads?followup=UPCOMING', undefined, agent1)).json().items[0].id, leadId);
  assert.deepEqual((await send('GET', '/api/leads?followup=NONE', undefined, managerA)).json().items, []);
  assert.equal((await send('GET', '/api/leads?from=2027-01-01T00:00:00Z', undefined, managerA)).json().items.length, 0);
  assert.equal((await send('GET', '/api/leads?from=2027-01-01T00:00:00Z&to=2026-01-01T00:00:00Z', undefined, managerA)).statusCode, 400);
  const field = await db`INSERT INTO field_definition (organization_id, branch_id, campaign_id, key, label, field_type)
    VALUES (${organizationId}, ${branchA}, ${campaign}, 'segment', 'Segment', 'TEXT') RETURNING id`;
  const fieldId = field[0]!.id as string;
  await db`INSERT INTO campaign_field (campaign_id, field_id, filterable, visible_to_agent, editable_by_agent)
    VALUES (${campaign}, ${fieldId}, true, false, false)`;
  await db`INSERT INTO lead_field_value (lead_id, field_id, value, source)
    VALUES (${leadId}, ${fieldId}, ${db.json('VIP')}, 'MANUAL')`;
  const fieldSearch = `/api/leads?campaignId=${campaign}&fieldId=${fieldId}&fieldValue=${encodeURIComponent(JSON.stringify('VIP'))}`;
  const fieldResult = await send('GET', fieldSearch, undefined, managerA);
  assert.equal(fieldResult.statusCode, 200, fieldResult.body);
  assert.equal(fieldResult.json().items[0].id, leadId);
  assert.equal((await send('GET', fieldSearch, undefined, agent1)).statusCode, 404);
  const viewFilters = { campaignId: campaign, fieldId, fieldValue: JSON.stringify('VIP') };
  const personalView = { name: 'VIP', scope: 'PERSONAL', filters: viewFilters, columns: [] };
  assert.equal((await send('POST', '/api/lead-views', personalView, agent1)).statusCode, 404);
  assert.equal((await send('GET', `/api/leads?fieldId=${fieldId}&fieldValue=%22VIP%22`, undefined, managerA)).statusCode, 400);
  assert.deepEqual((await send('GET', `/api/campaigns/${campaign}/filter-fields`, undefined, agent1)).json().items, []);
  assert.equal((await send('GET', `/api/campaigns/${campaign}/filter-fields`, undefined, managerB)).statusCode, 404);
  await db`UPDATE campaign_field SET visible_to_agent = true WHERE campaign_id = ${campaign} AND field_id = ${fieldId}`;
  assert.equal((await send('GET', fieldSearch, undefined, agent1)).json().items[0].id, leadId);
  assert.equal((await send('POST', '/api/lead-views', { ...personalView,
    filters: { ...viewFilters, fieldValue: 'not json' } }, agent1)).statusCode, 400);
  assert.equal((await send('POST', '/api/lead-views', { ...personalView,
    filters: { ...viewFilters, fieldValue: JSON.stringify(45) } }, agent1)).statusCode, 400);
  const agentView = await send('POST', '/api/lead-views', personalView, agent1);
  assert.equal(agentView.statusCode, 201, agentView.body);
  const agentViewId = agentView.json().id as string;
  assert.equal((await send('POST', '/api/lead-views', personalView, agent1)).statusCode, 409);
  assert.equal((await send('POST', '/api/lead-views', { ...personalView, scope: 'BRANCH' }, agent1)).statusCode, 403);
  assert.equal((await send('POST', '/api/lead-views', { ...personalView, scope: 'ORGANIZATION' }, managerA)).statusCode, 403);
  const branchView = await send('POST', '/api/lead-views', { name: 'Branch VIP', scope: 'BRANCH',
    filters: viewFilters, columns: ['contact'] }, managerA);
  assert.equal(branchView.statusCode, 201, branchView.body);
  const branchViewId = branchView.json().id as string;
  assert.deepEqual((await send('GET', '/api/lead-views', undefined, managerB)).json().items, []);
  assert.equal((await send('GET', '/api/lead-views', undefined, managerA)).json().items.some((item: { id: string }) =>
    item.id === branchViewId), true);
  const orgView = await send('POST', '/api/lead-views', { name: 'All', scope: 'ORGANIZATION',
    filters: {}, columns: [] }, admin);
  assert.equal(orgView.statusCode, 201, orgView.body);
  assert.equal((await send('GET', '/api/lead-views', undefined, managerB)).json().items.some((item: { id: string }) =>
    item.id === orgView.json().id), true);
  assert.equal((await send('PATCH', `/api/lead-views/${branchViewId}`, { name: 'Changed', scope: 'BRANCH',
    filters: viewFilters, columns: [], version: 1 }, managerB)).statusCode, 404);
  assert.equal((await send('PATCH', `/api/lead-views/${agentViewId}`, { ...personalView, version: 2 }, agent1)).statusCode, 409);
  const changedView = await send('PATCH', `/api/lead-views/${agentViewId}`, { ...personalView,
    name: 'VIP leads', version: 1 }, agent1);
  assert.equal(changedView.statusCode, 200, changedView.body);
  assert.equal(changedView.json().version, 2);
  assert.equal((await send('DELETE', `/api/lead-views/${agentViewId}`, undefined, agent2)).statusCode, 404);
  assert.equal((await send('GET', fieldSearch, undefined, agent1)).json().items[0].id, leadId);
  assert.equal((await send('PATCH', `/api/followups/${taskId}`, { version: 1, status: 'CANCELLED' }, agent1)).statusCode, 403);
  assert.equal((await send('PATCH', `/api/followups/${taskId}`, { version: 1, note: 'Denied' }, agent2)).statusCode, 404);
  const patch = await send('PATCH', `/api/followups/${taskId}`, { version: 1, note: 'Updated' }, agent1);
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal((await send('PATCH', `/api/followups/${taskId}`, { version: 1, note: 'Stale' }, agent1)).statusCode, 409);
  const second = await send('POST', `/api/leads/${leadId}/followups`, { dueAt }, managerA);
  assert.equal(second.statusCode, 201, second.body);
  const secondId = second.json().id as string;
  const page = await send('GET', `/api/leads/${leadId}/followups?limit=1`, undefined, managerA);
  assert.ok(page.json().nextCursor);
  assert.equal((await send('GET', `/api/leads/${leadId}/followups?limit=1&cursor=${encodeURIComponent(page.json().nextCursor)}`,
    undefined, managerA)).json().items.length, 1);

  const connection = await db`INSERT INTO integration_connection (organization_id, branch_id, kind, provider, name)
    VALUES (${organizationId}, ${branchA}, 'MESSAGING', 'FAKE', 'test') RETURNING id`;
  const sender = await db`INSERT INTO messaging_sender (organization_id, connection_id, external_sender_id, display_name)
    VALUES (${organizationId}, ${connection[0]!.id}, 'fake-1', 'Fake') RETURNING id`;
  const conversation = await db`INSERT INTO conversation (lead_id, connection_id, sender_id, channel, participant_ref,
    controller_type, controller_user_id, state) VALUES (${leadId}, ${connection[0]!.id}, ${sender[0]!.id}, 'TEST',
      'customer-1', 'HUMAN', ${agent1Id}, 'HUMAN_ACTIVE') RETURNING id`;
  const leadVersion = (await send('GET', `/api/leads/${leadId}`, undefined, managerA)).json().lead.version as number;
  assert.equal((await send('POST', `/api/leads/${leadId}/assignment`, { version: leadVersion, agentId: foreignAgentId }, managerA)).statusCode, 400);
  assert.equal((await send('POST', `/api/leads/${leadId}/assignment`, { version: leadVersion, agentId: agent2Id }, agent1)).statusCode, 403);
  assert.equal((await send('POST', `/api/leads/${leadId}/assignment`, { version: leadVersion, agentId: agent2Id }, managerB)).statusCode, 404);
  const assigned = await send('POST', `/api/leads/${leadId}/assignment`, { version: leadVersion, agentId: agent2Id, reason: 'Workload' }, managerA);
  assert.equal(assigned.statusCode, 200, assigned.body);
  assert.equal((await send('POST', `/api/leads/${leadId}/assignment`, { version: leadVersion, agentId: agent1Id }, managerA)).statusCode, 409);
  assert.equal((await send('GET', `/api/leads/${leadId}`, undefined, agent1)).statusCode, 404);
  assert.deepEqual((await send('GET', fieldSearch, undefined, agent1)).json().items, []);
  assert.equal((await send('GET', '/api/lead-views', undefined, agent1)).json().items.some((item: { id: string }) =>
    item.id === agentViewId), true);
  assert.equal((await send('DELETE', `/api/lead-views/${agentViewId}`, undefined, agent1)).statusCode, 200);
  assert.equal((await send('GET', '/api/lead-views', undefined, agent1)).json().items.some((item: { id: string }) =>
    item.id === agentViewId), false);
  assert.equal((await send('GET', `/api/leads/${leadId}`, undefined, agent2)).statusCode, 200);
  assert.equal((await send('PATCH', `/api/followups/${taskId}`, { version: patch.json().version, status: 'COMPLETED' }, agent1)).statusCode, 404);
  const movedTasks = await db`SELECT id, owner_user_id FROM follow_up WHERE lead_id = ${leadId} ORDER BY id`;
  assert.deepEqual(movedTasks.map((row) => row.owner_user_id), [agent2Id, agent2Id]);
  assert.equal((await db`SELECT controller_user_id FROM conversation WHERE id = ${conversation[0]!.id}`)[0]!.controller_user_id, agent2Id);
  const assignmentHistory = await send('GET', `/api/leads/${leadId}/assignments`, undefined, agent2);
  assert.equal(assignmentHistory.statusCode, 200);
  assert.equal(assignmentHistory.json().items[0].old_agent_id, agent1Id);
  assert.equal(assignmentHistory.json().items[0].new_agent_id, agent2Id);
  assert.equal((await send('GET', `/api/followups/${taskId}/history`, undefined, agent2)).json().items[0].event_type,
    'OWNER_CHANGED_BY_REASSIGNMENT');
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_handoff WHERE conversation_id = ${conversation[0]!.id}`)[0]!.n, 1);
  const completed = await send('PATCH', `/api/followups/${taskId}`, { version: patch.json().version + 1, status: 'COMPLETED' }, agent2);
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal((await send('PATCH', `/api/followups/${taskId}`, { version: completed.json().version, note: 'Too late' }, agent2)).statusCode, 409);
  const cancelled = await send('PATCH', `/api/followups/${secondId}`, { version: 2, status: 'CANCELLED' }, managerA);
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE target_id = ${leadId} AND action = 'LEAD_REASSIGNED'`)[0]!.n, 1);
});
