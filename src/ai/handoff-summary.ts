import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { openSecret } from '../credentials.js';
import { HttpError } from '../security.js';
import { AIInferenceError, type AIInferenceRegistry } from './inference-provider.js';
import { assertAIReadTestTransport } from './read-transport.js';
import { copilotSafeReferences, copilotSummaryPurpose } from './copilot-summary.js';
import { simulationResult, type SimulationReference, type SimulationProposal } from './simulation.js';

// Refresh uses a real authorized employee; the initial admission is native and autonomous.
export async function enqueueHandoffSummary(tx: postgres.TransactionSql, actionId: string, requestId: string, actorId: string, sessionId: string) {
  const assembled = (await tx`WITH source AS (SELECT ai_handoff_summary_locked_context(${actionId}) AS context) SELECT context,octet_length(context::text) AS bytes FROM source`)[0];
  const context = assembled?.context;
  if (!context) return null;
  if (assembled!.bytes > 1048576) throw new HttpError(409, 'AI_HANDOFF_SUMMARY_CONTEXT_TOO_LARGE');
  const existing = (await tx`SELECT id,action_id,actor_id FROM ai_handoff_summary WHERE request_id=${requestId}`)[0];
  if (existing) return existing.action_id === actionId && existing.actor_id === actorId ? { id: existing.id, duplicate: true } : null;
  const pending = (await tx`SELECT id FROM ai_handoff_summary WHERE action_id=${actionId} AND state IN ('QUEUED','RUNNING')`)[0];
  if (pending) return { id: pending.id, duplicate: true };
  const s = context.sourceContext.scope;
  const row = (await tx`INSERT INTO ai_handoff_summary(action_id,request_id,organization_id,branch_id,campaign_id,lead_id,conversation_id,actor_id,session_id,context,context_hash)
    VALUES(${actionId},${requestId},${s.organizationId},${s.branchId},${s.campaignId},${s.leadId},${s.conversationId},${actorId},${sessionId},${tx.json(context)},'') RETURNING id`)[0]!;
  return { id: row.id, duplicate: false };
}

export async function processOneAIHandoffSummary(db: Database, options: { adapters?: AIInferenceRegistry; leaseSeconds?: number; retryDelaySeconds?: number } = {}): Promise<boolean> {
  const transport = await assertAIReadTestTransport(db, options.adapters), lease = options.leaseSeconds ?? 60, delay = options.retryDelaySeconds;
  if (!Number.isFinite(lease) || lease < 0.1 || lease > 120 || delay != null && (!Number.isFinite(delay) || delay < 0 || delay > 300)) throw new Error('AI_HANDOFF_SUMMARY_WORKER_CONFIG_INVALID');
  const token = randomUUID(), row = await db.begin(async tx => {
    const s = (await tx`SELECT * FROM ai_handoff_summary WHERE (state='QUEUED' AND available_at<=clock_timestamp()) OR (state='RUNNING' AND lease_until<=clock_timestamp())
      ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)[0];
    if (!s) return null;
    if (s.attempt_count >= 5) {
      await tx`UPDATE ai_handoff_summary SET state='FAILED',error_code='AI_RETRY_EXHAUSTED',completed_lease_token=lease_token,lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=${s.id}`;
      return { exhausted: true };
    }
    return (await tx`UPDATE ai_handoff_summary SET state='RUNNING',attempt_count=attempt_count+1,lease_token=${token},lease_until=clock_timestamp()+(${lease}*interval '1 second'),
      completed_lease_token=NULL,error_code=NULL,version=version+1 WHERE id=${s.id} RETURNING *`)[0]!;
  });
  if (!row) return false; if (row.exhausted) return true;
  const authorize = async (tx: postgres.TransactionSql) => {
    // Acquire parents before the job row; no lock is held across provider I/O.
    if (!(await tx`SELECT ai_handoff_summary_current(s) AS current FROM ai_handoff_summary s WHERE id=${row.id}`)[0]?.current) return false;
    return !!(await tx`SELECT id FROM ai_handoff_summary WHERE id=${row.id} AND state='RUNNING' AND lease_token=${token} AND lease_until>clock_timestamp() FOR SHARE`)[0];
  };
  let result: ReturnType<typeof simulationResult> | null = null, failure: AIInferenceError | null = null, blocked = false;
  try {
    const input = await db.begin(async tx => {
      if (!await authorize(tx)) return null;
      // Live-off before reading secrets or constructing a provider payload. Synthetic injection only.
      if (!transport) throw new AIInferenceError('AI_LIVE_DATA_TRANSFER_DISABLED');
      const profile = row.context.profile;
      const secret = (await tx`SELECT ciphertext,nonce,auth_tag,key_version FROM connection_secret WHERE connection_id=${profile.connectionId} FOR SHARE`)[0];
      if (!secret) throw new AIInferenceError('AI_AUTH_FAILED');
      let credential: string;
      try { credential = openSecret(profile.connectionId, { ciphertext: secret.ciphertext, nonce: secret.nonce, authTag: secret.auth_tag, keyVersion: secret.key_version }); }
      catch { throw new AIInferenceError('AI_AUTH_FAILED'); }
      return { profile, credential };
    });
    if (!input) blocked = true;
    else {
      const execute = options.adapters![input.profile.provider]?.summarize;
      if (!execute) throw new AIInferenceError('AI_MODEL_UNSUPPORTED');
      const references = copilotSafeReferences(row.references_json as SimulationReference[]);
      const proposed = await execute({ credential: input.credential, model: input.profile.modelId, maxOutputTokens: input.profile.maxOutputTokens,
        data: { purpose: copilotSummaryPurpose, references, language: row.context.language } });
      try { result = simulationResult(proposed as SimulationProposal, references); } catch { throw new AIInferenceError('AI_RESPONSE_INVALID'); }
    }
  } catch (e) { failure = e instanceof AIInferenceError ? e : new AIInferenceError('AI_PROVIDER_UNAVAILABLE', true); }
  await db.begin(async tx => {
    if (!blocked && !await authorize(tx)) blocked = true;
    const held = (await tx`SELECT * FROM ai_handoff_summary WHERE id=${row.id} FOR UPDATE`)[0];
    if (held?.state !== 'RUNNING' || held.lease_token !== token || !(await tx`SELECT ${held.lease_until}::timestamptz>clock_timestamp() AS valid`)[0]!.valid) return;
    const retry = !blocked && failure?.retryable && held.attempt_count < 5;
    const state = blocked || failure?.code === 'AI_LIVE_DATA_TRANSFER_DISABLED' ? 'BLOCKED' : failure ? retry ? 'QUEUED' : 'FAILED' : 'COMPLETED';
    await tx`UPDATE ai_handoff_summary SET state=${state},result=${state === 'COMPLETED' ? tx.json(result!) : null},
      error_code=${blocked ? 'AI_HANDOFF_SUMMARY_CONTEXT_CHANGED' : failure?.code ?? null},completed_lease_token=${token},lease_token=NULL,lease_until=NULL,
      available_at=clock_timestamp()+(${delay ?? Math.min(300, 2 ** held.attempt_count)}*interval '1 second'),version=version+1 WHERE id=${row.id}`;
  });
  return true;
}
