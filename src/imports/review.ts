import type postgres from 'postgres';
import type {FastifyRequest} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,type Principal} from '../security.js';
import {importFile,importAvailable,importLimits,type ImportFile} from './service.js';
import {currentImportMapping,mapImportRow,type ImportMappingEntry} from './mapping.js';

export type ReviewSelection={sheet:number;version:number};
export type ImportReview={id:string;file_id:string;revision:number;request_key:string;selection:ReviewSelection[];configuration_hash:string;
 state:string;version:number;total:number;processed:number;valid_count:number;attempt_count:number;error_code:string|null;current:boolean};
export async function reviewAudit(tx:postgres.TransactionSql,j:ImportFile,r:Pick<ImportReview,'id'|'version'>,action:string,actor:string|null,detail:Record<string,postgres.JSONValue>={}){
 await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(${j.organization_id},${j.branch_id},${actor},${action},'LEAD_IMPORT_REVIEW',${r.id},${tx.json({...detail,version:r.version})})`;
}
export function reviewFileReady(j:ImportFile){importAvailable(j);if(j.state!=='REVIEW'||j.purged_at)throw new HttpError(409,'IMPORT_PREVIEW_NOT_READY');}
export async function lockReviewFields(tx:postgres.TransactionSql,j:ImportFile){
 await tx`SELECT fd.id FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id WHERE cf.campaign_id=${j.campaign_id} ORDER BY fd.id FOR SHARE OF fd,cf`;
}
export async function importReview(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,fileId:string,id:string){
 const j=await importFile(tx,actor,request,fileId,true);reviewFileReady(j);
 await lockReviewFields(tx,j);
 const r=(await tx`SELECT r.*,lead_import_review_current(j,r) current FROM lead_import_review r JOIN lead_import_file j ON j.id=r.file_id
  WHERE r.id=${id} AND r.file_id=${j.id} FOR UPDATE OF r`)[0] as ImportReview|undefined;
 if(!r)throw new HttpError(404,'IMPORT_REVIEW_NOT_FOUND');return {j,r};
}
export function reviewReady(r:ImportReview){if(!r.current)throw new HttpError(409,'IMPORT_REVIEW_STALE');if(r.state!=='READY')throw new HttpError(409,'IMPORT_REVIEW_NOT_READY');}
export async function cancelReview(tx:postgres.TransactionSql,j:ImportFile,r:ImportReview,session:string){
 await reviewAudit(tx,j,{...r,version:r.version+1},'IMPORT_REVIEW_CANCELLED',j.actor_id,{sessionId:session});
 await tx`UPDATE lead_import_review SET state='CANCELLED',version=version+1 WHERE id=${r.id}`;
 await tx`DELETE FROM lead_import_review_row WHERE review_id=${r.id}`;
}
// Indexed identity equality across ALL selected sheets. Names do not imply an identity or a merge.
export function duplicateReviewRow(tx:postgres.TransactionSql){return tx`EXISTS(SELECT 1 FROM lead_import_review_row peer WHERE peer.review_id=rw.review_id
 AND (peer.sheet_index,peer.row_number)<>(rw.sheet_index,rw.row_number)
 AND ((rw.phone_normalized IS NOT NULL AND peer.phone_normalized=rw.phone_normalized)
  OR (rw.email_normalized IS NOT NULL AND peer.email_normalized=rw.email_normalized)))`;}
export async function reviewSummary(tx:postgres.TransactionSql,r:ImportReview){
 return (await tx`SELECT count(*) FILTER(WHERE ${duplicateReviewRow(tx)})::int duplicates,
  count(*) FILTER(WHERE d.action IS NULL)::int unreviewed,count(*) FILTER(WHERE d.action='SKIP')::int skipped,
  count(*) FILTER(WHERE d.action='KEEP_AS_NEW_LEAD')::int kept
  FROM lead_import_review_row rw LEFT JOIN LATERAL(SELECT action FROM lead_import_review_decision
   WHERE review_id=rw.review_id AND sheet_index=rw.sheet_index AND row_number=rw.row_number ORDER BY version DESC LIMIT 1) d ON true WHERE rw.review_id=${r.id}`)[0]!;
}
export async function missingImportFields(tx:postgres.TransactionSql,j:ImportFile,ids:string[]){return (await tx`SELECT EXISTS(
 SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id WHERE cf.campaign_id=${j.campaign_id} AND cf.active AND fd.active
 AND cf.required_stage='LEAD_CREATION' AND NOT(fd.id=ANY(${ids}::uuid[]))) missing`)[0]!.missing as boolean;}

// DB-only bounded work: the file/job locks and one transaction are the claim. Crashes roll back the entire chunk.
// There is no provider call, detached computation, fabricated login or committed RUNNING lease to recover.
export async function processOneImportReview(db:Database,options:{retryDelaySeconds?:number}={}):Promise<boolean>{
 const delay=options.retryDelaySeconds;if(delay!==undefined&&(!Number.isFinite(delay)||delay<0||delay>300))throw Error('Invalid Import review retry delay');
 const candidate=(await db`SELECT r.id,r.file_id,r.version,f.branch_id,f.campaign_id,f.actor_id FROM lead_import_review r JOIN lead_import_file f ON f.id=r.file_id
  WHERE r.state='VALIDATING' AND r.next_run_at<=clock_timestamp() ORDER BY r.next_run_at,r.id LIMIT 1`)[0];if(!candidate)return false;
 const lock=async(tx:postgres.TransactionSql)=>{
  await importLimits(tx);await tx`SELECT id FROM branch WHERE id=${candidate.branch_id} FOR SHARE`;
  await tx`SELECT id FROM campaign WHERE id=${candidate.campaign_id} FOR SHARE`;await tx`SELECT id FROM user_account WHERE id=${candidate.actor_id} FOR SHARE`;
  const j=(await tx`SELECT *,expires_at<=clock_timestamp() expired FROM lead_import_file WHERE id=${candidate.file_id} FOR UPDATE SKIP LOCKED`)[0] as ImportFile|undefined;
  if(!j)return null;
  await lockReviewFields(tx,j);
  const r=(await tx`SELECT r.*,lead_import_review_current(j,r) current FROM lead_import_review r JOIN lead_import_file j ON j.id=r.file_id WHERE r.id=${candidate.id} FOR UPDATE OF r`)[0] as ImportReview;
  if(r.state!=='VALIDATING'||r.version!==candidate.version)return null;return {j,r};
 };
 try{return await db.begin(async tx=>{
  const locked=await lock(tx);if(!locked)return false;const {j,r}=locked;
  if(!r.current){await reviewAudit(tx,j,{...r,version:r.version+1},'IMPORT_REVIEW_STALE',null);
   await tx`UPDATE lead_import_review SET state='STALE',version=version+1,error_code='IMPORT_REVIEW_STALE' WHERE id=${r.id}`;
   await tx`DELETE FROM lead_import_review_row WHERE review_id=${r.id}`;return true;}
  const rows=await tx`SELECT raw.sheet_index,raw.row_number,raw.cells FROM lead_import_row raw
   WHERE raw.file_id=${j.id} AND EXISTS(SELECT 1 FROM jsonb_array_elements(${tx.json(r.selection)}) s WHERE (s->>'sheet')::int=raw.sheet_index)
    AND NOT EXISTS(SELECT 1 FROM lead_import_review_row done WHERE done.review_id=${r.id} AND done.sheet_index=raw.sheet_index AND done.row_number=raw.row_number)
   ORDER BY raw.sheet_index,raw.row_number LIMIT 100`;
  if(!rows.length)throw Error('Import review progress mismatch');
  const mappings=new Map<number,{entries:ImportMappingEntry[];targets:NonNullable<Awaited<ReturnType<typeof currentImportMapping>>>['targets'];missing:boolean}>();
  for(const s of r.selection){if(!rows.some(raw=>raw.sheet_index===s.sheet))continue;
   const m=await currentImportMapping(tx,j,s.sheet,s.version);if(!m)throw Error('Import mapping missing');
   mappings.set(s.sheet,{entries:m.mapping.entries,targets:m.targets,missing:await missingImportFields(tx,j,m.targets.map(t=>t.id))});}
  const values=rows.map(raw=>{const m=mappings.get(raw.sheet_index)!,v=mapImportRow(raw.row_number,raw.cells,m.entries,m.targets,m.missing);
   return {review_id:r.id,file_id:j.id,sheet_index:raw.sheet_index,row_number:v.rowNumber,valid:v.valid,
    contact:v.contact?tx.json(v.contact):null,fields:tx.json(v.fields),errors:tx.json(v.errors)};});
  await reviewAudit(tx,j,{...r,version:r.version+1},'IMPORT_REVIEW_PROGRESS',null,{rows:values.length});
  await tx`INSERT INTO lead_import_review_row ${tx(values,'review_id','file_id','sheet_index','row_number','valid','contact','fields','errors')}`;
  const processed=r.processed+values.length;
  await tx`UPDATE lead_import_review SET processed=${processed},valid_count=valid_count+${values.filter(v=>v.valid).length},
   state=${processed===r.total?'READY':'VALIDATING'},version=version+1,error_code=NULL,next_run_at=clock_timestamp() WHERE id=${r.id}`;
  return true;
 });}catch{
  // A failed transaction published no rows. Fence the failure record with its pre-attempt version.
  return db.begin(async tx=>{const locked=await lock(tx);if(!locked)return false;const {j,r}=locked;
   if(!r.current){await reviewAudit(tx,j,{...r,version:r.version+1},'IMPORT_REVIEW_STALE',null);await tx`UPDATE lead_import_review SET state='STALE',version=version+1,error_code='IMPORT_REVIEW_STALE' WHERE id=${r.id}`;
    await tx`DELETE FROM lead_import_review_row WHERE review_id=${r.id}`;return true;}
   const attempt=r.attempt_count+1;await reviewAudit(tx,j,{...r,version:r.version+1},'IMPORT_REVIEW_FAILED',null);
   await tx`UPDATE lead_import_review SET state=${attempt>=5?'FAILED':'VALIDATING'},version=version+1,attempt_count=${attempt},error_code='IMPORT_REVIEW_PROCESSING_FAILED',
    next_run_at=clock_timestamp()+${delay??Math.min(300,2**attempt)}*interval '1 second' WHERE id=${r.id}`;return true;
  });
 }
}

