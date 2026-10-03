import type { Database } from '../db.js';
import { HttpError, type Principal } from '../security.js';
import { evaluateSend, type SendAuthor } from './policy.js';
import { resolveConfiguredSender } from './sender-resolution.js';

export type OutboundRequest = { actor: Principal; conversationId: string; author: SendAuthor;
  body: string; idempotencyKey: string };

// Every caller, including future AI and automation tools, must enter here with an authorized principal.
export async function enqueueOutboundMessage(db: Database, input: OutboundRequest): Promise<{
  id: string; deliveryState: string; existing: boolean;
}> {
  if (!input.body.trim()) throw new HttpError(400, 'MESSAGE_BODY_REQUIRED');
  const outcome = await db.begin(async (tx) => {
    const scope = (await tx`SELECT l.id AS lead_id, l.organization_id, l.branch_id, l.campaign_id,
        l.contact_id, l.assigned_agent_id, l.lifecycle, ct.phone_normalized,
        b.active AS branch_active, b.timezone, b.messaging_window,
        ca.status AS campaign_status, ca.messaging_config, ca.messaging_policy
      FROM conversation cv JOIN lead l ON l.id = cv.lead_id
      JOIN contact ct ON ct.id = l.contact_id JOIN branch b ON b.id = l.branch_id
      JOIN campaign ca ON ca.id = l.campaign_id
      WHERE cv.id = ${input.conversationId} AND l.organization_id = ${input.actor.organizationId}
        AND (${input.actor.role === 'SUPER_ADMIN'} OR
          (${input.actor.role === 'MANAGER'} AND l.branch_id = ${input.actor.branchId}) OR
          (${input.actor.role === 'AGENT'} AND l.assigned_agent_id = ${input.actor.id}))
      FOR UPDATE OF l`)[0];
    if (!scope) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
    await tx`SELECT id FROM contact WHERE id = ${scope.contact_id} FOR SHARE`;
    const conversation = (await tx`SELECT id, lead_id, connection_id, sender_id, channel,
        participant_ref, controller_type, controller_user_id, state, needs_attention_reason
      FROM conversation WHERE id = ${input.conversationId} FOR UPDATE`)[0]!;
    const prior = (await tx`SELECT id, body, author_type, author_user_id, delivery_state
      FROM conversation_message WHERE conversation_id = ${conversation.id}
        AND idempotency_key = ${input.idempotencyKey}`)[0];
    if (prior) {
      if (prior.body !== input.body || prior.author_type !== input.author ||
          prior.author_user_id !== (input.author === 'HUMAN' ? input.actor.id : null))
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
      return { id: prior.id as string, deliveryState: prior.delivery_state as string, existing: true };
    }
    if (!scope.branch_active || scope.campaign_status !== 'ACTIVE' || scope.messaging_config?.enabled !== true)
      throw new HttpError(409, 'MESSAGING_NOT_ACTIVE');
    if (scope.lifecycle !== 'OPEN') throw new HttpError(409, 'LEAD_NOT_OPEN');
    if (conversation.channel !== 'WHATSAPP') throw new HttpError(409, 'CHANNEL_NOT_SUPPORTED');
    if (conversation.state === 'CLOSED') throw new HttpError(409, 'CONVERSATION_CLOSED');
    if (conversation.needs_attention_reason) throw new HttpError(409, conversation.needs_attention_reason);
    if (!scope.phone_normalized || scope.phone_normalized !== conversation.participant_ref) {
      await tx`UPDATE conversation SET needs_attention_reason = 'PARTICIPANT_CHANGED' WHERE id = ${conversation.id}`;
      return { blocked: 'PARTICIPANT_CHANGED' } as const;
    }
    const resolved = await resolveConfiguredSender(tx, { organizationId: scope.organization_id,
      branchId: scope.branch_id, campaignId: scope.campaign_id, pinnedSenderId: conversation.sender_id });
    if (!resolved.sender) {
      await tx`UPDATE conversation SET needs_attention_reason = ${resolved.reason} WHERE id = ${conversation.id}`;
      return { blocked: resolved.reason } as const;
    }
    if (resolved.sender.connectionId !== conversation.connection_id) {
      await tx`UPDATE conversation SET needs_attention_reason = 'CONNECTION_SENDER_MISMATCH' WHERE id = ${conversation.id}`;
      return { blocked: 'CONNECTION_SENDER_MISMATCH' } as const;
    }
    const consent = (await tx`SELECT status, do_not_contact FROM messaging_consent
      WHERE contact_id = ${scope.contact_id} AND channel = 'WHATSAPP'`)[0];
    const connection = (await tx`SELECT provider FROM integration_connection
      WHERE id = ${conversation.connection_id}`)[0]!;
    const latestInbound = (await tx`SELECT received_at FROM conversation_message
      WHERE conversation_id = ${conversation.id} AND direction = 'INBOUND'
      ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 1`)[0]?.received_at as Date | null | undefined;
    // Meta permits freeform replies only in the customer service window. Template sending has its own path.
    const now = new Date();
    const inboundAge = latestInbound ? now.getTime() - latestInbound.getTime() : null;
    const withinMetaServiceWindow = inboundAge !== null && inboundAge >= 0 && inboundAge < 24 * 60 * 60 * 1000;
    const policy = scope.messaging_policy || {};
    const proactive = input.author !== 'HUMAN';
    const attempt = proactive ? (await tx`SELECT count(*)::integer AS attempts, max(m.created_at) AS last_sent_at
      FROM conversation_message m JOIN conversation c ON c.id = m.conversation_id
      WHERE c.lead_id = ${scope.lead_id} AND m.direction = 'OUTBOUND'
        AND m.author_type IN ('AI','AUTOMATION','FOLLOW_UP')`)[0] : null;
    const decision = evaluateSend({ author: input.author, actorUserId: input.actor.id,
      controllerType: conversation.controller_type, controllerUserId: conversation.controller_user_id,
      conversationState: conversation.state, consentStatus: consent?.status ?? 'UNKNOWN',
      doNotContact: consent?.do_not_contact ?? false, consentRequired: true,
      sender: { ...resolved.sender, requiresTemplate: resolved.sender.requiresTemplate ||
        (connection.provider === 'META_WHATSAPP_CLOUD' && !withinMetaServiceWindow) },
      timezone: scope.timezone, sendingWindow: policy.sendingWindow ??
        (scope.messaging_window?.start ? scope.messaging_window : null),
      attempts: attempt?.attempts ?? 0, maxAttempts: proactive ? policy.maxAttempts : null,
      lastSentAt: attempt?.last_sent_at ?? null,
      minIntervalSeconds: proactive ? policy.minIntervalSeconds : null, now });
    if (!decision.allowed) throw new HttpError(409, decision.reason ?? 'MESSAGE_BLOCKED');
    const message = (await tx`INSERT INTO conversation_message (conversation_id, connection_id,
        sender_id, direction, author_type, author_user_id, body, delivery_state, idempotency_key)
      VALUES (${conversation.id}, ${conversation.connection_id}, ${conversation.sender_id},
        'OUTBOUND', ${input.author}, ${input.author === 'HUMAN' ? input.actor.id : null},
        ${input.body}, 'QUEUED', ${input.idempotencyKey}) RETURNING id`)[0]!;
    const job = (await tx`INSERT INTO background_job (queue, kind, payload, idempotency_key)
      VALUES ('messaging', 'SEND_MESSAGE', ${tx.json({ messageId: message.id })}, ${message.id})
      RETURNING id`)[0]!;
    await tx`INSERT INTO outbound_delivery_job (message_id, job_id) VALUES (${message.id}, ${job.id})`;
    await tx`UPDATE conversation SET last_message_at = now() WHERE id = ${conversation.id}`;
    await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
        target_type, target_id, detail) VALUES (${input.actor.organizationId}, ${scope.branch_id},
        ${input.actor.id}, 'OUTBOUND_MESSAGE_QUEUED', 'MESSAGE', ${message.id},
        ${tx.json({ conversationId: conversation.id, author: input.author })})`;
    return { id: message.id as string, deliveryState: 'QUEUED', existing: false };
  });
  if ('blocked' in outcome && typeof outcome.blocked === 'string') throw new HttpError(409, outcome.blocked);
  return outcome;
}
