import type {FastifyInstance} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest} from '../security.js';
import {bulkScope,bulkSession,executeBulkFields,type BulkFieldInput} from '../bulk-fields.js';
const uuid={type:'string',format:'uuid'} as const,version={type:'integer',minimum:1} as const;
const item={type:'object',additionalProperties:false,required:['id','leadVersion','definitionVersion','bindingVersion'],properties:{
 id:uuid,leadVersion:version,definitionVersion:version,bindingVersion:version,valueVersion:version}} as const;
function distinct(ids:string[]){if(new Set(ids).size!==ids.length)throw new HttpError(400,'DUPLICATE_BULK_LEAD');}
export function registerBulkFieldRoutes(app:FastifyInstance,db:Database){
 app.post<{Body:{fieldId:string;definitionVersion:number;ids:string[]}}>('/api/leads/bulk/fields/preview',{schema:{body:{type:'object',additionalProperties:false,required:['fieldId','definitionVersion','ids'],properties:{
  fieldId:uuid,definitionVersion:version,ids:{type:'array',minItems:1,maxItems:50,items:uuid}}}}},async request=>{
  const actor=await principalFromRequest(request,db),{ids,fieldId}=request.body;distinct(ids);
  return db.begin(async tx=>{
   await bulkSession(tx,actor,request);
   // One bounded query, no per-Lead metadata fetch or hidden/existence distinction.
   const rows=await tx`SELECT l.id,l.version AS "leadVersion",fd.version AS "definitionVersion",cf.version AS "bindingVersion",fv.version AS "valueVersion"
    FROM lead l JOIN campaign ca ON ca.id=l.campaign_id AND ca.organization_id=l.organization_id AND ca.branch_id=l.branch_id
    JOIN campaign_field cf ON cf.campaign_id=ca.id AND cf.field_id=${fieldId} JOIN field_definition fd ON fd.id=cf.field_id
    LEFT JOIN lead_field_value fv ON fv.lead_id=l.id AND fv.field_id=fd.id
    WHERE l.id IN ${tx(ids)} AND ${bulkScope(tx,actor)} AND fd.organization_id=l.organization_id
     AND (fd.branch_id IS NULL OR fd.branch_id=l.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=ca.id)
     AND fd.version=${request.body.definitionVersion} AND fd.active AND cf.active AND fd.value_mode='MANUAL' AND (${actor.role==='SUPER_ADMIN'} OR (cf.show_in_details OR cf.show_in_table)
      AND (${actor.role==='MANAGER'} AND cf.visible_to_manager AND cf.editable_by_manager OR ${actor.role==='AGENT'} AND cf.visible_to_agent AND cf.editable_by_agent))`;
   await bulkSession(tx,actor,request);
   const byId=new Map(rows.map(r=>[r.id,r]));return {items:ids.map(id=>{const r=byId.get(id);return r?{...r,valueVersion:r.valueVersion??undefined,status:'ELIGIBLE'}:{id,status:'FAILED',error:'LEAD_OR_FIELD_NOT_AVAILABLE'};})};
  });
 });
 app.post<{Body:BulkFieldInput}>('/api/leads/bulk/fields',{schema:{body:{type:'object',additionalProperties:false,
  required:['requestId','confirmed','fieldId','operation','value','items'],properties:{requestId:uuid,confirmed:{const:true},fieldId:uuid,
   operation:{enum:['SET','ADD_TAGS','REMOVE_TAGS']},value:{},items:{type:'array',minItems:1,maxItems:50,items:item}}}}},async request=>{
  const actor=await principalFromRequest(request,db);distinct(request.body.items.map(i=>i.id));
  return executeBulkFields(db,actor,request,request.body);
 });
}
