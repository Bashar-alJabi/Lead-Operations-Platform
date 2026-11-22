import {leadFilterFieldAccess,operationalFilterProperties,prepareLeadFilter,type LeadFilter} from '../lead-query.js';
import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { HttpError, principalFromRequest, requireBranch, type Principal } from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {campaignTableFieldAccess,maxLeadTableFields,readCampaignTableFields} from '../lead-table-fields.js';

type Filter=LeadFilter&{sort?:'CREATED_DESC'|'CREATED_ASC'};

type ViewInput = { name: string; scope: 'PERSONAL'|'BRANCH'|'ORGANIZATION'; branchId?: string;
  filters: Filter; columns: string[]; fieldColumns?:string[] };
const idParam = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const filterSchema={type:'object',additionalProperties:false,properties:{...operationalFilterProperties,sort:{enum:['CREATED_DESC','CREATED_ASC']}}} as const;

const inputSchema = { type: 'object', additionalProperties: false,
  required: ['name','scope','filters','columns'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 }, scope: { enum: ['PERSONAL','BRANCH','ORGANIZATION'] },
    branchId: { type: 'string', format: 'uuid' }, filters: filterSchema,
    columns: { type: 'array', maxItems: 12, uniqueItems: true,
      items: { enum: ['contact','campaign','branch','lifecycle','owner','source','created_at','followup'] } },
    fieldColumns:{type:'array',maxItems:maxLeadTableFields,uniqueItems:true,items:{type:'string',format:'uuid'}},
  } } as const;

async function validateView(db: postgres.TransactionSql, actor: Principal, input: ViewInput) {
  if (!input.name.trim()) throw new HttpError(400, 'VIEW_NAME_REQUIRED');
  if (input.scope === 'ORGANIZATION' && actor.role !== 'SUPER_ADMIN') throw new HttpError(403, 'FORBIDDEN');
  if (input.scope === 'BRANCH' && actor.role === 'AGENT') throw new HttpError(403, 'FORBIDDEN');
  if (input.scope === 'BRANCH' && !input.branchId && actor.role === 'SUPER_ADMIN') throw new HttpError(400, 'VIEW_BRANCH_REQUIRED');
  if (input.scope !== 'BRANCH' && input.branchId) throw new HttpError(400, 'VIEW_BRANCH_UNEXPECTED');
  const branchId = input.scope === 'BRANCH' ? input.branchId ?? actor.branchId : null;
  if (branchId) {
    requireBranch(actor, branchId);
    const branch = await db`SELECT 1 FROM branch WHERE id = ${branchId} AND organization_id = ${actor.organizationId}`;
    if (!branch.length) throw new HttpError(404, 'BRANCH_NOT_FOUND');
  }
  const filter = input.filters;
  if (filter.branchId) requireBranch(actor, filter.branchId);
  if (filter.from && filter.to && Date.parse(filter.from) > Date.parse(filter.to)) throw new HttpError(400, 'INVALID_DATE_RANGE');
  if (Boolean(filter.fieldId) !== Boolean(filter.fieldValue)) throw new HttpError(400, 'FIELD_FILTER_INCOMPLETE');
  if (filter.fieldId && !filter.campaignId) throw new HttpError(400, 'FIELD_FILTER_REQUIRES_CAMPAIGN');
  if (input.fieldColumns?.length && !filter.campaignId) throw new HttpError(400, 'FIELD_COLUMNS_REQUIRE_CAMPAIGN');
  if (input.scope === 'ORGANIZATION' && (filter.branchId || filter.campaignId || filter.assignedAgentId || filter.fieldId || filter.contactId))
    throw new HttpError(400, 'ORGANIZATION_VIEW_FILTER_SCOPE');
  if (input.scope === 'BRANCH' && filter.branchId && filter.branchId !== branchId)
    throw new HttpError(400, 'VIEW_BRANCH_FILTER_CONFLICT');
  if (filter.campaignId) {
    const campaign = await db`SELECT branch_id FROM campaign WHERE id = ${filter.campaignId} AND organization_id = ${actor.organizationId}
      AND (${actor.role === 'SUPER_ADMIN'} OR branch_id = ${actor.branchId})
      AND (${actor.role !== 'AGENT'} OR EXISTS (SELECT 1 FROM lead WHERE campaign_id = ${filter.campaignId}
        AND assigned_agent_id = ${actor.id}))`;
    if (!campaign[0]) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
    if (input.scope === 'BRANCH' && campaign[0].branch_id !== branchId) throw new HttpError(400, 'VIEW_BRANCH_FILTER_CONFLICT');
  }
  if (filter.fieldId && (await prepareLeadFilter(db,actor,filter)).emptyScope) {
    throw new HttpError(404, 'FIELD_NOT_FOUND');
  }
  if (input.fieldColumns?.length && filter.campaignId) {
    const {fields}=await readCampaignTableFields(db,actor,filter.campaignId,[],input.fieldColumns);
    if (fields.length!==input.fieldColumns.length) throw new HttpError(404,'FIELD_COLUMNS_NOT_AVAILABLE');
  }
  return branchId;
}

