import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { cpus, platform, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { sealSecret } from '../../src/credentials.js';
import { sha256 } from '../../src/security.js';
import { processOneInboundEvent } from '../../src/messaging/inbound-events.js';
import { processOnePendingDeliveryEvent } from '../../src/messaging/delivery-events.js';
import { processOneMessagingJob } from '../../src/messaging/send-worker.js';
import { ProviderSendError, type MessagingSendAdapter } from '../../src/messaging/providers.js';

export type MessagingLoadOptions = { contactsPerSender: number; senders: number; workers: number;
  apiReplicas: number; httpConcurrency: number; duplicateCopies: number; providerDelayMs: number };
export function loadOptions(input: Partial<MessagingLoadOptions> = {}): MessagingLoadOptions {
  const options = { contactsPerSender: 50, senders: 4, workers: 4, apiReplicas: 2,
    httpConcurrency: 12, duplicateCopies: 3, providerDelayMs: 5, ...input };
  const ranges = { contactsPerSender: [2,250], senders: [2,8], workers: [1,8],
    apiReplicas: [1,4], httpConcurrency: [1,32], duplicateCopies: [2,5], providerDelayMs: [0,100] };
  for (const [name, [min, max]] of Object.entries(ranges)) {
    const value = options[name as keyof MessagingLoadOptions];
    if (!Number.isInteger(value) || value < min! || value > max!) throw new Error(`Invalid load option: ${name}`);
  }
  if (options.senders % 2) throw new Error('An even sender count is required for two isolated connections');
  return options;
}
export function isolatedLoadDatabase(url: string | undefined, resetTestDatabase: boolean): string {
  if (!resetTestDatabase || !url) throw new Error('Explicit reset of isolated TEST_DATABASE_URL required');
  const parsed = new URL(url);
  if (!['postgres:','postgresql:'].includes(parsed.protocol) || parsed.pathname !== '/lead_operations_test'
    || !['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))
    throw new Error('Messaging load may use only the local lead_operations_test database');
  return url;
}
async function concurrent<T>(items: readonly T[], count: number, action: (item: T, index: number) => Promise<void>) {
  let next = 0; let failure: unknown;
  const running = await Promise.allSettled(Array.from({ length: count }, async () => {
    while (failure === undefined) {
      const index = next++; if (index >= items.length) return;
      try { await action(items[index]!, index); } catch (error) { failure = error; throw error; }
    }
  }));
  const rejected = running.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
}
function timings(samples: number[]) {
  const ordered = [...samples].sort((a,b) => a - b);
  const at = (fraction: number) => Number((ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0).toFixed(2));
  return { samples: ordered.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}
type Sender = { id: string; external: string; connection: string; waba: string; impaired: boolean };
type Fixture = { conversation: string; participant: string; sender: Sender; inboundId: string; outboundId?: string };

// Destructive only to the named local test database; the CLI additionally requires an explicit acknowledgement flag.
export async function runMessagingLoad(url: string | undefined, resetTestDatabase: boolean,
  input: Partial<MessagingLoadOptions> = {}) {
  const checkedUrl = isolatedLoadDatabase(url, resetTestDatabase); const options = loadOptions(input);
  const previousOrigin = process.env.APP_ORIGIN; const previousKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  // Independent pools model replica/worker database connections, within a bounded connection budget.
  const connect = () => postgres(checkedUrl, { max: 3, connect_timeout: 10, idle_timeout: 20,
    connection: { statement_timeout: 15000 } });
  const db = connect(); const apiDbs = Array.from({ length: options.apiReplicas }, connect);
  const workerDbs = Array.from({ length: options.workers }, connect);
  const apps: FastifyInstance[] = []; const addresses: string[] = []; const apiErrors: string[] = [];
  try {
    assert.equal((await db`SELECT current_database() AS name`)[0]!.name, 'lead_operations_test');
    await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`;
      await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
    const fixtures: Fixture[] = []; const credentials = { accessToken: 'load-test-only-access-token',
      appSecret: 'load-test-only-app-secret', verifyToken: 'load-test-only-verify-token' };
    const org = (await db`INSERT INTO organization (name) VALUES ('Isolated messaging load') RETURNING id`)[0]!.id;
    const branch = (await db`INSERT INTO branch (organization_id, name) VALUES (${org}, 'Load') RETURNING id`)[0]!.id;
    const agent = (await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash)
      VALUES (${org}, ${branch}, 'AGENT', 'Test Agent', 'agent@load.test', 'fixture-not-a-login-hash') RETURNING id`)[0]!.id;
    const token = randomBytes(32).toString('hex');
    await db`INSERT INTO user_session (user_id, token_hash, expires_at)
      VALUES (${agent}, ${sha256(token)}, now() + interval '1 hour')`;
    const connections: string[] = []; const senders: Sender[] = [];
    for (let i = 0; i < 2; i++) {
      const waba = String(900000000 + i);
      const id = (await db`INSERT INTO integration_connection (organization_id, branch_id, kind, provider, name, status, config)
        VALUES (${org}, ${branch}, 'MESSAGING', 'META_WHATSAPP_CLOUD', ${'Load ' + i}, 'CONNECTED',
          ${db.json({ graphVersion: 'v25.0', wabaId: waba })}) RETURNING id`)[0]!.id as string;
      connections.push(id); const secret = sealSecret(id, JSON.stringify(credentials));
      await db`INSERT INTO connection_secret (connection_id, ciphertext, nonce, auth_tag)
        VALUES (${id}, ${secret.ciphertext}, ${secret.nonce}, ${secret.authTag})`;
      for (let j = 0; j < options.senders / 2; j++) {
        const external = String(15550000000 + i * 100 + j);
        const senderId = (await db`INSERT INTO messaging_sender
          (organization_id, connection_id, external_sender_id, display_name, health, operator_enabled, capabilities)
          VALUES (${org}, ${id}, ${external}, ${'Load ' + external}, 'HEALTHY', true,
            '{"text":true,"requiresTemplate":false}'::jsonb) RETURNING id`)[0]!.id as string;
        senders.push({ id: senderId, external, connection: id, waba, impaired: i === 0 });
      }
    }
    await db.begin(async (tx) => {
      for (const [index, sender] of senders.entries()) {
        const campaign = (await tx`INSERT INTO campaign
          (organization_id, branch_id, name, status, sender_override_id, messaging_config)
          VALUES (${org}, ${branch}, ${'Load campaign ' + index}, 'ACTIVE', ${sender.id}, '{"enabled":true}'::jsonb)
          RETURNING id`)[0]!.id;
        for (let n = 0; n < options.contactsPerSender; n++) {
          const participant = String(15551000000 + index * 1000 + n);
          const contact = (await tx`INSERT INTO contact (organization_id, name, phone, phone_normalized)
            VALUES (${org}, ${'Load customer ' + index + ':' + n}, ${'+' + participant}, ${'+' + participant}) RETURNING id`)[0]!.id;
          const lead = (await tx`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind, assigned_agent_id)
            VALUES (${org}, ${branch}, ${campaign}, ${contact}, 'MANUAL', ${agent}) RETURNING id`)[0]!.id;
          const conversation = (await tx`INSERT INTO conversation (lead_id, connection_id, sender_id, channel, participant_ref,
              controller_type, controller_user_id, state)
            VALUES (${lead}, ${sender.connection}, ${sender.id}, 'WHATSAPP', ${'+' + participant},
              'HUMAN', ${agent}, 'HUMAN_ACTIVE') RETURNING id`)[0]!.id as string;
          await tx`INSERT INTO messaging_consent (contact_id, channel, status, source)
            VALUES (${contact}, 'WHATSAPP', 'GRANTED', 'LOAD_TEST')`;
          fixtures.push({ conversation, participant, sender, inboundId: `wamid.load.in.${index}.${n}` });
        }
      }
    });
    for (const apiDb of apiDbs) {
      const app = await buildApp(apiDb, { logger: false, globalRateLimitMax: 100000 });
      app.addHook('onError', async (_request, _reply, error) => {
        apiErrors.push(String(error.code));
      });
      apps.push(app); addresses.push(await app.listen({ port: 0, host: '127.0.0.1' }));
    }
    const http = async (path: string, payload: string, ordinal: number, signed = false) => {
      const response = await fetch(addresses[ordinal % addresses.length]! + path, { method: 'POST', body: payload,
        headers: { 'content-type': 'application/json', ...(signed ? { 'x-hub-signature-256':
          `sha256=${createHmac('sha256', credentials.appSecret).update(payload).digest('hex')}` }
          : { cookie: `lop_session=${token}`, origin: process.env.APP_ORIGIN! }) }, signal: AbortSignal.timeout(15000) });
      const result = await response.json() as { created?: number; id?: string; error?: string };
      assert.ok([200,202].includes(response.status), `HTTP ${response.status}: ${result.error}; server codes: ${apiErrors.join(',')}`); return result;
    };
    const envelope = (sender: Sender, content: object) => JSON.stringify({ object: 'whatsapp_business_account',
      entry: [{ id: sender.waba, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
        metadata: { phone_number_id: sender.external }, ...content } }] }] });
    const epoch = Math.floor(Date.now() / 1000);
    const inboundRequests: { sender: Sender; payload: string }[] = [];
    for (const sender of senders) {
      const group = fixtures.filter((f) => f.sender.id === sender.id);
      for (let offset = 0; offset < group.length; offset += 50) {
        const payload = envelope(sender, { messages: group.slice(offset, offset + 50).map((f) => ({
          id: f.inboundId, from: f.participant, timestamp: String(epoch), type: 'text', text: { body: 'Load test inbound' },
        })) });
        for (let copy = 0; copy < options.duplicateCopies; copy++) inboundRequests.push({ sender, payload });
      }
    }
    let createdInbound = 0; const webhookMs: number[] = []; const inboundStart = performance.now();
    await concurrent(inboundRequests, options.httpConcurrency, async ({ sender, payload }, ordinal) => {
      const started = performance.now(); const result = await http(`/api/webhooks/messaging/meta/${sender.connection}`, payload, ordinal, true);
      webhookMs.push(performance.now() - started); createdInbound += result.created!;
    });
    const webhookDurationMs = performance.now() - inboundStart; assert.equal(createdInbound, fixtures.length);
    const resolutionStart = performance.now();
    await concurrent(workerDbs, workerDbs.length, async (workerDb) => {
      while (await processOneInboundEvent(workerDb)) { /* durable row claim */ }
    });
    const resolutionDurationMs = performance.now() - resolutionStart;
    assert.equal((await db`SELECT count(*)::integer AS n FROM integration_event WHERE event_kind = 'INBOUND_MESSAGE' AND state = 'PROCESSED'`)[0]!.n, fixtures.length);
    assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message WHERE direction = 'INBOUND'`)[0]!.n, fixtures.length);
    // API replicas must converge on the same durable send intent under concurrent replay.
    const enqueueMs: number[] = []; const outboundStart = performance.now();
    const intents = fixtures.flatMap((f) => Array.from({ length: options.duplicateCopies }, () => f));
    await concurrent(intents, options.httpConcurrency, async (f, ordinal) => {
      const started = performance.now();
      const result = await http(`/api/conversations/${f.conversation}/messages`,
        JSON.stringify({ body: 'load:' + f.conversation, idempotencyKey: 'load:' + f.conversation }), ordinal);
      enqueueMs.push(performance.now() - started);
      if (f.outboundId) assert.equal(result.id, f.outboundId); else f.outboundId = result.id;
    });
    const enqueueDurationMs = performance.now() - outboundStart;
    assert.equal((await db`SELECT count(*)::integer AS n FROM outbound_delivery_job`)[0]!.n, fixtures.length);
    const active = new Map<string, number>(); const successfulCalls = new Set<string>();
    const earlySenders = new Set<string>(); let earlyCallbackCreated = 0; let earlyOrdinal = 0;
    let maxPerSender = 0; let parallel = 0; let maxParallel = 0; let rateLimited = false; let totalCalls = 0;
    const adapter: MessagingSendAdapter = { async sendText(message) {
      assert.equal(message.credentials.accessToken, credentials.accessToken);
      const nowActive = (active.get(message.externalSenderId) ?? 0) + 1;
      active.set(message.externalSenderId, nowActive); maxPerSender = Math.max(maxPerSender, nowActive);
      maxParallel = Math.max(maxParallel, ++parallel); totalCalls++;
      try {
        const impaired = message.config.wabaId === senders[0]!.waba;
        const reject = impaired && !rateLimited; if (reject) rateLimited = true;
        await delay(options.providerDelayMs);
        if (reject) throw new ProviderSendError('RETRYABLE', 'PROVIDER_RATE_LIMITED', 60);
        const key = `${message.externalSenderId}:${message.recipient}:${message.body}`;
        assert.equal(successfulCalls.has(key), false, 'Duplicate customer dispatch'); successfulCalls.add(key);
        const providerMessageId = `wamid.load.out.${successfulCalls.size}`;
        // A signed callback can race the provider acknowledgement and other worker completions.
        if (!earlySenders.has(message.externalSenderId)) {
          earlySenders.add(message.externalSenderId);
          const sender = senders.find((s) => s.external === message.externalSenderId)!;
          const callback = envelope(sender, { statuses: [{ id: providerMessageId,
            recipient_id: message.recipient.slice(1), status: 'sent', timestamp: String(epoch) }] });
          const response = await http(`/api/webhooks/messaging/meta/${sender.connection}`, callback, earlyOrdinal++, true);
          earlyCallbackCreated += response.created!;
        }
        return { providerMessageId };
      } finally { parallel--; active.set(message.externalSenderId, nowActive - 1); }
    } };
    const drain = async () => {
      let failure: unknown; const deadline = performance.now() + 90000;
      const results = await Promise.allSettled(workerDbs.map(async (workerDb) => {
        try {
          while (failure === undefined) {
            assert.ok(performance.now() < deadline, 'Messaging queue did not drain within the technical test timeout');
            if (await processOneMessagingJob(workerDb, adapter)) { await processOnePendingDeliveryEvent(workerDb); continue; }
            if (await processOnePendingDeliveryEvent(workerDb)) continue;
            const waiting = (await db`SELECT count(*)::integer AS n FROM background_job j
              JOIN outbound_delivery_job link ON link.job_id = j.id
              JOIN conversation_message m ON m.id = link.message_id
              JOIN messaging_sender s ON s.id = m.sender_id JOIN integration_connection c ON c.id = m.connection_id
              WHERE j.status = 'RUNNING' OR (j.status = 'QUEUED' AND j.run_after <= now()
                AND c.status = 'CONNECTED' AND s.active AND s.operator_enabled AND s.health IN ('HEALTHY','DEGRADED')
                AND (c.cooldown_until IS NULL OR c.cooldown_until <= now())
                AND (s.cooldown_until IS NULL OR s.cooldown_until <= now()))`)[0]!.n;
            if (!waiting) return; await delay(5);
          }
        } catch (error) { failure = error; throw error; }
      }));
      const rejected = results.find((r) => r.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    };
    const dispatchStart = performance.now(); await drain();
    const healthySent = (await db`SELECT count(*)::integer AS n FROM conversation_message
      WHERE connection_id = ${connections[1]!} AND direction = 'OUTBOUND' AND delivery_state = 'SENT'`)[0]!.n;
    assert.equal(healthySent, fixtures.length / 2, 'Unrelated connection must continue during provider cooldown');
    const parked = (await db`SELECT count(*)::integer AS n FROM conversation_message
      WHERE connection_id = ${connections[0]!} AND direction = 'OUTBOUND' AND delivery_state = 'QUEUED'`)[0]!.n;
    assert.ok(parked > 0); assert.equal(rateLimited, true);
    assert.equal((await db`SELECT count(*)::integer AS n FROM background_job WHERE status = 'RUNNING'`)[0]!.n, 0);
    const callsBeforeRecovery = totalCalls; await drain(); assert.equal(totalCalls, callsBeforeRecovery);
    // Advance only test clocks to model the provider cooldown expiring without a minute-long test wait.
    await db`UPDATE integration_connection SET cooldown_until = now() - interval '1 second' WHERE id = ${connections[0]!}`;
    await db`UPDATE messaging_sender SET cooldown_until = now() - interval '1 second' WHERE connection_id = ${connections[0]!}`;
    await db`UPDATE background_job SET run_after = now() - interval '1 second' WHERE status = 'QUEUED'`;
    await drain(); const dispatchDurationMs = performance.now() - dispatchStart;
    assert.equal(maxPerSender, 1); assert.equal(successfulCalls.size, fixtures.length);
    assert.equal(earlyCallbackCreated, options.senders);
    if (options.workers > 1) assert.ok(maxParallel > 1, 'Different senders should dispatch concurrently');
    assert.equal(totalCalls, fixtures.length + 1); assert.equal(parallel, 0);
    assert.equal((await db`SELECT count(*)::integer AS n FROM background_job WHERE status <> 'SUCCEEDED'`)[0]!.n, 0);
    assert.equal((await db`SELECT count(*)::integer AS n FROM sender_outbound_lease`)[0]!.n, 0);
    assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message WHERE direction = 'OUTBOUND' AND delivery_state = 'SENT'`)[0]!.n, fixtures.length);
    const callbacks: { sender: Sender; payload: string }[] = [];
    for (const sender of senders) {
      const sent = await db`SELECT m.provider_message_id, cv.participant_ref FROM conversation_message m
        JOIN conversation cv ON cv.id = m.conversation_id WHERE m.sender_id = ${sender.id} AND m.direction = 'OUTBOUND'
        ORDER BY m.id`;
      // READ may arrive before DELIVERED or SENT; repeats must preserve each event once and never regress.
      for (const [status, seconds] of [['read',2],['delivered',1],['sent',0]] as const) {
        for (let offset = 0; offset < sent.length; offset += 50) {
          const payload = envelope(sender, { statuses: sent.slice(offset, offset + 50).map((m) => ({
            id: m.provider_message_id, recipient_id: m.participant_ref.slice(1), status, timestamp: String(epoch + seconds),
          })) });
          for (let copy = 0; copy < options.duplicateCopies; copy++) callbacks.push({ sender, payload });
        }
      }
    }
    const callbackMs: number[] = []; const callbackStart = performance.now(); let createdCallbacks = 0;
    await concurrent(callbacks, options.httpConcurrency, async ({ sender, payload }, ordinal) => {
      const started = performance.now(); const result = await http(`/api/webhooks/messaging/meta/${sender.connection}`, payload, ordinal, true);
      callbackMs.push(performance.now() - started); createdCallbacks += result.created!;
    });
    const callbackDurationMs = performance.now() - callbackStart;
    assert.equal(createdCallbacks + earlyCallbackCreated, fixtures.length * 3);
    assert.equal((await db`SELECT count(*)::integer AS n FROM message_delivery_event`)[0]!.n, fixtures.length * 3);
    assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message WHERE direction = 'OUTBOUND' AND delivery_state = 'READ'`)[0]!.n, fixtures.length);
    assert.equal((await db`SELECT count(*)::integer AS n FROM integration_event WHERE state <> 'PROCESSED'`)[0]!.n, 0);
    return { recordedAt: new Date().toISOString(), environment: { node: process.version, platform: platform(),
        logicalCpus: cpus().length, hostMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
        database: 'Docker PostgreSQL', provider: 'in-process fake', transport: 'loopback HTTP',
        databasePoolPerReplica: 3, sharedNodeProcess: true }, options,
      counts: { contacts: fixtures.length, inbound: createdInbound, outbound: successfulCalls.size,
        deliveryEvents: createdCallbacks + earlyCallbackCreated, callbacksBeforeAcknowledgement: earlyCallbackCreated,
        duplicateCopies: options.duplicateCopies, totalProviderCalls: totalCalls,
        healthySentDuringCooldown: healthySent, queuedDuringCooldown: parked, maxPerSender, maxParallel },
      phases: { inboundWebhook: { ...timings(webhookMs), durationMs: Number(webhookDurationMs.toFixed(2)) },
        inboundResolution: { durationMs: Number(resolutionDurationMs.toFixed(2)),
          messagesPerSecond: Number((fixtures.length * 1000 / resolutionDurationMs).toFixed(2)) },
        outboundEnqueue: { ...timings(enqueueMs), durationMs: Number(enqueueDurationMs.toFixed(2)) },
        dispatchAndRecovery: { durationMs: Number(dispatchDurationMs.toFixed(2)),
          messagesPerSecond: Number((fixtures.length * 1000 / dispatchDurationMs).toFixed(2)) },
        deliveryWebhook: { ...timings(callbackMs), durationMs: Number(callbackDurationMs.toFixed(2)) },
        enqueueThroughDispatchMs: Number((performance.now() - outboundStart - callbackDurationMs).toFixed(2)) } };
  } finally {
    await Promise.allSettled(apps.map((app) => app.close()));
    await Promise.allSettled([db, ...apiDbs, ...workerDbs].map((sql) => sql.end({ timeout: 5 })));
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;
    if (previousKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY; else process.env.CREDENTIAL_ENCRYPTION_KEY = previousKey;
  }
}
