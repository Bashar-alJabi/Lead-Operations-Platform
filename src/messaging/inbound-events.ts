import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError, type Principal } from '../security.js';
import { MediaError, parseInboundMedia } from '../media/validation.js';
import { processOneIntegrationEvent } from './event-processing.js';
import { parseInboundQuickReply } from './quick-replies.js';
import { parseTextTemplate } from './approved-template.js';
import { identityLockKeys, normalizeSourceContact } from '../contacts.js';
import { parseMetaSourceReference, type SourceReference } from './source-reference.js';

type InboundPayload = { senderExternalId: string; message: Record<string, unknown> };
type EventRow = { id: string; connection_id: string; sender_id: string | null;
  participant_ref: string; payload: InboundPayload; state: string; failure_code: string | null;
  lead_id: string | null; conversation_id: string | null };

async function attention(tx: postgres.TransactionSql, id: string, reason: string) {
  await tx`UPDATE integration_event SET state = 'NEEDS_ATTENTION', failure_code = ${reason}
    WHERE id = ${id}`;
  return { state: 'NEEDS_ATTENTION', reason } as const;
}

export async function candidateLeads(tx: postgres.TransactionSql,
  event: { sender_id: string | null; participant_ref: string }, reference: SourceReference|null = null) {
  if (!event.sender_id) return [];
  return tx`SELECT l.id, l.branch_id, l.campaign_id, l.assigned_agent_id, l.lifecycle,
      c.name AS contact_name, ca.name AS campaign_name, b.name AS branch_name
    FROM lead l JOIN contact c ON c.id = l.contact_id
    JOIN campaign ca ON ca.id = l.campaign_id JOIN branch b ON b.id = l.branch_id
    JOIN messaging_sender s ON s.id = ${event.sender_id}
    JOIN integration_connection ic ON ic.id = s.connection_id
    WHERE l.organization_id = ic.organization_id AND l.lifecycle = 'OPEN'
      AND (ic.branch_id IS NULL OR ic.branch_id = l.branch_id)
      AND c.phone_normalized = ${event.participant_ref}
      AND (${reference === null} OR (${reference?.namespace ?? null}='META_AD' AND EXISTS
        (SELECT 1 FROM messaging_meta_ad_context(ic.organization_id, ${reference?.externalId ?? null}) ref
          WHERE ref.campaign_id=l.campaign_id)))
      AND (ca.sender_override_id = s.id OR
        (ca.sender_override_id IS NULL AND b.default_sender_id = s.id) OR
        (ca.sender_override_id IS NULL AND b.default_sender_id IS NULL
          AND ic.branch_id IS NULL AND EXISTS (SELECT 1 FROM sender_branch_binding binding
            WHERE binding.sender_id = s.id AND binding.branch_id = l.branch_id
              AND binding.allow_shared_fallback)))
    ORDER BY l.created_at DESC, l.id DESC LIMIT 101`;
}

export async function activeConversations(tx: postgres.TransactionSql,
  event: { sender_id: string|null; connection_id: string; participant_ref: string }, reference: SourceReference|null = null) {
  if (!event.sender_id) return [];
  return tx`SELECT cv.id, cv.lead_id, cv.state, cv.controller_type, cv.participant_ref,
      l.branch_id,c.name AS contact_name,ca.name AS campaign_name,b.name AS branch_name
    FROM conversation cv JOIN lead l ON l.id = cv.lead_id
      LEFT JOIN contact c ON c.id=l.contact_id JOIN campaign ca ON ca.id=l.campaign_id JOIN branch b ON b.id=l.branch_id
      JOIN integration_connection ic ON ic.id=cv.connection_id
    WHERE cv.connection_id = ${event.connection_id} AND cv.sender_id = ${event.sender_id}
      AND cv.participant_ref = ${event.participant_ref} AND cv.state <> 'CLOSED'
      AND l.organization_id=ic.organization_id AND (ic.branch_id IS NULL OR l.branch_id=ic.branch_id)
      AND (${reference === null} OR (${reference?.namespace ?? null}='META_AD' AND EXISTS
        (SELECT 1 FROM messaging_meta_ad_context(ic.organization_id, ${reference?.externalId ?? null}) ref
          WHERE ref.campaign_id=l.campaign_id)))
    ORDER BY cv.started_at DESC, cv.id DESC LIMIT 101`;
}

