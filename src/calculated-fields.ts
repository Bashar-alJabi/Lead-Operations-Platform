import type { Database } from './db.js';
import type postgres from 'postgres';
import type { CalculationKind } from './fields.js';

export async function calculateLeadFields(db: Database | postgres.TransactionSql, leadId: string, kinds: CalculationKind[]): Promise<Record<string, unknown>> {
  if (kinds.length === 0) return {};
  const rows = await db`SELECT l.created_at,
    min(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.sent_at IS NOT NULL) AS first_platform_contact,
    min(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'AI' AND m.sent_at IS NOT NULL) AS first_ai_contact,
    min(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'HUMAN' AND m.sent_at IS NOT NULL) AS first_human_contact,
    max(coalesce(m.sent_at, m.received_at)) AS last_contact,
    count(m.id) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'AI' AND m.sent_at IS NOT NULL)::integer AS ai_attempts,
    count(m.id) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'HUMAN' AND m.sent_at IS NOT NULL)::integer AS human_attempts,
    min(m.received_at) FILTER (WHERE m.direction = 'INBOUND' AND m.received_at IS NOT NULL) AS first_inbound
    FROM lead l LEFT JOIN conversation cv ON cv.lead_id = l.id
      LEFT JOIN conversation_message m ON m.conversation_id = cv.id
    WHERE l.id = ${leadId} GROUP BY l.id`;
  const row = rows[0];
  if (!row) return {};
  const firstHuman = row.first_human_contact as Date | null;
  const firstInbound = row.first_inbound as Date | null;
  const lastContact = row.last_contact as Date | null;
  let humanResponseSeconds: number | null = null;
  if (firstInbound && kinds.includes('HUMAN_RESPONSE_SECONDS')) {
    const response = await db`SELECT min(m.sent_at) AS first_response FROM conversation cv
      JOIN conversation_message m ON m.conversation_id = cv.id
      WHERE cv.lead_id = ${leadId} AND m.direction = 'OUTBOUND' AND m.author_type = 'HUMAN'
        AND m.sent_at >= ${firstInbound}`;
    const firstResponse = response[0]?.first_response as Date | null;
    if (firstResponse) humanResponseSeconds = Math.max(0, Math.floor((firstResponse.getTime() - firstInbound.getTime()) / 1000));
  }
  const ageSeconds = Math.max(0, Date.now() - (row.created_at as Date).getTime()) / 1000;
  const values: Record<CalculationKind, unknown> = {
    LEAD_AGE_DAYS: Math.floor(ageSeconds / 86400),
    FIRST_PLATFORM_CONTACT_AT: (row.first_platform_contact as Date | null)?.toISOString() ?? null,
    FIRST_AI_CONTACT_AT: (row.first_ai_contact as Date | null)?.toISOString() ?? null,
    FIRST_HUMAN_CONTACT_AT: firstHuman?.toISOString() ?? null,
    TIME_SINCE_LAST_CONTACT_SECONDS: lastContact ? Math.max(0, Math.floor((Date.now() - lastContact.getTime()) / 1000)) : null,
    AI_CONTACT_ATTEMPTS: row.ai_attempts,
    HUMAN_CONTACT_ATTEMPTS: row.human_attempts,
    HUMAN_RESPONSE_SECONDS: humanResponseSeconds,
  };
  return Object.fromEntries(kinds.map((kind) => [kind, values[kind]]));
}
