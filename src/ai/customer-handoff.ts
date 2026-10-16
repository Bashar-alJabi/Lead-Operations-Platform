import type postgres from 'postgres';
import type { Database } from '../db.js';
import { lockLocalAIAction, processOneLocalAIAction } from './local-action-queue.js';

// No employee identity, no readonly proposal as authority, no model-supplied user/owner.
export async function requestAIHumanHandoff(tx: postgres.TransactionSql, proposalId: string) {
  await lockLocalAIAction(tx, 'HANDOFF', proposalId);
  await tx`SELECT proposal_id FROM ai_customer_handoff_job WHERE proposal_id=${proposalId} FOR UPDATE`;
  const existing = (await tx`SELECT id,state FROM ai_customer_handoff_action WHERE proposal_id=${proposalId}`)[0];
  if (existing) return { duplicate: true, actionId: existing.id as string, state: existing.state as string };
  const context = (await tx`SELECT ai_customer_handoff_context(${proposalId}) AS context`)[0]?.context;
  const p = (await tx`SELECT p.*,COALESCE(s.context,p.context) AS action_context FROM ai_customer_proposal p
    LEFT JOIN ai_qualification_handoff_source s ON s.proposal_id=p.id WHERE p.id=${proposalId} FOR SHARE OF p`)[0];
  if (!p) throw new Error('AI_HANDOFF_SOURCE_NOT_FOUND');
  const action = (await tx`INSERT INTO ai_customer_handoff_action(proposal_id,lead_id,campaign_id,conversation_id,state,error_code,context)
    VALUES(${proposalId},${p.lead_id},${p.campaign_id},${p.conversation_id},${context ? 'APPLIED' : 'BLOCKED'},${context ? null : 'AI_HANDOFF_CONTEXT_CHANGED'},${tx.json(p.action_context)}) RETURNING *`)[0]!;
  if (context) {
    await tx`UPDATE conversation SET state='WAITING_FOR_HUMAN',controller_type='NONE',controller_user_id=NULL,
      needs_attention_reason='AI_HUMAN_HANDOFF_REQUESTED',version=version+1,ai_handoff_action_id=${action.id} WHERE id=${p.conversation_id}`;
    await tx`INSERT INTO conversation_handoff(conversation_id,from_controller,to_controller,reason,ai_action_id)
      VALUES(${p.conversation_id},'AI','NONE',${action.handoff_reason},${action.id})`;
  }
  return { duplicate: false, actionId: action.id as string, state: action.state as string };
}

// Short local transaction: restart-safe queue; no lock is held across external I/O.
export async function processOneAIHumanHandoff(db: Database): Promise<boolean> {
  return processOneLocalAIAction(db, 'HANDOFF', requestAIHumanHandoff);
}
