import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import type {FastifyRequest} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,type Principal} from '../security.js';
import {bulkHash} from '../bulk-actions.js';
import {currentPaymentSession} from '../payments/access.js';
import {prepareLeadFilter,leadPredicate,type LeadFilter} from '../lead-query.js';
import {calculateLeadFieldsBatch} from '../calculated-fields.js';
import type {CalculationKind} from '../fields.js';
import {csvRow} from './csv.js';

export const exportColumns=['id','contact','campaign','branch','lifecycle','owner','source','created_at','followup'] as const;
export type ExportColumn=typeof exportColumns[number];
export type ExportInput={filters:LeadFilter&{sort?:'CREATED_ASC'|'CREATED_DESC'};columns:ExportColumn[];fieldIds:string[];selectedIds:string[]};
export type ExportJob={id:string;organization_id:string;actor_id:string;actor_role:Principal['role'];branch_scope:string|null;filters:ExportInput['filters'];columns:ExportColumn[];field_ids:string[];selected_ids:string[];state:string;row_count:number;version:number;failure_count:number;error_code:string|null;cursor_text:string|null;cursor_id:string|null;created_text:string;expired:boolean};
type Field={id:string;key:string;label:string;field_type:string;calculation:{kind:CalculationKind}|null;definition_version:number;binding_version:number};
export async function exportLimits(tx:postgres.TransactionSql){await tx`SET LOCAL statement_timeout='8s'`;await tx`SET LOCAL lock_timeout='750ms'`;}
export async function exportSession(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest){
 await exportLimits(tx);const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'EXPORT_ACCESS_REVOKED');return session;
}
export async function exportActor(tx:postgres.TransactionSql,j:ExportJob):Promise<Principal>{
 const u=(await tx`SELECT id,organization_id,branch_id,role,name,email FROM user_account WHERE id=${j.actor_id} AND organization_id=${j.organization_id}
  AND active AND role=${j.actor_role} AND branch_id IS NOT DISTINCT FROM ${j.branch_scope}::uuid FOR SHARE`)[0];
 if(!u)throw new HttpError(403,'EXPORT_AUTHORITY_REVOKED');
 return {id:u.id,organizationId:u.organization_id,branchId:u.branch_id,role:u.role,name:u.name,email:u.email};
}
export function exportInput(j:ExportJob):ExportInput{return {filters:j.filters,columns:j.columns,fieldIds:j.field_ids,selectedIds:j.selected_ids};}
export function validateExportInput(input:ExportInput){
 if(!input.columns.length&&!input.fieldIds.length)throw new HttpError(400,'EXPORT_COLUMNS_REQUIRED');
 if(input.fieldIds.length&&!input.filters.campaignId)throw new HttpError(400,'EXPORT_FIELDS_REQUIRE_CAMPAIGN');
}
// Aliases fd/cf/c are shared by metadata and the actual read boundary.
export function exportFieldScope(tx:postgres.TransactionSql,actor:Principal,campaignId:string|null){
 return tx`c.id=${campaignId} AND c.organization_id=${actor.organizationId} AND fd.organization_id=c.organization_id
  AND (fd.branch_id IS NULL OR fd.branch_id=c.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=c.id) AND cf.active AND fd.active
  AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId} AND (${actor.role==='MANAGER'} OR ${actor.role==='AGENT'}
   AND EXISTS(SELECT 1 FROM lead l WHERE l.campaign_id=c.id AND l.branch_id=c.branch_id AND l.assigned_agent_id=${actor.id})))
  AND (${actor.role==='SUPER_ADMIN'} OR ${actor.role==='MANAGER'} AND cf.visible_to_manager OR ${actor.role==='AGENT'} AND cf.visible_to_agent)`;
}
// Read permissions, not editability. Metadata and values use the same current boundary.
export async function exportFields(tx:postgres.TransactionSql,actor:Principal,input:ExportInput):Promise<Field[]>{
 validateExportInput(input);const ids=[...new Set([...input.fieldIds,...(input.filters.fieldId?[input.filters.fieldId]:[])])];if(!ids.length)return [];
 const rows=await tx`SELECT fd.id,fd.key,fd.label,fd.field_type,fd.calculation,fd.version AS definition_version,cf.version AS binding_version
  FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id JOIN campaign c ON c.id=cf.campaign_id
  WHERE fd.id IN ${tx(ids)} AND ${exportFieldScope(tx,actor,input.filters.campaignId??null)}
   AND (${actor.role==='SUPER_ADMIN'} OR NOT fd.id=ANY(${tx.array(input.fieldIds)}::uuid[]) OR cf.show_in_details OR cf.show_in_table)
   AND (${input.filters.fieldId??null}::uuid IS NULL OR fd.id<>${input.filters.fieldId??null}::uuid OR cf.filterable)
  FOR SHARE OF fd,cf`;
 if(rows.length!==ids.length)throw new HttpError(404,'EXPORT_FIELDS_NOT_AVAILABLE');
 const byId=new Map(rows.map(r=>[r.id,r]));return input.fieldIds.map(id=>byId.get(id) as Field);
}
export async function exportJob(tx:postgres.TransactionSql,actor:Principal,id:string,lock=false):Promise<ExportJob>{
 const j=(await tx`SELECT *,cursor_at::text AS cursor_text,created_at::text AS created_text,expires_at<=clock_timestamp() AS expired FROM lead_export_job
  WHERE id=${id} AND actor_id=${actor.id} AND organization_id=${actor.organizationId} ${lock?tx`FOR UPDATE`:tx``}`)[0] as ExportJob|undefined;
 if(!j)throw new HttpError(404,'EXPORT_NOT_FOUND');
 if(j.actor_role!==actor.role||j.branch_scope!==actor.branchId)throw new HttpError(403,'EXPORT_CONTEXT_CHANGED');return j;
}
export async function exportVisible(tx:postgres.TransactionSql,actor:Principal,j:ExportJob){
 if(j.expired||['EXPIRED','CANCELLED'].includes(j.state))throw new HttpError(410,'EXPORT_UNAVAILABLE');
 const fields=await exportFields(tx,actor,exportInput(j));await prepareLeadFilter(tx,actor,j.filters);
 if(!(await tx`SELECT lead_export_manifest_visible(j) AS ok FROM lead_export_job j WHERE id=${j.id}`)[0]?.ok)throw new HttpError(403,'EXPORT_SCOPE_CHANGED');
 return fields;
}
export async function exportAudit(tx:postgres.TransactionSql,j:Pick<ExportJob,'id'|'organization_id'|'branch_scope'>,action:string,actor:string|null,detail:postgres.JSONValue={}){
 await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(${j.organization_id},${j.branch_scope},${actor},${action},'LEAD_EXPORT',${j.id},${tx.json(detail)})`;
}
export async function transitionExport(tx:postgres.TransactionSql,j:ExportJob,p:{state:string;count?:number;cursorAt?:string|null;cursorId?:string|null;failures?:number;error?:string|null;delayMs?:number}){
 const count=p.count??j.row_count,version=j.version+1;
 await exportAudit(tx,j,'LEAD_EXPORT_STATE_CHANGED',null,{version,state:p.state,count});
 return (await tx`UPDATE lead_export_job SET state=${p.state},row_count=${count},cursor_at=${p.cursorAt===undefined?j.cursor_text:p.cursorAt}::text::timestamptz,
  cursor_id=${p.cursorId===undefined?j.cursor_id:p.cursorId},failure_count=${p.failures??j.failure_count},error_code=${p.error??null},version=${version},
  next_run_at=clock_timestamp()+${p.delayMs??0}*interval '1 millisecond' WHERE id=${j.id} AND version=${j.version}
  RETURNING *,cursor_at::text AS cursor_text,created_at::text AS created_text,expires_at<=clock_timestamp() AS expired`)[0] as ExportJob;
}
export async function previewExport(tx:postgres.TransactionSql,actor:Principal,input:ExportInput){
 validateExportInput(input);const prepared=await prepareLeadFilter(tx,actor,input.filters);const fields=await exportFields(tx,actor,input);
 const rows=await tx`SELECT l.id FROM lead l LEFT JOIN contact c ON c.id=l.contact_id WHERE ${leadPredicate(tx,actor,input.filters,prepared)}
  AND (${input.selectedIds.length===0} OR l.id=ANY(${tx.array(input.selectedIds)}::uuid[])) LIMIT 1001`;
 return {count:Math.min(rows.length,1000),more:rows.length>1000,fields};
}
export async function createExport(db:Database,actor:Principal,request:FastifyRequest,input:ExportInput&{requestId:string;confirmed:true}){
 validateExportInput(input);const hash=bulkHash({filters:input.filters,columns:input.columns,fieldIds:input.fieldIds,selectedIds:input.selectedIds});
 return db.begin(async tx=>{
  const session=await exportSession(tx,actor,request);await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id+':export:'+input.requestId},0))`;
  const old=(await tx`SELECT id,request_hash FROM lead_export_job WHERE actor_id=${actor.id} AND request_key=${input.requestId}`)[0];
  if(old){if(!Buffer.from(old.request_hash).equals(hash))throw new HttpError(409,'EXPORT_REQUEST_CONFLICT');const j=await exportJob(tx,actor,old.id);await exportVisible(tx,actor,j);return {id:j.id};}
  await previewExport(tx,actor,input);
  const retention=Number(process.env.EXPORT_RETENTION_SECONDS??86400);if(!Number.isInteger(retention)||retention<1||retention>604800)throw Error('Invalid EXPORT_RETENTION_SECONDS');
  const id=randomUUID();await exportAudit(tx,{id,organization_id:actor.organizationId,branch_scope:actor.branchId},'LEAD_EXPORT_REQUESTED',actor.id,{sessionId:session,columns:input.columns,fieldCount:input.fieldIds.length,selectedCount:input.selectedIds.length});
  await tx`WITH stamp AS (SELECT clock_timestamp() AS at) INSERT INTO lead_export_job(id,organization_id,actor_id,actor_role,branch_scope,approved_session_id,request_key,request_hash,filters,columns,field_ids,selected_ids,created_at,expires_at)
   SELECT ${id},${actor.organizationId},${actor.id},${actor.role},${actor.branchId},${session},${input.requestId},${hash},${tx.json(input.filters)},${tx.json(input.columns)},${tx.array(input.fieldIds)}::uuid[],${tx.array(input.selectedIds)}::uuid[],at,at+${retention}*interval '1 second' FROM stamp`;
  await exportSession(tx,actor,request);return {id};
 });
}
export async function processOneExport(db:Database):Promise<boolean>{
 return db.begin(async tx=>{
  await exportLimits(tx);
  const j=(await tx`SELECT *,cursor_at::text AS cursor_text,created_at::text AS created_text,expires_at<=clock_timestamp() AS expired FROM lead_export_job
   WHERE state NOT IN ('EXPIRED','CANCELLED') AND (expires_at<=clock_timestamp() OR state='WAITING' AND next_run_at<=clock_timestamp())
   ORDER BY expires_at<=clock_timestamp() DESC,next_run_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)[0] as ExportJob|undefined;
  if(!j)return false;
  if(j.expired){await transitionExport(tx,j,{state:'EXPIRED'});await tx`DELETE FROM lead_export_member WHERE job_id=${j.id}`;return true;}
  try{await tx.savepoint(async step=>{
   const actor=await exportActor(step,j);await exportFields(step,actor,exportInput(j));const prepared=await prepareLeadFilter(step,actor,j.filters),asc=j.filters.sort==='CREATED_ASC';
   const rows=await step`SELECT l.id,l.branch_id,l.campaign_id,l.created_at::text AS created_text FROM lead l LEFT JOIN contact c ON c.id=l.contact_id
    WHERE ${leadPredicate(step,actor,j.filters,prepared)} AND l.created_at<=${j.created_text}::text::timestamptz
     AND (${j.selected_ids.length===0} OR l.id=ANY(${step.array(j.selected_ids)}::uuid[]))
     AND (${j.cursor_text}::text::timestamptz IS NULL OR ${asc} AND (l.created_at,l.id)>(${j.cursor_text}::text::timestamptz,${j.cursor_id}::uuid)
      OR NOT ${asc} AND (l.created_at,l.id)<(${j.cursor_text}::text::timestamptz,${j.cursor_id}::uuid))
    ORDER BY l.created_at ${step.unsafe(asc?'ASC':'DESC')},l.id ${step.unsafe(asc?'ASC':'DESC')} LIMIT 100 FOR SHARE OF l`;
   const max=Number(process.env.EXPORT_MAX_ROWS??100000);if(!Number.isInteger(max)||max<100||max>1000000)throw Error('Invalid EXPORT_MAX_ROWS');
   if(j.row_count+rows.length>max){await transitionExport(step,j,{state:'DEAD_LETTER',error:'EXPORT_ROW_LIMIT'});return;}
   if(rows.length)await step`INSERT INTO lead_export_member(job_id,lead_id,branch_id,campaign_id,lead_created_at,page_version)
    SELECT ${j.id},x.id,x.branch_id,x.campaign_id,x.created_text::timestamptz,${j.version+1} FROM jsonb_to_recordset(${step.json(rows as unknown as postgres.JSONValue)}) AS x(id uuid,branch_id uuid,campaign_id uuid,created_text text)`;
   const last=rows.at(-1);await transitionExport(step,j,{state:rows.length<100?'DONE':'WAITING',count:j.row_count+rows.length,cursorAt:last?.created_text??j.cursor_text,cursorId:last?.id??j.cursor_id});
  });}catch(error){
   const revoked=error instanceof HttpError||error instanceof Error&&/EXPORT_(SCOPE|AUTHORITY)/.test(error.message),failures=revoked?j.failure_count:Math.min(j.failure_count+1,5);
   await transitionExport(tx,j,{state:revoked?'REVOKED':failures>=5?'DEAD_LETTER':'WAITING',failures,error:revoked?'EXPORT_ACCESS_CHANGED':'EXPORT_PROCESSING_FAILED',delayMs:revoked?0:1000*2**(failures-1)});
  }
  return true;
 });
}

const headers:Record<ExportColumn,string[]>={id:['Lead ID'],contact:['Contact name','Phone','Email'],campaign:['Campaign'],branch:['Branch'],lifecycle:['Lifecycle'],owner:['Owner'],source:['Source'],created_at:['Created at (UTC)'],followup:['Next follow-up (UTC)']};
export function exportHeader(input:ExportInput,fields:Field[]){return csvRow([...input.columns.flatMap(c=>headers[c]),...fields.map(f=>f.label+' ('+f.key+')')]);}
export type ExportCursor={at:string;id:string}|null;
export async function exportPage(tx:postgres.TransactionSql,actor:Principal,j:ExportJob,after:ExportCursor,fieldSnapshot:Field[]){
 const size=Number(process.env.EXPORT_DOWNLOAD_PAGE_SIZE??25);if(!Number.isInteger(size)||size<1||size>100)throw Error('Invalid EXPORT_DOWNLOAD_PAGE_SIZE');
 const fields=await exportFields(tx,actor,exportInput(j));if(!bulkHash(fields).equals(bulkHash(fieldSnapshot)))throw new HttpError(409,'EXPORT_FIELDS_CHANGED');
 const asc=j.filters.sort==='CREATED_ASC';
 const members=await tx`SELECT lead_id,branch_id,campaign_id,lead_created_at::text AS cursor_at FROM lead_export_member WHERE job_id=${j.id}
  AND (${after?.at??null}::text::timestamptz IS NULL OR ${asc} AND (lead_created_at,lead_id)>(${after?.at??null}::text::timestamptz,${after?.id??null}::uuid)
   OR NOT ${asc} AND (lead_created_at,lead_id)<(${after?.at??null}::text::timestamptz,${after?.id??null}::uuid))
  ORDER BY lead_created_at ${tx.unsafe(asc?'ASC':'DESC')},lead_id ${tx.unsafe(asc?'ASC':'DESC')} LIMIT ${size}`;
 if(!members.length)return {csv:'',count:0,next:null};
 const ids=members.map(m=>m.lead_id as string);
 // Lock only the bounded current page, then revalidate the real downloading session.
 const rows=await tx`SELECT l.id,l.branch_id,l.campaign_id,l.lifecycle,l.source_kind,to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  c.name,c.phone,c.email,ca.name AS campaign,b.name AS branch,u.name AS owner,
  (SELECT to_char(min(f.due_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM follow_up f WHERE f.lead_id=l.id AND f.status='OPEN') AS followup,
  (SELECT jsonb_object_agg(fv.field_id,CASE WHEN jsonb_typeof(fv.value)='string' THEN fv.value#>>'{}' WHEN fv.value='null'::jsonb THEN NULL ELSE fv.value::text END)
   FROM lead_field_value fv WHERE fv.lead_id=l.id AND fv.field_id=ANY(${tx.array(j.field_ids)}::uuid[])) AS values
  FROM lead l LEFT JOIN contact c ON c.id=l.contact_id JOIN campaign ca ON ca.id=l.campaign_id JOIN branch b ON b.id=l.branch_id LEFT JOIN user_account u ON u.id=l.assigned_agent_id
  JOIN lead_export_job j ON j.id=${j.id} WHERE l.id IN ${tx(ids)} AND lead_export_lead_visible(j,l) FOR SHARE OF l`;
 const byId=new Map(rows.map(r=>[r.id,r]));
 if(members.some(m=>!byId.has(m.lead_id)||byId.get(m.lead_id)!.branch_id!==m.branch_id||byId.get(m.lead_id)!.campaign_id!==m.campaign_id))throw new HttpError(403,'EXPORT_SCOPE_CHANGED');
 const kinds=[...new Set(fields.flatMap(f=>f.calculation?[f.calculation.kind]:[]))],calculated=await calculateLeadFieldsBatch(tx,ids,kinds);
 const csv=ids.map(id=>{const r=byId.get(id)!;const base=j.columns.flatMap(c=>c==='contact'?[r.name,r.phone,r.email]:[c==='id'?id:c==='source'?r.source_kind:r[c]]);
  return csvRow([...base,...fields.map(f=>f.calculation?calculated[id]?.[f.calculation.kind]:r.values?.[f.id]??null)]);}).join('');
 const last=members.at(-1)!;return {csv,count:members.length,next:{at:last.cursor_at as string,id:last.lead_id as string}};
}