function visibleLeadViews(tx:postgres.TransactionSql,actor:Principal) {
  return tx`SELECT id, owner_user_id, branch_id, name, scope, columns, version, created_at,
        CASE WHEN denied.value THEN filters-ARRAY['fieldId','fieldValue'] ELSE filters END AS filters,
        denied.value AS "fieldFilterUnavailable",
        CASE WHEN v.field_columns IS NOT NULL THEN ARRAY(
          SELECT saved.field_id FROM unnest(v.field_columns) WITH ORDINALITY AS saved(field_id,position)
          WHERE EXISTS(SELECT 1 FROM campaign c JOIN campaign_field cf ON cf.campaign_id=c.id
            JOIN field_definition fd ON fd.id=cf.field_id
            WHERE c.id::text=v.filters->>'campaignId' AND fd.id=saved.field_id AND ${campaignTableFieldAccess(tx,actor)})
          ORDER BY saved.position) END AS "fieldColumns"
        FROM saved_lead_view v CROSS JOIN LATERAL(
          SELECT (v.filters ?| ARRAY['fieldId','fieldValue']) AND NOT EXISTS(
            SELECT 1 FROM campaign ca JOIN campaign_field cf ON cf.campaign_id=ca.id
            JOIN field_definition fd ON fd.id=cf.field_id
            WHERE ca.id::text=v.filters->>'campaignId' AND fd.id::text=v.filters->>'fieldId'
              AND ${leadFilterFieldAccess(tx,actor)}) AS value
        ) denied WHERE organization_id = ${actor.organizationId}
          AND (owner_user_id = ${actor.id} OR (${actor.role !== 'AGENT'} AND
            ((scope = 'ORGANIZATION' AND ${actor.role !== 'AGENT'}) OR
              (scope = 'BRANCH' AND (${actor.role === 'SUPER_ADMIN'} OR branch_id = ${actor.branchId})))))`;
}

export function registerLeadViewRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/lead-views', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const cursor = decodeCursor(request.query.cursor);
    const limit = request.query.limit ?? 30;
    return db.begin(async tx=>{
      if(!await currentPaymentSession(tx,actor,request)) throw new HttpError(403,'LEAD_VIEW_ACCESS_REVOKED');
      const rows = await tx`${visibleLeadViews(tx,actor)}
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR
            (created_at, id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
    });
  });

  app.get<{Params:{id:string}}>('/api/lead-views/:id',{schema:{params:idParam}},async request=>{
    const actor=await principalFromRequest(request,db);
    return db.begin(async tx=>{
      if(!await currentPaymentSession(tx,actor,request)) throw new HttpError(403,'LEAD_VIEW_ACCESS_REVOKED');
      const [view]=await tx`${visibleLeadViews(tx,actor)} AND v.id=${request.params.id}`;
      if(!view) throw new HttpError(404,'LEAD_VIEW_NOT_FOUND');
      return view;
    });
  });

  app.post<{ Body: ViewInput }>('/api/lead-views', { schema: { body: inputSchema } }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    const id = await db.begin(async (tx) => {
      if(!await currentPaymentSession(tx,actor,request)) throw new HttpError(403,'LEAD_VIEW_ACCESS_REVOKED');
      const branchId = await validateView(tx, actor, request.body);
      const rows = await tx`INSERT INTO saved_lead_view
        (organization_id, branch_id, owner_user_id, name, scope, filters, columns,field_columns)
        VALUES (${actor.organizationId}, ${branchId}, ${actor.id}, ${request.body.name.trim()}, ${request.body.scope},
          ${tx.json(request.body.filters)}, ${tx.json(request.body.columns)},${request.body.fieldColumns?tx.array(request.body.fieldColumns):null}::uuid[]) RETURNING id`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${branchId}, ${actor.id}, 'LEAD_VIEW_CREATED', 'LEAD_VIEW', ${rows[0]!.id})`;
      return rows[0]!.id;
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'LEAD_VIEW_NAME_CONFLICT');
      throw error;
    });
    reply.code(201); return { id };
  });

  app.patch<{ Params: { id: string }; Body: ViewInput & { version: number } }>('/api/lead-views/:id', {
    schema: { params: idParam, body: { ...inputSchema, required: [...inputSchema.required, 'version'],
      properties: { ...inputSchema.properties, version: { type: 'integer', minimum: 1 } } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      if(!await currentPaymentSession(tx,actor,request)) throw new HttpError(403,'LEAD_VIEW_ACCESS_REVOKED');
      const branchId = await validateView(tx, actor, request.body);
      const old = await tx`SELECT version FROM saved_lead_view WHERE id = ${request.params.id}
        AND organization_id = ${actor.organizationId} AND owner_user_id = ${actor.id} FOR UPDATE`;
      if (!old[0]) throw new HttpError(404, 'LEAD_VIEW_NOT_FOUND');
      if (old[0].version !== request.body.version) throw new HttpError(409, 'LEAD_VIEW_VERSION_CONFLICT');
      const rows = await tx`UPDATE saved_lead_view SET branch_id = ${branchId}, name = ${request.body.name.trim()},
        scope = ${request.body.scope}, filters = ${tx.json(request.body.filters)}, columns = ${tx.json(request.body.columns)},
        field_columns=${request.body.fieldColumns?tx.array(request.body.fieldColumns):null}::uuid[],
        version = version + 1, updated_at = now() WHERE id = ${request.params.id} RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${branchId}, ${actor.id}, 'LEAD_VIEW_UPDATED', 'LEAD_VIEW', ${request.params.id})`;
      return { version: rows[0]!.version };
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'LEAD_VIEW_NAME_CONFLICT');
      throw error;
    });
  });

  app.delete<{ Params: { id: string } }>('/api/lead-views/:id', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const old = await tx`DELETE FROM saved_lead_view WHERE id = ${request.params.id}
        AND organization_id = ${actor.organizationId} AND owner_user_id = ${actor.id} RETURNING branch_id`;
      if (!old[0]) throw new HttpError(404, 'LEAD_VIEW_NOT_FOUND');
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${old[0].branch_id}, ${actor.id}, 'LEAD_VIEW_DELETED', 'LEAD_VIEW', ${request.params.id})`;
      return { ok: true };
    });
  });
}
