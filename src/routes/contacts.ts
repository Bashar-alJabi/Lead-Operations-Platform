import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { identityLockKeys, normalizeSourceContact } from '../contacts.js';
import { routeLead } from '../routing.js';
import { recordLeadIntakeOrigin } from '../lead-intake-origin.js';
import { prepareManualFieldValues, storeManualFieldValues, type ManualFieldInput } from '../field-values.js';
import { HttpError, lockCurrentSession, principalFromRequest, requireBranch, requireRole, type Principal } from '../security.js';

const idParam = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const pageQuery = { type: 'object', additionalProperties: false, properties: {
  limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 }, q: { type: 'string', minLength: 2, maxLength: 100 },
} } as const;

function visibleLead(tx:postgres.TransactionSql,actor:Principal) {
  return tx`l.organization_id=${actor.organizationId} AND (
    ${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId}
      AND (${actor.role==='MANAGER'} OR l.assigned_agent_id=${actor.id}))`;
}

async function requireReviewScope(tx:postgres.TransactionSql,actor:Principal,candidates:string[]){
  if(actor.role!=='MANAGER')return;
  const [visible]=await tx`SELECT count(*)::integer AS count FROM contact c WHERE c.id IN ${tx(candidates)}
    AND c.organization_id=${actor.organizationId}
    AND EXISTS(SELECT 1 FROM lead l WHERE l.contact_id=c.id AND ${visibleLead(tx,actor)})
    AND NOT EXISTS(SELECT 1 FROM lead l WHERE l.contact_id=c.id AND l.branch_id<>${actor.branchId})`;
  if(visible!.count!==candidates.length)throw new HttpError(403,'CONTACT_REVIEW_REQUIRES_ADMIN');
}

