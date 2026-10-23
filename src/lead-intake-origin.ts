import type postgres from 'postgres';
import { HttpError } from './security.js';

// Call only within the real intake transaction, after source processing and Routing have completed.
export async function recordLeadIntakeOrigin(tx: postgres.TransactionSql, leadId: string, submissionId: string,
  authority: { kind: 'HUMAN_MANUAL'; actorId: string; sessionId: string } | { kind: 'SOURCE' }) {
  const routing = (await tx`SELECT id FROM assignment_history WHERE lead_id=${leadId} ORDER BY id DESC LIMIT 1`)[0];
  if (!routing) throw new HttpError(409, 'LEAD_INTAKE_ROUTING_REQUIRED');
  return (await tx`INSERT INTO lead_intake_receipt(lead_id,submission_id,routing_history_id,origin_kind,actor_id,session_id)
    VALUES(${leadId},${submissionId},${routing.id},${authority.kind},${authority.kind === 'HUMAN_MANUAL' ? authority.actorId : null},
      ${authority.kind === 'HUMAN_MANUAL' ? authority.sessionId : null}) RETURNING id`)[0]!.id as string;
}
