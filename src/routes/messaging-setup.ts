import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { metaMediaCapabilities } from '../media/meta-outbound.js';
import type { Database } from '../db.js';
import { openSecret, sealSecret } from '../credentials.js';
import { HttpError, principalFromRequest, requireBranch, requireRole, type Principal } from '../security.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { metaWhatsAppAdapter, type MessagingConnectionConfig, type MessagingCredentials,
  type MessagingProviderAdapter } from '../messaging/providers.js';

const idParam = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
const credentialsSchema = { type: 'object', additionalProperties: false,
  required: ['accessToken','appSecret','verifyToken'], properties: {
    accessToken: { type: 'string', minLength: 20, maxLength: 4096 },
    appSecret: { type: 'string', minLength: 16, maxLength: 512 },
    verifyToken: { type: 'string', minLength: 16, maxLength: 512 },
  } } as const;
const configSchema = { type: 'object', additionalProperties: false, required: ['wabaId','graphVersion'], properties: {
  wabaId: { type: 'string', pattern: '^\\d{1,30}$' },
  graphVersion: { type: 'string', pattern: '^v\\d{1,2}\\.\\d{1,2}$' },
} } as const;
const connectionSchema = { type: 'object', additionalProperties: false,
  required: ['name','config','credentials'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    branchId: { type: 'string', format: 'uuid' }, config: configSchema,
    credentials: credentialsSchema,
  } } as const;
type ConnectionInput = { name: string; branchId?: string; config: MessagingConnectionConfig;
  credentials: MessagingCredentials };

async function managedConnection(db: Database, actor: Principal, id: string) {
  requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  const rows = await db`SELECT id, branch_id, status, version, config FROM integration_connection
    WHERE id = ${id} AND organization_id = ${actor.organizationId} AND kind = 'MESSAGING'
      AND provider = 'META_WHATSAPP_CLOUD'
      AND (${actor.role === 'SUPER_ADMIN'} OR branch_id = ${actor.branchId})`;
  if (!rows[0]) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND');
  return rows[0];
}

async function visibleConnection(db: Database, actor: Principal, id: string) {
  requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  const rows = await db`SELECT c.id FROM integration_connection c WHERE c.id = ${id}
    AND c.organization_id = ${actor.organizationId} AND c.kind = 'MESSAGING'
    AND (${actor.role === 'SUPER_ADMIN'} OR c.branch_id = ${actor.branchId}
      OR (c.branch_id IS NULL AND EXISTS (SELECT 1 FROM messaging_sender ms
        JOIN sender_branch_binding b ON b.sender_id = ms.id
        WHERE ms.connection_id = c.id AND b.branch_id = ${actor.branchId})))`;
  if (!rows[0]) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND');
}

