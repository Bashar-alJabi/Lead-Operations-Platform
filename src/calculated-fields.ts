import type { Database } from './db.js';
import type postgres from 'postgres';
import type { CalculationKind } from './fields.js';

export async function calculateLeadFields(db: Database | postgres.TransactionSql, leadId: string, kinds: CalculationKind[]): Promise<Record<string, unknown>> {
  return (await calculateLeadFieldsBatch(db,[leadId],kinds))[leadId]??{};
}

// Callers pass only authorized Lead IDs. The same SQL values drive server-side filters.
export async function calculateLeadFieldsBatch(db: Database | postgres.TransactionSql, leadIds: string[], kinds: CalculationKind[]): Promise<Record<string,Record<string,unknown>>> {
  if (kinds.length === 0) return {};
  if(leadIds.length===0)return {};
  if(leadIds.length>100)throw new Error('Calculated field page exceeds bound');
  const rows = await db<{id:string;values:Record<string,unknown>}[]>`
    SELECT id, lead_calculated_field_values(id, created_at, ${db.array(kinds)}::text[]) AS values
    FROM lead WHERE id IN ${db(leadIds)}`;
  return Object.fromEntries(rows.map(row => [row.id,row.values]));
}
