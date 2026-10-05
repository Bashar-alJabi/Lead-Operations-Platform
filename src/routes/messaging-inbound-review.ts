import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireRole, type Principal } from '../security.js';
import { activeConversations, candidateLeads, hasSourceReferenceContext, processInboundEvent } from '../messaging/inbound-events.js';
import { parseMetaSourceReference, type SourceReference } from '../messaging/source-reference.js';
import { publicAttachment } from './messaging-attachments.js';

const connectionParams = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
const eventParams = { type: 'object', additionalProperties: false, required: ['id','eventId'],
  properties: { id: { type: 'string', format: 'uuid' }, eventId: { type: 'string', format: 'uuid' } } } as const;

async function managedConnection(db: Database, actor: Principal, id: string) {
  requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  const connection = (await db`SELECT id, branch_id FROM integration_connection
    WHERE id = ${id} AND organization_id = ${actor.organizationId} AND kind = 'MESSAGING'
      AND provider = 'META_WHATSAPP_CLOUD'
      AND (${actor.role === 'SUPER_ADMIN'} OR branch_id = ${actor.branchId})`)[0];
  if (!connection) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND');
  return connection;
}

export function registerMessagingInboundReviewRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: number; before?: string } }>(
    '/api/messaging/connections/:id/inbound-review', { schema: { params: connectionParams,
      querystring: { type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        before: { type: 'string', format: 'uuid' },
      } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      const connection = await managedConnection(db, actor, request.params.id);
      const limit = request.query.limit ?? 30;
      const rows = await db`SELECT e.id, e.sender_id, e.failure_code, e.received_at,
          right(e.participant_ref, 4) AS participant_last4
        FROM integration_event e WHERE e.connection_id = ${connection.id}
          AND e.event_kind = 'INBOUND_MESSAGE' AND e.state = 'NEEDS_ATTENTION'
          AND (${request.query.before ?? null}::uuid IS NULL OR (e.received_at, e.id) <
            (SELECT received_at, id FROM integration_event WHERE id = ${request.query.before ?? null}::uuid
              AND connection_id = ${connection.id}))
        ORDER BY e.received_at DESC, e.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      return { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null };
    });

  app.get<{ Params: { id: string; eventId: string } }>(
    '/api/messaging/connections/:id/inbound-review/:eventId', { schema: { params: eventParams } },
    async (request) => {
      const actor = await principalFromRequest(request, db);
      const connection = await managedConnection(db, actor, request.params.id);
      return db.begin(async (tx) => {
        const event = (await tx`SELECT id, connection_id, sender_id, participant_ref, payload,
            state, failure_code, review_note, lead_id, conversation_id, received_at
          FROM integration_event WHERE id = ${request.params.eventId}
            AND connection_id = ${connection.id} AND event_kind = 'INBOUND_MESSAGE'`)[0];
        if (!event) throw new HttpError(404, 'INBOUND_EVENT_NOT_FOUND');
        const message = event.payload?.message;
        let sourceReference: SourceReference|null=null;let sourceReferenceInvalid=false;
        try { if (message) sourceReference=parseMetaSourceReference(message); } catch { sourceReferenceInvalid=true; }
        const knownReference=await hasSourceReferenceContext(tx,connection.id,sourceReference);
        const attachment = (await tx`SELECT * FROM message_attachment WHERE integration_event_id = ${event.id}`)[0];
        const text = message?.type === 'text' && typeof message?.text?.body === 'string'
          ? message.text.body as string : message?.type==='button' && typeof message?.button?.text==='string'
            ? String(message.button.text).slice(0,25) : typeof message?.[message?.type]?.caption === 'string'
            ? message[message.type].caption as string : null;
        const leads = (await candidateLeads(tx, { sender_id: event.sender_id,
          participant_ref: event.participant_ref },knownReference ? sourceReference : null)).filter((lead) =>
          actor.role === 'SUPER_ADMIN' || lead.branch_id === actor.branchId);
        const conversations = (await activeConversations(tx,{ sender_id:event.sender_id,connection_id:connection.id,
          participant_ref:event.participant_ref },knownReference ? sourceReference : null))
          .filter((cv)=>actor.role==='SUPER_ADMIN' || cv.branch_id===actor.branchId);
        return { event: { id: event.id, state: event.state, failureCode: event.failure_code,
          reviewNote: event.review_note, senderId: event.sender_id,
          participantLast4: String(event.participant_ref).slice(-4),
          messageType: message?.type ?? null, body: text, attachment: attachment ? publicAttachment(attachment) : null,
          sourceReference,sourceReferenceInvalid,
          receivedAt: event.received_at,
          leadId: event.lead_id, conversationId: event.conversation_id },
          leads: leads.map((lead) => ({ id: lead.id, branchId: lead.branch_id,
            campaignName: lead.campaign_name, branchName: lead.branch_name,
            contactName: lead.contact_name })),
          conversations: conversations.map((cv) => ({ id: cv.id, leadId: cv.lead_id,
            state: cv.state,contactName:cv.contact_name,campaignName:cv.campaign_name,branchName:cv.branch_name })) };
      });
    });

  app.post<{ Params: { id: string; eventId: string }; Body: { leadId?: string; conversationId?: string } }>(
    '/api/messaging/connections/:id/inbound-review/:eventId/resolve', { schema: { params: eventParams,
      body: { type: 'object', additionalProperties: false, properties: {
        leadId: { type: 'string', format: 'uuid' }, conversationId: { type: 'string', format: 'uuid' },
      } } } }, async (request, reply) => {
      const actor = await principalFromRequest(request, db);
      await managedConnection(db, actor, request.params.id);
      if (Boolean(request.body.leadId) === Boolean(request.body.conversationId))
        throw new HttpError(400, 'INBOUND_TARGET_REQUIRED');
      const result = await db.begin(async (tx) => {
        const event = (await tx`SELECT id FROM integration_event WHERE id = ${request.params.eventId}
          AND connection_id = ${request.params.id} AND event_kind = 'INBOUND_MESSAGE'`)[0];
        if (!event) throw new HttpError(404, 'INBOUND_EVENT_NOT_FOUND');
        return processInboundEvent(tx, event.id, { actor,
          leadId: request.body.leadId, conversationId: request.body.conversationId });
      });
      if (result.state !== 'PROCESSED') reply.code(409);
      return result;
    });

  app.post<{ Params: { id: string; eventId: string }; Body: { reason: string } }>(
    '/api/messaging/connections/:id/inbound-review/:eventId/ignore', { schema: { params: eventParams,
      body: { type: 'object', additionalProperties: false, required: ['reason'], properties: {
        reason: { type: 'string', minLength: 3, maxLength: 500 },
      } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      const connection = await managedConnection(db, actor, request.params.id);
      if (!request.body.reason.trim()) throw new HttpError(400, 'REVIEW_REASON_REQUIRED');
      return db.begin(async (tx) => {
        const event = (await tx`SELECT id, state, review_note FROM integration_event
          WHERE id = ${request.params.eventId} AND connection_id = ${connection.id}
            AND event_kind = 'INBOUND_MESSAGE' FOR UPDATE`)[0];
        if (!event) throw new HttpError(404, 'INBOUND_EVENT_NOT_FOUND');
        if (event.state === 'IGNORED' && event.review_note === request.body.reason.trim())
          return { state: 'IGNORED', existing: true };
        if (event.state !== 'NEEDS_ATTENTION') throw new HttpError(409, 'INBOUND_ALREADY_RESOLVED');
        await tx`UPDATE integration_event SET state = 'IGNORED', failure_code = 'MANUALLY_IGNORED',
          review_note = ${request.body.reason.trim()}, resolved_by = ${actor.id}, resolved_at = now()
          WHERE id = ${event.id}`;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
          target_type, target_id, detail) VALUES (${actor.organizationId}, ${connection.branch_id},
            ${actor.id}, 'INBOUND_EVENT_IGNORED', 'INTEGRATION_EVENT', ${event.id},
            ${tx.json({ reason: request.body.reason.trim() })})`;
        return { state: 'IGNORED', existing: false };
      });
    });
}
