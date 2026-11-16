import type { Database } from './db.js';
import type postgres from 'postgres';
import type { CalculationKind } from './fields.js';

export async function calculateLeadFields(db: Database | postgres.TransactionSql, leadId: string, kinds: CalculationKind[]): Promise<Record<string, unknown>> {
  return (await calculateLeadFieldsBatch(db,[leadId],kinds))[leadId]??{};
}

// Bounded multi-Lead readers (Export) use the same facts and interpretation as Lead details.
export async function calculateLeadFieldsBatch(db: Database | postgres.TransactionSql, leadIds: string[], kinds: CalculationKind[]): Promise<Record<string,Record<string,unknown>>> {
  if (kinds.length === 0) return {};
  if(leadIds.length===0)return {};
  if(leadIds.length>100)throw new Error('Calculated field page exceeds bound');
  const rows = await db`WITH facts AS (SELECT l.id,l.created_at,
    min(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.sent_at IS NOT NULL) AS first_platform_contact,
    min(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'AI' AND m.sent_at IS NOT NULL) AS first_ai_contact,
    min(m.sent_at) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'HUMAN' AND m.sent_at IS NOT NULL) AS first_human_contact,
    max(coalesce(m.sent_at, m.received_at)) AS last_contact,
    count(m.id) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'AI' AND m.sent_at IS NOT NULL)::integer AS ai_attempts,
    count(m.id) FILTER (WHERE m.direction = 'OUTBOUND' AND m.author_type = 'HUMAN' AND m.sent_at IS NOT NULL)::integer AS human_attempts,
    min(m.received_at) FILTER (WHERE m.direction = 'INBOUND' AND m.received_at IS NOT NULL) AS first_inbound
    FROM lead l LEFT JOIN conversation cv ON cv.lead_id = l.id
      LEFT JOIN conversation_message m ON m.conversation_id = cv.id
    WHERE l.id IN ${db(leadIds)} GROUP BY l.id)
    SELECT facts.*,(SELECT min(m.sent_at) FROM conversation cv JOIN conversation_message m ON m.conversation_id=cv.id
     WHERE cv.lead_id=facts.id AND m.direction='OUTBOUND' AND m.author_type='HUMAN' AND m.sent_at>=facts.first_inbound) AS first_response FROM facts`;
  const result:Record<string,Record<string,unknown>>={},now=Date.now();
  for(const row of rows){
  const firstHuman = row.first_human_contact as Date | null;
  const firstInbound = row.first_inbound as Date | null;
  const lastContact = row.last_contact as Date | null;
  let humanResponseSeconds: number | null = null;
  if (firstInbound && kinds.includes('HUMAN_RESPONSE_SECONDS')) {
    const firstResponse = row.first_response as Date | null;
    if (firstResponse) humanResponseSeconds = Math.max(0, Math.floor((firstResponse.getTime() - firstInbound.getTime()) / 1000));
  }
  const ageSeconds = Math.max(0, now - (row.created_at as Date).getTime()) / 1000;
  const values: Record<CalculationKind, unknown> = {
    LEAD_AGE_DAYS: Math.floor(ageSeconds / 86400),
    FIRST_PLATFORM_CONTACT_AT: (row.first_platform_contact as Date | null)?.toISOString() ?? null,
    FIRST_AI_CONTACT_AT: (row.first_ai_contact as Date | null)?.toISOString() ?? null,
    FIRST_HUMAN_CONTACT_AT: firstHuman?.toISOString() ?? null,
    TIME_SINCE_LAST_CONTACT_SECONDS: lastContact ? Math.max(0, Math.floor((now - lastContact.getTime()) / 1000)) : null,
    AI_CONTACT_ATTEMPTS: row.ai_attempts,
    HUMAN_CONTACT_ATTEMPTS: row.human_attempts,
    HUMAN_RESPONSE_SECONDS: humanResponseSeconds,
  };
  result[row.id]=Object.fromEntries(kinds.map((kind) => [kind, values[kind]]));
  }
  return result;
}
