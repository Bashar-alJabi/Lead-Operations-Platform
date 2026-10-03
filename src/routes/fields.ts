import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { calculateLeadFields } from '../calculated-fields.js';
import { calculationKinds, fieldTypes, validateFieldConfiguration, validateFieldValue,
  type CalculationKind, type FieldOption, type FieldType, type FieldValidation } from '../fields.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { HttpError, principalFromRequest, requireBranch, requireRole, type Principal } from '../security.js';

const idParam = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const bindingParam = { type: 'object', additionalProperties: false, required: ['id','fieldId'], properties: {
  id: { type: 'string', format: 'uuid' }, fieldId: { type: 'string', format: 'uuid' },
} } as const;
const fieldTypeSchema = { enum: [...fieldTypes] } as const;
const optionSchema = { type: 'object', additionalProperties: false, required: ['value','label','active'], properties: {
  value: { type: 'string', minLength: 1, maxLength: 100 }, label: { type: 'string', minLength: 1, maxLength: 200 }, active: { type: 'boolean' },
} } as const;
const validationSchema = { type: 'object', additionalProperties: false, properties: {
  minLength: { type: 'integer', minimum: 0, maximum: 20000 }, maxLength: { type: 'integer', minimum: 1, maximum: 20000 },
  min: { type: 'number' }, max: { type: 'number' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
} } as const;
const calculationSchema = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['kind'], properties: {
  kind: { enum: [...calculationKinds] },
} }] } as const;
type DefinitionInput = { scope: 'GLOBAL'|'BRANCH'|'CAMPAIGN'; branchId?: string; campaignId?: string; key: string; label: string;
  description?: string; fieldType: FieldType; valueMode: 'MANUAL'|'SOURCE'|'SYSTEM'|'CALCULATED'; options: FieldOption[];
  validation: FieldValidation; calculation?: { kind: CalculationKind } | null };
type BindingInput = { version?: number; active: boolean; position: number; requiredStage: 'NONE'|'LEAD_CREATION'|'CLOSE'|'ENROLLMENT';
  visibleToAgent: boolean; editableByAgent: boolean; visibleToManager: boolean; editableByManager: boolean;
  showInTable: boolean; showInDetails: boolean; filterable: boolean; usableByAutomation: boolean; usableByAi: boolean };

async function campaignForManager(db: Database, organizationId: string, campaignId: string, actor: { role: string; branchId: string | null }) {
  const rows = await db`SELECT id, branch_id, status FROM campaign WHERE id = ${campaignId} AND organization_id = ${organizationId}`;
  const campaign = rows[0];
  if (!campaign) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
  if (actor.role !== 'SUPER_ADMIN' && campaign.branch_id !== actor.branchId) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
  return campaign;
}

async function scopedLead(tx: postgres.TransactionSql, actor: Principal, leadId: string, lock: 'SHARE'|'UPDATE') {
  const rows = lock === 'UPDATE' ? await tx`SELECT id, campaign_id, lifecycle FROM lead WHERE id = ${leadId} AND organization_id = ${actor.organizationId}
    AND (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND branch_id = ${actor.branchId})
      OR (${actor.role === 'AGENT'} AND assigned_agent_id = ${actor.id})) FOR UPDATE` :
    await tx`SELECT id, campaign_id, lifecycle FROM lead WHERE id = ${leadId} AND organization_id = ${actor.organizationId}
    AND (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND branch_id = ${actor.branchId})
      OR (${actor.role === 'AGENT'} AND assigned_agent_id = ${actor.id})) FOR SHARE`;
  if (!rows[0]) throw new HttpError(404, 'LEAD_NOT_FOUND');
  return rows[0];
}

