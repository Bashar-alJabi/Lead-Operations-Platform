import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError } from '../security.js';
import { customerSafeEvidence, validateCustomerProposal } from './customer-proposal.js';
import { copilotSafeReferences } from './copilot-summary.js';
import { lockLocalAIAction, processOneLocalAIAction } from './local-action-queue.js';
import { checkOutboundAuthorityPolicy, lockOutboundAuthority } from '../messaging/authority.js';

// Local intent only. A separate current dispatch check and transport gate precede credential/provider I/O.
export async function enqueueAICustomerReply(tx: postgres.TransactionSql, proposalId: string) {
  await lockLocalAIAction(tx, 'SEND', proposalId);
  await tx`SELECT proposal_id FROM ai_customer_send_job WHERE proposal_id=${proposalId} FOR UPDATE`;
  const prior = (await tx`SELECT id,state,message_id FROM ai_customer_send_action WHERE proposal_id=${proposalId}`)[0];
  if (prior) return { duplicate: true, actionId: prior.id as string, state: prior.state as string, messageId: prior.message_id as string | null };
  const p = (await tx`SELECT * FROM ai_customer_proposal WHERE id=${proposalId} FOR SHARE`)[0];
  if (!p) throw new Error('AI_SEND_SOURCE_NOT_FOUND');
  let content: postgres.JSONValue | null = null, error: string | null = null;
  try {
    const locked = await lockOutboundAuthority(tx, { kind: 'AI_ADMISSION', proposalId }, p.conversation_id);
    const decision = await checkOutboundAuthorityPolicy(tx, locked);
    if (!decision.allowed) error = decision.reason;
    else {
      const { protocolVersion, toolsExecuted, sendAllowed, mutationsAllowed, ...result } = p.result ?? {};
      const evidence = customerSafeEvidence({ messages: p.context.messages, references: p.context.references, questions: p.context.questions, sourceMessageId: p.message_id });
      validateCustomerProposal(result, evidence);
      const candidate = (await tx`SELECT ai_customer_send_content(${proposalId}) AS content`)[0]?.content;
      if (!candidate || !copilotSafeReferences([{ id: 'body', text: candidate.body }]).length) error = 'AI_SEND_CONTENT_UNAVAILABLE';
      else content = candidate;
    }
  } catch (e) { if (e instanceof HttpError) error = e.code; else throw e; }
  const id = randomUUID(), messageId = error ? null : randomUUID();
  const a = (await tx`INSERT INTO ai_customer_send_action(id,proposal_id,lead_id,campaign_id,conversation_id,state,error_code,message_id,context,content)
    VALUES(${id},${proposalId},${p.lead_id},${p.campaign_id},${p.conversation_id},${error ? 'BLOCKED' : 'APPLIED'},${error},${messageId},${tx.json(p.context)},${content ? tx.json(content) : null}) RETURNING state`)[0]!;
  if (messageId) {
    const body = (content as { body: string }).body, cv = p.context.conversation;
    await tx`INSERT INTO conversation_message(id,conversation_id,connection_id,sender_id,direction,author_type,body,delivery_state,idempotency_key,ai_send_action_id)
      VALUES(${messageId},${p.conversation_id},${cv.connectionId},${cv.senderId},'OUTBOUND','AI',${body},'QUEUED',${id},${id})`;
    const job = (await tx`INSERT INTO background_job(queue,kind,payload,idempotency_key)
      VALUES('messaging','SEND_MESSAGE',${tx.json({ messageId })},${messageId}) RETURNING id`)[0]!;
    await tx`INSERT INTO outbound_delivery_job(message_id,job_id) VALUES(${messageId},${job.id})`;
    await tx`UPDATE conversation SET last_message_at=clock_timestamp() WHERE id=${p.conversation_id}`;
  }
  return { duplicate: false, actionId: id, state: a.state as string, messageId };
}
export function processOneAICustomerSend(db: Database) {
  return processOneLocalAIAction(db, 'SEND', enqueueAICustomerReply);
}
