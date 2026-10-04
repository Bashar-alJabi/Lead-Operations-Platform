import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest } from '../security.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { enqueueOutboundMessage } from '../messaging/outbound.js';
import { bodyParameterCount } from '../messaging/approved-template.js';

const idParam = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;

export function registerConversationMessageRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: number; cursor?: string } }>(
    '/api/conversations/:id/messages', { schema: { params: idParam, querystring: {
      type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', maxLength: 256 },
      },
    } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      const authorized = await db`SELECT 1 FROM conversation cv JOIN lead l ON l.id = cv.lead_id
        WHERE cv.id = ${request.params.id} AND l.organization_id = ${actor.organizationId}
          AND (${actor.role === 'SUPER_ADMIN'} OR
            (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
            (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))`;
      if (!authorized.length) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
      const limit = request.query.limit ?? 50;
      const cursor = decodeCursor(request.query.cursor);
      const rows = await db`SELECT m.id, m.direction, m.author_type, m.author_user_id, m.body,
          m.message_kind, m.template_id,
          CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id', a.id, 'state', a.state,
            'mediaKind', a.media_kind, 'mime', coalesce(a.mime_type, a.declared_mime), 'sizeBytes', a.size_bytes,
            'errorCode', a.last_error_code, 'version', a.version) END AS attachment,
          m.delivery_state, m.last_error_code, m.created_at, m.sent_at, m.received_at
        FROM conversation_message m JOIN conversation cv ON cv.id = m.conversation_id
        LEFT JOIN message_attachment a ON a.id = m.attachment_id
        JOIN lead l ON l.id = cv.lead_id
        WHERE cv.id = ${request.params.id} AND l.organization_id = ${actor.organizationId}
          AND (${actor.role === 'SUPER_ADMIN'} OR
            (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
            (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR
            (m.created_at, m.id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ?
        encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
    });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; after?: string } }>(
    '/api/conversations/:id/available-templates', { schema: { params: idParam, querystring: {
      type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        after: { type: 'string', format: 'uuid' },
      },
    } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      const authorized = (await db`SELECT cv.connection_id, l.campaign_id FROM conversation cv
        JOIN lead l ON l.id = cv.lead_id WHERE cv.id = ${request.params.id}
          AND l.organization_id = ${actor.organizationId}
          AND (${actor.role === 'SUPER_ADMIN'} OR
            (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
            (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))`)[0];
      if (!authorized) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
      const limit = request.query.limit ?? 50;
      const rows = await db`SELECT id, name, language, category,
          components->0->>'text' AS body
        FROM provider_message_template WHERE connection_id = ${authorized.connection_id}
          AND active AND status = 'APPROVED' AND jsonb_array_length(components) = 1
          AND EXISTS (SELECT 1 FROM campaign_message_template_binding b
            WHERE b.template_id = provider_message_template.id
              AND b.campaign_id = ${authorized.campaign_id} AND b.active)
          AND components->0->>'type' = 'BODY'
          AND length(components->0->>'text') BETWEEN 1 AND 1024
          AND (${request.query.after ?? null}::uuid IS NULL OR id > ${request.query.after ?? null}::uuid)
        ORDER BY id LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      const items = page.flatMap((row) => {
        const parameterCount = bodyParameterCount(row.body);
        return parameterCount === null ? [] : [{ ...row, parameterCount }];
      });
      return { items, nextAfter: rows.length > limit ? page.at(-1)!.id : null };
    });

  app.post<{ Params: { id: string }; Body: { body?: string; templateId?: string;
    templateParameters?: string[]; idempotencyKey: string } }>(
    '/api/conversations/:id/messages', { schema: { params: idParam, body: {
      type: 'object', additionalProperties: false, required: ['idempotencyKey'], properties: {
        body: { type: 'string', minLength: 1, maxLength: 20000 },
        templateId: { type: 'string', format: 'uuid' },
        templateParameters: { type: 'array', maxItems: 10, items: {
          type: 'string', minLength: 1, maxLength: 512 } },
        idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,128}$' },
      },
    } } }, async (request, reply) => {
      const actor = await principalFromRequest(request, db);
      const result = await enqueueOutboundMessage(db, { actor, conversationId: request.params.id,
        author: 'HUMAN', body: request.body.body, templateId: request.body.templateId,
        templateParameters: request.body.templateParameters,
        idempotencyKey: request.body.idempotencyKey });
      reply.code(result.existing ? 200 : 202);
      return result;
    });
}
