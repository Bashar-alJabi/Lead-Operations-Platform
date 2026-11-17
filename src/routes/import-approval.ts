import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest} from '../security.js';
import {importFile,importScope} from '../imports/service.js';
import {importReview,reviewReady} from '../imports/review.js';

const uuid={type:'string',format:'uuid'} as const;
const params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const reviewParams={type:'object',additionalProperties:false,required:['id','reviewId'],properties:{id:uuid,reviewId:uuid}} as const;
const datasetParams={type:'object',additionalProperties:false,required:['id','datasetId'],properties:{id:uuid,datasetId:uuid}} as const;
export function registerImportApprovalRoutes(app:FastifyInstance,db:Database){
 const root='/api/lead-imports/:id';
 app.post<{Params:{id:string;reviewId:string};Body:{version:number;requestId:string;unreviewedPolicy:'KEEP_VALID_UNIQUE'}}>(root+'/reviews/:reviewId/approve-dataset',{schema:{params:reviewParams,body:{type:'object',additionalProperties:false,required:['version','requestId','unreviewedPolicy'],properties:{version:{type:'integer',minimum:1,maximum:2147483647},requestId:uuid,unreviewedPolicy:{const:'KEEP_VALID_UNIQUE'}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');reply.code(201);return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id,true),b=request.body;
   // An already committed approval can be acknowledged after quarantine expiry; this grants no new authority.
   const old=(await tx`SELECT id,review_id,review_version,unreviewed_policy,total,ready_count,skipped_count,invalid_count,duplicate_count FROM lead_import_dataset WHERE file_id=${j.id} AND request_key=${b.requestId}`)[0];
   if(old){if(old.review_id!==request.params.reviewId||old.review_version!==b.version||old.unreviewed_policy!==b.unreviewedPolicy)throw new HttpError(409,'IMPORT_DATASET_REQUEST_CONFLICT');return {datasetId:old.id,state:'SOURCE_CAPTURED'};}
   const {r}=await importReview(tx,actor,request,j.id,request.params.reviewId);reviewReady(r);if(r.version!==b.version)throw new HttpError(409,'IMPORT_REVIEW_VERSION_CONFLICT');
   if(!(await tx`SELECT 1 FROM campaign WHERE id=${j.campaign_id} AND status='ACTIVE'`).length)throw new HttpError(409,'IMPORT_CAMPAIGN_NOT_ACTIVE');
   if((await tx`SELECT 1 FROM lead_import_dataset WHERE review_id=${r.id}`).length)throw new HttpError(409,'IMPORT_DATASET_ALREADY_APPROVED');
   const overlap=(await tx`SELECT EXISTS(SELECT 1 FROM lead_import_review_row rw JOIN lead_import_dataset_row dr
    ON dr.file_id=rw.file_id AND dr.sheet_index=rw.sheet_index AND dr.row_number=rw.row_number WHERE rw.review_id=${r.id}) present`)[0]!.present;
   if(overlap)throw new HttpError(409,'IMPORT_SOURCE_ROW_ALREADY_APPROVED');
   const counts=(await tx`WITH rows AS(SELECT lead_import_review_disposition(rw.review_id,rw.sheet_index,rw.row_number) disposition,
    lead_import_review_duplicate(rw.review_id,rw.sheet_index,rw.row_number) duplicate FROM lead_import_review_row rw WHERE rw.review_id=${r.id})
    SELECT count(*)::int total,count(*) FILTER(WHERE disposition='READY_FOR_INTAKE')::int ready,count(*) FILTER(WHERE disposition='SKIPPED')::int skipped,
     count(*) FILTER(WHERE disposition='INVALID')::int invalid,count(*) FILTER(WHERE disposition IS NULL)::int unresolved,count(*) FILTER(WHERE duplicate)::int duplicates FROM rows`)[0]!;
   if(counts.unresolved)throw new HttpError(409,'IMPORT_DUPLICATE_REVIEW_REQUIRED');if(counts.total!==r.total)throw new HttpError(409,'IMPORT_REVIEW_INCOMPLETE');
   const session=await importScope(tx,actor,request,j.branch_id,j.campaign_id),id=randomUUID();
   await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(${j.organization_id},${j.branch_id},${actor.id},'IMPORT_DATASET_APPROVED','LEAD_IMPORT_DATASET',${id},
     ${tx.json({sessionId:session,requestId:b.requestId,reviewId:r.id,reviewVersion:r.version,configurationHash:r.configuration_hash,unreviewedPolicy:b.unreviewedPolicy,total:counts.total,ready:counts.ready,skipped:counts.skipped,invalid:counts.invalid,duplicates:counts.duplicates})})`;
   await tx`INSERT INTO lead_import_dataset(id,file_id,review_id,request_key,review_version,session_id,unreviewed_policy,configuration_hash,total,ready_count,skipped_count,invalid_count,duplicate_count)
    VALUES(${id},${j.id},${r.id},${b.requestId},${r.version},${session},${b.unreviewedPolicy},${r.configuration_hash},${counts.total},${counts.ready},${counts.skipped},${counts.invalid},${counts.duplicates})`;
   await tx`INSERT INTO lead_import_dataset_sheet(dataset_id,file_id,sheet_index,name,headers,header_row,row_count,mapping_version)
    SELECT ${id},s.file_id,s.sheet_index,s.name,s.headers,s.header_row,s.row_count,(sel->>'version')::int
    FROM lead_import_sheet s JOIN jsonb_array_elements(${tx.json(r.selection)}) sel ON (sel->>'sheet')::int=s.sheet_index WHERE s.file_id=${j.id}`;
   // Server-side set capture: no HTTP/JS loop over the complete file and no dependence on it after commit.
   await tx`INSERT INTO source_submission(organization_id,branch_id,campaign_id,source_kind,raw_payload,import_dataset_id,import_sheet_index,import_row_number)
    SELECT ${j.organization_id},${j.branch_id},${j.campaign_id},${j.format==='CSV'?'IMPORT_CSV':'IMPORT_EXCEL'},lead_import_source_payload(${id},rw.sheet_index,rw.row_number),${id},rw.sheet_index,rw.row_number
    FROM lead_import_review_row rw WHERE rw.review_id=${r.id} ORDER BY rw.sheet_index,rw.row_number`;
   await tx`INSERT INTO lead_import_dataset_row(dataset_id,file_id,sheet_index,row_number,submission_id,mapping_version,decision_version,disposition,duplicate,contact,fields,errors)
    SELECT ${id},rw.file_id,rw.sheet_index,rw.row_number,src.id,(sel->>'version')::int,COALESCE(d.version,0),lead_import_review_disposition(rw.review_id,rw.sheet_index,rw.row_number),
     lead_import_review_duplicate(rw.review_id,rw.sheet_index,rw.row_number),rw.contact,rw.fields,rw.errors
    FROM lead_import_review_row rw JOIN source_submission src ON src.import_dataset_id=${id} AND src.import_sheet_index=rw.sheet_index AND src.import_row_number=rw.row_number
    JOIN jsonb_array_elements(${tx.json(r.selection)}) sel ON (sel->>'sheet')::int=rw.sheet_index
    LEFT JOIN LATERAL(SELECT version FROM lead_import_review_decision WHERE review_id=rw.review_id AND sheet_index=rw.sheet_index AND row_number=rw.row_number ORDER BY version DESC LIMIT 1) d ON true
    WHERE rw.review_id=${r.id} ORDER BY rw.sheet_index,rw.row_number`;
   return {datasetId:id,state:'SOURCE_CAPTURED'};
  });
 });
 app.get<{Params:{id:string};Querystring:{after?:string}}>(root+'/approved-datasets',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{after:uuid}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id);
   const items=await tx`SELECT id,review_id,total,ready_count,skipped_count,invalid_count,duplicate_count,created_at,'SOURCE_CAPTURED' state FROM lead_import_dataset
    WHERE file_id=${j.id} AND (${request.query.after??null}::uuid IS NULL OR id>${request.query.after??null}::uuid) ORDER BY id LIMIT 26`;
   return {items:items.slice(0,25),nextId:items.length>25?items[24]!.id:null};
  });
 });
 app.get<{Params:{id:string;datasetId:string};Querystring:{afterSheet?:number;afterRow?:number}}>(root+'/approved-datasets/:datasetId/rows',{schema:{params:datasetParams,querystring:{type:'object',additionalProperties:false,dependencies:{afterSheet:['afterRow'],afterRow:['afterSheet']},properties:{afterSheet:{type:'integer',minimum:0,maximum:9},afterRow:{type:'integer',minimum:2,maximum:1048576}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id),q=request.query;
   if(!(await tx`SELECT 1 FROM lead_import_dataset WHERE id=${request.params.datasetId} AND file_id=${j.id}`).length)throw new HttpError(404,'IMPORT_DATASET_NOT_FOUND');
   // Receipt metadata only: raw originals and old Field values are not a back door around current Field visibility.
   const items=await tx`SELECT sheet_index,row_number,submission_id,mapping_version,decision_version,disposition,duplicate FROM lead_import_dataset_row
    WHERE dataset_id=${request.params.datasetId} AND (sheet_index,row_number)>(${q.afterSheet??-1},${q.afterRow??0}) ORDER BY sheet_index,row_number LIMIT 26`;
   return {items:items.slice(0,25),next:items.length>25?{sheet:items[24]!.sheet_index,row:items[24]!.row_number}:null};
  });
 });
}