export function registerContactRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Querystring: { limit?: number; cursor?: string; q?: string } }>('/api/contacts', { schema: { querystring: pageQuery } }, async (request,reply) => {
    const actor = await principalFromRequest(request, db);
    const limit = request.query.limit ?? 30;
    const cursor = decodeCursor(request.query.cursor);
    const search = request.query.q?.trim().normalize('NFKC').toLowerCase() || null;
    const prefix = search ? `${search.replace(/[\\%_]/g, '\\$&')}%` : null;
    const phoneSearch = search?.replace(/[\s().-]/g, '') || null;
    const phonePrefix = phoneSearch ? `${phoneSearch.replace(/[\\%_]/g, '\\$&')}%` : null;
    reply.header('Cache-Control','no-store');
    return db.begin(async tx=>{
      if(!await lockCurrentSession(tx,actor,request))throw new HttpError(403,'CONTACT_ACCESS_REVOKED');
      const rows = await tx`WITH page AS MATERIALIZED (
        SELECT c.id, c.name, c.phone, c.email, c.created_at, c.updated_at, c.version,c.created_at::text AS cursor_at
        FROM contact c WHERE c.organization_id = ${actor.organizationId}
          AND EXISTS (SELECT 1 FROM lead l WHERE l.contact_id = c.id AND ${visibleLead(tx,actor)})
          AND (${prefix}::text IS NULL OR lower(c.name) LIKE ${prefix} OR c.phone_normalized LIKE ${phonePrefix} OR c.email_normalized LIKE ${prefix})
          AND (${cursor?.timestamp ?? null}::text::timestamptz IS NULL OR (c.created_at, c.id) < (${cursor?.timestamp ?? null}::text::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit+1}
      ) SELECT c.*,(SELECT count(*)::integer FROM lead l WHERE l.contact_id=c.id AND ${visibleLead(tx,actor)}) AS accessible_lead_count
        FROM page c ORDER BY c.created_at DESC,c.id DESC`;
      const items=rows.slice(0,limit).map(({cursor_at,...row})=>row);
      const last=rows[limit-1];
      return {items,nextCursor:rows.length>limit&&last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};
    });
  });

  app.get<{ Params: { id: string } }>('/api/contacts/:id', { schema: { params: idParam } }, async (request,reply) => {
    const actor = await principalFromRequest(request, db);
    reply.header('Cache-Control','no-store');
    return db.begin(async tx=>{
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      if(!await lockCurrentSession(tx,actor,request))throw new HttpError(403,'CONTACT_ACCESS_REVOKED');
      const [contact]=await tx`SELECT c.id, c.name, c.phone, c.email, c.version, c.created_at, c.updated_at,
        (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND NOT EXISTS
          (SELECT 1 FROM lead other WHERE other.contact_id=c.id AND other.organization_id=c.organization_id AND other.branch_id<>${actor.branchId}))) AS editable
        FROM contact c WHERE c.id=${request.params.id} AND c.organization_id=${actor.organizationId}
          AND EXISTS (SELECT 1 FROM lead l WHERE l.contact_id=c.id AND ${visibleLead(tx,actor)})`;
      if(!contact)throw new HttpError(404,'CONTACT_NOT_FOUND');
      const leads=await tx`SELECT l.id,l.branch_id,l.campaign_id,l.lifecycle,l.created_at,l.created_at::text AS cursor_at
        FROM lead l WHERE l.contact_id=${contact.id} AND ${visibleLead(tx,actor)}
        ORDER BY l.created_at DESC,l.id DESC LIMIT 51`;
      const last=leads[49];
      return {contact,leads:leads.slice(0,50).map(({cursor_at,...row})=>row),
        nextLeadCursor:leads.length>50&&last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};
    });
  });

  app.patch<{ Params: { id: string }; Body: { name: string; phone?: string | null; email?: string | null; version: number } }>('/api/contacts/:id', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, required: ['name','version'], properties: {
      name: { type: 'string', maxLength: 200 }, phone: { anyOf: [{ type: 'string', maxLength: 50 }, { type: 'null' }] },
      email: { anyOf: [{ type: 'string', maxLength: 320 }, { type: 'null' }] }, version: { type: 'integer', minimum: 1 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    return db.begin(async (tx) => {
      const [initial]=await tx`SELECT c.phone,c.email,c.phone_normalized,c.email_normalized,c.version FROM contact c
        WHERE c.id=${request.params.id} AND c.organization_id=${actor.organizationId}
          AND EXISTS(SELECT 1 FROM lead l WHERE l.contact_id=c.id AND ${visibleLead(tx,actor)})`;
      if (!initial) throw new HttpError(404,'CONTACT_NOT_FOUND');
      const normalized = normalizeSourceContact({ name: request.body.name,
        phone: request.body.phone === undefined ? initial.phone ?? undefined : request.body.phone ?? undefined,
        email: request.body.email === undefined ? initial.email ?? undefined : request.body.email ?? undefined });
      if (!normalized) throw new HttpError(400,'CONTACT_DATA_REQUIRED');
      const oldKeys=identityLockKeys(actor.organizationId,{ ...normalized,phoneNormalized:initial.phone_normalized,emailNormalized:initial.email_normalized });
      // Match/create and edit share identity-first lock ordering; lock identities being removed as well as added.
      for (const key of [...new Set([...oldKeys,...identityLockKeys(actor.organizationId,normalized)])].sort())
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
      const locked = await tx`SELECT id, organization_id, name, phone, phone_normalized, email, email_normalized, version
        FROM contact WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId} FOR UPDATE`;
      const contact = locked[0];
      if (!contact) throw new HttpError(404, 'CONTACT_NOT_FOUND');
      if(!await lockCurrentSession(tx,actor,request))throw new HttpError(403,'CONTACT_ACCESS_REVOKED');
      const [scope]=await tx`SELECT EXISTS(SELECT 1 FROM lead l WHERE l.contact_id=${contact.id} AND ${visibleLead(tx,actor)}) AS visible,
        EXISTS(SELECT 1 FROM lead WHERE contact_id=${contact.id} AND organization_id=${actor.organizationId}
          AND branch_id<>${actor.branchId}::uuid) AS shared`;
      if(!scope!.visible)throw new HttpError(404,'CONTACT_NOT_FOUND');
      if(actor.role==='MANAGER'&&scope!.shared)throw new HttpError(403,'CONTACT_SHARED_ACROSS_BRANCHES');
      if (contact.version !== request.body.version || contact.version !== initial.version) throw new HttpError(409, 'CONTACT_VERSION_CONFLICT');
      const conflict = await tx`SELECT 1 FROM contact WHERE organization_id = ${actor.organizationId} AND id <> ${contact.id}
        AND ((${normalized.phoneNormalized}::text IS NOT NULL AND phone_normalized = ${normalized.phoneNormalized})
          OR (${normalized.emailNormalized}::text IS NOT NULL AND email_normalized = ${normalized.emailNormalized})) LIMIT 1`;
      if (conflict.length) throw new HttpError(409, 'CONTACT_IDENTITY_CONFLICT');
      const previous = { name: contact.name, phone: contact.phone, email: contact.email };
      const next = { name: normalized.name, phone: normalized.phone, email: normalized.email };
      if (JSON.stringify(previous) === JSON.stringify(next)) return { version: contact.version };
      const updated = await tx`UPDATE contact SET name = ${normalized.name}, phone = ${normalized.phone}, phone_normalized = ${normalized.phoneNormalized},
        email = ${normalized.email}, email_normalized = ${normalized.emailNormalized}, version = version + 1, updated_at = now()
        WHERE id = ${contact.id} RETURNING version`;
      await tx`INSERT INTO contact_history (contact_id, actor_user_id, old_data, new_data)
        VALUES (${contact.id}, ${actor.id}, ${tx.json(previous)}, ${tx.json(next)})`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${actor.role === 'MANAGER' ? actor.branchId : null}, ${actor.id}, 'CONTACT_UPDATED', 'CONTACT', ${contact.id})`;
      return { version: updated[0]!.version as number };
    });
  });

  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/contact-reviews', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 },
    } } },
  }, async (request,reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const cursor = decodeCursor(request.query.cursor);
    const limit = request.query.limit ?? 30;
    reply.header('Cache-Control','no-store');
    return db.begin(async tx=>{
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      if(!await lockCurrentSession(tx,actor,request))throw new HttpError(403,'CONTACT_ACCESS_REVOKED');
      const rows = await tx`SELECT s.id, s.branch_id, s.campaign_id, s.raw_payload, s.created_at,s.created_at::text AS cursor_at
        FROM source_submission s WHERE s.organization_id = ${actor.organizationId} AND s.source_kind='MANUAL' AND s.state = 'NEEDS_ATTENTION'
          AND s.failure_code IN ('CONTACT_AMBIGUOUS','CONTACT_SCOPE_REVIEW') AND (${actor.role === 'SUPER_ADMIN'} OR s.branch_id = ${actor.branchId})
          AND (${cursor?.timestamp ?? null}::text::timestamptz IS NULL OR (s.created_at, s.id) < (${cursor?.timestamp ?? null}::text::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY s.created_at DESC, s.id DESC LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      const candidateIds = [...new Set(items.flatMap((item) => item.raw_payload.candidateContactIds as string[]))];
      const candidates = candidateIds.length ? await tx`SELECT c.id, c.name, c.phone, c.email FROM contact c WHERE c.id IN ${tx(candidateIds)}
        AND c.organization_id = ${actor.organizationId} AND (${actor.role === 'SUPER_ADMIN'} OR EXISTS
          (SELECT 1 FROM lead l WHERE l.contact_id=c.id AND ${visibleLead(tx,actor)}
            AND NOT EXISTS (SELECT 1 FROM lead other WHERE other.contact_id = c.id AND other.branch_id <> ${actor.branchId})))` : [];
      const visible = new Map(candidates.map((candidate) => [candidate.id as string, candidate]));
      const last = items[items.length - 1];
      return { items: items.map((item) => ({ id: item.id, branchId: item.branch_id, campaignId: item.campaign_id,
        contact: item.raw_payload.contact, candidates: (item.raw_payload.candidateContactIds as string[]).map((id) => visible.get(id)).filter(Boolean),
        restrictedCandidates: (item.raw_payload.candidateContactIds as string[]).some((id) => !visible.has(id)), createdAt: item.created_at })),
        nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.cursor_at, id: last.id }) : null };
    });
  });

  app.post<{ Params: { id: string }; Body: { contactId: string } }>('/api/contact-reviews/:id/resolve', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, required: ['contactId'], properties: {
      contactId: { type: 'string', format: 'uuid' },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    return db.begin(async (tx) => {
      const found = await tx`SELECT id, branch_id, campaign_id, lead_id, resolution_contact_id, state, raw_payload FROM source_submission
        WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId} AND source_kind='MANUAL' AND raw_payload ? 'candidateContactIds' FOR UPDATE`;
      const submission = found[0];
      if (!submission) throw new HttpError(404, 'CONTACT_REVIEW_NOT_FOUND');
      requireBranch(actor, submission.branch_id);
      if (submission.state === 'PROCESSED') {
        if(!await lockCurrentSession(tx,actor,request))throw new HttpError(403,'CONTACT_ACCESS_REVOKED');
        if (submission.resolution_contact_id !== request.body.contactId) throw new HttpError(409, 'CONTACT_REVIEW_ALREADY_RESOLVED');
        const visible=await tx`SELECT 1 FROM lead l WHERE l.id=${submission.lead_id} AND ${visibleLead(tx,actor)}`;
        if(!visible.length)throw new HttpError(404,'CONTACT_REVIEW_NOT_FOUND');
        return { id: submission.lead_id, status: 'PROCESSED' };
      }
      if (submission.state !== 'NEEDS_ATTENTION') throw new HttpError(409, 'CONTACT_REVIEW_NOT_OPEN');
      const candidates = submission.raw_payload.candidateContactIds as string[];
      if (!candidates.includes(request.body.contactId)) throw new HttpError(400, 'CONTACT_NOT_CANDIDATE');
      await requireReviewScope(tx,actor,candidates);
      await tx`SELECT id FROM branch WHERE id=${submission.branch_id} AND organization_id=${actor.organizationId} FOR NO KEY UPDATE`;
      const campaigns = await tx`SELECT c.id, c.routing_method, b.timezone FROM campaign c JOIN branch b ON b.id = c.branch_id
        WHERE c.id = ${submission.campaign_id} AND c.branch_id = ${submission.branch_id} AND c.organization_id = ${actor.organizationId}
          AND c.status='ACTIVE' AND b.active FOR NO KEY UPDATE OF c`;
      const campaign = campaigns[0];
      if (!campaign) throw new HttpError(409, 'CAMPAIGN_NOT_AVAILABLE');
      // A concurrent intake needs a foreign-key lock on the Contact it shares.
      const contactsToLock=actor.role==='MANAGER'?candidates:[request.body.contactId];
      const lockedContacts=await tx`SELECT id FROM contact WHERE id IN ${tx(contactsToLock)} AND organization_id=${actor.organizationId}
        ORDER BY id FOR UPDATE`;
      if(!lockedContacts.some(row=>row.id===request.body.contactId))throw new HttpError(404,'CONTACT_NOT_FOUND');
      const intakeSession = await lockCurrentSession(tx, actor, request);
      if (!intakeSession) throw new HttpError(403, 'LEAD_INTAKE_ACCESS_REVOKED');
      await requireReviewScope(tx,actor,candidates);
      const fieldValues = await prepareManualFieldValues(tx, campaign.id, actor,
        (submission.raw_payload.fields ?? []) as ManualFieldInput[]);
      const lead = await tx`INSERT INTO lead (organization_id, branch_id, campaign_id, contact_id, source_kind)
        VALUES (${actor.organizationId}, ${submission.branch_id}, ${campaign.id}, ${request.body.contactId}, 'MANUAL') RETURNING id`;
      const leadId = lead[0]!.id as string;
      await storeManualFieldValues(tx, leadId, actor.id, fieldValues);
      await tx`UPDATE source_submission SET lead_id = ${leadId}, resolution_contact_id = ${request.body.contactId}, state = 'PROCESSED', failure_code = NULL WHERE id = ${submission.id}`;
      await tx`INSERT INTO lead_activity (lead_id, actor_user_id, event_type, detail)
        VALUES (${leadId}, ${actor.id}, 'LEAD_CREATED_AFTER_CONTACT_REVIEW', ${tx.json({ submissionId: submission.id })})`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${submission.branch_id}, ${actor.id}, 'LEAD_CREATED', 'LEAD', ${leadId})`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
        VALUES (${actor.organizationId}, ${submission.branch_id}, ${actor.id}, 'CONTACT_MATCH_REVIEW_RESOLVED', 'SOURCE_SUBMISSION', ${submission.id},
          ${tx.json({ contactId: request.body.contactId, leadId })})`;
      await routeLead(tx, campaign.id, submission.branch_id, campaign.routing_method, campaign.timezone, leadId);
      await recordLeadIntakeOrigin(tx, leadId, submission.id, { kind: 'HUMAN_MANUAL', actorId: actor.id, sessionId: intakeSession });
      return { id: leadId, status: 'PROCESSED' };
    });
  });
}
