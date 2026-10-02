import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireBranch, requireLead, requireRole } from '../security.js';
import { routeLead } from '../routing.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { identityLockKeys, normalizeContact } from '../contacts.js';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const pageQuery = { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 }, branchId: { type: 'string', format: 'uuid' }, campaignId: { type: 'string', format: 'uuid' }, contactId: { type: 'string', format: 'uuid' }, assignedAgentId: { type: 'string', format: 'uuid' }, lifecycle: { enum: ['OPEN','CLOSED','ARCHIVED'] } } } as const;

export function registerOperationsRoutes(app: FastifyInstance, db: Database): void {
  app.get('/api/branches', async (request) => {
    const actor = await principalFromRequest(request, db);
    const rows = await db`SELECT id, name, timezone, active, business_hours, ai_defaults, created_at FROM branch
      WHERE organization_id = ${actor.organizationId} AND (${actor.role === 'SUPER_ADMIN'} OR id = ${actor.branchId}) ORDER BY name`;
    return { items: rows };
  });

  app.post<{ Body: { name: string; timezone: string } }>('/api/branches', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name','timezone'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 }, timezone: { type: 'string', minLength: 1, maxLength: 100 },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN');
    try { new Intl.DateTimeFormat('en', { timeZone: request.body.timezone }); } catch { throw new HttpError(400, 'INVALID_TIMEZONE'); }
    const rows = await db.begin(async (tx) => {
      const created = await tx`INSERT INTO branch (organization_id, name, timezone)
        VALUES (${actor.organizationId}, ${request.body.name.trim()}, ${request.body.timezone}) RETURNING id`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${created[0]!.id}, ${actor.id}, 'BRANCH_CREATED', 'BRANCH', ${created[0]!.id})`;
      return created;
    });
    reply.code(201); return { id: rows[0]!.id };
  });

  app.get('/api/campaigns', async (request) => {
    const actor = await principalFromRequest(request, db);
    if (actor.role === 'AGENT') {
      const rows = await db`SELECT c.id, c.branch_id, c.name, c.status
        FROM campaign c WHERE c.organization_id = ${actor.organizationId}
          AND EXISTS (SELECT 1 FROM lead l WHERE l.campaign_id = c.id AND l.assigned_agent_id = ${actor.id})
        ORDER BY c.created_at DESC, c.id DESC LIMIT 100`;
      return { items: rows };
    }
    const rows = await db`SELECT c.id, c.branch_id, c.name, c.status, c.source_kind, c.routing_method, c.created_at,
      COALESCE(jsonb_agg(jsonb_build_object('agentId', ca.agent_id, 'name', u.name) ORDER BY u.name)
        FILTER (WHERE ca.active = true AND u.id IS NOT NULL), '[]'::jsonb) AS agents
      FROM campaign c LEFT JOIN campaign_agent ca ON ca.campaign_id = c.id
      LEFT JOIN user_account u ON u.id = ca.agent_id
      WHERE c.organization_id = ${actor.organizationId} AND (${actor.role === 'SUPER_ADMIN'} OR c.branch_id = ${actor.branchId})
      GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC LIMIT 100`;
    return { items: rows };
  });

  app.post<{ Body: { branchId: string; name: string; sourceKind?: string; routingMethod?: 'MANUAL'|'ROUND_ROBIN'|'WEIGHTED'|'PERFORMANCE' } }>('/api/campaigns', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['branchId','name'], properties: {
      branchId: { type: 'string', format: 'uuid' }, name: { type: 'string', minLength: 1, maxLength: 200 },
      sourceKind: { type: 'string', minLength: 1, maxLength: 40 }, routingMethod: { enum: ['MANUAL','ROUND_ROBIN','WEIGHTED','PERFORMANCE'] },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    requireBranch(actor, request.body.branchId);
    const branch = await db`SELECT 1 FROM branch WHERE id = ${request.body.branchId} AND organization_id = ${actor.organizationId} AND active`;
    if (!branch.length) throw new HttpError(404, 'BRANCH_NOT_FOUND');
    const rows = await db.begin(async (tx) => {
      const created = await tx`INSERT INTO campaign (organization_id, branch_id, name, source_kind, routing_method)
        VALUES (${actor.organizationId}, ${request.body.branchId}, ${request.body.name.trim()}, ${request.body.sourceKind ?? 'MANUAL'}, ${request.body.routingMethod ?? 'MANUAL'}) RETURNING id`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${request.body.branchId}, ${actor.id}, 'CAMPAIGN_CREATED', 'CAMPAIGN', ${created[0]!.id})`;
      return created;
    });
    reply.code(201); return { id: rows[0]!.id };
  });

  app.put<{ Params: { id: string }; Body: { agentId: string; weight?: number; capacityOverride?: number } }>('/api/campaigns/:id/agents', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, required: ['agentId'], properties: {
      agentId: { type: 'string', format: 'uuid' }, weight: { type: 'integer', minimum: 1, maximum: 1000 }, capacityOverride: { type: 'integer', minimum: 0 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const campaigns = await db`SELECT branch_id FROM campaign WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId}`;
    const campaign = campaigns[0]; if (!campaign) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
    requireBranch(actor, campaign.branch_id);
    const agents = await db`SELECT 1 FROM user_account WHERE id = ${request.body.agentId} AND branch_id = ${campaign.branch_id} AND role = 'AGENT' AND active`;
    if (!agents.length) throw new HttpError(400, 'AGENT_NOT_ELIGIBLE');
    await db`INSERT INTO campaign_agent (campaign_id, agent_id, weight, capacity_override)
      VALUES (${request.params.id}, ${request.body.agentId}, ${request.body.weight ?? 1}, ${request.body.capacityOverride ?? null})
      ON CONFLICT (campaign_id, agent_id) DO UPDATE SET active = true, weight = EXCLUDED.weight, capacity_override = EXCLUDED.capacity_override`;
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/activate', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const rows = await db`SELECT id, branch_id, source_kind, routing_method, ai_config, messaging_config FROM campaign WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId}`;
    const campaign = rows[0]; if (!campaign) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
    requireBranch(actor, campaign.branch_id);
    const issues: string[] = [];
    if (campaign.routing_method !== 'MANUAL') {
      const agents = await db`SELECT 1 FROM campaign_agent WHERE campaign_id = ${campaign.id} AND active LIMIT 1`;
      if (!agents.length) issues.push('NO_ELIGIBLE_AGENTS_CONFIGURED');
    }
    if (campaign.ai_config?.enabled) issues.push('AI_CONFIGURATION_NOT_READY');
    if (campaign.messaging_config?.enabled) issues.push('MESSAGING_CONFIGURATION_NOT_READY');
    if (campaign.source_kind !== 'MANUAL') issues.push('SOURCE_BINDING_NOT_READY');
    if (issues.length) throw new HttpError(409, 'CAMPAIGN_NOT_READY', issues.join(','));
    await db`UPDATE campaign SET status = 'ACTIVE', updated_at = now() WHERE id = ${campaign.id}`;
    return { status: 'ACTIVE' };
  });

  app.post<{ Body: { branchId: string; campaignId: string; contact: { name: string; phone?: string; email?: string } } }>('/api/leads', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['branchId','campaignId','contact'], properties: {
      branchId: { type: 'string', format: 'uuid' }, campaignId: { type: 'string', format: 'uuid' },
      contact: { type: 'object', additionalProperties: false, required: ['name'], properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 }, phone: { type: 'string', maxLength: 50 }, email: { type: 'string', maxLength: 320 },
      } },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    requireBranch(actor, request.body.branchId);
    const campaigns = await db`SELECT c.id, c.routing_method, b.timezone FROM campaign c JOIN branch b ON b.id = c.branch_id
      WHERE c.id = ${request.body.campaignId} AND c.branch_id = ${request.body.branchId} AND c.organization_id = ${actor.organizationId} AND c.status = 'ACTIVE'`;
    const campaign = campaigns[0]; if (!campaign) throw new HttpError(404, 'ACTIVE_CAMPAIGN_NOT_FOUND');
    const normalized = normalizeContact(request.body.contact);
    const result = await db.begin(async (tx) => {
      for (const identity of identityLockKeys(actor.organizationId, normalized)) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
      const matches = await tx`SELECT id FROM contact WHERE organization_id = ${actor.organizationId}
        AND ((${normalized.phoneNormalized}::text IS NOT NULL AND phone_normalized = ${normalized.phoneNormalized})
          OR (${normalized.emailNormalized}::text IS NOT NULL AND email_normalized = ${normalized.emailNormalized}))
        ORDER BY id`;
      const crossBranchOnly = matches.length === 1 && actor.role === 'MANAGER' &&
        !(await tx`SELECT 1 FROM lead WHERE contact_id = ${matches[0]!.id} AND branch_id = ${request.body.branchId} LIMIT 1`).length;
      if (matches.length > 1 || crossBranchOnly) {
        const reason = crossBranchOnly ? 'CONTACT_SCOPE_REVIEW' : 'CONTACT_AMBIGUOUS';
        const review = await tx`INSERT INTO source_submission
          (organization_id, branch_id, campaign_id, source_kind, raw_payload, state, failure_code)
          VALUES (${actor.organizationId}, ${request.body.branchId}, ${campaign.id}, 'MANUAL',
            ${tx.json({ contact: request.body.contact, candidateContactIds: matches.map((item) => item.id) })}, 'NEEDS_ATTENTION', ${reason})
          RETURNING id`;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
          VALUES (${actor.organizationId}, ${request.body.branchId}, ${actor.id}, 'CONTACT_MATCH_REVIEW_CREATED', 'SOURCE_SUBMISSION', ${review[0]!.id}, ${tx.json({ reason })})`;
        return { reviewId: review[0]!.id as string };
      }
      let contactId = matches[0]?.id as string | undefined;
      if (!contactId) {
        const created = await tx`INSERT INTO contact (organization_id, name, phone, phone_normalized, email, email_normalized)
          VALUES (${actor.organizationId}, ${normalized.name}, ${normalized.phone}, ${normalized.phoneNormalized}, ${normalized.email}, ${normalized.emailNormalized}) RETURNING id`;
        contactId = created[0]!.id as string;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
          VALUES (${actor.organizationId}, ${request.body.branchId}, ${actor.id}, 'CONTACT_CREATED', 'CONTACT', ${contactId})`;
      }
      const leads = await tx`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
        VALUES (${actor.organizationId}, ${request.body.branchId}, ${campaign.id}, ${contactId}, 'MANUAL') RETURNING id`;
      const leadId = leads[0]!.id as string;
      await tx`INSERT INTO source_submission (organization_id, branch_id, campaign_id, lead_id, source_kind, raw_payload, state)
        VALUES (${actor.organizationId}, ${request.body.branchId}, ${campaign.id}, ${leadId}, 'MANUAL', ${tx.json({ contact: request.body.contact })}, 'PROCESSED')`;
      await tx`INSERT INTO lead_activity (lead_id, actor_user_id, event_type) VALUES (${leadId}, ${actor.id}, 'LEAD_CREATED')`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${request.body.branchId}, ${actor.id}, 'LEAD_CREATED', 'LEAD', ${leadId})`;
      await routeLead(tx, campaign.id, request.body.branchId, campaign.routing_method, campaign.timezone, leadId);
      return { id: leadId };
    });
    if ('reviewId' in result) { reply.code(202); return { reviewId: result.reviewId, status: 'NEEDS_ATTENTION' }; }
    reply.code(201); return result;
  });

  app.get<{ Querystring: { limit?: number; cursor?: string; branchId?: string; campaignId?: string; contactId?: string; assignedAgentId?: string; lifecycle?: string } }>('/api/leads', {
    schema: { querystring: pageQuery },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const q = request.query;
    const cursor = decodeCursor(q.cursor);
    const limit = Math.min(q.limit ?? 30, 100);
    if (q.branchId) requireBranch(actor, q.branchId);
    const rows = await db`
      SELECT l.id, l.branch_id, l.campaign_id, l.assigned_agent_id, l.lifecycle, l.source_kind,
        l.needs_attention_reason, l.created_at, c.name AS contact_name, c.phone, c.email
      FROM lead l JOIN contact c ON c.id = l.contact_id
      WHERE l.organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId})
          OR (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))
        AND (${q.branchId ?? null}::uuid IS NULL OR l.branch_id = ${q.branchId ?? null})
        AND (${q.campaignId ?? null}::uuid IS NULL OR l.campaign_id = ${q.campaignId ?? null})
        AND (${q.contactId ?? null}::uuid IS NULL OR l.contact_id = ${q.contactId ?? null})
        AND (${q.assignedAgentId ?? null}::uuid IS NULL OR l.assigned_agent_id = ${q.assignedAgentId ?? null})
        AND (${q.lifecycle ?? null}::text IS NULL OR l.lifecycle = ${q.lifecycle ?? null})
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (l.created_at, l.id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      ORDER BY l.created_at DESC, l.id DESC LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
  });

  app.get<{ Params: { id: string } }>('/api/leads/:id', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const lead = await requireLead(db, actor, request.params.id);
    const activities = await db`SELECT id, actor_user_id, event_type, detail, created_at FROM lead_activity WHERE lead_id = ${lead.id} ORDER BY id DESC LIMIT 100`;
    return { lead, activities };
  });

  app.post<{ Params: { id: string }; Body: { lifecycle: 'OPEN'|'CLOSED'|'ARCHIVED' } }>('/api/leads/:id/lifecycle', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, required: ['lifecycle'], properties: { lifecycle: { enum: ['OPEN','CLOSED','ARCHIVED'] } } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const lead = await requireLead(db, actor, request.params.id);
    await db.begin(async (tx) => {
      await tx`UPDATE lead SET lifecycle = ${request.body.lifecycle}, closed_at = ${request.body.lifecycle === 'OPEN' ? null : new Date()}, updated_at = now() WHERE id = ${lead.id}`;
      await tx`INSERT INTO lead_activity (lead_id, actor_user_id, event_type, detail) VALUES (${lead.id}, ${actor.id}, 'LIFECYCLE_CHANGED', ${tx.json({ from: lead.lifecycle, to: request.body.lifecycle })})`;
    });
    return { lifecycle: request.body.lifecycle };
  });
}
