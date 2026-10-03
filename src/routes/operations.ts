import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireBranch, requireLead, requireRole } from '../security.js';
import { routeLead } from '../routing.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { identityLockKeys, normalizeContact } from '../contacts.js';
import { enforceRequiredFieldStage, prepareManualFieldValues, storeManualFieldValues, type ManualFieldInput } from '../field-values.js';
import { registerCampaignRoutes } from './campaigns.js';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const pageQuery = { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 }, branchId: { type: 'string', format: 'uuid' }, campaignId: { type: 'string', format: 'uuid' }, contactId: { type: 'string', format: 'uuid' }, assignedAgentId: { type: 'string', format: 'uuid' }, lifecycle: { enum: ['OPEN','CLOSED','ARCHIVED'] } } } as const;

export function registerOperationsRoutes(app: FastifyInstance, db: Database): void {
  registerCampaignRoutes(app, db);
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

  app.post<{ Body: { branchId: string; campaignId: string; contact: { name: string; phone?: string; email?: string }; fields?: ManualFieldInput[] } }>('/api/leads', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['branchId','campaignId','contact'], properties: {
      branchId: { type: 'string', format: 'uuid' }, campaignId: { type: 'string', format: 'uuid' },
      contact: { type: 'object', additionalProperties: false, required: ['name'], properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 }, phone: { type: 'string', maxLength: 50 }, email: { type: 'string', maxLength: 320 },
      } },
      fields: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['fieldId','value'], properties: {
        fieldId: { type: 'string', format: 'uuid' }, value: {},
      } } },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    requireBranch(actor, request.body.branchId);
    const normalized = normalizeContact(request.body.contact);
    const result = await db.begin(async (tx) => {
      // Serialize intake against deactivation so a request checked earlier cannot create a lead afterward.
      await tx`SELECT id FROM branch WHERE id = ${request.body.branchId} AND organization_id = ${actor.organizationId} FOR NO KEY UPDATE`;
      const campaigns = await tx`SELECT c.id, c.routing_method, b.timezone FROM campaign c JOIN branch b ON b.id = c.branch_id
        WHERE c.id = ${request.body.campaignId} AND c.branch_id = ${request.body.branchId}
          AND c.organization_id = ${actor.organizationId} FOR NO KEY UPDATE OF c`;
      const campaign = campaigns[0];
      if (!campaign) throw new HttpError(404, 'ACTIVE_CAMPAIGN_NOT_FOUND');
      const active = await tx`SELECT 1 FROM campaign WHERE id = ${campaign.id} AND status = 'ACTIVE'`;
      if (!active.length) throw new HttpError(404, 'ACTIVE_CAMPAIGN_NOT_FOUND');
      const fieldValues = await prepareManualFieldValues(tx, campaign.id, actor, request.body.fields ?? []);
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
            ${tx.json({ contact: request.body.contact, fields: request.body.fields ?? [], candidateContactIds: matches.map((item) => item.id) })}, 'NEEDS_ATTENTION', ${reason})
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
      await storeManualFieldValues(tx, leadId, actor.id, fieldValues);
      await tx`INSERT INTO source_submission (organization_id, branch_id, campaign_id, lead_id, source_kind, raw_payload, state)
        VALUES (${actor.organizationId}, ${request.body.branchId}, ${campaign.id}, ${leadId}, 'MANUAL', ${tx.json({ contact: request.body.contact, fields: request.body.fields ?? [] })}, 'PROCESSED')`;
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
      const current = await tx`SELECT lifecycle, campaign_id FROM lead WHERE id = ${lead.id} FOR UPDATE`;
      if (request.body.lifecycle === 'CLOSED') await enforceRequiredFieldStage(tx, lead.id, current[0]!.campaign_id, 'CLOSE');
      await tx`UPDATE lead SET lifecycle = ${request.body.lifecycle}, closed_at = ${request.body.lifecycle === 'OPEN' ? null : new Date()}, updated_at = now() WHERE id = ${lead.id}`;
      await tx`INSERT INTO lead_activity (lead_id, actor_user_id, event_type, detail) VALUES (${lead.id}, ${actor.id}, 'LIFECYCLE_CHANGED', ${tx.json({ from: current[0]!.lifecycle, to: request.body.lifecycle })})`;
    });
    return { lifecycle: request.body.lifecycle };
  });
}
