import type postgres from 'postgres';
import { rankHumanPerformance, sampleHumanPerformance, type PerformancePolicy } from './performance-routing.js';

type Candidate = { id: string; weight: number; assigned_count: number; capacity: number | null; working_hours: unknown };
type BaselineMethod = 'MANUAL' | 'ROUND_ROBIN' | 'WEIGHTED';
type Decision = { agentId: string | null; reason: string };

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

function eligibleAgents(candidates: Candidate[], timezone: string, at: Date): Candidate[] {
  return candidates.filter((agent) => (agent.capacity == null || agent.assigned_count < agent.capacity)
    && isWithinWorkingHours(agent.working_hours, timezone, at));
}

function assignFromEligible(eligible: Candidate[], method: BaselineMethod): Decision {
  if (!eligible.length) return { agentId: null, reason: 'NO_ELIGIBLE_AGENT' };
  if (method === 'MANUAL') return { agentId: null, reason: 'MANUAL_ROUTING' };
  const weighted = method === 'WEIGHTED';
  eligible.sort((a, b) => {
    const left = a.assigned_count / (weighted ? a.weight : 1);
    const right = b.assigned_count / (weighted ? b.weight : 1);
    return left - right || a.id.localeCompare(b.id);
  });
  return { agentId: eligible[0]!.id, reason: method };
}

export function chooseAgent(candidates: Candidate[], method: BaselineMethod, timezone: string, at = new Date()): Decision {
  return assignFromEligible(eligibleAgents(candidates, timezone, at), method);
}

async function performanceDecision(
  tx: postgres.TransactionSql, campaignId: string, branchId: string, eligible: Candidate[], at: Date,
) {
  const [policy] = await tx<PerformancePolicy[]>`SELECT version,lookback_days,minimum_samples,response_weight,
    follow_up_weight,fallback_method FROM campaign_performance_routing_policy WHERE campaign_id=${campaignId}`;
  if (!policy) return { agentId: null, reason: 'PERFORMANCE_POLICY_REQUIRED' };
  const evidence = { policyVersion: policy.version, evaluatedAt: at.toISOString() };
  if (!eligible.length) return { agentId: null, reason: 'NO_ELIGIBLE_AGENT', performance: evidence };
  const samples = await sampleHumanPerformance(tx, campaignId, branchId, eligible.map(agent => agent.id), policy, at);
  const winner = rankHumanPerformance(eligible, samples, policy);
  if (!winner) {
    const fallback = assignFromEligible(eligible, policy.fallback_method);
    return { agentId: fallback.agentId, reason: 'INSUFFICIENT_HUMAN_SAMPLE_FALLBACK',
      performance: { ...evidence, fallbackMethod: policy.fallback_method } };
  }
  return { agentId: winner.candidate.id, reason: 'HUMAN_PERFORMANCE',
    performance: { ...evidence, score: winner.score, sample: winner.sample } };
}

export async function routeLead(tx: postgres.TransactionSql, campaignId: string, branchId: string, method: string, timezone: string, leadId: string): Promise<void> {
  // Capacity is branch-wide, so serialize decisions across campaigns in this branch.
  await tx`SELECT id FROM branch WHERE id = ${branchId} FOR NO KEY UPDATE`;
  await tx`SELECT id FROM campaign WHERE id = ${campaignId} FOR NO KEY UPDATE`;
  const rows = await tx`
    WITH membership AS MATERIALIZED (
      SELECT u.id, ca.weight, COALESCE(ca.capacity_override, u.capacity) AS capacity, u.working_hours
      FROM campaign_agent ca JOIN user_account u ON u.id = ca.agent_id
      WHERE ca.campaign_id = ${campaignId} AND ca.active AND u.active
        AND u.role = 'AGENT' AND u.branch_id = ${branchId}
      ORDER BY u.id FOR SHARE OF u
    )
    SELECT m.*, (SELECT count(*)::integer FROM lead l WHERE l.assigned_agent_id=m.id AND l.lifecycle='OPEN') AS assigned_count
    FROM membership m`;
  const candidates: Candidate[] = rows.map((row) => ({ id: String(row.id), weight: Number(row.weight),
    assigned_count: Number(row.assigned_count), capacity: row.capacity == null ? null : Number(row.capacity),
    working_hours: row.working_hours }));
  const at = new Date();
  if (method !== 'MANUAL' && method !== 'ROUND_ROBIN' && method !== 'WEIGHTED' && method !== 'PERFORMANCE') {
    throw new Error('Invalid campaign routing method');
  }
  const decision = method === 'PERFORMANCE'
    ? await performanceDecision(tx, campaignId, branchId, eligibleAgents(candidates, timezone, at), at)
    : chooseAgent(candidates, method, timezone, at);
  if (decision.agentId) await tx`UPDATE lead SET assigned_agent_id = ${decision.agentId}, updated_at = now() WHERE id = ${leadId}`;
  else if (decision.reason !== 'MANUAL_ROUTING') await tx`UPDATE lead SET needs_attention_reason = ${decision.reason} WHERE id = ${leadId}`;
  const [history] = await tx`INSERT INTO assignment_history (lead_id, new_branch_id, new_agent_id, method, reason)
    VALUES (${leadId}, ${branchId}, ${decision.agentId}, ${method}, ${decision.reason}) RETURNING id`;
  const detail = tx.json({ method, ...decision, assignmentHistoryId: String(history!.id) });
  await tx`INSERT INTO lead_activity (lead_id, event_type, detail) VALUES (${leadId}, 'ROUTING_DECISION', ${detail})`;
  if (method === 'PERFORMANCE') {
    await tx`INSERT INTO audit_log (organization_id, branch_id, action, target_type, target_id, detail)
      SELECT organization_id, branch_id, 'LEAD_PERFORMANCE_ROUTED', 'LEAD', id, ${detail} FROM lead WHERE id=${leadId}`;
  }
}
