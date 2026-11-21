import type {Database} from './db.js';

// These processors never interpret SQL, scripts, provider operations or model-generated tools.
// Native approved-action guards atomically derive the two typed internal effects and their history.
export async function processOneAutomationMatch(db:Database):Promise<boolean> {
 const candidates=await db`SELECT source_id FROM automation_match_queue WHERE state='QUEUED' AND next_run_at<=statement_timestamp() ORDER BY next_run_at,source_id LIMIT 25`;
 for(const item of candidates){
  const processed=await db.begin(async tx=>{
   await tx`SET LOCAL lock_timeout='750ms'`;await tx`SET LOCAL statement_timeout='5s'`;
   const q=(await tx`SELECT source_id FROM automation_match_queue WHERE source_id=${item.source_id} AND state='QUEUED'
    AND next_run_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`)[0];if(!q)return false;
   try{await tx.savepoint(async save=>{await save`UPDATE automation_match_queue SET version=version+1,operation='MATCH' WHERE source_id=${q.source_id}`;});}
   catch{await tx`UPDATE automation_match_queue SET version=version+1,operation='FAILURE' WHERE source_id=${q.source_id}`;}
   return true;
  });if(processed)return true;
 }
 return false;
}

export async function processOneAutomationExecution(db:Database):Promise<boolean> {
 const candidates=await db`SELECT e.id,s.branch_id,s.lead_id,s.campaign_id,e.rule_id,f.field_id,r.condition_field_id FROM automation_execution e
  JOIN automation_source s ON s.id=e.source_id JOIN automation_rule r ON r.id=e.rule_id
  LEFT JOIN automation_field_change f ON f.id=s.field_change_id
  WHERE e.state='QUEUED' AND e.next_run_at<=statement_timestamp()
  ORDER BY e.next_run_at,e.id LIMIT 25`;
 for(const item of candidates){
  try{
   const processed=await db.begin(async tx=>{
    await tx`SET LOCAL lock_timeout='750ms'`;await tx`SET LOCAL statement_timeout='5s'`;
    await tx`SELECT id FROM branch WHERE id=${item.branch_id} FOR SHARE`;
    await tx`SELECT id FROM lead WHERE id=${item.lead_id} FOR UPDATE`;
    await tx`SELECT id FROM campaign WHERE id=${item.campaign_id} FOR SHARE`;
    if(item.field_id||item.condition_field_id)await tx`SELECT id FROM field_definition
      WHERE id IN (${item.field_id},${item.condition_field_id}) ORDER BY id FOR SHARE`;
    await tx`SELECT id FROM user_account WHERE id IN (SELECT actor_id FROM automation_rule WHERE id=${item.rule_id}
     UNION SELECT assigned_agent_id FROM lead WHERE id=${item.lead_id}) ORDER BY id FOR SHARE`;
    await tx`SELECT id FROM automation_rule WHERE id=${item.rule_id} FOR SHARE`;
    const e=(await tx`SELECT id FROM automation_execution WHERE id=${item.id} AND state='QUEUED'
     AND next_run_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`)[0];if(!e)return false;
    try{await tx.savepoint(async save=>{await save`UPDATE automation_execution SET version=version+1,operation='EXECUTE' WHERE id=${e.id}`;});}
    catch{await tx`UPDATE automation_execution SET version=version+1,operation='FAILURE' WHERE id=${e.id}`;}
    return true;
   });if(processed)return true;
  }catch(error){if(!['55P03','40P01','57014'].includes((error as {code?:string}).code??''))throw error;}
 }
 return false;
}
