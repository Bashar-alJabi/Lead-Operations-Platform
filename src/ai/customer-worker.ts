import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { openSecret } from '../credentials.js';
import { effectiveConfigHash } from './operational-config.js';
import { AIInferenceError, type AIInferenceRegistry } from './inference-provider.js';
import { assertAIReadTestTransport } from './read-transport.js';
import { customerSafeEvidence, customerProviderInput, validateCustomerProposal, type CustomerEvidence, type CustomerProposal } from './customer-proposal.js';

// Only newly processed authenticated events may create work. No public enqueue, BLOCKED replay or Human principal.
export async function enqueueCustomerProposal(tx: postgres.TransactionSql, eventId: string) {
  const assembled = (await tx`WITH source AS (SELECT ai_customer_proposal_context(${eventId}) AS context) SELECT context,octet_length(context::text) AS context_bytes FROM source`)[0];
  const context = assembled?.context;
  if (!context) return null;
  const s = context.scope;
  if (assembled!.context_bytes > 1048576) {
    // Keep valid inbound messaging available even when an AI snapshot exceeds the technical bound.
    await tx`UPDATE conversation SET needs_attention_reason='AI_CUSTOMER_CONTEXT_TOO_LARGE' WHERE id=${s.conversationId} AND controller_type='AI'`;
    await tx`INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail) VALUES(${s.organizationId},${s.branchId},'AI_CUSTOMER_CONTEXT_BLOCKED','CONVERSATION',${s.conversationId},${tx.json({ eventId, errorCode: 'AI_CUSTOMER_CONTEXT_TOO_LARGE', maxBytes: 1048576 })})`;
    return null;
  }
  if ((await tx`SELECT count(*)::integer AS n FROM ai_customer_proposal WHERE conversation_id=${s.conversationId} AND state IN ('QUEUED','RUNNING')`)[0]!.n >= 10) {
    await tx`UPDATE conversation SET needs_attention_reason='AI_QUEUE_BACKPRESSURE' WHERE id=${s.conversationId} AND controller_type='AI'`;
    await tx`INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail) VALUES(${s.organizationId},${s.branchId},'AI_CUSTOMER_PROPOSAL_BACKPRESSURE','CONVERSATION',${s.conversationId},${tx.json({ eventId, pendingLimit: 10 })})`;
    return null;
  }
  const proposal = (await tx`INSERT INTO ai_customer_proposal(organization_id,branch_id,campaign_id,lead_id,conversation_id,event_id,message_id,context,context_hash)
    VALUES(${s.organizationId},${s.branchId},${s.campaignId},${s.leadId},${s.conversationId},${eventId},${context.source.messageId},${tx.json(context)},'') ON CONFLICT(event_id) DO NOTHING RETURNING id`)[0] ?? null;
  if (proposal && (await tx`SELECT ai_qualification_admissible(${tx.json(context)}) AS allowed`)[0]!.allowed)
    await tx`INSERT INTO ai_customer_action_admission(proposal_id,event_id,context) VALUES(${proposal.id},${eventId},${tx.json(context)})`;
  return proposal;
}
export async function processOneAICustomerProposal(db: Database, options: { adapters?: AIInferenceRegistry; leaseSeconds?: number; retryDelaySeconds?: number } = {}): Promise<boolean> {
  const transport = await assertAIReadTestTransport(db, options.adapters), lease = options.leaseSeconds ?? 60, delay = options.retryDelaySeconds;
  if (!Number.isFinite(lease) || lease < 0.1 || lease > 120 || delay != null && (!Number.isFinite(delay) || delay < 0 || delay > 300)) throw new Error('AI_CUSTOMER_WORKER_CONFIG_INVALID');
  const token = randomUUID(), row = await db.begin(async tx => {
    const p = (await tx`SELECT * FROM ai_customer_proposal WHERE (state='QUEUED' AND available_at<=clock_timestamp()) OR (state='RUNNING' AND lease_until<=clock_timestamp()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)[0];
    if (!p) return null;
    if (p.attempt_count >= 5) {
      await tx`UPDATE ai_customer_proposal SET state='FAILED',error_code='AI_RETRY_EXHAUSTED',completed_lease_token=lease_token,lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=${p.id}`;
      return { exhausted: true };
    }
    return (await tx`UPDATE ai_customer_proposal SET state='RUNNING',attempt_count=attempt_count+1,lease_token=${token},lease_until=clock_timestamp()+(${lease}*interval '1 second'),completed_lease_token=NULL,error_code=NULL,version=version+1 WHERE id=${p.id} RETURNING *`)[0]!;
  });
  if (!row) return false; if (row.exhausted) return true;
  const authorize = async (tx: postgres.TransactionSql) => {
    const current = (await tx`SELECT ai_customer_proposal_locked_context(${row.event_id}) AS context`)[0]?.context;
    if (!current || effectiveConfigHash(current) !== effectiveConfigHash(row.context)) return null;
    return (await tx`SELECT 1 FROM ai_customer_proposal WHERE id=${row.id} AND state='RUNNING' AND lease_token=${token} AND lease_until>clock_timestamp() FOR SHARE`)[0] ? current : null;
  };
  let result: CustomerProposal | null = null, failure: AIInferenceError | null = null, block: string | null = null, invoked = false;
  try {
    const prepared = await db.begin(async tx => {
      const current = await authorize(tx); if (!current) { block = 'AI_CUSTOMER_CONTEXT_REVOKED_OR_CHANGED'; return null; }
      // Live gate precedes secret access and construction of customer/provider payloads.
      if (!transport) { block = 'AI_LIVE_DATA_TRANSFER_DISABLED'; return null; }
      const evidence: CustomerEvidence = { messages: current.messages, references: current.references, questions: current.questions, sourceMessageId: current.source.messageId };
      const safe = customerSafeEvidence(evidence);
      if (!safe.messages.some(m => m.id === safe.sourceMessageId)) { block = 'AI_SENSITIVE_INPUT_OMITTED'; return null; }
      const p = current.profile, secret = (await tx`SELECT ciphertext,nonce,auth_tag,key_version FROM connection_secret WHERE connection_id=${p.connectionId} FOR SHARE`)[0];
      if (!secret) throw new AIInferenceError('AI_AUTH_FAILED'); let credential: string;
      try { credential = openSecret(p.connectionId, { ciphertext: secret.ciphertext, nonce: secret.nonce, authTag: secret.auth_tag, keyVersion: secret.key_version }); }
      catch { throw new AIInferenceError('AI_AUTH_FAILED'); }
      return { profile: p, evidence: safe, credential, data: customerProviderInput(safe, { language: current.operationalData.language, tone: current.operationalData.tone, prohibitedClaims: current.knowledgeData.content.prohibitedClaims }) };
    });
    if (prepared) {
      const execute = options.adapters![prepared.profile.provider]?.proposeCustomer;
      if (!execute) throw new AIInferenceError('AI_MODEL_UNSUPPORTED');
      invoked = true;
      const proposal = await execute({ credential: prepared.credential, model: prepared.profile.modelId, maxOutputTokens: prepared.profile.maxOutputTokens, data: prepared.data });
      try { result = validateCustomerProposal(proposal, prepared.evidence); } catch { throw new AIInferenceError('AI_RESPONSE_INVALID'); }
    }
  } catch (e) { failure = e instanceof AIInferenceError ? e : new AIInferenceError('AI_PROVIDER_UNAVAILABLE', true); }
  await db.begin(async tx => {
    if (!await authorize(tx)) block = 'AI_CUSTOMER_CONTEXT_REVOKED_OR_CHANGED';
    const held = (await tx`SELECT * FROM ai_customer_proposal WHERE id=${row.id} FOR UPDATE`)[0];
    if (held?.state !== 'RUNNING' || held.lease_token !== token || !(await tx`SELECT ${held.lease_until}::timestamptz>clock_timestamp() AS current`)[0]!.current) return;
    const retry = !block && failure?.retryable && held.attempt_count < 5;
    const state = block ? 'BLOCKED' : failure ? retry ? 'QUEUED' : 'FAILED' : 'PROPOSED';
    await tx`UPDATE ai_customer_proposal SET state=${state},result=${state === 'PROPOSED' ? tx.json({ ...result!, protocolVersion: 1, toolsExecuted: [], sendAllowed: false, mutationsAllowed: false }) : null},
      error_code=${block ?? failure?.code ?? null},provider_invoked=provider_invoked OR ${invoked},completed_lease_token=${token},lease_token=NULL,lease_until=NULL,
      available_at=clock_timestamp()+(${delay ?? Math.min(300, 2 ** held.attempt_count)}*interval '1 second'),version=version+1 WHERE id=${row.id}`;
    if (state === 'FAILED' || state === 'BLOCKED' || state === 'PROPOSED' && result!.decision !== 'QUALIFICATION')
      await tx`UPDATE conversation cv SET state='AI_HANDOFF_REQUIRED',needs_attention_reason='AI_PROCESSING_NOT_READY'
        WHERE cv.id=${row.conversation_id} AND cv.controller_type='AI' AND cv.state IN ('AI_ACTIVE','AI_WAITING_FOR_LEAD') AND cv.needs_attention_reason IS NULL
          AND ${row.message_id}::uuid=(SELECT id FROM conversation_message WHERE conversation_id=cv.id ORDER BY created_at DESC,id DESC LIMIT 1)
          AND EXISTS(SELECT 1 FROM ai_customer_action_admission WHERE proposal_id=${row.id})`;
  });
  return true;
}
