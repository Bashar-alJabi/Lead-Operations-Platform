import type postgres from 'postgres';

export type PerformancePolicy = {
  version: number;
  lookback_days: number;
  minimum_samples: number;
  response_weight: number;
  follow_up_weight: number;
  fallback_method: 'MANUAL' | 'ROUND_ROBIN' | 'WEIGHTED';
};

export type HumanSample = {
  id: string;
  replies: number;
  responseSeconds: number | null;
  followUps: number;
  onTime: number;
};

export function rankHumanPerformance(
  candidates: { id: string; assigned_count: number }[],
  samples: HumanSample[],
  policy: PerformancePolicy,
) {
  const byAgent = new Map(samples.map(sample => [sample.id, sample]));
  const ranked = [];
  for (const candidate of candidates) {
    const sample = byAgent.get(candidate.id);
    // Use the campaign fallback for the whole pool so staff without history remain eligible.
    if (!sample || (policy.response_weight > 0 &&
      (sample.replies < policy.minimum_samples || sample.responseSeconds === null)) ||
      (policy.follow_up_weight > 0 && sample.followUps < policy.minimum_samples)) return null;
    const responseScore = policy.response_weight > 0
      ? policy.response_weight / (1 + sample.responseSeconds! / 3600) : 0;
    const followUpScore = policy.follow_up_weight > 0
      ? policy.follow_up_weight * sample.onTime / sample.followUps : 0;
    ranked.push({ candidate, sample, score: responseScore + followUpScore });
  }
  ranked.sort((a, b) => b.score - a.score || a.candidate.assigned_count - b.candidate.assigned_count ||
    a.candidate.id.localeCompare(b.candidate.id));
  return ranked[0] ?? null;
}

export async function sampleHumanPerformance(
  tx: postgres.TransactionSql, campaignId: string, branchId: string, agentIds: string[],
  policy: PerformancePolicy, at: Date,
): Promise<HumanSample[]> {
  return tx<HumanSample[]>`
    WITH cutoff AS (
      SELECT ${at}::timestamptz AS until, ${at}::timestamptz - make_interval(days=>${policy.lookback_days}) AS since
    ), first_replies AS (
      SELECT DISTINCT ON (m.author_user_id,c.lead_id)
        m.author_user_id, extract(epoch FROM (m.sent_at-customer.received_at)) AS seconds
      FROM conversation_message m
      JOIN conversation c ON c.id=m.conversation_id
      JOIN lead l ON l.id=c.lead_id AND l.campaign_id=${campaignId} AND l.branch_id=${branchId}
      CROSS JOIN cutoff w
      JOIN LATERAL (
        SELECT i.received_at FROM conversation_message i
        WHERE i.conversation_id=c.id AND i.direction='INBOUND' AND i.author_type='CUSTOMER'
          AND i.received_at>=w.since AND i.received_at<=m.sent_at
        ORDER BY i.received_at LIMIT 1
      ) customer ON true
      WHERE ${policy.response_weight}>0 AND m.author_user_id=ANY(${agentIds}::uuid[])
        AND m.direction='OUTBOUND' AND m.author_type='HUMAN' AND m.delivery_state IN ('SENT','DELIVERED','READ')
        AND m.sent_at>=w.since AND m.sent_at<=w.until
      ORDER BY m.author_user_id,c.lead_id,m.sent_at,m.id
    ), replies AS (
      SELECT author_user_id, count(*)::integer AS total, avg(seconds)::double precision AS seconds
      FROM first_replies GROUP BY author_user_id
    ), tasks AS (
      SELECT f.owner_user_id, count(*)::integer AS total,
        count(*) FILTER (WHERE f.status='COMPLETED' AND f.completed_at<=f.due_at)::integer AS on_time
      FROM follow_up f
      JOIN lead l ON l.id=f.lead_id AND l.campaign_id=${campaignId} AND l.branch_id=${branchId}
      CROSS JOIN cutoff w
      WHERE ${policy.follow_up_weight}>0 AND f.owner_user_id=ANY(${agentIds}::uuid[])
        AND f.kind='HUMAN' AND f.status IN ('OPEN','COMPLETED') AND f.due_at>=w.since AND f.due_at<=w.until
        AND (f.status='OPEN' OR f.completed_by=f.owner_user_id AND f.completed_at<=w.until)
      GROUP BY f.owner_user_id
    )
    SELECT a.id, COALESCE(r.total,0) AS replies, r.seconds AS "responseSeconds",
      COALESCE(t.total,0) AS "followUps", COALESCE(t.on_time,0) AS "onTime"
    FROM unnest(${agentIds}::uuid[]) AS a(id)
    LEFT JOIN replies r ON r.author_user_id=a.id
    LEFT JOIN tasks t ON t.owner_user_id=a.id`;
}
