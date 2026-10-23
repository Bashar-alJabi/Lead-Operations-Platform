import type {Database} from './db.js';

// Bounded candidate read, then the same parent/task/queue lock order used by task writers.
// There is no external I/O or lease: the observation, inbox event, queue and Audit commit together.
export async function processOneFollowUpNotification(db:Database):Promise<boolean>{
 const candidates=await db`SELECT q.follow_up_id,f.lead_id,l.branch_id,l.campaign_id FROM follow_up_notification_queue q
  JOIN follow_up f ON f.id=q.follow_up_id JOIN lead l ON l.id=f.lead_id
  WHERE q.state='WAITING' AND q.next_run_at<=statement_timestamp() AND q.due_at<=statement_timestamp()
  ORDER BY q.next_run_at,q.follow_up_id LIMIT 25`;
 for(const candidate of candidates){
  const processed=await db.begin(async tx=>{
   await tx`SET LOCAL lock_timeout='750ms'`;await tx`SET LOCAL statement_timeout='5s'`;
   await tx`SELECT id FROM branch WHERE id=${candidate.branch_id} FOR SHARE`;
   const lead=(await tx`SELECT id,branch_id,campaign_id FROM lead WHERE id=${candidate.lead_id} FOR SHARE`)[0];
   if(!lead||lead.branch_id!==candidate.branch_id||lead.campaign_id!==candidate.campaign_id)return false;
   await tx`SELECT id FROM campaign WHERE id=${lead.campaign_id} FOR SHARE`;
   if(!(await tx`SELECT id FROM follow_up WHERE id=${candidate.follow_up_id} AND lead_id=${lead.id} FOR UPDATE SKIP LOCKED`).length)return false;
   const queue=(await tx`SELECT follow_up_id FROM follow_up_notification_queue WHERE follow_up_id=${candidate.follow_up_id}
    AND state='WAITING' AND next_run_at<=statement_timestamp() AND due_at<=statement_timestamp() FOR UPDATE SKIP LOCKED`)[0];
   if(!queue)return false;
   try{await tx.savepoint(async step=>{await step`INSERT INTO follow_up_due_observation(follow_up_id) VALUES(${queue.follow_up_id})`;});}
   catch{await tx`UPDATE follow_up_notification_queue SET version=version+1,operation='FAILURE' WHERE follow_up_id=${queue.follow_up_id}`;}
   return true;
  });
  if(processed)return true;
 }
 return false;
}
