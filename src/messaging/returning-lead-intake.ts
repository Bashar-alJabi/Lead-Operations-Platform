import type postgres from 'postgres';
import { routeLead } from '../routing.js';

export async function intakeReturningLead(tx: postgres.TransactionSql, eventId: string, priorConversationId: string):
  Promise<{block:string}|{leadId:string;conversationId:string}> {
  const [proof]=await tx`SELECT returning_lead_intake_reason(${eventId},${priorConversationId}) AS block`;
  if(proof?.block)return {block:proof.block as string};
  const [intake]=await tx`INSERT INTO messaging_returning_lead_intake(event_id,prior_conversation_id)
    VALUES(${eventId},${priorConversationId}) RETURNING lead_id,branch_id,campaign_id`;
  const {lead_id,branch_id,campaign_id}=intake!;
  const [configuration]=await tx`SELECT ca.routing_method,b.timezone FROM campaign ca JOIN branch b ON b.id=ca.branch_id
    WHERE ca.id=${campaign_id} AND b.id=${branch_id}`;
  await routeLead(tx,campaign_id,branch_id,configuration!.routing_method,configuration!.timezone,lead_id);
  const [conversation]=await tx`INSERT INTO conversation(lead_id,connection_id,sender_id,participant_ref,channel,
    controller_type,state,needs_attention_reason)
    SELECT ${lead_id},cv.connection_id,cv.sender_id,cv.participant_ref,cv.channel,'NONE','WAITING_FOR_HUMAN','NO_HUMAN_CONTROLLER'
    FROM conversation cv WHERE cv.id=${priorConversationId} RETURNING id`;
  return {leadId:lead_id as string,conversationId:conversation!.id as string};
}
