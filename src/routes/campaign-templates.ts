import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireRole, type Principal } from '../security.js';
import { parseTextTemplate } from '../messaging/approved-template.js';

const params = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
type Sql = Database | postgres.TransactionSql;

async function campaignConnection(sql: Sql, actor: Principal, id: string) {
  requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  const campaign = (await sql`SELECT c.id, c.branch_id, c.sender_override_id, b.default_sender_id
    FROM campaign c JOIN branch b ON b.id = c.branch_id
    WHERE c.id = ${id} AND c.organization_id = ${actor.organizationId}
      AND (${actor.role === 'SUPER_ADMIN'} OR c.branch_id = ${actor.branchId})`)[0];
  if (!campaign) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
  const configured = campaign.sender_override_id ?? campaign.default_sender_id;
  const senders = configured ? await sql`SELECT s.id, s.connection_id, ic.branch_id AS connection_branch_id
    FROM messaging_sender s JOIN integration_connection ic ON ic.id = s.connection_id
    LEFT JOIN sender_branch_binding b ON b.sender_id = s.id AND b.branch_id = ${campaign.branch_id}
    WHERE s.id = ${configured} AND s.organization_id = ${actor.organizationId}
      AND ic.organization_id = ${actor.organizationId} AND ic.kind = 'MESSAGING'
      AND (ic.branch_id = ${campaign.branch_id} OR (ic.branch_id IS NULL AND b.branch_id IS NOT NULL))`
    : await sql`SELECT s.id, s.connection_id, ic.branch_id AS connection_branch_id FROM sender_branch_binding b
      JOIN messaging_sender s ON s.id = b.sender_id
      JOIN integration_connection ic ON ic.id = s.connection_id
      WHERE b.branch_id = ${campaign.branch_id} AND b.allow_shared_fallback
        AND ic.organization_id = ${actor.organizationId} AND ic.kind = 'MESSAGING'
        AND ic.branch_id IS NULL AND s.organization_id = ${actor.organizationId}
      ORDER BY s.id LIMIT 2`;
  if (senders.length !== 1) throw new HttpError(409,
    senders.length ? 'SHARED_FALLBACK_AMBIGUOUS' : 'NO_SENDER');
  return { campaignId: campaign.id as string, branchId: campaign.branch_id as string,
    connectionId: senders[0]!.connection_id as string,
    connectionBranchId: senders[0]!.connection_branch_id as string | null };
}

export function registerCampaignTemplateRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: number; after?: string } }>(
    '/api/messaging/campaigns/:id/templates', { schema: { params, querystring: {
      type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 }, after: { type: 'string', format: 'uuid' },
      },
    } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      const scope = await campaignConnection(db, actor, request.params.id);
      const limit = request.query.limit ?? 50;
      const rows = await db`SELECT t.id, t.name, t.language, t.status, t.category,
          t.components, COALESCE(b.active, false) AS bound,
          COALESCE(b.version, 0) AS version
        FROM provider_message_template t
        LEFT JOIN campaign_message_template_binding b
          ON b.template_id = t.id AND b.campaign_id = ${scope.campaignId}
        WHERE t.connection_id = ${scope.connectionId} AND t.active
          AND (${actor.role === 'SUPER_ADMIN' || scope.connectionBranchId !== null} OR b.active)
          AND (${request.query.after ?? null}::uuid IS NULL OR t.id > ${request.query.after ?? null}::uuid)
        ORDER BY t.id LIMIT ${limit + 1}`;
      const page=rows.slice(0,limit);
      const items=page.flatMap((row)=> { const parsed=parseTextTemplate(row.components);
        const { components:_,...visible }=row;
        return parsed ? [{ ...visible,body:parsed.preview,parameterCount:parsed.parameterCount,headerParameterCount:parsed.headerParameterCount }] : []; });
      return { items, nextAfter: rows.length > limit ? page.at(-1)!.id : null,
        canManage: actor.role === 'SUPER_ADMIN' || scope.connectionBranchId !== null };
    });

  app.put<{ Params: { id: string; templateId: string }; Body: { version: number; bound: boolean } }>(
    '/api/messaging/campaigns/:id/templates/:templateId', { schema: { params: {
      type: 'object', additionalProperties: false, required: ['id','templateId'], properties: {
        id: { type: 'string', format: 'uuid' }, templateId: { type: 'string', format: 'uuid' },
      },
    }, body: { type: 'object', additionalProperties: false, required: ['version','bound'], properties: {
      version: { type: 'integer', minimum: 0 }, bound: { type: 'boolean' },
    } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      return db.begin(async (tx) => {
        const campaign = (await tx`SELECT id, branch_id FROM campaign
          WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId}
            AND (${actor.role === 'SUPER_ADMIN'} OR
              (${actor.role === 'MANAGER'} AND branch_id = ${actor.branchId})) FOR UPDATE`)[0];
        requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
        if (!campaign) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
        const scope = await campaignConnection(tx, actor, request.params.id);
        if (actor.role === 'MANAGER' && scope.connectionBranchId === null)
          throw new HttpError(403, 'FORBIDDEN');
        const template = (await tx`SELECT id, status, active, components FROM provider_message_template
          WHERE id = ${request.params.templateId} AND connection_id = ${scope.connectionId} FOR SHARE`)[0];
        if (!template) throw new HttpError(404, 'TEMPLATE_NOT_AVAILABLE');
        if (request.body.bound && (!template.active || template.status !== 'APPROVED'))
          throw new HttpError(409, 'TEMPLATE_NOT_APPROVED');
        if (request.body.bound && !parseTextTemplate(template.components)) throw new HttpError(409,'TEMPLATE_FORMAT_UNSUPPORTED');
        const existing = (await tx`SELECT version, active FROM campaign_message_template_binding
          WHERE campaign_id = ${scope.campaignId} AND template_id = ${template.id} FOR UPDATE`)[0];
        if ((existing?.version ?? 0) !== request.body.version)
          throw new HttpError(409, 'TEMPLATE_BINDING_VERSION_CONFLICT');
        if (existing && existing.active === request.body.bound)
          return { version: existing.version, bound: existing.active, unchanged: true };
        const changed = existing ? (await tx`UPDATE campaign_message_template_binding
          SET active = ${request.body.bound}, version = version + 1, updated_by = ${actor.id},
            updated_at = now() WHERE campaign_id = ${scope.campaignId} AND template_id = ${template.id}
          RETURNING version`)[0]! : (await tx`INSERT INTO campaign_message_template_binding
          (campaign_id, template_id, active, updated_by)
          VALUES (${scope.campaignId}, ${template.id}, ${request.body.bound}, ${actor.id})
          RETURNING version`)[0]!;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
          target_type, target_id, detail) VALUES (${actor.organizationId}, ${scope.branchId},
          ${actor.id}, ${request.body.bound ? 'CAMPAIGN_TEMPLATE_BOUND' : 'CAMPAIGN_TEMPLATE_UNBOUND'},
          'CAMPAIGN', ${scope.campaignId}, ${tx.json({ templateId: template.id })})`;
        return { version: changed.version, bound: request.body.bound, unchanged: false };
      });
    });
}
