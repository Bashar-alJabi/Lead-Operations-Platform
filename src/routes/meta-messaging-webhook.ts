import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { openSecret } from '../credentials.js';
import { HttpError, principalFromRequest, requireRole, type Principal } from '../security.js';
import type { MessagingConnectionConfig, MessagingCredentials } from '../messaging/providers.js';
import { providerEventId, type DeliveryStatus } from '../messaging/delivery-events.js';

const idParam = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;

async function connectionFor(db: Database, id: string) {
  const connection = (await db`SELECT id, organization_id, branch_id, status, version, config, capabilities
    FROM integration_connection WHERE id = ${id} AND kind = 'MESSAGING'
      AND provider = 'META_WHATSAPP_CLOUD'`)[0];
  if (!connection) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND');
  return connection;
}
async function managedConnection(db: Database, actor: Principal, id: string) {
  requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  const connection = await connectionFor(db, id);
  if (connection.organization_id !== actor.organizationId ||
    (actor.role === 'MANAGER' && connection.branch_id !== actor.branchId))
    throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND');
  return connection;
}
async function credentialsFor(db: Database, id: string): Promise<MessagingCredentials> {
  const secret = (await db`SELECT ciphertext, nonce, auth_tag, key_version FROM connection_secret
    WHERE connection_id = ${id}`)[0];
  if (!secret) throw new HttpError(409, 'CONNECTION_CREDENTIAL_MISSING');
  try {
    const credentials = JSON.parse(openSecret(id, { ciphertext: secret.ciphertext,
      nonce: secret.nonce, authTag: secret.auth_tag, keyVersion: secret.key_version })) as MessagingCredentials;
    if (!credentials.appSecret || !credentials.verifyToken) throw new Error('missing');
    return credentials;
  } catch { throw new HttpError(409, 'CONNECTION_CREDENTIAL_UNAVAILABLE'); }
}
function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
type WebhookEvent = { kind: 'DELIVERY_STATUS'; status: DeliveryStatus }
  | { kind: 'INBOUND_MESSAGE'; senderExternalId: string; messageId: string;
    participant: string; payload: Record<string, unknown> };

function parseWebhook(body: unknown, wabaId: string): WebhookEvent[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
  const root = body as Record<string, unknown>;
  if (root.object !== 'whatsapp_business_account' || !Array.isArray(root.entry)
    || root.entry.length < 1 || root.entry.length > 100) throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
  const events: WebhookEvent[] = [];
  for (const entry of root.entry) {
    if (!entry || typeof entry !== 'object' || entry.id !== wabaId || !Array.isArray(entry.changes)
      || entry.changes.length < 1 || entry.changes.length > 100) throw new HttpError(400, 'WEBHOOK_SCOPE_INVALID');
    for (const change of entry.changes) {
      const value = change?.value;
      const sender = value?.metadata?.phone_number_id;
      if (change?.field !== 'messages' || value?.messaging_product !== 'whatsapp'
        || typeof sender !== 'string' || !/^\d{1,30}$/.test(sender))
        throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
      if (value.statuses !== undefined && !Array.isArray(value.statuses)) throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
      if (value.messages !== undefined && !Array.isArray(value.messages)) throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
      if (!value.statuses && !value.messages) throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
      for (const item of value.statuses ?? []) {
        if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 255
          || !['sent','delivered','read','failed'].includes(item.status)
          || typeof item.timestamp !== 'string' || !/^\d{10,11}$/.test(item.timestamp)
          || typeof item.recipient_id !== 'string' || !/^\d{8,15}$/.test(item.recipient_id))
          throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
        const epoch = Number(item.timestamp);
        if (epoch < 946684800 || epoch > 4102444800) throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
        events.push({ kind: 'DELIVERY_STATUS', status: { senderExternalId: sender,
          providerMessageId: item.id, recipient: `+${item.recipient_id}`,
          status: item.status, providerTimestamp: new Date(epoch * 1000).toISOString() } });
      }
      for (const item of value.messages ?? []) {
        if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 255
          || typeof item.from !== 'string' || !/^\d{8,15}$/.test(item.from)
          || typeof item.timestamp !== 'string' || !/^\d{10,11}$/.test(item.timestamp))
          throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
        const epoch = Number(item.timestamp);
        if (epoch < 946684800 || epoch > 4102444800) throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
        if (JSON.stringify(item).length > 20000) throw new HttpError(400, 'WEBHOOK_PAYLOAD_TOO_LARGE');
        events.push({ kind: 'INBOUND_MESSAGE', senderExternalId: sender, messageId: item.id,
          participant: `+${item.from}`, payload: item });
      }
      if (events.length > 100) throw new HttpError(400, 'WEBHOOK_PAYLOAD_TOO_LARGE');
    }
  }
  if (!events.length) throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID');
  return events;
}

export function registerMetaMessagingWebhookRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>('/api/messaging/connections/:id/webhook', {
    schema: { params: idParam },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const connection = await managedConnection(db, actor, request.params.id);
    const health = (await db`SELECT
      count(*) FILTER (WHERE state = 'NEEDS_ATTENTION' AND failure_code IS DISTINCT FROM 'INBOUND_PROCESSING_NOT_READY')::integer AS attention,
      count(*) FILTER (WHERE state = 'RECEIVED' OR (state = 'NEEDS_ATTENTION'
        AND failure_code = 'INBOUND_PROCESSING_NOT_READY'))::integer AS pending,
      count(*) FILTER (WHERE state = 'FAILED')::integer AS failed,
      min(received_at) FILTER (WHERE state = 'RECEIVED' OR (state = 'NEEDS_ATTENTION'
        AND failure_code = 'INBOUND_PROCESSING_NOT_READY')) AS oldest_pending_at,
      max(last_processed_at) AS last_processed_at
      FROM integration_event WHERE connection_id = ${connection.id}
        AND event_kind IN ('DELIVERY_STATUS','INBOUND_MESSAGE')`)[0]!;
    return { callbackPath: `/api/webhooks/messaging/meta/${connection.id}`,
      handshakeVerified: connection.capabilities.webhookHandshakeVerified === true,
      signedCallbackVerified: connection.capabilities.webhookVerified === true,
      needsAttention: health.attention, pending: health.pending, failed: health.failed,
      oldestPendingAt: health.oldest_pending_at, lastProcessedAt: health.last_processed_at };
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: number; before?: string; state?: 'PENDING'|'FAILED'|'NEEDS_ATTENTION' } }>(
    '/api/messaging/connections/:id/events', { schema: { params: idParam, querystring: {
      type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        before: { type: 'string', format: 'uuid' },
        state: { type: 'string', enum: ['PENDING','FAILED','NEEDS_ATTENTION'] },
      },
    } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      const connection = await managedConnection(db, actor, request.params.id);
      const limit = request.query.limit ?? 30;
      const rows = await db`SELECT e.id, e.event_kind, e.state, e.failure_code, e.sender_id,
          e.processing_attempts, e.processing_failures, e.processing_version,
          e.processing_available_at, e.processing_last_error, e.last_processed_at,
          e.received_at, right(coalesce(e.participant_ref,''), 4) AS participant_last4
        FROM integration_event e WHERE e.connection_id = ${connection.id}
          AND e.event_kind IN ('DELIVERY_STATUS','INBOUND_MESSAGE')
          AND (${request.query.state ?? null}::text IS NULL OR
            (${request.query.state ?? null} = 'FAILED' AND e.state = 'FAILED') OR
            (${request.query.state ?? null} = 'PENDING' AND (e.state = 'RECEIVED' OR
              (e.state = 'NEEDS_ATTENTION' AND e.failure_code = 'INBOUND_PROCESSING_NOT_READY'))) OR
            (${request.query.state ?? null} = 'NEEDS_ATTENTION' AND e.state = 'NEEDS_ATTENTION'
              AND e.failure_code IS DISTINCT FROM 'INBOUND_PROCESSING_NOT_READY'))
          AND (${request.query.before ?? null}::uuid IS NULL OR (e.received_at, e.id) <
            (SELECT received_at, id FROM integration_event WHERE id = ${request.query.before ?? null}::uuid
              AND connection_id = ${connection.id}))
        ORDER BY e.received_at DESC, e.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      return { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null };
    });

  const eventParams = { ...idParam, required: ['id','eventId'], properties: {
    ...idParam.properties, eventId: { type: 'string', format: 'uuid' },
  } } as const;
  app.get<{ Params: { id: string; eventId: string }; Querystring: { limit?: number; before?: string } }>(
    '/api/messaging/connections/:id/events/:eventId/attempts', { schema: { params: eventParams,
      querystring: { type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string', format: 'uuid' },
      } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      const connection = await managedConnection(db, actor, request.params.id);
      const event = (await db`SELECT id FROM integration_event WHERE id = ${request.params.eventId}
        AND connection_id = ${connection.id} AND event_kind IN ('DELIVERY_STATUS','INBOUND_MESSAGE')`)[0];
      if (!event) throw new HttpError(404, 'MESSAGING_EVENT_NOT_FOUND');
      const limit = request.query.limit ?? 20;
      const rows = await db`SELECT id, attempt_number, outcome, error_code, finished_at
        FROM integration_event_processing_attempt WHERE event_id = ${event.id}
          AND (${request.query.before ?? null}::uuid IS NULL OR (finished_at,id) <
            (SELECT finished_at,id FROM integration_event_processing_attempt WHERE id = ${request.query.before ?? null}::uuid
              AND event_id = ${event.id})) ORDER BY finished_at DESC,id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0,limit);
      return { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null };
    });
  app.post<{ Params: { id: string; eventId: string }; Body: { version: number; reason: string } }>(
    '/api/messaging/connections/:id/events/:eventId/retry', { schema: { params: eventParams,
      body: { type: 'object', additionalProperties: false, required: ['version','reason'], properties: {
        version: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 10, maxLength: 500 },
      } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      const connection = await managedConnection(db, actor, request.params.id);
      if (request.body.reason.trim().length < 10) throw new HttpError(400, 'RETRY_REASON_REQUIRED');
      return db.begin(async (tx) => {
        const event = (await tx`SELECT id, event_kind, state, failure_code, processing_version
          FROM integration_event WHERE id = ${request.params.eventId} AND connection_id = ${connection.id}
            AND event_kind IN ('DELIVERY_STATUS','INBOUND_MESSAGE') FOR UPDATE`)[0];
        if (!event) throw new HttpError(404, 'MESSAGING_EVENT_NOT_FOUND');
        if (event.processing_version !== request.body.version) throw new HttpError(409, 'EVENT_VERSION_CONFLICT');
        if (event.state !== 'FAILED' || event.failure_code !== 'EVENT_PROCESSING_FAILED')
          throw new HttpError(409, 'EVENT_NOT_RETRYABLE');
        const updated = (await tx`UPDATE integration_event SET
          state = ${event.event_kind === 'DELIVERY_STATUS' ? 'RECEIVED' : 'NEEDS_ATTENTION'},
          failure_code = ${event.event_kind === 'DELIVERY_STATUS' ? null : 'INBOUND_PROCESSING_NOT_READY'},
          processing_failures = 0, processing_last_error = NULL, processing_available_at = now(),
          processing_version = processing_version + 1 WHERE id = ${event.id} RETURNING processing_version`)[0]!;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
          VALUES (${actor.organizationId}, ${connection.branch_id}, ${actor.id}, 'MESSAGING_EVENT_RETRY_REQUESTED',
            'INTEGRATION_EVENT', ${event.id}, ${tx.json({ reason: request.body.reason.trim() })})`;
        return { version: updated.processing_version };
      });
    });

  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, buffer, done) => {
      done(null, buffer);
    });
    scope.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
      '/api/webhooks/messaging/meta/:id', { schema: { params: idParam },
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
        const connection = await connectionFor(db, request.params.id);
        const credentials = await credentialsFor(db, connection.id);
        const query = request.query;
        const challenge = query['hub.challenge'];
        if (query['hub.mode'] !== 'subscribe' || !query['hub.verify_token']
          || typeof challenge !== 'string' || challenge.length < 1 || challenge.length > 256
          || !equalSecret(query['hub.verify_token'], credentials.verifyToken))
          throw new HttpError(403, 'WEBHOOK_VERIFICATION_DENIED');
        const changed = await db`UPDATE integration_connection SET
          capabilities = capabilities || ${db.json({ webhookHandshakeVerified: true })}::jsonb,
          updated_at = now() WHERE id = ${connection.id} AND version = ${connection.version} RETURNING id`;
        if (!changed.length) throw new HttpError(409, 'CONNECTION_VERSION_CONFLICT');
        reply.type('text/plain');
        return challenge;
      });
    scope.post<{ Params: { id: string } }>('/api/webhooks/messaging/meta/:id', {
      schema: { params: idParam }, config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    }, async (request) => {
      const connection = await connectionFor(db, request.params.id);
      const credentials = await credentialsFor(db, connection.id);
      const raw = request.body;
      const signature = request.headers['x-hub-signature-256'];
      if (!Buffer.isBuffer(raw) || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature))
        throw new HttpError(403, 'WEBHOOK_SIGNATURE_INVALID');
      const expected = `sha256=${createHmac('sha256', credentials.appSecret).update(raw).digest('hex')}`;
      if (!equalSecret(signature, expected)) throw new HttpError(403, 'WEBHOOK_SIGNATURE_INVALID');
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString('utf8')); }
      catch { throw new HttpError(400, 'WEBHOOK_PAYLOAD_INVALID'); }
      const events = parseWebhook(parsed, (connection.config as MessagingConnectionConfig).wabaId);
      let created = 0;
      await db.begin(async (tx) => {
        const current = (await tx`SELECT version FROM integration_connection
          WHERE id = ${connection.id} FOR NO KEY UPDATE`)[0];
        if (!current || current.version !== connection.version)
          throw new HttpError(409, 'CONNECTION_VERSION_CONFLICT');
        const senderIds = [...new Set(events.map((item) => item.kind === 'DELIVERY_STATUS'
          ? item.status.senderExternalId : item.senderExternalId))];
        const senderRows = await tx`SELECT id, external_sender_id FROM messaging_sender
          WHERE connection_id = ${connection.id} AND external_sender_id IN ${tx(senderIds)}`;
        const senderMap = new Map(senderRows.map((sender) => [sender.external_sender_id, sender.id]));
        const records = events.map((item) => {
          const senderExternalId = item.kind === 'DELIVERY_STATUS' ? item.status.senderExternalId : item.senderExternalId;
          const eventId = item.kind === 'DELIVERY_STATUS'
            ? providerEventId('DELIVERY_STATUS', [senderExternalId, item.status.providerMessageId,
              item.status.status, item.status.providerTimestamp, item.status.recipient])
            : providerEventId('INBOUND_MESSAGE', [senderExternalId, item.messageId]);
          const payload = item.kind === 'DELIVERY_STATUS' ? {
            senderExternalId, providerMessageId: item.status.providerMessageId,
            status: item.status.status, providerTimestamp: item.status.providerTimestamp,
          } : { senderExternalId, message: item.payload };
          return { provider_event_id: eventId, event_kind: item.kind, sender_id: senderMap.get(senderExternalId) ?? null,
            participant_ref: item.kind === 'DELIVERY_STATUS' ? item.status.recipient : item.participant, payload,
            state: item.kind === 'DELIVERY_STATUS' ? 'RECEIVED' : 'NEEDS_ATTENTION',
            failure_code: item.kind === 'INBOUND_MESSAGE' ? 'INBOUND_PROCESSING_NOT_READY' : null };
        });
        // Persist a bounded batch atomically; callbacks are processed outside the webhook request.
        const inserted = await tx`INSERT INTO integration_event (connection_id, provider_event_id,
          event_kind, sender_id, participant_ref, payload, state, failure_code)
          SELECT ${connection.id}, e.provider_event_id, e.event_kind, e.sender_id, e.participant_ref,
            e.payload, e.state, e.failure_code FROM jsonb_to_recordset(${tx.json(JSON.parse(JSON.stringify(records)))}) AS e
            (provider_event_id text, event_kind text, sender_id uuid, participant_ref text, payload jsonb,
              state text, failure_code text)
          ON CONFLICT (connection_id, provider_event_id) DO NOTHING RETURNING id`;
        created = inserted.length;
        await tx`UPDATE integration_connection SET
          capabilities = capabilities || ${tx.json({ webhookVerified: true })}::jsonb,
          last_success_at = now(), updated_at = now() WHERE id = ${connection.id}`;
      });
      return { received: events.length, created };
    });
  });
}
