import type postgres from 'postgres';
import { validateFieldValue, type FieldOption, type FieldType, type FieldValidation } from './fields.js';
import { HttpError, type Principal } from './security.js';

export type ManualFieldInput = { fieldId: string; value: postgres.JSONValue };
export type PreparedFieldValue = { fieldId: string; value: postgres.JSONValue };

export async function prepareManualFieldValues(tx: postgres.TransactionSql, campaignId: string, actor: Principal,
  submitted: ManualFieldInput[]): Promise<PreparedFieldValue[]> {
  if (new Set(submitted.map((item) => item.fieldId)).size !== submitted.length) throw new HttpError(400, 'FIELD_DUPLICATE_INPUT');
  const rows = await tx`SELECT fd.id, fd.field_type, fd.value_mode, fd.options, fd.validation, fd.active AS definition_active,
    cf.active AS binding_active, cf.required_stage, cf.visible_to_manager, cf.editable_by_manager
    FROM campaign_field cf JOIN field_definition fd ON fd.id = cf.field_id
    WHERE cf.campaign_id = ${campaignId} AND fd.organization_id = ${actor.organizationId}`;
  const byId = new Map(rows.map((row) => [row.id as string, row]));
  const prepared: PreparedFieldValue[] = [];
  for (const item of submitted) {
    const field = byId.get(item.fieldId);
    if (!field || !field.definition_active || !field.binding_active ||
      actor.role === 'MANAGER' && !field.visible_to_manager) throw new HttpError(404, 'FIELD_NOT_FOUND');
    if (field.value_mode !== 'MANUAL' || actor.role === 'MANAGER' && !field.editable_by_manager) throw new HttpError(403, 'FIELD_READ_ONLY');
    const value = validateFieldValue(field.field_type as FieldType, item.value, field.options as FieldOption[], field.validation as FieldValidation);
    if (value !== null) prepared.push({ fieldId: item.fieldId, value: value as postgres.JSONValue });
  }
  const provided = new Set(prepared.map((item) => item.fieldId));
  if (rows.some((row) => row.definition_active && row.binding_active && row.required_stage === 'LEAD_CREATION' && !provided.has(row.id))) {
    throw new HttpError(409, 'FIELD_REQUIRED_AT_LEAD_CREATION');
  }
  return prepared;
}

export async function storeManualFieldValues(tx: postgres.TransactionSql, leadId: string, actorId: string,
  values: PreparedFieldValue[]): Promise<void> {
  for (const item of values) {
    await tx`INSERT INTO lead_field_value (lead_id, field_id, value, source, updated_by)
      VALUES (${leadId}, ${item.fieldId}, ${tx.json(item.value)}, 'MANUAL', ${actorId})`;
    await tx`INSERT INTO field_value_history (lead_id, field_id, new_value, source, actor_user_id)
      VALUES (${leadId}, ${item.fieldId}, ${tx.json(item.value)}, 'MANUAL', ${actorId})`;
  }
}

export async function enforceRequiredFieldStage(tx: postgres.TransactionSql, leadId: string, campaignId: string,
  stage: 'CLOSE'|'ENROLLMENT'): Promise<void> {
  const missing = await tx`SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id = cf.field_id
    LEFT JOIN lead_field_value lfv ON lfv.field_id = cf.field_id AND lfv.lead_id = ${leadId}
    WHERE cf.campaign_id = ${campaignId} AND cf.active AND fd.active AND cf.required_stage = ${stage}
      AND (lfv.lead_id IS NULL OR lfv.value IS NULL) LIMIT 1`;
  if (missing.length) throw new HttpError(409, 'FIELD_REQUIRED');
}
