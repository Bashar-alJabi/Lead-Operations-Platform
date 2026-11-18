import type {FastifyRequest} from 'fastify';import type {Database} from '../db.js';import {HttpError,type Principal} from '../security.js';
import {captureJob} from './capture.js';import {importFile,importScope,importAudit} from '../imports/service.js';
export type GoogleImportInput={version:number;requestId:string;reason:string};
export async function prepareGoogleImport(db:Database,actor:Principal,request:FastifyRequest,captureId:string,p:GoogleImportInput){
 if(p.reason.trim().length<3)throw new HttpError(400,'GOOGLE_TEXT_INVALID');
 return db.begin(async tx=>{
  await tx`SET LOCAL lock_timeout='750ms'`;await tx`SET LOCAL statement_timeout='10s'`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id+':'+p.requestId},190))`;
  const prior=(await tx`SELECT id FROM lead_import_file WHERE actor_id=${actor.id} AND request_key=${p.requestId}`)[0];
  if(prior){const old=await importFile(tx,actor,request,prior.id);if(old.input_kind!=='GOOGLE_SHEETS'||old.google_capture_id!==captureId||old.google_capture_version!==p.version||old.input_reason!==p.reason.trim())throw new HttpError(409,'GOOGLE_IMPORT_REQUEST_REUSED');return {id:old.id,inputKind:old.input_kind,state:old.state,version:old.version};}
  const parent=(await tx`SELECT connection_id FROM google_capture_job WHERE id=${captureId} AND actor_id=${actor.id} AND organization_id=${actor.organizationId}`)[0];if(!parent)throw new HttpError(404,'GOOGLE_CAPTURE_NOT_FOUND');
  await tx`SELECT id FROM integration_connection WHERE id=${parent.connection_id} FOR SHARE`;
  const g=await captureJob(tx,actor,request,captureId);if(g.version!==p.version)throw new HttpError(409,'GOOGLE_CAPTURE_VERSION_CONFLICT');
  if(g.expired||g.state!=='READY')throw new HttpError(409,'GOOGLE_CAPTURE_NOT_READY');
  if(!(await tx`SELECT google_capture_allowed(j) ok FROM google_capture_job j WHERE id=${g.id}`)[0]!.ok)throw new HttpError(403,'GOOGLE_CAPTURE_ACCESS_CHANGED');
  if(g.row_count<2)throw new HttpError(400,'GOOGLE_IMPORT_NO_DATA');
  const headers=(await tx`SELECT google_import_headers(${g.id}) value`)[0]!.value as string[];
  if(headers.some(v=>v.length>256))throw new HttpError(400,'GOOGLE_IMPORT_HEADER_SIZE');
  const name=g.verified_metadata.sheetTitle as string;if(name.length>128)throw new HttpError(400,'GOOGLE_IMPORT_SHEET_NAME_SIZE');
  const session=await importScope(tx,actor,request,g.branch_id,g.campaign_id);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.organizationId+':import-upload'},0))`;
  if((await tx`SELECT 1 FROM lead_import_file WHERE google_capture_id=${g.id}`).length)throw new HttpError(409,'GOOGLE_IMPORT_ALREADY_PREPARED');
  const quota=(await tx`SELECT count(*)::int n,count(*) FILTER(WHERE actor_id=${actor.id})::int own FROM lead_import_file WHERE organization_id=${actor.organizationId} AND purged_at IS NULL`)[0]!;
  if(quota.n>=200||quota.own>=10)throw new HttpError(429,'IMPORT_PRIVATE_STORAGE_QUOTA');
  const id=(await tx`SELECT gen_random_uuid() id`)[0]!.id;
  await importAudit(tx,{id,organization_id:actor.organizationId,branch_id:g.branch_id},'IMPORT_GOOGLE_INPUT_CAPTURED',actor.id,{version:1,sessionId:session,requestId:p.requestId,captureId:g.id,captureVersion:g.version,reason:p.reason.trim()});
  await tx`INSERT INTO lead_import_file(id,organization_id,branch_id,campaign_id,actor_id,actor_role,branch_scope,uploaded_session_id,request_key,label,input_kind,
   google_capture_id,google_capture_version,google_manifest,input_reason,state,row_count,expires_at)
   VALUES(${id},${actor.organizationId},${g.branch_id},${g.campaign_id},${actor.id},${actor.role},${actor.branchId},${session},${p.requestId},${g.label},'GOOGLE_SHEETS',
    ${g.id},${g.version},google_import_manifest(${g.id}),${p.reason.trim()},'REVIEW',${g.row_count-1},(SELECT expires_at FROM google_capture_job WHERE id=${g.id}))`;
  await tx`INSERT INTO lead_import_sheet(file_id,sheet_index,name,headers,header_row,row_count) VALUES(${id},0,${name},${tx.json(headers)},1,${g.row_count-1})`;
  await tx`INSERT INTO lead_import_row(file_id,sheet_index,row_number,cells) SELECT ${id},0,row_number-${g.start_row}+1,cells FROM google_capture_row WHERE job_id=${g.id} AND row_number>${g.start_row} ORDER BY row_number`;
  return {id,inputKind:'GOOGLE_SHEETS',state:'REVIEW',version:1};
 });
}
