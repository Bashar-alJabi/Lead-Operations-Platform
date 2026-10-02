import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { passwordHash, sha256 } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
const databaseName = url ? new URL(url).pathname.slice(1) : '';
if (!url || databaseName !== 'lead_operations_test') {
  throw new Error('TEST_DATABASE_URL must target the isolated lead_operations_test database');
}

test('PostgreSQL API: bootstrap, isolation, sessions, and concurrent routing', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  const db = createDatabase(url);
  const app = await buildApp(db, { logger: false });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => {
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE organization CASCADE`;
  });

  const send = async (method: 'GET'|'POST'|'PUT'|'PATCH', path: string, payload?: Record<string, unknown>, cookie?: string) => await app.inject({
    method, url: path, payload,
    headers: { origin: process.env.APP_ORIGIN!, ...(cookie ? { cookie } : {}) },
  });
  const login = async (email: string, password: string) => {
    const response = await send('POST', '/api/auth/login', { email, password });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.headers['set-cookie'];
    assert.ok(cookie);
    return (Array.isArray(cookie) ? cookie[0]! : cookie).split(';')[0]!;
  };
  const createUser = async (_adminCookie: string, branchId: string, role: 'MANAGER'|'AGENT', name: string, email: string, capacity?: number) => {
    const organizationId = (await db`SELECT id FROM organization LIMIT 1`)[0]!.id;
    const hashed = await passwordHash('Test password 12345!');
    const rows = await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash, capacity)
      VALUES (${organizationId}, ${branchId}, ${role}, ${name}, ${email}, ${hashed}, ${capacity ?? null}) RETURNING id`;
    return rows[0]!.id as string;
  };

  assert.deepEqual((await send('GET', '/api/setup/status')).json(), { initialized: false });
  const deniedBootstrap = await send('POST', '/api/setup/bootstrap', {
    token: 'wrong-token-long-enough-for-schema', organizationName: 'Test Org', name: 'Owner', email: 'owner@example.test', password: 'Test password 12345!',
  });
  assert.equal(deniedBootstrap.statusCode, 403);
  const bootstrapPayload = {
    token: process.env.BOOTSTRAP_TOKEN, organizationName: 'Test Org', name: 'Owner', email: 'owner@example.test', password: 'Test password 12345!',
  };
  const competingBootstrap = await Promise.all([
    send('POST', '/api/setup/bootstrap', bootstrapPayload),
    send('POST', '/api/setup/bootstrap', bootstrapPayload),
  ]);
  assert.deepEqual(competingBootstrap.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal((await db`SELECT count(*)::integer AS count FROM organization`)[0]!.count, 1);
  assert.deepEqual((await send('GET', '/api/setup/status')).json(), { initialized: true });
  assert.equal((await send('POST', '/api/setup/bootstrap', {
    token: process.env.BOOTSTRAP_TOKEN, organizationName: 'Another', name: 'Owner', email: 'other@example.test', password: 'Test password 12345!',
  })).statusCode, 409);
  assert.equal((await send('POST', '/api/auth/login', { email: 'owner@example.test', password: 'wrong password' })).statusCode, 401);
  const admin = await login('owner@example.test', 'Test password 12345!');
  const wrongOrigin = await app.inject({ method: 'POST', url: '/api/branches', payload: { name: 'Denied', timezone: 'UTC' }, headers: { origin: 'https://evil.example', cookie: admin } });
  assert.equal(wrongOrigin.statusCode, 403);
  assert.equal((await send('GET', '/api/auth/me')).statusCode, 401);

  const branchAResponse = await send('POST', '/api/branches', { name: 'A', timezone: 'UTC' }, admin);
  const branchBResponse = await send('POST', '/api/branches', { name: 'B', timezone: 'UTC' }, admin);
  assert.equal(branchAResponse.statusCode, 201, branchAResponse.body);
  assert.equal(branchBResponse.statusCode, 201, branchBResponse.body);
  const branchA = branchAResponse.json().id as string;
  const branchB = branchBResponse.json().id as string;
  await createUser(admin, branchA, 'MANAGER', 'Manager A', 'manager-a@example.test');
  await createUser(admin, branchB, 'MANAGER', 'Manager B', 'manager-b@example.test');
  const agentA1 = await createUser(admin, branchA, 'AGENT', 'Agent A1', 'agent-a1@example.test', 1);
  const agentA2 = await createUser(admin, branchA, 'AGENT', 'Agent A2', 'agent-a2@example.test', 1);
  const managerA = await login('manager-a@example.test', 'Test password 12345!');
  const managerB = await login('manager-b@example.test', 'Test password 12345!');
  const agent1 = await login('agent-a1@example.test', 'Test password 12345!');
  const agent2 = await login('agent-a2@example.test', 'Test password 12345!');
  assert.equal((await send('POST', '/api/campaigns', { branchId: branchB, name: 'Denied' }, managerA)).statusCode, 403);

  const campaignResponse = await send('POST', '/api/campaigns', { branchId: branchA, name: 'Campaign A', routingMethod: 'ROUND_ROBIN' }, managerA);
  assert.equal(campaignResponse.statusCode, 201, campaignResponse.body);
  const campaignId = campaignResponse.json().id as string;
  assert.equal((await send('POST', `/api/campaigns/${campaignId}/activate`, undefined, managerA)).statusCode, 409);
  for (const agentId of [agentA1, agentA2]) {
    const bound = await send('PUT', `/api/campaigns/${campaignId}/agents`, { agentId }, managerA);
    assert.equal(bound.statusCode, 200, bound.body);
  }
  assert.equal((await send('PUT', `/api/campaigns/${campaignId}/agents`, { agentId: agentA1 }, managerB)).statusCode, 403);
  const campaignsA = await send('GET', '/api/campaigns', undefined, managerA);
  assert.equal(campaignsA.statusCode, 200, campaignsA.body);
  assert.deepEqual(new Set(campaignsA.json().items[0].agents.map((agent: { agentId: string }) => agent.agentId)), new Set([agentA1, agentA2]));
  assert.deepEqual((await send('GET', '/api/campaigns', undefined, managerB)).json().items, []);
  assert.equal((await send('POST', `/api/campaigns/${campaignId}/activate`, undefined, managerA)).statusCode, 200);

  const intakes = await Promise.all([1, 2, 3].map((n) => send('POST', '/api/leads', {
    branchId: branchA, campaignId, contact: { name: `Contact ${n}`, phone: `+1555000000${n}` },
  }, managerA)));
  for (const result of intakes) assert.equal(result.statusCode, 201, result.body);
  const leadIds = intakes.map((result) => result.json().id as string);
  const assigned = await db`SELECT id, assigned_agent_id, needs_attention_reason FROM lead WHERE id IN ${db(leadIds)}`;
  assert.deepEqual(new Set(assigned.map((row) => row.assigned_agent_id).filter(Boolean)), new Set([agentA1, agentA2]));
  assert.equal(assigned.filter((row) => row.needs_attention_reason === 'NO_ELIGIBLE_AGENT').length, 1);
  const firstAssigned = assigned.find((row) => row.assigned_agent_id === agentA1)!;
  const unrelatedCampaign = await send('POST', '/api/campaigns', { branchId: branchA, name: 'Unrelated' }, managerA);
  assert.equal(unrelatedCampaign.statusCode, 201, unrelatedCampaign.body);
  const agentCampaigns = await send('GET', '/api/campaigns', undefined, agent1);
  assert.equal(agentCampaigns.statusCode, 200, agentCampaigns.body);
  assert.deepEqual(agentCampaigns.json().items.map((campaign: { id: string }) => campaign.id), [campaignId]);
  assert.equal('routing_method' in agentCampaigns.json().items[0], false);
  assert.equal('agents' in agentCampaigns.json().items[0], false);
  assert.equal((await send('GET', `/api/leads/${firstAssigned.id}`, undefined, agent1)).statusCode, 200);
  assert.equal((await send('GET', `/api/leads/${firstAssigned.id}`, undefined, agent2)).statusCode, 404);
  assert.equal((await send('GET', `/api/leads/${firstAssigned.id}`, undefined, managerB)).statusCode, 404);
  assert.equal((await send('GET', `/api/leads?branchId=${branchA}`, undefined, managerB)).statusCode, 403);
  assert.equal((await send('POST', '/api/leads', {
    branchId: branchA, campaignId, contact: { name: 'Cross Branch', phone: '+15550000005' },
  }, managerB)).statusCode, 403);
  const firstPage = await send('GET', '/api/leads?limit=1', undefined, managerA);
  assert.equal(firstPage.statusCode, 200, firstPage.body);
  assert.equal(firstPage.json().items.length, 1);
  assert.ok(firstPage.json().nextCursor);
  const secondPage = await send('GET', `/api/leads?limit=1&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`, undefined, managerA);
  assert.equal(secondPage.statusCode, 200, secondPage.body);
  assert.notEqual(secondPage.json().items[0].id, firstPage.json().items[0].id);
  assert.equal((await send('POST', `/api/leads/${firstAssigned.id}/lifecycle`, { lifecycle: 'CLOSED' }, agent1)).statusCode, 403);
  assert.equal((await send('POST', `/api/leads/${firstAssigned.id}/lifecycle`, { lifecycle: 'CLOSED' }, managerB)).statusCode, 404);
  assert.equal((await send('POST', `/api/leads/${firstAssigned.id}/lifecycle`, { lifecycle: 'CLOSED' }, managerA)).statusCode, 200);
  assert.equal((await db`SELECT lifecycle FROM lead WHERE id = ${firstAssigned.id}`)[0]!.lifecycle, 'CLOSED');

  const sameContact = await send('POST', '/api/leads', {
    branchId: branchA, campaignId, contact: { name: 'Contact 1 repeat', phone: '+15550000001' },
  }, managerA);
  assert.equal(sameContact.statusCode, 201, sameContact.body);
  assert.equal((await db`SELECT count(*)::integer AS count FROM contact`)[0]!.count, 3);
  assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id = ${sameContact.json().id}`)[0]!.assigned_agent_id, agentA1);
  const repeatedIntake = await Promise.all([1, 2].map((n) => send('POST', '/api/leads', {
    branchId: branchA, campaignId, contact: { name: `Shared ${n}`, phone: '+15550000004' },
  }, managerA)));
  for (const result of repeatedIntake) assert.equal(result.statusCode, 201, result.body);
  assert.equal((await db`SELECT count(*)::integer AS count FROM contact WHERE phone_normalized = '+15550000004'`)[0]!.count, 1);

  const disable = await send('PATCH', `/api/users/${agentA1}/status`, { active: false }, managerA);
  assert.equal(disable.statusCode, 200, disable.body);
  assert.equal((await send('GET', '/api/auth/me', undefined, agent1)).statusCode, 401);
  assert.equal((await send('POST', '/api/auth/login', { email: 'agent-a1@example.test', password: 'Test password 12345!' })).statusCode, 401);
  assert.equal((await send('POST', '/api/auth/logout', undefined, managerB)).statusCode, 200);
  assert.equal((await send('GET', '/api/auth/me', undefined, managerB)).statusCode, 401);

  assert.equal((await send('POST', '/api/auth/password', { currentPassword: 'wrong', newPassword: 'Another test password 123!' }, managerA)).statusCode, 401);
  assert.equal((await send('GET', '/api/auth/me', undefined, managerA)).statusCode, 200);
  assert.equal((await send('POST', '/api/auth/password', { currentPassword: 'Test password 12345!', newPassword: 'Another test password 123!' }, managerA)).statusCode, 200);
  assert.equal((await send('GET', '/api/auth/me', undefined, managerA)).statusCode, 401);
  assert.equal((await send('POST', '/api/auth/login', { email: 'manager-a@example.test', password: 'Test password 12345!' })).statusCode, 401);
  const changedPasswordSession = await login('manager-a@example.test', 'Another test password 123!');
  await db`UPDATE user_session SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
    WHERE token_hash = ${sha256(changedPasswordSession.split('=')[1]!)}`;
  assert.equal((await send('GET', '/api/auth/me', undefined, changedPasswordSession)).statusCode, 401);

  const audit = await db`SELECT action FROM audit_log WHERE action IN ('FIRST_SUPER_ADMIN_BOOTSTRAP', 'USER_DISABLED', 'PASSWORD_CHANGED') ORDER BY id`;
  assert.deepEqual(audit.map((row) => row.action), ['FIRST_SUPER_ADMIN_BOOTSTRAP', 'USER_DISABLED', 'PASSWORD_CHANGED']);
});
