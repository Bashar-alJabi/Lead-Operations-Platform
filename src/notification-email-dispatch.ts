import type postgres from 'postgres';
import type { Database } from './db.js';
import { openSecret } from './credentials.js';
import type { EmailSettings, NotificationSmtpSend } from './identity-email.js';
import { notificationDefaultsByEvent, renderNotification, type NotificationEventType, type NotificationLanguage } from './notifications.js';

// The envelope must contain one bare address. Reject display names, address lists and control characters.
export function isNotificationMailbox(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 254) return false;
  const [local, domain, extra] = value.split('@');
  if (!local || !domain || extra !== undefined || Buffer.byteLength(local) > 64) return false;
  const atoms = /^[\p{L}\p{M}\p{N}!#$%&'*+\-/=?^_`{|}~]+$/u;
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  const labels = domain.split('.');
  return local.split('.').every(part => atoms.test(part)) && labels.length > 1 && labels.every(part => label.test(part));
}

const singleLine = (value: string) => value.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ');

type DispatchPayload = {
  id: string;
  connectionId: string;
  settings: EmailSettings;
  password: string;
  message: { to: string; subject: string; text: string };
};

export async function lockEmailDispatch(tx: postgres.TransactionSql, id: string, connectionId: string) {
  if (!(await tx`SELECT id FROM integration_connection WHERE id=${connectionId} FOR UPDATE SKIP LOCKED`).length) return;
  return (await tx`SELECT * FROM notification_email_dispatch WHERE outbox_id=${id} FOR UPDATE`)[0];
}

async function prepareEmail(db: Database): Promise<DispatchPayload | boolean> {
  return db.begin(async tx => {
    await tx`SET LOCAL statement_timeout='5s'`;
    await tx`SET LOCAL lock_timeout='750ms'`;
    const expired = (await tx`SELECT outbox_id,connection_id FROM notification_email_dispatch
      WHERE state='SENDING' AND lease_until<=clock_timestamp() ORDER BY lease_until,outbox_id LIMIT 1`)[0];
    if (expired) {
      const claim = await lockEmailDispatch(tx, expired.outbox_id, expired.connection_id);
      if (claim?.state === 'SENDING') {
        await tx`UPDATE notification_email_dispatch SET state='UNKNOWN' WHERE outbox_id=${expired.outbox_id}`;
        return true;
      }
    }
    const candidates = await tx`SELECT d.outbox_id,d.connection_id FROM notification_email_dispatch d
      WHERE d.state='WAITING' AND d.run_at<=clock_timestamp() AND NOT EXISTS (
        SELECT 1 FROM notification_email_dispatch busy WHERE busy.connection_id=d.connection_id AND busy.state='SENDING'
      ) ORDER BY d.run_at,d.outbox_id LIMIT 20`;
    for (const candidate of candidates) {
      const id = candidate.outbox_id as string;
      const connectionId = candidate.connection_id as string;
      const job = await lockEmailDispatch(tx, id, connectionId);
      if (!job || job.state !== 'WAITING') continue;
      if ((await tx`SELECT 1 FROM notification_email_dispatch WHERE connection_id=${connectionId} AND state='SENDING'`).length) continue;
      const status = (await tx`SELECT d.run_at<=clock_timestamp() AS ready,
        notification_email_recipient_allowed(o.event_id,o.user_id) AS permitted
        FROM notification_email_dispatch d JOIN notification_email_outbox o ON o.id=d.outbox_id WHERE d.outbox_id=${id}`)[0]!;
      if (!status.ready) continue;
      if (!status.permitted) {
        await tx`UPDATE notification_email_dispatch SET state='SUPPRESSED' WHERE outbox_id=${id}`;
        return true;
      }
      const [row] = await tx`SELECT u.email,c.config,s.ciphertext,s.nonce,s.auth_tag,s.key_version,e.event_type,
          e.organization_id,e.branch_id,e.campaign_id,campaign.name AS campaign_name,owner.name AS owner_name
        FROM notification_email_outbox o JOIN notification_event e ON e.id=o.event_id
        LEFT JOIN lead l ON l.id=e.lead_id LEFT JOIN campaign ON campaign.id=e.campaign_id
        JOIN user_account u ON u.id=o.user_id JOIN integration_connection c ON c.id=${connectionId}
        JOIN connection_secret s ON s.connection_id=c.id
        LEFT JOIN follow_up f ON f.id=e.follow_up_id
        LEFT JOIN user_account owner ON owner.id=COALESCE(f.owner_user_id,l.assigned_agent_id)
          AND owner.organization_id=e.organization_id AND owner.branch_id=e.branch_id
        WHERE o.id=${id} AND c.status='CONNECTED' AND u.credential_state='READY'`;
      const settings = row?.config as EmailSettings | undefined;
      let password: string | undefined;
      if (row && settings && isNotificationMailbox(row.email) && isNotificationMailbox(settings.fromAddress)) {
        try {
          password = openSecret(connectionId, { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag, keyVersion: row.key_version });
        } catch {
          // Configuration or credential repair is required. The durable job stores a generic error.
        }
      }
      if (!password || !row || !settings) {
        await tx`UPDATE notification_email_dispatch SET state='WAITING' WHERE outbox_id=${id}`;
        return true;
      }
      const [attempt] = await tx`INSERT INTO notification_email_attempt(outbox_id) VALUES(${id})
        RETURNING language,template_scope,template_version`;
      const language = attempt!.language as NotificationLanguage;
      const fallback = notificationDefaultsByEvent[row.event_type as NotificationEventType][language];
      let wording = fallback;
      if (attempt!.template_scope !== 'DEFAULT') {
        const resourceId = { CAMPAIGN: row.campaign_id, BRANCH: row.branch_id, GLOBAL: row.organization_id }[
          attempt!.template_scope as 'CAMPAIGN' | 'BRANCH' | 'GLOBAL'
        ];
        const [template] = await tx`SELECT title,body FROM notification_template WHERE scope=${attempt!.template_scope}
          AND resource_id=${resourceId} AND organization_id=${row.organization_id} AND event_type=${row.event_type}
          AND channel='EMAIL' AND language=${language} AND version=${attempt!.template_version}`;
        if (!template) throw Error('Selected notification wording is unavailable');
        wording = { title: template.title, body: template.body, owner: fallback.owner };
      }
      const values = { campaign: singleLine(row.campaign_name ?? ''), owner: singleLine(row.owner_name ?? fallback.owner) };
      const message = { to: row.email as string, subject: singleLine(renderNotification(wording.title, values)), text: renderNotification(wording.body, values) };
      await tx`UPDATE notification_email_dispatch SET state='SENDING' WHERE outbox_id=${id}`;
      return { id, connectionId, settings, password, message };
    }
    return false;
  });
}