export async function hasSourceReferenceContext(tx: postgres.TransactionSql, connectionId: string, reference: SourceReference|null) {
  if (reference?.namespace !== 'META_AD') return false;
  return (await tx`SELECT 1 FROM integration_connection ic
    JOIN messaging_meta_ad_context(ic.organization_id, ${reference.externalId}) ref ON true
    JOIN campaign c ON c.id=ref.campaign_id
    WHERE ic.id=${connectionId} AND c.organization_id=ic.organization_id
      AND (ic.branch_id IS NULL OR c.branch_id=ic.branch_id) LIMIT 1`).length > 0;
}

export async function processInboundEvent(tx: postgres.TransactionSql, eventId: string,
  decision?: { actor: Principal; leadId?: string; conversationId?: string }): Promise<{
    state: string; reason?: string; leadId?: string; conversationId?: string; messageId?: string; existing?: boolean;
  }> {
  const event = (await tx`SELECT id, connection_id, sender_id, participant_ref, payload,
      event_kind, state, failure_code, lead_id, conversation_id
    FROM integration_event WHERE id = ${eventId} FOR UPDATE`)[0] as (EventRow & { event_kind: string }) | undefined;
  if (!event || event.event_kind !== 'INBOUND_MESSAGE') throw new HttpError(404, 'INBOUND_EVENT_NOT_FOUND');
  if (event.state === 'PROCESSED') {
    if (decision && decision.conversationId && decision.conversationId !== event.conversation_id)
      throw new HttpError(409, 'INBOUND_ALREADY_RESOLVED');
    if (decision && decision.leadId && decision.leadId !== event.lead_id)
      throw new HttpError(409, 'INBOUND_ALREADY_RESOLVED');
    return { state: 'PROCESSED', leadId: event.lead_id!, conversationId: event.conversation_id!, existing: true };
  }
  if (event.state === 'IGNORED') throw new HttpError(409, 'INBOUND_ALREADY_IGNORED');
  if (event.state === 'FAILED') throw new HttpError(409, 'EVENT_RETRY_REQUIRED');
  if (!event.sender_id || !/^\+[1-9]\d{7,14}$/.test(event.participant_ref))
    return attention(tx, event.id, 'SENDER_OR_PARTICIPANT_UNRESOLVED');
  const organization = (await tx`SELECT organization_id FROM integration_connection WHERE id=${event.connection_id}`)[0];
  if (!organization) return attention(tx, event.id, 'SENDER_OR_PARTICIPANT_UNRESOLVED');
  // Same identity mutex as Contact edits and Source intake; re-read authority after any wait.
  for (const key of identityLockKeys(organization.organization_id, normalizeSourceContact({ phone:event.participant_ref })!))
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
  const sender = (await tx`SELECT s.id, s.connection_id, s.active, s.operator_enabled,
      ic.organization_id, ic.branch_id, ic.status AS connection_status
    FROM messaging_sender s JOIN integration_connection ic ON ic.id = s.connection_id
    WHERE s.id = ${event.sender_id} AND s.connection_id = ${event.connection_id} FOR SHARE OF s,ic`)[0];
  if (!sender) return attention(tx, event.id, 'SENDER_OR_PARTICIPANT_UNRESOLVED');
  if (sender.connection_status === 'DISABLED') return attention(tx, event.id, 'CONNECTION_DISABLED');
  if (!sender.active || !sender.operator_enabled) return attention(tx, event.id, 'SENDER_DISABLED');
  const message = event.payload?.message;
  if (!message || typeof message.id !== 'string' || !message.id || message.id.length > 255)
    return attention(tx, event.id, 'INBOUND_PAYLOAD_INVALID');
  let sourceReference: SourceReference|null;
  try { sourceReference=parseMetaSourceReference(message); }
  catch { return attention(tx,event.id,'INBOUND_SOURCE_REFERENCE_INVALID'); }
  const knownSourceReference=await hasSourceReferenceContext(tx,event.connection_id,sourceReference);
  let body: string; let attachmentId: string | null = null;
  const quickReply=message.type==='button' ? parseInboundQuickReply(message) : null;
  if (message.type==='button' && !quickReply) return attention(tx,event.id,'QUICK_REPLY_PAYLOAD_INVALID');
  if (message.type === 'text' && message.text && typeof message.text === 'object'
    && typeof (message.text as Record<string, unknown>).body === 'string'
    && (message.text as { body: string }).body.trim()
    && (message.text as { body: string }).body.length <= 20000) {
    body = (message.text as { body: string }).body;
  } else if (quickReply) { body=quickReply.body; }
  else {
    let media;
    try { media = parseInboundMedia(message); }
    catch (error) { return attention(tx, event.id, error instanceof MediaError ? error.code : 'MEDIA_PAYLOAD_INVALID'); }
    if (!media) return attention(tx, event.id, 'INBOUND_CONTENT_UNSUPPORTED');
    const attachment = (await tx`INSERT INTO message_attachment (integration_event_id, media_kind,
      provider_media_id, declared_mime, expected_sha256)
      VALUES (${event.id}, ${media.kind}, ${media.providerId}, ${media.mime}, ${media.sha256})
      ON CONFLICT (integration_event_id) DO NOTHING RETURNING id`)[0]
      ?? (await tx`SELECT id FROM message_attachment WHERE integration_event_id = ${event.id}`)[0]!;
    attachmentId = attachment.id; body = media.caption;
  }
  const timestamp = typeof message.timestamp === 'string' && /^\d{10,11}$/.test(message.timestamp)
    ? new Date(Number(message.timestamp) * 1000) : new Date();
  const contextId = message.context && typeof message.context === 'object'
    ? (message.context as { id?: unknown }).id : null;
  if (contextId != null && (typeof contextId !== 'string' || !contextId || contextId.length > 255))
    return attention(tx, event.id, 'INBOUND_CONTEXT_INVALID');

  let conversationId = decision?.conversationId ?? null;
  let leadId = decision?.leadId ?? null;
  let providerContext = false;
  let sourceEvidence: postgres.Row|null = null;
  if (decision) {
    if (Boolean(conversationId) === Boolean(leadId)) throw new HttpError(400, 'INBOUND_TARGET_REQUIRED');
    if (decision.actor.organizationId !== sender.organization_id
      || (decision.actor.role === 'MANAGER' && sender.branch_id !== decision.actor.branchId))
      throw new HttpError(404, 'INBOUND_EVENT_NOT_FOUND');
    const currentActor=(await tx`SELECT 1 FROM user_account WHERE id=${decision.actor.id} AND active
      AND organization_id=${sender.organization_id} AND role=${decision.actor.role}
      AND (role='SUPER_ADMIN' OR (role='MANAGER' AND branch_id=${decision.actor.branchId})) FOR SHARE`)[0];
    if (!currentActor) throw new HttpError(403,'INBOUND_REVIEW_ACCESS_DENIED');
  }
  if (quickReply) {
    const prior=(await tx`SELECT prior.id,prior.provider_message_id,prior.template_snapshot,
        cv.id AS conversation_id,cv.lead_id,cv.state
      FROM conversation_message prior JOIN conversation cv ON cv.id=prior.conversation_id
      WHERE prior.id=${quickReply.messageId} AND prior.direction='OUTBOUND' AND prior.message_kind='TEMPLATE'
        AND prior.connection_id=${event.connection_id} AND prior.sender_id=${event.sender_id}
        AND cv.participant_ref=${event.participant_ref}`)[0];
    if (!prior) return attention(tx,event.id,'QUICK_REPLY_REFERENCE_NOT_FOUND');
    const parsed=parseTextTemplate(prior.template_snapshot?.components);const button=parsed?.buttons[quickReply.index];
    if (!button || button.type!=='QUICK_REPLY' || button.text!==body
      || prior.template_snapshot?.quickReplyPayloads?.[quickReply.index]!==quickReply.payload)
      return attention(tx,event.id,'QUICK_REPLY_REFERENCE_MISMATCH');
    if (!prior.provider_message_id) return attention(tx,event.id,'QUICK_REPLY_REFERENCE_PENDING');
    if (contextId && contextId!==prior.provider_message_id) return attention(tx,event.id,'QUICK_REPLY_CONTEXT_MISMATCH');
    if (decision && ((conversationId && conversationId!==prior.conversation_id) || (leadId && leadId!==prior.lead_id)))
      throw new HttpError(409,'INBOUND_CONTEXT_TARGET_CONFLICT');
    if (prior.state==='CLOSED') return attention(tx,event.id,'CLOSED_CONVERSATION');
    conversationId=prior.conversation_id;leadId=prior.lead_id;providerContext=true;
  }
  if (contextId) {
    const references = await tx`SELECT cv.id, cv.lead_id, cv.state, cv.participant_ref
      FROM conversation_message prior JOIN conversation cv ON cv.id = prior.conversation_id
      WHERE prior.connection_id = ${event.connection_id} AND prior.sender_id = ${event.sender_id}
        AND prior.provider_message_id = ${contextId} LIMIT 2`;
    if (references.length > 1) return attention(tx, event.id, 'AMBIGUOUS_CONTEXT');
    if (references.length === 1) {
      if (references[0]!.participant_ref !== event.participant_ref)
        return attention(tx, event.id, 'CONTEXT_PARTICIPANT_MISMATCH');
      if (decision && ((conversationId && conversationId !== references[0]!.id)
        || (leadId && leadId !== references[0]!.lead_id)))
        throw new HttpError(409, 'INBOUND_CONTEXT_TARGET_CONFLICT');
      if (!decision) {
        if (references[0]!.state === 'CLOSED') return attention(tx, event.id, 'CLOSED_CONVERSATION');
        conversationId = references[0]!.id; leadId = references[0]!.lead_id;
      }
      providerContext=true;
    }
  }
  if (!conversationId && !leadId) {
    if (sourceReference && !knownSourceReference)
      return attention(tx,event.id,'SOURCE_REFERENCE_UNRESOLVED');
    const active = await activeConversations(tx, event, sourceReference);
    if (active.length > 1) return attention(tx, event.id, 'MULTIPLE_ACTIVE_CONVERSATIONS');
    if (active.length === 1) { conversationId = active[0]!.id; leadId = active[0]!.lead_id; }
    else {
      const leads = await candidateLeads(tx, event, sourceReference);
      if (leads.length !== 1) return attention(tx, event.id,
        leads.length > 1 ? 'MULTIPLE_ACTIVE_LEADS' : 'NO_UNIQUE_LEAD');
      leadId = leads[0]!.id;
    }
  }
  if (conversationId) {
    // All conversation mutations take Lead before Conversation, including reassignment.
    await tx`SELECT l.id FROM lead l JOIN conversation cv ON cv.lead_id=l.id
      WHERE cv.id=${conversationId} AND cv.connection_id=${event.connection_id} AND cv.sender_id=${event.sender_id}
        AND cv.participant_ref=${event.participant_ref} AND l.organization_id=${sender.organization_id}
        AND (${sender.branch_id}::uuid IS NULL OR l.branch_id=${sender.branch_id}) FOR UPDATE OF l`;
    const cv = (await tx`SELECT cv.id, cv.lead_id, cv.state, l.branch_id
      FROM conversation cv JOIN lead l ON l.id = cv.lead_id
      WHERE cv.id = ${conversationId} AND cv.connection_id = ${event.connection_id}
        AND cv.sender_id = ${event.sender_id} AND cv.participant_ref = ${event.participant_ref}
        AND cv.state <> 'CLOSED' AND l.organization_id=${sender.organization_id}
        AND (${sender.branch_id}::uuid IS NULL OR l.branch_id=${sender.branch_id}) FOR UPDATE OF cv`)[0];
    if (!cv) return attention(tx, event.id, 'CONVERSATION_NOT_AVAILABLE');
    if (decision?.actor.role === 'MANAGER' && cv.branch_id !== decision.actor.branchId)
      throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
    leadId = cv.lead_id;
    sourceEvidence = knownSourceReference ? (await tx`SELECT ref.* FROM lead l
      JOIN messaging_meta_ad_context(l.organization_id,${sourceReference!.externalId}) ref ON ref.campaign_id=l.campaign_id
      WHERE l.id=${leadId} ORDER BY ref.evidence_kind DESC,ref.evidence_id LIMIT 1`)[0] ?? null : null;
    if (knownSourceReference && !sourceEvidence) return attention(tx,event.id,'SOURCE_REFERENCE_TARGET_CONFLICT');
  } else {
    if (!leadId) return attention(tx, event.id, 'NO_UNIQUE_LEAD');
    const lead = (await tx`SELECT l.id, l.branch_id, l.assigned_agent_id, u.active AS agent_active
      FROM lead l LEFT JOIN user_account u ON u.id = l.assigned_agent_id
      WHERE l.id = ${leadId} AND l.organization_id = ${sender.organization_id}
        AND l.lifecycle = 'OPEN' FOR UPDATE OF l`)[0];
    if (!lead) return attention(tx, event.id, 'LEAD_NOT_AVAILABLE');
    if (decision?.actor.role === 'MANAGER' && lead.branch_id !== decision.actor.branchId)
      throw new HttpError(404, 'LEAD_NOT_FOUND');
    const eligible = await tx`SELECT l.id FROM lead l JOIN contact c ON c.id=l.contact_id
      JOIN campaign ca ON ca.id=l.campaign_id JOIN branch b ON b.id=l.branch_id
      WHERE l.id=${leadId} AND l.organization_id=${sender.organization_id}
        AND (${sender.branch_id}::uuid IS NULL OR l.branch_id=${sender.branch_id})
        AND c.phone_normalized=${event.participant_ref}
        AND (ca.sender_override_id=${event.sender_id} OR (ca.sender_override_id IS NULL AND b.default_sender_id=${event.sender_id})
          OR (ca.sender_override_id IS NULL AND b.default_sender_id IS NULL AND ${sender.branch_id}::uuid IS NULL
            AND EXISTS (SELECT 1 FROM sender_branch_binding binding WHERE binding.sender_id=${event.sender_id}
              AND binding.branch_id=l.branch_id AND binding.allow_shared_fallback)))`;
    if (!eligible.length)
      return attention(tx, event.id, 'LEAD_SENDER_SCOPE_MISMATCH');
    sourceEvidence = knownSourceReference ? (await tx`SELECT ref.* FROM lead l
      JOIN messaging_meta_ad_context(l.organization_id,${sourceReference!.externalId}) ref ON ref.campaign_id=l.campaign_id
      WHERE l.id=${leadId} ORDER BY ref.evidence_kind DESC,ref.evidence_id LIMIT 1`)[0] ?? null : null;
    if (knownSourceReference && !sourceEvidence)
      return attention(tx,event.id,'SOURCE_REFERENCE_TARGET_CONFLICT');
    const pinned = await tx`SELECT id, sender_id, connection_id, participant_ref FROM conversation
      WHERE lead_id = ${leadId} AND channel = 'WHATSAPP' AND state <> 'CLOSED'
      ORDER BY started_at DESC, id DESC LIMIT 2`;
    if (pinned.length > 1) return attention(tx, event.id, 'MULTIPLE_ACTIVE_CONVERSATIONS');
    if (pinned.length === 1) {
      if (pinned[0]!.sender_id !== event.sender_id || pinned[0]!.connection_id !== event.connection_id
        || pinned[0]!.participant_ref !== event.participant_ref)
        return attention(tx, event.id, 'PINNED_SENDER_MISMATCH');
      conversationId = pinned[0]!.id;
    } else {
      const human = lead.assigned_agent_id && lead.agent_active ? lead.assigned_agent_id : null;
      const created = (await tx`INSERT INTO conversation (lead_id, connection_id, sender_id, channel,
        participant_ref, controller_type, controller_user_id, state, needs_attention_reason)
        VALUES (${leadId}, ${event.connection_id}, ${event.sender_id}, 'WHATSAPP',
          ${event.participant_ref}, ${human ? 'HUMAN' : 'NONE'}, ${human},
          ${human ? 'HUMAN_ACTIVE' : 'WAITING_FOR_HUMAN'},
          ${human ? null : 'NO_HUMAN_CONTROLLER'}) RETURNING id`)[0]!;
      conversationId = created.id;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
        target_type, target_id, detail) VALUES (${sender.organization_id}, ${lead.branch_id},
          ${decision?.actor.id ?? null}, 'INBOUND_CONVERSATION_OPENED', 'CONVERSATION',
          ${conversationId}, ${tx.json({ leadId, eventId: event.id })})`;
    }
  }
  const inserted = await tx`INSERT INTO conversation_message (conversation_id, connection_id,
    sender_id, direction, author_type, body, provider_message_id, delivery_state, received_at,
    message_kind, attachment_id,reply_to_message_id,reply_button_index,source_event_id,source_reference)
    VALUES (${conversationId}, ${event.connection_id}, ${event.sender_id}, 'INBOUND', 'CUSTOMER',
      ${body}, ${message.id}, 'RECEIVED', ${timestamp}, ${attachmentId ? 'ATTACHMENT' : 'TEXT'}, ${attachmentId},
      ${quickReply?.messageId ?? null},${quickReply?.index ?? null},${event.id},${sourceReference ? tx.json(sourceReference) : null})
    ON CONFLICT DO NOTHING RETURNING id`;
  const existing = inserted.length ? null : (await tx`SELECT id, conversation_id FROM conversation_message
    WHERE connection_id = ${event.connection_id} AND provider_message_id = ${message.id}`)[0];
  if (existing && existing.conversation_id !== conversationId)
    throw new HttpError(409, 'INBOUND_MESSAGE_ALREADY_ATTACHED');
  await tx`UPDATE conversation SET last_message_at = GREATEST(coalesce(last_message_at, ${timestamp}), ${timestamp}),
    needs_attention_reason = CASE WHEN controller_type = 'AI' THEN 'AI_PROCESSING_NOT_READY'
      ELSE needs_attention_reason END,
    state = CASE WHEN controller_type = 'AI' THEN 'AI_HANDOFF_REQUIRED' ELSE state END
    WHERE id = ${conversationId}`;
  await tx`UPDATE integration_event SET state = 'PROCESSED', failure_code = NULL,
    lead_id = ${leadId}, conversation_id = ${conversationId}, resolved_by = ${decision?.actor.id ?? null},
    resolved_at = now() WHERE id = ${event.id}`;
  await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
    target_type, target_id, detail) SELECT l.organization_id, l.branch_id,
      ${decision?.actor.id ?? null}, 'INBOUND_MESSAGE_ATTACHED', 'MESSAGE', ${inserted[0]?.id ?? existing?.id},
      ${tx.json({ eventId: event.id, conversationId,
        resolutionBasis: decision ? 'MANUAL_REVIEW' : providerContext ? 'PROVIDER_CONTEXT' : sourceReference ? 'SOURCE_REFERENCE' : 'PARTICIPANT',
        sourceReference:sourceReference ? { namespace:sourceReference.namespace,externalId:sourceReference.externalId } : null,
        sourceEvidence:sourceEvidence ?? null })} FROM lead l WHERE l.id = ${leadId}`;
  return { state: 'PROCESSED', leadId: leadId!, conversationId: conversationId!,
    messageId: inserted[0]?.id ?? existing?.id, existing: Boolean(existing) };
}

export async function processOneInboundEvent(db: Database): Promise<boolean> {
  return processOneIntegrationEvent(db, 'INBOUND_MESSAGE', processInboundEvent);
}
