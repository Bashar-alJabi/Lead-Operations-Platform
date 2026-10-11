import type postgres from 'postgres';
// Caller already holds current Branch/Lead/Conversation access locks. No model/provider dependency.
export async function currentHandoffReception(tx: postgres.TransactionSql, actionId: string | null) {
  if (!actionId) return null;
  const a = (await tx`SELECT conversation_id,lead_id,campaign_id,context->'scope'->>'branchId' AS branch_id FROM ai_customer_handoff_action WHERE id=${actionId}`)[0];
  if (!a) return null;
  await tx`SELECT resource_id FROM ai_operational_config WHERE branch_id=${a.branch_id} AND (scope='BRANCH' OR campaign_id=${a.campaign_id}) ORDER BY scope,resource_id FOR SHARE`;
  const ids = (await tx`SELECT DISTINCT id FROM (
    SELECT assigned_agent_id AS id FROM lead WHERE id=${a.lead_id}
    UNION ALL SELECT (definition->>'handoffTargetId')::uuid FROM ai_operational_config WHERE branch_id=${a.branch_id} AND (scope='BRANCH' OR campaign_id=${a.campaign_id})
  ) candidates WHERE id IS NOT NULL`).map(r => r.id as string);
  if (ids.length) {
    await tx`SELECT id FROM user_account WHERE id IN ${tx(ids)} ORDER BY id FOR SHARE`;
    await tx`SELECT agent_id FROM campaign_agent WHERE campaign_id=${a.campaign_id} AND agent_id IN ${tx(ids)} ORDER BY agent_id FOR SHARE`;
  }
  return (await tx`SELECT ai_handoff_reception(${actionId},clock_timestamp()) AS reception`)[0]!.reception;
}
