import type postgres from 'postgres';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { writeManualFieldValue } from '../field-values.js';
import { emptyQualification, evaluateQualification, type QualificationDefinition } from '../ai/qualification.js';
import { normalizeQualificationAnswer, qualificationAnswerSchema, type QualificationAnswerInput } from '../ai/qualification-answers.js';
import { effectiveConfigHash } from '../ai/operational-config.js';
import type { FieldOption, FieldValidation } from '../fields.js';

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

async function state(tx: postgres.TransactionSql, actor: Principal, lead: { id: string; campaign_id: string }, branchActive: boolean) {
  const config = (await tx`SELECT version,definition FROM ai_qualification_config WHERE campaign_id=${lead.campaign_id} FOR SHARE`)[0];
  const definition = (config?.definition ?? emptyQualification()) as QualificationDefinition, version = (config?.version ?? 0) as number;
  const ids = [...new Set(definition.questions.flatMap(q => q.fieldId ? [q.fieldId] : []))];
  const fields = ids.length ? await tx`SELECT fd.id,fd.key,fd.label,fd.field_type,fd.options,fd.validation,fd.value_mode,fd.active AS definition_active,
    fd.version AS definition_version,cf.version AS binding_version,cf.active AS binding_active,cf.usable_by_ai,
    cf.visible_to_agent,cf.editable_by_agent,cf.visible_to_manager,cf.editable_by_manager,cf.show_in_details,cf.show_in_table
    FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id JOIN campaign c ON c.id=cf.campaign_id
    WHERE cf.campaign_id=${lead.campaign_id} AND fd.id IN ${tx(ids)} AND fd.organization_id=${actor.organizationId}
      AND (fd.branch_id IS NULL OR fd.branch_id=c.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=c.id) FOR SHARE OF fd,cf` : [];
  const byId = new Map(fields.map(f => [f.id as string, f]));
  const values = ids.length ? await tx`SELECT field_id,value,version,source FROM lead_field_value WHERE lead_id=${lead.id} AND field_id IN ${tx(ids)}` : [];
  const byValue = new Map(values.map(v => [v.field_id as string, v]));
  const questionIds = definition.questions.map(q => q.id);
  const captured = questionIds.length ? await tx`SELECT question_id,qualification_version,question_snapshot,version,value FROM lead_qualification_answer WHERE lead_id=${lead.id} AND question_id IN ${tx(questionIds)}` : [];
  const byAnswer = new Map(captured.map(a => [a.question_id as string, a]));
  const visible = (f: postgres.Row | undefined) => !!f && (actor.role === 'SUPER_ADMIN' ||
    (actor.role === 'AGENT' ? f.visible_to_agent : f.visible_to_manager) && (f.show_in_details || f.show_in_table));
  const usable = (f: postgres.Row | undefined) => !!f && f.definition_active && f.binding_active && f.usable_by_ai && f.value_mode === 'MANUAL';
  const answers: Record<string, postgres.JSONValue> = {}, blockers = new Set<string>();
  if (!branchActive) blockers.add('BRANCH_DISABLED');
  const questions = definition.questions.flatMap(q => {
    const f = q.fieldId ? byId.get(q.fieldId) : undefined;
    if (q.fieldId && !visible(f)) { blockers.add('QUALIFICATION_RESTRICTED'); return []; }
    const capture = byAnswer.get(q.id), fv = q.fieldId ? byValue.get(q.fieldId) : undefined;
    const sameQuestion = !!capture && isDeepStrictEqual(capture.question_snapshot, q);
    let value = q.fieldId ? fv?.value ?? null : sameQuestion ? capture!.value : null;
    const available = !q.fieldId || usable(f);
    let valid = available;
    try { if (valid) value = normalizeQualificationAnswer(value, f as Parameters<typeof normalizeQualificationAnswer>[1]); }
    catch { valid = false; }
    if (!valid) blockers.add('QUALIFICATION_FIELD_UNAVAILABLE');
    answers[q.id] = valid ? value : null;
    return [{ ...q, value, source: q.fieldId ? fv?.source === 'MANUAL' ? 'HUMAN' : fv?.source ?? null : sameQuestion ? 'HUMAN' : null,
      collectedDefinitionVersion: sameQuestion ? capture!.qualification_version : null,
      answerVersion: capture?.version ?? 0, fieldValueVersion: q.fieldId ? fv?.version ?? 0 : null,
      editable: definition.enabled && branchActive && available && (!f || actor.role === 'SUPER_ADMIN' || (actor.role === 'AGENT' ? f.editable_by_agent : f.editable_by_manager)),
      field: f ? { id: f.id, key: f.key, label: f.label, field_type: f.field_type, value_mode: f.value_mode, options: f.options, validation: f.validation,
        definitionVersion: f.definition_version, bindingVersion: f.binding_version } : null }];
  });
  // Do not leak hidden data through a completion boolean or missing-question list.
  if (!blockers.size) for (const rule of [...definition.completion.conditions, ...definition.handoff.conditions]) if (rule.operator === 'EQUALS') {
    const q = definition.questions.find(q => q.id === rule.questionId)!;
    try { normalizeQualificationAnswer(rule.value, q.fieldId ? byId.get(q.fieldId) as Parameters<typeof normalizeQualificationAnswer>[1] : undefined); }
    catch { blockers.add('QUALIFICATION_FIELD_UNAVAILABLE'); }
  }
  const { previewOnly: _, ...result } = evaluateQualification(definition, answers);
  return { version, enabled: definition.enabled, questions, result: blockers.size ? null : result, blockers: [...blockers], definition, byId };
}

