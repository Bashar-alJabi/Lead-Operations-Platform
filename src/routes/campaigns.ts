import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { HttpError, principalFromRequest, requireBranch, requireRole, type Principal } from '../security.js';
import { sourceCampaignIssues } from '../sources/readiness.js';
import { recheckSourceActor } from '../sources/catalog-sync.js';
import {initialCampaignIssues} from '../ai/initial-readiness.js';
import {currentPaymentSession} from '../payments/access.js';
import { validateFieldValue, type FieldOption, type FieldType, type FieldValidation } from '../fields.js';

const idParam = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const routingMethods = ['MANUAL', 'ROUND_ROBIN', 'WEIGHTED', 'PERFORMANCE'] as const;
type RoutingMethod = typeof routingMethods[number];
const performanceFallbacks=['MANUAL','ROUND_ROBIN','WEIGHTED'] as const;
type PerformancePolicyInput={
 version:number;lookbackDays:number;minimumSamples:number;responseWeight:number;followUpWeight:number;
 fallbackMethod:typeof performanceFallbacks[number];reason:string;
};
type CampaignUpdate = {
  version: number;
  name: string;
  sourceKind: string;
  routingMethod: RoutingMethod;
  messagingEnabled: boolean;
  aiEnabled: boolean;
  conversion?: { type: 'PAYMENT_CONFIRMED' | 'ENROLLMENT_CONFIRMED' } |
    { type: 'FIELD_VALUE'; fieldId: string; value: unknown } | null;
};

async function managedCampaign(sql: Database | postgres.TransactionSql, actor: Principal, id: string, lock = false) {
  requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  if (lock) {
    const [initial]=await sql`SELECT id,branch_id,source_kind FROM campaign WHERE id=${id} AND organization_id=${actor.organizationId}`;
    if (!initial) throw new HttpError(404,'CAMPAIGN_NOT_FOUND');requireBranch(actor,initial.branch_id);
    // Source changes and intake hold Connection before Branch/Campaign; activation uses the same order.
    await sql`SELECT c.id FROM integration_connection c WHERE c.organization_id=${actor.organizationId}
      AND EXISTS (SELECT 1 FROM source_campaign_binding b WHERE b.connection_id=c.id AND b.campaign_id=${id} AND b.active)
      ORDER BY c.id FOR UPDATE OF c`;
    await sql`SELECT id FROM branch WHERE id=${initial.branch_id} FOR NO KEY UPDATE`;
  }
  const rows = lock
    ? await sql`SELECT c.*, b.active AS branch_active FROM campaign c JOIN branch b ON b.id = c.branch_id
        WHERE c.id = ${id} AND c.organization_id = ${actor.organizationId} FOR UPDATE OF c`
    : await sql`SELECT c.*, b.active AS branch_active FROM campaign c JOIN branch b ON b.id = c.branch_id
        WHERE c.id = ${id} AND c.organization_id = ${actor.organizationId}`;
  const campaign = rows[0];
  if (!campaign) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
  if (lock) await recheckSourceActor(sql as Database,actor);
  requireBranch(actor, campaign.branch_id);
  return campaign;
}

async function readiness(sql: Database | postgres.TransactionSql, campaign: postgres.Row,lock=false): Promise<string[]> {
  const issues: string[] = [];
  if (!campaign.branch_active) issues.push('BRANCH_INACTIVE');
  if (campaign.routing_method !== 'MANUAL') {
    const eligible = await sql`SELECT 1 FROM campaign_agent ca JOIN user_account u ON u.id = ca.agent_id
      WHERE ca.campaign_id = ${campaign.id} AND ca.active AND u.active AND u.role = 'AGENT'
        AND u.branch_id = ${campaign.branch_id} LIMIT 1`;
    if (!eligible.length) issues.push('NO_ELIGIBLE_AGENTS_CONFIGURED');
  }
  if (campaign.routing_method === 'PERFORMANCE') {
    const [policy] = await sql`SELECT 1 FROM campaign_performance_routing_policy WHERE campaign_id=${campaign.id}`;
    if (!policy) issues.push('PERFORMANCE_POLICY_REQUIRED');
  }
  issues.push(...await sourceCampaignIssues(sql as Database,campaign,lock));
  // The first-contact flow is implemented and verified by ai-initial-contact integration and Browser E2E.
  // Fail closed on its current scoped configuration. This never enables the separate live transport gate.
  issues.push(...await initialCampaignIssues(sql,campaign));
  return issues;
}

