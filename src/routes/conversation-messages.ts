import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest } from '../security.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { enqueueOutboundMessage } from '../messaging/outbound.js';

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
          m.delivery_state, m.last_error_code, m.created_at, m.sent_at, m.received_at
        FROM conversation_message m JOIN conversation cv ON cv.id = m.conversation_id
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

  app.post<{ Params: { id: string }; Body: { body: string; idempotencyKey: string } }>(
    '/api/conversations/:id/messages', { schema: { params: idParam, body: {
      type: 'object', additionalProperties: false, required: ['body','idempotencyKey'], properties: {
        body: { type: 'string', minLength: 1, maxLength: 20000 },
        idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,128}$' },
      },
    } } }, async (request, reply) => {
      const actor = await principalFromRequest(request, db);
      const result = await enqueueOutboundMessage(db, { actor, conversationId: request.params.id,
        author: 'HUMAN', body: request.body.body, idempotencyKey: request.body.idempotencyKey });
      reply.code(result.existing ? 200 : 202);
      return result;
    });
}
