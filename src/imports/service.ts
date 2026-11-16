import {createHash,randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import type {FastifyRequest} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,requireRole,requireBranch,type Principal} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {configuredMediaStorage,type MediaStorage} from '../media/storage.js';
import {configuredMediaScanner,type MediaScanner} from '../media/scanner.js';
import {MediaError} from '../media/validation.js';
import {validateImportSignature} from './signature.js';
import {parseImportIsolated} from './parse-isolated.js';
import {ImportParseError,importMaxBytes,type ImportFormat,type ParsedImport} from './types.js';

export type ImportFile={id:string;organization_id:string;branch_id:string;campaign_id:string;actor_id:string;actor_role:Principal['role'];branch_scope:string|null;
 label:string;format:ImportFormat;delimiter:','|';'|'\t';content_sha256:string;size_bytes:number;storage_key:string;storage_backend:string;state:string;
 version:number;attempt_count:number;lease_token:string|null;purged_at:Date|null;expired:boolean;live_lease:boolean;row_count:number;cleanup_attempt_count:number};
export async function importLimits(tx:postgres.TransactionSql){await tx`SET LOCAL statement_timeout='10s'`;await tx`SET LOCAL lock_timeout='750ms'`;}
export async function importScope(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,branchId:string,campaignId:string){
 requireRole(actor,'SUPER_ADMIN','MANAGER');requireBranch(actor,branchId);await importLimits(tx);
 const b=(await tx`SELECT id FROM branch WHERE id=${branchId} AND organization_id=${actor.organizationId} AND active FOR SHARE`)[0];
 const c=(await tx`SELECT id FROM campaign WHERE id=${campaignId} AND organization_id=${actor.organizationId} AND branch_id=${branchId} FOR SHARE`)[0];
 if(!b||!c)throw new HttpError(404,'IMPORT_SCOPE_NOT_AVAILABLE');
 const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'IMPORT_ACCESS_REVOKED');return session;
}
export async function importFile(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,id:string,lock=false){
 const initial=(await tx`SELECT branch_id,campaign_id FROM lead_import_file WHERE id=${id} AND actor_id=${actor.id} AND organization_id=${actor.organizationId}`)[0];
 if(!initial)throw new HttpError(404,'IMPORT_FILE_NOT_FOUND');await importScope(tx,actor,request,initial.branch_id,initial.campaign_id);
 const j=(await tx`SELECT *,expires_at<=clock_timestamp() AS expired,lease_until>clock_timestamp() AS live_lease FROM lead_import_file
  WHERE id=${id} ${lock?tx`FOR UPDATE`:tx``}`)[0] as ImportFile;
 if(j.actor_role!==actor.role||j.branch_scope!==actor.branchId)throw new HttpError(403,'IMPORT_CONTEXT_CHANGED');return j;
}
export function importAvailable(j:ImportFile){if(j.expired||['EXPIRED','CANCELLED'].includes(j.state))throw new HttpError(410,'IMPORT_FILE_UNAVAILABLE');}
export async function importAudit(tx:postgres.TransactionSql,j:Pick<ImportFile,'id'|'organization_id'|'branch_id'>,action:string,actor:string|null,detail:postgres.JSONValue){
 await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(${j.organization_id},${j.branch_id},${actor},${action},'LEAD_IMPORT_FILE',${j.id},${tx.json(detail)})`;
}
type Change={state:string;attempt?:number;token?:string|null;leaseSeconds?:number;error?:string|null;scanner?:string|null;rows?:number;delay?:number};
export async function changeImport(tx:postgres.TransactionSql,j:ImportFile,p:Change){
 await importAudit(tx,j,'IMPORT_FILE_STATE',null,{version:j.version+1,state:p.state,leaseToken:j.lease_token});
 return (await tx`UPDATE lead_import_file SET state=${p.state},version=version+1,attempt_count=${p.attempt??j.attempt_count},
  lease_token=${p.token??null},lease_until=CASE WHEN ${p.token??null}::uuid IS NULL THEN NULL ELSE clock_timestamp()+${p.leaseSeconds??240}*interval '1 second' END,
  error_code=${p.error??null},next_run_at=clock_timestamp()+${p.delay??0}*interval '1 second',
  scanner_version=COALESCE(${p.scanner??null},scanner_version),scanned_at=CASE WHEN ${p.scanner??null}::text IS NULL THEN scanned_at ELSE clock_timestamp() END,
  row_count=${p.rows??j.row_count} WHERE id=${j.id} RETURNING *,expires_at<=clock_timestamp() AS expired,lease_until>clock_timestamp() AS live_lease`)[0] as ImportFile;
}
export type UploadInput={branchId:string;campaignId:string;label:string;format:ImportFormat;delimiter:','|';'|'\t';requestId:string};
export async function uploadImport(db:Database,actor:Principal,request:FastifyRequest,bytes:Buffer,input:UploadInput,storageOption?:MediaStorage){
 const hash=createHash('sha256').update(bytes).digest('hex');const compare=(j:ImportFile)=>{
  if(j.content_sha256!==hash||j.label!==input.label.trim()||j.format!==input.format||j.delimiter!==input.delimiter||j.branch_id!==input.branchId||j.campaign_id!==input.campaignId)
   throw new HttpError(409,'IMPORT_REQUEST_CONFLICT');importAvailable(j);return {id:j.id,state:j.state,version:j.version};
 };
 const old=await db.begin(async tx=>{await importScope(tx,actor,request,input.branchId,input.campaignId);
  const row=(await tx`SELECT id FROM lead_import_file WHERE actor_id=${actor.id} AND request_key=${input.requestId}`)[0];
  return row?compare(await importFile(tx,actor,request,row.id)):null;});if(old)return old;
 if(!input.label.trim()||!input.label.toLowerCase().endsWith('.'+input.format.toLowerCase()))throw new HttpError(400,'IMPORT_FILE_EXTENSION');
 try{validateImportSignature(bytes,input.format);}catch(e){throw new HttpError(400,e instanceof ImportParseError?e.code:'IMPORT_FILE_INVALID');}
 const id=randomUUID(),key=id+'-'+hash;let storage:MediaStorage;
 try{storage=storageOption??configuredMediaStorage();await storage.put(key,bytes);}catch{throw new HttpError(503,'IMPORT_STORAGE_UNAVAILABLE');}
 let result;try{result=await db.begin(async tx=>{
  const session=await importScope(tx,actor,request,input.branchId,input.campaignId);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.organizationId+':import-upload'},0))`;
  const previous=(await tx`SELECT id FROM lead_import_file WHERE actor_id=${actor.id} AND request_key=${input.requestId}`)[0];
  if(previous)return {value:compare(await importFile(tx,actor,request,previous.id)),created:false};
  const quota=(await tx`SELECT count(*)::int n,count(*) FILTER(WHERE actor_id=${actor.id})::int own FROM lead_import_file WHERE organization_id=${actor.organizationId} AND purged_at IS NULL`)[0]!;
  if(quota.n>=200||quota.own>=10)throw new HttpError(429,'IMPORT_PRIVATE_STORAGE_QUOTA');
  const retention=Number(process.env.IMPORT_RETENTION_SECONDS??86400);if(!Number.isInteger(retention)||retention<1||retention>604800)throw Error('Invalid IMPORT_RETENTION_SECONDS');
  await importAudit(tx,{id,organization_id:actor.organizationId,branch_id:input.branchId},'IMPORT_FILE_UPLOADED',actor.id,{version:1,sessionId:session,format:input.format,size:bytes.length});
  const j=(await tx`WITH stamp AS(SELECT clock_timestamp() at) INSERT INTO lead_import_file(id,organization_id,branch_id,campaign_id,actor_id,actor_role,branch_scope,uploaded_session_id,request_key,
   label,format,delimiter,content_sha256,size_bytes,storage_key,storage_backend,created_at,expires_at)
   SELECT ${id},${actor.organizationId},${input.branchId},${input.campaignId},${actor.id},${actor.role},${actor.branchId},${session},${input.requestId},
    ${input.label.trim()},${input.format},${input.delimiter},${hash},${bytes.length},${key},${storage.backend},at,at+${retention}*interval '1 second' FROM stamp
    RETURNING *,false AS expired`)[0] as ImportFile;
  return {value:compare(j),created:true};
 });}catch(e){
  // Unknown DB commit outcome retains an orphan for reconciliation; never delete a possibly committed file.
  if(e instanceof HttpError&&!(await db`SELECT 1 FROM lead_import_file WHERE storage_key=${key}`).length)await storage.remove(key).catch(()=>{});throw e;
 }
 if(!result.created)await storage.remove(key).catch(()=>{});return result.value;
}
async function purgeRows(tx:postgres.TransactionSql,id:string){await tx`DELETE FROM lead_import_row WHERE file_id=${id}`;await tx`DELETE FROM lead_import_sheet WHERE file_id=${id}`;}
export async function cleanupImportStorage(db:Database,storageOption?:MediaStorage){
 const j=(await db`SELECT * FROM lead_import_file WHERE state IN ('CANCELLED','EXPIRED','REJECTED','REVOKED') AND purged_at IS NULL AND cleanup_next_run_at<=clock_timestamp() ORDER BY cleanup_next_run_at,id LIMIT 1`)[0] as ImportFile|undefined;
 if(!j)return false;
 try{const storage=storageOption??configuredMediaStorage();if(storage.backend!==j.storage_backend)throw Error('Import storage backend unavailable');await storage.remove(j.storage_key);}
 catch{
  await db.begin(async tx=>{
   const row=(await tx`SELECT * FROM lead_import_file WHERE id=${j.id} FOR UPDATE`)[0] as ImportFile;
   if(row.purged_at||row.cleanup_attempt_count!==j.cleanup_attempt_count)return;
   const attempt=Math.min(5,row.cleanup_attempt_count+1),delay=attempt>=5?3600:5*2**attempt;
   await importAudit(tx,row,'IMPORT_FILE_PURGE_FAILED',null,{version:row.version,attempt});
   await tx`UPDATE lead_import_file SET cleanup_attempt_count=${attempt},cleanup_error_code='IMPORT_FILE_PURGE_FAILED',cleanup_next_run_at=clock_timestamp()+${delay}*interval '1 second' WHERE id=${row.id}`;
  });return false;
 }
 await db.begin(async tx=>{
  const row=(await tx`SELECT * FROM lead_import_file WHERE id=${j.id} FOR UPDATE`)[0] as ImportFile;
  if(row.purged_at)return;await importAudit(tx,row,'IMPORT_FILE_PURGED',null,{version:row.version});
  await tx`UPDATE lead_import_file SET purged_at=clock_timestamp() WHERE id=${row.id}`;
 });return true;
}
export async function processOneImportFile(db:Database,options:{storage?:MediaStorage;scanner?:MediaScanner;leaseSeconds?:number;retryDelaySeconds?:number}={}):Promise<boolean>{
 const lease=options.leaseSeconds??240,delay=options.retryDelaySeconds;
 if(!Number.isFinite(lease)||lease<0.1||lease>240||delay!==undefined&&(!Number.isFinite(delay)||delay<0||delay>300))throw Error('Invalid Import worker capacity');
 if(await cleanupImportStorage(db,options.storage))return true;
 const token=randomUUID();
 const j=await db.begin(async tx=>{
  await importLimits(tx);
  const row=(await tx`SELECT *,expires_at<=clock_timestamp() AS expired,lease_until>clock_timestamp() AS live_lease FROM lead_import_file
   WHERE (state NOT IN ('EXPIRED','CANCELLED') AND expires_at<=clock_timestamp()) OR (state='WAITING' AND next_run_at<=clock_timestamp())
    OR (state='RUNNING' AND lease_until<=clock_timestamp()) ORDER BY next_run_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)[0] as ImportFile|undefined;
  if(!row)return null;
  if(row.expired){await changeImport(tx,row,{state:'EXPIRED'});await purgeRows(tx,row.id);return {handled:true};}
  if(!(await tx`SELECT lead_import_authority(j) ok FROM lead_import_file j WHERE id=${row.id}`)[0]!.ok){await changeImport(tx,row,{state:'REVOKED',error:'IMPORT_AUTHORITY_REVOKED'});await purgeRows(tx,row.id);return {handled:true};}
  if(row.attempt_count>=5){await changeImport(tx,row,{state:'DEAD_LETTER',error:'IMPORT_RETRY_EXHAUSTED'});return {handled:true};}
  return changeImport(tx,row,{state:'RUNNING',attempt:row.attempt_count+1,token,leaseSeconds:lease});
 });
 if(!j)return false;if('handled'in j)return true;
 let parsed:ParsedImport|null=null,scanner:string|null=null,error:string|null=null,retryable=false;
 try{
  const storage=options.storage??configuredMediaStorage();if(storage.backend!==j.storage_backend)throw new MediaError('IMPORT_STORAGE_UNAVAILABLE',true);
  const bytes=await storage.get(j.storage_key,importMaxBytes);
  if(bytes.length!==j.size_bytes||createHash('sha256').update(bytes).digest('hex')!==j.content_sha256)throw new ImportParseError('IMPORT_STORAGE_INTEGRITY_FAILED');
  const scan=await(options.scanner??configuredMediaScanner()).scan(bytes);
  if(!scan.clean)throw new ImportParseError('IMPORT_CONTENT_REJECTED');
  if(!scan.version||scan.version.length>255)throw new MediaError('IMPORT_SCANNER_UNAVAILABLE',true);scanner=scan.version;
  parsed=await parseImportIsolated(bytes,j.format,j.delimiter);
 }catch(e){error=e instanceof ImportParseError?e.code:e instanceof MediaError&&/^MEDIA_SCANNER_/.test(e.code)?'IMPORT_SCANNER_UNAVAILABLE':'IMPORT_PROCESSING_UNAVAILABLE';retryable=!(e instanceof ImportParseError);}
 const complete=async(failed:boolean)=>db.begin(async tx=>{
  await importLimits(tx);
  // Lock scope and actor before the file; no original or fabricated HTTP session in background.
  await tx`SELECT id FROM branch WHERE id=${j.branch_id} FOR SHARE`;await tx`SELECT id FROM campaign WHERE id=${j.campaign_id} FOR SHARE`;
  await tx`SELECT id FROM user_account WHERE id=${j.actor_id} FOR SHARE`;
  const row=(await tx`SELECT *,expires_at<=clock_timestamp() AS expired,lease_until>clock_timestamp() AS live_lease FROM lead_import_file WHERE id=${j.id} FOR UPDATE`)[0] as ImportFile;
  if(row.state!=='RUNNING'||row.lease_token!==token||!row.live_lease)return;
  if(row.expired){await changeImport(tx,row,{state:'EXPIRED'});await purgeRows(tx,row.id);return;}
  if(!(await tx`SELECT lead_import_authority(j) ok FROM lead_import_file j WHERE id=${row.id}`)[0]!.ok){await changeImport(tx,row,{state:'REVOKED',error:'IMPORT_AUTHORITY_REVOKED'});await purgeRows(tx,row.id);return;}
  if(failed||error){const retry=failed||retryable;await changeImport(tx,row,{state:retry?(row.attempt_count<5?'WAITING':'DEAD_LETTER'):'REJECTED',
   error:failed?'IMPORT_PROCESSING_UNAVAILABLE':error,delay:delay??Math.min(300,2**row.attempt_count)});return;}
  await importAudit(tx,row,'IMPORT_FILE_PARSED',null,{version:row.version+1,leaseToken:token,rows:parsed!.rowCount});
  for(const s of parsed!.sheets){
   await tx`INSERT INTO lead_import_sheet(file_id,sheet_index,name,headers,header_row,row_count) VALUES(${row.id},${s.index},${s.name},${tx.json(s.headers)},${s.headerRow},${s.rows.length})`;
   for(let i=0;i<s.rows.length;i+=100){const rows=s.rows.slice(i,i+100).map(r=>({file_id:row.id,sheet_index:s.index,row_number:r.number,cells:tx.json(r.cells)}));
    await tx`INSERT INTO lead_import_row ${tx(rows,'file_id','sheet_index','row_number','cells')}`;}
  }
  await changeImport(tx,row,{state:'REVIEW',rows:parsed!.rowCount,scanner:scanner!});
 });
 try{await complete(false);}catch{await complete(true);}return true;
}
