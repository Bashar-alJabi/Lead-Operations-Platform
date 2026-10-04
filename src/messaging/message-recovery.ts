import { isDeepStrictEqual } from 'node:util';
import type { Database } from '../db.js';
import { HttpError, type Principal } from '../security.js';
import { approvedBodyTemplate } from './approved-template.js';
import { checkCurrentOutbound, lockOutboundScope } from './outbound-policy.js';
import { mediaCaptionAllowed } from '../media/outbound-policy.js';

export type RecoveryFacts = {
  direction: string; author_type: string; author_user_id: string | null;
  delivery_state: string; provider_message_id: string | null; delivery_rank: number;
  sent_at: Date | null; delivery_provider_at: Date | null; job_status: string | null;
  locked_until: Date | null; unsafe_attempt: boolean; has_delivery_event: boolean;
};

// This is structural eligibility. The full current messaging policy is evaluated on POST and again by the worker.
export function messageRecoveryBlock(facts: RecoveryFacts, actorId: string): string | null {
  if (facts.direction !== 'OUTBOUND' || facts.author_type !== 'HUMAN') return 'HUMAN_OUTBOUND_REQUIRED';
  if (facts.author_user_id !== actorId) return 'ORIGINAL_AUTHOR_REQUIRED';
  if (facts.delivery_state !== 'FAILED' || facts.job_status !== 'DEAD' || facts.locked_until !== null)
    return 'MESSAGE_NOT_RETRYABLE';
  if (facts.provider_message_id !== null || facts.delivery_rank !== 0 || facts.sent_at !== null
    || facts.delivery_provider_at !== null || facts.unsafe_attempt || facts.has_delivery_event)
    return 'SEND_ACCEPTANCE_NOT_EXCLUDED';
  return null;
}