export function registerCampaignRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Querystring: { limit?: number; cursor?: string; branchId?: string } }>('/api/campaigns', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 }, branchId: { type: 'string', format: 'uuid' },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const q = request.query;
    if (q.branchId) requireBranch(actor, q.branchId);
    const cursor = decodeCursor(q.cursor);
    const limit = q.limit ?? 30;
    if (actor.role === 'AGENT') {
      const rows = await db`SELECT c.id, c.branch_id, c.name, c.status, c.created_at
        FROM campaign c WHERE c.organization_id = ${actor.organizationId} AND c.branch_id = ${actor.branchId}
          AND (${q.branchId ?? null}::uuid IS NULL OR c.branch_id = ${q.branchId ?? null})
          AND EXISTS (SELECT 1 FROM lead l WHERE l.campaign_id = c.id AND l.assigned_agent_id = ${actor.id})
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR
            (c.created_at, c.id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
    }
    const rows = await db`SELECT c.id, c.branch_id, c.name, c.status, c.source_kind, c.routing_method, c.version, c.created_at,
      COALESCE(jsonb_agg(jsonb_build_object('agentId', ca.agent_id, 'name', u.name, 'weight', ca.weight,
          'capacityOverride', ca.capacity_override) ORDER BY u.name)
          FILTER (WHERE ca.active AND u.id IS NOT NULL), '[]'::jsonb) AS agents
      FROM campaign c LEFT JOIN campaign_agent ca ON ca.campaign_id = c.id
      LEFT JOIN user_account u ON u.id = ca.agent_id
      WHERE c.organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR c.branch_id = ${actor.branchId})
        AND (${q.branchId ?? null}::uuid IS NULL OR c.branch_id = ${q.branchId ?? null})
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR
          (c.created_at, c.id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
  });

  app.post<{ Body: { branchId: string; name: string; sourceKind?: string; routingMethod?: RoutingMethod } }>('/api/campaigns', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['branchId','name'], properties: {
      branchId: { type: 'string', format: 'uuid' }, name: { type: 'string', minLength: 1, maxLength: 200 },
      sourceKind: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' }, routingMethod: { enum: routingMethods },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    requireBranch(actor, request.body.branchId);
    if (!request.body.name.trim()) throw new HttpError(400, 'INVALID_CAMPAIGN_NAME');
    const branch = await db`SELECT 1 FROM branch WHERE id = ${request.body.branchId} AND organization_id = ${actor.organizationId} AND active`;
    if (!branch.length) throw new HttpError(404, 'BRANCH_NOT_FOUND');
    const id = await db.begin(async (tx) => {
      const created = await tx`INSERT INTO campaign (organization_id, branch_id, name, source_kind, routing_method)
        VALUES (${actor.organizationId}, ${request.body.branchId}, ${request.body.name.trim()}, ${request.body.sourceKind ?? 'MANUAL'}, ${request.body.routingMethod ?? 'MANUAL'}) RETURNING id`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${request.body.branchId}, ${actor.id}, 'CAMPAIGN_CREATED', 'CAMPAIGN', ${created[0]!.id})`;
      return created[0]!.id as string;
    });
    reply.code(201);
    return { id };
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => {
      const campaign = await managedCampaign(tx, actor, request.params.id);
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'CAMPAIGN_ACCESS_REVOKED');
      const [conversionField] = campaign.conversion_config?.type === 'FIELD_VALUE'
        ? await tx`SELECT f.id,f.key,f.label,f.field_type,f.value_mode,f.options,f.validation
          FROM campaign c CROSS JOIN LATERAL campaign_conversion_field(c,c.conversion_config,${actor.role}) f
          WHERE c.id=${campaign.id} AND c.version=${campaign.version}`
        : [];
      const visibleCampaign = campaign.conversion_config?.type === 'FIELD_VALUE' && !conversionField
        ? { ...campaign, conversion_config: { type: 'FIELD_VALUE', unavailable: true } } : campaign;
      const agents = await tx`SELECT ca.agent_id, u.name, ca.active, ca.weight, ca.capacity_override, u.active AS account_active
        FROM campaign_agent ca JOIN user_account u ON u.id = ca.agent_id WHERE ca.campaign_id = ${campaign.id} ORDER BY u.name`;
      return { campaign: visibleCampaign, conversionField: conversionField ?? null, agents, issues: await readiness(tx, campaign) };
    });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/campaigns/:id/conversion-fields', {
    schema: { params: idParam, querystring: { type: 'object', additionalProperties: false,
      properties: { after: { type: 'string', format: 'uuid' } } } },
  }, async request => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => {
      const campaign = await managedCampaign(tx, actor, request.params.id);
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'CAMPAIGN_ACCESS_REVOKED');
      const rows = await tx`SELECT f.id,f.key,f.label,f.field_type,f.value_mode,f.options,f.validation
        FROM campaign c JOIN campaign_field cf ON c.id=cf.campaign_id JOIN field_definition f ON f.id=cf.field_id
        WHERE c.id=${campaign.id} AND campaign_conversion_field_allowed(c,f,cf,${actor.role})
          AND (${request.query.after ?? null}::uuid IS NULL OR f.id>${request.query.after ?? null}) ORDER BY f.id LIMIT 51`;
      return { items: rows.slice(0,50), nextAfter: rows.length>50 ? rows[49]!.id : null };
    });
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/readiness', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const campaign = await managedCampaign(db, actor, request.params.id);
    const issues = await readiness(db, campaign);
    return { ready: issues.length === 0, issues, version: campaign.version, status: campaign.status };
  });

  const performancePath='/api/campaigns/:id/performance-routing';
  app.get<{Params:{id:string}}>(performancePath,{schema:{params:idParam}},async request=>{
    const actor=await principalFromRequest(request,db);
    return db.begin(async tx=>{
      const campaign=await managedCampaign(tx,actor,request.params.id);
      if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'PERFORMANCE_POLICY_ACCESS_DENIED');
      const [policy]=await tx`SELECT version,lookback_days AS "lookbackDays",minimum_samples AS "minimumSamples",
        response_weight AS "responseWeight",follow_up_weight AS "followUpWeight",fallback_method AS "fallbackMethod",
        reason,changed_at AS "changedAt" FROM campaign_performance_routing_policy WHERE campaign_id=${campaign.id}`;
      return {policy:policy??null};
    });
  });
  app.put<{Params:{id:string};Body:PerformancePolicyInput}>(performancePath,{
    schema:{params:idParam,body:{type:'object',additionalProperties:false,
      required:['version','lookbackDays','minimumSamples','responseWeight','followUpWeight','fallbackMethod','reason'],
      properties:{version:{type:'integer',minimum:0,maximum:2147483646},lookbackDays:{type:'integer',minimum:1,maximum:90},
        minimumSamples:{type:'integer',minimum:1,maximum:100},responseWeight:{type:'integer',minimum:0,maximum:100},
        followUpWeight:{type:'integer',minimum:0,maximum:100},fallbackMethod:{enum:performanceFallbacks},
        reason:{type:'string',minLength:3,maxLength:500}}}},
  },async request=>{
    const actor=await principalFromRequest(request,db),input=request.body;
    const reason=input.reason.trim();
    if(input.responseWeight+input.followUpWeight!==100||reason.length<3||/[\x00-\x1f\x7f]/.test(input.reason))
      throw new HttpError(400,'PERFORMANCE_POLICY_INVALID');
    return db.begin(async tx=>{
      const campaign=await managedCampaign(tx,actor,request.params.id,true);
      const session=await currentPaymentSession(tx,actor,request);
      if(!session)throw new HttpError(403,'PERFORMANCE_POLICY_ACCESS_DENIED');
      if(campaign.status==='ACTIVE')throw new HttpError(409,'PERFORMANCE_POLICY_CAMPAIGN_ACTIVE');
      const [current]=await tx`SELECT version FROM campaign_performance_routing_policy WHERE campaign_id=${campaign.id}`;
      if((current?.version??0)!==input.version)throw new HttpError(409,'PERFORMANCE_POLICY_VERSION_CONFLICT');
      const version=input.version+1;
      const policy={version,lookback_days:input.lookbackDays,minimum_samples:input.minimumSamples,
        response_weight:input.responseWeight,follow_up_weight:input.followUpWeight,fallback_method:input.fallbackMethod,
        actor_id:actor.id,session_id:session,reason};
      if(current)await tx`UPDATE campaign_performance_routing_policy SET ${tx(policy)} WHERE campaign_id=${campaign.id}`;
      else await tx`INSERT INTO campaign_performance_routing_policy ${tx({campaign_id:campaign.id,...policy})}`;
      return {version};
    });
  });
  app.get<{Params:{id:string};Querystring:{before?:number}}>(performancePath+'/history',{
    schema:{params:idParam,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}},
  },async request=>{
    const actor=await principalFromRequest(request,db);
    return db.begin(async tx=>{
      const campaign=await managedCampaign(tx,actor,request.params.id);
      if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'PERFORMANCE_POLICY_ACCESS_DENIED');
      const rows=await tx`SELECT version,changed_at AS "changedAt",snapshot->>'reason' AS reason,
        (snapshot->>'lookback_days')::integer AS "lookbackDays",(snapshot->>'minimum_samples')::integer AS "minimumSamples",
        (snapshot->>'response_weight')::integer AS "responseWeight",(snapshot->>'follow_up_weight')::integer AS "followUpWeight",
        snapshot->>'fallback_method' AS "fallbackMethod" FROM campaign_performance_routing_policy_history
        WHERE campaign_id=${campaign.id} AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null})
        ORDER BY version DESC LIMIT 11`;
      return {items:rows.slice(0,10),nextVersion:rows.length>10?rows[9]!.version:null};
    });
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string; after?: string; limit?: number } }>('/api/campaigns/:id/eligible-agents', {
    schema: { params: idParam, querystring: { type: 'object', additionalProperties: false, properties: {
      q: { type: 'string', maxLength: 100 }, after: { type: 'string', format: 'uuid' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const campaign = await managedCampaign(db, actor, request.params.id);
    const limit = request.query.limit ?? 30;
    const query = request.query.q?.trim().toLocaleLowerCase() ?? '';
    const rows = await db`SELECT id, name FROM user_account WHERE organization_id = ${actor.organizationId}
      AND branch_id = ${campaign.branch_id} AND role = 'AGENT' AND active
      AND (${query} = '' OR position(${query} in lower(name)) > 0 OR position(${query} in lower(email)) > 0)
      AND (${request.query.after ?? null}::uuid IS NULL OR id > ${request.query.after ?? null})
      ORDER BY id LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  });

  app.patch<{ Params: { id: string }; Body: CampaignUpdate }>('/api/campaigns/:id', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false,
      required: ['version','name','sourceKind','routingMethod','messagingEnabled','aiEnabled'], properties: {
        version: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1, maxLength: 200 },
        sourceKind: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' }, routingMethod: { enum: routingMethods },
        messagingEnabled: { type: 'boolean' }, aiEnabled: { type: 'boolean' },
        conversion: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
          required: ['type'], properties: { type: { enum: ['PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED'] } } },
          { type: 'object', additionalProperties: false, required: ['type','fieldId','value'],
            properties: { type: { const: 'FIELD_VALUE' }, fieldId: { type: 'string', format: 'uuid' }, value: {} } }] },
      } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const campaign = await managedCampaign(tx, actor, request.params.id, true);
      if (campaign.version !== request.body.version) throw new HttpError(409, 'CAMPAIGN_VERSION_CONFLICT');
      if (campaign.status === 'ACTIVE') throw new HttpError(409, 'DEACTIVATE_CAMPAIGN_BEFORE_EDIT');
      if (!request.body.name.trim()) throw new HttpError(400, 'INVALID_CAMPAIGN_NAME');
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'CAMPAIGN_ACCESS_REVOKED');
      let conversion = request.body.conversion === undefined ? campaign.conversion_config : request.body.conversion ?? {};
      if (request.body.conversion?.type === 'FIELD_VALUE') {
        const selection = request.body.conversion;
        const [field] = await tx`SELECT f.id,f.field_type,f.options,f.validation
          FROM campaign c JOIN campaign_field cf ON c.id=cf.campaign_id JOIN field_definition f ON f.id=cf.field_id
          WHERE c.id=${campaign.id} AND f.id=${selection.fieldId}
            AND campaign_conversion_field_allowed(c,f,cf,${actor.role}) FOR SHARE OF f,cf`;
        if (!field) throw new HttpError(404, 'CONVERSION_FIELD_NOT_FOUND');
        const value = validateFieldValue(field.field_type as FieldType, selection.value,
          field.options as FieldOption[], field.validation as FieldValidation);
        if (value === null || !(await tx`SELECT stored_field_value_valid(${tx.json(value as postgres.JSONValue)},f) AS valid
          FROM field_definition f WHERE f.id=${field.id}`)[0]?.valid) throw new HttpError(400, 'CONVERSION_VALUE_INVALID');
        conversion = { type: selection.type, fieldId: field.id, value };
      }
      const changed = await tx`UPDATE campaign SET name = ${request.body.name.trim()}, source_kind = ${request.body.sourceKind},
        routing_method = ${request.body.routingMethod}, messaging_config = ${tx.json({ enabled: request.body.messagingEnabled })},
        ai_config = ${tx.json({ enabled: request.body.aiEnabled })}, conversion_config = ${tx.json(conversion)},
        version = version + 1, updated_at = now() WHERE id = ${campaign.id} RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
        VALUES (${actor.organizationId}, ${campaign.branch_id}, ${actor.id}, 'CAMPAIGN_UPDATED', 'CAMPAIGN', ${campaign.id},
          ${tx.json({ fromVersion: campaign.version, toVersion: changed[0]!.version,
            conversionType: conversion?.type ?? null, conversionFieldId: conversion?.fieldId ?? null })})`;
      return { version: changed[0]!.version };
    });
  });

  app.put<{ Params: { id: string }; Body: { agentId: string; weight?: number; capacityOverride?: number | null } }>('/api/campaigns/:id/agents', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, required: ['agentId'], properties: {
      agentId: { type: 'string', format: 'uuid' }, weight: { type: 'integer', minimum: 1, maximum: 1000 },
      capacityOverride: { type: ['integer', 'null'], minimum: 0 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const campaign = await managedCampaign(tx, actor, request.params.id, true);
      const agents = await tx`SELECT 1 FROM user_account WHERE id = ${request.body.agentId} AND organization_id = ${actor.organizationId}
        AND branch_id = ${campaign.branch_id} AND role = 'AGENT' AND active`;
      if (!agents.length) throw new HttpError(400, 'AGENT_NOT_ELIGIBLE');
      await tx`INSERT INTO campaign_agent (campaign_id, agent_id, weight, capacity_override)
        VALUES (${campaign.id}, ${request.body.agentId}, ${request.body.weight ?? 1}, ${request.body.capacityOverride ?? null})
        ON CONFLICT (campaign_id, agent_id) DO UPDATE SET active = true, weight = EXCLUDED.weight, capacity_override = EXCLUDED.capacity_override`;
      const changed = await tx`UPDATE campaign SET version = version + 1, updated_at = now() WHERE id = ${campaign.id} RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
        VALUES (${actor.organizationId}, ${campaign.branch_id}, ${actor.id}, 'CAMPAIGN_AGENT_SET', 'CAMPAIGN', ${campaign.id},
          ${tx.json({ agentId: request.body.agentId, weight: request.body.weight ?? 1, capacityOverride: request.body.capacityOverride ?? null })})`;
      return { ok: true, version: changed[0]!.version };
    });
  });

  app.delete<{ Params: { id: string; agentId: string } }>('/api/campaigns/:id/agents/:agentId', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['id','agentId'], properties: {
      id: { type: 'string', format: 'uuid' }, agentId: { type: 'string', format: 'uuid' },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const campaign = await managedCampaign(tx, actor, request.params.id, true);
      const changed = await tx`UPDATE campaign_agent SET active = false WHERE campaign_id = ${campaign.id}
        AND agent_id = ${request.params.agentId} AND active RETURNING agent_id`;
      if (!changed.length) throw new HttpError(404, 'CAMPAIGN_AGENT_NOT_FOUND');
      if (campaign.status === 'ACTIVE' && campaign.routing_method !== 'MANUAL') {
        const issues = await readiness(tx, campaign);
        if (issues.length) throw new HttpError(409, 'CAMPAIGN_NOT_READY', issues.join(','));
      }
      const version = await tx`UPDATE campaign SET version = version + 1, updated_at = now() WHERE id = ${campaign.id} RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
        VALUES (${actor.organizationId}, ${campaign.branch_id}, ${actor.id}, 'CAMPAIGN_AGENT_REMOVED', 'CAMPAIGN', ${campaign.id},
          ${tx.json({ agentId: request.params.agentId })})`;
      return { ok: true, version: version[0]!.version };
    });
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/activate', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const campaign = await managedCampaign(tx, actor, request.params.id, true);
      const issues = await readiness(tx, campaign,true);
      if (issues.length) throw new HttpError(409, 'CAMPAIGN_NOT_READY', issues.join(','));
      if (campaign.status === 'ACTIVE') return { status: 'ACTIVE', version: campaign.version };
      const changed = await tx`UPDATE campaign SET status = 'ACTIVE', version = version + 1, last_activated_at = now(), updated_at = now()
        WHERE id = ${campaign.id} RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${campaign.branch_id}, ${actor.id}, 'CAMPAIGN_ACTIVATED', 'CAMPAIGN', ${campaign.id})`;
      return { status: 'ACTIVE', version: changed[0]!.version };
    });
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/deactivate', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const campaign = await managedCampaign(tx, actor, request.params.id, true);
      if (campaign.status === 'INACTIVE') return { status: 'INACTIVE', version: campaign.version };
      const changed = await tx`UPDATE campaign SET status = 'INACTIVE', version = version + 1,
        last_deactivated_at = now(), updated_at = now() WHERE id = ${campaign.id} RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${campaign.branch_id}, ${actor.id}, 'CAMPAIGN_DEACTIVATED', 'CAMPAIGN', ${campaign.id})`;
      return { status: 'INACTIVE', version: changed[0]!.version };
    });
  });
}