export function registerMessagingSetupRoutes(app: FastifyInstance, db: Database,
  adapter: MessagingProviderAdapter = metaWhatsAppAdapter): void {
  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/messaging/connections', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const limit = request.query.limit ?? 30;
    const cursor = decodeCursor(request.query.cursor);
    const rows = await db`SELECT c.id, c.branch_id, c.provider, c.name, c.status, c.config,
        c.capabilities, c.version, c.last_success_at, c.last_failure_at, c.last_error_code,
        c.created_at, s.connection_id IS NOT NULL AS has_credential
      FROM integration_connection c LEFT JOIN connection_secret s ON s.connection_id = c.id
      WHERE c.organization_id = ${actor.organizationId} AND c.kind = 'MESSAGING'
        AND (c.branch_id = ${actor.branchId} OR ${actor.role === 'SUPER_ADMIN'} OR
          (c.branch_id IS NULL AND EXISTS (SELECT 1 FROM messaging_sender ms
            JOIN sender_branch_binding b ON b.sender_id = ms.id
            WHERE ms.connection_id = c.id AND b.branch_id = ${actor.branchId})))
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR
          (c.created_at, c.id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
  });

  app.post<{ Body: ConnectionInput }>('/api/messaging/connections', {
    schema: { body: connectionSchema },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const branchId = actor.role === 'SUPER_ADMIN' ? request.body.branchId ?? null : actor.branchId;
    if (actor.role === 'MANAGER' && !branchId) throw new HttpError(403, 'FORBIDDEN');
    if (actor.role === 'MANAGER' && request.body.branchId && request.body.branchId !== actor.branchId)
      throw new HttpError(403, 'FORBIDDEN');
    if (!request.body.name.trim()) throw new HttpError(400, 'NAME_REQUIRED');
    if (branchId) {
      requireBranch(actor, branchId);
      const branch = await db`SELECT 1 FROM branch WHERE id = ${branchId} AND organization_id = ${actor.organizationId}`;
      if (!branch.length) throw new HttpError(404, 'BRANCH_NOT_FOUND');
    }
    const id = randomUUID();
    const secret = sealSecret(id, JSON.stringify(request.body.credentials));
    await db.begin(async (tx) => {
      await tx`INSERT INTO integration_connection
        (id, organization_id, branch_id, kind, provider, name, config, created_by)
        VALUES (${id}, ${actor.organizationId}, ${branchId}, 'MESSAGING', 'META_WHATSAPP_CLOUD',
          ${request.body.name.trim()}, ${tx.json(request.body.config)}, ${actor.id})`;
      await tx`INSERT INTO connection_secret (connection_id, ciphertext, nonce, auth_tag, key_version)
        VALUES (${id}, ${secret.ciphertext}, ${secret.nonce}, ${secret.authTag}, ${secret.keyVersion})`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${branchId}, ${actor.id}, 'MESSAGING_CONNECTION_CREATED', 'CONNECTION', ${id})`;
    });
    reply.code(201);
    return { id, status: 'NOT_CONFIGURED' };
  });

  app.put<{ Params: { id: string }; Body: ConnectionInput & { version: number } }>('/api/messaging/connections/:id', {
    schema: { params: idParam, body: { ...connectionSchema,
      required: ['name','config','version'], properties: { ...connectionSchema.properties,
        version: { type: 'integer', minimum: 1 } } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const old = await managedConnection(db, actor, request.params.id);
    if (request.body.branchId && request.body.branchId !== old.branch_id) throw new HttpError(400, 'CONNECTION_SCOPE_IMMUTABLE');
    if (!request.body.name.trim()) throw new HttpError(400, 'NAME_REQUIRED');
    const sealed = request.body.credentials ? sealSecret(request.params.id, JSON.stringify(request.body.credentials)) : null;
    return db.begin(async (tx) => {
      const rows = await tx`SELECT version, status FROM integration_connection WHERE id = ${request.params.id} FOR UPDATE`;
      if (rows[0]!.version !== request.body.version) throw new HttpError(409, 'CONNECTION_VERSION_CONFLICT');
      if (rows[0]!.status === 'DISABLED') throw new HttpError(409, 'CONNECTION_DISABLED');
      const updated = await tx`UPDATE integration_connection SET name = ${request.body.name.trim()},
        config = ${tx.json(request.body.config)}, status = 'NOT_CONFIGURED', version = version + 1,
        capabilities = '{}'::jsonb, last_error_code = NULL, updated_at = now()
        WHERE id = ${request.params.id} RETURNING version`;
      if (sealed) await tx`UPDATE connection_secret SET ciphertext = ${sealed.ciphertext}, nonce = ${sealed.nonce},
        auth_tag = ${sealed.authTag}, key_version = ${sealed.keyVersion}, updated_at = now()
        WHERE connection_id = ${request.params.id}`;
      await tx`UPDATE messaging_sender SET health = 'UNKNOWN', active = false WHERE connection_id = ${request.params.id}`;
      await tx`UPDATE provider_message_template SET active = false WHERE connection_id = ${request.params.id}`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${old.branch_id}, ${actor.id}, 'MESSAGING_CONNECTION_UPDATED', 'CONNECTION', ${request.params.id})`;
      return { version: updated[0]!.version, status: 'NOT_CONFIGURED' };
    });
  });

  app.post<{ Params: { id: string } }>('/api/messaging/connections/:id/test', {
    schema: { params: idParam }, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const connection = await managedConnection(db, actor, request.params.id);
    if (connection.status === 'DISABLED') throw new HttpError(409, 'CONNECTION_DISABLED');
    const secrets = await db`SELECT ciphertext, nonce, auth_tag, key_version FROM connection_secret
      WHERE connection_id = ${connection.id}`;
    if (!secrets[0]) throw new HttpError(409, 'CONNECTION_CREDENTIAL_MISSING');
    const credentials = JSON.parse(openSecret(connection.id, { ciphertext: secrets[0].ciphertext,
      nonce: secrets[0].nonce, authTag: secrets[0].auth_tag, keyVersion: secrets[0].key_version })) as MessagingCredentials;
    let discovered;
    try { discovered = await adapter.discoverSenders(connection.config as MessagingConnectionConfig, credentials); }
    catch {
      await db.begin(async (tx) => {
        const changed = await tx`UPDATE integration_connection SET status = 'ERROR', last_failure_at = now(),
          last_error_code = 'SENDER_DISCOVERY_FAILED', updated_at = now()
          WHERE id = ${connection.id} AND version = ${connection.version} AND status <> 'DISABLED' RETURNING id`;
        if (changed.length) await tx`INSERT INTO audit_log
          (organization_id, branch_id, actor_user_id, action, target_type, target_id)
          VALUES (${actor.organizationId}, ${connection.branch_id}, ${actor.id},
            'MESSAGING_CONNECTION_DISCOVERY_FAILED', 'CONNECTION', ${connection.id})`;
      });
      throw new HttpError(502, 'MESSAGING_CONNECTION_TEST_FAILED');
    }
    if (!discovered.length || discovered.length > 1000 || new Set(discovered.map((sender) => sender.externalId)).size !== discovered.length)
      throw new HttpError(502, 'SENDER_DISCOVERY_INVALID');
    return db.begin(async (tx) => {
      const changed = await tx`UPDATE integration_connection SET status = 'WARNING',
        capabilities = ${tx.json({ senderDiscovery: true })}, last_success_at = now(),
        last_error_code = 'SEND_NOT_TESTED', updated_at = now()
        WHERE id = ${connection.id} AND version = ${connection.version} AND status <> 'DISABLED' RETURNING id`;
      if (!changed.length) throw new HttpError(409, 'CONNECTION_VERSION_CONFLICT');
      await tx`UPDATE messaging_sender SET active = false, health = 'UNKNOWN' WHERE connection_id = ${connection.id}`;
      for (const sender of discovered) {
        if (!/^\d{1,30}$/.test(sender.externalId) || !sender.displayName.trim() || sender.displayName.length > 200)
          throw new HttpError(502, 'SENDER_DISCOVERY_INVALID');
        await tx`INSERT INTO messaging_sender (organization_id, connection_id, external_sender_id,
          display_name, provider_status, capabilities)
          VALUES (${actor.organizationId}, ${connection.id}, ${sender.externalId}, ${sender.displayName},
          ${tx.json({ qualityRating: sender.qualityRating })}, ${tx.json({ text: true, template: true, ...metaMediaCapabilities() })})
          ON CONFLICT (connection_id, external_sender_id) DO UPDATE SET display_name = EXCLUDED.display_name,
            provider_status = EXCLUDED.provider_status, capabilities = EXCLUDED.capabilities,
            active = true`;
      }
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
        VALUES (${actor.organizationId}, ${connection.branch_id}, ${actor.id}, 'MESSAGING_CONNECTION_DISCOVERED',
          'CONNECTION', ${connection.id}, ${tx.json({ senderCount: discovered.length })})`;
      return { status: 'WARNING', senderCount: discovered.length, outboundVerified: false };
    });
  });

  app.patch<{ Params: { id: string }; Body: { version: number; disabled: boolean } }>('/api/messaging/connections/:id/status', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false,
      required: ['version','disabled'], properties: { version: { type: 'integer', minimum: 1 },
        disabled: { type: 'boolean' } } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const connection = await managedConnection(db, actor, request.params.id);
    return db.begin(async (tx) => {
      const updated = await tx`UPDATE integration_connection SET status = ${request.body.disabled ? 'DISABLED' : 'NOT_CONFIGURED'},
        capabilities = '{}'::jsonb, version = version + 1, updated_at = now()
        WHERE id = ${connection.id} AND version = ${request.body.version} RETURNING version`;
      if (!updated.length) throw new HttpError(409, 'CONNECTION_VERSION_CONFLICT');
      await tx`UPDATE messaging_sender SET health = 'UNKNOWN' WHERE connection_id = ${connection.id}`;
      if (request.body.disabled) await tx`UPDATE provider_message_template SET active = false
        WHERE connection_id = ${connection.id}`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${connection.branch_id}, ${actor.id},
          ${request.body.disabled ? 'MESSAGING_CONNECTION_DISABLED' : 'MESSAGING_CONNECTION_ENABLED'},
          'CONNECTION', ${connection.id})`;
      return { status: request.body.disabled ? 'DISABLED' : 'NOT_CONFIGURED', version: updated[0]!.version };
    });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; after?: string } }>(
    '/api/messaging/connections/:id/senders', {
    schema: { params: idParam, querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, after: { type: 'string', format: 'uuid' },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    await visibleConnection(db, actor, request.params.id);
    const limit = request.query.limit ?? 50;
    const rows = await db`SELECT id, external_sender_id, display_name, active, operator_enabled, version,
        health, capabilities, provider_status, cooldown_until, last_provider_error_code,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('branchId', b.branch_id,
          'allowSharedFallback', b.allow_shared_fallback)), '[]'::jsonb)
          FROM sender_branch_binding b WHERE b.sender_id = messaging_sender.id
            AND (${actor.role === 'SUPER_ADMIN'} OR b.branch_id = ${actor.branchId})) AS bindings
      FROM messaging_sender WHERE connection_id = ${request.params.id} AND organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR EXISTS (SELECT 1 FROM integration_connection c
          WHERE c.id = messaging_sender.connection_id AND c.branch_id = ${actor.branchId}) OR
          EXISTS (SELECT 1 FROM sender_branch_binding b WHERE b.sender_id = messaging_sender.id
            AND b.branch_id = ${actor.branchId}))
        AND (${request.query.after ?? null}::uuid IS NULL OR id > ${request.query.after ?? null}::uuid)
      ORDER BY id LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    return { items, nextAfter: rows.length > limit ? items.at(-1)!.id : null };
  });

  app.get<{ Params: { id: string } }>('/api/messaging/connections/:id/queue-health', {
    schema: { params: idParam },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    await visibleConnection(db, actor, request.params.id);
    const connection = (await db`SELECT status, cooldown_until, last_error_code
      FROM integration_connection WHERE id = ${request.params.id}`)[0]!;
    const depth = (await db`SELECT
        count(*) FILTER (WHERE j.status = 'QUEUED')::integer AS queued,
        count(*) FILTER (WHERE j.status = 'RUNNING')::integer AS running,
        min(j.created_at) FILTER (WHERE j.status = 'QUEUED') AS oldest_queued_at
      FROM background_job j JOIN outbound_delivery_job link ON link.job_id = j.id
      JOIN conversation_message m ON m.id = link.message_id
      JOIN conversation cv ON cv.id = m.conversation_id JOIN lead l ON l.id = cv.lead_id
      WHERE j.queue = 'messaging' AND j.kind = 'SEND_MESSAGE'
        AND j.status IN ('QUEUED','RUNNING') AND m.connection_id = ${request.params.id}
        AND (${actor.role === 'SUPER_ADMIN'} OR l.branch_id = ${actor.branchId})`)[0]!;
    return { status: connection.status, cooldownUntil: connection.cooldown_until,
      lastErrorCode: connection.last_error_code, ...depth };
  });
}
