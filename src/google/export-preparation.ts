import {randomUUID,randomInt} from 'node:crypto';
import type postgres from 'postgres';import type {FastifyRequest} from 'fastify';import type {Database} from '../db.js';
import {HttpError,type Principal} from '../security.js';import {bulkHash} from '../bulk-actions.js';
import {exportSession,exportActor,exportJob,exportVisible,exportCellHeader,exportCellPage,exportInput,type ExportJob} from '../exports/service.js';
import {googleExportCell} from './export-cells.js';
type Tx=postgres.TransactionSql;type Row=postgres.Row;
export type GoogleExportIntent={resourceId:string;resourceVersion:number;connectionVersion:number;requestId:string;reason:string;confirmed:true};
export function googleExportReceipt(j:Row){return {id:j.id,sourceExportId:j.source_export_id,state:j.state,version:j.version,preparedRows:j.prepared_rows,expectedRows:j.expected_rows,
 payloadBytes:j.payload_bytes,errorCode:j.error_code,spreadsheetId:j.spreadsheet_id,sheetId:j.sheet_id,sheetTitle:j.sheet_title,reason:j.reason,expiresAt:j.expires_at};}
export async function ownedGoogleExport(tx:Tx,actor:Principal,id:string,lock=false){
 const j=(await tx`SELECT *,cursor_at::text cursor_text,expires_at<=clock_timestamp() expired FROM google_export_job WHERE id=${id} AND organization_id=${actor.organizationId} AND actor_id=${actor.id} ${lock?tx`FOR UPDATE`:tx``}`)[0];
 if(!j)throw new HttpError(404,'GOOGLE_EXPORT_NOT_FOUND');
 if(j.actor_role!==actor.role||j.branch_scope!==actor.branchId)throw new HttpError(403,'GOOGLE_EXPORT_CONTEXT_CHANGED');return j;
}
export async function visibleGoogleExport(tx:Tx,actor:Principal,j:Row){
 if(j.expired||['CANCELLED','EXPIRED'].includes(j.state))throw new HttpError(410,'GOOGLE_EXPORT_EXPIRED');
 const p=await exportJob(tx,actor,j.source_export_id);await exportVisible(tx,actor,p);
 if(!(await tx`SELECT google_export_allowed(j) ok FROM google_export_job j WHERE id=${j.id}`)[0]?.ok)throw new HttpError(403,'GOOGLE_EXPORT_ACCESS_CHANGED');return p;
}
async function source(tx:Tx,actor:Principal,request:FastifyRequest,id:string){
 await exportSession(tx,actor,request);const p=await exportJob(tx,actor,id,true),fields=await exportVisible(tx,actor,p);
 if(p.state!=='DONE')throw new HttpError(409,'GOOGLE_EXPORT_SOURCE_NOT_READY');if(p.row_count>10000)throw new HttpError(409,'GOOGLE_EXPORT_ROW_LIMIT');return {p,fields};
}
export async function googleExportTargets(db:Database,actor:Principal,request:FastifyRequest,sourceId:string,after:string|null){
 return db.begin(async tx=>{const {p}=await source(tx,actor,request,sourceId);
  const rows=await tx`SELECT r.id,r.version resource_version,c.version connection_version,r.metadata->>'title' title,r.spreadsheet_id
   FROM google_resource r JOIN integration_connection c ON c.id=r.connection_id WHERE r.organization_id=${actor.organizationId}
    AND (${after}::uuid IS NULL OR r.id>${after}::uuid) AND google_export_target_allowed((SELECT j FROM lead_export_job j WHERE j.id=${p.id}),r.id) ORDER BY r.id LIMIT 26`;
  await exportSession(tx,actor,request);return {items:rows.slice(0,25),nextCursor:rows.length>25?rows[24]!.id:null};
 });
}
export async function prepareGoogleExport(db:Database,actor:Principal,request:FastifyRequest,sourceId:string,input:GoogleExportIntent){
 if(input.reason.trim().length<3)throw new HttpError(400,'GOOGLE_EXPORT_REASON_REQUIRED');
 const hash=bulkHash({sourceId,resourceId:input.resourceId,resourceVersion:input.resourceVersion,connectionVersion:input.connectionVersion,reason:input.reason.trim()});
 const ttl=Number(process.env.GOOGLE_EXPORT_TTL_SECONDS??86400);if(!Number.isInteger(ttl)||ttl<5||ttl>86400)throw Error('Invalid Google export retention');
 return db.begin(async tx=>{
  // Sharing/configuration use Connection first; recheck the real session after waiting for it.
  const found=(await tx`SELECT connection_id FROM google_resource WHERE id=${input.resourceId} AND organization_id=${actor.organizationId}`)[0];if(!found)throw new HttpError(404,'GOOGLE_RESOURCE_UNAVAILABLE');
  await tx`SELECT id FROM integration_connection WHERE id=${found.connection_id} FOR UPDATE`;const session=await exportSession(tx,actor,request);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id+':google-export:'+input.requestId},0))`;
  const old=(await tx`SELECT *,expires_at<=clock_timestamp() expired FROM google_export_job WHERE actor_id=${actor.id} AND request_id=${input.requestId}`)[0];
  if(old){if(!Buffer.from(old.request_hash).equals(hash))throw new HttpError(409,'GOOGLE_EXPORT_INTENT_CONFLICT');await visibleGoogleExport(tx,actor,old);return googleExportReceipt(old);}
  const {p,fields}=await source(tx,actor,request,sourceId),r=(await tx`SELECT r.*,c.version current_connection_version FROM google_resource r JOIN integration_connection c ON c.id=r.connection_id WHERE r.id=${input.resourceId} FOR SHARE OF r`)[0]!;
  if(r.version!==input.resourceVersion||r.current_connection_version!==input.connectionVersion||!(await tx`SELECT google_export_target_allowed(j,${r.id}) ok FROM lead_export_job j WHERE j.id=${p.id}`)[0]?.ok)throw new HttpError(409,'GOOGLE_EXPORT_TARGET_CHANGED');
  const id=randomUUID(),header=exportCellHeader(exportInput(p),fields).map(value=>googleExportCell(value)),sheetId=randomInt(1,2147483647),sheetTitle='Lead export '+id.slice(0,18);
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(${actor.organizationId},${actor.branchId},${actor.id},'GOOGLE_EXPORT_REQUESTED','GOOGLE_EXPORT',${id},${tx.json({sessionId:session,requestId:input.requestId,resourceId:r.id})})`;
  const [j]=await tx`INSERT INTO google_export_job(id,organization_id,source_export_id,actor_id,actor_role,branch_scope,approval_session_id,request_id,request_hash,resource_id,resource_version,connection_id,connection_version,spreadsheet_id,sheet_id,sheet_title,fields_snapshot,header_cells,expected_rows,payload_bytes,reason,expires_at)
   SELECT ${id},${actor.organizationId},${p.id},${actor.id},${actor.role},${actor.branchId},${session},${input.requestId},${hash},${r.id},${input.resourceVersion},${r.connection_id},${input.connectionVersion},${r.spreadsheet_id},${sheetId},${sheetTitle},${tx.json(fields as unknown as postgres.JSONValue)},${tx.json(header)},${p.row_count},4096+google_export_cell_bytes(${tx.json(header)}::jsonb),${input.reason.trim()},LEAST(s.expires_at,statement_timestamp()+${ttl}*interval '1 second') FROM lead_export_job s WHERE s.id=${p.id} RETURNING *`;
  await exportSession(tx,actor,request);return googleExportReceipt(j!);
 });
}
async function transition(tx:Tx,j:Row,state:string,error:string|null,patch:{count?:number;bytes?:number;cursorAt?:string|null;cursorId?:string|null;failures?:number;delay?:number}={}){
 return (await tx`UPDATE google_export_job SET state=${state},error_code=${error},version=version+1,prepared_rows=${patch.count??j.prepared_rows},payload_bytes=${patch.bytes??j.payload_bytes},
  cursor_at=${patch.cursorAt===undefined?j.cursor_text:patch.cursorAt}::text::timestamptz,cursor_id=${patch.cursorId===undefined?j.cursor_id:patch.cursorId},failures=${patch.failures??j.failures},
  next_run_at=clock_timestamp()+${patch.delay??0}*interval '1 millisecond' WHERE id=${j.id} AND version=${j.version} RETURNING *,cursor_at::text cursor_text`)[0]!;
}
export async function processOneGoogleExportPreparation(db:Database,options:{retryDelayMs?:number}={}):Promise<boolean>{
 return db.begin(async tx=>{
  await tx`SET LOCAL lock_timeout='750ms'`;await tx`SET LOCAL statement_timeout='10s'`;
  const found=(await tx`SELECT id,connection_id FROM google_export_job WHERE state='WAITING' AND next_run_at<=clock_timestamp() OR expires_at<=clock_timestamp() AND state NOT IN ('CANCELLED','EXPIRED') ORDER BY expires_at<=clock_timestamp() DESC,next_run_at,id LIMIT 1`)[0];if(!found)return false;
  if(!(await tx`SELECT id FROM integration_connection WHERE id=${found.connection_id} FOR UPDATE SKIP LOCKED`).length)return false;
  const j=(await tx`SELECT *,cursor_at::text cursor_text,expires_at<=clock_timestamp() expired FROM google_export_job WHERE id=${found.id} FOR UPDATE`)[0]!;
  if(j.expired){await transition(tx,j,'EXPIRED','GOOGLE_EXPORT_EXPIRED');await tx`DELETE FROM google_export_row WHERE job_id=${j.id}`;return true;}
  if(j.state!=='WAITING')return true;
  try{await tx.savepoint(async step=>{
   const p=(await step`SELECT *,created_at::text created_text,expires_at<=clock_timestamp() expired FROM lead_export_job WHERE id=${j.source_export_id} FOR SHARE`)[0] as ExportJob,actor=await exportActor(step,p);
   await exportVisible(step,actor,p);if(!(await step`SELECT google_export_allowed(j) ok FROM google_export_job j WHERE id=${j.id}`)[0]?.ok)throw new HttpError(403,'GOOGLE_EXPORT_ACCESS_CHANGED');
   const page=await exportCellPage(step,actor,p,j.cursor_id?{id:j.cursor_id,at:j.cursor_text}:null,j.fields_snapshot);
   if(!page.count&&j.prepared_rows!==j.expected_rows)throw new HttpError(409,'GOOGLE_EXPORT_SOURCE_CHANGED');
   const ids=page.count?(await step`SELECT lead_id,branch_id,campaign_id FROM lead_export_member WHERE job_id=${p.id} AND (${j.cursor_text}::text::timestamptz IS NULL OR ${p.filters.sort==='CREATED_ASC'} AND (lead_created_at,lead_id)>(${j.cursor_text}::text::timestamptz,${j.cursor_id}::uuid) OR ${p.filters.sort!=='CREATED_ASC'} AND (lead_created_at,lead_id)<(${j.cursor_text}::text::timestamptz,${j.cursor_id}::uuid)) ORDER BY lead_created_at ${step.unsafe(p.filters.sort==='CREATED_ASC'?'ASC':'DESC')},lead_id ${step.unsafe(p.filters.sort==='CREATED_ASC'?'ASC':'DESC')} LIMIT ${page.count}`):[];
   const rows=page.cells.map((cells,index)=>({row_number:j.prepared_rows+index+1,lead_id:ids[index]!.lead_id,branch_id:ids[index]!.branch_id,campaign_id:ids[index]!.campaign_id,cells:cells.map(value=>googleExportCell(value)??'')}));
   const inserted=rows.length?await step`INSERT INTO google_export_row(job_id,row_number,lead_id,branch_id,campaign_id,cells,payload_bytes,page_version)
    SELECT ${j.id},x.row_number,x.lead_id,x.branch_id,x.campaign_id,x.cells,google_export_cell_bytes(x.cells),${j.version+1} FROM jsonb_to_recordset(${step.json(rows as postgres.JSONValue[])}) x(row_number integer,lead_id uuid,branch_id uuid,campaign_id uuid,cells jsonb) RETURNING payload_bytes`:[];
   const count=j.prepared_rows+page.count,bytes=j.payload_bytes+inserted.reduce((sum,r)=>sum+r.payload_bytes,0);if(bytes>8388608)throw new HttpError(409,'GOOGLE_EXPORT_PAYLOAD_LIMIT');
   await transition(step,j,count===j.expected_rows?'READY':'WAITING',null,{count,bytes,cursorAt:page.next?.at??j.cursor_text,cursorId:page.next?.id??j.cursor_id});
  });}catch(e){const revoked=e instanceof HttpError,failures=revoked?j.failures:Math.min(j.failures+1,5);await transition(tx,j,revoked?'NEEDS_ATTENTION':failures===5?'DEAD_LETTER':'WAITING',revoked?'GOOGLE_EXPORT_ACCESS_CHANGED':'GOOGLE_EXPORT_PREPARATION_FAILED',{failures,delay:options.retryDelayMs??1000*2**failures});}
  return true;
 });
}
export async function actOnGoogleExport(db:Database,actor:Principal,request:FastifyRequest,id:string,input:{version:number;reason:string},cancel:boolean){
 if(input.reason.trim().length<3)throw new HttpError(400,'GOOGLE_EXPORT_REASON_REQUIRED');
 return db.begin(async tx=>{
  const found=(await tx`SELECT connection_id FROM google_export_job WHERE id=${id} AND actor_id=${actor.id} AND organization_id=${actor.organizationId}`)[0];if(!found)throw new HttpError(404,'GOOGLE_EXPORT_NOT_FOUND');
  await tx`SELECT id FROM integration_connection WHERE id=${found.connection_id} FOR UPDATE`;const sid=await exportSession(tx,actor,request),j=await ownedGoogleExport(tx,actor,id,true);
  if(j.expired||['CANCELLED','EXPIRED'].includes(j.state))throw new HttpError(410,'GOOGLE_EXPORT_EXPIRED');if(j.version!==input.version)throw new HttpError(409,'GOOGLE_EXPORT_VERSION_CONFLICT');
  if(!cancel){if(!['NEEDS_ATTENTION','DEAD_LETTER'].includes(j.state))throw new HttpError(409,'GOOGLE_EXPORT_NOT_RECOVERABLE');await visibleGoogleExport(tx,actor,j);}
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(${actor.organizationId},${actor.branchId},${actor.id},${cancel?'GOOGLE_EXPORT_CANCELLED':'GOOGLE_EXPORT_RECOVERED'},'GOOGLE_EXPORT',${id},${tx.json({sessionId:sid})})`;
  const [updated]=await tx`UPDATE google_export_job SET state=${cancel?'CANCELLED':'WAITING'},version=version+1,reason=${input.reason.trim()},approval_session_id=${sid},failures=0,error_code=${cancel?'GOOGLE_EXPORT_CANCELLED':null},next_run_at=clock_timestamp() WHERE id=${id} RETURNING *`;
  if(cancel)await tx`DELETE FROM google_export_row WHERE job_id=${id}`;await exportSession(tx,actor,request);return googleExportReceipt(updated!);
 });
}
