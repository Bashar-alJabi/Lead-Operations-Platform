import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireRole } from '../security.js';

const idParam = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
type ConsentBody = { version: number; status: 'GRANTED'|'REVOKED'|'UNKNOWN'; doNotContact: boolean;
  evidence: string | null; source: string };

export function registerMessagingConsentRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>('/api/leads/:id/messaging-consent', {
    schema: { params: idParam },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const row = (await db`SELECT mc.status, mc.do_not_contact, mc.evidence, mc.source,
        mc.updated_at, mc.version,
        (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND NOT EXISTS
          (SELECT 1 FROM lead other WHERE other.contact_id = l.contact_id
            AND other.branch_id <> ${actor.branchId}))) AS editable
      FROM lead l LEFT JOIN messaging_consent mc
          ON mc.contact_id = l.contact_id AND mc.channel = 'WHATSAPP'
      WHERE l.id = ${request.params.id} AND l.organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR
          (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId}) OR
          (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))`)[0];
    if (!row) throw new HttpError(404, 'LEAD_NOT_FOUND');
    return row.status ? row : { status: 'UNKNOWN', do_not_contact: false, evidence: null,
      source: null, updated_at: null, version: 0, editable: row.editable };
  });

  app.put<{ Params: { id: string }; Body: ConsentBody }>('/api/leads/:id/messaging-consent', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false,
      required: ['version','status','doNotContact','evidence','source'], properties: {
        version: { type: 'integer', minimum: 0 }, status: { enum: ['GRANTED','REVOKED','UNKNOWN'] },
        doNotContact: { type: 'boolean' }, evidence: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }] },
        source: { type: 'string', minLength: 3, maxLength: 100 },
      } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const evidence = request.body.evidence?.trim() || null;
    const source = request.body.source.trim();
    if (!source || (request.body.status === 'GRANTED' && !evidence))
      throw new HttpError(400, 'CONSENT_EVIDENCE_REQUIRED');
    return db.begin(async (tx) => {
      const lead = (await tx`SELECT id, branch_id, contact_id FROM lead WHERE id = ${request.params.id}
        AND organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR branch_id = ${actor.branchId}) FOR SHARE`)[0];
      if (!lead) throw new HttpError(404, 'LEAD_NOT_FOUND');
      await tx`SELECT id FROM contact WHERE id = ${lead.contact_id} FOR UPDATE`;
      if (actor.role === 'MANAGER') {
        const shared = await tx`SELECT 1 FROM lead WHERE contact_id = ${lead.contact_id}
          AND branch_id <> ${actor.branchId} LIMIT 1`;
        if (shared.length) throw new HttpError(403, 'CONTACT_SHARED_ACROSS_BRANCHES');
      }
      const current = (await tx`SELECT status, do_not_contact, evidence, source, version
        FROM messaging_consent WHERE contact_id = ${lead.contact_id} AND channel = 'WHATSAPP' FOR UPDATE`)[0];
      if ((current?.version ?? 0) !== request.body.version) throw new HttpError(409, 'CONSENT_VERSION_CONFLICT');
      if (current && current.status === request.body.status && current.do_not_contact === request.body.doNotContact
        && current.evidence === evidence && current.source === source) return { version: current.version, unchanged: true };
      const version = (current?.version ?? 0) + 1;
      if (current) await tx`UPDATE messaging_consent SET status = ${request.body.status},
        do_not_contact = ${request.body.doNotContact}, evidence = ${evidence}, source = ${source},
        updated_by = ${actor.id}, updated_at = now(), version = ${version}
        WHERE contact_id = ${lead.contact_id} AND channel = 'WHATSAPP'`;
      else await tx`INSERT INTO messaging_consent (contact_id, channel, status, do_not_contact,
        evidence, source, updated_by, version) VALUES (${lead.contact_id}, 'WHATSAPP',
          ${request.body.status}, ${request.body.doNotContact}, ${evidence}, ${source}, ${actor.id}, ${version})`;
      await tx`INSERT INTO messaging_consent_history (contact_id, channel, version, status,
        do_not_contact, evidence, source, changed_by) VALUES (${lead.contact_id}, 'WHATSAPP', ${version},
          ${request.body.status}, ${request.body.doNotContact}, ${evidence}, ${source}, ${actor.id})`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id,
        detail) VALUES (${actor.organizationId}, ${lead.branch_id}, ${actor.id}, 'MESSAGING_CONSENT_UPDATED',
          'CONTACT', ${lead.contact_id}, ${tx.json({ channel: 'WHATSAPP', status: request.body.status,
            doNotContact: request.body.doNotContact, version })})`;
      return { version, unchanged: false };
    });
  });
}