export async function processOneNotificationEmail(db: Database, send: NotificationSmtpSend): Promise<boolean> {
  const payload = await prepareEmail(db);
  if (typeof payload === 'boolean') return payload;

  // The attempt has committed. Recheck the lease and privacy-sensitive inputs before provider I/O.
  const maySend = await db.begin(async tx => {
    await tx`SET LOCAL lock_timeout='750ms'`;
    await tx`SELECT id FROM integration_connection WHERE id=${payload.connectionId} FOR SHARE`;
    const [job] = await tx`SELECT state,lease_until>clock_timestamp() AS live FROM notification_email_dispatch
      WHERE outbox_id=${payload.id} FOR UPDATE`;
    if (!job?.live || job.state !== 'SENDING') return false;
    const [authority] = await tx`SELECT notification_email_dispatch_allowed(${payload.id}) AS allowed`;
    const [address] = await tx`SELECT u.email=${payload.message.to} AND pref.version=a.preference_version
        AND COALESCE(wording.scope,'DEFAULT')=a.template_scope
        AND COALESCE(wording.version,0)=a.template_version AS unchanged
      FROM notification_email_outbox o JOIN user_account u ON u.id=o.user_id
      JOIN notification_event e ON e.id=o.event_id JOIN notification_email_attempt a ON a.outbox_id=o.id
      LEFT JOIN notification_email_preference pref ON pref.user_id=u.id AND pref.event_type=e.event_type
      LEFT JOIN LATERAL (
        SELECT t.scope,t.version FROM notification_template t
        WHERE t.organization_id=e.organization_id AND t.channel='EMAIL' AND t.event_type=e.event_type
          AND t.language=pref.language AND t.active
          AND ((t.scope='CAMPAIGN' AND t.resource_id=e.campaign_id AND t.branch_id=e.branch_id)
            OR (t.scope='BRANCH' AND t.resource_id=e.branch_id AND t.branch_id=e.branch_id)
            OR (t.scope='GLOBAL' AND t.resource_id=e.organization_id AND t.branch_id IS NULL))
        ORDER BY CASE t.scope WHEN 'CAMPAIGN' THEN 1 WHEN 'BRANCH' THEN 2 ELSE 3 END LIMIT 1 FOR SHARE
      ) wording ON true
      WHERE o.id=${payload.id}`;
    if (authority?.allowed && address?.unchanged) return true;
    await tx`UPDATE notification_email_dispatch SET state='SUPPRESSED' WHERE outbox_id=${payload.id}`;
    return false;
  });
  if (!maySend) return true;

  let state: 'ACCEPTED' | 'UNKNOWN';
  try {
    await send(payload.settings, payload.password, payload.message);
    state = 'ACCEPTED';
  } catch {
    state = 'UNKNOWN';
  }
  await db`UPDATE notification_email_dispatch SET state=${state} WHERE outbox_id=${payload.id} AND state='SENDING'`;
  return true;
}