function dto(s: Awaited<ReturnType<typeof state>>) {
  return { definitionVersion: s.version, enabled: s.enabled, questions: s.questions, result: s.result, blockers: s.blockers };
}

export function registerLeadQualificationRoutes(app: FastifyInstance, db: Database) {
  const root = '/api/leads/:id/qualification';
  app.get<{ Params: { id: string } }>(root, { schema: { params } }, async request => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => { const { lead, branchActive } = await access(tx, actor, request.params.id, request); return dto(await state(tx, actor, lead, branchActive)); });
  });

  app.put<{ Params: { id: string; questionId: string }; Body: QualificationAnswerInput }>(root + '/answers/:questionId', {
    bodyLimit: 131072, schema: { params: questionParams, body: qualificationAnswerSchema },
  }, async request => {
    const actor = await principalFromRequest(request, db), input = request.body;
    const requestHash = effectiveConfigHash({ questionId: request.params.questionId, ...input });
    return db.begin(async tx => {
      const { lead, sessionId, branchActive } = await access(tx, actor, request.params.id, request, true);
      const receipt = (await tx`SELECT request_hash,answer_version FROM lead_qualification_request WHERE lead_id=${lead.id} AND actor_id=${actor.id} AND request_id=${input.requestId}`)[0];
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new HttpError(409, 'QUALIFICATION_IDEMPOTENCY_CONFLICT');
        return { duplicate: true, answerVersion: receipt.answer_version };
      }
      const s = await state(tx, actor, lead, branchActive);
      if (s.version !== input.definitionVersion) throw new HttpError(409, 'QUALIFICATION_DEFINITION_VERSION_CONFLICT');
      if (!s.enabled) throw new HttpError(409, 'QUALIFICATION_DISABLED');
      const q = s.questions.find(q => q.id === request.params.questionId);
      if (!q) throw new HttpError(404, 'QUALIFICATION_QUESTION_NOT_FOUND');
      if (!q.editable) throw new HttpError(403, 'QUALIFICATION_READ_ONLY');
      if (q.answerVersion !== input.answerVersion || q.fieldValueVersion !== input.fieldValueVersion) throw new HttpError(409, 'QUALIFICATION_ANSWER_VERSION_CONFLICT');
      const field = q.fieldId ? s.byId.get(q.fieldId) : undefined;
      const value = normalizeQualificationAnswer(input.value, field as { field_type: string; options: FieldOption[]; validation: FieldValidation } | undefined);
      const snapshot = s.definition.questions.find(item => item.id === q.id)!;
      await tx`INSERT INTO lead_qualification_request(lead_id,actor_id,session_id,request_id,request_hash,question_id,qualification_version,answer_version,field_value_version,question_snapshot,value)
        VALUES (${lead.id},${actor.id},${sessionId},${input.requestId},${requestHash},${q.id},${s.version},${input.answerVersion + 1},${input.fieldValueVersion},${tx.json(snapshot)},${tx.json(value)})`;
      let fieldValueVersion: number | null = null;
      if (q.fieldId) fieldValueVersion = (await writeManualFieldValue(tx, actor, lead, q.fieldId, { value,
        ...(input.fieldValueVersion ? { version: input.fieldValueVersion } : {}) })).version;
      if (input.answerVersion) await tx`UPDATE lead_qualification_answer SET qualification_version=${s.version},version=${input.answerVersion + 1},value=${tx.json(value)},
        source='HUMAN',field_id=${q.fieldId},field_value_version=${fieldValueVersion},actor_id=${actor.id},session_id=${sessionId},request_id=${input.requestId},question_snapshot=${tx.json(snapshot)}
        WHERE lead_id=${lead.id} AND question_id=${q.id}`;
      else await tx`INSERT INTO lead_qualification_answer(lead_id,campaign_id,question_id,qualification_version,version,value,source,field_id,field_value_version,actor_id,session_id,request_id,question_snapshot)
        VALUES (${lead.id},${lead.campaign_id},${q.id},${s.version},${input.answerVersion + 1},${tx.json(value)},'HUMAN',${q.fieldId},${fieldValueVersion},${actor.id},${sessionId},${input.requestId},${tx.json(snapshot)})
        `;
      return { duplicate: false, answerVersion: input.answerVersion + 1, ...dto(await state(tx, actor, lead, branchActive)) };
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