export async function recoverOutboundMessage(db: Database, input: {
  actor: Principal; conversationId: string; messageId: string; version: number; reason: string;
}): Promise<{ deliveryState: 'QUEUED'; recoveryVersion: number; recoveryId: string }> {
  if (input.reason.trim().length < 10 || input.reason.length > 500)
    throw new HttpError(400, 'RECOVERY_REASON_REQUIRED');
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new HttpError(400, 'RECOVERY_VERSION_INVALID');
  const outcome = await db.begin(async (tx) => {
    // Connection comes first, matching delivery callbacks and worker completion. No external I/O here.
    const identity = (await tx`SELECT m.connection_id FROM conversation_message m
      JOIN conversation cv ON cv.id = m.conversation_id JOIN lead l ON l.id = cv.lead_id
      WHERE m.id = ${input.messageId} AND m.conversation_id = ${input.conversationId}
        AND l.organization_id = ${input.actor.organizationId} AND (${input.actor.role === 'SUPER_ADMIN'} OR
          (${input.actor.role === 'MANAGER'} AND l.branch_id = ${input.actor.branchId}) OR
          (${input.actor.role === 'AGENT'} AND l.assigned_agent_id = ${input.actor.id}))`)[0];
    if (!identity) throw new HttpError(404, 'MESSAGE_NOT_FOUND');
    await tx`SELECT id FROM integration_connection WHERE id = ${identity.connection_id} FOR NO KEY UPDATE`;
    // Reject active jobs without taking Conversation locks: a pre-dispatch failure may hold Job then Conversation.
    // DEAD cannot be claimed by workers; competing recovery and accepted completion use this Connection lock.
    const preliminary = (await tx`SELECT j.status, j.locked_until FROM conversation_message m
      JOIN conversation cv ON cv.id = m.conversation_id JOIN lead l ON l.id = cv.lead_id
      LEFT JOIN outbound_delivery_job link ON link.message_id = m.id LEFT JOIN background_job j ON j.id = link.job_id
      WHERE m.id = ${input.messageId} AND cv.id = ${input.conversationId}
        AND l.organization_id = ${input.actor.organizationId} AND (${input.actor.role === 'SUPER_ADMIN'} OR
          (${input.actor.role === 'MANAGER'} AND l.branch_id = ${input.actor.branchId}) OR
          (${input.actor.role === 'AGENT'} AND l.assigned_agent_id = ${input.actor.id}))`)[0];
    if (!preliminary) throw new HttpError(404, 'MESSAGE_NOT_FOUND');
    if (preliminary.status !== 'DEAD' || preliminary.locked_until !== null)
      throw new HttpError(409, 'MESSAGE_NOT_RETRYABLE');
    const locked = await lockOutboundScope(tx, input.actor, input.conversationId);
    const link = (await tx`SELECT job_id, recovery_version FROM outbound_delivery_job
      WHERE message_id = ${input.messageId} FOR UPDATE`)[0];
    if (!link) throw new HttpError(409, 'MESSAGE_NOT_RETRYABLE');
    if (link.recovery_version !== input.version) throw new HttpError(409, 'MESSAGE_RECOVERY_VERSION_CONFLICT');
    const job = (await tx`SELECT status, locked_until, attempts, max_attempts FROM background_job
      WHERE id = ${link.job_id} FOR UPDATE`)[0]!;
    const message = (await tx`SELECT m.*,
        EXISTS (SELECT 1 FROM outbound_send_attempt a WHERE a.message_id = m.id
          AND (a.state <> 'REJECTED' OR a.finished_at IS NULL OR a.provider_message_id IS NOT NULL)) AS unsafe_attempt,
        EXISTS (SELECT 1 FROM message_delivery_event e WHERE e.message_id = m.id) AS has_delivery_event
      FROM conversation_message m WHERE m.id = ${input.messageId}
        AND m.conversation_id = ${input.conversationId} FOR UPDATE OF m`)[0]!;
    const block = messageRecoveryBlock({ ...message, job_status: job.status,
      locked_until: job.locked_until } as RecoveryFacts, input.actor.id);
    if (block) throw new HttpError(409, block);
    const attachment = message.attachment_id ? (await tx`SELECT state, media_kind, upload_conversation_id
      FROM message_attachment WHERE id = ${message.attachment_id} FOR SHARE`)[0] : null;
    if (message.message_kind === 'ATTACHMENT' && (!attachment || attachment.state !== 'READY'
      || attachment.upload_conversation_id !== input.conversationId)) throw new HttpError(409, 'ATTACHMENT_NOT_READY');
    if (attachment && !mediaCaptionAllowed(attachment.media_kind,message.body))
      throw new HttpError(409,'MEDIA_CAPTION_NOT_SUPPORTED');
    const decision = await checkCurrentOutbound(tx, locked, input.actor, 'HUMAN',
      message.id, message.template_id, attachment?.media_kind);
    if (!decision.allowed) return { blocked: decision.reason } as const;
    if (message.message_kind === 'TEMPLATE') {
      const template = await approvedBodyTemplate(tx, message.connection_id, locked.scope.campaign_id,
        message.template_id, message.template_snapshot?.bodyParameters ?? [],message.template_snapshot?.headerParameter);
      if (!isDeepStrictEqual(template.snapshot, message.template_snapshot) || template.body !== message.body)
        throw new HttpError(409, 'TEMPLATE_CHANGED');
    }
    const version = link.recovery_version + 1;
    const recovery = (await tx`INSERT INTO outbound_message_recovery
      (message_id, job_id, recovery_version, previous_error_code, attempts_before, requested_by, reason)
      VALUES (${message.id}, ${link.job_id}, ${version}, ${message.last_error_code}, ${job.attempts},
        ${input.actor.id}, ${input.reason.trim()}) RETURNING id`)[0]!;
    await tx`UPDATE outbound_delivery_job SET recovery_version = ${version} WHERE message_id = ${message.id}`;
    // Preserve every historical attempt number. Grant one bounded automatic retry budget for this explicit recovery.
    await tx`UPDATE conversation_message SET delivery_state = 'QUEUED', last_error_code = NULL WHERE id = ${message.id}`;
    await tx`UPDATE background_job SET status = 'QUEUED', max_attempts = attempts + 5,
      run_after = now(), locked_until = NULL, last_error_code = NULL, updated_at = now() WHERE id = ${link.job_id}`;
    await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
      VALUES (${input.actor.organizationId}, ${locked.scope.branch_id}, ${input.actor.id},
        'OUTBOUND_MESSAGE_RECOVERY_REQUESTED', 'MESSAGE', ${message.id},
        ${tx.json({ recoveryId: recovery.id, version, attemptsBefore: job.attempts,
          previousErrorCode: message.last_error_code, reason: input.reason.trim() })})`;
    return { deliveryState: 'QUEUED' as const, recoveryVersion: version, recoveryId: recovery.id as string };
  });
  if ('blocked' in outcome && typeof outcome.blocked === 'string') throw new HttpError(409, outcome.blocked);
  return outcome;
}
