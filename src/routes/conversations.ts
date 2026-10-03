import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireLead } from '../security.js';
import { resolveConfiguredSender } from '../messaging/sender-resolution.js';
import { decodeCursor, encodeCursor } from '../pagination.js';

const idParam = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;

export function registerConversationRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Params: { id: string } }>('/api/leads/:id/conversations', {
    schema: { params: idParam },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    const result = await db.begin(async (tx) => {
      const lead = (await tx`SELECT l.id, l.branch_id, l.campaign_id, l.lifecycle, l.assigned_agent_id,
          c.phone_normalized FROM lead l JOIN contact c ON c.id = l.contact_id
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
        if (current.needs_attention_reason) await tx`UPDATE conversation SET needs_attention_reason = NULL WHERE id = ${current.id}`;
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
      const rows = await db`SELECT c.id, c.sender_id, s.display_name AS sender_name, c.connection_id,
          c.channel, c.participant_ref, c.controller_type, c.controller_user_id,
          u.name AS controller_name, c.state, c.needs_attention_reason, c.started_at, c.last_message_at
        FROM conversation c JOIN lead l ON l.id = c.lead_id
        JOIN messaging_sender s ON s.id = c.sender_id LEFT JOIN user_account u ON u.id = c.controller_user_id
        WHERE c.lead_id = ${request.params.id} AND l.organization_id = ${actor.organizationId}
          AND (${actor.role === 'SUPER_ADMIN'} OR
            (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
            (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR
            (c.started_at, c.id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY c.started_at DESC, c.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ?
        encodeCursor({ timestamp: last.started_at.toISOString(), id: last.id }) : null };
    });

  app.get<{ Params: { id: string } }>('/api/conversations/:id', {
    schema: { params: idParam },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const conversation = (await db`SELECT c.id, c.lead_id, c.sender_id, s.display_name AS sender_name,
        c.connection_id, c.channel, c.participant_ref, c.controller_type, c.controller_user_id,
        u.name AS controller_name, c.state, c.needs_attention_reason,
        c.started_at, c.last_message_at FROM conversation c JOIN lead l ON l.id = c.lead_id
        JOIN messaging_sender s ON s.id = c.sender_id LEFT JOIN user_account u ON u.id = c.controller_user_id
      WHERE c.id = ${request.params.id} AND l.organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR
          (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
          (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))`)[0];
    if (!conversation) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
    return { conversation };
  });
}
