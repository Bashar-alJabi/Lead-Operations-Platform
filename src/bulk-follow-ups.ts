import type {FastifyRequest} from 'fastify';
import type {Database} from './db.js';
import {HttpError,type Principal} from './security.js';
import {bulkHash,bulkSession,bulkScope,bulkDeadline,bulkFailure} from './bulk-actions.js';
import {createHumanFollowUp,humanFollowUpOwner,requireHumanFollowUpOwner,type HumanFollowUpInput,type FollowUpLead} from './human-follow-ups.js';
export type BulkFollowUpInput=HumanFollowUpInput&{requestId:string;confirmed:true;items:{id:string;leadVersion:number;ownerUserId:string}[]};
export function bulkFollowUpHash(input:BulkFollowUpInput){return bulkHash({dueAt:input.dueAt,note:input.note?.trim()??null,priority:input.priority??'NORMAL',ownerUserId:input.ownerUserId??null,items:input.items});}
export async function executeBulkFollowUps(db:Database,actor:Principal,request:FastifyRequest,input:BulkFollowUpInput){
 const deadline=bulkDeadline('BULK_FOLLOW_UP_REQUEST_BUDGET_MS'),hash=bulkFollowUpHash(input);
 const batch=await db.begin(async tx=>{
  const session=await bulkSession(tx,actor,request);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id+':follow-up:'+input.requestId},0))`;
  let row=(await tx`SELECT * FROM bulk_follow_up_batch WHERE actor_id=${actor.id} AND request_key=${input.requestId}`)[0];
  if(!row){row=(await tx`INSERT INTO bulk_follow_up_batch(organization_id,actor_id,actor_role,branch_scope,session_id,request_key,request_hash,item_count)
   VALUES(${actor.organizationId},${actor.id},${actor.role},${actor.branchId},${session},${input.requestId},${hash},${input.items.length}) RETURNING *`)[0]!;
   await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(${actor.organizationId},${actor.branchId},${actor.id},'BULK_FOLLOW_UP_REQUESTED','BULK_FOLLOW_UP_BATCH',${row.id},${tx.json({count:input.items.length})})`;
  }
  if(!Buffer.from(row.request_hash).equals(hash))throw new HttpError(409,'BULK_REQUEST_CONFLICT');
  if(row.organization_id!==actor.organizationId||row.actor_role!==actor.role||row.branch_scope!==actor.branchId)throw new HttpError(403,'BULK_CONTEXT_CHANGED');
  return row;
 });
 const results:{id:string;status:'CREATED'|'REPLAYED'|'FAILED';followUpId?:string;error?:string}[]=[];
 for(const item of input.items){
  if(Date.now()>=deadline){results.push({id:item.id,status:'FAILED',error:'BULK_REQUEST_PAUSED'});continue;}
  try{const result=await db.begin(async tx=>{
   await tx`SET LOCAL statement_timeout='8s'`;await tx`SET LOCAL lock_timeout='750ms'`;
   const lead=(await tx`SELECT l.id,l.branch_id,l.campaign_id,l.assigned_agent_id,l.version FROM lead l WHERE l.id=${item.id} AND ${bulkScope(tx,actor)} FOR UPDATE OF l`)[0];
   if(!lead)throw new HttpError(404,'LEAD_NOT_FOUND');
   const session=await bulkSession(tx,actor,request),typed=lead as FollowUpLead;
   // A receipt does not grant current Lead/owner authority or revive a cancelled task.
   await requireHumanFollowUpOwner(tx,actor,typed,item.ownerUserId);
   const receipt=(await tx`SELECT follow_up_id FROM bulk_follow_up_receipt WHERE batch_id=${batch.id} AND lead_id=${lead.id}`)[0];
   if(receipt)return {status:'REPLAYED' as const,followUpId:receipt.follow_up_id as string};
   if(lead.version!==item.leadVersion)throw new HttpError(409,'LEAD_VERSION_CONFLICT');
   if(humanFollowUpOwner(actor,typed,input)!==item.ownerUserId)throw new HttpError(409,'FOLLOW_UP_OWNER_CHANGED');
   const task=await createHumanFollowUp(tx,actor,typed,input);
   await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(${actor.organizationId},${lead.branch_id},${actor.id},'BULK_FOLLOW_UP_CREATED','FOLLOW_UP',${task.id},${tx.json({batchId:batch.id,leadId:lead.id})})`;
   await tx`INSERT INTO bulk_follow_up_receipt(batch_id,lead_id,branch_id,campaign_id,session_id,lead_version,owner_user_id,follow_up_id,history_id)
    VALUES(${batch.id},${lead.id},${lead.branch_id},${lead.campaign_id},${session},${lead.version},${task.owner},${task.id},${task.historyId})`;
   await bulkSession(tx,actor,request);
   return {status:'CREATED' as const,followUpId:task.id};
  });results.push({id:item.id,...result});
  }catch(error){results.push({id:item.id,status:'FAILED',error:bulkFailure(error)});}
 }
 return {requestId:input.requestId,results};
}
