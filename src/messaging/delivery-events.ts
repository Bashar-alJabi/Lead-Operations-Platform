import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { Database } from '../db.js';

export type DeliveryStatus = { senderExternalId: string; providerMessageId: string;
  recipient: string; status: 'sent'|'delivered'|'read'|'failed'; providerTimestamp: string };
const rank: Record<DeliveryStatus['status'], number> = { sent: 1, failed: 2, delivered: 3, read: 4 };
const state: Record<DeliveryStatus['status'], string> = {
  sent: 'SENT', failed: 'FAILED', delivered: 'DELIVERED', read: 'READ',
};

export function providerEventId(kind: 'DELIVERY_STATUS'|'INBOUND_MESSAGE', values: string[]): string {
  return createHash('sha256').update(JSON.stringify([kind, ...values])).digest('hex');
}

export async function applyDeliveryEvent(tx: postgres.TransactionSql, eventId: string): Promise<string> {
  const event = (await tx`SELECT id, connection_id, sender_id, participant_ref, payload, state
    FROM integration_event WHERE id = ${eventId} FOR UPDATE`)[0];
  if (!event || event.state === 'PROCESSED') return 'PROCESSED';
  // Serialize state mutations for a connection before locking its messages/senders.
  // Compatible with FK key-share locks; no provider I/O runs under this lock.
  await tx`SELECT id FROM integration_connection WHERE id = ${event.connection_id} FOR NO KEY UPDATE`;
  const value = event.payload as { senderExternalId: string; providerMessageId: string;
    status: DeliveryStatus['status']; providerTimestamp: string };
  let senderId = event.sender_id as string | null;
  if (!senderId) {
    const sender = (await tx`SELECT id FROM messaging_sender WHERE connection_id = ${event.connection_id}
      AND external_sender_id = ${value.senderExternalId}`)[0];
    if (sender) {
      senderId = sender.id;
      await tx`UPDATE integration_event SET sender_id = ${senderId} WHERE id = ${event.id}`;
    }
  }
  if (!senderId) {
    await tx`UPDATE integration_event SET state = 'NEEDS_ATTENTION', failure_code = 'SENDER_NOT_FOUND'
      WHERE id = ${event.id}`;
    return 'NEEDS_ATTENTION';
  }
  const message = (await tx`SELECT m.id, m.sender_id, m.conversation_id, m.delivery_state,
      m.delivery_rank, m.delivery_provider_at, cv.participant_ref
    FROM conversation_message m JOIN conversation cv ON cv.id = m.conversation_id
    WHERE m.connection_id = ${event.connection_id}
      AND m.provider_message_id = ${value.providerMessageId} FOR UPDATE OF m`)[0];
  const attempt = message ? null : (await tx`SELECT id, sender_id, recipient_last4,
      delivery_state, delivery_provider_at
    FROM messaging_connection_test_send WHERE connection_id = ${event.connection_id}
      AND provider_message_id = ${value.providerMessageId} FOR UPDATE`)[0];
  if (!message && !attempt) {
    await tx`UPDATE integration_event SET state = 'NEEDS_ATTENTION', failure_code = 'MESSAGE_NOT_FOUND'
      WHERE id = ${event.id}`;
    return 'NEEDS_ATTENTION';
  }
  if ((message ?? attempt)!.sender_id !== senderId) {
    await tx`UPDATE integration_event SET state = 'NEEDS_ATTENTION', failure_code = 'SENDER_MISMATCH'
      WHERE id = ${event.id}`;
    return 'NEEDS_ATTENTION';
  }
  if (message && message.participant_ref !== event.participant_ref) {
    await tx`UPDATE integration_event SET state = 'NEEDS_ATTENTION', failure_code = 'PARTICIPANT_MISMATCH'
      WHERE id = ${event.id}`;
    return 'NEEDS_ATTENTION';
  }
  if (attempt && !String(event.participant_ref).endsWith(attempt.recipient_last4)) {
    await tx`UPDATE integration_event SET state = 'NEEDS_ATTENTION', failure_code = 'PARTICIPANT_MISMATCH'
      WHERE id = ${event.id}`;
    return 'NEEDS_ATTENTION';
  }
  const incomingAt = new Date(value.providerTimestamp);
  const oldAt = (message ?? attempt)!.delivery_provider_at as Date | null;
  const incomingRank = rank[value.status];
  const currentRank = message ? Number(message.delivery_rank) :
    attempt!.delivery_state === 'READ' ? 4 : attempt!.delivery_state === 'DELIVERED' ? 3 :
      attempt!.delivery_state === 'FAILED' ? 2 : attempt!.delivery_state === 'SENT' ? 1 : 0;
  const advance = (!oldAt || incomingAt >= oldAt) && incomingRank > currentRank;
  if (message) {
    await tx`INSERT INTO message_delivery_event (message_id, integration_event_id, status, provider_timestamp)
      VALUES (${message.id}, ${event.id}, ${state[value.status]}, ${incomingAt})
      ON CONFLICT (integration_event_id) DO NOTHING`;
    if (advance) {
      await tx`UPDATE conversation_message SET delivery_state = ${state[value.status]},
        delivery_rank = ${incomingRank}, delivery_provider_at = ${incomingAt},
        last_error_code = ${value.status === 'failed' ? 'PROVIDER_DELIVERY_FAILED' : null}
        WHERE id = ${message.id}`;
      if (value.status === 'failed') await tx`UPDATE conversation SET needs_attention_reason = 'DELIVERY_FAILED'
        WHERE id = ${message.conversation_id} AND needs_attention_reason IS NULL`;
      else await tx`UPDATE conversation SET needs_attention_reason = NULL
        WHERE id = ${message.conversation_id} AND needs_attention_reason = 'DELIVERY_FAILED'`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
        target_type, target_id, detail)
        SELECT l.organization_id, l.branch_id, NULL, 'MESSAGE_DELIVERY_UPDATED', 'MESSAGE',
          ${message.id}, ${tx.json({ status: state[value.status], eventId: event.id })}
        FROM conversation cv JOIN lead l ON l.id = cv.lead_id WHERE cv.id = ${message.conversation_id}`;
    }
  } else if (advance) {
    await tx`UPDATE messaging_connection_test_send SET delivery_state = ${state[value.status]},
      delivery_provider_at = ${incomingAt}, updated_at = now() WHERE id = ${attempt!.id}`;
  }
  if (advance && (value.status === 'delivered' || value.status === 'read'))
    await tx`UPDATE messaging_sender SET health = 'HEALTHY' WHERE id = ${senderId}`;
  await tx`UPDATE integration_event SET state = 'PROCESSED', failure_code = NULL WHERE id = ${event.id}`;
  return 'PROCESSED';
}

export async function processOnePendingDeliveryEvent(db: Database): Promise<boolean> {
  return db.begin(async (tx) => {
    const pending = (await tx`SELECT e.id FROM integration_event e
      WHERE e.event_kind = 'DELIVERY_STATUS' AND e.state = 'NEEDS_ATTENTION'
        AND e.failure_code = 'MESSAGE_NOT_FOUND'
        AND (EXISTS (SELECT 1 FROM conversation_message m
          WHERE m.connection_id = e.connection_id AND m.provider_message_id = e.payload->>'providerMessageId')
          OR EXISTS (SELECT 1 FROM messaging_connection_test_send r
            WHERE r.connection_id = e.connection_id AND r.provider_message_id = e.payload->>'providerMessageId'))
      ORDER BY e.received_at, e.id FOR UPDATE OF e SKIP LOCKED LIMIT 1`)[0];
    if (!pending) return false;
    await applyDeliveryEvent(tx, pending.id);
    return true;
  });
}
