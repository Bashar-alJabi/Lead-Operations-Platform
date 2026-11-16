import type postgres from 'postgres';
import {HttpError,type Principal} from './security.js';
export type HumanFollowUpInput={dueAt:string;note?:string;ownerUserId?:string;priority?:'LOW'|'NORMAL'|'HIGH'};
export type FollowUpLead={id:string;branch_id:string;assigned_agent_id:string|null};
export function humanFollowUpOwner(actor:Principal,lead:FollowUpLead,input:Pick<HumanFollowUpInput,'ownerUserId'>){
 return input.ownerUserId??(actor.role==='AGENT'?actor.id:lead.assigned_agent_id??actor.id);
}
export async function requireHumanFollowUpOwner(tx:postgres.TransactionSql,actor:Principal,lead:FollowUpLead,owner:string){
 if(actor.role==='AGENT'&&owner!==actor.id)throw new HttpError(403,'FOLLOW_UP_OWNER_DENIED');
 const found=await tx`SELECT id FROM user_account WHERE id=${owner} AND organization_id=${actor.organizationId}
  AND branch_id=${lead.branch_id} AND active AND role IN ('MANAGER','AGENT') FOR SHARE`;
 if(!found.length)throw new HttpError(400,'FOLLOW_UP_OWNER_NOT_ELIGIBLE');
}
// Shared Human service. Background AI/Automation use their own approved execution authority.
export async function createHumanFollowUp(tx:postgres.TransactionSql,actor:Principal,lead:FollowUpLead,input:HumanFollowUpInput){
 const owner=humanFollowUpOwner(actor,lead,input);await requireHumanFollowUpOwner(tx,actor,lead,owner);
 const priority=input.priority??'NORMAL',note=input.note?.trim()??null;
 const task=(await tx`INSERT INTO follow_up(lead_id,owner_user_id,due_at,note,priority,created_by,kind)
  VALUES(${lead.id},${owner},${input.dueAt}::text::timestamptz,${note},${priority},${actor.id},'HUMAN') RETURNING id`)[0]!;
 const history=(await tx`INSERT INTO follow_up_history(follow_up_id,actor_user_id,event_type,detail)
  VALUES(${task.id},${actor.id},'CREATED',${tx.json({owner,dueAt:input.dueAt,priority,note})}) RETURNING id`)[0]!;
 await tx`INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail)
  VALUES(${lead.id},${actor.id},'FOLLOW_UP_CREATED',${tx.json({followUpId:task.id})})`;
 await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id)
  VALUES(${actor.organizationId},${lead.branch_id},${actor.id},'FOLLOW_UP_CREATED','FOLLOW_UP',${task.id})`;
 return {id:task.id as string,historyId:history.id as string,owner};
}
