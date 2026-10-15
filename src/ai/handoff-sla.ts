import type {Database} from '../db.js';

// No external I/O: transaction locks replace a lease. Rollback leaves the durable cursor unchanged.
export async function processOneHandoffSLATimer(db:Database):Promise<boolean>{
 return db.begin(async tx=>{
  const queue=(await tx`SELECT q.action_id FROM ai_handoff_sla_queue q JOIN ai_handoff_sla_timer t ON t.action_id=q.action_id
   WHERE q.failure_count<5 AND q.next_run_at<'infinity' AND q.next_run_at<=ai_handoff_sla_now() AND t.state NOT IN ('EXPIRED','CANCELLED')
   ORDER BY q.next_run_at,q.action_id FOR UPDATE OF q SKIP LOCKED LIMIT 1`)[0];
  if(!queue)return false;
  try{await tx.savepoint(async step=>{await step`UPDATE ai_handoff_sla_timer SET version=version+1 WHERE action_id=${queue.action_id}`;await step`SET CONSTRAINTS ai_handoff_sla_final_expiry IMMEDIATE`;});}
  catch{await tx`UPDATE ai_handoff_sla_queue SET version=version+1,operation='FAILURE' WHERE action_id=${queue.action_id}`;}
  return true;
 });
}

// One bounded startup sweep for pre-migration actual receipts. Never scan all waiting conversations every tick.
// New receipts are admitted atomically by the native trigger; unique action IDs make restart/concurrency safe.
export async function admitLegacyHandoffSLATimers(db:Database,cursor:string|null,limit=25){
 if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Invalid SLA admission batch');
 const sources=await db`SELECT cv.ai_handoff_action_id AS action_id FROM conversation cv JOIN ai_handoff_reception_event re ON re.action_id=cv.ai_handoff_action_id
  JOIN ai_customer_handoff_action a ON a.id=re.action_id AND a.state='APPLIED'
  WHERE cv.state='WAITING_FOR_HUMAN' AND cv.controller_type='NONE' AND (${cursor}::uuid IS NULL OR cv.ai_handoff_action_id>${cursor}::uuid)
   AND NOT EXISTS(SELECT 1 FROM ai_handoff_sla_timer t WHERE t.action_id=re.action_id) AND ai_handoff_reception(a.id,statement_timestamp()) IS NOT NULL
  ORDER BY cv.ai_handoff_action_id LIMIT ${limit}`;
 for(const source of sources)try{await db`INSERT INTO ai_handoff_sla_timer(action_id) VALUES(${source.action_id}) ON CONFLICT(action_id) DO NOTHING`;}
 catch(error){if(!(error instanceof Error)||error.message!=='HANDOFF_SLA_CURRENT_WAITING_REQUIRED')throw error;}
 return {done:sources.length<limit,nextCursor:sources.at(-1)?.action_id as string|undefined};
}
