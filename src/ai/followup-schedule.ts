import type { Database } from '../db.js';

export async function processOneAIFollowupSchedule(db: Database): Promise<boolean> {
  return db.begin(async tx => {
    const [candidate] = await tx`SELECT s.id,s.lead_id,s.conversation_id FROM ai_followup_schedule s
      JOIN branch b ON b.id=s.branch_id WHERE s.state='WAITING' AND s.due_at<=clock_timestamp()
      ORDER BY s.due_at,s.id LIMIT 1 FOR UPDATE OF b SKIP LOCKED`;
    if (!candidate) return false;
    // Inbound and human takeover lock the Lead and Conversation before changing the schedule.
    await tx`SELECT id FROM lead WHERE id=${candidate.lead_id} FOR UPDATE`;
    await tx`SELECT id FROM conversation WHERE id=${candidate.conversation_id} FOR UPDATE`;
    const updated = await tx`UPDATE ai_followup_schedule SET state='READY'
      WHERE id=${candidate.id} AND state='WAITING' AND due_at<=clock_timestamp() RETURNING id`;
    return updated.length>0;
  });
}
