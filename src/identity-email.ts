import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type postgres from 'postgres';
import type { Database } from './db.js';
import { openOpaque, openSecret, sealOpaque, type SealedSecret } from './credentials.js';
import { newToken, sha256 } from './security.js';

export type EmailSettings = { host: string; port: number; secure: boolean; username: string; fromAddress: string };
export type IdentityEmailAdapter = {
  verify(settings: EmailSettings, password: string): Promise<void>;
  send(settings: EmailSettings, password: string, message: { to: string; subject: string; text: string }): Promise<void>;
};

function transport(settings: EmailSettings, password: string) {
  return nodemailer.createTransport({
    host: settings.host, port: settings.port, secure: settings.secure, requireTLS: !settings.secure,
    auth: { user: settings.username, pass: password },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    tls: { rejectUnauthorized: true },
  });
}

export const smtpEmailAdapter: IdentityEmailAdapter = {
  async verify(settings, password) { await transport(settings, password).verify(); },
  async send(settings, password, message) {
    await transport(settings, password).sendMail({ from: settings.fromAddress, ...message });
  },
};

export type IdentityPurpose = 'INVITATION' | 'RESET';

export async function identityEmailConnection(db: Database, organizationId: string) {
  const rows = await db`SELECT c.id, c.name, c.status, c.config, s.ciphertext, s.nonce, s.auth_tag, s.key_version
    FROM identity_email_connection i JOIN integration_connection c ON c.id = i.connection_id
    LEFT JOIN connection_secret s ON s.connection_id = c.id
    WHERE i.organization_id = ${organizationId} AND c.organization_id = ${organizationId} AND c.kind = 'EMAIL' LIMIT 1`;
  return rows[0] ?? null;
}

export async function enqueueIdentityEmail(tx: postgres.TransactionSql, input: {
  userId: string; recipient: string; purpose: IdentityPurpose; connectionId: string;
}): Promise<void> {
  const token = newToken();
  const tokenRows = await tx`INSERT INTO credential_token (user_id, token_hash, purpose, expires_at)
    VALUES (${input.userId}, ${sha256(token)}, ${input.purpose}, now() + ${input.purpose === 'INVITATION' ? '48 hours' : '30 minutes'}::interval)
    RETURNING id`;
  const tokenId = String(tokenRows[0]!.id);
  const jobId = randomUUID();
  const sealed = sealOpaque(`identity-email:${jobId}`, token);
  const payload = {
    tokenId, userId: input.userId, connectionId: input.connectionId, recipient: input.recipient,
    purpose: input.purpose, ciphertext: sealed.ciphertext.toString('base64'),
    nonce: sealed.nonce.toString('base64'), authTag: sealed.authTag.toString('base64'), keyVersion: sealed.keyVersion,
  };
  await tx`INSERT INTO background_job (id, queue, kind, payload, idempotency_key)
    VALUES (${jobId}, 'identity_email', ${input.purpose}, ${tx.json(payload)}, ${`identity-token:${tokenId}`})`;
}

type IdentityJobPayload = {
  tokenId: string; userId: string; connectionId: string; recipient: string; purpose: IdentityPurpose;
  ciphertext: string; nonce: string; authTag: string; keyVersion: number;
};

