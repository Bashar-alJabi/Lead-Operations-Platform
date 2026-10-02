import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { openSecret, sealSecret } from '../credentials.js';
import { identityEmailConnection, type EmailSettings, type IdentityEmailAdapter } from '../identity-email.js';
import { HttpError, principalFromRequest, requireRole } from '../security.js';
import { decodeCursor, encodeCursor } from '../pagination.js';

const emailPattern = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';

export function registerIdentityEmailRoutes(app: FastifyInstance, db: Database, adapter: IdentityEmailAdapter): void {
  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/identity/deliveries', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const cursor = decodeCursor(request.query.cursor);
    const limit = request.query.limit ?? 50;
    const rows = await db`SELECT j.id, j.kind, j.status, j.attempts, j.max_attempts, j.last_error_code,
      j.run_after, j.created_at, u.email, u.name
      FROM background_job j JOIN user_account u ON u.id::text = (j.payload ->> 'userId')
      WHERE j.queue = 'identity_email' AND u.organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR u.branch_id = ${actor.branchId})
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (j.created_at, j.id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      ORDER BY j.created_at DESC, j.id DESC LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
  });

  app.post<{ Params: { id: string } }>('/api/identity/deliveries/:id/retry', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    await db.begin(async (tx) => {
      const rows = await tx`SELECT j.id, j.status, u.id AS user_id, u.branch_id,
        t.used_at, t.expires_at <= now() AS expired
        FROM background_job j JOIN user_account u ON u.id::text = (j.payload ->> 'userId')
        JOIN credential_token t ON t.id::text = (j.payload ->> 'tokenId')
        WHERE j.id = ${request.params.id} AND j.queue = 'identity_email'
          AND u.organization_id = ${actor.organizationId} FOR UPDATE OF j`;
      const job = rows[0];
      if (!job) throw new HttpError(404, 'DELIVERY_NOT_FOUND');
      if (actor.role === 'MANAGER' && job.branch_id !== actor.branchId) throw new HttpError(403, 'FORBIDDEN');
      if (job.status !== 'DEAD' || job.used_at || job.expired) throw new HttpError(409, 'DELIVERY_NOT_RETRYABLE');
      await tx`UPDATE background_job SET status = 'QUEUED', attempts = 0, run_after = now(),
        locked_until = NULL, last_error_code = NULL, updated_at = now() WHERE id = ${job.id}`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${job.branch_id}, ${actor.id}, 'IDENTITY_DELIVERY_RETRIED', 'JOB', ${job.id})`;
    });
    return { status: 'QUEUED' };
  });

  app.get('/api/identity/email', async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN');
    const row = await identityEmailConnection(db, actor.organizationId);
    if (!row) return { configured: false };
    return { configured: true, id: row.id, name: row.name, status: row.status, settings: row.config,
      hasCredential: row.ciphertext != null };
  });

  app.put<{ Body: EmailSettings & { name: string; password: string } }>('/api/identity/email', {
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['name','host','port','secure','username','password','fromAddress'], properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        host: { type: 'string', minLength: 1, maxLength: 253, pattern: '^[a-zA-Z0-9][a-zA-Z0-9.:-]*$' },
        port: { type: 'integer', minimum: 1, maximum: 65535 }, secure: { type: 'boolean' },
        username: { type: 'string', minLength: 1, maxLength: 320 },
        password: { type: 'string', minLength: 1, maxLength: 4096 },
        fromAddress: { type: 'string', pattern: emailPattern, maxLength: 320 },
      } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN');
    const { name, password, ...settings } = request.body;
    const id = await db.begin(async (tx) => {
      await tx`SELECT id FROM organization WHERE id = ${actor.organizationId} FOR UPDATE`;
      const existing = await tx`SELECT connection_id FROM identity_email_connection WHERE organization_id = ${actor.organizationId}`;
      const connectionId = String(existing[0]?.connection_id ?? randomUUID());
      const secret = sealSecret(connectionId, password);
      if (existing.length) {
        await tx`UPDATE integration_connection SET name = ${name.trim()}, config = ${tx.json(settings)},
          status = 'NOT_CONFIGURED', updated_at = now() WHERE id = ${connectionId}`;
      } else {
        await tx`INSERT INTO integration_connection
          (id, organization_id, kind, provider, name, config, created_by)
          VALUES (${connectionId}, ${actor.organizationId}, 'EMAIL', 'SMTP', ${name.trim()}, ${tx.json(settings)}, ${actor.id})`;
        await tx`INSERT INTO identity_email_connection (organization_id, connection_id, updated_by)
          VALUES (${actor.organizationId}, ${connectionId}, ${actor.id})`;
      }
      await tx`INSERT INTO connection_secret (connection_id, ciphertext, nonce, auth_tag, key_version)
        VALUES (${connectionId}, ${secret.ciphertext}, ${secret.nonce}, ${secret.authTag}, ${secret.keyVersion})
        ON CONFLICT (connection_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce,
          auth_tag = EXCLUDED.auth_tag, key_version = EXCLUDED.key_version, updated_at = now()`;
      await tx`INSERT INTO audit_log (organization_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${actor.id}, 'IDENTITY_EMAIL_CONFIGURED', 'CONNECTION', ${connectionId})`;
      return connectionId;
    });
    return { id, status: 'NOT_CONFIGURED' };
  });

  app.post('/api/identity/email/test', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN');
    const row = await identityEmailConnection(db, actor.organizationId);
    if (!row || !row.ciphertext) throw new HttpError(409, 'EMAIL_NOT_CONFIGURED');
    try {
      const password = openSecret(String(row.id), {
        ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag, keyVersion: row.key_version,
      });
      await adapter.verify(row.config as EmailSettings, password);
    } catch {
      await db`UPDATE integration_connection SET status = 'ERROR', last_failure_at = now(),
        last_error_code = 'SMTP_VERIFICATION_FAILED', updated_at = now() WHERE id = ${row.id}`;
      throw new HttpError(502, 'EMAIL_CONNECTION_FAILED');
    }
    await db`UPDATE integration_connection SET status = 'CONNECTED', last_success_at = now(),
      last_error_code = NULL, updated_at = now() WHERE id = ${row.id}`;
    return { status: 'CONNECTED' };
  });
}
