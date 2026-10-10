import type postgres from 'postgres';

// Only the authenticated, resolved inbound processor calls this service. No public enqueue/action endpoint.
// A blocked historical snapshot must never be accepted as an approved AI action or financial proof.
export async function recordBlockedCustomerAIInbound(tx: postgres.TransactionSql, eventId: string) {
  const prior = (await tx`SELECT id FROM ai_customer_inbound_execution WHERE event_id=${eventId}`)[0];
  if (prior) return { id: prior.id as string, duplicate: true };
  // Most inbound traffic is Human controlled; avoid assembling unused AI configuration snapshots.
  if (!(await tx`SELECT 1 FROM integration_event e JOIN conversation cv ON cv.id=e.conversation_id
    WHERE e.id=${eventId} AND e.state='PROCESSED' AND cv.controller_type='AI'`).length) return null;
  const context = (await tx`SELECT ai_customer_inbound_context(${eventId}) AS context`)[0]?.context;
  if (!context || context.conversation.controller !== 'AI') return null;
  const s = context.scope;
  const inserted = (await tx`INSERT INTO ai_customer_inbound_execution(organization_id,branch_id,campaign_id,lead_id,conversation_id,event_id,message_id,context,context_hash)
    VALUES (${s.organizationId},${s.branchId},${s.campaignId},${s.leadId},${s.conversationId},${eventId},${context.source.messageId},${tx.json(context)},'')
    ON CONFLICT(event_id) DO NOTHING RETURNING id`)[0];
  return { id: (inserted ?? (await tx`SELECT id FROM ai_customer_inbound_execution WHERE event_id=${eventId}`)[0]!).id as string, duplicate: !inserted };
}
