import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { passwordHash } from '../src/security.js';
import type { MessagingProviderAdapter } from '../src/messaging/providers.js';
import { resolveConfiguredSender } from '../src/messaging/sender-resolution.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Messaging setup encrypts credentials, scopes connections, and discovers senders without claiming outbound readiness', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const db = createDatabase(url);
  let failDiscovery = false;
  let discoveryCalls = 0;
  const adapter: MessagingProviderAdapter = { async discoverSenders(config, credentials) {
    discoveryCalls++;
    assert.equal(config.wabaId, '123456789012345');
    assert.equal(credentials.accessToken, 'test-access-token-123456789');
    assert.equal(credentials.appSecret, 'test-app-secret-123456789');
    if (failDiscovery) throw new Error('upstream with secret test-access-token-123456789');
    return [{ externalId: '15550001111', displayName: 'Branch number', qualityRating: 'GREEN' }];
  } };
  const app = await buildApp(db, { logger: false, messagingAdapter: adapter });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE organization CASCADE`; });
  const send = async (method: 'GET'|'POST'|'PUT'|'PATCH', path: string, body?: object, cookie?: string) => app.inject({
    method, url: path, payload: body, headers: { origin: process.env.APP_ORIGIN!, ...(cookie ? { cookie } : {}) },
  });
  const password = 'Test password 12345!';
  assert.equal((await send('POST', '/api/setup/bootstrap', { token: process.env.BOOTSTRAP_TOKEN,
    organizationName: 'Messaging Test', name: 'Owner', email: 'owner@example.test', password })).statusCode, 201);
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
  for (const [email, branchId, role] of [
    ['manager-a@example.test', branchA, 'MANAGER'], ['manager-b@example.test', branchB, 'MANAGER'],
    ['agent-a@example.test', branchA, 'AGENT'],
  ] as const) await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash)
    VALUES (${organizationId}, ${branchId}, ${role}, ${email}, ${email}, ${hash})`;
  const managerA = await login('manager-a@example.test');
  const managerB = await login('manager-b@example.test');
  const agent = await login('agent-a@example.test');
  const input = { name: 'Branch WhatsApp', config: { wabaId: '123456789012345', graphVersion: 'v25.0' },
    credentials: { accessToken: 'test-access-token-123456789', appSecret: 'test-app-secret-123456789',
      verifyToken: 'test-verify-token-123456789' } };
  assert.equal((await send('GET', '/api/messaging/connections', undefined, agent)).statusCode, 403);
  assert.equal((await send('POST', '/api/messaging/connections', input, agent)).statusCode, 403);
  assert.equal((await send('POST', '/api/messaging/connections', { ...input, branchId: branchB }, managerA)).statusCode, 403);
  assert.equal((await send('POST', '/api/messaging/connections', { ...input,
    config: { wabaId: 'bad', graphVersion: 'v25.0' } }, managerA)).statusCode, 400);
  const created = await send('POST', '/api/messaging/connections', input, managerA);
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  assert.equal((await db`SELECT branch_id, status FROM integration_connection WHERE id = ${id}`)[0]!.branch_id, branchA);
  const stored = await db`SELECT ciphertext FROM connection_secret WHERE connection_id = ${id}`;
  assert.ok(stored[0]?.ciphertext);
  assert.equal(stored[0]!.ciphertext.toString('utf8').includes(input.credentials.accessToken), false);
  const listA = await send('GET', '/api/messaging/connections', undefined, managerA);
  assert.equal(listA.statusCode, 200, listA.body);
  assert.equal(listA.json().items[0].id, id);
  assert.equal(listA.json().items[0].has_credential, true);
  assert.equal(listA.body.includes(input.credentials.accessToken), false);
  assert.deepEqual((await send('GET', '/api/messaging/connections', undefined, managerB)).json().items, []);
  assert.equal((await send('POST', `/api/messaging/connections/${id}/test`, undefined, managerB)).statusCode, 404);
  const orgConnection = await send('POST', '/api/messaging/connections', { ...input, name: 'Organization' }, admin);
  assert.equal(orgConnection.statusCode, 201, orgConnection.body);
  assert.equal((await db`SELECT branch_id FROM integration_connection WHERE id = ${orgConnection.json().id}`)[0]!.branch_id, null);
  assert.equal((await send('GET', '/api/messaging/connections', undefined, admin)).json().items.length, 2);
  assert.equal((await send('GET', '/api/messaging/connections', undefined, managerA)).json().items.length, 1);
  assert.equal((await send('POST', `/api/messaging/connections/${orgConnection.json().id}/test`, undefined, admin)).statusCode, 200);
  const sharedSender = (await db`SELECT id FROM messaging_sender WHERE connection_id = ${orgConnection.json().id}`)[0]!.id as string;
  await db`INSERT INTO sender_branch_binding (sender_id, branch_id) VALUES (${sharedSender}, ${branchA})`;
  await db`INSERT INTO messaging_sender (organization_id, connection_id, external_sender_id, display_name)
    VALUES (${organizationId}, ${orgConnection.json().id}, '15550002222', 'Unbound number')`;
  assert.equal((await send('GET', '/api/messaging/connections', undefined, managerA)).json().items.length, 2);
  assert.equal((await send('GET', `/api/messaging/connections/${orgConnection.json().id}/senders`, undefined, managerA)).json().items.length, 1);
  assert.equal((await send('GET', `/api/messaging/connections/${orgConnection.json().id}/senders`, undefined, admin)).json().items.length, 2);
  const senderPage = (await send('GET', `/api/messaging/connections/${orgConnection.json().id}/senders?limit=1`, undefined, admin)).json();
  assert.equal(senderPage.items.length, 1);
  assert.equal((await send('GET', `/api/messaging/connections/${orgConnection.json().id}/senders?limit=1&after=${senderPage.nextAfter}`,
    undefined, admin)).json().items.length, 1);
  assert.equal((await send('POST', `/api/messaging/connections/${orgConnection.json().id}/test`, undefined, managerA)).statusCode, 404);
  assert.equal((await send('GET', `/api/messaging/connections/${orgConnection.json().id}/senders`, undefined, managerB)).statusCode, 404);
  const testResponse = await send('POST', `/api/messaging/connections/${id}/test`, undefined, managerA);
  assert.equal(testResponse.statusCode, 200, testResponse.body);
  assert.equal(testResponse.json().status, 'WARNING');
  assert.equal(testResponse.json().outboundVerified, false);
  assert.equal(discoveryCalls, 2);
  const discovered = await send('GET', `/api/messaging/connections/${id}/senders`, undefined, managerA);
  assert.equal(discovered.json().items.length, 1);
  assert.equal(discovered.json().items[0].health, 'UNKNOWN');
  assert.equal((await send('POST', `/api/messaging/connections/${id}/test`, undefined, managerA)).statusCode, 200);
  assert.equal((await db`SELECT count(*)::integer AS n FROM messaging_sender WHERE connection_id = ${id}`)[0]!.n, 1);
  failDiscovery = true;
  const failure = await send('POST', `/api/messaging/connections/${id}/test`, undefined, managerA);
  assert.equal(failure.statusCode, 502, failure.body);
  assert.equal(failure.body.includes(input.credentials.accessToken), false);
  assert.equal((await db`SELECT status, last_error_code FROM integration_connection WHERE id = ${id}`)[0]!.last_error_code,
    'SENDER_DISCOVERY_FAILED');
  const update = await send('PUT', `/api/messaging/connections/${id}`, { name: 'Updated', config: input.config,
    version: 1 }, managerA);
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(update.json().version, 2);
  assert.equal((await send('PUT', `/api/messaging/connections/${id}`, { name: 'Stale', config: input.config,
    version: 1 }, managerA)).statusCode, 409);
  assert.equal((await send('PUT', `/api/messaging/connections/${id}`, { name: 'Foreign', config: input.config,
    version: 2 }, managerB)).statusCode, 404);
  const disabled = await send('PATCH', `/api/messaging/connections/${id}/status`, { version: 2, disabled: true }, managerA);
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal((await send('POST', `/api/messaging/connections/${id}/test`, undefined, managerA)).statusCode, 409);
  assert.equal((await send('PUT', `/api/messaging/connections/${id}`, { name: 'Bypass', config: input.config,
    version: 3 }, managerA)).statusCode, 409);
  assert.equal((await send('PATCH', `/api/messaging/connections/${id}/status`, { version: 2, disabled: false }, managerA)).statusCode, 409);
  assert.equal((await send('PATCH', `/api/messaging/connections/${id}/status`, { version: 3, disabled: false }, managerA)).statusCode, 200);
  const concurrentUpdates = await Promise.all(['One','Two'].map((name) => send('PUT',
    `/api/messaging/connections/${id}`, { name, config: input.config, version: 4 }, managerA)));
  assert.deepEqual(concurrentUpdates.map((response) => response.statusCode).sort(), [200,409]);
  assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE target_id = ${id}`)[0]!.n, 8);
  const branchSender = (await db`SELECT id FROM messaging_sender WHERE connection_id = ${id}`)[0]!.id as string;
  assert.equal((await send('PATCH', `/api/messaging/senders/${branchSender}`,
    { version: 1, operatorEnabled: false }, agent)).statusCode, 403);
  assert.equal((await send('PATCH', `/api/messaging/senders/${sharedSender}`,
    { version: 1, operatorEnabled: false }, managerA)).statusCode, 404);
  assert.equal((await send('PUT', `/api/messaging/senders/${sharedSender}/bindings/${branchB}`,
    { version: 1, bound: true, allowSharedFallback: false }, managerA)).statusCode, 403);
  const eligibleA = await send('GET', `/api/messaging/branches/${branchA}/senders`, undefined, managerA);
  assert.equal(eligibleA.statusCode, 200, eligibleA.body);
  assert.equal(eligibleA.json().items.length, 2);
  const branchPage = (await send('GET', `/api/messaging/branches/${branchA}/senders?limit=1`, undefined, managerA)).json();
  assert.equal(branchPage.items.length, 1);
  assert.equal((await send('GET', `/api/messaging/branches/${branchA}/senders?limit=1&after=${branchPage.nextAfter}`,
    undefined, managerA)).json().items.length, 1);
  assert.deepEqual((await send('GET', `/api/messaging/branches/${branchB}/senders`, undefined, managerB)).json().items, []);
  assert.equal((await send('GET', `/api/messaging/branches/${branchA}/senders`, undefined, agent)).statusCode, 403);
  const sharedBinding = await send('PUT', `/api/messaging/senders/${sharedSender}/bindings/${branchB}`,
    { version: 1, bound: true, allowSharedFallback: false }, admin);
  assert.equal(sharedBinding.statusCode, 200, sharedBinding.body);
  assert.equal(sharedBinding.json().version, 2);
  assert.equal((await send('PUT', `/api/messaging/senders/${sharedSender}/bindings/${branchB}`,
    { version: 1, bound: true, allowSharedFallback: true }, admin)).statusCode, 409);
  assert.equal((await send('PUT', `/api/messaging/senders/${branchSender}/bindings/${branchB}`,
    { version: 1, bound: true, allowSharedFallback: false }, admin)).statusCode, 400);
  const bindingRace = await Promise.all([true, false].map((allowSharedFallback) => send('PUT',
    `/api/messaging/senders/${sharedSender}/bindings/${branchB}`,
    { version: 2, bound: true, allowSharedFallback }, admin)));
  assert.deepEqual(bindingRace.map((response) => response.statusCode).sort(), [200,409]);
  assert.equal((await send('GET', `/api/messaging/branches/${branchB}/senders`, undefined, managerB)).json().items.length, 1);
  assert.equal((await send('PUT', `/api/messaging/branches/${branchA}/default-sender`,
    { version: 1, senderId: sharedSender }, managerB)).statusCode, 403);
  assert.equal((await send('PUT', `/api/messaging/branches/${branchB}/default-sender`,
    { version: 1, senderId: branchSender }, managerB)).statusCode, 400);
  const defaultA = await send('PUT', `/api/messaging/branches/${branchA}/default-sender`,
    { version: 1, senderId: sharedSender }, managerA);
  assert.equal(defaultA.statusCode, 200, defaultA.body);
  assert.equal(defaultA.json().sender_version, 2);
  assert.equal((await send('PUT', `/api/messaging/branches/${branchA}/default-sender`,
    { version: 1, senderId: branchSender }, managerA)).statusCode, 409);
  const inUse = await send('PUT', `/api/messaging/senders/${sharedSender}/bindings/${branchA}`,
    { version: 3, bound: false, allowSharedFallback: false }, admin);
  assert.equal(inUse.statusCode, 409, inUse.body);
  const defaultRace = await Promise.all([1,2].map(() => send('PUT',
    `/api/messaging/branches/${branchA}/default-sender`, { version: 2, senderId: sharedSender }, managerA)));
  assert.deepEqual(defaultRace.map((response) => response.statusCode).sort(), [200,409]);
  const campaign = await send('POST', '/api/campaigns', { branchId: branchA, name: 'Sender test' }, managerA);
  assert.equal(campaign.statusCode, 201, campaign.body);
  const campaignId = campaign.json().id as string;
  assert.equal((await send('PUT', `/api/messaging/campaigns/${campaignId}/sender-override`,
    { version: 1, senderId: sharedSender }, managerB)).statusCode, 404);
  const override = await send('PUT', `/api/messaging/campaigns/${campaignId}/sender-override`,
    { version: 1, senderId: sharedSender }, managerA);
  assert.equal(override.statusCode, 200, override.body);
  assert.equal((await send('PUT', `/api/messaging/campaigns/${campaignId}/sender-override`,
    { version: 1, senderId: branchSender }, managerA)).statusCode, 409);
  const disabledSender = await send('PATCH', `/api/messaging/senders/${branchSender}`,
    { version: 1, operatorEnabled: false }, managerA);
  assert.equal(disabledSender.statusCode, 200, disabledSender.body);
  assert.equal((await send('PUT', `/api/messaging/campaigns/${campaignId}/sender-override`,
    { version: 2, senderId: branchSender }, managerA)).statusCode, 400);
  const overrideRace = await Promise.all([1,2].map(() => send('PUT',
    `/api/messaging/campaigns/${campaignId}/sender-override`,
    { version: 2, senderId: sharedSender }, managerA)));
  assert.deepEqual(overrideRace.map((response) => response.statusCode).sort(), [200,409]);
  assert.equal((await send('GET', `/api/messaging/campaigns/${campaignId}/effective-sender`, undefined, agent)).statusCode, 403);
  assert.equal((await send('GET', `/api/messaging/campaigns/${campaignId}/effective-sender`, undefined, managerB)).statusCode, 404);
  const unverified = await send('GET', `/api/messaging/campaigns/${campaignId}/effective-sender`, undefined, managerA);
  assert.equal(unverified.statusCode, 200, unverified.body);
  assert.equal(unverified.json().senderId, null);
  assert.equal(unverified.json().reason, 'CONNECTION_NOT_READY');
  await db`UPDATE integration_connection SET status = 'CONNECTED' WHERE id = ${orgConnection.json().id}`;
  await db`UPDATE messaging_sender SET health = 'HEALTHY' WHERE id = ${sharedSender}`;
  assert.equal((await send('GET', `/api/messaging/campaigns/${campaignId}/effective-sender`, undefined, managerA))
    .json().senderId, sharedSender);
  await db`UPDATE integration_connection SET status = 'CONNECTED' WHERE id = ${id}`;
  await db`UPDATE messaging_sender SET active = true, operator_enabled = true, health = 'HEALTHY'
    WHERE id = ${branchSender}`;
  const overrideBranch = await send('PUT', `/api/messaging/campaigns/${campaignId}/sender-override`,
    { version: 3, senderId: branchSender }, managerA);
  assert.equal(overrideBranch.statusCode, 200, overrideBranch.body);
  await db`UPDATE messaging_sender SET operator_enabled = false WHERE id = ${sharedSender}`;
  const pinned = await resolveConfiguredSender(db, { organizationId, branchId: branchA,
    campaignId, pinnedSenderId: sharedSender });
  assert.equal(pinned.sender, null);
  assert.equal(pinned.reason, 'PINNED_SENDER_DISABLED');
  assert.equal((await send('GET', `/api/messaging/campaigns/${campaignId}/effective-sender`, undefined, managerA))
    .json().senderId, branchSender);
  await db`UPDATE messaging_sender SET operator_enabled = true WHERE id = ${sharedSender}`;
  assert.equal((await send('PUT', `/api/messaging/campaigns/${campaignId}/sender-override`,
    { version: 4, senderId: null }, managerA)).statusCode, 200);
  assert.equal((await send('PUT', `/api/messaging/branches/${branchA}/default-sender`,
    { version: 3, senderId: null }, managerA)).statusCode, 200);
  const fallback = await send('PUT', `/api/messaging/senders/${sharedSender}/bindings/${branchA}`,
    { version: 3, bound: true, allowSharedFallback: true }, admin);
  assert.equal(fallback.statusCode, 200, fallback.body);
  assert.equal((await send('GET', `/api/messaging/campaigns/${campaignId}/effective-sender`, undefined, managerA))
    .json().reason, 'SHARED_FALLBACK');
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'CAMPAIGN_SENDER_OVERRIDE_SET'
    AND target_id = ${campaignId}`).length);
  const flood = await Promise.all(Array.from({ length: 12 }, () => send('POST',
    `/api/messaging/connections/${id}/test`, undefined, managerA)));
  assert.ok(flood.some((response) => response.statusCode === 429 && response.json().error === 'RATE_LIMITED'));
  assert.ok(flood.every((response) => response.statusCode !== 500));
});
