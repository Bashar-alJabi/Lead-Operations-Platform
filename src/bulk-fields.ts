import type {FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import type {Database} from './db.js';
import {HttpError,type Principal} from './security.js';
import {bulkHash,bulkSession,bulkScope,bulkDeadline,bulkFailure} from './bulk-actions.js';
import {writableManualField,writeManualFieldValue} from './field-values.js';
import {validateFieldValue,type FieldType,type FieldOption,type FieldValidation} from './fields.js';

export type BulkFieldItem={id:string;leadVersion:number;definitionVersion:number;bindingVersion:number;valueVersion?:number};
export type BulkFieldInput={requestId:string;confirmed:true;fieldId:string;operation:'SET'|'ADD_TAGS'|'REMOVE_TAGS';value:postgres.JSONValue;items:BulkFieldItem[]};
export function bulkFieldHash(input:BulkFieldInput){return bulkHash({fieldId:input.fieldId,operation:input.operation,value:input.value,items:input.items});}
export function bulkFieldValue(operation:BulkFieldInput['operation'],type:string,current:unknown,value:unknown):unknown {
 if(operation==='SET')return value;
 if(type!=='TAGS')throw new HttpError(400,'BULK_TAG_FIELD_REQUIRED');
 const tags=validateFieldValue('TAGS',value,[],{}) as string[]|null;
 if(!tags)throw new HttpError(400,'BULK_TAGS_REQUIRED');
 if(current!==null&&current!==undefined&&(!Array.isArray(current)||current.some(v=>typeof v!=='string')))throw new HttpError(409,'BULK_CURRENT_VALUE_INVALID');
 const old=(current??[]) as string[];
 return operation==='ADD_TAGS'?[...new Set([...old,...tags])]:old.filter(v=>!tags.includes(v));
}
export async function executeBulkFields(db:Database,actor:Principal,request:FastifyRequest,input:BulkFieldInput){
 const deadline=bulkDeadline('BULK_FIELD_REQUEST_BUDGET_MS');
 const hash=bulkFieldHash(input);
 const batch=await db.begin(async tx=>{
  const session=await bulkSession(tx,actor,request);
  // Serialize envelope creation without keeping a transaction open over the whole batch.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id+':'+input.requestId},0))`;
  let row=(await tx`SELECT * FROM bulk_field_batch WHERE actor_id=${actor.id} AND request_key=${input.requestId}`)[0];
  if(!row){row=(await tx`INSERT INTO bulk_field_batch(organization_id,actor_id,actor_role,branch_scope,session_id,request_key,request_hash,field_id,operation,item_count)
   VALUES(${actor.organizationId},${actor.id},${actor.role},${actor.branchId},${session},${input.requestId},${hash},${input.fieldId},${input.operation},${input.items.length}) RETURNING *`)[0]!;
   await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(${actor.organizationId},${actor.branchId},${actor.id},'BULK_FIELD_REQUESTED','BULK_FIELD_BATCH',${row.id},${tx.json({fieldId:input.fieldId,operation:input.operation,count:input.items.length})})`;
  }
  if(!Buffer.from(row.request_hash).equals(hash))throw new HttpError(409,'BULK_REQUEST_CONFLICT');
  if(row.organization_id!==actor.organizationId||row.actor_role!==actor.role||row.branch_scope!==actor.branchId)throw new HttpError(403,'BULK_CONTEXT_CHANGED');
  return row;
 });
 const results:{id:string;status:'UPDATED'|'REPLAYED'|'FAILED';version?:number;error?:string}[]=[];
 for(const item of input.items){
  if(Date.now()>=deadline){results.push({id:item.id,status:'FAILED',error:'BULK_REQUEST_PAUSED'});continue;}
  try{
   const result=await db.begin(async tx=>{
    await tx`SET LOCAL statement_timeout='8s'`;await tx`SET LOCAL lock_timeout='750ms'`;
    const lead=(await tx`SELECT l.id,l.branch_id,l.campaign_id,l.lifecycle,l.version FROM lead l WHERE l.id=${item.id} AND ${bulkScope(tx,actor)} FOR UPDATE OF l`)[0];
    if(!lead)throw new HttpError(404,'LEAD_NOT_FOUND');
    const session=await bulkSession(tx,actor,request);
    const typedLead=lead as {id:string;campaign_id:string;lifecycle:string};
    // Current visibility/edit authority precedes receipt lookup; historical success grants no access.
    const field=await writableManualField(tx,actor,typedLead,input.fieldId);
    const receipt=(await tx`SELECT result_version FROM bulk_field_receipt WHERE batch_id=${batch.id} AND lead_id=${lead.id}`)[0];
    if(receipt)return {status:'REPLAYED' as const,version:receipt.result_version as number};
    if(lead.version!==item.leadVersion)throw new HttpError(409,'LEAD_VERSION_CONFLICT');
    if(field.definition_version!==item.definitionVersion||field.binding_version!==item.bindingVersion)throw new HttpError(409,'BULK_FIELD_CONFIGURATION_CHANGED');
    const old=(await tx`SELECT value,version FROM lead_field_value WHERE lead_id=${lead.id} AND field_id=${field.id} FOR UPDATE`)[0];
    if((old?.version??undefined)!==item.valueVersion)throw new HttpError(409,'FIELD_VALUE_VERSION_CONFLICT');
    const value=bulkFieldValue(input.operation,field.field_type,old?.value,input.value);
    // Validate the resulting set (including size/options), then use the ordinary Human service.
    validateFieldValue(field.field_type as FieldType,value,field.options as FieldOption[],field.validation as FieldValidation);
    const changed=await writeManualFieldValue(tx,actor,typedLead,field.id,{value,version:item.valueVersion});
    await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
     VALUES(${actor.organizationId},${lead.branch_id},${actor.id},'BULK_FIELD_UPDATED','LEAD',${lead.id},${tx.json({batchId:batch.id,fieldId:field.id,operation:input.operation})})`;
    await tx`INSERT INTO bulk_field_receipt(batch_id,lead_id,branch_id,campaign_id,field_id,session_id,lead_version,definition_version,binding_version,result_version,history_id)
     VALUES(${batch.id},${lead.id},${lead.branch_id},${lead.campaign_id},${field.id},${session},${lead.version},${field.definition_version},${field.binding_version},${changed.version},${changed.historyId})`;
    await bulkSession(tx,actor,request);
    return {status:'UPDATED' as const,version:changed.version};
   });
   results.push({id:item.id,...result});
  }catch(error){
   results.push({id:item.id,status:'FAILED',error:bulkFailure(error)});
  }
 }
 return {requestId:input.requestId,results};
}
