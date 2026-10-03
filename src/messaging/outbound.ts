import type { Database } from '../db.js';
import { HttpError, type Principal } from '../security.js';
import type { SendAuthor } from './policy.js';
import { checkCurrentOutbound, lockOutboundScope } from './outbound-policy.js';

export type OutboundRequest = { actor: Principal; conversationId: string; author: SendAuthor;
  body: string; idempotencyKey: string };

// Every caller, including future AI and automation tools, must enter here with an authorized principal.
export async function enqueueOutboundMessage(db: Database, input: OutboundRequest): Promise<{
  id: string; deliveryState: string; existing: boolean;
}> {
  if (!input.body.trim()) throw new HttpError(400, 'MESSAGE_BODY_REQUIRED');
  const outcome = await db.begin(async (tx) => {
    const locked = await lockOutboundScope(tx, input.actor, input.conversationId);
    const { scope, conversation } = locked;
    const prior = (await tx`SELECT id, body, author_type, author_user_id, delivery_state
      FROM conversation_message WHERE conversation_id = ${conversation.id}
        AND idempotency_key = ${input.idempotencyKey}`)[0];
    if (prior) {
      if (prior.body !== input.body || prior.author_type !== input.author ||
          prior.author_user_id !== (input.author === 'HUMAN' ? input.actor.id : null))
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
      return { id: prior.id as string, deliveryState: prior.delivery_state as string, existing: true };
    }
    const decision = await checkCurrentOutbound(tx, locked, input.actor, input.author);
    if (!decision.allowed) return { blocked: decision.reason } as const;
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
