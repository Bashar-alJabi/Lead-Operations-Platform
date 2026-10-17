import type postgres from 'postgres';
import type { Database } from '../db.js';
export type LocalAIActionKind = 'QUALIFICATION' | 'HANDOFF' | 'SEND';

export async function lockLocalAIAction(tx: postgres.TransactionSql, kind: LocalAIActionKind, proposalId: string) {
  await tx`SELECT id FROM ai_local_action_queue WHERE kind=${kind} AND proposal_id=${proposalId} FOR UPDATE`;
}
// A local action has no external I/O. Short row locks replace a lease; no partial Domain writes escape the savepoint.
export async function processOneLocalAIAction(db: Database, kind: LocalAIActionKind,
  execute: (tx: postgres.TransactionSql, proposalId: string) => Promise<unknown>): Promise<boolean> {
  const result = await db.begin(async tx => {
    await tx`SET LOCAL lock_timeout='2s'`;
    await tx`SET LOCAL statement_timeout='10s'`;
    const pending = (await tx`SELECT id,proposal_id FROM ai_local_action_queue WHERE kind=${kind} AND state='WAITING' AND failure_count<5 AND available_at<=ai_local_action_now()
      ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)[0];
    if (!pending) return null;
    try {
      await tx.savepoint(async step => { await execute(step, pending.proposal_id as string); await step`SET CONSTRAINTS ALL IMMEDIATE`; });
      return { failed: false };
    } catch {
      const q = (await tx`UPDATE ai_local_action_queue SET operation='FAILURE',version=version+1 WHERE id=${pending.id} RETURNING id,state,failure_count`)[0]!;
      return { failed: true, id: q.id, state: q.state, failures: q.failure_count };
    }
  });
  if (result?.failed) process.stderr.write(JSON.stringify({ event: 'ai_local_action_step_failed', kind, queueId: result.id, state: result.state, failureCount: result.failures }) + '\n');
  return result !== null;
}

type LegacyCursor = { createdAt: string; proposalId: string };
// One bounded startup traversal of indexed pending Jobs; no historical admission grants or per-tick full scans.
export async function admitLegacyLocalAIActions(db: Database, kind: LocalAIActionKind, cursor: LegacyCursor | null, limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !['QUALIFICATION', 'HANDOFF'].includes(kind)) throw new Error('Invalid local AI action admission capacity');
  const table = kind === 'QUALIFICATION' ? db('ai_customer_action_job') : db('ai_customer_handoff_job');
  const rows = await db`SELECT proposal_id,created_at::text AS cursor_at FROM ${table} WHERE state='QUEUED'
    AND (${cursor?.createdAt ?? null}::text::timestamptz IS NULL OR (created_at,proposal_id)>(${cursor?.createdAt ?? null}::text::timestamptz,${cursor?.proposalId ?? null}::uuid))
    ORDER BY created_at,proposal_id LIMIT ${limit}`;
  for (const row of rows) try { await db.begin(async tx => {
    // A concurrent normal worker may have completed this source after the batch read.
    const source = kind === 'QUALIFICATION' ? await tx`SELECT 1 FROM ai_customer_action_job WHERE proposal_id=${row.proposal_id} AND state='QUEUED'`
      : await tx`SELECT 1 FROM ai_customer_handoff_job WHERE proposal_id=${row.proposal_id} AND state='QUEUED'`;
    if (source.length) await tx`INSERT INTO ai_local_action_queue(proposal_id,kind,operation) VALUES(${row.proposal_id},${kind},'ADMIT') ON CONFLICT(proposal_id,kind) DO NOTHING`;
  }); } catch (error) {
    if (!(error instanceof Error) || error.message !== 'AI_LOCAL_ACTION_ADMISSION_REQUIRED') throw error;
    const completed = kind === 'QUALIFICATION' ? await db`SELECT 1 FROM ai_customer_action_job WHERE proposal_id=${row.proposal_id} AND state='DONE'`
      : await db`SELECT 1 FROM ai_customer_handoff_job WHERE proposal_id=${row.proposal_id} AND state='DONE'`;
    if (!completed.length) throw error;
  }
  const last = rows.at(-1);
  return { done: rows.length < limit, nextCursor: last ? { createdAt: last.cursor_at as string, proposalId: last.proposal_id as string } : cursor };
}
