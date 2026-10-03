import type { Database } from '../db.js';
import type postgres from 'postgres';
import { isDeepStrictEqual } from 'node:util';
import { openSecret } from '../credentials.js';
import { HttpError, type Principal } from '../security.js';
import { checkCurrentOutbound, lockOutboundScope } from './outbound-policy.js';
import { approvedBodyTemplate } from './approved-template.js';
import { metaWhatsAppSendAdapter, ProviderSendError, type MessagingConnectionConfig,
  type MessagingCredentials, type MessagingSendAdapter, type SendTextInput,
  type SendTemplateInput } from './providers.js';

type Claimed = { jobId: string; messageId: string; senderId: string; attemptNo: number; recovered?: boolean };

async function auditWorkerEvent(tx: postgres.TransactionSql, messageId: string, action: string,
  detail: { reason?: string; attempt?: number }): Promise<void> {
  await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
      target_type, target_id, detail)
    SELECT l.organization_id, l.branch_id, NULL, ${action}, 'MESSAGE', m.id, ${tx.json(detail)}
    FROM conversation_message m JOIN conversation cv ON cv.id = m.conversation_id
    JOIN lead l ON l.id = cv.lead_id WHERE m.id = ${messageId}`;
}

async function claimOne(db: Database): Promise<Claimed | null> {
  return db.begin(async (tx) => {
    const candidates = await tx`SELECT j.id AS job_id, j.status, j.attempts, j.max_attempts,
        m.id AS message_id, m.sender_id, m.conversation_id, m.delivery_state
      FROM background_job j JOIN outbound_delivery_job link ON link.job_id = j.id
      JOIN conversation_message m ON m.id = link.message_id
      JOIN messaging_sender s ON s.id = m.sender_id
      JOIN integration_connection c ON c.id = m.connection_id
      WHERE j.queue = 'messaging' AND j.kind = 'SEND_MESSAGE'
        AND ((j.status = 'QUEUED' AND j.run_after <= now()
          AND c.status = 'CONNECTED' AND (c.cooldown_until IS NULL OR c.cooldown_until <= now())
          AND s.active AND s.operator_enabled AND s.health IN ('HEALTHY','DEGRADED')
          AND (s.cooldown_until IS NULL OR s.cooldown_until <= now())) OR
          (j.status = 'RUNNING' AND j.locked_until < now()))
        AND NOT EXISTS (SELECT 1 FROM sender_outbound_lease lease
          WHERE lease.sender_id = m.sender_id AND lease.locked_until > now())
      ORDER BY j.run_after, j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 20`;
    for (const row of candidates) {
      if (row.delivery_state !== 'QUEUED') {
        await tx`UPDATE background_job SET status = 'SUCCEEDED', locked_until = NULL,
          updated_at = now() WHERE id = ${row.job_id}`;
        await tx`DELETE FROM sender_outbound_lease WHERE sender_id = ${row.sender_id} AND job_id = ${row.job_id}`;
        return { jobId: row.job_id, messageId: row.message_id, senderId: row.sender_id,
          attemptNo: row.attempts, recovered: true };
      }
      if (row.status === 'RUNNING') {
        const prepared = (await tx`SELECT id FROM outbound_send_attempt
          WHERE job_id = ${row.job_id} AND state = 'PREPARED' LIMIT 1`)[0];
        if (prepared) {
          await tx`UPDATE outbound_send_attempt SET state = 'UNKNOWN',
            error_code = 'SEND_OUTCOME_UNKNOWN', finished_at = now() WHERE id = ${prepared.id}`;
          await tx`UPDATE conversation_message SET delivery_state = 'UNKNOWN',
            last_error_code = 'SEND_OUTCOME_UNKNOWN' WHERE id = ${row.message_id} AND delivery_state = 'QUEUED'`;
          await tx`UPDATE conversation SET needs_attention_reason = 'SEND_OUTCOME_UNKNOWN'
            WHERE id = ${row.conversation_id}`;
          await tx`UPDATE background_job SET status = 'DEAD', last_error_code = 'SEND_OUTCOME_UNKNOWN',
            locked_until = NULL, updated_at = now() WHERE id = ${row.job_id}`;
          await auditWorkerEvent(tx, row.message_id, 'OUTBOUND_SEND_OUTCOME_UNKNOWN',
            { reason: 'LEASE_EXPIRED_AFTER_DISPATCH', attempt: row.attempts });
          await tx`DELETE FROM sender_outbound_lease WHERE sender_id = ${row.sender_id} AND job_id = ${row.job_id}`;
          return { jobId: row.job_id, messageId: row.message_id, senderId: row.sender_id,
            attemptNo: row.attempts, recovered: true };
        }
      }
      if (row.attempts >= row.max_attempts) {
        await tx`UPDATE conversation_message SET delivery_state = 'FAILED',
          last_error_code = 'SEND_ATTEMPTS_EXHAUSTED' WHERE id = ${row.message_id}`;
        await tx`UPDATE background_job SET status = 'DEAD',
          last_error_code = 'SEND_ATTEMPTS_EXHAUSTED', locked_until = NULL,
          updated_at = now() WHERE id = ${row.job_id}`;
        await auditWorkerEvent(tx, row.message_id, 'OUTBOUND_MESSAGE_FAILED',
          { reason: 'SEND_ATTEMPTS_EXHAUSTED', attempt: row.attempts });
        await tx`DELETE FROM sender_outbound_lease WHERE sender_id = ${row.sender_id} AND job_id = ${row.job_id}`;
        return { jobId: row.job_id, messageId: row.message_id, senderId: row.sender_id,
          attemptNo: row.attempts, recovered: true };
      }
      const lease = await tx`INSERT INTO sender_outbound_lease (sender_id, job_id, locked_until)
        VALUES (${row.sender_id}, ${row.job_id}, now() + interval '60 seconds')
        ON CONFLICT (sender_id) DO UPDATE SET job_id = EXCLUDED.job_id,
          locked_until = EXCLUDED.locked_until, updated_at = now()
          WHERE sender_outbound_lease.locked_until <= now() RETURNING sender_id`;
      if (!lease.length) continue;
      const changed = (await tx`UPDATE background_job SET status = 'RUNNING', attempts = attempts + 1,
        locked_until = now() + interval '60 seconds', updated_at = now()
        WHERE id = ${row.job_id} RETURNING attempts`)[0]!;
      return { jobId: row.job_id, messageId: row.message_id,
        senderId: row.sender_id, attemptNo: changed.attempts };
    }
    return null;
  });
}

async function finishWithoutSend(db: Database, claimed: Claimed, code: string): Promise<void> {
  await db.begin(async (tx) => {
    const job = (await tx`SELECT status, attempts FROM background_job WHERE id = ${claimed.jobId} FOR UPDATE`)[0];
    if (!job || job.status !== 'RUNNING' || job.attempts !== claimed.attemptNo) return;
    await tx`UPDATE conversation_message SET delivery_state = 'FAILED', last_error_code = ${code}
      WHERE id = ${claimed.messageId} AND delivery_state = 'QUEUED'`;
    await tx`UPDATE outbound_send_attempt SET state = 'REJECTED', error_code = ${code},
      finished_at = now() WHERE job_id = ${claimed.jobId} AND attempt_number = ${claimed.attemptNo}
      AND state = 'PREPARED'`;
    if (code.startsWith('TEMPLATE_')) await tx`UPDATE conversation
      SET needs_attention_reason = ${code}
      WHERE id = (SELECT conversation_id FROM conversation_message WHERE id = ${claimed.messageId})`;
    await tx`UPDATE background_job SET status = 'DEAD', locked_until = NULL, last_error_code = ${code},
      updated_at = now() WHERE id = ${claimed.jobId}`;
    await auditWorkerEvent(tx, claimed.messageId, 'OUTBOUND_MESSAGE_BLOCKED', { reason: code });
    await tx`DELETE FROM sender_outbound_lease WHERE sender_id = ${claimed.senderId} AND job_id = ${claimed.jobId}`;
  });
}

type Prepared = { kind: 'TEXT'; input: SendTextInput; connectionId: string }
  | { kind: 'TEMPLATE'; input: SendTemplateInput; connectionId: string };
async function prepare(db: Database, claimed: Claimed): Promise<Prepared | { blocked: string } |
  { deferredUntil: Date | null }> {
  const message = (await db`SELECT m.conversation_id, m.connection_id, m.sender_id, m.author_type,
      m.author_user_id, m.body, m.delivery_state, m.message_kind, m.template_id,
      m.template_snapshot, u.organization_id, u.branch_id, u.role,
      u.name, u.email, u.active
    FROM conversation_message m LEFT JOIN user_account u ON u.id = m.author_user_id
    WHERE m.id = ${claimed.messageId}`)[0];
  if (!message || message.delivery_state !== 'QUEUED') return { blocked: 'MESSAGE_NOT_QUEUED' };
  if (message.author_type !== 'HUMAN' || !message.active || !message.author_user_id)
    return { blocked: 'AUTHOR_NO_LONGER_AUTHORIZED' };
  const actor: Principal = { id: message.author_user_id, organizationId: message.organization_id,
    branchId: message.branch_id, role: message.role, name: message.name, email: message.email };
  try {
    return await db.begin(async (tx) => {
      const readiness = (await tx`SELECT c.status, c.cooldown_until AS connection_cooldown,
          s.active, s.operator_enabled, s.health, s.cooldown_until AS sender_cooldown
        FROM integration_connection c JOIN messaging_sender s ON s.connection_id = c.id
        WHERE c.id = ${message.connection_id} AND s.id = ${message.sender_id}
        FOR SHARE OF c, s`)[0];
      if (!readiness || readiness.status !== 'CONNECTED' || !readiness.active ||
          !readiness.operator_enabled || !['HEALTHY','DEGRADED'].includes(readiness.health))
        return { deferredUntil: null };
      const until = [readiness.connection_cooldown, readiness.sender_cooldown]
        .filter((value): value is Date => value instanceof Date)
        .reduce<Date | null>((latest, value) => !latest || value > latest ? value : latest, null);
      if (until && until > new Date()) return { deferredUntil: until };
      const locked = await lockOutboundScope(tx, actor, message.conversation_id);
      const decision = await checkCurrentOutbound(tx, locked, actor, 'HUMAN',
        claimed.messageId, message.template_id);
      if (!decision.allowed) return { blocked: decision.reason };
      if (decision.provider !== 'META_WHATSAPP_CLOUD') return { blocked: 'PROVIDER_SEND_NOT_SUPPORTED' };
      const template = message.message_kind === 'TEMPLATE'
        ? await approvedBodyTemplate(tx, message.connection_id,
          locked.scope.campaign_id, message.template_id,
          message.template_snapshot?.bodyParameters ?? []) : null;
      if (template && (!isDeepStrictEqual(template.snapshot, message.template_snapshot)
        || template.body !== message.body)) return { blocked: 'TEMPLATE_CHANGED' };
      const job = (await tx`SELECT status, attempts FROM background_job WHERE id = ${claimed.jobId} FOR UPDATE`)[0];
      if (!job || job.status !== 'RUNNING' || job.attempts !== claimed.attemptNo)
        return { blocked: 'JOB_LEASE_LOST' };
      const connection = (await tx`SELECT c.config, c.status, s.external_sender_id,
          secret.ciphertext, secret.nonce, secret.auth_tag, secret.key_version
        FROM integration_connection c JOIN messaging_sender s ON s.connection_id = c.id
        LEFT JOIN connection_secret secret ON secret.connection_id = c.id
        WHERE c.id = ${message.connection_id} AND s.id = ${message.sender_id}`)[0];
      if (!connection || connection.status !== 'CONNECTED' || !connection.ciphertext)
        return { blocked: 'CONNECTION_CREDENTIAL_UNAVAILABLE' };
      let credentials: MessagingCredentials;
      try { credentials = JSON.parse(openSecret(message.connection_id, { ciphertext: connection.ciphertext,
        nonce: connection.nonce, authTag: connection.auth_tag, keyVersion: connection.key_version })) as MessagingCredentials; }
      catch { return { blocked: 'CONNECTION_CREDENTIAL_UNAVAILABLE' }; }
      if (!credentials || typeof credentials.accessToken !== 'string' || !credentials.accessToken)
        return { blocked: 'CONNECTION_CREDENTIAL_UNAVAILABLE' };
      await tx`INSERT INTO outbound_send_attempt (message_id, job_id, attempt_number, state)
        VALUES (${claimed.messageId}, ${claimed.jobId}, ${claimed.attemptNo}, 'PREPARED')`;
      const common = { config: connection.config as MessagingConnectionConfig, credentials,
        externalSenderId: connection.external_sender_id, recipient: decision.recipient };
      return template ? { kind: 'TEMPLATE', input: { ...common,
        templateName: template.snapshot.name, templateLanguage: template.snapshot.language,
        bodyParameters: template.snapshot.bodyParameters ?? [] },
        connectionId: message.connection_id as string } : { kind: 'TEXT',
        input: { ...common, body: message.body }, connectionId: message.connection_id as string };
    });
  } catch (error) {
    if (error instanceof HttpError) return { blocked: error.code === 'CONVERSATION_NOT_FOUND'
      ? 'AUTHOR_NO_LONGER_AUTHORIZED' : error.code };
    throw error;
  }
}

async function deferClaim(db: Database, claimed: Claimed, until: Date | null): Promise<void> {
  await db.begin(async (tx) => {
    await tx`UPDATE background_job SET status = 'QUEUED', attempts = attempts - 1,
      run_after = GREATEST(now(), ${until}::timestamptz), locked_until = NULL,
      updated_at = now() WHERE id = ${claimed.jobId} AND status = 'RUNNING'
        AND attempts = ${claimed.attemptNo}`;
    await tx`DELETE FROM sender_outbound_lease WHERE sender_id = ${claimed.senderId}
      AND job_id = ${claimed.jobId}`;
  });
}

async function finishAttempt(db: Database, claimed: Claimed, connectionId: string,
  result: { providerMessageId: string } | ProviderSendError): Promise<void> {
  await db.begin(async (tx) => {
    const job = (await tx`SELECT status, attempts, max_attempts FROM background_job
      WHERE id = ${claimed.jobId} FOR UPDATE`)[0];
    if (!job || job.status !== 'RUNNING' || job.attempts !== claimed.attemptNo) return;
    if ('providerMessageId' in result) {
      await tx`UPDATE conversation_message SET provider_message_id = ${result.providerMessageId},
        delivery_state = 'SENT', delivery_rank = 1, attempt_count = ${claimed.attemptNo},
        sent_at = now(), last_error_code = NULL WHERE id = ${claimed.messageId} AND delivery_state = 'QUEUED'`;
      await tx`UPDATE outbound_send_attempt SET state = 'ACKNOWLEDGED',
        provider_message_id = ${result.providerMessageId}, finished_at = now()
        WHERE job_id = ${claimed.jobId} AND attempt_number = ${claimed.attemptNo}`;
      await tx`UPDATE background_job SET status = 'SUCCEEDED', locked_until = NULL,
        last_error_code = NULL, updated_at = now() WHERE id = ${claimed.jobId}`;
      await tx`UPDATE integration_connection SET last_success_at = now(), last_error_code = NULL
        WHERE id = ${connectionId}`;
      await tx`UPDATE messaging_sender SET last_provider_error_code = NULL
        WHERE id = ${claimed.senderId}`;
      await auditWorkerEvent(tx, claimed.messageId, 'OUTBOUND_MESSAGE_SENT',
        { attempt: claimed.attemptNo });
    } else {
      const retry = result.kind === 'RETRYABLE' && claimed.attemptNo < job.max_attempts;
      const unknown = result.kind === 'UNKNOWN';
      const delay = Math.min(3600, Math.max(result.retryAfterSeconds ?? 30,
        30 * 2 ** Math.min(claimed.attemptNo, 6)));
      if (result.code === 'PROVIDER_RATE_LIMITED') {
        await tx`UPDATE integration_connection SET cooldown_until = GREATEST(
          COALESCE(cooldown_until, now()), now() + (${delay} * interval '1 second'))
          WHERE id = ${connectionId}`;
        await tx`UPDATE messaging_sender SET cooldown_until = GREATEST(
          COALESCE(cooldown_until, now()), now() + (${delay} * interval '1 second')),
          last_provider_error_code = ${result.code} WHERE id = ${claimed.senderId}`;
      }
      if (result.code === 'PROVIDER_AUTH_FAILED') {
        await tx`UPDATE messaging_sender SET health = 'UNKNOWN',
          last_provider_error_code = ${result.code} WHERE connection_id = ${connectionId}`;
      }
      await tx`UPDATE outbound_send_attempt SET state = ${unknown ? 'UNKNOWN' : 'REJECTED'},
        error_code = ${result.code}, finished_at = now()
        WHERE job_id = ${claimed.jobId} AND attempt_number = ${claimed.attemptNo}`;
      await tx`UPDATE conversation_message SET delivery_state = ${retry ? 'QUEUED' : unknown ? 'UNKNOWN' : 'FAILED'},
        attempt_count = ${claimed.attemptNo}, last_error_code = ${result.code}
        WHERE id = ${claimed.messageId} AND delivery_state = 'QUEUED'`;
      await tx`UPDATE background_job SET status = ${retry ? 'QUEUED' : 'DEAD'},
        run_after = now() + (${delay} * interval '1 second'), locked_until = NULL,
        last_error_code = ${result.code}, updated_at = now() WHERE id = ${claimed.jobId}`;
      if (unknown) await tx`UPDATE conversation SET needs_attention_reason = 'SEND_OUTCOME_UNKNOWN'
        WHERE id = (SELECT conversation_id FROM conversation_message WHERE id = ${claimed.messageId})`;
      await tx`UPDATE integration_connection SET last_failure_at = now(), last_error_code = ${result.code},
        status = CASE WHEN ${result.code === 'PROVIDER_AUTH_FAILED'} THEN 'AUTH_EXPIRED'
          WHEN ${unknown} THEN 'WARNING' ELSE status END WHERE id = ${connectionId}`;
      await auditWorkerEvent(tx, claimed.messageId,
        unknown ? 'OUTBOUND_SEND_OUTCOME_UNKNOWN' : retry ? 'OUTBOUND_SEND_RETRY_SCHEDULED' : 'OUTBOUND_MESSAGE_FAILED',
        { reason: result.code, attempt: claimed.attemptNo });
    }
    await tx`DELETE FROM sender_outbound_lease WHERE sender_id = ${claimed.senderId} AND job_id = ${claimed.jobId}`;
  });
}

export async function processOneMessagingJob(db: Database,
  adapter: MessagingSendAdapter = metaWhatsAppSendAdapter): Promise<boolean> {
  const claimed = await claimOne(db);
  if (!claimed) return false;
  if (claimed.recovered) return true;
  const prepared = await prepare(db, claimed);
  if ('deferredUntil' in prepared) {
    await deferClaim(db, claimed, prepared.deferredUntil);
    return true;
  }
  if ('blocked' in prepared) {
    await finishWithoutSend(db, claimed, prepared.blocked);
    return true;
  }
  if (prepared.kind === 'TEMPLATE' && !adapter.sendTemplate) {
    await finishWithoutSend(db, claimed, 'TEMPLATE_SEND_NOT_SUPPORTED');
    return true;
  }
  let result: { providerMessageId: string } | ProviderSendError;
  try { result = prepared.kind === 'TEMPLATE'
    ? await adapter.sendTemplate!(prepared.input) : await adapter.sendText(prepared.input); }
  catch (error) { result = error instanceof ProviderSendError ? error
    : new ProviderSendError('UNKNOWN', 'PROVIDER_SEND_OUTCOME_UNKNOWN'); }
  await finishAttempt(db, claimed, prepared.connectionId, result);
  return true;
}
