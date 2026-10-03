import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError } from '../security.js';
import { resolveSender, type SenderSelection, type Sender } from './policy.js';

type Sql = Database | postgres.TransactionSql;

export async function resolveConfiguredSender(sql: Sql, input: { organizationId: string; branchId: string;
  campaignId: string; pinnedSenderId?: string | null }): Promise<SenderSelection> {
  const config = (await sql`SELECT b.default_sender_id, c.sender_override_id FROM campaign c
    JOIN branch b ON b.id = c.branch_id WHERE c.id = ${input.campaignId}
      AND c.branch_id = ${input.branchId} AND c.organization_id = ${input.organizationId}`)[0];
  if (!config) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
  const configured = input.pinnedSenderId ?? config.sender_override_id ?? config.default_sender_id;
  const rows = configured ? await sql`SELECT s.id, s.connection_id, s.active, s.operator_enabled,
      s.health, s.capabilities, c.status AS connection_status, c.branch_id AS connection_branch_id,
      b.branch_id AS binding_branch_id, b.allow_shared_fallback
    FROM messaging_sender s JOIN integration_connection c ON c.id = s.connection_id
    LEFT JOIN sender_branch_binding b ON b.sender_id = s.id AND b.branch_id = ${input.branchId}
    WHERE s.id = ${configured} AND s.organization_id = ${input.organizationId} AND c.kind = 'MESSAGING'`
    : await sql`SELECT s.id, s.connection_id, s.active, s.operator_enabled,
      s.health, s.capabilities, c.status AS connection_status, c.branch_id AS connection_branch_id,
      b.branch_id AS binding_branch_id, b.allow_shared_fallback
    FROM sender_branch_binding b JOIN messaging_sender s ON s.id = b.sender_id
    JOIN integration_connection c ON c.id = s.connection_id
    WHERE b.branch_id = ${input.branchId} AND b.allow_shared_fallback
      AND c.branch_id IS NULL AND c.kind = 'MESSAGING' AND s.organization_id = ${input.organizationId}
    ORDER BY s.id LIMIT 2`;
  const senders: Sender[] = rows.map((row) => {
    const inScope = row.connection_branch_id === input.branchId || row.binding_branch_id === input.branchId;
    return { id: row.id, connectionId: row.connection_id, active: row.active && row.operator_enabled,
      health: row.health, connectionStatus: row.connection_status,
      branchIds: inScope ? [input.branchId] : [],
      sharedFallbackBranchIds: row.connection_branch_id === null && row.allow_shared_fallback ? [input.branchId] : [],
      supportsText: row.capabilities?.text === true,
      supportsTemplate: row.capabilities?.template === true,
      requiresTemplate: row.capabilities?.requiresTemplate === true };
  });
  return resolveSender({ branchId: input.branchId, pinnedSenderId: input.pinnedSenderId,
    campaignOverrideId: config.sender_override_id, branchDefaultId: config.default_sender_id, senders });
}
