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
  const app = await buildApp(db, { logger: false, messagingAdapter: adapter, globalRateLimitMax: 1000 });
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
  assert.equal((await send('POST', messagePath,
    { body: 'Hello', idempotencyKey: firstKey }, managerA)).json().id, queued.json().id);
  assert.equal((await db`SELECT count(*)::integer AS n FROM outbound_delivery_job j
    JOIN conversation_message m ON m.id = j.message_id WHERE m.conversation_id = ${conversationId}`)[0]!.n, 2);
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'OUTBOUND_MESSAGE_QUEUED'
    AND target_id = ${queued.json().id}`).length);
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'CAMPAIGN_SENDER_OVERRIDE_SET'
    AND target_id = ${campaignId}`).length);
  const flood = await Promise.all(Array.from({ length: 12 }, () => send('POST',
    `/api/messaging/connections/${id}/test`, undefined, managerA)));
  assert.ok(flood.some((response) => response.statusCode === 429 && response.json().error === 'RATE_LIMITED'));
  assert.ok(flood.every((response) => response.statusCode !== 500));
});