function checkBinding(input: BindingInput, mode: string): void {
  if ((input.editableByAgent && !input.visibleToAgent) || (input.editableByManager && !input.visibleToManager)) throw new HttpError(400, 'FIELD_BINDING_INVALID');
  if ((input.editableByAgent || input.editableByManager) && !input.showInTable && !input.showInDetails) throw new HttpError(400, 'FIELD_BINDING_INVALID');
  if (mode !== 'MANUAL' && (input.editableByAgent || input.editableByManager)) throw new HttpError(400, 'FIELD_READ_ONLY');
  if (mode === 'CALCULATED' && input.requiredStage !== 'NONE') throw new HttpError(400, 'FIELD_BINDING_INVALID');
}

export function registerFieldRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Querystring: { campaignId?: string; limit?: number; cursor?: string } }>('/api/fields', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      campaignId: { type: 'string', format: 'uuid' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const campaign = request.query.campaignId ? await campaignForManager(db, actor.organizationId, request.query.campaignId, actor) : null;
    const cursor = decodeCursor(request.query.cursor);
    const limit = request.query.limit ?? 30;
    const rows = await db`SELECT id, organization_id, branch_id, campaign_id, key, label, description, field_type, value_mode,
      options, validation, calculation, active, version, created_at, updated_at
      FROM field_definition WHERE organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR branch_id IS NULL OR branch_id = ${actor.branchId})
        AND (${campaign?.id ?? null}::uuid IS NULL OR campaign_id = ${campaign?.id ?? null}
          OR (campaign_id IS NULL AND (branch_id IS NULL OR branch_id = ${campaign?.branch_id ?? null})))
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at, id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
  });

  app.post<{ Body: DefinitionInput }>('/api/fields', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['scope','key','label','fieldType','valueMode','options','validation'], properties: {
      scope: { enum: ['GLOBAL','BRANCH','CAMPAIGN'] }, branchId: { type: 'string', format: 'uuid' }, campaignId: { type: 'string', format: 'uuid' },
      key: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80 }, label: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', maxLength: 1000 }, fieldType: fieldTypeSchema, valueMode: { enum: ['MANUAL','SOURCE','SYSTEM','CALCULATED'] },
      options: { type: 'array', maxItems: 200, items: optionSchema }, validation: validationSchema, calculation: calculationSchema,
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const input = request.body;
    validateFieldConfiguration(input.fieldType, input.valueMode, input.options, input.validation, input.calculation ?? null);
    if (input.scope === 'GLOBAL') {
      requireRole(actor, 'SUPER_ADMIN');
      if (input.branchId || input.campaignId) throw new HttpError(400, 'FIELD_SCOPE_INVALID');
    } else if (input.scope === 'BRANCH') {
      if (!input.branchId || input.campaignId) throw new HttpError(400, 'FIELD_SCOPE_INVALID');
      requireBranch(actor, input.branchId);
      const branch = await db`SELECT 1 FROM branch WHERE id = ${input.branchId} AND organization_id = ${actor.organizationId}`;
      if (!branch.length) throw new HttpError(404, 'BRANCH_NOT_FOUND');
    } else {
      if (!input.branchId || !input.campaignId) throw new HttpError(400, 'FIELD_SCOPE_INVALID');
      requireBranch(actor, input.branchId);
      const campaign = await campaignForManager(db, actor.organizationId, input.campaignId, actor);
      if (campaign.branch_id !== input.branchId) throw new HttpError(400, 'FIELD_SCOPE_INVALID');
    }
    const id = await db.begin(async (tx) => {
      const created = await tx`INSERT INTO field_definition (organization_id, branch_id, campaign_id, key, label, description,
        field_type, value_mode, options, validation, calculation)
        VALUES (${actor.organizationId}, ${input.branchId ?? null}, ${input.campaignId ?? null}, ${input.key}, ${input.label.trim()},
          ${input.description?.trim() ?? null}, ${input.fieldType}, ${input.valueMode}, ${tx.json(input.options)}, ${tx.json(input.validation)},
          ${input.calculation ? tx.json(input.calculation) : null}) RETURNING id`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${input.branchId ?? null}, ${actor.id}, 'FIELD_CREATED', 'FIELD', ${created[0]!.id})`;
      return created[0]!.id as string;
    }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new HttpError(409, 'FIELD_KEY_EXISTS');
      throw error;
    });
    reply.code(201); return { id };
  });

  app.patch<{ Params: { id: string }; Body: { version: number; label: string; description?: string | null; options: FieldOption[];
    validation: FieldValidation; active: boolean; fieldType?: FieldType; valueMode?: 'MANUAL'|'SOURCE'|'SYSTEM'|'CALCULATED';
    calculation?: { kind: CalculationKind } | null } }>('/api/fields/:id', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, required: ['version','label','options','validation','active'], properties: {
      version: { type: 'integer', minimum: 1 }, label: { type: 'string', minLength: 1, maxLength: 200 },
      description: { anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'null' }] },
      options: { type: 'array', maxItems: 200, items: optionSchema }, validation: validationSchema, active: { type: 'boolean' },
      fieldType: fieldTypeSchema, valueMode: { enum: ['MANUAL','SOURCE','SYSTEM','CALCULATED'] }, calculation: calculationSchema,
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    return db.begin(async (tx) => {
      const rows = await tx`SELECT id, branch_id, campaign_id, field_type, value_mode, calculation, options, version FROM field_definition
        WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId} FOR UPDATE`;
      const field = rows[0];
      if (!field) throw new HttpError(404, 'FIELD_NOT_FOUND');
      if (field.branch_id === null) requireRole(actor, 'SUPER_ADMIN');
      else requireBranch(actor, field.branch_id);
      if (field.version !== request.body.version) throw new HttpError(409, 'FIELD_VERSION_CONFLICT');
      const nextType = request.body.fieldType ?? field.field_type;
      const nextMode = request.body.valueMode ?? field.value_mode;
      const nextCalculation = request.body.calculation === undefined ? field.calculation : request.body.calculation;
      validateFieldConfiguration(nextType, nextMode, request.body.options, request.body.validation, nextCalculation);
      const nextOptionValues = new Set(request.body.options.map((option) => option.value));
      for (const oldOption of field.options as FieldOption[]) {
        if (nextOptionValues.has(oldOption.value)) continue;
        const used = await tx`SELECT 1 FROM field_value_history WHERE field_id = ${field.id}
          AND (new_value = to_jsonb(${oldOption.value}::text) OR new_value @> to_jsonb(ARRAY[${oldOption.value}]::text[])) LIMIT 1`;
        if (used.length) throw new HttpError(409, 'FIELD_OPTION_IN_HISTORY');
      }
      if (nextType !== field.field_type || nextMode !== field.value_mode || JSON.stringify(nextCalculation) !== JSON.stringify(field.calculation)) {
        const inUse = await tx`SELECT 1 FROM campaign_field WHERE field_id = ${field.id} LIMIT 1`;
        const values = await tx`SELECT 1 FROM lead_field_value WHERE field_id = ${field.id} LIMIT 1`;
        if (inUse.length || values.length) throw new HttpError(409, 'FIELD_TYPE_IN_USE');
      }
      const updated = await tx`UPDATE field_definition SET label = ${request.body.label.trim()}, description = ${request.body.description?.trim() ?? null},
        field_type = ${nextType}, value_mode = ${nextMode}, calculation = ${nextCalculation ? tx.json(nextCalculation) : null},
        options = ${tx.json(request.body.options)}, validation = ${tx.json(request.body.validation)}, active = ${request.body.active},
        version = version + 1, updated_at = now() WHERE id = ${field.id} RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
        VALUES (${actor.organizationId}, ${field.branch_id}, ${actor.id}, 'FIELD_UPDATED', 'FIELD', ${field.id},
          ${tx.json({ fromVersion: field.version, toVersion: updated[0]!.version })})`;
      return { version: updated[0]!.version };
    });
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/fields', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    await campaignForManager(db, actor.organizationId, request.params.id, actor);
    const rows = await db`SELECT cf.*, fd.key, fd.label, fd.field_type, fd.value_mode, fd.options, fd.validation, fd.calculation,
      fd.active AS definition_active FROM campaign_field cf JOIN field_definition fd ON fd.id = cf.field_id
      WHERE cf.campaign_id = ${request.params.id} AND fd.organization_id = ${actor.organizationId}
      ORDER BY cf.position, fd.key`;
    return { items: rows };
  });

  app.put<{ Params: { id: string; fieldId: string }; Body: BindingInput }>('/api/campaigns/:id/fields/:fieldId', {
    schema: { params: bindingParam, body: { type: 'object', additionalProperties: false, required: ['active','position','requiredStage',
      'visibleToAgent','editableByAgent','visibleToManager','editableByManager','showInTable','showInDetails','filterable','usableByAutomation','usableByAi'], properties: {
      version: { type: 'integer', minimum: 1 }, active: { type: 'boolean' }, position: { type: 'integer', minimum: 0, maximum: 10000 },
      requiredStage: { enum: ['NONE','LEAD_CREATION','CLOSE','ENROLLMENT'] }, visibleToAgent: { type: 'boolean' }, editableByAgent: { type: 'boolean' },
      visibleToManager: { type: 'boolean' }, editableByManager: { type: 'boolean' }, showInTable: { type: 'boolean' },
      showInDetails: { type: 'boolean' }, filterable: { type: 'boolean' }, usableByAutomation: { type: 'boolean' }, usableByAi: { type: 'boolean' },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    return db.begin(async (tx) => {
      const campaigns = await tx`SELECT id, branch_id FROM campaign WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId} FOR UPDATE`;
      const campaign = campaigns[0];
      if (!campaign) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
      requireBranch(actor, campaign.branch_id);
      const fields = await tx`SELECT id, key, branch_id, campaign_id, value_mode, active FROM field_definition
        WHERE id = ${request.params.fieldId} AND organization_id = ${actor.organizationId}`;
      const field = fields[0];
      if (!field || (field.branch_id && field.branch_id !== campaign.branch_id) || (field.campaign_id && field.campaign_id !== campaign.id)) {
        throw new HttpError(404, 'FIELD_NOT_FOUND');
      }
      checkBinding(request.body, field.value_mode);
      if (request.body.active && !field.active) throw new HttpError(409, 'FIELD_DEFINITION_INACTIVE');
      if (request.body.active) {
        const duplicate = await tx`SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id = cf.field_id
          WHERE cf.campaign_id = ${campaign.id} AND cf.field_id <> ${field.id} AND cf.active AND fd.key = ${field.key} LIMIT 1`;
        if (duplicate.length) throw new HttpError(409, 'FIELD_KEY_CONFLICT');
      }
      const existing = await tx`SELECT version FROM campaign_field WHERE campaign_id = ${campaign.id} AND field_id = ${field.id}`;
      if (existing.length && existing[0]!.version !== request.body.version) throw new HttpError(409, 'FIELD_BINDING_VERSION_CONFLICT');
      if (!existing.length && request.body.version !== undefined) throw new HttpError(409, 'FIELD_BINDING_VERSION_CONFLICT');
      const updated = await tx`INSERT INTO campaign_field (campaign_id, field_id, active, position, required_stage,
        visible_to_agent, editable_by_agent, visible_to_manager, editable_by_manager, show_in_table, show_in_details,
        filterable, usable_by_automation, usable_by_ai)
        VALUES (${campaign.id}, ${field.id}, ${request.body.active}, ${request.body.position}, ${request.body.requiredStage},
          ${request.body.visibleToAgent}, ${request.body.editableByAgent}, ${request.body.visibleToManager}, ${request.body.editableByManager},
          ${request.body.showInTable}, ${request.body.showInDetails}, ${request.body.filterable}, ${request.body.usableByAutomation}, ${request.body.usableByAi})
        ON CONFLICT (campaign_id, field_id) DO UPDATE SET active = EXCLUDED.active, position = EXCLUDED.position,
          required_stage = EXCLUDED.required_stage, visible_to_agent = EXCLUDED.visible_to_agent, editable_by_agent = EXCLUDED.editable_by_agent,
          visible_to_manager = EXCLUDED.visible_to_manager, editable_by_manager = EXCLUDED.editable_by_manager,
          show_in_table = EXCLUDED.show_in_table, show_in_details = EXCLUDED.show_in_details, filterable = EXCLUDED.filterable,
          usable_by_automation = EXCLUDED.usable_by_automation, usable_by_ai = EXCLUDED.usable_by_ai, version = campaign_field.version + 1
        RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${campaign.branch_id}, ${actor.id}, 'CAMPAIGN_FIELD_CONFIGURED', 'FIELD', ${field.id})`;
      return { version: updated[0]!.version };
    });
  });

  app.get<{ Params: { id: string } }>('/api/leads/:id/fields', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const lead = await scopedLead(tx, actor, request.params.id, 'SHARE');
      const rows = await tx`SELECT fd.id, fd.key, fd.label, fd.field_type, fd.value_mode, fd.options, fd.validation, fd.calculation,
      fd.active AS definition_active, cf.active AS binding_active, cf.position, cf.required_stage, cf.show_in_details,
      cf.show_in_table, cf.filterable, cf.editable_by_agent, cf.editable_by_manager,
      lfv.value, lfv.version AS value_version, lfv.source, lfv.updated_at
      FROM campaign_field cf JOIN field_definition fd ON fd.id = cf.field_id
        LEFT JOIN lead_field_value lfv ON lfv.field_id = fd.id AND lfv.lead_id = ${lead.id}
      WHERE cf.campaign_id = ${lead.campaign_id} AND fd.organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND cf.visible_to_manager)
          OR (${actor.role === 'AGENT'} AND cf.visible_to_agent))
        AND (${actor.role === 'SUPER_ADMIN'} OR cf.show_in_details OR cf.show_in_table)
      ORDER BY cf.position, fd.key`;
      const kinds = [...new Set(rows.filter((row) => row.field_type === 'CALCULATED' && row.calculation?.kind).map((row) => row.calculation.kind as CalculationKind))];
      const calculated = await calculateLeadFields(tx, lead.id, kinds);
      return { items: rows.map((row) => ({ ...row, value: row.field_type === 'CALCULATED' ? calculated[row.calculation.kind] : row.value,
        editable: row.binding_active && row.definition_active && row.value_mode === 'MANUAL' &&
          (actor.role === 'SUPER_ADMIN' || actor.role === 'MANAGER' && row.editable_by_manager || actor.role === 'AGENT' && row.editable_by_agent) })) };
    });
  });

  app.put<{ Params: { id: string; fieldId: string }; Body: { value: unknown; version?: number } }>('/api/leads/:id/fields/:fieldId', {
    schema: { params: bindingParam, body: { type: 'object', additionalProperties: false, required: ['value'], properties: {
      value: {}, version: { type: 'integer', minimum: 1 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const lead = await scopedLead(tx, actor, request.params.id, 'UPDATE');
      const fields = await tx`SELECT fd.id, fd.field_type, fd.value_mode, fd.options, fd.validation, fd.active AS definition_active,
        cf.active AS binding_active, cf.required_stage, cf.visible_to_agent, cf.editable_by_agent, cf.visible_to_manager, cf.editable_by_manager,
        cf.show_in_details, cf.show_in_table
        FROM campaign_field cf JOIN field_definition fd ON fd.id = cf.field_id
        WHERE cf.campaign_id = ${lead.campaign_id} AND fd.id = ${request.params.fieldId} AND fd.organization_id = ${actor.organizationId}`;
      const field = fields[0];
      if (!field || actor.role === 'AGENT' && !field.visible_to_agent || actor.role === 'MANAGER' && !field.visible_to_manager ||
        actor.role !== 'SUPER_ADMIN' && !field.show_in_details && !field.show_in_table) {
        throw new HttpError(404, 'FIELD_NOT_FOUND');
      }
      if (!field.definition_active || !field.binding_active || field.value_mode !== 'MANUAL' ||
        actor.role === 'AGENT' && !field.editable_by_agent || actor.role === 'MANAGER' && !field.editable_by_manager) {
        throw new HttpError(403, 'FIELD_READ_ONLY');
      }
      const value = validateFieldValue(field.field_type, request.body.value, field.options, field.validation);
      if (value === null && (field.required_stage === 'CLOSE' && lead.lifecycle === 'CLOSED')) throw new HttpError(409, 'FIELD_REQUIRED');
      const previous = await tx`SELECT value, version FROM lead_field_value WHERE lead_id = ${lead.id} AND field_id = ${field.id} FOR UPDATE`;
      if (previous.length && previous[0]!.version !== request.body.version) throw new HttpError(409, 'FIELD_VALUE_VERSION_CONFLICT');
      if (!previous.length && request.body.version !== undefined) throw new HttpError(409, 'FIELD_VALUE_VERSION_CONFLICT');
      const updated = await tx`INSERT INTO lead_field_value (lead_id, field_id, value, source, updated_by)
        VALUES (${lead.id}, ${field.id}, ${tx.json(value as postgres.JSONValue)}, 'MANUAL', ${actor.id})
        ON CONFLICT (lead_id, field_id) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_by = EXCLUDED.updated_by,
          version = lead_field_value.version + 1, updated_at = now() RETURNING version`;
      await tx`INSERT INTO field_value_history (lead_id, field_id, old_value, new_value, source, actor_user_id)
        VALUES (${lead.id}, ${field.id}, ${previous.length ? tx.json(previous[0]!.value) : null}, ${tx.json(value as postgres.JSONValue)}, 'MANUAL', ${actor.id})`;
      await tx`INSERT INTO lead_activity (lead_id, actor_user_id, event_type, detail)
        VALUES (${lead.id}, ${actor.id}, 'FIELD_VALUE_CHANGED', ${tx.json({ fieldId: field.id })})`;
      return { version: updated[0]!.version };
    });
  });

  app.get<{ Params: { id: string; fieldId: string }; Querystring: { limit?: number; cursor?: string } }>('/api/leads/:id/fields/:fieldId/history', {
    schema: { params: bindingParam, querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const lead = await scopedLead(tx, actor, request.params.id, 'SHARE');
      const visible = await tx`SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id = cf.field_id
      WHERE cf.campaign_id = ${lead.campaign_id} AND fd.id = ${request.params.fieldId} AND fd.organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND cf.visible_to_manager)
          OR (${actor.role === 'AGENT'} AND cf.visible_to_agent))
        AND (${actor.role === 'SUPER_ADMIN'} OR cf.show_in_details OR cf.show_in_table)`;
      if (!visible.length) throw new HttpError(404, 'FIELD_NOT_FOUND');
      const cursor = request.query.cursor ? Number(request.query.cursor) : null;
      if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new HttpError(400, 'INVALID_CURSOR');
      const limit = request.query.limit ?? 30;
      const rows = await tx`SELECT h.id, h.old_value, h.new_value, h.source, h.actor_user_id, h.created_at
      FROM field_value_history h WHERE h.lead_id = ${lead.id} AND h.field_id = ${request.params.fieldId}
        AND (${cursor}::bigint IS NULL OR h.id < ${cursor})
      ORDER BY h.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return { items, nextCursor: rows.length > limit && last ? String(last.id) : null };
    });
  });
}
