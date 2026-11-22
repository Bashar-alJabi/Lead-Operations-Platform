import type postgres from 'postgres';

export async function leadActivityBoundary(tx: postgres.TransactionSql, leadId: string, includeAllScopes: boolean) {
  if (includeAllScopes) return null;
  const [transfer] = await tx`SELECT id FROM lead_activity WHERE lead_id=${leadId} AND event_type='LEAD_BRANCH_TRANSFERRED'
    ORDER BY created_at DESC,id DESC LIMIT 1`;
  return transfer?.id ?? null;
}
