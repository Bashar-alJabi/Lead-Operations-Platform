import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireLead, requireRole } from '../security.js';
import { resolveConfiguredSender } from '../messaging/sender-resolution.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { metaMediaCapabilities } from '../media/meta-outbound.js';

function withMediaRules(row:Record<string,unknown>) {
  const { sender_provider,...conversation }=row;
  if (sender_provider!=='META_WHATSAPP_CLOUD') return conversation;
  const capabilities=row.sender_capabilities as { media?:string[] };
  const profile=metaMediaCapabilities();
  return { ...conversation,sender_capabilities:{ ...capabilities,mediaProfile:profile.mediaProfile,
    mediaRules:Object.fromEntries(Object.entries(profile.mediaRules).filter(([kind])=>capabilities.media?.includes(kind))) } };
}

const idParam = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;

function recheckableAttention(reason: string | null): boolean {
  return Boolean(reason?.startsWith('PINNED_') || reason === 'PARTICIPANT_CHANGED'
    || reason === 'CONNECTION_SENDER_MISMATCH');
}

export function registerConversationRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Params: { id: string } }>('/api/leads/:id/conversations', {
    schema: { params: idParam },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    const result = await db.begin(async (tx) => {
      const lead = (await tx`SELECT l.id, l.branch_id, l.campaign_id, l.lifecycle, l.assigned_agent_id,
          c.phone_normalized FROM lead l LEFT JOIN contact c ON c.id = l.contact_id
        WHERE l.id = ${request.params.id} AND l.organization_id = ${actor.organizationId}
          AND (${actor.role === 'SUPER_ADMIN'} OR
            (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
            (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id})) FOR UPDATE OF l`)[0];
      if (!lead) throw new HttpError(404, 'LEAD_NOT_FOUND');
      if (lead.lifecycle !== 'OPEN') throw new HttpError(409, 'LEAD_NOT_OPEN');
      if (!lead.phone_normalized || !/^\+[1-9]\d{7,14}$/.test(lead.phone_normalized))
        throw new HttpError(409, 'CONTACT_PHONE_REQUIRED');
      const prior = await tx`SELECT id, sender_id, connection_id, participant_ref, state, needs_attention_reason
        FROM conversation WHERE lead_id = ${lead.id} AND channel = 'WHATSAPP' AND state <> 'CLOSED'
        ORDER BY started_at DESC, id DESC LIMIT 2`;
      if (prior.length > 1) {
        await tx`UPDATE conversation SET needs_attention_reason = 'AMBIGUOUS_ACTIVE_CONVERSATIONS'
          WHERE lead_id = ${lead.id} AND channel = 'WHATSAPP' AND state <> 'CLOSED'`;
        return { blocked: 'AMBIGUOUS_ACTIVE_CONVERSATIONS' } as const;
      }
      const current = prior[0];
      if (current?.needs_attention_reason && !recheckableAttention(current.needs_attention_reason))
        return { id: current.id, senderId: current.sender_id, connectionId: current.connection_id,
          state: current.state, existing: true } as const;
      if (current && current.participant_ref !== lead.phone_normalized) {
        await tx`UPDATE conversation SET needs_attention_reason = 'PARTICIPANT_CHANGED' WHERE id = ${current.id}`;
        return { blocked: 'PARTICIPANT_CHANGED' } as const;
      }
      const selection = await resolveConfiguredSender(tx, { organizationId: actor.organizationId,
        branchId: lead.branch_id, campaignId: lead.campaign_id, pinnedSenderId: current?.sender_id });
      if (!selection.sender) {
        if (current) await tx`UPDATE conversation SET needs_attention_reason = ${selection.reason} WHERE id = ${current.id}`;
        return { blocked: selection.reason } as const;
      }
      if (current && current.connection_id !== selection.sender.connectionId) {
        await tx`UPDATE conversation SET needs_attention_reason = 'CONNECTION_SENDER_MISMATCH' WHERE id = ${current.id}`;
        return { blocked: 'CONNECTION_SENDER_MISMATCH' } as const;
      }
      if (current) {
        if (recheckableAttention(current.needs_attention_reason))
          await tx`UPDATE conversation SET needs_attention_reason = NULL WHERE id = ${current.id}`;
        return { id: current.id, senderId: current.sender_id, connectionId: current.connection_id,
          state: current.state, existing: true } as const;
      }
      const created = (await tx`INSERT INTO conversation (lead_id, connection_id, sender_id, channel,
          participant_ref, controller_type, controller_user_id, state)
        VALUES (${lead.id}, ${selection.sender.connectionId}, ${selection.sender.id}, 'WHATSAPP',
          ${lead.phone_normalized}, 'HUMAN', ${actor.id}, 'HUMAN_ACTIVE') RETURNING id`)[0]!;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id,
        detail) VALUES (${actor.organizationId}, ${lead.branch_id}, ${actor.id}, 'CONVERSATION_OPENED',
          'CONVERSATION', ${created.id}, ${tx.json({ leadId: lead.id, senderId: selection.sender.id })})`;
      return { id: created.id, senderId: selection.sender.id, connectionId: selection.sender.connectionId,
        state: 'HUMAN_ACTIVE', existing: false } as const;
    });
    if (typeof result.blocked === 'string') throw new HttpError(409, result.blocked);
    reply.code(result.existing ? 200 : 201);
    return result;
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; cursor?: string } }>(
    '/api/leads/:id/conversations', { schema: { params: idParam, querystring: { type: 'object',
      additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', maxLength: 256 } } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      await requireLead(db, actor, request.params.id);
      const limit = request.query.limit ?? 30;
      const cursor = decodeCursor(request.query.cursor);
      const rows = await db`SELECT c.id, c.sender_id, s.display_name AS sender_name,
          s.capabilities AS sender_capabilities, ic.provider AS sender_provider, c.connection_id,
          c.channel, c.participant_ref, c.controller_type, c.controller_user_id, c.version,
          u.name AS controller_name, c.state, c.needs_attention_reason, c.started_at, c.last_message_at
        FROM conversation c JOIN lead l ON l.id = c.lead_id
        JOIN messaging_sender s ON s.id = c.sender_id JOIN integration_connection ic ON ic.id = c.connection_id
        LEFT JOIN user_account u ON u.id = c.controller_user_id
        WHERE c.lead_id = ${request.params.id} AND l.organization_id = ${actor.organizationId}
          AND (${actor.role === 'SUPER_ADMIN'} OR
            (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
            (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR
            (c.started_at, c.id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY c.started_at DESC, c.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items:items.map(withMediaRules), nextCursor: rows.length > limit && last ?
        encodeCursor({ timestamp: last.started_at.toISOString(), id: last.id }) : null };
    });

  app.get<{ Params: { id: string } }>('/api/conversations/:id', {
    schema: { params: idParam },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const conversation = (await db`SELECT c.id, c.lead_id, c.sender_id, s.display_name AS sender_name,
        s.capabilities AS sender_capabilities, ic.provider AS sender_provider,
        c.connection_id, c.channel, c.participant_ref, c.controller_type, c.controller_user_id, c.version,
        u.name AS controller_name, c.state, c.needs_attention_reason,
        c.started_at, c.last_message_at FROM conversation c JOIN lead l ON l.id = c.lead_id
        JOIN messaging_sender s ON s.id = c.sender_id JOIN integration_connection ic ON ic.id = c.connection_id
        LEFT JOIN user_account u ON u.id = c.controller_user_id
      WHERE c.id = ${request.params.id} AND l.organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR
          (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
          (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))`)[0];
    if (!conversation) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
    return { conversation:withMediaRules(conversation) };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; before?: string } }>(
    '/api/conversations/:id/attention-reviews', { schema: { params: idParam,
      querystring: { type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        before: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
      } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
      const authorized = await db`SELECT 1 FROM conversation cv JOIN lead l ON l.id = cv.lead_id
        WHERE cv.id = ${request.params.id} AND l.organization_id = ${actor.organizationId}
          AND (${actor.role === 'SUPER_ADMIN'} OR l.branch_id = ${actor.branchId})`;
      if (!authorized.length) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
      const limit = request.query.limit ?? 30;
      const rows = await db`SELECT r.id, r.previous_reason, r.review_note,
          r.reviewed_by, u.name AS reviewer_name, r.created_at
        FROM conversation_attention_review r JOIN user_account u ON u.id = r.reviewed_by
        WHERE r.conversation_id = ${request.params.id}
          AND (${request.query.before ?? null}::bigint IS NULL OR r.id < ${request.query.before ?? null}::bigint)
        ORDER BY r.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      return { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null };
    });

  app.post<{ Params: { id: string }; Body: { version: number; expectedReason: string;
    reviewNote: string; reviewConfirmed: true } }>(
    '/api/conversations/:id/attention/acknowledge', { schema: { params: idParam,
      body: { type: 'object', additionalProperties: false,
        required: ['version','expectedReason','reviewNote','reviewConfirmed'], properties: {
          version: { type: 'integer', minimum: 1 },
          expectedReason: { type: 'string', enum: ['SEND_OUTCOME_UNKNOWN','DELIVERY_FAILED','TEMPLATE_CHANGED'] },
          reviewNote: { type: 'string', minLength: 10, maxLength: 2000 },
          reviewConfirmed: { type: 'boolean', const: true },
        } },
    } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
      if (request.body.reviewNote.trim().length < 10) throw new HttpError(400, 'REVIEW_NOTE_REQUIRED');
      return db.begin(async (tx) => {
        const lead = (await tx`SELECT l.id, l.branch_id FROM conversation cv
          JOIN lead l ON l.id = cv.lead_id WHERE cv.id = ${request.params.id}
            AND l.organization_id = ${actor.organizationId}
            AND (${actor.role === 'SUPER_ADMIN'} OR l.branch_id = ${actor.branchId})
          FOR UPDATE OF l`)[0];
        if (!lead) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
        const current = (await tx`SELECT version, state, needs_attention_reason FROM conversation
          WHERE id = ${request.params.id} FOR UPDATE`)[0]!;
        if (current.version !== request.body.version) throw new HttpError(409, 'CONVERSATION_VERSION_CONFLICT');
        if (current.state === 'CLOSED') throw new HttpError(409, 'CONVERSATION_CLOSED');
        if (current.needs_attention_reason !== request.body.expectedReason)
          throw new HttpError(409, 'ATTENTION_REASON_CHANGED');
        const reviewed = (await tx`INSERT INTO conversation_attention_review
          (conversation_id, previous_reason, review_note, reviewed_by)
          VALUES (${request.params.id}, ${request.body.expectedReason},
            ${request.body.reviewNote.trim()}, ${actor.id}) RETURNING id`)[0]!;
        const changed = (await tx`UPDATE conversation SET needs_attention_reason = NULL,
          version = version + 1 WHERE id = ${request.params.id} RETURNING version`)[0]!;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
          target_type, target_id, detail) VALUES (${actor.organizationId}, ${lead.branch_id},
            ${actor.id}, 'CONVERSATION_ATTENTION_REVIEWED', 'CONVERSATION', ${request.params.id},
            ${tx.json({ reviewId: reviewed.id, previousReason: request.body.expectedReason })})`;
        return { version: changed.version, reviewId: reviewed.id,
          acknowledgedReason: request.body.expectedReason };
      });
    });

  app.post<{ Params: { id: string }; Body: { version: number; reason: string } }>(
    '/api/conversations/:id/takeover', { schema: { params: idParam, body: {
      type: 'object', additionalProperties: false, required: ['version','reason'], properties: {
        version: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 3, maxLength: 500 },
      },
    } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      if (!request.body.reason.trim()) throw new HttpError(400, 'TAKEOVER_REASON_REQUIRED');
      return db.begin(async (tx) => {
        const lead = (await tx`SELECT l.id, l.branch_id FROM conversation cv
          JOIN lead l ON l.id = cv.lead_id WHERE cv.id = ${request.params.id}
            AND l.organization_id = ${actor.organizationId}
            AND (${actor.role === 'SUPER_ADMIN'} OR
              (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
              (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))
          FOR UPDATE OF l`)[0];
        if (!lead) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
        const cv = (await tx`SELECT id, state, version, controller_type, controller_user_id,
            needs_attention_reason FROM conversation WHERE id = ${request.params.id} FOR UPDATE`)[0]!;
        if (cv.state === 'CLOSED') throw new HttpError(409, 'CONVERSATION_CLOSED');
        if (cv.version !== request.body.version) throw new HttpError(409, 'CONVERSATION_VERSION_CONFLICT');
        if (cv.controller_type === 'HUMAN' && cv.controller_user_id === actor.id
          && cv.state === 'HUMAN_ACTIVE') return { state: cv.state, version: cv.version, existing: true };
        const attention = ['NO_HUMAN_CONTROLLER','AI_PROCESSING_NOT_READY','AI_CUSTOMER_CONTEXT_TOO_LARGE','AI_QUEUE_BACKPRESSURE'].includes(cv.needs_attention_reason)
          ? null : cv.needs_attention_reason;
        const changed = (await tx`UPDATE conversation SET controller_type = 'HUMAN',
          controller_user_id = ${actor.id}, state = 'HUMAN_ACTIVE',
          needs_attention_reason = ${attention}, version = version + 1
          WHERE id = ${cv.id} RETURNING version`)[0]!;
        await tx`INSERT INTO conversation_handoff (conversation_id, from_controller, from_user_id,
          to_controller, to_user_id, reason, requested_by)
          VALUES (${cv.id}, ${cv.controller_type}, ${cv.controller_user_id}, 'HUMAN', ${actor.id},
            ${request.body.reason.trim()}, ${actor.id})`;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
          target_type, target_id, detail) VALUES (${actor.organizationId}, ${lead.branch_id}, ${actor.id},
            'CONVERSATION_TAKEN_OVER', 'CONVERSATION', ${cv.id},
            ${tx.json({ previousController: cv.controller_type, reason: request.body.reason.trim() })})`;
        return { state: 'HUMAN_ACTIVE', version: changed.version, existing: false };
      });
    });
}
