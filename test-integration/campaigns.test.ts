import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { passwordHash } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Campaign configuration, readiness, scope, concurrency, and history on PostgreSQL', async (t) => {
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
  const bootstrap = await send('POST', '/api/setup/bootstrap', {
    token: process.env.BOOTSTRAP_TOKEN, organizationName: 'Campaign Test', name: 'Owner', email: 'owner@example.test', password,
  });
  assert.equal(bootstrap.statusCode, 201, bootstrap.body);
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
  const agentA = await createUser(branchA, 'AGENT', 'agent-a@example.test');
  const agentB = await createUser(branchB, 'AGENT', 'agent-b@example.test');
  const managerA = await login('manager-a@example.test');
  const managerB = await login('manager-b@example.test');
  const agent = await login('agent-a@example.test');

  assert.equal((await send('POST', '/api/campaigns', { branchId: branchA, name: ' ' }, managerA)).statusCode, 400);
  assert.equal((await send('POST', '/api/campaigns', { branchId: branchA, name: 'X', sourceKind: 'bad' }, managerA)).statusCode, 400);
  const created = await send('POST', '/api/campaigns', { branchId: branchA, name: 'Autumn' }, managerA);
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  for (const path of [`/api/campaigns/${id}`, `/api/campaigns/${id}/readiness`]) {
    assert.equal((await send('GET', path, undefined, managerB)).statusCode, 403);
    assert.equal((await send('GET', path, undefined, agent)).statusCode, 403);
  }
  assert.equal((await send('GET', `/api/campaigns/${id}/eligible-agents`, undefined, managerB)).statusCode, 403);
  assert.equal((await send('GET', `/api/campaigns/${id}/eligible-agents`, undefined, agent)).statusCode, 403);
  const eligible = await send('GET', `/api/campaigns/${id}/eligible-agents?q=agent-a`, undefined, managerA);
  assert.deepEqual(eligible.json().items.map((item: { id: string }) => item.id), [agentA]);
  assert.deepEqual((await send('GET', `/api/campaigns/${id}/eligible-agents?q=agent-b`, undefined, managerA)).json().items, []);
  assert.equal((await send('GET', `/api/campaigns/${id}/readiness`, undefined, managerA)).json().ready, true);
  assert.equal((await send('GET', '/api/campaigns?branchId=' + branchB, undefined, managerA)).statusCode, 403);
  assert.deepEqual((await send('GET', '/api/campaigns', undefined, managerB)).json().items, []);
  const initialVersion = (await send('GET', `/api/campaigns/${id}`, undefined, managerA)).json().campaign.version as number;
  const config = { version: initialVersion, name: 'Autumn Updated', sourceKind: 'META', routingMethod: 'WEIGHTED',
    messagingEnabled: true, aiEnabled: true, conversion: { type: 'PAYMENT_CONFIRMED' } };
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, config, agent)).statusCode, 403);
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, config, managerB)).statusCode, 403);
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, { ...config, unknown: true }, managerA)).statusCode, 400);
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, { ...config, conversion: { type: 'CLOSED' } }, managerA)).statusCode, 400);
  const competing = await Promise.all([send('PATCH', `/api/campaigns/${id}`, config, managerA),
    send('PATCH', `/api/campaigns/${id}`, { ...config, name: 'Competing' }, managerA)]);
  assert.deepEqual(competing.map((response) => response.statusCode).sort(), [200, 409]);
  const configured = (await send('GET', `/api/campaigns/${id}`, undefined, managerA)).json();
  assert.equal(configured.campaign.conversion_config.type, 'PAYMENT_CONFIRMED');
  assert.deepEqual(new Set(configured.issues), new Set([
    'NO_ELIGIBLE_AGENTS_CONFIGURED', 'SOURCE_BINDING_NOT_READY',
    'MESSAGING_CONFIGURATION_NOT_READY', 'AI_CONFIGURATION_NOT_READY',
  ]));
  assert.equal((await send('POST', `/api/campaigns/${id}/activate`, undefined, managerA)).statusCode, 409);
  assert.equal((await send('PUT', `/api/campaigns/${id}/agents`, { agentId: agentB }, managerA)).statusCode, 400);
  assert.equal((await send('PUT', `/api/campaigns/${id}/agents`, { agentId: agentA }, managerB)).statusCode, 403);
  const bound = await send('PUT', `/api/campaigns/${id}/agents`, { agentId: agentA, weight: 3, capacityOverride: 2 }, managerA);
  assert.equal(bound.statusCode, 200, bound.body);
  const latestVersion = bound.json().version as number;
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, { ...config, version: latestVersion - 1 }, managerA)).statusCode, 409);
  const performance = await send('PATCH', `/api/campaigns/${id}`, { ...config, version: latestVersion,
    sourceKind: 'MANUAL', routingMethod: 'PERFORMANCE', messagingEnabled: false, aiEnabled: false }, managerA);
  assert.equal(performance.statusCode, 200, performance.body);
  assert.deepEqual((await send('GET', `/api/campaigns/${id}/readiness`, undefined, managerA)).json().issues, ['PERFORMANCE_ROUTING_NOT_READY']);
  assert.equal((await send('POST', `/api/campaigns/${id}/activate`, undefined, managerA)).statusCode, 409);
  const readyConfig = await send('PATCH', `/api/campaigns/${id}`, { ...config, version: performance.json().version,
    sourceKind: 'MANUAL', routingMethod: 'WEIGHTED', messagingEnabled: false, aiEnabled: false }, managerA);
  assert.equal(readyConfig.statusCode, 200, readyConfig.body);
  assert.equal((await send('GET', `/api/campaigns/${id}/readiness`, undefined, managerA)).json().ready, true);
  assert.equal((await send('POST', `/api/campaigns/${id}/activate`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, { ...config, version: readyConfig.json().version }, managerA)).statusCode, 409);
  assert.equal((await send('DELETE', `/api/campaigns/${id}/agents/${agentA}`, undefined, managerA)).statusCode, 409);
  assert.equal((await db`SELECT active FROM campaign_agent WHERE campaign_id = ${id} AND agent_id = ${agentA}`)[0]!.active, true);
  const lead = await send('POST', '/api/leads', { branchId: branchA, campaignId: id,
    contact: { name: 'A customer', phone: '+15550009876' } }, managerA);
  assert.equal(lead.statusCode, 201, lead.body);
  assert.equal((await send('POST', `/api/campaigns/${id}/deactivate`, undefined, managerB)).statusCode, 403);
  const deactivated = await send('POST', `/api/campaigns/${id}/deactivate`, undefined, managerA);
  assert.equal(deactivated.statusCode, 200, deactivated.body);
  assert.equal((await send('POST', `/api/campaigns/${id}/deactivate`, undefined, managerA)).json().version, deactivated.json().version);
  assert.equal((await send('POST', '/api/leads', { branchId: branchA, campaignId: id,
    contact: { name: 'B customer', phone: '+15550009877' } }, managerA)).statusCode, 404);
  assert.equal((await send('GET', `/api/leads/${lead.json().id}`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('DELETE', `/api/campaigns/${id}/agents/${agentA}`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('DELETE', `/api/campaigns/${id}/agents/${agentA}`, undefined, managerA)).statusCode, 404);
  assert.equal((await send('POST', `/api/campaigns/${id}/activate`, undefined, managerA)).statusCode, 409);
  const second = await send('POST', '/api/campaigns', { branchId: branchA, name: 'Spring' }, managerA);
  assert.equal(second.statusCode, 201);
  const page = await send('GET', '/api/campaigns?limit=1', undefined, managerA);
  assert.equal(page.json().items.length, 1);
  assert.ok(page.json().nextCursor);
  const nextPage = await send('GET', `/api/campaigns?limit=1&cursor=${encodeURIComponent(page.json().nextCursor)}`, undefined, managerA);
  assert.equal(nextPage.json().items.length, 1);
  assert.notEqual(nextPage.json().items[0].id, page.json().items[0].id);
  const audit = await db`SELECT action FROM audit_log WHERE target_id = ${id} ORDER BY id`;
  assert.deepEqual(audit.map((row) => row.action), [
    'CAMPAIGN_CREATED', 'CAMPAIGN_UPDATED', 'CAMPAIGN_AGENT_SET', 'CAMPAIGN_UPDATED', 'CAMPAIGN_UPDATED',
    'CAMPAIGN_ACTIVATED', 'CAMPAIGN_DEACTIVATED', 'CAMPAIGN_AGENT_REMOVED',
  ]);
});
