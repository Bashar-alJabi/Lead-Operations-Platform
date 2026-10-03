import type postgres from 'postgres';
import { HttpError, type Principal } from '../security.js';
import { evaluateSend, type SendAuthor } from './policy.js';
import { resolveConfiguredSender } from './sender-resolution.js';

export async function lockOutboundScope(tx: postgres.TransactionSql, actor: Principal, conversationId: string) {
  const scope = (await tx`SELECT l.id AS lead_id, l.organization_id, l.branch_id, l.campaign_id,
      l.contact_id, l.assigned_agent_id, l.lifecycle, ct.phone_normalized,
      b.active AS branch_active, b.timezone, b.messaging_window,
      ca.status AS campaign_status, ca.messaging_config, ca.messaging_policy
    FROM conversation cv JOIN lead l ON l.id = cv.lead_id
    JOIN contact ct ON ct.id = l.contact_id JOIN branch b ON b.id = l.branch_id
    JOIN campaign ca ON ca.id = l.campaign_id
    WHERE cv.id = ${conversationId} AND l.organization_id = ${actor.organizationId}
      AND (${actor.role === 'SUPER_ADMIN'} OR
        (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
        (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))
    FOR UPDATE OF l`)[0];
  if (!scope) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
  await tx`SELECT id FROM contact WHERE id = ${scope.contact_id} FOR SHARE`;
  const conversation = (await tx`SELECT id, lead_id, connection_id, sender_id, channel,
      participant_ref, controller_type, controller_user_id, state, needs_attention_reason
    FROM conversation WHERE id = ${conversationId} FOR UPDATE`)[0]!;
  return { scope, conversation };
}

export type LockedOutboundScope = Awaited<ReturnType<typeof lockOutboundScope>>;

export async function checkCurrentOutbound(tx: postgres.TransactionSql, locked: LockedOutboundScope,
  actor: Principal, author: SendAuthor, excludeMessageId?: string, templateId?: string | null) {
  const { scope, conversation } = locked;
  if (!scope.branch_active || scope.campaign_status !== 'ACTIVE' || scope.messaging_config?.enabled !== true)
    return { allowed: false as const, reason: 'MESSAGING_NOT_ACTIVE' };
  if (scope.lifecycle !== 'OPEN') return { allowed: false as const, reason: 'LEAD_NOT_OPEN' };
  if (conversation.channel !== 'WHATSAPP') return { allowed: false as const, reason: 'CHANNEL_NOT_SUPPORTED' };
  if (conversation.state === 'CLOSED') return { allowed: false as const, reason: 'CONVERSATION_CLOSED' };
  if (conversation.needs_attention_reason) return { allowed: false as const, reason: conversation.needs_attention_reason as string };
  if (!scope.phone_normalized || scope.phone_normalized !== conversation.participant_ref) {
    await tx`UPDATE conversation SET needs_attention_reason = 'PARTICIPANT_CHANGED' WHERE id = ${conversation.id}`;
    return { allowed: false as const, reason: 'PARTICIPANT_CHANGED' };
  }
  const resolved = await resolveConfiguredSender(tx, { organizationId: scope.organization_id,
    branchId: scope.branch_id, campaignId: scope.campaign_id, pinnedSenderId: conversation.sender_id });
  if (!resolved.sender) {
    await tx`UPDATE conversation SET needs_attention_reason = ${resolved.reason} WHERE id = ${conversation.id}`;
    return { allowed: false as const, reason: resolved.reason };
  }
  if (resolved.sender.connectionId !== conversation.connection_id) {
    await tx`UPDATE conversation SET needs_attention_reason = 'CONNECTION_SENDER_MISMATCH' WHERE id = ${conversation.id}`;
    return { allowed: false as const, reason: 'CONNECTION_SENDER_MISMATCH' };
  }
  const consent = (await tx`SELECT status, do_not_contact FROM messaging_consent
    WHERE contact_id = ${scope.contact_id} AND channel = 'WHATSAPP'`)[0];
  const connection = (await tx`SELECT provider FROM integration_connection
    WHERE id = ${conversation.connection_id}`)[0]!;
  const latestInbound = (await tx`SELECT received_at FROM conversation_message
    WHERE conversation_id = ${conversation.id} AND direction = 'INBOUND'
    ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 1`)[0]?.received_at as Date | null | undefined;
  const now = new Date();
  const inboundAge = latestInbound ? now.getTime() - latestInbound.getTime() : null;
  const withinMetaServiceWindow = inboundAge !== null && inboundAge >= 0 && inboundAge < 24 * 60 * 60 * 1000;
  const policy = scope.messaging_policy || {};
  const proactive = author !== 'HUMAN';
  const attempt = proactive ? (await tx`SELECT count(*)::integer AS attempts, max(m.created_at) AS last_sent_at
    FROM conversation_message m JOIN conversation c ON c.id = m.conversation_id
    WHERE c.lead_id = ${scope.lead_id} AND m.direction = 'OUTBOUND'
      AND m.author_type IN ('AI','AUTOMATION','FOLLOW_UP')
      AND (${excludeMessageId ?? null}::uuid IS NULL OR m.id <> ${excludeMessageId ?? null}::uuid)`)[0] : null;
  const decision = evaluateSend({ author, actorUserId: actor.id,
    controllerType: conversation.controller_type, controllerUserId: conversation.controller_user_id,
    conversationState: conversation.state, consentStatus: consent?.status ?? 'UNKNOWN',
    doNotContact: consent?.do_not_contact ?? false, consentRequired: true,
    sender: { ...resolved.sender, requiresTemplate: resolved.sender.requiresTemplate ||
      (connection.provider === 'META_WHATSAPP_CLOUD' && !withinMetaServiceWindow) },
    templateId,
    timezone: scope.timezone, sendingWindow: policy.sendingWindow ??
      (scope.messaging_window?.start ? scope.messaging_window : null),
    attempts: attempt?.attempts ?? 0, maxAttempts: proactive ? policy.maxAttempts : null,
    lastSentAt: attempt?.last_sent_at ?? null,
    minIntervalSeconds: proactive ? policy.minIntervalSeconds : null, now });
  if (!decision.allowed) return { allowed: false as const, reason: decision.reason ?? 'MESSAGE_BLOCKED' };
  return { allowed: true as const, sender: resolved.sender, provider: connection.provider as string,
    recipient: conversation.participant_ref as string };
}
