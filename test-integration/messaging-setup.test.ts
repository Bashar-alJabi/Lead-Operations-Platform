import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { passwordHash } from '../src/security.js';
import type { MessagingProviderAdapter } from '../src/messaging/providers.js';
import { ProviderSendError, type MessagingSendAdapter } from '../src/messaging/providers.js';
import { TemplateProviderError, type MessagingTemplateAdapter,
  type ProviderTemplate } from '../src/messaging/templates-provider.js';
import { resolveConfiguredSender } from '../src/messaging/sender-resolution.js';
import { processOneMessagingJob } from '../src/messaging/send-worker.js';
import { processOnePendingDeliveryEvent } from '../src/messaging/delivery-events.js';
import { processOneInboundEvent } from '../src/messaging/inbound-events.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Messaging setup encrypts credentials, scopes connections, and discovers senders without claiming outbound readiness', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const db = createDatabase(url);
  let failDiscovery = false;
  let discoveryCalls = 0;
  let createCalls = 0;
  let failTemplateCreate = false;
  let failTemplateSync = false;
  let catalog: ProviderTemplate[] = [];
  let holdTemplateCreate: Promise<void> | null = null;
  let templateCreateStarted: (() => void) | null = null;
  const templateAdapter: MessagingTemplateAdapter = {
    async list(_config, credentials) {
      assert.equal(credentials.accessToken, 'test-access-token-123456789');
      if (failTemplateSync) throw new TemplateProviderError('UNKNOWN', 'UPSTREAM_SECRET');
      return catalog;
    },
    async create(_config, credentials, input) {
      createCalls++;
      assert.equal(credentials.accessToken, 'test-access-token-123456789');
      if (holdTemplateCreate) { templateCreateStarted?.(); await holdTemplateCreate; }
      if (failTemplateCreate) throw new TemplateProviderError('UNKNOWN', 'UPSTREAM_SECRET');
      const item = { externalId: String(900000 + createCalls), name: input.name, language: input.language,
        status: 'PENDING', category: input.category, components: [{ type: 'BODY', text: input.body }] };
      catalog = [...catalog, item];
      return item;
    },
  };
  const adapter: MessagingProviderAdapter = { async discoverSenders(config, credentials) {
    discoveryCalls++;
    assert.equal(config.wabaId, '123456789012345');
    assert.equal(credentials.accessToken, 'test-access-token-123456789');
    assert.equal(credentials.appSecret, 'test-app-secret-123456789');
    if (failDiscovery) throw new Error('upstream with secret test-access-token-123456789');
    return [{ externalId: '15550001111', displayName: 'Branch number', qualityRating: 'GREEN' }];
  } };
  const app = await buildApp(db, { logger: false, messagingAdapter: adapter,
    messagingTemplateAdapter: templateAdapter, globalRateLimitMax: 1000 });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
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
  assert.equal((await send('GET', `/api/messaging/connections/${orgConnection.json().id}/templates`,
    undefined, managerA)).statusCode, 404);
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
  const templatesPath = `/api/messaging/connections/${id}/templates`;
  const templateInput = { idempotencyKey: 'template-create-001', name: 'follow_up_notice',
    language: 'en_US', category: 'UTILITY', body: 'We will contact you soon.' };
  assert.equal((await send('GET', templatesPath, undefined, agent)).statusCode, 403);
  assert.equal((await send('GET', templatesPath, undefined, managerB)).statusCode, 404);
  assert.equal((await send('POST', templatesPath, templateInput, agent)).statusCode, 403);
  assert.equal((await send('POST', templatesPath, templateInput, managerB)).statusCode, 404);
  assert.equal((await send('POST', templatesPath, { ...templateInput, body: '{{1}}' }, managerA)).statusCode, 400);
  assert.equal((await send('POST', templatesPath, { ...templateInput, extra: true }, managerA)).statusCode, 400);
  const createdTemplate = await send('POST', templatesPath, templateInput, managerA);
  assert.equal(createdTemplate.statusCode, 201, createdTemplate.body);
  assert.equal(createdTemplate.json().status, 'PENDING');
  assert.equal((await send('POST', templatesPath, templateInput, managerA)).statusCode, 200);
  assert.equal(createCalls, 1);
  assert.equal((await send('POST', templatesPath, { ...templateInput, body: 'Different' }, managerA)).json().error,
    'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await send('POST', templatesPath, { ...templateInput, idempotencyKey: 'template-create-002' }, managerA))
    .json().error, 'TEMPLATE_ALREADY_EXISTS');
  const pendingTemplate = (await send('GET', templatesPath, undefined, managerA)).json().items[0];
  assert.equal(pendingTemplate.status, 'PENDING');
  assert.equal(pendingTemplate.active, true);
  catalog = [{ ...catalog[0]!, status: 'APPROVED' }];
  assert.equal((await send('POST', `${templatesPath}/sync`, undefined, managerB)).statusCode, 404);
  assert.equal((await send('POST', `${templatesPath}/sync`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('GET', templatesPath, undefined, managerA)).json().items
    .find((item: { name: string }) => item.name === 'follow_up_notice').status, 'APPROVED');
  let releaseTemplateCreate!: () => void;
  let signalTemplateCreate!: () => void;
  holdTemplateCreate = new Promise<void>((resolve) => { releaseTemplateCreate = resolve; });
  const startedTemplateCreate = new Promise<void>((resolve) => { signalTemplateCreate = resolve; });
  templateCreateStarted = signalTemplateCreate;
  const raceInput = { ...templateInput, name: 'race_notice', idempotencyKey: 'template-create-race' };
  const firstCreate = send('POST', templatesPath, raceInput, managerA);
  await startedTemplateCreate;
  const runningRequest = (await send('GET', `${templatesPath}/requests`, undefined, managerA)).json().items
    .find((item: { name: string }) => item.name === 'race_notice');
  assert.equal((await send('POST', `${templatesPath}/requests/${runningRequest.id}/resolve`,
    { confirmAbsent: true }, managerA)).json().error, 'TEMPLATE_CREATE_STILL_RUNNING');
  assert.equal((await send('POST', templatesPath, raceInput, managerA)).json().error,
    'TEMPLATE_CREATE_IN_PROGRESS');
  releaseTemplateCreate();
  assert.equal((await firstCreate).statusCode, 201);
  holdTemplateCreate = null;
  templateCreateStarted = null;
  assert.equal((await send('POST', templatesPath, raceInput, managerA)).statusCode, 200);
  failTemplateSync = true;
  const failedSync = await send('POST', `${templatesPath}/sync`, undefined, managerA);
  assert.equal(failedSync.statusCode, 502, failedSync.body);
  assert.equal(failedSync.body.includes('UPSTREAM_SECRET'), false);
  assert.equal((await send('GET', templatesPath, undefined, managerA)).json().items
    .find((item: { name: string }) => item.name === 'follow_up_notice').status, 'APPROVED');
  failTemplateSync = false;
  failTemplateCreate = true;
  const unknownInput = { ...templateInput, idempotencyKey: 'template-create-003', name: 'unknown_notice' };
  assert.equal((await send('POST', templatesPath, unknownInput, managerA)).json().error,
    'TEMPLATE_CREATE_OUTCOME_UNKNOWN');
  assert.equal((await send('POST', templatesPath, unknownInput, managerA)).json().error,
    'TEMPLATE_CREATE_OUTCOME_UNKNOWN');
  assert.equal(createCalls, 3);
  assert.equal((await send('POST', templatesPath, { ...unknownInput, idempotencyKey: 'template-create-004' }, managerA))
    .json().error, 'TEMPLATE_CREATE_NEEDS_SYNC');
  catalog = [...catalog, { externalId: '900009', name: 'unknown_notice', language: 'en_US',
    status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: unknownInput.body }] }];
  assert.equal((await send('POST', `${templatesPath}/sync`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('POST', templatesPath, unknownInput, managerA)).statusCode, 200);
  assert.equal(createCalls, 3);
  const absentInput = { ...templateInput, idempotencyKey: 'template-create-absent', name: 'absent_notice' };
  assert.equal((await send('POST', templatesPath, absentInput, managerA)).json().error,
    'TEMPLATE_CREATE_OUTCOME_UNKNOWN');
  const unresolved = (await send('GET', `${templatesPath}/requests`, undefined, managerA)).json().items
    .find((item: { name: string }) => item.name === 'absent_notice');
  assert.ok(unresolved?.id);
  const resolvePath = `${templatesPath}/requests/${unresolved.id}/resolve`;
  assert.equal((await send('POST', resolvePath, { confirmAbsent: true }, managerB)).statusCode, 404);
  assert.equal((await send('POST', resolvePath, { confirmAbsent: false }, managerA)).statusCode, 400);
  assert.equal((await send('POST', resolvePath, { confirmAbsent: true }, managerA)).json().error,
    'TEMPLATE_REVIEW_REQUIRES_SYNC');
  assert.equal((await send('POST', `${templatesPath}/sync`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('POST', resolvePath, { confirmAbsent: true }, managerA)).statusCode, 200);
  assert.equal((await send('POST', resolvePath, { confirmAbsent: true }, managerA)).json().error,
    'TEMPLATE_CREATE_ALREADY_RESOLVED');
  failTemplateCreate = false;
  assert.equal((await send('POST', templatesPath, { ...absentInput,
    idempotencyKey: 'template-create-after-review' }, managerA)).statusCode, 201);
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'MESSAGING_TEMPLATE_CREATE_REVIEWED_ABSENT'
    AND target_id = ${id}`).length);
  const stale = (await db`INSERT INTO messaging_template_create_request
    (connection_id, idempotency_key, request_hash, name, language, state, created_by, created_at)
    SELECT ${id}, 'template-create-crashed', 'crashed-hash', 'crashed_notice', 'en_US',
      'IN_PROGRESS', id, now() - interval '3 minutes' FROM user_account
    WHERE email = 'manager-a@example.test' RETURNING id`)[0]!.id as string;
  const stalePath = `${templatesPath}/requests/${stale}/resolve`;
  await db`UPDATE messaging_template_catalog_sync SET synced_at = now() - interval '4 minutes'
    WHERE connection_id = ${id}`;
  assert.equal((await send('POST', stalePath, { confirmAbsent: true }, managerA)).json().error,
    'TEMPLATE_REVIEW_REQUIRES_SYNC');
  assert.equal((await send('POST', `${templatesPath}/sync`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('POST', stalePath, { confirmAbsent: true }, managerA)).statusCode, 200);
  catalog = catalog.slice(1);
  assert.equal((await send('POST', `${templatesPath}/sync`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('GET', templatesPath, undefined, managerA)).json().items
    .find((item: { name: string }) => item.name === 'follow_up_notice').active, false);
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'MESSAGING_TEMPLATES_SYNCED'
    AND target_id = ${id}`).length);
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
  const agentId = (await db`SELECT id FROM user_account WHERE email = 'agent-a@example.test'`)[0]!.id as string;
  const contactId = (await db`INSERT INTO contact (organization_id, name, phone, phone_normalized)
    VALUES (${organizationId}, 'Conversation contact', '+15550003333', '+15550003333') RETURNING id`)[0]!.id as string;
  const leadId = (await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
    VALUES (${organizationId}, ${branchA}, ${campaignId}, ${contactId}, 'MANUAL') RETURNING id`)[0]!.id as string;
  assert.equal((await send('POST', `/api/leads/${leadId}/conversations`, undefined, agent)).statusCode, 404);
  assert.equal((await send('POST', `/api/leads/${leadId}/conversations`, undefined, managerB)).statusCode, 404);
  const opened = await send('POST', `/api/leads/${leadId}/conversations`, undefined, managerA);
  assert.equal(opened.statusCode, 201, opened.body);
  assert.equal(opened.json().senderId, sharedSender);
  const conversationId = opened.json().id as string;
  assert.equal((await send('POST', `/api/leads/${leadId}/conversations`, undefined, managerA)).json().id,
    conversationId);
  assert.equal((await send('GET', `/api/conversations/${conversationId}`, undefined, managerB)).statusCode, 404);
  assert.equal((await send('GET', `/api/conversations/${conversationId}`, undefined, agent)).statusCode, 404);
  await db`UPDATE lead SET assigned_agent_id = ${agentId} WHERE id = ${leadId}`;
  assert.equal((await send('GET', `/api/conversations/${conversationId}`, undefined, agent)).statusCode, 200);
  assert.equal((await send('GET', `/api/leads/${leadId}/conversations`, undefined, agent)).json().items.length, 1);
  await db`UPDATE lead SET assigned_agent_id = NULL WHERE id = ${leadId}`;
  assert.equal((await send('GET', `/api/conversations/${conversationId}`, undefined, agent)).statusCode, 404);
  assert.equal((await send('GET', `/api/leads/${leadId}/conversations`, undefined, agent)).statusCode, 404);
  const secondContactId = (await db`INSERT INTO contact (organization_id, name, phone, phone_normalized)
    VALUES (${organizationId}, 'Concurrent contact', '+15550004444', '+15550004444') RETURNING id`)[0]!.id as string;
  const secondLeadId = (await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id,
    assigned_agent_id, source_kind) VALUES (${organizationId}, ${branchA}, ${campaignId}, ${secondContactId},
    ${agentId}, 'MANUAL') RETURNING id`)[0]!.id as string;
  const openings = await Promise.all([1,2].map(() => send('POST',
    `/api/leads/${secondLeadId}/conversations`, undefined, agent)));
  assert.deepEqual(openings.map((response) => response.statusCode).sort(), [200,201]);
  assert.equal(openings[0]!.json().id, openings[1]!.json().id);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation WHERE lead_id = ${secondLeadId}`)[0]!.n, 1);
  const noPhoneContact = (await db`INSERT INTO contact (organization_id, name, email, email_normalized)
    VALUES (${organizationId}, 'Email only', 'email-only@example.test', 'email-only@example.test') RETURNING id`)[0]!.id as string;
  const noPhoneLead = (await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
    VALUES (${organizationId}, ${branchA}, ${campaignId}, ${noPhoneContact}, 'MANUAL') RETURNING id`)[0]!.id as string;
  assert.equal((await send('POST', `/api/leads/${noPhoneLead}/conversations`, undefined, managerA)).statusCode, 409);
  assert.equal((await send('PUT', `/api/messaging/campaigns/${campaignId}/sender-override`,
    { version: 5, senderId: branchSender }, managerA)).statusCode, 200);
  await db`UPDATE messaging_sender SET operator_enabled = false WHERE id = ${sharedSender}`;
  const blockedConversation = await send('POST', `/api/leads/${leadId}/conversations`, undefined, managerA);
  assert.equal(blockedConversation.statusCode, 409, blockedConversation.body);
  assert.equal(blockedConversation.json().error, 'PINNED_SENDER_DISABLED');
  assert.equal((await db`SELECT sender_id, needs_attention_reason FROM conversation WHERE id = ${conversationId}`)[0]!
    .needs_attention_reason, 'PINNED_SENDER_DISABLED');
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation WHERE lead_id = ${leadId}`)[0]!.n, 1);
  await db`UPDATE contact SET phone_normalized = '+15550009999' WHERE id = ${contactId}`;
  assert.equal((await send('POST', `/api/leads/${leadId}/conversations`, undefined, managerA)).json().error,
    'PARTICIPANT_CHANGED');
  await db`UPDATE contact SET phone_normalized = '+15550003333' WHERE id = ${contactId}`;
  await db`UPDATE messaging_sender SET operator_enabled = true WHERE id = ${sharedSender}`;
  await db`UPDATE conversation SET connection_id = ${id} WHERE id = ${conversationId}`;
  assert.equal((await send('POST', `/api/leads/${leadId}/conversations`, undefined, managerA)).json().error,
    'CONNECTION_SENDER_MISMATCH');
  assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE action = 'CONVERSATION_OPENED'`)[0]!.n, 2);
  const consentPath = `/api/leads/${leadId}/messaging-consent`;
  assert.equal((await send('GET', consentPath, undefined, agent)).statusCode, 404);
  assert.equal((await send('GET', consentPath, undefined, managerA)).json().version, 0);
  assert.equal((await send('PUT', consentPath, { version: 0, status: 'GRANTED',
    doNotContact: false, evidence: 'Form checkbox', source: 'WEB_FORM' }, agent)).statusCode, 403);
  assert.equal((await send('PUT', consentPath, { version: 0, status: 'GRANTED',
    doNotContact: false, evidence: null, source: 'WEB_FORM' }, managerA)).statusCode, 400);
  const granted = await send('PUT', consentPath, { version: 0, status: 'GRANTED',
    doNotContact: false, evidence: 'Form checkbox', source: 'WEB_FORM' }, managerA);
  assert.equal(granted.statusCode, 200, granted.body);
  assert.equal(granted.json().version, 1);
  assert.equal((await send('PUT', consentPath, { version: 1, status: 'GRANTED',
    doNotContact: false, evidence: 'Form checkbox', source: 'WEB_FORM' }, managerA)).json().unchanged, true);
  const consentRace = await Promise.all(['GRANTED','REVOKED'].map((status) => send('PUT', consentPath,
    { version: 1, status, doNotContact: true, evidence: 'Customer request', source: 'CALL' }, managerA)));
  assert.deepEqual(consentRace.map((response) => response.statusCode).sort(), [200,409]);
  assert.equal((await db`SELECT count(*)::integer AS n FROM messaging_consent_history
    WHERE contact_id = ${contactId}`)[0]!.n, 2);
  assert.equal((await send('GET', consentPath, undefined, managerA)).json().do_not_contact, true);
  const branchBCampaign = await send('POST', '/api/campaigns', { branchId: branchB, name: 'B shared' }, managerB);
  assert.equal(branchBCampaign.statusCode, 201, branchBCampaign.body);
  const branchBLeadId = (await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
    VALUES (${organizationId}, ${branchB}, ${branchBCampaign.json().id}, ${contactId}, 'MANUAL') RETURNING id`)[0]!.id as string;
  assert.equal((await send('GET', `/api/leads/${branchBLeadId}/messaging-consent`, undefined, managerB))
    .json().do_not_contact, true);
  assert.equal((await send('PUT', consentPath, { version: 2, status: 'REVOKED',
    doNotContact: true, evidence: 'Customer request', source: 'CALL' }, managerA)).statusCode, 403);
  assert.equal((await send('PUT', `/api/leads/${branchBLeadId}/messaging-consent`, { version: 2,
    status: 'REVOKED', doNotContact: true, evidence: 'Customer request', source: 'CALL' }, managerB)).statusCode, 403);
  assert.equal((await send('PUT', consentPath, { version: 2, status: 'UNKNOWN',
    doNotContact: true, evidence: 'Admin review', source: 'ADMIN' }, admin)).statusCode, 200);
  assert.equal((await db`SELECT count(*)::integer AS n FROM messaging_consent_history
    WHERE contact_id = ${contactId}`)[0]!.n, 3);
  await db`UPDATE lead SET assigned_agent_id = ${agentId} WHERE id = ${leadId}`;
  const agentConsent = await send('GET', consentPath, undefined, agent);
  assert.equal(agentConsent.statusCode, 200, agentConsent.body);
  assert.equal(agentConsent.json().editable, false);
  const branchPolicyPath = `/api/messaging/branches/${branchA}/policy`;
  assert.equal((await send('GET', branchPolicyPath, undefined, agent)).statusCode, 403);
  assert.equal((await send('GET', branchPolicyPath, undefined, managerB)).statusCode, 403);
  assert.equal((await send('PUT', branchPolicyPath, { version: 1, sendingWindow: null }, agent)).statusCode, 403);
  assert.equal((await send('PUT', branchPolicyPath, { version: 1, sendingWindow: null }, managerB)).statusCode, 403);
  assert.equal((await send('GET', branchPolicyPath, undefined, managerA)).json().sendingWindow, null);
  assert.equal((await send('PUT', branchPolicyPath, { version: 1,
    sendingWindow: { start: '22:00', end: '22:00' } }, managerA)).statusCode, 400);
  assert.equal((await send('PUT', branchPolicyPath, { version: 1,
    sendingWindow: { start: '99:00', end: '06:00' } }, managerA)).statusCode, 400);
  const branchPolicy = await send('PUT', branchPolicyPath,
    { version: 1, sendingWindow: { start: '22:00', end: '06:00' } }, managerA);
  assert.equal(branchPolicy.statusCode, 200, branchPolicy.body);
  assert.equal(branchPolicy.json().version, 2);
  assert.equal((await send('PUT', branchPolicyPath, { version: 1, sendingWindow: null }, managerA)).statusCode, 409);
  const campaignPolicyPath = `/api/messaging/campaigns/${campaignId}/policy`;
  assert.equal((await send('GET', campaignPolicyPath, undefined, agent)).statusCode, 403);
  assert.equal((await send('GET', campaignPolicyPath, undefined, managerB)).statusCode, 404);
  const inheritedPolicy = await send('GET', campaignPolicyPath, undefined, managerA);
  assert.equal(inheritedPolicy.statusCode, 200, inheritedPolicy.body);
  assert.deepEqual(inheritedPolicy.json().effectiveSendingWindow, { start: '22:00', end: '06:00' });
  const policyVersion = inheritedPolicy.json().version as number;
  assert.equal((await send('PUT', campaignPolicyPath, { version: policyVersion,
    sendingWindow: null, maxAttempts: 0, minIntervalSeconds: 300 }, managerA)).statusCode, 400);
  assert.equal((await send('PUT', campaignPolicyPath, { version: policyVersion,
    sendingWindow: null, maxAttempts: 3, minIntervalSeconds: 0 }, managerA)).statusCode, 400);
  assert.equal((await send('PUT', campaignPolicyPath, { version: policyVersion,
    sendingWindow: null, maxAttempts: 3, minIntervalSeconds: 300 }, agent)).statusCode, 403);
  assert.equal((await send('PUT', campaignPolicyPath, { version: policyVersion,
    sendingWindow: null, maxAttempts: 3, minIntervalSeconds: 300 }, managerB)).statusCode, 404);
  assert.equal((await send('PUT', campaignPolicyPath, { version: policyVersion,
    sendingWindow: { start: '10:00', end: '10:00' }, maxAttempts: 3,
    minIntervalSeconds: 300 }, managerA)).statusCode, 400);
  const setPolicy = await send('PUT', campaignPolicyPath, { version: policyVersion,
    sendingWindow: null, maxAttempts: 3, minIntervalSeconds: 300 }, managerA);
  assert.equal(setPolicy.statusCode, 200, setPolicy.body);
  assert.deepEqual((await send('GET', campaignPolicyPath, undefined, managerA)).json().effectiveSendingWindow,
    { start: '22:00', end: '06:00' });
  const policyRace = await Promise.all([1,2].map(() => send('PUT', campaignPolicyPath,
    { version: policyVersion + 1, sendingWindow: { start: '10:00', end: '18:00' },
      maxAttempts: 3, minIntervalSeconds: 300 }, managerA)));
  assert.deepEqual(policyRace.map((response) => response.statusCode).sort(), [200,409]);
  assert.deepEqual((await send('GET', campaignPolicyPath, undefined, managerA)).json().effectiveSendingWindow,
    { start: '10:00', end: '18:00' });
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'CAMPAIGN_MESSAGING_POLICY_UPDATED'
    AND target_id = ${campaignId}`).length);
  // Exercise the send intent against a synthetically healthy sandbox connection; discovery alone stays WARNING.
  await db`UPDATE conversation SET connection_id = ${orgConnection.json().id}, needs_attention_reason = NULL
    WHERE id = ${conversationId}`;
  await db`UPDATE campaign SET status = 'ACTIVE', messaging_config = ${db.json({ enabled: true })}
    WHERE id = ${campaignId}`;
  const currentCampaignPolicy = (await send('GET', campaignPolicyPath, undefined, managerA)).json();
  assert.equal((await send('PUT', campaignPolicyPath, { version: currentCampaignPolicy.version,
    sendingWindow: null, maxAttempts: 3, minIntervalSeconds: 300 }, managerA)).statusCode, 200);
  assert.equal((await send('PUT', branchPolicyPath, { version: 2, sendingWindow: null }, managerA)).statusCode, 200);
  const messagePath = `/api/conversations/${conversationId}/messages`;
  const firstKey = 'send-intent-001';
  await db`UPDATE lead SET assigned_agent_id = NULL WHERE id = ${leadId}`;
  assert.equal((await send('GET', messagePath, undefined, managerB)).statusCode, 404);
  assert.equal((await send('POST', messagePath, { body: 'Hello', idempotencyKey: firstKey }, agent)).statusCode, 404);
  assert.equal((await send('POST', messagePath, { body: 'Hello', idempotencyKey: firstKey }, managerB)).statusCode, 404);
  const dncBlocked = await send('POST', messagePath, { body: 'Hello', idempotencyKey: firstKey }, managerA);
  assert.equal(dncBlocked.statusCode, 409, dncBlocked.body);
  assert.equal(dncBlocked.json().error, 'DO_NOT_CONTACT');
  assert.equal((await send('PUT', consentPath, { version: 3, status: 'GRANTED', doNotContact: false,
    evidence: 'Verified opt-in', source: 'ADMIN' }, admin)).statusCode, 200);
  const templateBlocked = await send('POST', messagePath, { body: 'Hello', idempotencyKey: firstKey }, managerA);
  assert.equal(templateBlocked.statusCode, 409, templateBlocked.body);
  assert.equal(templateBlocked.json().error, 'TEMPLATE_REQUIRED');
  await db`INSERT INTO conversation_message (conversation_id, connection_id, sender_id, direction,
    author_type, body, delivery_state, received_at) VALUES (${conversationId}, ${orgConnection.json().id},
      ${sharedSender}, 'INBOUND', 'CUSTOMER', 'Customer message', 'RECEIVED', now())`;
  const queued = await send('POST', messagePath, { body: 'Hello', idempotencyKey: firstKey }, managerA);
  assert.equal(queued.statusCode, 202, queued.body);
  assert.equal(queued.json().deliveryState, 'QUEUED');
  const replayed = await send('POST', messagePath, { body: 'Hello', idempotencyKey: firstKey }, managerA);
  assert.equal(replayed.statusCode, 200, replayed.body);
  assert.equal(replayed.json().id, queued.json().id);
  assert.equal((await send('POST', messagePath, { body: 'Changed', idempotencyKey: firstKey }, managerA)).statusCode, 409);
  const concurrent = await Promise.all([1,2].map(() => send('POST', messagePath,
    { body: 'Concurrent', idempotencyKey: 'send-intent-002' }, managerA)));
  assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [200,202]);
  assert.equal(concurrent[0]!.json().id, concurrent[1]!.json().id);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message
    WHERE conversation_id = ${conversationId} AND direction = 'OUTBOUND'`)[0]!.n, 2);
  assert.equal((await db`SELECT count(*)::integer AS n FROM outbound_delivery_job j
    JOIN conversation_message m ON m.id = j.message_id WHERE m.conversation_id = ${conversationId}`)[0]!.n, 2);
  const secondMessageId = concurrent[0]!.json().id as string;
  await db`UPDATE background_job SET run_after = now() + interval '1 hour'
    WHERE id = (SELECT job_id FROM outbound_delivery_job WHERE message_id = ${secondMessageId})`;
  let providerCalls = 0;
  const acceptedAdapter: MessagingSendAdapter = { async sendText(input) {
    providerCalls++;
    assert.equal(input.body, 'Hello');
    assert.equal(input.recipient, '+15550003333');
    assert.equal(input.credentials.accessToken, 'test-access-token-123456789');
    return { providerMessageId: 'wamid.test-first' };
  } };
  assert.equal(await processOneMessagingJob(db, acceptedAdapter), true);
  assert.equal((await db`SELECT delivery_state, provider_message_id FROM conversation_message
    WHERE id = ${queued.json().id}`)[0]!.delivery_state, 'SENT');
  assert.equal((await db`SELECT status FROM background_job WHERE id =
    (SELECT job_id FROM outbound_delivery_job WHERE message_id = ${queued.json().id})`)[0]!.status, 'SUCCEEDED');
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'OUTBOUND_MESSAGE_SENT'
    AND target_id = ${queued.json().id}`).length);
  await db`UPDATE background_job SET run_after = now()
    WHERE id = (SELECT job_id FROM outbound_delivery_job WHERE message_id = ${secondMessageId})`;
  const rateLimitedAdapter: MessagingSendAdapter = { async sendText() {
    providerCalls++; throw new ProviderSendError('RETRYABLE', 'PROVIDER_RATE_LIMITED', 1);
  } };
  assert.equal(await processOneMessagingJob(db, rateLimitedAdapter), true);
  assert.equal((await db`SELECT status, attempts FROM background_job WHERE id =
    (SELECT job_id FROM outbound_delivery_job WHERE message_id = ${secondMessageId})`)[0]!.status, 'QUEUED');
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id = ${secondMessageId}`)[0]!
    .delivery_state, 'QUEUED');
  assert.equal(providerCalls, 2);
  assert.equal((await send('GET', messagePath, undefined, managerA)).json().items.length, 3);
  await db`UPDATE lead SET assigned_agent_id = ${agentId} WHERE id = ${leadId}`;
  assert.equal((await send('GET', messagePath, undefined, agent)).statusCode, 200);
  assert.equal((await send('POST', messagePath, { body: 'Agent reply', idempotencyKey: 'send-intent-003' }, agent))
    .json().error, 'HUMAN_CONTROLLER_REQUIRED');
  await db`UPDATE lead SET assigned_agent_id = NULL WHERE id = ${leadId}`;
  assert.equal((await send('GET', messagePath, undefined, agent)).statusCode, 404);
  await assert.rejects(db`UPDATE conversation_message SET body = 'edited' WHERE id = ${queued.json().id}`);
  await assert.rejects(db`UPDATE conversation SET connection_id = ${id} WHERE id = ${conversationId}`);
  assert.equal((await send('POST', messagePath, { body: '   ', idempotencyKey: 'send-intent-003' }, managerA)).statusCode, 400);
  assert.equal((await send('POST', messagePath, { body: 'Hello', idempotencyKey: 'x' }, managerA)).statusCode, 400);
  await db`UPDATE messaging_sender SET operator_enabled = false WHERE id = ${sharedSender}`;
  const invalidPinned = await send('POST', messagePath,
    { body: 'Blocked sender', idempotencyKey: 'send-intent-004' }, managerA);
  assert.equal(invalidPinned.statusCode, 409, invalidPinned.body);
  assert.equal(invalidPinned.json().error, 'PINNED_SENDER_DISABLED');
  assert.equal((await db`SELECT needs_attention_reason FROM conversation WHERE id = ${conversationId}`)[0]!
    .needs_attention_reason, 'PINNED_SENDER_DISABLED');
  await db`UPDATE messaging_sender SET operator_enabled = true WHERE id = ${sharedSender}`;
  assert.equal((await send('POST', `/api/leads/${leadId}/conversations`, undefined, managerA)).statusCode, 200);
  const hour = (new Date().getUTCHours() + 2) % 24;
  const blockedWindow = { start: `${String(hour).padStart(2, '0')}:00`,
    end: `${String((hour + 1) % 24).padStart(2, '0')}:00` };
  assert.equal((await send('PUT', branchPolicyPath, { version: 3,
    sendingWindow: blockedWindow }, managerA)).statusCode, 200);
  const timeBlocked = await send('POST', messagePath,
    { body: 'Outside window', idempotencyKey: 'send-intent-005' }, managerA);
  assert.equal(timeBlocked.statusCode, 409, timeBlocked.body);
  assert.equal(timeBlocked.json().error, 'OUTSIDE_SENDING_WINDOW');
  assert.equal((await send('PUT', branchPolicyPath, { version: 4, sendingWindow: null }, managerA)).statusCode, 200);
  await db`UPDATE campaign SET status = 'INACTIVE' WHERE id = ${campaignId}`;
  assert.equal((await send('POST', messagePath,
    { body: 'Inactive', idempotencyKey: 'send-intent-006' }, managerA)).json().error, 'MESSAGING_NOT_ACTIVE');
  await db`UPDATE campaign SET status = 'ACTIVE' WHERE id = ${campaignId}`;
  assert.equal((await send('PUT', consentPath, { version: 4, status: 'REVOKED', doNotContact: true,
    evidence: 'Opt-out', source: 'ADMIN' }, admin)).statusCode, 200);
  assert.equal((await send('POST', messagePath,
    { body: 'After opt-out', idempotencyKey: 'send-intent-007' }, managerA)).json().error, 'DO_NOT_CONTACT');
  await db`UPDATE background_job SET run_after = now()
    WHERE id = (SELECT job_id FROM outbound_delivery_job WHERE message_id = ${secondMessageId})`;
  assert.equal(await processOneMessagingJob(db, acceptedAdapter), true);
  assert.equal(providerCalls, 2);
  assert.equal((await db`SELECT delivery_state, last_error_code FROM conversation_message
    WHERE id = ${secondMessageId}`)[0]!.last_error_code, 'DO_NOT_CONTACT');
  assert.equal((await send('POST', messagePath,
    { body: 'Hello', idempotencyKey: firstKey }, managerA)).json().id, queued.json().id);
  assert.equal((await db`SELECT count(*)::integer AS n FROM outbound_delivery_job j
    JOIN conversation_message m ON m.id = j.message_id WHERE m.conversation_id = ${conversationId}`)[0]!.n, 2);
  assert.equal((await send('PUT', consentPath, { version: 5, status: 'GRANTED', doNotContact: false,
    evidence: 'Reconfirmed opt-in', source: 'ADMIN' }, admin)).statusCode, 200);
  const unknownMessage = await send('POST', messagePath,
    { body: 'Unknown outcome', idempotencyKey: 'send-intent-008' }, managerA);
  const crashMessage = await send('POST', messagePath,
    { body: 'Crash recovery', idempotencyKey: 'send-intent-009' }, managerA);
  assert.equal(unknownMessage.statusCode, 202, unknownMessage.body);
  assert.equal(crashMessage.statusCode, 202, crashMessage.body);
  await db`UPDATE background_job SET run_after = now() - interval '1 minute'
    WHERE id = (SELECT job_id FROM outbound_delivery_job WHERE message_id = ${unknownMessage.json().id})`;
  let started!: () => void;
  let release!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const uncertainAdapter: MessagingSendAdapter = { async sendText() {
    providerCalls++; started(); await releasePromise;
    throw new ProviderSendError('UNKNOWN', 'PROVIDER_SEND_OUTCOME_UNKNOWN');
  } };
  const running = processOneMessagingJob(db, uncertainAdapter);
  await startedPromise;
  assert.equal(await processOneMessagingJob(db, acceptedAdapter), false);
  release();
  assert.equal(await running, true);
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id = ${unknownMessage.json().id}`)[0]!
    .delivery_state, 'UNKNOWN');
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'OUTBOUND_SEND_OUTCOME_UNKNOWN'
    AND target_id = ${unknownMessage.json().id}`).length);
  assert.equal((await db`SELECT needs_attention_reason FROM conversation WHERE id = ${conversationId}`)[0]!
    .needs_attention_reason, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(providerCalls, 3);
  const crashJob = (await db`SELECT job_id FROM outbound_delivery_job WHERE message_id = ${crashMessage.json().id}`)[0]!.job_id;
  await db`UPDATE background_job SET status = 'RUNNING', attempts = 1,
    locked_until = now() - interval '1 second' WHERE id = ${crashJob}`;
  await db`INSERT INTO outbound_send_attempt (message_id, job_id, attempt_number, state)
    VALUES (${crashMessage.json().id}, ${crashJob}, 1, 'PREPARED')`;
  assert.equal(await processOneMessagingJob(db, acceptedAdapter), true);
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id = ${crashMessage.json().id}`)[0]!
    .delivery_state, 'UNKNOWN');
  assert.equal(providerCalls, 3);
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'OUTBOUND_MESSAGE_QUEUED'
    AND target_id = ${queued.json().id}`).length);
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'CAMPAIGN_SENDER_OVERRIDE_SET'
    AND target_id = ${campaignId}`).length);
  // A shared sender can serve multiple campaigns; template visibility requires an explicit campaign binding.
  await db`UPDATE campaign SET sender_override_id = NULL WHERE id = ${campaignId}`;
  await db`UPDATE integration_connection SET status = 'CONNECTED' WHERE id = ${orgConnection.json().id}`;
  const orgTemplateId = (await db`INSERT INTO provider_message_template
    (connection_id, external_template_id, name, language, status, category, components)
    VALUES (${orgConnection.json().id}, '9090909', 'campaign_notice', 'en_US', 'PENDING',
      'UTILITY', ${db.json([{ type: 'BODY', text: 'Approved notice' }])}) RETURNING id`)[0]!.id as string;
  const campaignTemplatesPath = `/api/messaging/campaigns/${campaignId}/templates`;
  assert.equal((await send('GET', campaignTemplatesPath, undefined, agent)).statusCode, 403);
  assert.equal((await send('GET', campaignTemplatesPath, undefined, managerB)).statusCode, 404);
  assert.deepEqual((await send('GET', campaignTemplatesPath, undefined, managerA)).json().items, []);
  assert.equal((await send('GET', campaignTemplatesPath, undefined, admin)).json().items
    .find((item: { id: string }) => item.id === orgTemplateId).status, 'PENDING');
  const bindingPath = `${campaignTemplatesPath}/${orgTemplateId}`;
  assert.equal((await send('PUT', bindingPath, { version: 0, bound: true }, agent)).statusCode, 403);
  assert.equal((await send('PUT', bindingPath, { version: 0, bound: true }, managerB)).statusCode, 404);
  assert.equal((await send('PUT', bindingPath, { version: 0, bound: true }, managerA)).statusCode, 403);
  assert.equal((await send('PUT', bindingPath, { version: 0, bound: true }, admin)).json().error,
    'TEMPLATE_NOT_APPROVED');
  await db`UPDATE provider_message_template SET status = 'APPROVED' WHERE id = ${orgTemplateId}`;
  const secondConversationId = openings[0]!.json().id as string;
  const availablePath = `/api/conversations/${secondConversationId}/available-templates`;
  assert.equal((await send('GET', availablePath, undefined, managerB)).statusCode, 404);
  assert.deepEqual((await send('GET', availablePath, undefined, agent)).json().items, []);
  assert.equal((await send('PUT', bindingPath, { version: 0, bound: true }, admin)).statusCode, 200);
  assert.equal((await send('PUT', bindingPath, { version: 0, bound: true }, admin)).statusCode, 409);
  assert.equal((await send('GET', campaignTemplatesPath, undefined, managerA)).json().items[0].id,
    orgTemplateId);
  assert.equal((await send('GET', availablePath, undefined, agent)).json().items[0].id, orgTemplateId);
  assert.equal((await send('PUT', `/api/messaging/campaigns/${campaignId}/templates/${createdTemplate.json().id}`,
    { version: 0, bound: true }, admin)).statusCode, 404);
  const secondConsentPath = `/api/leads/${secondLeadId}/messaging-consent`;
  assert.equal((await send('PUT', secondConsentPath, { version: 0, status: 'GRANTED',
    doNotContact: false, evidence: 'Test opt-in', source: 'ADMIN' }, managerA)).statusCode, 200);
  const templateMessagePath = `/api/conversations/${secondConversationId}/messages`;
  assert.equal((await send('POST', templateMessagePath, { body: 'Freeform outside window',
    idempotencyKey: 'template-freeform-blocked' }, agent)).json().error, 'TEMPLATE_REQUIRED');
  assert.equal((await send('POST', templateMessagePath, { templateId: orgTemplateId,
    body: 'Forged body', idempotencyKey: 'template-forged-body' }, agent)).statusCode, 400);
  assert.equal((await send('POST', templateMessagePath, { templateId: createdTemplate.json().id,
    idempotencyKey: 'template-wrong-connection' }, agent)).json().error, 'TEMPLATE_NOT_AVAILABLE');
  await db`UPDATE provider_message_template SET status = 'REJECTED' WHERE id = ${orgTemplateId}`;
  assert.deepEqual((await send('GET', availablePath, undefined, agent)).json().items, []);
  assert.equal((await send('POST', templateMessagePath,
    { templateId: orgTemplateId, idempotencyKey: 'template-not-approved' }, agent)).json().error,
    'TEMPLATE_NOT_APPROVED');
  await db`UPDATE provider_message_template SET status = 'APPROVED' WHERE id = ${orgTemplateId}`;
  const queuedTemplate = await send('POST', templateMessagePath,
    { templateId: orgTemplateId, idempotencyKey: 'template-send-001' }, agent);
  assert.equal(queuedTemplate.statusCode, 202, queuedTemplate.body);
  assert.equal((await send('POST', templateMessagePath,
    { templateId: orgTemplateId, idempotencyKey: 'template-send-001' }, agent)).statusCode, 200);
  assert.equal((await send('POST', templateMessagePath,
    { body: 'Changed', idempotencyKey: 'template-send-001' }, agent)).json().error, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await db`SELECT message_kind, body FROM conversation_message
    WHERE id = ${queuedTemplate.json().id}`)[0]!.body, 'Approved notice');
  await assert.rejects(db`UPDATE conversation_message SET template_snapshot = '{}'::jsonb
    WHERE id = ${queuedTemplate.json().id}`);
  let templateProviderCalls = 0;
  const templateSendAdapter: MessagingSendAdapter = {
    async sendText() { throw new Error('template must not use freeform send'); },
    async sendTemplate(input) {
      templateProviderCalls++;
      assert.equal(input.templateName, 'campaign_notice');
      assert.equal(input.templateLanguage, 'en_US');
      assert.equal(input.recipient, '+15550004444');
      return { providerMessageId: `wamid.template-${templateProviderCalls}` };
    },
  };
  assert.equal(await processOneMessagingJob(db, templateSendAdapter), true);
  assert.equal(templateProviderCalls, 1);
  assert.equal((await db`SELECT delivery_state FROM conversation_message
    WHERE id = ${queuedTemplate.json().id}`)[0]!.delivery_state, 'SENT');
  assert.equal((await send('PUT', bindingPath, { version: 1, bound: false }, admin)).statusCode, 200);
  assert.equal((await send('POST', templateMessagePath,
    { templateId: orgTemplateId, idempotencyKey: 'template-unbound' }, agent)).json().error,
    'TEMPLATE_NOT_AVAILABLE');
  assert.equal((await send('PUT', bindingPath, { version: 2, bound: true }, admin)).statusCode, 200);
  const changedTemplate = await send('POST', templateMessagePath,
    { templateId: orgTemplateId, idempotencyKey: 'template-send-002' }, agent);
  assert.equal(changedTemplate.statusCode, 202, changedTemplate.body);
  await db`UPDATE provider_message_template SET components = ${db.json([{ type: 'BODY', text: 'Changed remotely' }])}
    WHERE id = ${orgTemplateId}`;
  assert.equal(await processOneMessagingJob(db, templateSendAdapter), true);
  assert.equal(templateProviderCalls, 1);
  assert.equal((await db`SELECT delivery_state, last_error_code FROM conversation_message
    WHERE id = ${changedTemplate.json().id}`)[0]!.last_error_code, 'TEMPLATE_CHANGED');
  assert.equal((await db`SELECT needs_attention_reason FROM conversation
    WHERE id = ${secondConversationId}`)[0]!.needs_attention_reason, 'TEMPLATE_CHANGED');
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'CAMPAIGN_TEMPLATE_BOUND'
    AND target_id = ${campaignId}`).length);
  const flood = await Promise.all(Array.from({ length: 12 }, () => send('POST',
    `/api/messaging/connections/${id}/test`, undefined, managerA)));
  assert.ok(flood.some((response) => response.statusCode === 429 && response.json().error === 'RATE_LIMITED'));
  assert.ok(flood.every((response) => response.statusCode !== 500));
});

test('Meta operational test send requires approved template, scopes access, and records uncertain outcomes without retry', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const db = createDatabase(url);
  let calls = 0;
  let mode: 'ACCEPT'|'UNKNOWN'|'AUTH' = 'ACCEPT';
  let hold: Promise<void> | null = null;
  let started: (() => void) | null = null;
  const sendAdapter: MessagingSendAdapter = {
    async sendText() { throw new Error('test send must use a template'); },
    async sendTemplate(input) {
      calls++;
      assert.equal(input.credentials.accessToken, 'test-access-token-123456789');
      assert.equal(input.externalSenderId, '15550001111');
      assert.equal(input.templateName, 'approved_test');
      assert.equal(input.templateLanguage, 'en_US');
      assert.equal(input.recipient, '+15550009999');
      if (hold) { started?.(); await hold; }
      if (mode === 'UNKNOWN') throw new ProviderSendError('UNKNOWN', 'PROVIDER_SEND_OUTCOME_UNKNOWN');
      if (mode === 'AUTH') throw new ProviderSendError('REJECTED', 'PROVIDER_AUTH_FAILED');
      return { providerMessageId: `wamid.test-${calls}` };
    },
  };
  const app = await buildApp(db, { logger: false, globalRateLimitMax: 1000,
    messagingAdapter: { async discoverSenders() { return [{ externalId: '15550001111',
      displayName: 'Test sender', qualityRating: 'GREEN' }]; } }, messagingSendAdapter: sendAdapter });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
  const send = (method: 'GET'|'POST'|'PUT'|'PATCH', path: string, payload?: object, cookie?: string) => app.inject({
    method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, ...(cookie ? { cookie } : {}) },
  });
  const password = 'Test password 12345!';
  assert.equal((await send('POST', '/api/setup/bootstrap', { token: process.env.BOOTSTRAP_TOKEN,
    organizationName: 'Test Send Org', name: 'Owner', email: 'owner@example.test', password })).statusCode, 201);
  const login = async (email: string) => {
    const response = await send('POST', '/api/auth/login', { email, password });
    assert.equal(response.statusCode, 200, response.body);
    return (response.headers['set-cookie'] as string).split(';')[0]!;
  };
  const admin = await login('owner@example.test');
  const branchA = (await send('POST', '/api/branches', { name: 'A', timezone: 'UTC' }, admin)).json().id as string;
  const branchB = (await send('POST', '/api/branches', { name: 'B', timezone: 'UTC' }, admin)).json().id as string;
  const orgId = (await db`SELECT id FROM organization LIMIT 1`)[0]!.id as string;
  const hash = await passwordHash(password);
  for (const [email, branchId, role] of [
    ['manager-a@example.test', branchA, 'MANAGER'], ['manager-b@example.test', branchB, 'MANAGER'],
    ['agent@example.test', branchA, 'AGENT'],
  ] as const) await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash)
    VALUES (${orgId}, ${branchId}, ${role}, ${email}, ${email}, ${hash})`;
  const managerA = await login('manager-a@example.test');
  const managerB = await login('manager-b@example.test');
  const agent = await login('agent@example.test');
  const setup = { name: 'Branch WhatsApp', config: { wabaId: '123456789012345', graphVersion: 'v25.0' },
    credentials: { accessToken: 'test-access-token-123456789', appSecret: 'test-app-secret-123456789',
      verifyToken: 'test-verify-token-123456789' } };
  const connection = await send('POST', '/api/messaging/connections', setup, managerA);
  assert.equal(connection.statusCode, 201, connection.body);
  const connectionId = connection.json().id as string;
  const path = `/api/messaging/connections/${connectionId}/test-send`;
  const listPath = `/api/messaging/connections/${connectionId}/test-sends`;
  const base = { senderId: randomUUID(), templateId: randomUUID(),
    recipient: '+15550009999', recipientConfirmed: true, idempotencyKey: 'test-send-key-001' };
  assert.equal((await send('POST', path, base, managerA)).json().error, 'CONNECTION_DISCOVERY_REQUIRED');
  assert.equal((await send('POST', `/api/messaging/connections/${connectionId}/test`, undefined, managerA)).statusCode, 200);
  const senderId = (await db`SELECT id FROM messaging_sender WHERE connection_id = ${connectionId}`)[0]!.id as string;
  const templateId = (await db`INSERT INTO provider_message_template
    (connection_id, external_template_id, name, language, status, category, components)
    VALUES (${connectionId}, '9001', 'approved_test', 'en_US', 'APPROVED', 'UTILITY',
      ${db.json([{ type: 'BODY', text: 'A test message' }])}) RETURNING id`)[0]!.id as string;
  const input = { ...base, senderId, templateId };
  assert.equal((await send('POST', path, input, agent)).statusCode, 403);
  assert.equal((await send('GET', listPath, undefined, agent)).statusCode, 403);
  assert.equal((await send('POST', path, input, managerB)).statusCode, 404);
  assert.equal((await send('GET', listPath, undefined, managerB)).statusCode, 404);
  assert.equal((await send('POST', path, { ...input, recipientConfirmed: false }, managerA)).statusCode, 400);
  assert.equal((await send('POST', path, { ...input, recipient: '15550009999' }, managerA)).statusCode, 400);
  assert.equal((await send('POST', path, { ...input, senderId: randomUUID() }, managerA)).json().error,
    'TEST_SENDER_UNAVAILABLE');
  const foreignSender = (await db`INSERT INTO messaging_sender
    (organization_id, connection_id, external_sender_id, display_name)
    VALUES (${orgId}, ${connectionId}, '15550002222', 'Disabled') RETURNING id`)[0]!.id as string;
  await db`UPDATE messaging_sender SET active = false WHERE id = ${foreignSender}`;
  assert.equal((await send('POST', path, { ...input, senderId: foreignSender }, managerA)).json().error,
    'TEST_SENDER_UNAVAILABLE');
  await db`UPDATE provider_message_template SET status = 'PENDING' WHERE id = ${templateId}`;
  assert.equal((await send('POST', path, input, managerA)).json().error, 'TEMPLATE_NOT_APPROVED');
  await db`UPDATE provider_message_template SET status = 'APPROVED',
    components = ${db.json([{ type: 'BODY', text: 'Hello {{1}}' }])} WHERE id = ${templateId}`;
  assert.equal((await send('POST', path, input, managerA)).json().error, 'TEMPLATE_FORMAT_UNSUPPORTED');
  await db`UPDATE provider_message_template SET components = ${db.json([{ type: 'BODY', text: 'A test message' }])}
    WHERE id = ${templateId}`;
  const accepted = await send('POST', path, input, managerA);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().state, 'SUCCEEDED');
  assert.equal(accepted.json().outboundReady, true);
  assert.equal(calls, 1);
  assert.equal((await send('POST', path, input, managerA)).json().replayed, true);
  assert.equal(calls, 1);
  assert.equal((await send('POST', path, { ...input, recipient: '+15550008888' }, managerA)).json().error,
    'IDEMPOTENCY_KEY_REUSED');
  const readiness = (await db`SELECT status, capabilities, last_error_code FROM integration_connection
    WHERE id = ${connectionId}`)[0]!;
  assert.equal(readiness.status, 'CONNECTED');
  assert.equal(readiness.capabilities.outboundAccepted, true);
  assert.equal(readiness.capabilities.webhookVerified, false);
  assert.equal((await db`SELECT health FROM messaging_sender WHERE id = ${senderId}`)[0]!.health, 'DEGRADED');
  const history = await send('GET', listPath, undefined, managerA);
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items[0].recipient_last4, '9999');
  assert.equal(history.body.includes('+15550009999'), false);
  assert.equal(history.body.includes(setup.credentials.accessToken), false);
  mode = 'UNKNOWN';
  const uncertain = await send('POST', path, { ...input, idempotencyKey: 'test-send-key-002' }, managerA);
  assert.equal(uncertain.statusCode, 202, uncertain.body);
  assert.equal(uncertain.json().state, 'UNKNOWN');
  assert.equal((await send('POST', path, { ...input, idempotencyKey: 'test-send-key-002' }, managerA)).json().error,
    'TEST_SEND_OUTCOME_UNKNOWN');
  assert.equal(calls, 2);
  const staleId = (await db`INSERT INTO messaging_connection_test_send (connection_id, connection_version,
    sender_id, template_id, idempotency_key, request_hash, recipient_last4, state, created_by, created_at)
    SELECT connection_id, connection_version, sender_id, template_id, 'stale-test-send', request_hash,
      recipient_last4, 'IN_PROGRESS', created_by, now() - interval '3 minutes'
      FROM messaging_connection_test_send WHERE id = ${accepted.json().id} RETURNING id`)[0]!.id as string;
  assert.equal((await send('POST', path, { ...input, idempotencyKey: 'stale-test-send' }, managerA)).json().error,
    'TEST_SEND_OUTCOME_UNKNOWN');
  assert.equal((await db`SELECT state FROM messaging_connection_test_send WHERE id = ${staleId}`)[0]!.state, 'UNKNOWN');
  mode = 'AUTH';
  const auth = await send('POST', path, { ...input, idempotencyKey: 'test-send-key-003' }, managerA);
  assert.equal(auth.statusCode, 200, auth.body);
  assert.equal(auth.json().state, 'REJECTED');
  assert.equal((await db`SELECT status FROM integration_connection WHERE id = ${connectionId}`)[0]!.status,
    'AUTH_EXPIRED');
  assert.equal((await send('POST', path, { ...input, idempotencyKey: 'test-send-key-004' }, managerA)).json().error,
    'CONNECTION_DISCOVERY_REQUIRED');
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'MESSAGING_TEST_SEND_ACCEPTED'
    AND target_id = ${connectionId}`).length);
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'MESSAGING_TEST_SEND_UNKNOWN'
    AND target_id = ${connectionId}`).length);
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'MESSAGING_TEST_SEND_REJECTED'
    AND target_id = ${connectionId}`).length);
  mode = 'ACCEPT';
  assert.equal((await send('POST', `/api/messaging/connections/${connectionId}/test`, undefined, managerA)).statusCode, 200);
  let release!: () => void;
  let begin!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { begin = resolve; });
  started = begin;
  const raceInput = { ...input, idempotencyKey: 'test-send-key-race' };
  const running = send('POST', path, raceInput, managerA);
  await began;
  assert.equal((await send('POST', path, raceInput, managerA)).json().error, 'TEST_SEND_IN_PROGRESS');
  const update = await send('PUT', `/api/messaging/connections/${connectionId}`,
    { name: 'Rotated', config: setup.config, version: 1 }, managerA);
  assert.equal(update.statusCode, 200, update.body);
  release();
  const afterRotation = await running;
  assert.equal(afterRotation.statusCode, 200, afterRotation.body);
  assert.equal(afterRotation.json().state, 'SUCCEEDED');
  assert.equal(afterRotation.json().outboundReady, false);
  assert.equal((await db`SELECT status FROM integration_connection WHERE id = ${connectionId}`)[0]!.status,
    'NOT_CONFIGURED');
  assert.deepEqual((await db`SELECT capabilities FROM integration_connection WHERE id = ${connectionId}`)[0]!
    .capabilities, {});
  assert.equal(calls, 4);
});

test('signed Meta callbacks preserve delivery history and never regress on replay or out-of-order status', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const db = createDatabase(url);
  const app = await buildApp(db, { logger: false, globalRateLimitMax: 1000,
    messagingAdapter: { async discoverSenders() { return [{ externalId: '15550001111',
      displayName: 'Test sender', qualityRating: 'GREEN' }]; } } });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
  const api = (method: 'GET'|'POST', path: string, payload?: object, cookie?: string) => app.inject({
    method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, ...(cookie ? { cookie } : {}) },
  });
  const password = 'Test password 12345!';
  assert.equal((await api('POST', '/api/setup/bootstrap', { token: process.env.BOOTSTRAP_TOKEN,
    organizationName: 'Webhook Org', name: 'Owner', email: 'owner@example.test', password })).statusCode, 201);
  const login = async (email: string) => {
    const response = await api('POST', '/api/auth/login', { email, password });
    assert.equal(response.statusCode, 200, response.body);
    return (response.headers['set-cookie'] as string).split(';')[0]!;
  };
  const admin = await login('owner@example.test');
  const branchId = (await api('POST', '/api/branches', { name: 'A', timezone: 'UTC' }, admin)).json().id as string;
  const otherBranchId = (await api('POST', '/api/branches', { name: 'B', timezone: 'UTC' }, admin)).json().id as string;
  const orgId = (await db`SELECT id FROM organization LIMIT 1`)[0]!.id as string;
  const hash = await passwordHash(password);
  for (const [email, branch, role] of [
    ['manager@example.test', branchId, 'MANAGER'], ['other@example.test', otherBranchId, 'MANAGER'],
    ['agent@example.test', branchId, 'AGENT'],
  ] as const) await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash)
    VALUES (${orgId}, ${branch}, ${role}, ${email}, ${email}, ${hash})`;
  const manager = await login('manager@example.test');
  const other = await login('other@example.test');
  const agent = await login('agent@example.test');
  const managerId = (await db`SELECT id FROM user_account WHERE email = 'manager@example.test'`)[0]!.id as string;
  const appSecret = 'test-app-secret-123456789';
  const verifyToken = 'test-verify-token-123456789';
  const setup = await api('POST', '/api/messaging/connections', { name: 'Webhook sender',
    config: { wabaId: '123456789012345', graphVersion: 'v25.0' },
    credentials: { accessToken: 'test-access-token-123456789', appSecret, verifyToken } }, manager);
  assert.equal(setup.statusCode, 201, setup.body);
  const connectionId = setup.json().id as string;
  assert.equal((await api('POST', `/api/messaging/connections/${connectionId}/test`, undefined, manager)).statusCode, 200);
  const senderId = (await db`SELECT id FROM messaging_sender WHERE connection_id = ${connectionId}`)[0]!.id as string;
  const campaignId = (await db`INSERT INTO campaign (organization_id, branch_id, name)
    VALUES (${orgId}, ${branchId}, 'Callbacks') RETURNING id`)[0]!.id as string;
  const contactId = (await db`INSERT INTO contact (organization_id, name, phone, phone_normalized)
    VALUES (${orgId}, 'Recipient', '+15550009999', '+15550009999') RETURNING id`)[0]!.id as string;
  const leadId = (await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
    VALUES (${orgId}, ${branchId}, ${campaignId}, ${contactId}, 'MANUAL') RETURNING id`)[0]!.id as string;
  const conversationId = (await db`INSERT INTO conversation (lead_id, connection_id, sender_id, channel,
    participant_ref, controller_type, controller_user_id, state)
    VALUES (${leadId}, ${connectionId}, ${senderId}, 'WHATSAPP', '+15550009999',
      'HUMAN', ${managerId}, 'HUMAN_ACTIVE') RETURNING id`)[0]!.id as string;
  const messageId = (await db`INSERT INTO conversation_message (conversation_id, connection_id, sender_id,
    direction, author_type, author_user_id, body, provider_message_id, delivery_state, delivery_rank, sent_at)
    VALUES (${conversationId}, ${connectionId}, ${senderId}, 'OUTBOUND', 'HUMAN', ${managerId},
      'Hello', 'wamid.callback-1', 'SENT', 1, now()) RETURNING id`)[0]!.id as string;
  const path = `/api/webhooks/messaging/meta/${connectionId}`;
  const infoPath = `/api/messaging/connections/${connectionId}/webhook`;
  const eventsPath = `/api/messaging/connections/${connectionId}/events`;
  assert.equal((await api('GET', infoPath, undefined, agent)).statusCode, 403);
  assert.equal((await api('GET', eventsPath, undefined, other)).statusCode, 404);
  assert.equal((await api('GET', infoPath, undefined, manager)).json().signedCallbackVerified, false);
  const verify = (token: string) => app.inject({ method: 'GET',
    url: `${path}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=challenge-123` });
  assert.equal((await verify('wrong-token')).statusCode, 403);
  const verified = await verify(verifyToken);
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.body, 'challenge-123');
  assert.equal((await api('GET', infoPath, undefined, manager)).json().handshakeVerified, true);
  const callback = (payload: object, signed = true) => {
    const raw = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
    return app.inject({ method: 'POST', url: path, payload: raw, headers: {
      'content-type': 'application/json', ...(signed ? { 'x-hub-signature-256': signature } : {}),
    } });
  };
  const epoch = Math.floor(Date.now() / 1000);
  const payload = (status: string, timestamp: number, id = 'wamid.callback-1',
    sender = '15550001111') => ({ object: 'whatsapp_business_account', entry: [{ id: '123456789012345',
      changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
        metadata: { phone_number_id: sender }, statuses: [{ id, status,
          timestamp: String(timestamp), recipient_id: '15550009999' }] } }] }] });
  const delivered = payload('delivered', epoch);
  assert.equal((await callback(delivered, false)).statusCode, 403);
  const badSignature = await app.inject({ method: 'POST', url: path, payload: JSON.stringify(delivered),
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
  assert.equal(badSignature.statusCode, 403);
  assert.equal((await callback({ ...delivered, entry: [{ id: 'wrong-waba', changes: delivered.entry[0]!.changes }] }))
    .statusCode, 400);
  assert.equal((await callback({ bad: 'payload' })).statusCode, 400);
  const first = await callback(delivered);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().created, 1);
  assert.equal((await db`SELECT delivery_state, delivery_rank FROM conversation_message WHERE id = ${messageId}`)[0]!
    .delivery_state, 'DELIVERED');
  assert.equal((await callback(delivered)).json().created, 0);
  assert.equal((await callback(payload('read', epoch + 20))).statusCode, 200);
  assert.equal((await callback(payload('sent', epoch - 20))).statusCode, 200);
  assert.equal((await callback(payload('failed', epoch + 30))).statusCode, 200);
  const current = (await db`SELECT delivery_state, delivery_rank FROM conversation_message WHERE id = ${messageId}`)[0]!;
  assert.equal(current.delivery_state, 'READ');
  assert.equal(current.delivery_rank, 4);
  assert.equal((await db`SELECT count(*)::integer AS n FROM message_delivery_event
    WHERE message_id = ${messageId}`)[0]!.n, 4);
  assert.equal((await api('GET', infoPath, undefined, manager)).json().signedCallbackVerified, true);
  assert.equal((await db`SELECT health FROM messaging_sender WHERE id = ${senderId}`)[0]!.health, 'HEALTHY');
  const unknown = await callback(payload('delivered', epoch + 40, 'wamid.late'));
  assert.equal(unknown.statusCode, 200, unknown.body);
  assert.equal((await db`SELECT state, failure_code FROM integration_event
    WHERE connection_id = ${connectionId} AND payload->>'providerMessageId' = 'wamid.late'`)[0]!
    .failure_code, 'MESSAGE_NOT_FOUND');
  const lateMessageId = (await db`INSERT INTO conversation_message (conversation_id, connection_id, sender_id,
    direction, author_type, author_user_id, body, provider_message_id, delivery_state, delivery_rank, sent_at)
    VALUES (${conversationId}, ${connectionId}, ${senderId}, 'OUTBOUND', 'HUMAN', ${managerId},
      'Late', 'wamid.late', 'SENT', 1, now()) RETURNING id`)[0]!.id as string;
  assert.equal(await processOnePendingDeliveryEvent(db), true);
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id = ${lateMessageId}`)[0]!
    .delivery_state, 'DELIVERED');
  assert.equal(await processOnePendingDeliveryEvent(db), false);
  const templateId = (await db`INSERT INTO provider_message_template
    (connection_id, external_template_id, name, language, status, components)
    VALUES (${connectionId}, '991', 'callback_test', 'en_US', 'APPROVED',
      ${db.json([{ type: 'BODY', text: 'Test' }])}) RETURNING id`)[0]!.id as string;
  await db`INSERT INTO messaging_connection_test_send (connection_id, connection_version,
    sender_id, template_id, idempotency_key, request_hash, recipient_last4, state,
    provider_message_id, delivery_state, created_by)
    VALUES (${connectionId}, 1, ${senderId}, ${templateId}, 'webhook-test-attempt', 'test-hash',
      '9999', 'SUCCEEDED', 'wamid.test-callback', 'SENT', ${managerId})`;
  assert.equal((await callback(payload('delivered', epoch + 50, 'wamid.test-callback'))).statusCode, 200);
  assert.equal((await db`SELECT delivery_state FROM messaging_connection_test_send
    WHERE provider_message_id = 'wamid.test-callback'`)[0]!.delivery_state, 'DELIVERED');
  const failedMessageId = (await db`INSERT INTO conversation_message (conversation_id, connection_id, sender_id,
    direction, author_type, author_user_id, body, provider_message_id, delivery_state, delivery_rank, sent_at)
    VALUES (${conversationId}, ${connectionId}, ${senderId}, 'OUTBOUND', 'HUMAN', ${managerId},
      'Failed', 'wamid.failed-then-delivered', 'SENT', 1, now()) RETURNING id`)[0]!.id as string;
  assert.equal((await callback(payload('failed', epoch + 60, 'wamid.failed-then-delivered'))).statusCode, 200);
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id = ${failedMessageId}`)[0]!
    .delivery_state, 'FAILED');
  assert.equal((await callback(payload('sent', epoch + 55, 'wamid.failed-then-delivered'))).statusCode, 200);
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id = ${failedMessageId}`)[0]!
    .delivery_state, 'FAILED');
  assert.equal((await callback(payload('delivered', epoch + 70, 'wamid.failed-then-delivered'))).statusCode, 200);
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id = ${failedMessageId}`)[0]!
    .delivery_state, 'DELIVERED');
  const secondSender = (await db`INSERT INTO messaging_sender
    (organization_id, connection_id, external_sender_id, display_name)
    VALUES (${orgId}, ${connectionId}, '15550002222', 'Other sender') RETURNING id`)[0]!.id as string;
  assert.ok(secondSender);
  assert.equal((await callback(payload('read', epoch + 80, 'wamid.callback-1', '15550002222'))).statusCode, 200);
  assert.equal((await db`SELECT failure_code FROM integration_event WHERE connection_id = ${connectionId}
    AND sender_id = ${secondSender}`)[0]!.failure_code, 'SENDER_MISMATCH');
  const wrongRecipient = payload('read', epoch + 90);
  wrongRecipient.entry[0]!.changes[0]!.value.statuses[0]!.recipient_id = '15550008888';
  assert.equal((await callback(wrongRecipient)).statusCode, 200);
  assert.ok((await db`SELECT 1 FROM integration_event WHERE connection_id = ${connectionId}
    AND failure_code = 'PARTICIPANT_MISMATCH'`).length);
  assert.equal(await processOnePendingDeliveryEvent(db), false);
  const inbound = { object: 'whatsapp_business_account', entry: [{ id: '123456789012345',
    changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      metadata: { phone_number_id: '15550001111' }, messages: [{ id: 'wamid.inbound-1',
        from: '15550009999', timestamp: String(epoch), type: 'text', text: { body: '<script>alert(1)</script>' } }] } }] }] };
  assert.equal((await callback(inbound)).statusCode, 200);
  assert.equal((await callback(inbound)).json().created, 0);
  const attention = (await api('GET', infoPath, undefined, manager)).json();
  assert.equal(attention.needsAttention, 3);
  const events = await api('GET', eventsPath, undefined, manager);
  assert.equal(events.statusCode, 200, events.body);
  assert.equal(events.body.includes('15550009999'), false);
  assert.equal(events.body.includes('<script>'), false);
  assert.ok(events.json().items.some((event: { event_kind: string; state: string }) =>
    event.event_kind === 'INBOUND_MESSAGE' && event.state === 'NEEDS_ATTENTION'));
  const inboundEventId = (await db`SELECT id FROM integration_event WHERE connection_id = ${connectionId}
    AND event_kind = 'INBOUND_MESSAGE' AND payload->'message'->>'id' = 'wamid.inbound-1'`)[0]!.id as string;
  const reviewPath = `/api/messaging/connections/${connectionId}/inbound-review`;
  assert.equal((await api('GET', reviewPath, undefined, agent)).statusCode, 403);
  assert.equal((await api('GET', reviewPath, undefined, other)).statusCode, 404);
  assert.equal(await processOneInboundEvent(db), true);
  const attached = (await db`SELECT cv.id AS conversation_id, m.body FROM conversation_message m
    JOIN conversation cv ON cv.id = m.conversation_id WHERE m.provider_message_id = 'wamid.inbound-1'`)[0]!;
  assert.equal(attached.conversation_id, conversationId);
  assert.equal(attached.body, '<script>alert(1)</script>');
  assert.equal((await db`SELECT state FROM integration_event WHERE id = ${inboundEventId}`)[0]!.state, 'PROCESSED');
  assert.equal(await processOneInboundEvent(db), false);
  const reviewDetailPath = `${reviewPath}/${inboundEventId}`;
  assert.equal((await api('GET', reviewDetailPath, undefined, agent)).statusCode, 403);
  assert.equal((await api('GET', reviewDetailPath, undefined, other)).statusCode, 404);
  assert.equal((await api('GET', reviewDetailPath, undefined, manager)).json().event.body,
    '<script>alert(1)</script>');
  assert.equal((await api('POST', `${reviewDetailPath}/resolve`, { leadId }, manager)).json().existing, true);
  assert.equal((await callback(inbound)).json().created, 0);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message
    WHERE provider_message_id = 'wamid.inbound-1'`)[0]!.n, 1);

  await db`UPDATE branch SET default_sender_id = ${senderId} WHERE id = ${branchId}`;
  const makeInbound = (id: string, phone: string, type = 'text', contextId?: string) => ({
    object: 'whatsapp_business_account', entry: [{ id: '123456789012345', changes: [{
      field: 'messages', value: { messaging_product: 'whatsapp',
        metadata: { phone_number_id: '15550001111' }, messages: [{ id, from: phone,
          timestamp: String(epoch), type, ...(type === 'text' ? { text: { body: `Inbound ${id}` } } : {}),
          ...(contextId ? { context: { id: contextId } } : {}) }] },
    }] }],
  });
  assert.equal((await callback(makeInbound('wamid.context', '15550009999', 'text',
    'wamid.callback-1'))).statusCode, 200);
  const contextEventId = (await db`SELECT id FROM integration_event WHERE connection_id = ${connectionId}
    AND payload->'message'->>'id' = 'wamid.context'`)[0]!.id as string;
  assert.equal((await api('POST', `${reviewPath}/${contextEventId}/resolve`,
    { leadId: randomUUID() }, manager)).json().error, 'INBOUND_CONTEXT_TARGET_CONFLICT');
  assert.equal(await processOneInboundEvent(db), true);
  assert.equal((await db`SELECT conversation_id FROM integration_event WHERE id = ${contextEventId}`)[0]!
    .conversation_id, conversationId);
  const loneContact = (await db`INSERT INTO contact (organization_id, name, phone, phone_normalized)
    VALUES (${orgId}, 'Lone', '+15550006666', '+15550006666') RETURNING id`)[0]!.id as string;
  const loneLead = (await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
    VALUES (${orgId}, ${branchId}, ${campaignId}, ${loneContact}, 'MANUAL') RETURNING id`)[0]!.id as string;
  assert.equal((await callback(makeInbound('wamid.new-lead', '15550006666'))).statusCode, 200);
  assert.equal(await processOneInboundEvent(db), true);
  const newConversation = (await db`SELECT cv.id, cv.controller_type, cv.state, cv.needs_attention_reason
    FROM conversation cv WHERE cv.lead_id = ${loneLead}`)[0]!;
  assert.equal(newConversation.controller_type, 'NONE');
  assert.equal(newConversation.state, 'WAITING_FOR_HUMAN');
  assert.equal(newConversation.needs_attention_reason, 'NO_HUMAN_CONTROLLER');
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message
    WHERE conversation_id = ${newConversation.id} AND direction = 'INBOUND'`)[0]!.n, 1);
  const takeoverPath = `/api/conversations/${newConversation.id}/takeover`;
  const takeoverInput = { version: 1, reason: 'Manager accepted inbound conversation' };
  assert.equal((await api('POST', takeoverPath, takeoverInput, agent)).statusCode, 404);
  assert.equal((await api('POST', takeoverPath, takeoverInput, other)).statusCode, 404);
  assert.equal((await api('POST', takeoverPath, { version: 1, reason: ' ' }, manager)).statusCode, 400);
  const takeover = await api('POST', takeoverPath, takeoverInput, manager);
  assert.equal(takeover.statusCode, 200, takeover.body);
  assert.equal(takeover.json().state, 'HUMAN_ACTIVE');
  assert.equal((await api('POST', takeoverPath, takeoverInput, manager)).statusCode, 409);
  assert.equal((await api('POST', takeoverPath, { ...takeoverInput, version: 2 }, manager)).json().existing, true);
  assert.equal((await db`SELECT controller_type, controller_user_id, needs_attention_reason FROM conversation
    WHERE id = ${newConversation.id}`)[0]!.controller_user_id, managerId);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_handoff
    WHERE conversation_id = ${newConversation.id}`)[0]!.n, 1);
  const sharedContact = (await db`INSERT INTO contact (organization_id, name, phone, phone_normalized)
    VALUES (${orgId}, 'Shared', '+15550008888', '+15550008888') RETURNING id`)[0]!.id as string;
  const leadOne = (await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
    VALUES (${orgId}, ${branchId}, ${campaignId}, ${sharedContact}, 'MANUAL') RETURNING id`)[0]!.id as string;
  const leadTwo = (await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
    VALUES (${orgId}, ${branchId}, ${campaignId}, ${sharedContact}, 'MANUAL') RETURNING id`)[0]!.id as string;
  assert.equal((await callback(makeInbound('wamid.ambiguous', '15550008888'))).statusCode, 200);
  assert.equal(await processOneInboundEvent(db), true);
  const ambiguousId = (await db`SELECT id FROM integration_event WHERE connection_id = ${connectionId}
    AND payload->'message'->>'id' = 'wamid.ambiguous'`)[0]!.id as string;
  assert.equal((await db`SELECT failure_code FROM integration_event WHERE id = ${ambiguousId}`)[0]!
    .failure_code, 'MULTIPLE_ACTIVE_LEADS');
  assert.equal(await processOneInboundEvent(db), false);
  const detail = await api('GET', `${reviewPath}/${ambiguousId}`, undefined, manager);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().leads.map((lead: { id: string }) => lead.id).sort(), [leadOne, leadTwo].sort());
  assert.equal(detail.body.includes('15550008888'), false);
  const resolvePath = `${reviewPath}/${ambiguousId}/resolve`;
  assert.equal((await api('POST', resolvePath, { leadId: leadOne }, agent)).statusCode, 403);
  assert.equal((await api('POST', resolvePath, { leadId: leadOne }, other)).statusCode, 404);
  const competing = await Promise.all([leadOne, leadTwo].map((target) =>
    api('POST', resolvePath, { leadId: target }, manager)));
  assert.deepEqual(competing.map((response) => response.statusCode).sort(), [200,409]);
  const chosenLead = competing[0]!.statusCode === 200 ? leadOne : leadTwo;
  assert.equal((await db`SELECT lead_id, state FROM integration_event WHERE id = ${ambiguousId}`)[0]!
    .lead_id, chosenLead);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message
    WHERE provider_message_id = 'wamid.ambiguous'`)[0]!.n, 1);
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'INBOUND_MESSAGE_ATTACHED'
    AND detail->>'eventId' = ${ambiguousId}`).length);
  assert.equal((await api('POST', resolvePath, { leadId: chosenLead }, manager)).json().existing, true);
  assert.equal((await callback(makeInbound('wamid.unsupported', '15550007777', 'image'))).statusCode, 200);
  assert.equal(await processOneInboundEvent(db), true);
  const unsupportedId = (await db`SELECT id FROM integration_event WHERE connection_id = ${connectionId}
    AND payload->'message'->>'id' = 'wamid.unsupported'`)[0]!.id as string;
  assert.equal((await db`SELECT failure_code FROM integration_event WHERE id = ${unsupportedId}`)[0]!
    .failure_code, 'INBOUND_CONTENT_UNSUPPORTED');
  assert.equal((await api('POST', `${reviewPath}/${unsupportedId}/ignore`, { reason: 'Unsupported media' }, manager))
    .json().state, 'IGNORED');
  assert.equal((await api('POST', `${reviewPath}/${unsupportedId}/ignore`, { reason: 'Unsupported media' }, manager))
    .json().existing, true);
  assert.equal((await api('POST', `${reviewPath}/${unsupportedId}/resolve`, { leadId: loneLead }, manager))
    .statusCode, 409);
  assert.equal((await db`SELECT review_note FROM integration_event WHERE id = ${unsupportedId}`)[0]!
    .review_note, 'Unsupported media');
  const concurrentContact = (await db`INSERT INTO contact (organization_id, name, phone, phone_normalized)
    VALUES (${orgId}, 'Concurrent', '+15550005555', '+15550005555') RETURNING id`)[0]!.id as string;
  const concurrentLead = (await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
    VALUES (${orgId}, ${branchId}, ${campaignId}, ${concurrentContact}, 'MANUAL') RETURNING id`)[0]!.id as string;
  assert.equal((await callback(makeInbound('wamid.concurrent-1', '15550005555'))).statusCode, 200);
  assert.equal((await callback(makeInbound('wamid.concurrent-2', '15550005555'))).statusCode, 200);
  assert.deepEqual(await Promise.all([processOneInboundEvent(db), processOneInboundEvent(db)]), [true, true]);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation
    WHERE lead_id = ${concurrentLead} AND state <> 'CLOSED'`)[0]!.n, 1);
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message m
    JOIN conversation cv ON cv.id = m.conversation_id WHERE cv.lead_id = ${concurrentLead}
      AND m.direction = 'INBOUND'`)[0]!.n, 2);
  await db`UPDATE messaging_sender SET operator_enabled = false WHERE id = ${senderId}`;
  assert.equal((await callback(makeInbound('wamid.disabled-sender', '15550009999'))).statusCode, 200);
  assert.equal(await processOneInboundEvent(db), true);
  assert.equal((await db`SELECT failure_code FROM integration_event WHERE connection_id = ${connectionId}
    AND payload->'message'->>'id' = 'wamid.disabled-sender'`)[0]!.failure_code, 'SENDER_DISABLED');
  assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message
    WHERE provider_message_id = 'wamid.disabled-sender'`)[0]!.n, 0);
  const sharedSetup = await api('POST', '/api/messaging/connections', { name: 'Shared webhook',
    config: { wabaId: '123456789012345', graphVersion: 'v25.0' },
    credentials: { accessToken: 'test-access-token-123456789', appSecret, verifyToken } }, admin);
  assert.equal(sharedSetup.statusCode, 201, sharedSetup.body);
  const sharedId = sharedSetup.json().id as string;
  assert.equal((await api('POST', `/api/messaging/connections/${sharedId}/test`, undefined, admin)).statusCode, 200);
  const sharedSenderId = (await db`SELECT id FROM messaging_sender WHERE connection_id = ${sharedId}`)[0]!.id as string;
  await db`INSERT INTO sender_branch_binding (sender_id, branch_id, allow_shared_fallback)
    VALUES (${sharedSenderId}, ${branchId}, true)`;
  assert.equal((await api('GET', `/api/messaging/connections/${sharedId}/inbound-review`, undefined, manager))
    .statusCode, 404);
  assert.equal((await api('GET', `/api/messaging/connections/${sharedId}/inbound-review`, undefined, admin))
    .statusCode, 200);
});
