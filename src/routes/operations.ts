import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireBranch, requireLead, requireRole } from '../security.js';
import { routeLead } from '../routing.js';
import { recordLeadIntakeOrigin } from '../lead-intake-origin.js';
import { currentPaymentSession } from '../payments/access.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { identityLockKeys, normalizeContact } from '../contacts.js';
import { prepareManualFieldValues, storeManualFieldValues, type ManualFieldInput } from '../field-values.js';
import { registerCampaignRoutes } from './campaigns.js';
import { registerBranchTimezoneRoutes } from './branch-timezone.js';
import {leadPredicate,prepareLeadFilter,operationalFilterProperties,type LeadFilter} from '../lead-query.js';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const pageQuery={type:'object',additionalProperties:false,properties:{...operationalFilterProperties,
 limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',maxLength:256},sort:{enum:['CREATED_DESC','CREATED_ASC']}}} as const;

export function registerOperationsRoutes(app: FastifyInstance, db: Database): void {
  registerCampaignRoutes(app, db);
  registerBranchTimezoneRoutes(app, db);
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
      const intakeSession = await currentPaymentSession(tx, actor, request);
      if (!intakeSession) throw new HttpError(403, 'LEAD_INTAKE_ACCESS_REVOKED');
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
      const intakeSubmission = (await tx`INSERT INTO source_submission (organization_id, branch_id, campaign_id, lead_id, source_kind, raw_payload, state)
        VALUES (${actor.organizationId}, ${request.body.branchId}, ${campaign.id}, ${leadId}, 'MANUAL', ${tx.json({ contact: request.body.contact, fields: request.body.fields ?? [] })}, 'PROCESSED') RETURNING id`)[0]!;
      await tx`INSERT INTO lead_activity (lead_id, actor_user_id, event_type) VALUES (${leadId}, ${actor.id}, 'LEAD_CREATED')`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${request.body.branchId}, ${actor.id}, 'LEAD_CREATED', 'LEAD', ${leadId})`;
      await routeLead(tx, campaign.id, request.body.branchId, campaign.routing_method, campaign.timezone, leadId);
      await recordLeadIntakeOrigin(tx, leadId, intakeSubmission.id, { kind: 'HUMAN_MANUAL', actorId: actor.id, sessionId: intakeSession });
      return { id: leadId };
    });
    if ('reviewId' in result) { reply.code(202); return { reviewId: result.reviewId, status: 'NEEDS_ATTENTION' }; }
    reply.code(201); return result;
  });

  app.get<{Querystring:LeadFilter&{limit?:number;cursor?:string;sort?:'CREATED_DESC'|'CREATED_ASC'}}>('/api/leads',{schema:{querystring:pageQuery}},async request=>{
   const actor=await principalFromRequest(request,db),q=request.query,cursor=decodeCursor(q.cursor),limit=q.limit??30,ascending=q.sort==='CREATED_ASC';
   return db.begin(async tx=>{
    if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'LEAD_QUERY_ACCESS_REVOKED');const field=await prepareLeadFilter(tx,actor,q);
    const rows=await tx`SELECT l.id,l.branch_id,l.campaign_id,l.contact_id,l.assigned_agent_id,l.lifecycle,l.version,l.source_kind,l.needs_attention_reason,l.created_at,l.created_at::text AS cursor_at,
     automation_review_pending(l.id,l.branch_id,l.campaign_id) AS automation_review_pending,
     campaign.name AS campaign_name,c.name AS contact_name,c.phone,c.email,
     (SELECT min(f.due_at) FROM follow_up f WHERE f.lead_id=l.id AND f.status='OPEN') AS next_followup_at
     FROM lead l JOIN campaign ON campaign.id=l.campaign_id AND campaign.organization_id=l.organization_id
     LEFT JOIN contact c ON c.id=l.contact_id WHERE ${leadPredicate(tx,actor,q,field)} AND
      (${cursor?.timestamp??null}::text::timestamptz IS NULL OR ${ascending} AND (l.created_at,l.id)>(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid)
       OR NOT ${ascending} AND (l.created_at,l.id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
     ORDER BY l.created_at ${tx.unsafe(ascending?'ASC':'DESC')},l.id ${tx.unsafe(ascending?'ASC':'DESC')} LIMIT ${limit+1}`;
    const items=rows.slice(0,limit),last=items.at(-1);return {items,nextCursor:rows.length>limit&&last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};
   });
  });

  app.get<{ Params: { id: string } }>('/api/leads/:id', { schema: { params: idParam } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const lead = await requireLead(db, actor, request.params.id);
    const activities = await db`SELECT id, actor_user_id, event_type, detail, created_at FROM lead_activity WHERE lead_id = ${lead.id} ORDER BY id DESC LIMIT 100`;
    return { lead, activities };
  });
}
