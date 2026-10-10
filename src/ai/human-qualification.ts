import type postgres from 'postgres';
import { isDeepStrictEqual } from 'node:util';
import { HttpError, type Principal } from '../security.js';
import { writeManualFieldValue } from '../field-values.js';
import { emptyQualification, evaluateQualification, type QualificationDefinition } from './qualification.js';
import { normalizeQualificationAnswer, type QualificationAnswerInput } from './qualification-answers.js';
import { effectiveConfigHash } from './operational-config.js';
import type { FieldOption, FieldValidation } from '../fields.js';

type HumanQualificationLead = { id: string; campaign_id: string; branch_id: string; lifecycle: string };
export async function readHumanQualificationState(tx: postgres.TransactionSql, actor: Principal, lead: { id: string; campaign_id: string }, branchActive: boolean) {
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
  const captured = questionIds.length ? await tx`SELECT question_id,qualification_version,question_snapshot,version,value,source FROM lead_qualification_answer WHERE lead_id=${lead.id} AND question_id IN ${tx(questionIds)}` : [];
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
    return [{ ...q, value, source: q.fieldId ? fv?.source === 'MANUAL' ? 'HUMAN' : fv?.source ?? null : sameQuestion ? capture!.source : null,
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

export function humanQualificationDTO(s: Awaited<ReturnType<typeof readHumanQualificationState>>) {
  return { definitionVersion: s.version, enabled: s.enabled, questions: s.questions, result: s.result, blockers: s.blockers };
}


// Human authority only. Autonomous AI/Form tools require separate execution/action proofs.
// Own the Branch -> Lead locks even when called outside HTTP; native100 remains the final write authority.
export async function collectHumanQualificationAnswer(tx: postgres.TransactionSql, actor: Principal, lead: HumanQualificationLead,
  sessionId: string, questionId: string, input: QualificationAnswerInput) {
  const branch = (await tx`SELECT b.active FROM branch b JOIN lead l ON l.branch_id=b.id
    WHERE l.id=${lead.id} AND l.organization_id=${actor.organizationId} AND b.id=${lead.branch_id} FOR SHARE OF b`)[0];
  if (!branch?.active) throw new HttpError(403, 'QUALIFICATION_ACCESS_REVOKED');
  await tx`SELECT id FROM lead WHERE id=${lead.id} FOR UPDATE`;
  const current = (await tx`SELECT u.id FROM user_account u JOIN user_session s ON s.user_id=u.id JOIN lead l ON l.id=${lead.id}
    WHERE u.id=${actor.id} AND u.active AND u.organization_id=${actor.organizationId} AND u.role=${actor.role}
      AND u.branch_id IS NOT DISTINCT FROM ${actor.branchId}::uuid AND s.id=${sessionId} AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND l.campaign_id=${lead.campaign_id} AND l.branch_id=${lead.branch_id} AND l.lifecycle=${lead.lifecycle} AND l.organization_id=${actor.organizationId}
      AND qualification_capture_access(l.id,u.id,s.id) FOR SHARE OF u,s,l`)[0];
  if (!current) throw new HttpError(403, 'QUALIFICATION_ACCESS_REVOKED');
  const requestHash = effectiveConfigHash({ questionId, ...input });
  const receipt = (await tx`SELECT request_hash,answer_version FROM lead_qualification_request WHERE lead_id=${lead.id} AND actor_id=${actor.id} AND request_id=${input.requestId}`)[0];
  if (receipt) {
    if (receipt.request_hash !== requestHash) throw new HttpError(409, 'QUALIFICATION_IDEMPOTENCY_CONFLICT');
    return { duplicate: true, answerVersion: receipt.answer_version };
  }
  const s = await readHumanQualificationState(tx, actor, lead, branch.active as boolean);
  if (s.version !== input.definitionVersion) throw new HttpError(409, 'QUALIFICATION_DEFINITION_VERSION_CONFLICT');
  if (!s.enabled) throw new HttpError(409, 'QUALIFICATION_DISABLED');
  const q = s.questions.find(q => q.id === questionId);
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
  return { duplicate: false, answerVersion: input.answerVersion + 1, ...humanQualificationDTO(await readHumanQualificationState(tx, actor, lead, branch.active as boolean)) };
}
