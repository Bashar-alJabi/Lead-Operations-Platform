import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { openSecret } from '../credentials.js';
import type { MessagingConnectionConfig, MessagingCredentials } from '../messaging/providers.js';
import { type MessagingMediaAdapter, metaMessagingMediaAdapter } from './meta-provider.js';
import { type MediaScanner, configuredMediaScanner } from './scanner.js';
import { type MediaStorage, configuredMediaStorage } from './storage.js';
import { MediaError, mediaMaxBytes, validateMedia, type MediaKind } from './validation.js';

export type MediaWorkerOptions = { adapter?: MessagingMediaAdapter; scanner?: MediaScanner; storage?: MediaStorage };
export async function processOneInboundAttachment(db: Database, options: MediaWorkerOptions = {}): Promise<boolean> {
  const token = randomUUID();
  const row = await db.begin(async (tx) => {
    const found = (await tx`SELECT a.*, e.connection_id, ic.config, s.external_sender_id
      FROM message_attachment a JOIN integration_event e ON e.id = a.integration_event_id
      JOIN integration_connection ic ON ic.id = e.connection_id
      JOIN messaging_sender s ON s.id = e.sender_id
      WHERE ((a.state = 'QUEUED' AND a.available_at <= now() AND ic.status <> 'DISABLED'
          AND s.active AND s.operator_enabled AND e.state <> 'IGNORED')
        OR (a.state = 'RUNNING' AND a.lease_until < now()))
      ORDER BY a.available_at, a.id FOR UPDATE OF a SKIP LOCKED LIMIT 1`)[0];
    if (!found) return null;
    if (found.state === 'RUNNING') await tx`UPDATE attachment_processing_attempt
      SET outcome = 'LEASE_EXPIRED', error_code = 'MEDIA_LEASE_EXPIRED', finished_at = now()
      WHERE lease_token = ${found.lease_token} AND outcome = 'STARTED'`;
    if (found.retry_count >= 5) {
      await tx`UPDATE message_attachment SET state = 'FAILED', lease_token = NULL, lease_until = NULL,
        last_error_code = 'MEDIA_RETRY_EXHAUSTED', version = version + 1, updated_at = now() WHERE id = ${found.id}`;
      return { exhausted: true } as const;
    }
    await tx`UPDATE message_attachment SET state = 'RUNNING', lease_token = ${token},
      lease_until = now() + interval '300 seconds', attempt_count = attempt_count + 1,
      retry_count = retry_count + 1, version = version + 1, updated_at = now() WHERE id = ${found.id}`;
    await tx`INSERT INTO attachment_processing_attempt (attachment_id, lease_token, attempt_number, outcome)
      VALUES (${found.id}, ${token}, ${found.attempt_count + 1}, 'STARTED')`;
    return found;
  });
  if (!row) return false;
  if ('exhausted' in row) return true;
  let result: { mime: string; hash: string; size: number; key: string; backend: string; scannerVersion: string } | null = null;
  let failure: MediaError | null = null; let stage = 'MEDIA_PROVIDER_UNAVAILABLE';
  try {
    const connection = (await db`SELECT ic.status, s.active, s.operator_enabled, e.state AS event_state,
      secret.ciphertext, secret.nonce, secret.auth_tag, secret.key_version
      FROM integration_connection ic JOIN connection_secret secret ON secret.connection_id = ic.id
      JOIN integration_event e ON e.connection_id = ic.id JOIN messaging_sender s ON s.id = e.sender_id
      WHERE ic.id = ${row.connection_id} AND e.id = ${row.integration_event_id}`)[0];
    if (!connection || connection.status === 'DISABLED' || !connection.active || !connection.operator_enabled
      || connection.event_state === 'IGNORED') throw new MediaError('MEDIA_CONNECTION_UNAVAILABLE', true);
    const credentials = JSON.parse(openSecret(row.connection_id, { ciphertext: connection.ciphertext,
      nonce: connection.nonce, authTag: connection.auth_tag, keyVersion: connection.key_version })) as MessagingCredentials;
    const bytes = await (options.adapter ?? metaMessagingMediaAdapter).download({
      config: row.config as MessagingConnectionConfig, credentials, externalSenderId: row.external_sender_id,
      mediaId: row.provider_media_id, maxBytes: mediaMaxBytes() });
    const valid = await validateMedia(bytes, row.media_kind as MediaKind, row.declared_mime, row.expected_sha256);
    stage = 'MEDIA_SCANNER_UNAVAILABLE';
    const scan = await (options.scanner ?? configuredMediaScanner()).scan(bytes);
    if (!scan.clean) throw new MediaError('MEDIA_CONTENT_REJECTED');
    stage = 'MEDIA_STORAGE_UNAVAILABLE';
    const storage = options.storage ?? configuredMediaStorage();
    const key = `${row.id}-${valid.hash}`;
    await storage.put(key, bytes);
    result = { ...valid, key, backend: storage.backend, scannerVersion: scan.version.slice(0, 255) };
  } catch (error) { failure = error instanceof MediaError ? error : new MediaError(stage, true); }
  await db.begin(async (tx) => {
    const current = (await tx`SELECT state, lease_token FROM message_attachment WHERE id = ${row.id} FOR UPDATE`)[0];
    // A recovered lease owns its own result; late work cannot replace that state.
    if (current?.state !== 'RUNNING' || current.lease_token !== token) return;
    const permanentReject = failure && ['MEDIA_CONTENT_REJECTED','MEDIA_TYPE_MISMATCH','MEDIA_HASH_MISMATCH',
      'MEDIA_SIZE_INVALID','MEDIA_SIZE_MISMATCH','MEDIA_PROVIDER_URL_DENIED'].includes(failure.code);
    const next = result ? 'READY' : permanentReject ? 'REJECTED'
      : failure?.retryable && row.retry_count + 1 < 5 ? 'QUEUED' : 'FAILED';
    await tx`UPDATE message_attachment SET state = ${next},
      mime_type = ${result?.mime ?? null}, size_bytes = ${result?.size ?? null},
      content_sha256 = ${result?.hash ?? null}, storage_key = ${result?.key ?? null},
      storage_backend = ${result?.backend ?? null}, scanner_version = ${result?.scannerVersion ?? null},
      scanned_at = ${result ? new Date() : null}, lease_token = NULL, lease_until = NULL,
      last_error_code = ${failure?.code ?? null}, available_at = now() + ${Math.min(1800, 30 * 2 ** row.retry_count)} * interval '1 second',
      version = version + 1, updated_at = now() WHERE id = ${row.id}`;
    await tx`UPDATE attachment_processing_attempt SET outcome = ${next === 'QUEUED' ? 'RETRY' : next},
      error_code = ${failure?.code ?? null}, finished_at = now() WHERE lease_token = ${token}`;
    await tx`INSERT INTO audit_log (organization_id, branch_id, action, target_type, target_id, detail)
      SELECT ic.organization_id, coalesce(l.branch_id, ic.branch_id), 'INBOUND_ATTACHMENT_PROCESSED',
        'ATTACHMENT', ${row.id}, ${tx.json({ state: next, errorCode: failure?.code ?? null })}
      FROM integration_event e JOIN integration_connection ic ON ic.id = e.connection_id
      LEFT JOIN lead l ON l.id = e.lead_id WHERE e.id = ${row.integration_event_id}`;
  });
  return true;
}
