import type postgres from 'postgres';
import { resolveConfiguredSender } from './sender-resolution.js';

type ReturningContext = { eventId: string; conversationId: string; leadId: string; organizationId: string;
  branchId: string; campaignId: string; senderId: string; connectionId: string };

// The caller holds the inbound identity, connection, Lead and Conversation locks.
export async function reopenReturningConversation(tx: postgres.TransactionSql, context: ReturningContext) {
  const {eventId,conversationId,leadId,organizationId,branchId,campaignId,senderId,connectionId}=context;
  const [proof]=await tx`SELECT b.active AND ca.status='ACTIVE' AND ca.messaging_config->>'enabled'='true' AS campaign_ready,
      cv.controller_type='NONE' AS released,
      ct.phone_normalized IS NOT DISTINCT FROM cv.participant_ref AS participant_matches,
      a.event_id IS NOT NULL AND a.payload_sha256=encode(sha256(convert_to(e.payload::text,'UTF8')),'hex') AS authenticated,
      COALESCE(e.received_at>cv.closed_at AND a.verified_at>cv.closed_at AND
        CASE WHEN (e.payload->'message'->>'timestamp') ~ '^[0-9]{10,11}$'
          THEN to_timestamp((e.payload->'message'->>'timestamp')::double precision)>=date_trunc('second',cv.closed_at)
            AND to_timestamp((e.payload->'message'->>'timestamp')::double precision)<=e.received_at+interval '2 minutes'
          ELSE false END,false) AS fresh,
      EXISTS(SELECT 1 FROM conversation other WHERE other.lead_id=l.id AND other.channel=cv.channel AND other.state<>'CLOSED') AS competing,
      EXISTS(SELECT 1 FROM conversation other WHERE other.lead_id=l.id AND other.channel=cv.channel AND other.state<>'CLOSED'
        AND (other.connection_id,other.sender_id,other.participant_ref) IS DISTINCT FROM (cv.connection_id,cv.sender_id,cv.participant_ref)) AS different_pin,
      EXISTS(SELECT 1 FROM conversation_message m WHERE m.connection_id=e.connection_id
        AND m.provider_message_id=e.payload->'message'->>'id') AS duplicate
    FROM conversation cv JOIN lead l ON l.id=cv.lead_id JOIN contact ct ON ct.id=l.contact_id AND ct.organization_id=l.organization_id
    JOIN branch b ON (b.id,b.organization_id)=(l.branch_id,l.organization_id)
    JOIN campaign ca ON (ca.id,ca.branch_id,ca.organization_id)=(l.campaign_id,l.branch_id,l.organization_id)
    JOIN integration_event e ON (e.connection_id,e.sender_id,e.participant_ref)=(cv.connection_id,cv.sender_id,cv.participant_ref)
    LEFT JOIN messaging_inbound_authentication a ON a.event_id=e.id
    WHERE cv.id=${conversationId} AND l.id=${leadId} AND e.id=${eventId} AND e.event_kind='INBOUND_MESSAGE'
      AND (l.organization_id,l.branch_id,l.campaign_id)=(${organizationId},${branchId},${campaignId})
      AND l.lifecycle='OPEN' AND cv.channel='WHATSAPP' AND cv.state='CLOSED'
    FOR SHARE OF b,ca,ct`;
  const [policy]=await tx`SELECT version,definition->'returningContact'->>'closedConversation' AS action FROM ai_behavior_policy
    WHERE scope='CAMPAIGN' AND resource_id=${campaignId} AND campaign_id=${campaignId} AND branch_id=${branchId} FOR SHARE`;
  if(proof?.different_pin)return 'PINNED_SENDER_MISMATCH';
  if(policy?.action!=='REOPEN_EXISTING')return 'CLOSED_CONVERSATION';
  if(!proof?.campaign_ready)return 'RETURNING_CAMPAIGN_NOT_READY';
  if(!proof.released)return 'CLOSED_CONVERSATION';
  if(!proof.participant_matches)return 'CONTEXT_PARTICIPANT_MISMATCH';
  if(!proof.authenticated)return 'RETURNING_INBOUND_AUTHENTICATION_REQUIRED';
  if(!proof.fresh)return 'RETURNING_INBOUND_STALE';
  if(proof.duplicate)return 'RETURNING_INBOUND_ALREADY_ATTACHED';
  if(proof.competing)return 'RETURNING_ACTIVE_CONVERSATION_EXISTS';
  const selected=await resolveConfiguredSender(tx,{organizationId,branchId,campaignId,pinnedSenderId:senderId});
  if(!selected.sender||selected.sender.connectionId!==connectionId)return 'RETURNING_PINNED_SENDER_NOT_AVAILABLE';

  // Preserve the closure timestamp for outbound dispatch and retain any outstanding delivery review.
  const [changed]=await tx`UPDATE conversation SET state='WAITING_FOR_HUMAN',version=version+1,
    needs_attention_reason=COALESCE(needs_attention_reason,'NO_HUMAN_CONTROLLER')
    WHERE id=${conversationId} RETURNING version`;
  const detail=tx.json({eventId,conversationId,policyVersion:policy.version,version:changed!.version});
  await tx`INSERT INTO lead_activity(lead_id,event_type,detail) VALUES(${leadId},'CONVERSATION_REOPENED_BY_INBOUND',${detail})`;
  await tx`INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail)
    VALUES(${organizationId},${branchId},'CONVERSATION_REOPENED_BY_INBOUND','CONVERSATION',${conversationId},${detail})`;
  return null;
}
