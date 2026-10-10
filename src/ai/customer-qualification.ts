import type postgres from 'postgres';
import type { Database } from '../db.js';
import { normalizeQualificationAnswer } from './qualification-answers.js';

// Autonomous current authority, never a Human Principal or a readonly/Copilot result.
// Native admission and action guards own parent/current dependency locks and atomic proof.
export async function collectAIQualificationAnswer(tx: postgres.TransactionSql, proposalId: string) {
  await tx`SELECT proposal_id FROM ai_customer_action_job WHERE proposal_id=${proposalId} FOR UPDATE`;
  const existing = (await tx`SELECT id,state FROM ai_customer_action WHERE proposal_id=${proposalId}`)[0];
  if (existing) return { duplicate: true, actionId: existing.id as string, state: existing.state as string };
  const context = (await tx`SELECT ai_customer_action_context(${proposalId}) AS context`)[0]?.context;
  const proposal = (await tx`SELECT * FROM ai_customer_proposal WHERE id=${proposalId} FOR SHARE`)[0];
  if (!proposal) throw new Error('AI_ACTION_SOURCE_NOT_FOUND');
  let error: string | null = context ? null : 'AI_ACTION_CONTEXT_CHANGED';
  if (context) {
    const question = (await tx`SELECT item FROM ai_qualification_config qc CROSS JOIN LATERAL jsonb_array_elements(qc.definition->'questions') item
      WHERE qc.campaign_id=${proposal.campaign_id} AND item->>'id'=${proposal.result.questionId}`)[0]?.item;
    const field = question?.fieldId ? (await tx`SELECT field_type,options,validation FROM field_definition WHERE id=${question.fieldId}`)[0] : undefined;
    try { normalizeQualificationAnswer(proposal.result.answerValue, field as Parameters<typeof normalizeQualificationAnswer>[1]); }
    catch { error = 'AI_ACTION_VALUE_INVALID'; }
  }
  const action = (await tx`INSERT INTO ai_customer_action(proposal_id,lead_id,campaign_id,conversation_id,state,error_code,context)
    VALUES(${proposalId},${proposal.lead_id},${proposal.campaign_id},${proposal.conversation_id},${error ? 'BLOCKED' : 'APPLIED'},${error},${tx.json(proposal.context)}) RETURNING *`)[0]!;
  if (error) return { duplicate: false, actionId: action.id as string, state: 'BLOCKED' };
  let fieldVersion: number | null = null;
  if (action.field_id) {
    const written = action.previous_field_version ? await tx`UPDATE lead_field_value SET value=${tx.json(action.value)},source='AI',updated_by=NULL,ai_action_id=${action.id},
      version=version+1,updated_at=clock_timestamp(),source_submission_id=NULL,source_binding_id=NULL,source_mapping_version=NULL
      WHERE lead_id=${action.lead_id} AND field_id=${action.field_id} AND version=${action.previous_field_version} RETURNING version`
      : await tx`INSERT INTO lead_field_value(lead_id,field_id,value,source,updated_by,ai_action_id) VALUES(${action.lead_id},${action.field_id},${tx.json(action.value)},'AI',NULL,${action.id}) RETURNING version`;
    fieldVersion = written[0]!.version as number;
  }
  if (action.answer_version > 1) await tx`UPDATE lead_qualification_answer SET qualification_version=${action.qualification_version},version=${action.answer_version},value=${tx.json(action.value)},
    source='AI',field_id=${action.field_id},field_value_version=${fieldVersion},actor_id=NULL,session_id=NULL,request_id=NULL,question_snapshot=${tx.json(action.question_snapshot)},ai_action_id=${action.id}
    WHERE lead_id=${action.lead_id} AND question_id=${action.question_id}`;
  else await tx`INSERT INTO lead_qualification_answer(lead_id,campaign_id,question_id,qualification_version,version,value,source,field_id,field_value_version,actor_id,session_id,request_id,question_snapshot,ai_action_id)
    VALUES(${action.lead_id},${action.campaign_id},${action.question_id},${action.qualification_version},${action.answer_version},${tx.json(action.value)},'AI',${action.field_id},${fieldVersion},NULL,NULL,NULL,${tx.json(action.question_snapshot)},${action.id})`;
  return { duplicate: false, actionId: action.id as string, state: 'APPLIED' };
}

// Durable pending admission survives process restarts; all local writes commit together.
export async function processOneAIQualificationAction(db: Database): Promise<boolean> {
  return db.begin(async tx => {
    const pending = (await tx`SELECT proposal_id FROM ai_customer_action_job WHERE state='QUEUED'
      ORDER BY created_at,proposal_id FOR UPDATE SKIP LOCKED LIMIT 1`)[0];
    if (!pending) return false;
    await collectAIQualificationAnswer(tx, pending.proposal_id as string);
    return true;
  });
}
