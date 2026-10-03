import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { HttpError, principalFromRequest, requireBranch, requireRole, type Principal } from '../security.js';

const idParam = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const routingMethods = ['MANUAL', 'ROUND_ROBIN', 'WEIGHTED', 'PERFORMANCE'] as const;
type RoutingMethod = typeof routingMethods[number];
type CampaignUpdate = {
  version: number;
  name: string;
  sourceKind: string;
  routingMethod: RoutingMethod;
  messagingEnabled: boolean;
  aiEnabled: boolean;
  conversion: { type: 'PAYMENT_CONFIRMED' | 'ENROLLMENT_CONFIRMED' } | null;
};

async function managedCampaign(sql: Database | postgres.TransactionSql, actor: Principal, id: string, lock = false) {
  requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  const rows = lock
    ? await sql`SELECT c.*, b.active AS branch_active FROM campaign c JOIN branch b ON b.id = c.branch_id
        WHERE c.id = ${id} AND c.organization_id = ${actor.organizationId} FOR UPDATE OF c`
    : await sql`SELECT c.*, b.active AS branch_active FROM campaign c JOIN branch b ON b.id = c.branch_id
        WHERE c.id = ${id} AND c.organization_id = ${actor.organizationId}`;
  const campaign = rows[0];
  if (!campaign) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
  requireBranch(actor, campaign.branch_id);
  return campaign;
}

async function readiness(sql: Database | postgres.TransactionSql, campaign: postgres.Row): Promise<string[]> {
  const issues: string[] = [];
  if (!campaign.branch_active) issues.push('BRANCH_INACTIVE');
  if (campaign.routing_method !== 'MANUAL') {
    const eligible = await sql`SELECT 1 FROM campaign_agent ca JOIN user_account u ON u.id = ca.agent_id
      WHERE ca.campaign_id = ${campaign.id} AND ca.active AND u.active AND u.role = 'AGENT'
        AND u.branch_id = ${campaign.branch_id} LIMIT 1`;
    if (!eligible.length) issues.push('NO_ELIGIBLE_AGENTS_CONFIGURED');
  }
  // Performance scoring requires human-only metrics and a configured sample/fallback policy.
  if (campaign.routing_method === 'PERFORMANCE') issues.push('PERFORMANCE_ROUTING_NOT_READY');
  if (campaign.source_kind !== 'MANUAL') issues.push('SOURCE_BINDING_NOT_READY');
  if (campaign.messaging_config?.enabled) issues.push('MESSAGING_CONFIGURATION_NOT_READY');
  if (campaign.ai_config?.enabled) issues.push('AI_CONFIGURATION_NOT_READY');
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
    const campaign = await managedCampaign(db, actor, request.params.id);
    const agents = await db`SELECT ca.agent_id, u.name, ca.active, ca.weight, ca.capacity_override, u.active AS account_active
      FROM campaign_agent ca JOIN user_account u ON u.id = ca.agent_id WHERE ca.campaign_id = ${campaign.id} ORDER BY u.name`;
    return { campaign, agents, issues: await readiness(db, campaign) };
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id/readiness', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const campaign = await managedCampaign(db, actor, request.params.id);
    const issues = await readiness(db, campaign);
    return { ready: issues.length === 0, issues, version: campaign.version, status: campaign.status };
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
      required: ['version','name','sourceKind','routingMethod','messagingEnabled','aiEnabled','conversion'], properties: {
        version: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1, maxLength: 200 },
        sourceKind: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' }, routingMethod: { enum: routingMethods },
        messagingEnabled: { type: 'boolean' }, aiEnabled: { type: 'boolean' },
        conversion: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
          required: ['type'], properties: { type: { enum: ['PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED'] } } }] },
      } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const campaign = await managedCampaign(tx, actor, request.params.id, true);
      if (campaign.version !== request.body.version) throw new HttpError(409, 'CAMPAIGN_VERSION_CONFLICT');
      if (campaign.status === 'ACTIVE') throw new HttpError(409, 'DEACTIVATE_CAMPAIGN_BEFORE_EDIT');
      if (!request.body.name.trim()) throw new HttpError(400, 'INVALID_CAMPAIGN_NAME');
      const changed = await tx`UPDATE campaign SET name = ${request.body.name.trim()}, source_kind = ${request.body.sourceKind},
        routing_method = ${request.body.routingMethod}, messaging_config = ${tx.json({ enabled: request.body.messagingEnabled })},
        ai_config = ${tx.json({ enabled: request.body.aiEnabled })}, conversion_config = ${tx.json(request.body.conversion ?? {})},
        version = version + 1, updated_at = now() WHERE id = ${campaign.id} RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
        VALUES (${actor.organizationId}, ${campaign.branch_id}, ${actor.id}, 'CAMPAIGN_UPDATED', 'CAMPAIGN', ${campaign.id},
          ${tx.json({ fromVersion: campaign.version, toVersion: changed[0]!.version })})`;
      return { version: changed[0]!.version };
    });
  });

  app.put<{ Params: { id: string }; Body: { agentId: string; weight?: number; capacityOverride?: number | null } }>('/api/campaigns/:id/agents', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, required: ['agentId'], properties: {
      agentId: { type: 'string', format: 'uuid' }, weight: { type: 'integer', minimum: 1, maximum: 1000 },
      capacityOverride: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0 }] },
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
      const issues = await readiness(tx, campaign);
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
