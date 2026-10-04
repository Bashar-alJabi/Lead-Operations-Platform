import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealSecret } from '../src/credentials.js';
import { sha256 } from '../src/security.js';
import { processOneInboundEvent } from '../src/messaging/inbound-events.js';
import { processOneInboundAttachment } from '../src/media/inbound-worker.js';
import { localMediaStorage } from '../src/media/storage.js';
import { MediaError } from '../src/media/validation.js';
import type { MessagingMediaAdapter } from '../src/media/meta-provider.js';
import type { MediaScanner } from '../src/media/scanner.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('signed inbound attachments preserve history, gate downloads on scanning, isolate access and recover safely', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const db = createDatabase(url);
  const root = await mkdtemp(resolve('.local/media-test-')); const storage = localMediaStorage(root);
  const app = await buildApp(db, { logger: false, mediaStorage: storage, globalRateLimitMax: 10000 });
  t.after(async () => { await app.close(); await db.end(); await rm(root, { recursive: true, force: true }); });
  await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
  const org = (await db`INSERT INTO organization (name) VALUES ('Media test') RETURNING id`)[0]!.id;
  const branch = (await db`INSERT INTO branch (organization_id, name) VALUES (${org}, 'A') RETURNING id`)[0]!.id;
  const otherBranch = (await db`INSERT INTO branch (organization_id, name) VALUES (${org}, 'B') RETURNING id`)[0]!.id;
  const identities: Record<string, { id: string; cookie: string }> = {};
  for (const [name, role, branchId] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],
    ['other','MANAGER',otherBranch],['agent','AGENT',branch],['second','AGENT',branch]] as const) {
    const id = (await db`INSERT INTO user_account (organization_id, branch_id, name, role, email, password_hash)
      VALUES (${org}, ${branchId}, ${name}, ${role}, ${name + '@media.test'}, 'fixture-not-a-login-hash') RETURNING id`)[0]!.id;
    const token = randomBytes(32).toString('hex');
    await db`INSERT INTO user_session (user_id, token_hash, expires_at) VALUES (${id}, ${sha256(token)}, now() + interval '1 hour')`;
    identities[name] = { id, cookie: `lop_session=${token}` };
  }
  const campaign = (await db`INSERT INTO campaign (organization_id, branch_id, name, status)
    VALUES (${org}, ${branch}, 'Media campaign', 'ACTIVE') RETURNING id`)[0]!.id;
  const connection = (await db`INSERT INTO integration_connection (organization_id, branch_id, kind, provider, name, status, config)
    VALUES (${org}, ${branch}, 'MESSAGING', 'META_WHATSAPP_CLOUD', 'Media', 'CONNECTED',
      ${db.json({ graphVersion: 'v25.0', wabaId: '123456789' })}) RETURNING id`)[0]!.id;
  const credentials = { accessToken: 'test-access-token', appSecret: 'test-app-secret', verifyToken: 'test-verify-token' };
  const secret = sealSecret(connection, JSON.stringify(credentials));
  await db`INSERT INTO connection_secret (connection_id, ciphertext, nonce, auth_tag)
    VALUES (${connection}, ${secret.ciphertext}, ${secret.nonce}, ${secret.authTag})`;
  const sender = (await db`INSERT INTO messaging_sender (organization_id, connection_id, external_sender_id, display_name)
    VALUES (${org}, ${connection}, '15550001111', 'Media sender') RETURNING id`)[0]!.id;
  await db`UPDATE branch SET default_sender_id = ${sender} WHERE id = ${branch}`;
  const contact = (await db`INSERT INTO contact (organization_id, name, phone, phone_normalized)
    VALUES (${org}, 'Customer', '+15550002222', '+15550002222') RETURNING id`)[0]!.id;
  const lead = (await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind, assigned_agent_id)
    VALUES (${org}, ${branch}, ${campaign}, ${contact}, 'MANUAL', ${identities.agent!.id}) RETURNING id`)[0]!.id;
  const conversation = (await db`INSERT INTO conversation (lead_id, connection_id, sender_id, channel, participant_ref,
    controller_type, controller_user_id, state) VALUES (${lead}, ${connection}, ${sender}, 'WHATSAPP', '+15550002222',
      'HUMAN', ${identities.agent!.id}, 'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
  const api = (method: 'GET'|'POST', path: string, name?: string, body?: object) => app.inject({ method,
    url: path, payload: body, headers: { origin: process.env.APP_ORIGIN!, ...(name ? { cookie: identities[name]!.cookie } : {}) } });
  const bytes = Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
  const hash = createHash('sha256').update(bytes).digest('hex');
  let nextId = 100; let calls = 0; let scanMode: 'clean'|'reject'|'unavailable' = 'clean';
  let downloadMode: 'valid'|'mismatch'|'badType'|'timeout' = 'valid';
  let block: Promise<void> | undefined; let started: (() => void) | undefined;
  const adapter: MessagingMediaAdapter = { async download(input) {
    calls++; assert.equal(input.credentials.accessToken, credentials.accessToken);
    assert.equal(input.externalSenderId, '15550001111');
    started?.(); if (block) await block;
    if (downloadMode === 'timeout') throw new MediaError('MEDIA_PROVIDER_UNAVAILABLE', true);
    return downloadMode === 'mismatch' ? Buffer.concat([bytes, Buffer.from('different')])
      : downloadMode === 'badType' ? Buffer.from('<html>unsafe</html>') : bytes;
  } };
  const scanner: MediaScanner = { async scan(file) {
    assert.deepEqual(file, bytes);
    if (scanMode === 'unavailable') throw new MediaError('MEDIA_SCANNER_UNAVAILABLE', true);
    return { clean: scanMode === 'clean', version: 'FakeScanner/test-only' };
  } };
  const worker = () => processOneInboundAttachment(db, { adapter, scanner, storage });
  async function webhook(id: string, media: object) {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '123456789', changes: [{
      field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '15550001111' },
        messages: [{ id, from: '15550002222', timestamp: String(Math.floor(Date.now() / 1000)), type: 'document', document: media }] },
    }] }] });
    return app.inject({ method: 'POST', url: `/api/webhooks/messaging/meta/${connection}`, payload,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256':
        `sha256=${createHmac('sha256', credentials.appSecret).update(payload).digest('hex')}` } });
  }
  async function incoming(extra: object = {}) {
    const id = `wamid.media-${nextId++}`;
    const response = await webhook(id, { id: String(nextId), mime_type: 'application/pdf', sha256: hash,
      filename: '../../evil.html', caption: '<script>alert(1)</script>', ...extra });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await processOneInboundEvent(db), true);
    const attachment = (await db`SELECT a.* FROM message_attachment a JOIN integration_event e ON e.id = a.integration_event_id
      WHERE e.payload->'message'->>'id' = ${id}`)[0]!;
    return attachment;
  }
  const first = await incoming();
  const path = `/api/messaging/attachments/${first.id}`;
  assert.equal((await api('GET', path + '/download')).statusCode, 401);
  assert.equal((await api('GET', path, 'other')).statusCode, 404);
  assert.equal((await api('GET', path, 'second')).statusCode, 404);
  assert.equal((await api('GET', path + '/download', 'agent')).json().error, 'ATTACHMENT_NOT_READY');
  const listed = (await api('GET', `/api/conversations/${conversation}/messages`, 'agent')).json().items[0];
  assert.equal(listed.message_kind, 'ATTACHMENT'); assert.equal(listed.body, '<script>alert(1)</script>');
  assert.equal(JSON.stringify(listed).includes('evil.html'), false);
  await assert.rejects(db`UPDATE message_attachment SET state = 'READY', mime_type = 'application/pdf',
    size_bytes = ${bytes.length}, content_sha256 = NULL, storage_key = ${first.id + '-' + hash}, storage_backend = 'LOCAL',
    scanner_version = 'fake', scanned_at = now() WHERE id = ${first.id}`, /attachment_content_integrity/);
  const startedSignal = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void; block = new Promise<void>((resolve) => { release = resolve; });
  const pending = worker(); await startedSignal;
  assert.equal(await worker(), false); release(); await pending; block = undefined; started = undefined;
  assert.equal(calls, 1); assert.equal(await worker(), false);
  const ready = (await api('GET', path, 'agent')).json(); assert.equal(ready.state, 'READY');
  assert.equal(JSON.stringify(ready).includes('storage_key'), false);
  const download = await api('GET', path + '/download', 'agent');
  assert.equal(download.statusCode, 200); assert.deepEqual(download.rawPayload, bytes);
  assert.equal(download.headers['cache-control'], 'private, no-store');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.ok(String(download.headers['content-disposition']).endsWith('.pdf"'));
  assert.equal(download.body.includes('../../evil'), false);
  await assert.rejects(db`UPDATE conversation_message SET body = 'changed' WHERE attachment_id = ${first.id}`,
    /CUSTOMER_MESSAGE_IMMUTABLE/);
  await assert.rejects(db`UPDATE message_attachment SET storage_key = 'changed' WHERE id = ${first.id}`,
    /ATTACHMENT_IMMUTABLE/);
  // Replaying the signed provider identity creates neither another attachment nor another message.
  assert.equal((await webhook('wamid.media-100', { id: '101', mime_type: 'application/pdf', sha256: hash })).statusCode, 200);
  assert.equal(await processOneInboundEvent(db), false);
  assert.equal((await db`SELECT count(*)::integer AS n FROM message_attachment`)[0]!.n, 1);
  // Current assignment is checked at every download, even for historical media.
  await db`UPDATE lead SET assigned_agent_id = ${identities.second!.id} WHERE id = ${lead}`;
  assert.equal((await api('GET', path + '/download', 'agent')).statusCode, 404);
  assert.equal((await api('GET', path + '/download', 'second')).statusCode, 200);
  await db`UPDATE lead SET assigned_agent_id = ${identities.agent!.id} WHERE id = ${lead}`;
  scanMode = 'reject'; const rejected = await incoming(); await worker();
  assert.equal((await api('GET', `/api/messaging/attachments/${rejected.id}`, 'agent')).json().state, 'REJECTED');
  assert.equal((await api('GET', `/api/messaging/attachments/${rejected.id}/download`, 'admin')).statusCode, 409);
  assert.equal((await api('POST', `/api/messaging/attachments/${rejected.id}/retry`, 'manager',
    { version: 3, reason: 'Reviewed invalid attachment' })).statusCode, 409);
  scanMode = 'clean'; downloadMode = 'mismatch'; const mismatch = await incoming(); await worker();
  assert.equal((await api('GET', `/api/messaging/attachments/${mismatch.id}`, 'manager')).json().errorCode, 'MEDIA_HASH_MISMATCH');
  downloadMode = 'badType'; const badType = await incoming(); await worker();
  assert.equal((await api('GET', `/api/messaging/attachments/${badType.id}`, 'manager')).json().errorCode, 'MEDIA_TYPE_MISMATCH');
  downloadMode = 'valid'; scanMode = 'unavailable'; const failing = await incoming();
  for (let attempt = 0; attempt < 5; attempt++) {
    await db`UPDATE message_attachment SET available_at = now() WHERE id = ${failing.id}`;
    assert.equal(await worker(), true);
  }
  let failed = (await api('GET', `/api/messaging/attachments/${failing.id}`, 'manager')).json();
  assert.equal(failed.state, 'FAILED'); assert.equal(failed.errorCode, 'MEDIA_SCANNER_UNAVAILABLE');
  assert.equal((await api('GET', `/api/messaging/attachments/${failing.id}/download`, 'agent')).statusCode, 409);
  const retryPath = `/api/messaging/attachments/${failing.id}/retry`;
  const retry = { version: failed.version, reason: 'Scanner restored and verified' };
  assert.equal((await api('POST', retryPath, 'agent', retry)).statusCode, 403);
  assert.equal((await api('POST', retryPath, 'other', retry)).statusCode, 404);
  assert.equal((await api('POST', retryPath, 'manager', { ...retry, reason: 'short' })).statusCode, 400);
  const retries = await Promise.all([api('POST', retryPath, 'manager', retry), api('POST', retryPath, 'manager', retry)]);
  assert.deepEqual(retries.map((r) => r.statusCode).sort(), [200,409]);
  scanMode = 'clean'; await worker();
  failed = (await api('GET', `/api/messaging/attachments/${failing.id}`, 'agent')).json();
  assert.equal(failed.state, 'READY');
  assert.equal((await db`SELECT count(*)::integer AS n FROM attachment_processing_attempt WHERE attachment_id = ${failing.id}`)[0]!.n, 6);
  // Interrupted retrieval may be repeated: it has no customer-facing send side effect.
  const expired = await incoming(); const oldLease = randomUUID();
  await db`UPDATE message_attachment SET state = 'RUNNING', lease_token = ${oldLease},
    lease_until = now() - interval '1 minute', attempt_count = 1, retry_count = 1 WHERE id = ${expired.id}`;
  await db`INSERT INTO attachment_processing_attempt (attachment_id, lease_token, attempt_number, outcome)
    VALUES (${expired.id}, ${oldLease}, 1, 'STARTED')`;
  await worker();
  assert.equal((await db`SELECT outcome FROM attachment_processing_attempt WHERE lease_token = ${oldLease}`)[0]!.outcome, 'LEASE_EXPIRED');
  assert.equal((await api('GET', `/api/messaging/attachments/${expired.id}`, 'agent')).json().state, 'READY');
  // Late completion from the old lease is fenced out after recovery succeeds.
  const late = await incoming();
  const lateStarted = new Promise<void>((resolve) => { started = resolve; });
  let releaseLate!: () => void; block = new Promise<void>((resolve) => { releaseLate = resolve; });
  const latePending = worker(); await lateStarted;
  const staleToken = (await db`SELECT lease_token FROM message_attachment WHERE id = ${late.id}`)[0]!.lease_token;
  block = undefined; started = undefined;
  await db`UPDATE message_attachment SET lease_until = now() - interval '1 minute' WHERE id = ${late.id}`;
  await worker(); const newer = (await api('GET', `/api/messaging/attachments/${late.id}`, 'agent')).json();
  releaseLate(); await latePending;
  assert.deepEqual((await api('GET', `/api/messaging/attachments/${late.id}`, 'agent')).json(), newer);
  assert.equal(newer.state, 'READY');
  assert.equal((await db`SELECT outcome FROM attachment_processing_attempt WHERE lease_token = ${staleToken}`)[0]!.outcome, 'LEASE_EXPIRED');
  const paused = await incoming();
  await db`UPDATE messaging_sender SET operator_enabled = false WHERE id = ${sender}`;
  assert.equal(await worker(), false);
  assert.equal((await db`SELECT attempt_count FROM message_attachment WHERE id = ${paused.id}`)[0]!.attempt_count, 0);
  await db`UPDATE messaging_sender SET operator_enabled = true WHERE id = ${sender}`;
  await worker();
  downloadMode = 'timeout'; const providerFail = await incoming(); await worker();
  assert.equal((await api('GET', `/api/messaging/attachments/${providerFail.id}`, 'manager')).json().state, 'QUEUED');
  assert.equal((await api('GET', `/api/messaging/attachments/${providerFail.id}/download`, 'admin')).statusCode, 409);
  downloadMode = 'valid';
  await db`UPDATE message_attachment SET available_at = now() WHERE id = ${providerFail.id}`;
  await worker();
  assert.equal((await api('GET', `/api/messaging/attachments/${providerFail.id}`, 'manager')).json().state, 'READY');
  // Ambiguous media is scanned but remains restricted to connection reviewers until an explicit target is chosen.
  await db`UPDATE conversation SET state = 'CLOSED' WHERE id = ${conversation}`;
  await db`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
    VALUES (${org}, ${branch}, ${campaign}, ${contact}, 'MANUAL')`;
  const ambiguous = await incoming(); await worker();
  const reviewPath = `/api/messaging/connections/${connection}/inbound-review/${ambiguous.integration_event_id}`;
  const detail = await api('GET', reviewPath, 'manager'); assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().event.failureCode, 'MULTIPLE_ACTIVE_LEADS');
  assert.equal(detail.json().event.attachment.state, 'READY');
  assert.equal((await api('GET', `/api/messaging/attachments/${ambiguous.id}/download`, 'agent')).statusCode, 404);
  assert.equal((await api('GET', `/api/messaging/attachments/${ambiguous.id}/download`, 'manager')).statusCode, 200);
  const resolution = await api('POST', reviewPath + '/resolve', 'manager', { leadId: lead });
  assert.equal(resolution.statusCode, 200, resolution.body);
  assert.equal((await api('GET', `/api/messaging/attachments/${ambiguous.id}/download`, 'agent')).statusCode, 200);
  const invalid = await webhook('wamid.invalid-media', { id: '../../invalid', mime_type: 'text/html', sha256: hash });
  assert.equal(invalid.statusCode, 200); await processOneInboundEvent(db);
  assert.equal((await db`SELECT failure_code FROM integration_event WHERE payload->'message'->>'id' = 'wamid.invalid-media'`)[0]!.failure_code,
    'MEDIA_PAYLOAD_INVALID');
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'ATTACHMENT_RETRY_REQUESTED' AND target_id = ${failing.id}`).length);
  assert.ok((await db`SELECT 1 FROM audit_log WHERE action = 'ATTACHMENT_DOWNLOADED' AND target_id = ${first.id}`).length);
});
