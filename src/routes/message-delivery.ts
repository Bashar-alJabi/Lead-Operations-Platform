import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, type Principal } from '../security.js';
import { messageRecoveryBlock, recoverOutboundMessage, type RecoveryFacts } from '../messaging/message-recovery.js';

const params = { type: 'object', additionalProperties: false, required: ['id', 'messageId'], properties: {
  id: { type: 'string', format: 'uuid' }, messageId: { type: 'string', format: 'uuid' },
} } as const;
const pageQuery = { type: 'object', additionalProperties: false, properties: {
  limit: { type: 'integer', minimum: 1, maximum: 100 },
  before: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' },
} } as const;
type Params = { id: string; messageId: string };
type Query = { limit?: number; before?: string };

async function authorize(tx: postgres.TransactionSql, actor: Principal, ids: Params) {
  // Keep assignment stable until the bounded read finishes; no payload or integration secret is selected.
  const row = (await tx`SELECT cv.controller_type, cv.controller_user_id, cv.state, cv.needs_attention_reason
    FROM conversation_message m JOIN conversation cv ON cv.id = m.conversation_id JOIN lead l ON l.id = cv.lead_id
    WHERE m.id = ${ids.messageId} AND cv.id = ${ids.id} AND l.organization_id = ${actor.organizationId}
      AND (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId})
        OR (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id})) FOR SHARE OF l`)[0];
  if (!row) throw new HttpError(404, 'MESSAGE_NOT_FOUND');
  return row;
}

export function registerMessageDeliveryRoutes(app: FastifyInstance, db: Database): void {
  const path = '/api/conversations/:id/messages/:messageId';
  app.get<{ Params: Params }>(path + '/delivery', { schema: { params } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const cv = await authorize(tx, actor, request.params);
      const row = (await tx`SELECT m.direction, m.author_type, m.author_user_id, m.delivery_state,
          m.provider_message_id, m.delivery_rank, m.sent_at, m.delivery_provider_at, m.last_error_code,
          j.status AS job_status, j.attempts, j.max_attempts, j.run_after, j.locked_until,
          j.last_error_code AS queue_error_code, link.recovery_version,
          EXISTS (SELECT 1 FROM outbound_send_attempt a WHERE a.message_id = m.id
            AND (a.state <> 'REJECTED' OR a.finished_at IS NULL OR a.provider_message_id IS NOT NULL)) AS unsafe_attempt,
          EXISTS (SELECT 1 FROM message_delivery_event e WHERE e.message_id = m.id) AS has_delivery_event
        FROM conversation_message m LEFT JOIN outbound_delivery_job link ON link.message_id = m.id
        LEFT JOIN background_job j ON j.id = link.job_id WHERE m.id = ${request.params.messageId}`)[0]!;
      const block = messageRecoveryBlock(row as RecoveryFacts, actor.id)
        ?? (cv.controller_type !== 'HUMAN' || cv.controller_user_id !== actor.id ? 'HUMAN_CONTROLLER_REQUIRED' : null)
        ?? (cv.state === 'CLOSED' ? 'CONVERSATION_CLOSED' : cv.needs_attention_reason);
      return { deliveryState: row.delivery_state, errorCode: row.last_error_code,
        providerMessageId: row.provider_message_id, sentAt: row.sent_at, providerUpdatedAt: row.delivery_provider_at,
        queue: row.job_status ? { state: row.job_status, attempts: row.attempts, maxAttempts: row.max_attempts,
          availableAt: row.run_after, lockedUntil: row.locked_until, errorCode: row.queue_error_code } : null,
        recoveryVersion: row.recovery_version, canRequestRecovery: block === null, recoveryBlock: block };
    });
  });
  for (const kind of ['attempts', 'delivery-events', 'recoveries'] as const) {
    app.get<{ Params: Params; Querystring: Query }>(path + '/' + kind,
      { schema: { params, querystring: pageQuery } }, async (request) => {
        const actor = await principalFromRequest(request, db);
        return db.begin(async (tx) => {
          await authorize(tx, actor, request.params);
          const limit = request.query.limit ?? 20;
          const before = request.query.before ?? null;
          const rows = kind === 'attempts' ? await tx`SELECT id, attempt_number, state,
              provider_message_id, error_code, started_at, finished_at
            FROM outbound_send_attempt WHERE message_id = ${request.params.messageId}
              AND (${before}::bigint IS NULL OR id < ${before}::bigint) ORDER BY id DESC LIMIT ${limit + 1}`
            : kind === 'delivery-events' ? await tx`SELECT id, status, provider_timestamp, received_at
              FROM message_delivery_event WHERE message_id = ${request.params.messageId}
                AND (${before}::bigint IS NULL OR id < ${before}::bigint) ORDER BY id DESC LIMIT ${limit + 1}`
              : await tx`SELECT r.id, r.recovery_version, r.previous_error_code, r.attempts_before,
                  r.requested_by, u.name AS requester_name, r.reason, r.created_at
                FROM outbound_message_recovery r JOIN user_account u ON u.id = r.requested_by
                WHERE r.message_id = ${request.params.messageId}
                  AND (${before}::bigint IS NULL OR r.id < ${before}::bigint) ORDER BY r.id DESC LIMIT ${limit + 1}`;
          const items = rows.slice(0, limit);
          return { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null };
        });
      });
  }
  app.post<{ Params: Params; Body: { version: number; reason: string } }>(path + '/retry', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { params, body: { type: 'object', additionalProperties: false, required: ['version', 'reason'], properties: {
      version: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 10, maxLength: 500 },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    const result = await recoverOutboundMessage(db, { actor, conversationId: request.params.id,
      messageId: request.params.messageId, ...request.body });
    reply.code(202); return result;
  });
}
