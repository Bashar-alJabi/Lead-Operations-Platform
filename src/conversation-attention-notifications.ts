import type {Database} from './db.js';

// Capture never takes a parent lock. This independent publisher follows Branch->Lead->Campaign->Conversation->Queue.
export async function processOneConversationAttentionNotification(db:Database):Promise<boolean>{
 const candidates=await db`SELECT s.id,s.branch_id,s.lead_id,s.campaign_id,s.conversation_id FROM conversation_attention_queue q
  JOIN conversation_attention_transition s ON s.id=q.source_id WHERE q.state='QUEUED' AND q.next_run_at<=statement_timestamp()
  ORDER BY q.next_run_at,q.source_id LIMIT 25`;
 for(const s of candidates){
  const done=await db.begin(async tx=>{
   await tx`SET LOCAL lock_timeout='750ms'`;await tx`SET LOCAL statement_timeout='5s'`;
   await tx`SELECT id FROM branch WHERE id=${s.branch_id} FOR SHARE`;
   await tx`SELECT id FROM lead WHERE id=${s.lead_id} FOR SHARE`;
   await tx`SELECT id FROM campaign WHERE id=${s.campaign_id} FOR SHARE`;
   await tx`SELECT id FROM conversation WHERE id=${s.conversation_id} FOR SHARE`;
   const q=(await tx`SELECT source_id FROM conversation_attention_queue WHERE source_id=${s.id} AND state='QUEUED' AND next_run_at<=statement_timestamp() FOR UPDATE SKIP LOCKED`)[0];
   if(!q)return false;
   try{await tx.savepoint(async step=>{await step`UPDATE conversation_attention_queue SET version=version+1,operation='PUBLISH' WHERE source_id=${s.id}`;});}
   catch{await tx`UPDATE conversation_attention_queue SET version=version+1,operation='FAILURE' WHERE source_id=${s.id}`;}
   return true;
  });
  if(done)return true;
 }
 return false;
}
