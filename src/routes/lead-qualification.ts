import { collectHumanQualificationAnswer, readHumanQualificationState, humanQualificationDTO } from '../ai/human-qualification.js';
import type postgres from 'postgres';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { qualificationAnswerSchema, type QualificationAnswerInput } from '../ai/qualification-answers.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } } as const;
const questionParams = { ...params, required: ['id', 'questionId'], properties: { id: uuid, questionId: uuid } } as const;

async function access(tx: postgres.TransactionSql, actor: Principal, id: string, request: FastifyRequest, write = false) {
  // Branch first, then Lead, then configuration/Field rows: the same order as operational writes.
  const branch = (await tx`SELECT b.id,b.active FROM branch b JOIN lead l ON l.branch_id=b.id
    WHERE l.id=${id} AND l.organization_id=${actor.organizationId}
      AND (${actor.role === 'SUPER_ADMIN'} OR l.branch_id=${actor.branchId}) FOR SHARE OF b`)[0];
  if (!branch) throw new HttpError(404, 'LEAD_NOT_FOUND');
  const lead = (write ? await tx`SELECT id,campaign_id,branch_id,lifecycle FROM lead WHERE id=${id}
    AND organization_id=${actor.organizationId} AND branch_id=${branch.id} AND (${actor.role !== 'AGENT'} OR assigned_agent_id=${actor.id}) FOR UPDATE`
    : await tx`SELECT id,campaign_id,branch_id,lifecycle FROM lead WHERE id=${id}
    AND organization_id=${actor.organizationId} AND branch_id=${branch.id} AND (${actor.role !== 'AGENT'} OR assigned_agent_id=${actor.id}) FOR SHARE`)[0];
  if (!lead) throw new HttpError(404, 'LEAD_NOT_FOUND');
  const sessionId = await currentPaymentSession(tx, actor, request);
  if (!sessionId) throw new HttpError(403, 'QUALIFICATION_ACCESS_REVOKED');
  if (write && !branch.active) throw new HttpError(409, 'BRANCH_DISABLED');
  return { lead: lead as { id: string; campaign_id: string; branch_id: string; lifecycle: string }, sessionId, branchActive: branch.active as boolean };
}

export function registerLeadQualificationRoutes(app: FastifyInstance, db: Database) {
  const root = '/api/leads/:id/qualification';
  app.get<{ Params: { id: string } }>(root, { schema: { params } }, async request => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => { const { lead, branchActive } = await access(tx, actor, request.params.id, request); return humanQualificationDTO(await readHumanQualificationState(tx, actor, lead, branchActive)); });
  });

  app.put<{ Params: { id: string; questionId: string }; Body: QualificationAnswerInput }>(root + '/answers/:questionId', {
    bodyLimit: 131072, schema: { params: questionParams, body: qualificationAnswerSchema },
  }, async request => {
    const actor = await principalFromRequest(request, db), input = request.body;
    return db.begin(async tx => {
      const { lead, sessionId } = await access(tx, actor, request.params.id, request, true);
      return collectHumanQualificationAnswer(tx, actor, lead, sessionId, request.params.questionId, input);
    });
  });

  app.get<{ Params: { id: string; questionId: string }; Querystring: { before?: number; limit?: number } }>(root + '/answers/:questionId/history', {
    schema: { params: questionParams, querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
  }, async request => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => {
      const { lead } = await access(tx, actor, request.params.id, request), limit = request.query.limit ?? 20;
      // Both the captured mapping and the current mapping must be visible. Changed/removed definitions retain authorized history.
      const rows = await tx`SELECT h.version,h.snapshot,h.created_at FROM lead_qualification_answer_history h
        LEFT JOIN ai_qualification_config cfg ON cfg.campaign_id=${lead.campaign_id}
        WHERE h.lead_id=${lead.id} AND h.question_id=${request.params.questionId}
        AND (${request.query.before ?? null}::integer IS NULL OR h.version<${request.query.before ?? null})
        AND (${actor.role === 'SUPER_ADMIN'} OR NOT EXISTS(SELECT 1 FROM (
          SELECT (h.snapshot->>'field_id')::uuid AS id UNION SELECT (item->>'fieldId')::uuid FROM jsonb_array_elements(cfg.definition->'questions') item WHERE item->>'id'=${request.params.questionId}
        ) mapping WHERE mapping.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
          WHERE cf.campaign_id=${lead.campaign_id} AND cf.field_id=mapping.id AND fd.organization_id=${actor.organizationId}
          AND (cf.show_in_details OR cf.show_in_table) AND (${actor.role === 'AGENT'} AND cf.visible_to_agent OR ${actor.role === 'MANAGER'} AND cf.visible_to_manager))))
        ORDER BY h.version DESC LIMIT ${limit + 1}`;
      return { items: rows.slice(0, limit).map(h => ({ version: h.version, value: h.snapshot.value, source: h.snapshot.source,
        definitionVersion: h.snapshot.qualification_version, question: h.snapshot.question_snapshot, actorId: h.snapshot.actor_id, createdAt: h.created_at })),
        nextVersion: rows.length > limit ? rows[limit - 1]!.version : null };
    });
  });
}
