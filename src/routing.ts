import type postgres from 'postgres';

type Candidate = { id: string; weight: number; assigned_count: number; capacity: number | null; working_hours: unknown };

export function isWithinWorkingHours(hours: unknown, timezone: string, instant = new Date()): boolean {
  if (!hours || typeof hours !== 'object' || Array.isArray(hours) || !Object.keys(hours).length) return true;
  const format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
  const key = parts.weekday?.toLowerCase();
  const ranges = (hours as Record<string, unknown>)[key ?? ''];
  if (!Array.isArray(ranges)) return false;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return ranges.some((range) => {
    if (!Array.isArray(range) || range.length !== 2 || typeof range[0] !== 'string' || typeof range[1] !== 'string') return false;
    const parse = (value: string) => { const match = /^(\d{2}):(\d{2})$/.exec(value); return match ? Number(match[1]) * 60 + Number(match[2]) : NaN; };
    const start = parse(range[0]); const end = parse(range[1]);
    return Number.isFinite(start) && Number.isFinite(end) && start <= minute && minute < end;
  });
}

export function chooseAgent(candidates: Candidate[], method: string, timezone: string, at = new Date()): { agentId: string | null; reason: string } {
  const eligible = candidates.filter((agent) => (agent.capacity == null || agent.assigned_count < agent.capacity)
    && isWithinWorkingHours(agent.working_hours, timezone, at));
  if (!eligible.length) return { agentId: null, reason: 'NO_ELIGIBLE_AGENT' };
  if (method === 'MANUAL') return { agentId: null, reason: 'MANUAL_ROUTING' };
  // Historical human-performance sampling is required before performance routing can score agents.
  // Until then use the campaign's fair fallback rather than an invented score.
  const weighted = method === 'WEIGHTED';
  eligible.sort((a, b) => {
    const left = a.assigned_count / (weighted ? a.weight : 1);
    const right = b.assigned_count / (weighted ? b.weight : 1);
    return left - right || a.id.localeCompare(b.id);
  });
  return { agentId: eligible[0]!.id, reason: method === 'PERFORMANCE' ? 'INSUFFICIENT_HUMAN_SAMPLE_FALLBACK' : method };
}

export async function routeLead(tx: postgres.TransactionSql, campaignId: string, branchId: string, method: string, timezone: string, leadId: string): Promise<void> {
  // Capacity is branch-wide, so serialize decisions across campaigns in this branch.
  await tx`SELECT id FROM branch WHERE id = ${branchId} FOR NO KEY UPDATE`;
  await tx`SELECT id FROM campaign WHERE id = ${campaignId} FOR NO KEY UPDATE`;
  const rows = await tx`
    SELECT u.id, ca.weight,
      COALESCE(ca.capacity_override, u.capacity) AS capacity,
      u.working_hours,
      count(l.id)::integer AS assigned_count
    FROM campaign_agent ca JOIN user_account u ON u.id = ca.agent_id
      LEFT JOIN lead l ON l.assigned_agent_id = u.id AND l.lifecycle = 'OPEN'
    WHERE ca.campaign_id = ${campaignId} AND ca.active = true AND u.active = true
      AND u.role = 'AGENT' AND u.branch_id = ${branchId}
    GROUP BY u.id, ca.weight, ca.capacity_override, u.capacity, u.working_hours`;
  const candidates: Candidate[] = rows.map((row) => ({ id: String(row.id), weight: Number(row.weight),
    assigned_count: Number(row.assigned_count), capacity: row.capacity == null ? null : Number(row.capacity),
    working_hours: row.working_hours }));
  const decision = chooseAgent(candidates, method, timezone);
  if (decision.agentId) await tx`UPDATE lead SET assigned_agent_id = ${decision.agentId}, updated_at = now() WHERE id = ${leadId}`;
  else if (decision.reason !== 'MANUAL_ROUTING') await tx`UPDATE lead SET needs_attention_reason = ${decision.reason} WHERE id = ${leadId}`;
  await tx`INSERT INTO assignment_history (lead_id, new_branch_id, new_agent_id, method, reason)
    VALUES (${leadId}, ${branchId}, ${decision.agentId}, ${method}, ${decision.reason})`;
  await tx`INSERT INTO lead_activity (lead_id, event_type, detail)
    VALUES (${leadId}, 'ROUTING_DECISION', ${tx.json({ method, reason: decision.reason, agentId: decision.agentId })})`;
}
