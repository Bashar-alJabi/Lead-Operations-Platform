import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireBranch, requireRole } from '../security.js';
import { resolveConfiguredSender } from '../messaging/sender-resolution.js';
import { currentPaymentSession } from '../payments/access.js';

const idParam = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
const bindingParam = { type: 'object', additionalProperties: false, required: ['id','branchId'],
  properties: { id: { type: 'string', format: 'uuid' }, branchId: { type: 'string', format: 'uuid' } } } as const;
const senderId = { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] } as const;

export function registerSenderBindingRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Params: { id: string }; Body: { version: number; reason: string } }>(
    '/api/messaging/senders/:id/reserve-for-staff', {
      preValidation: async request => {
        if (typeof request.body?.version !== 'number' || typeof request.body?.reason !== 'string')
          throw new HttpError(400,'INVALID_STAFF_SENDER_REQUEST');
      },
      schema: { params: idParam, body: { type: 'object', additionalProperties: false, required: ['version','reason'],
        properties: { version: { type: 'integer', minimum: 1, maximum: 2147483646 },
          reason: { type: 'string', minLength: 3, maxLength: 500, pattern: '^[^\\x00-\\x1f\\x7f]+$' } } } },
    }, async (request,reply) => {
      const actor = await principalFromRequest(request, db);
      requireRole(actor,'SUPER_ADMIN','MANAGER');
      const reason = request.body.reason.trim();
      if (reason.length<3) throw new HttpError(400,'STAFF_SENDER_REASON_REQUIRED');
      try {
        const result = await db.begin(async tx => {
          const [connection] = await tx`SELECT c.id,c.branch_id FROM messaging_sender s
            JOIN integration_connection c ON c.id=s.connection_id AND c.kind='MESSAGING' AND c.organization_id=s.organization_id
            WHERE s.id=${request.params.id} AND c.organization_id=${actor.organizationId} AND c.branch_id IS NOT NULL
              AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId}) FOR NO KEY UPDATE OF c`;
          if (!connection) throw new HttpError(404,'SENDER_NOT_FOUND');
          await tx`SELECT id FROM branch WHERE id=${connection.branch_id} FOR SHARE`;
          const [sender] = await tx`SELECT version FROM messaging_sender WHERE id=${request.params.id}
            AND connection_id=${connection.id} FOR UPDATE`;
          const session = await currentPaymentSession(tx,actor,request);
          if (!session) throw new HttpError(403,'STAFF_SENDER_ACCESS_DENIED');
          if (sender?.version!==request.body.version) throw new HttpError(409,'SENDER_VERSION_CONFLICT');
          if ((await tx`SELECT 1 FROM staff_messaging_sender WHERE sender_id=${request.params.id}`).length)
            throw new HttpError(409,'STAFF_SENDER_ALREADY_RESERVED');
          const [reservation] = await tx`INSERT INTO staff_messaging_sender(sender_id,connection_id,actor_id,session_id,sender_version,reason)
            VALUES(${request.params.id},${connection.id},${actor.id},${session},${request.body.version},${reason})
            RETURNING sender_id AS "senderId",branch_id AS "branchId",sender_version+1 AS version,created_at AS "reservedAt"`;
          return reservation;
        });
        return reply.code(201).send(result);
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['STAFF_SENDER_CUSTOMER_USE','STAFF_SENDER_EXTERNAL_ID_SHARED','STAFF_SENDER_UNAVAILABLE','SENDER_VERSION_CONFLICT'].includes(code))
          throw new HttpError(409,code);
        if (code==='STAFF_SENDER_ACCESS_DENIED') throw new HttpError(403,code);
        throw error;
      }
    });

  app.get<{ Params: { id: string } }>('/api/messaging/campaigns/:id/effective-sender', {
    schema: { params: idParam },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const campaign = (await db`SELECT branch_id FROM campaign WHERE id = ${request.params.id}
      AND organization_id = ${actor.organizationId}
      AND (${actor.role === 'SUPER_ADMIN'} OR branch_id = ${actor.branchId})`)[0];
    if (!campaign) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
    const result = await resolveConfiguredSender(db, { organizationId: actor.organizationId,
      branchId: campaign.branch_id, campaignId: request.params.id });
    return { senderId: result.sender?.id ?? null, reason: result.reason };
  });

  app.patch<{ Params: { id: string }; Body: { version: number; operatorEnabled: boolean } }>(
    '/api/messaging/senders/:id', { schema: { params: idParam, body: { type: 'object', additionalProperties: false,
      required: ['version','operatorEnabled'], properties: { version: { type: 'integer', minimum: 1 },
        operatorEnabled: { type: 'boolean' } } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
      return db.begin(async (tx) => {
        const sender = (await tx`SELECT s.id, s.version, c.branch_id,
          EXISTS(SELECT 1 FROM staff_messaging_sender i WHERE i.sender_id=s.id) AS staff_only FROM messaging_sender s
          JOIN integration_connection c ON c.id = s.connection_id WHERE s.id = ${request.params.id}
            AND s.organization_id = ${actor.organizationId} AND c.kind = 'MESSAGING'
          FOR UPDATE OF s`)[0];
        if (!sender || (actor.role !== 'SUPER_ADMIN' && sender.branch_id !== actor.branchId))
          throw new HttpError(404, 'SENDER_NOT_FOUND');
        if (sender.staff_only) throw new HttpError(409, 'STAFF_SENDER_CUSTOMER_USE');
        if (sender.version !== request.body.version) throw new HttpError(409, 'SENDER_VERSION_CONFLICT');
        const row = (await tx`UPDATE messaging_sender SET operator_enabled = ${request.body.operatorEnabled},
          version = version + 1 WHERE id = ${sender.id} RETURNING version, operator_enabled`)[0]!;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
          VALUES (${actor.organizationId}, ${sender.branch_id}, ${actor.id},
            ${request.body.operatorEnabled ? 'MESSAGING_SENDER_ENABLED' : 'MESSAGING_SENDER_DISABLED'}, 'SENDER', ${sender.id})`;
        return row;
      });
    });

  app.put<{ Params: { id: string; branchId: string }; Body: { version: number; bound: boolean;
    allowSharedFallback: boolean } }>('/api/messaging/senders/:id/bindings/:branchId', {
    schema: { params: bindingParam, body: { type: 'object', additionalProperties: false,
      required: ['version','bound','allowSharedFallback'], properties: { version: { type: 'integer', minimum: 1 },
        bound: { type: 'boolean' }, allowSharedFallback: { type: 'boolean' } } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN');
    if (!request.body.bound && request.body.allowSharedFallback) throw new HttpError(400, 'INVALID_BINDING');
    return db.begin(async (tx) => {
      const sender = (await tx`SELECT s.id, s.version, c.branch_id FROM messaging_sender s
        JOIN integration_connection c ON c.id = s.connection_id WHERE s.id = ${request.params.id}
          AND s.organization_id = ${actor.organizationId} AND c.kind = 'MESSAGING' FOR UPDATE OF s`)[0];
      if (!sender) throw new HttpError(404, 'SENDER_NOT_FOUND');
      if (sender.branch_id !== null) throw new HttpError(400, 'BINDING_REQUIRES_ORGANIZATION_SENDER');
      if (sender.version !== request.body.version) throw new HttpError(409, 'SENDER_VERSION_CONFLICT');
      const branch = await tx`SELECT 1 FROM branch WHERE id = ${request.params.branchId}
        AND organization_id = ${actor.organizationId}`;
      if (!branch.length) throw new HttpError(404, 'BRANCH_NOT_FOUND');
      if (request.body.bound) {
        await tx`INSERT INTO sender_branch_binding (sender_id, branch_id, allow_shared_fallback)
          VALUES (${sender.id}, ${request.params.branchId}, ${request.body.allowSharedFallback})
          ON CONFLICT (sender_id, branch_id) DO UPDATE SET allow_shared_fallback = EXCLUDED.allow_shared_fallback`;
      } else {
        const used = await tx`SELECT 1 FROM branch WHERE id = ${request.params.branchId} AND default_sender_id = ${sender.id}
          UNION ALL SELECT 1 FROM campaign WHERE branch_id = ${request.params.branchId}
            AND sender_override_id = ${sender.id} LIMIT 1`;
        if (used.length) throw new HttpError(409, 'SENDER_IN_USE');
        await tx`DELETE FROM sender_branch_binding WHERE sender_id = ${sender.id} AND branch_id = ${request.params.branchId}`;
      }
      const changed = (await tx`UPDATE messaging_sender SET version = version + 1 WHERE id = ${sender.id}
        RETURNING version`)[0]!;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id,
        detail) VALUES (${actor.organizationId}, ${request.params.branchId}, ${actor.id},
          ${request.body.bound ? 'MESSAGING_SENDER_BOUND' : 'MESSAGING_SENDER_UNBOUND'}, 'SENDER', ${sender.id},
          ${tx.json({ allowSharedFallback: request.body.allowSharedFallback })})`;
      return { version: changed.version, bound: request.body.bound,
        allowSharedFallback: request.body.allowSharedFallback };
    });
  });

  app.get<{ Params: { id: string } }>('/api/messaging/branches/:id/default-sender', {
    schema: { params: idParam },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    requireBranch(actor, request.params.id);
    const row = (await db`SELECT default_sender_id, sender_version FROM branch WHERE id = ${request.params.id}
      AND organization_id = ${actor.organizationId}`)[0];
    if (!row) throw new HttpError(404, 'BRANCH_NOT_FOUND');
    return row;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; after?: string } }>(
    '/api/messaging/branches/:id/senders', { schema: { params: idParam,
      querystring: { type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 }, after: { type: 'string', format: 'uuid' },
      } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
      requireBranch(actor, request.params.id);
      const branch = await db`SELECT 1 FROM branch WHERE id = ${request.params.id}
        AND organization_id = ${actor.organizationId}`;
      if (!branch.length) throw new HttpError(404, 'BRANCH_NOT_FOUND');
      const limit = request.query.limit ?? 50;
      const rows = await db`SELECT s.id, s.display_name, s.external_sender_id, s.active,
          s.operator_enabled, s.health, c.status AS connection_status, c.name AS connection_name,
          (b.allow_shared_fallback IS TRUE) AS allow_shared_fallback
        FROM messaging_sender s JOIN integration_connection c ON c.id = s.connection_id
        LEFT JOIN sender_branch_binding b ON b.sender_id = s.id AND b.branch_id = ${request.params.id}
        WHERE s.organization_id = ${actor.organizationId} AND c.kind = 'MESSAGING'
          AND (c.branch_id = ${request.params.id} OR (c.branch_id IS NULL AND b.branch_id IS NOT NULL))
          AND NOT EXISTS(SELECT 1 FROM staff_messaging_sender i WHERE i.sender_id=s.id)
          AND (${request.query.after ?? null}::uuid IS NULL OR s.id > ${request.query.after ?? null}::uuid)
        ORDER BY s.id LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      return { items, nextAfter: rows.length > limit ? items.at(-1)!.id : null };
    });

  app.put<{ Params: { id: string }; Body: { version: number; senderId: string | null } }>(
    '/api/messaging/branches/:id/default-sender', { schema: { params: idParam,
      body: { type: 'object', additionalProperties: false, required: ['version','senderId'],
        properties: { version: { type: 'integer', minimum: 1 }, senderId } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
      requireBranch(actor, request.params.id);
      return db.begin(async (tx) => {
        const branch = (await tx`SELECT sender_version FROM branch WHERE id = ${request.params.id}
          AND organization_id = ${actor.organizationId} FOR UPDATE`)[0];
        if (!branch) throw new HttpError(404, 'BRANCH_NOT_FOUND');
        if (branch.sender_version !== request.body.version) throw new HttpError(409, 'SENDER_DEFAULT_VERSION_CONFLICT');
        if (request.body.senderId) {
          const candidate = await tx`SELECT s.id FROM messaging_sender s
            JOIN integration_connection c ON c.id = s.connection_id
            WHERE s.id = ${request.body.senderId} AND s.organization_id = ${actor.organizationId}
              AND s.active AND s.operator_enabled AND c.status <> 'DISABLED'
              AND s.capabilities->>'text' = 'true' AND c.kind = 'MESSAGING'
              AND (c.branch_id = ${request.params.id} OR (c.branch_id IS NULL AND EXISTS
                (SELECT 1 FROM sender_branch_binding b WHERE b.sender_id = s.id
                  AND b.branch_id = ${request.params.id}))) FOR SHARE OF s`;
          if (!candidate.length) throw new HttpError(400, 'SENDER_NOT_AVAILABLE_FOR_BRANCH');
        }
        const row = (await tx`UPDATE branch SET default_sender_id = ${request.body.senderId},
          sender_version = sender_version + 1, updated_at = now() WHERE id = ${request.params.id}
          RETURNING sender_version, default_sender_id`)[0]!;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id,
          detail) VALUES (${actor.organizationId}, ${request.params.id}, ${actor.id},
            'BRANCH_DEFAULT_SENDER_SET', 'BRANCH', ${request.params.id},
            ${tx.json({ senderId: request.body.senderId })})`;
        return row;
      });
    });

  app.put<{ Params: { id: string }; Body: { version: number; senderId: string | null } }>(
    '/api/messaging/campaigns/:id/sender-override', { schema: { params: idParam,
      body: { type: 'object', additionalProperties: false, required: ['version','senderId'],
        properties: { version: { type: 'integer', minimum: 1 }, senderId } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
      return db.begin(async (tx) => {
        const campaign = (await tx`SELECT id, branch_id, version, status FROM campaign
          WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId}`)[0];
        if (!campaign || (actor.role !== 'SUPER_ADMIN' && campaign.branch_id !== actor.branchId))
          throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
        const locked = (await tx`SELECT version, status FROM campaign WHERE id = ${campaign.id} FOR UPDATE`)[0]!;
        if (locked.version !== request.body.version) throw new HttpError(409, 'CAMPAIGN_VERSION_CONFLICT');
        if (locked.status === 'ACTIVE') throw new HttpError(409, 'CAMPAIGN_ACTIVE');
        if (request.body.senderId) {
          const candidate = await tx`SELECT s.id FROM messaging_sender s
            JOIN integration_connection c ON c.id = s.connection_id
            WHERE s.id = ${request.body.senderId} AND s.organization_id = ${actor.organizationId}
              AND s.active AND s.operator_enabled AND c.status <> 'DISABLED'
              AND s.capabilities->>'text' = 'true' AND c.kind = 'MESSAGING'
              AND (c.branch_id = ${campaign.branch_id} OR (c.branch_id IS NULL AND EXISTS
                (SELECT 1 FROM sender_branch_binding b WHERE b.sender_id = s.id
                  AND b.branch_id = ${campaign.branch_id}))) FOR SHARE OF s`;
          if (!candidate.length) throw new HttpError(400, 'SENDER_NOT_AVAILABLE_FOR_BRANCH');
        }
        const row = (await tx`UPDATE campaign SET sender_override_id = ${request.body.senderId},
          version = version + 1, updated_at = now() WHERE id = ${campaign.id} RETURNING version, sender_override_id`)[0]!;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id,
          detail) VALUES (${actor.organizationId}, ${campaign.branch_id}, ${actor.id},
            'CAMPAIGN_SENDER_OVERRIDE_SET', 'CAMPAIGN', ${campaign.id},
            ${tx.json({ senderId: request.body.senderId })})`;
        return row;
      });
    });
}