export async function processOneIdentityEmailJob(db: Database, adapter: IdentityEmailAdapter = smtpEmailAdapter): Promise<boolean> {
  const job = await db.begin(async (tx) => {
    const rows = await tx`SELECT id, payload, attempts, max_attempts FROM background_job
      WHERE queue = 'identity_email' AND ((status = 'QUEUED' AND run_after <= now()) OR
        (status = 'RUNNING' AND locked_until < now()))
      ORDER BY run_after, created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows[0]) return null;
    await tx`UPDATE background_job SET status = 'RUNNING', attempts = attempts + 1,
      locked_until = now() + interval '60 seconds', updated_at = now() WHERE id = ${rows[0].id}`;
    return rows[0];
  });
  if (!job) return false;
  const payload = job.payload as IdentityJobPayload;
  try {
    const tokens = await db`SELECT t.id, t.purpose, t.used_at, t.expires_at <= now() AS expired,
      u.organization_id, u.active, u.credential_state
      FROM credential_token t JOIN user_account u ON u.id = t.user_id
      WHERE t.id = ${payload.tokenId} AND t.user_id = ${payload.userId}`;
    const tokenRow = tokens[0];
    if (!tokenRow || tokenRow.used_at || !tokenRow.active || tokenRow.purpose !== payload.purpose ||
      (payload.purpose === 'INVITATION' && tokenRow.credential_state !== 'INVITED') ||
      (payload.purpose === 'RESET' && tokenRow.credential_state !== 'READY')) {
      await db`UPDATE background_job SET status = 'SUCCEEDED', locked_until = NULL, updated_at = now()
        WHERE id = ${job.id} AND status = 'RUNNING'`;
      return true;
    }
    if (tokenRow.expired) {
      await db`UPDATE background_job SET status = 'DEAD', last_error_code = 'TOKEN_EXPIRED',
        locked_until = NULL, updated_at = now() WHERE id = ${job.id} AND status = 'RUNNING'`;
      return true;
    }
    const connections = await db`SELECT c.config, c.status, s.ciphertext AS secret_ciphertext, s.nonce AS secret_nonce,
      s.auth_tag AS secret_auth_tag, s.key_version AS secret_key_version
      FROM integration_connection c JOIN connection_secret s ON s.connection_id = c.id
      WHERE c.id = ${payload.connectionId} AND c.organization_id = ${tokenRow.organization_id} AND c.kind = 'EMAIL'`;
    const row = connections[0];
    if (!row || !['CONNECTED', 'WARNING'].includes(String(row.status))) throw new Error('EMAIL_CONNECTION_UNAVAILABLE');
    const sealed: SealedSecret = {
      ciphertext: Buffer.from(payload.ciphertext, 'base64'), nonce: Buffer.from(payload.nonce, 'base64'),
      authTag: Buffer.from(payload.authTag, 'base64'), keyVersion: payload.keyVersion,
    };
    const token = openOpaque(`identity-email:${job.id}`, sealed);
    const password = openSecret(payload.connectionId, {
      ciphertext: row.secret_ciphertext, nonce: row.secret_nonce,
      authTag: row.secret_auth_tag, keyVersion: row.secret_key_version,
    });
    const settings = row.config as EmailSettings;
    const origin = process.env.APP_ORIGIN;
    if (!origin) throw new Error('APP_ORIGIN is required');
    const url = new URL('/', origin);
    url.hash = new URLSearchParams({ [payload.purpose === 'INVITATION' ? 'invite' : 'reset']: token }).toString();
    const subject = payload.purpose === 'INVITATION' ? 'Your Lead Operations invitation' : 'Reset your Lead Operations password';
    const text = payload.purpose === 'INVITATION'
      ? `You were invited to Lead Operations. Set your password within 48 hours: ${url.toString()}\n\nدعوة إلى منصة إدارة العملاء. أنشئ كلمة المرور خلال 48 ساعة.`
      : `Reset your Lead Operations password within 30 minutes: ${url.toString()}\n\nرابط استعادة كلمة المرور صالح لمدة 30 دقيقة.`;
    await adapter.send(settings, password, { to: payload.recipient, subject, text });
    await db.begin(async (tx) => {
      await tx`UPDATE background_job SET status = 'SUCCEEDED', locked_until = NULL, updated_at = now()
        WHERE id = ${job.id} AND status = 'RUNNING'`;
      await tx`UPDATE integration_connection SET last_success_at = now(), last_error_code = NULL
        WHERE id = ${payload.connectionId}`;
    });
  } catch {
    const attempts = Number(job.attempts) + 1;
    const delay = Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
    await db.begin(async (tx) => {
      await tx`UPDATE background_job SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
        run_after = now() + (${delay} * interval '1 second'), locked_until = NULL,
        last_error_code = 'EMAIL_DELIVERY_FAILED', updated_at = now()
        WHERE id = ${job.id} AND status = 'RUNNING'`;
      await tx`UPDATE integration_connection SET last_failure_at = now(), last_error_code = 'EMAIL_DELIVERY_FAILED',
        status = CASE WHEN status = 'CONNECTED' THEN 'WARNING' ELSE status END
        WHERE id = ${payload.connectionId}`;
    });
  }
  return true;
}
