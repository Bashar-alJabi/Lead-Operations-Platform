import type {FastifyInstance} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest} from '../security.js';
import {bulkScope,bulkSession} from '../bulk-actions.js';
import {executeBulkFollowUps,type BulkFollowUpInput} from '../bulk-follow-ups.js';
const uuid={type:'string',format:'uuid'} as const;
function distinct(ids:string[]){if(new Set(ids).size!==ids.length)throw new HttpError(400,'DUPLICATE_BULK_LEAD');}
export function registerBulkFollowUpRoutes(app:FastifyInstance,db:Database){
 app.post<{Body:{ids:string[];ownerUserId?:string}}>('/api/leads/bulk/followups/preview',{schema:{body:{type:'object',additionalProperties:false,required:['ids'],properties:{ids:{type:'array',minItems:1,maxItems:50,items:uuid},ownerUserId:uuid}}}},async request=>{
  const actor=await principalFromRequest(request,db),{ids,ownerUserId}=request.body;distinct(ids);
  return db.begin(async tx=>{
   await bulkSession(tx,actor,request);
   const rows=await tx`SELECT l.id,l.version AS "leadVersion",u.id AS "ownerUserId" FROM lead l
    JOIN user_account u ON u.id=COALESCE(${ownerUserId??null}::uuid,CASE WHEN ${actor.role==='AGENT'} THEN ${actor.id}::uuid ELSE COALESCE(l.assigned_agent_id,${actor.id}::uuid) END)
     AND u.organization_id=l.organization_id AND u.branch_id=l.branch_id AND u.active AND u.role IN ('MANAGER','AGENT')
    WHERE l.id IN ${tx(ids)} AND ${bulkScope(tx,actor)} AND (${actor.role!=='AGENT'} OR u.id=${actor.id})`;
   await bulkSession(tx,actor,request);const byId=new Map(rows.map(r=>[r.id,r]));
   return {items:ids.map(id=>byId.has(id)?{...byId.get(id),status:'ELIGIBLE'}:{id,status:'FAILED',error:'LEAD_OR_OWNER_NOT_AVAILABLE'})};
  });
 });
 app.post<{Body:BulkFollowUpInput}>('/api/leads/bulk/followups',{schema:{body:{type:'object',additionalProperties:false,required:['requestId','confirmed','dueAt','items'],properties:{
  requestId:uuid,confirmed:{const:true},dueAt:{type:'string',format:'date-time'},note:{type:'string',maxLength:4000},priority:{enum:['LOW','NORMAL','HIGH']},ownerUserId:uuid,
  items:{type:'array',minItems:1,maxItems:50,items:{type:'object',additionalProperties:false,required:['id','leadVersion','ownerUserId'],properties:{id:uuid,leadVersion:{type:'integer',minimum:1},ownerUserId:uuid}}}}}}},async request=>{
   const actor=await principalFromRequest(request,db);distinct(request.body.items.map(i=>i.id));return executeBulkFollowUps(db,actor,request,request.body);
 });
}
