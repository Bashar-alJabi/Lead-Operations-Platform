import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { openSecret } from '../credentials.js';
import { requiredEnv } from '../config.js';
import { parseTextTemplate } from '../messaging/approved-template.js';
import { HttpError, principalFromRequest, requireRole } from '../security.js';
import { metaWhatsAppSendAdapter, ProviderSendError, type MessagingConnectionConfig,
  type MessagingCredentials, type MessagingSendAdapter } from '../messaging/providers.js';

const params = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
const body = { type: 'object', additionalProperties: false,
  required: ['senderId','templateId','recipient','recipientConfirmed','idempotencyKey'], properties: {
    senderId: { type: 'string', format: 'uuid' }, templateId: { type: 'string', format: 'uuid' },
    recipient: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
    recipientConfirmed: { type: 'boolean', const: true },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
  } } as const;
type TestInput = { senderId: string; templateId: string; recipient: string;
  recipientConfirmed: true; idempotencyKey: string };

function staticBody(components: unknown): boolean {
  const parsed=parseTextTemplate(components);
  return parsed?.parameterCount===0 && parsed.headerParameterCount===0 && parsed.urlParameterIndex===null
    && !parsed.buttons.some((button)=>button.type==='QUICK_REPLY');
}

export function registerMessagingTestSendRoutes(app: FastifyInstance, db: Database,
  adapter: MessagingSendAdapter = metaWhatsAppSendAdapter): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: number; before?: string } }>(
    '/api/messaging/connections/:id/test-sends', { schema: { params, querystring: {
      type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        before: { type: 'string', format: 'uuid' },
      },
    } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
      const connection = (await db`SELECT id FROM integration_connection WHERE id = ${request.params.id}
        AND organization_id = ${actor.organizationId} AND kind = 'MESSAGING'
        AND provider = 'META_WHATSAPP_CLOUD'
        AND (${actor.role === 'SUPER_ADMIN'} OR branch_id = ${actor.branchId})`)[0];
      if (!connection) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND');
      const limit = request.query.limit ?? 30;
      const rows = await db`SELECT r.id, r.connection_version, r.sender_id, r.template_id,
          r.recipient_last4, r.state, r.delivery_state, r.provider_message_id, r.error_code,
          r.created_at, r.updated_at
        FROM messaging_connection_test_send r WHERE r.connection_id = ${connection.id}
          AND (${request.query.before ?? null}::uuid IS NULL OR (r.created_at, r.id) <
            (SELECT created_at, id FROM messaging_connection_test_send WHERE id = ${request.query.before ?? null}::uuid
              AND connection_id = ${connection.id}))
        ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      return { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null };
    });

  app.post<{ Params: { id: string }; Body: TestInput }>(
    '/api/messaging/connections/:id/test-send', {
      schema: { params, body }, config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
    }, async (request, reply) => {
      const actor = await principalFromRequest(request, db);
      requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
      const connection = (await db`SELECT id, branch_id, status, version, config
        FROM integration_connection WHERE id = ${request.params.id}
          AND organization_id = ${actor.organizationId} AND kind = 'MESSAGING'
          AND provider = 'META_WHATSAPP_CLOUD'
          AND (${actor.role === 'SUPER_ADMIN'} OR branch_id = ${actor.branchId})`)[0];
      if (!connection) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND');
      const input = request.body;
      const requestHash = createHmac('sha256', requiredEnv('CREDENTIAL_ENCRYPTION_KEY'))
        .update(JSON.stringify([connection.version, input.senderId, input.templateId, input.recipient])).digest('hex');
      const existing = (await db`SELECT id, request_hash, state, provider_message_id, error_code
        FROM messaging_connection_test_send WHERE connection_id = ${connection.id}
          AND idempotency_key = ${input.idempotencyKey}`)[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
        if (existing.state === 'SUCCEEDED' || existing.state === 'REJECTED') return {
          id: existing.id, state: existing.state, providerMessageId: existing.provider_message_id,
          errorCode: existing.error_code, replayed: true,
        };
        if (existing.state === 'IN_PROGRESS') {
          const stale = await db`UPDATE messaging_connection_test_send SET state = 'UNKNOWN',
            error_code = 'TEST_SEND_INTERRUPTED', updated_at = now()
            WHERE id = ${existing.id} AND state = 'IN_PROGRESS'
              AND created_at < now() - interval '2 minutes' RETURNING id`;
          if (stale.length) await db`INSERT INTO audit_log (organization_id, branch_id, actor_user_id,
            action, target_type, target_id, detail) VALUES (${actor.organizationId}, ${connection.branch_id},
              ${actor.id}, 'MESSAGING_TEST_SEND_UNKNOWN', 'CONNECTION', ${connection.id},
              ${db.json({ requestId: existing.id, errorCode: 'TEST_SEND_INTERRUPTED' })})`;
          throw new HttpError(409, stale.length ? 'TEST_SEND_OUTCOME_UNKNOWN' : 'TEST_SEND_IN_PROGRESS');
        }
        throw new HttpError(409, 'TEST_SEND_OUTCOME_UNKNOWN');
      }
      if (!['WARNING','CONNECTED'].includes(connection.status)) throw new HttpError(409, 'CONNECTION_DISCOVERY_REQUIRED');
      const secret = (await db`SELECT ciphertext, nonce, auth_tag, key_version FROM connection_secret
        WHERE connection_id = ${connection.id}`)[0];
      if (!secret) throw new HttpError(409, 'CONNECTION_CREDENTIAL_MISSING');
      let credentials: MessagingCredentials;
      try {
        credentials = JSON.parse(openSecret(connection.id, { ciphertext: secret.ciphertext,
          nonce: secret.nonce, authTag: secret.auth_tag, keyVersion: secret.key_version })) as MessagingCredentials;
        if (!credentials.accessToken) throw new Error('missing');
      } catch { throw new HttpError(409, 'CONNECTION_CREDENTIAL_UNAVAILABLE'); }
      if (!adapter.sendTemplate) throw new HttpError(409, 'PROVIDER_TEMPLATE_SEND_UNSUPPORTED');

      const claimed = await db.begin(async (tx) => {
        const current = (await tx`SELECT status, version, cooldown_until FROM integration_connection
          WHERE id = ${connection.id} FOR SHARE`)[0]!;
        if (current.version !== connection.version) throw new HttpError(409, 'CONNECTION_VERSION_CONFLICT');
        if (!['WARNING','CONNECTED'].includes(current.status)) throw new HttpError(409, 'CONNECTION_DISCOVERY_REQUIRED');
        const sender = (await tx`SELECT external_sender_id, active, operator_enabled, cooldown_until
          FROM messaging_sender WHERE id = ${input.senderId} AND connection_id = ${connection.id}
            AND organization_id = ${actor.organizationId} FOR SHARE`)[0];
        if (!sender || !sender.active || !sender.operator_enabled) throw new HttpError(409, 'TEST_SENDER_UNAVAILABLE');
        if ((current.cooldown_until && current.cooldown_until > new Date()) ||
          (sender.cooldown_until && sender.cooldown_until > new Date()))
          throw new HttpError(409, 'PROVIDER_COOLDOWN_ACTIVE');
        const template = (await tx`SELECT name, language, components, active, status
          FROM provider_message_template WHERE id = ${input.templateId} AND connection_id = ${connection.id}
          FOR SHARE`)[0];
        if (!template || !template.active || template.status !== 'APPROVED')
          throw new HttpError(409, 'TEMPLATE_NOT_APPROVED');
        if (!staticBody(template.components)) throw new HttpError(409, 'TEMPLATE_FORMAT_UNSUPPORTED');
        const inserted = await tx`INSERT INTO messaging_connection_test_send
          (connection_id, connection_version, sender_id, template_id, idempotency_key,
            request_hash, recipient_last4, state, created_by)
          VALUES (${connection.id}, ${connection.version}, ${input.senderId}, ${input.templateId},
            ${input.idempotencyKey}, ${requestHash}, ${input.recipient.slice(-4)}, 'IN_PROGRESS', ${actor.id})
          ON CONFLICT (connection_id, idempotency_key) DO NOTHING RETURNING id`;
        if (!inserted.length) return null;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
          target_type, target_id) VALUES (${actor.organizationId}, ${connection.branch_id}, ${actor.id},
            'MESSAGING_TEST_SEND_STARTED', 'CONNECTION', ${connection.id})`;
        return { id: inserted[0]!.id as string, sender: sender.external_sender_id as string,
          templateName: template.name as string, templateLanguage: template.language as string };
      });
      if (!claimed) throw new HttpError(409, 'TEST_SEND_IN_PROGRESS');

      let state: 'SUCCEEDED'|'REJECTED'|'UNKNOWN' = 'SUCCEEDED';
      let providerMessageId: string | null = null;
      let errorCode: string | null = null;
      let providerFailure: ProviderSendError | null = null;
      try {
        const result = await adapter.sendTemplate({ config: connection.config as MessagingConnectionConfig,
          credentials, externalSenderId: claimed.sender, recipient: input.recipient,
          templateName: claimed.templateName, templateLanguage: claimed.templateLanguage });
        if (!result.providerMessageId || result.providerMessageId.length > 255)
          throw new ProviderSendError('UNKNOWN', 'PROVIDER_RESPONSE_AMBIGUOUS');
        providerMessageId = result.providerMessageId;
      } catch (error) {
        providerFailure = error instanceof ProviderSendError ? error : null;
        state = providerFailure && providerFailure.kind !== 'UNKNOWN' ? 'REJECTED' : 'UNKNOWN';
        errorCode = error instanceof ProviderSendError ? error.code : 'PROVIDER_SEND_OUTCOME_UNKNOWN';
      }
      const readiness = await db.begin(async (tx) => {
        const current = (await tx`SELECT status, version FROM integration_connection
          WHERE id = ${connection.id} FOR UPDATE`)[0]!;
        const sender = (await tx`SELECT active, operator_enabled FROM messaging_sender
          WHERE id = ${input.senderId} FOR UPDATE`)[0]!;
        const validVersion = current.version === connection.version && current.status !== 'DISABLED';
        const ready = state === 'SUCCEEDED' && validVersion && sender.active && sender.operator_enabled;
        await tx`UPDATE messaging_connection_test_send SET state = ${state}, provider_message_id = ${providerMessageId},
          delivery_state = ${state === 'SUCCEEDED' ? 'SENT' : null},
          error_code = ${errorCode}, updated_at = now() WHERE id = ${claimed.id}`;
        if (ready) {
          await tx`UPDATE integration_connection SET status = 'CONNECTED',
            capabilities = capabilities || ${tx.json({ outboundAccepted: true, webhookVerified: false })}::jsonb,
            last_success_at = now(), last_error_code = 'WEBHOOK_NOT_TESTED', updated_at = now()
            WHERE id = ${connection.id}`;
          await tx`UPDATE messaging_sender SET health = 'DEGRADED', last_provider_error_code = NULL
            WHERE id = ${input.senderId}`;
        } else if (validVersion && state !== 'SUCCEEDED') {
          await tx`UPDATE integration_connection SET last_failure_at = now(), last_error_code = ${errorCode},
            status = CASE WHEN ${errorCode} = 'PROVIDER_AUTH_FAILED' THEN 'AUTH_EXPIRED' ELSE status END,
            updated_at = now() WHERE id = ${connection.id}`;
          if (providerFailure?.code === 'PROVIDER_RATE_LIMITED') {
            const delay = Math.min(3600, Math.max(1, providerFailure.retryAfterSeconds ?? 30));
            await tx`UPDATE integration_connection SET cooldown_until = GREATEST(
              COALESCE(cooldown_until, now()), now() + (${delay} * interval '1 second'))
              WHERE id = ${connection.id}`;
            await tx`UPDATE messaging_sender SET cooldown_until = GREATEST(
              COALESCE(cooldown_until, now()), now() + (${delay} * interval '1 second')),
              last_provider_error_code = 'PROVIDER_RATE_LIMITED' WHERE id = ${input.senderId}`;
          }
          if (errorCode === 'PROVIDER_AUTH_FAILED')
            await tx`UPDATE messaging_sender SET health = 'UNKNOWN' WHERE connection_id = ${connection.id}`;
        }
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
          target_type, target_id, detail) VALUES (${actor.organizationId}, ${connection.branch_id}, ${actor.id},
            ${state === 'SUCCEEDED' ? 'MESSAGING_TEST_SEND_ACCEPTED' : state === 'REJECTED'
              ? 'MESSAGING_TEST_SEND_REJECTED' : 'MESSAGING_TEST_SEND_UNKNOWN'},
            'CONNECTION', ${connection.id}, ${tx.json({ requestId: claimed.id, senderId: input.senderId,
              errorCode, readiness: ready })})`;
        return ready;
      });
      if (state === 'UNKNOWN') reply.code(202);
      return { id: claimed.id, state, providerMessageId, errorCode, outboundReady: readiness, replayed: false };
    });
}
