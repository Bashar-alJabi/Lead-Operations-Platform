import type postgres from 'postgres';
import type { Database } from '../db.js';

export function eventWorkerOptions(env: NodeJS.ProcessEnv = process.env) {
  const bounded = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  return { batchSize: bounded('MESSAGING_EVENT_BATCH_SIZE',50,1,500),
    pollMs: bounded('MESSAGING_EVENT_POLL_MS',2000,100,60000) };
}
export function eventProcessingFailure(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return code === '40P01' ? 'PROCESSING_DEADLOCK' : code === '40001' ? 'PROCESSING_SERIALIZATION'
    : code === '57014' ? 'PROCESSING_TIMEOUT' : 'EVENT_PROCESSING_FAILED';
}
export function eventProcessingDelay(failures: number): number {
  return Math.min(1800, 30 * 2 ** Math.max(0, Math.min(failures - 1, 6)));
}
// All work is short database work. Row locks fence competing workers; a crash rolls the transaction back.
export async function processOneIntegrationEvent(db: Database, kind: 'DELIVERY_STATUS'|'INBOUND_MESSAGE',
  process: (tx: postgres.TransactionSql, id: string) => Promise<unknown>): Promise<boolean> {
  return db.begin(async (tx) => {
    const event = (await tx`SELECT e.id, e.connection_id, e.state, e.failure_code,
        e.processing_attempts, e.processing_failures FROM integration_event e
      WHERE e.event_kind = ${kind} AND e.processing_available_at <= now()
        AND e.event_kind IN ('DELIVERY_STATUS','INBOUND_MESSAGE') AND (e.state = 'RECEIVED' OR
          (e.state = 'NEEDS_ATTENTION' AND e.failure_code IN ('INBOUND_PROCESSING_NOT_READY','MESSAGE_NOT_FOUND')))
        AND ((e.state = 'RECEIVED') OR
          (${kind === 'INBOUND_MESSAGE'} AND e.state = 'NEEDS_ATTENTION' AND e.failure_code = 'INBOUND_PROCESSING_NOT_READY') OR
          (${kind === 'DELIVERY_STATUS'} AND e.state = 'NEEDS_ATTENTION' AND e.failure_code = 'MESSAGE_NOT_FOUND'
            AND (EXISTS (SELECT 1 FROM conversation_message m WHERE m.connection_id = e.connection_id
                AND m.provider_message_id = e.payload->>'providerMessageId')
              OR EXISTS (SELECT 1 FROM messaging_connection_test_send r WHERE r.connection_id = e.connection_id
                AND r.provider_message_id = e.payload->>'providerMessageId'))))
      ORDER BY e.processing_available_at, e.received_at, e.id FOR UPDATE OF e SKIP LOCKED LIMIT 1`)[0];
    if (!event) return false;
    const attempt = Number(event.processing_attempts) + 1;
    let outcome: string; let errorCode: string | null;
    try {
      const result = await tx.savepoint(async (nested) => {
        await process(nested, event.id);
        const updated = (await nested`SELECT state, failure_code FROM integration_event WHERE id = ${event.id}`)[0]!;
        if (!['PROCESSED','NEEDS_ATTENTION'].includes(updated.state)) throw new Error('Invalid processor outcome');
        return updated;
      });
      outcome = result.state; errorCode = result.failure_code;
      await tx`UPDATE integration_event SET processing_attempts = ${attempt}, processing_failures = 0,
        processing_last_error = NULL, processing_version = processing_version + 1,
        last_processed_at = now() WHERE id = ${event.id}`;
    } catch (error) {
      const failures = Number(event.processing_failures) + 1; const failed = failures >= 5;
      errorCode = eventProcessingFailure(error); outcome = failed ? 'FAILED' : 'RETRY';
      await tx`UPDATE integration_event SET processing_attempts = ${attempt}, processing_failures = ${failures},
        processing_last_error = ${errorCode}, processing_version = processing_version + 1,
        state = ${failed ? 'FAILED' : event.state}, failure_code = ${failed ? 'EVENT_PROCESSING_FAILED' : event.failure_code},
        processing_available_at = now() + ${eventProcessingDelay(failures)} * interval '1 second',
        last_processed_at = now() WHERE id = ${event.id}`;
    }
    await tx`INSERT INTO integration_event_processing_attempt (event_id, attempt_number, outcome, error_code)
      VALUES (${event.id}, ${attempt}, ${outcome}, ${errorCode})`;
    if (outcome === 'RETRY' || outcome === 'FAILED') await tx`INSERT INTO audit_log
      (organization_id, branch_id, action, target_type, target_id, detail)
      SELECT organization_id, branch_id, ${outcome === 'FAILED' ? 'MESSAGING_EVENT_PROCESSING_FAILED' : 'MESSAGING_EVENT_RETRY_SCHEDULED'},
        'INTEGRATION_EVENT', ${event.id}, ${tx.json({ attempt, errorCode })}
      FROM integration_connection WHERE id = ${event.connection_id}`;
    return true;
  });
}
