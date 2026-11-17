import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest} from '../security.js';
import {importFile,importScope} from '../imports/service.js';
import {currentImportMapping,importContactMatches,importMappingHash,importMappingTargets,type MappedRow} from '../imports/mapping.js';
import {reviewFileReady,reviewAudit,importReview,reviewReady,cancelReview,reviewSummary,duplicateReviewRow,lockReviewFields,type ImportReview,type ReviewSelection} from '../imports/review.js';

const uuid={type:'string',format:'uuid'} as const,sheet={type:'integer',minimum:0,maximum:9} as const,row={type:'integer',minimum:2,maximum:1048576} as const;
const params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const reviewParams={type:'object',additionalProperties:false,required:['id','reviewId'],properties:{id:uuid,reviewId:uuid}} as const;
const versionBody={type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1}}} as const;
function publicReview(r:ImportReview){return {id:r.id,revision:r.revision,selection:r.selection,state:r.current||r.state==='CANCELLED'?r.state:'STALE',version:r.version,total:r.total,
 processed:r.processed,valid:r.valid_count,invalid:r.processed-r.valid_count,errorCode:r.current?r.error_code:'IMPORT_REVIEW_STALE'};}

export function registerImportReviewRoutes(app:FastifyInstance,db:Database){
 const root='/api/lead-imports/:id/reviews';
 app.post<{Params:{id:string};Body:{revision:number;requestId:string;configurationHash:string;selection:ReviewSelection[]}}>(root,{schema:{params,body:{type:'object',additionalProperties:false,required:['revision','requestId','configurationHash','selection'],properties:{
  revision:{type:'integer',minimum:0},requestId:uuid,configurationHash:{type:'string',pattern:'^[a-f0-9]{64}$'},selection:{type:'array',minItems:1,maxItems:10,items:{type:'object',additionalProperties:false,required:['sheet','version'],properties:{sheet,version:{type:'integer',minimum:1}}}},
 }}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');reply.code(202);return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id,true);reviewFileReady(j);const b=request.body,selection=[...b.selection].sort((a,b)=>a.sheet-b.sheet);
   await lockReviewFields(tx,j);
   if(new Set(selection.map(s=>s.sheet)).size!==selection.length)throw new HttpError(400,'IMPORT_REVIEW_SELECTION');
   if(await importMappingHash(tx,j.id)!==b.configurationHash)throw new HttpError(409,'IMPORT_MAPPING_CONFIGURATION_CHANGED');
   const old=(await tx`SELECT r.*,r.selection=${tx.json(selection)}::jsonb same_selection,lead_import_review_current(j,r) current FROM lead_import_review r
    JOIN lead_import_file j ON j.id=r.file_id WHERE r.file_id=${j.id} AND r.request_key=${b.requestId}`)[0];
   if(old){if(!old.same_selection||old.configuration_hash!==b.configurationHash||old.revision!==b.revision+1)throw new HttpError(409,'IMPORT_REVIEW_REQUEST_CONFLICT');
    if(!old.current||['STALE','CANCELLED'].includes(old.state))throw new HttpError(409,'IMPORT_REVIEW_STALE');return publicReview(old as ImportReview);}
   for(const s of selection){const m=await currentImportMapping(tx,j,s.sheet);if(!m)throw new HttpError(409,'IMPORT_MAPPING_REQUIRED');if(m.mapping.version!==s.version)throw new HttpError(409,'IMPORT_MAPPING_VERSION_CONFLICT');}
   const session=await importScope(tx,actor,request,j.branch_id,j.campaign_id);
   const previous=(await tx`SELECT * FROM lead_import_review WHERE file_id=${j.id} ORDER BY revision DESC LIMIT 1 FOR UPDATE`)[0] as ImportReview|undefined;
   if((previous?.revision??0)!==b.revision)throw new HttpError(409,'IMPORT_REVIEW_VERSION_CONFLICT');
   if(previous&&!['CANCELLED','STALE'].includes(previous.state))await cancelReview(tx,j,previous,session);
   const total=(await tx`SELECT sum(row_count)::int total FROM lead_import_sheet WHERE file_id=${j.id} AND sheet_index=ANY(${selection.map(s=>s.sheet)}::integer[])`)[0]!.total as number;
   const id=randomUUID(),revision=(previous?.revision??0)+1;await reviewAudit(tx,j,{id,version:1},'IMPORT_REVIEW_CREATED',actor.id,{sessionId:session,requestId:b.requestId,selection,configurationHash:b.configurationHash,revision});
   const r=(await tx`INSERT INTO lead_import_review(id,file_id,revision,request_key,session_id,selection,configuration_hash,total)
    VALUES(${id},${j.id},${revision},${b.requestId},${session},${tx.json(selection)},${b.configurationHash},${total}) RETURNING *,true current`)[0] as ImportReview;return publicReview(r);
  });
 });
 app.get<{Params:{id:string};Querystring:{before?:number}}>(root,{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id,true);reviewFileReady(j);
   const items=await tx`SELECT r.*,lead_import_review_current(j,r) current FROM lead_import_review r JOIN lead_import_file j ON j.id=r.file_id WHERE r.file_id=${j.id}
    AND (${request.query.before??null}::integer IS NULL OR r.revision<${request.query.before??null}) ORDER BY revision DESC LIMIT 26`;
   return {items:items.slice(0,25).map(r=>publicReview(r as ImportReview)),nextRevision:items.length>25?items[24]!.revision:null};
  });
 });
 app.get<{Params:{id:string;reviewId:string};Querystring:{before?:number}}>(root+'/:reviewId',{schema:{params:reviewParams,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const {r}=await importReview(tx,actor,request,request.params.id,request.params.reviewId);
   const history=await tx`SELECT version,state,processed,valid_count,attempt_count,error_code,created_at FROM lead_import_review_history WHERE review_id=${r.id}
    AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT 26`;
   const dataset=(await tx`SELECT id FROM lead_import_dataset WHERE review_id=${r.id}`)[0];
   return {...publicReview(r),approvedDatasetId:dataset?.id??null,summary:r.current&&r.state==='READY'?await reviewSummary(tx,r):null,history:history.slice(0,25),nextVersion:history.length>25?history[24]!.version:null};
  });
 });
 app.get<{Params:{id:string;reviewId:string};Querystring:{afterSheet?:number;afterRow?:number;filter?:'ALL'|'INVALID'|'DUPLICATE'|'UNREVIEWED'}}>(root+'/:reviewId/rows',{schema:{params:reviewParams,querystring:{type:'object',additionalProperties:false,dependencies:{afterSheet:['afterRow'],afterRow:['afterSheet']},properties:{afterSheet:sheet,afterRow:row,filter:{type:'string',enum:['ALL','INVALID','DUPLICATE','UNREVIEWED']}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const {j,r}=await importReview(tx,actor,request,request.params.id,request.params.reviewId);reviewReady(r);const q=request.query;
   const rows=await tx`SELECT rw.sheet_index,rw.row_number,rw.valid,rw.contact,rw.fields,rw.errors,${duplicateReviewRow(tx)} duplicate,d.action decision,COALESCE(d.version,0) decision_version
    FROM lead_import_review_row rw LEFT JOIN LATERAL(SELECT action,version FROM lead_import_review_decision
     WHERE review_id=rw.review_id AND sheet_index=rw.sheet_index AND row_number=rw.row_number ORDER BY version DESC LIMIT 1) d ON true
    WHERE rw.review_id=${r.id} AND (rw.sheet_index,rw.row_number)>(${q.afterSheet??-1},${q.afterRow??0})
     AND (${q.filter??'ALL'}='ALL' OR ${q.filter??'ALL'}='INVALID' AND NOT rw.valid OR ${q.filter??'ALL'}='DUPLICATE' AND ${duplicateReviewRow(tx)} OR ${q.filter??'ALL'}='UNREVIEWED' AND d.action IS NULL)
    ORDER BY rw.sheet_index,rw.row_number LIMIT 26`;
   const items=[];
   // Match once per sheet: row numbers alone are not unique across worksheets.
   for(const index of new Set(rows.slice(0,25).map(raw=>raw.sheet_index as number))){
    const group=rows.slice(0,25).filter(raw=>raw.sheet_index===index),mapped=group.map(raw=>({rowNumber:raw.row_number,valid:raw.valid,contact:raw.contact,fields:raw.fields,errors:raw.errors})) as MappedRow[];
    const matches=await importContactMatches(tx,actor,j,mapped);
    for(const raw of group)items.push({...raw,match:matches.get(raw.row_number)??{state:'NO_IDENTIFIER',restricted:false,candidates:[]}});
   }
   const targets=await importMappingTargets(tx,j,[...new Set(rows.slice(0,25).flatMap(raw=>(raw.fields as {fieldId:string}[]).map(f=>f.fieldId)))]);
   return {items,targets:targets.map(t=>({id:t.id,label:t.label})),next:rows.length>25?{sheet:rows[24]!.sheet_index,row:rows[24]!.row_number}:null};
  });
 });
 app.post<{Params:{id:string;reviewId:string};Body:{sheet:number;row:number;version:number;requestId:string;action:'SKIP'|'KEEP_AS_NEW_LEAD'}}>(root+'/:reviewId/decisions',{schema:{params:reviewParams,body:{type:'object',additionalProperties:false,required:['sheet','row','version','requestId','action'],properties:{sheet,row,version:{type:'integer',minimum:0},requestId:uuid,action:{type:'string',enum:['SKIP','KEEP_AS_NEW_LEAD']}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const {j,r}=await importReview(tx,actor,request,request.params.id,request.params.reviewId);reviewReady(r);const b=request.body;
   const old=(await tx`SELECT * FROM lead_import_review_decision WHERE review_id=${r.id} AND request_key=${b.requestId}`)[0];
   if(old){if(old.sheet_index!==b.sheet||old.row_number!==b.row||old.version!==b.version+1||old.action!==b.action)throw new HttpError(409,'IMPORT_REVIEW_REQUEST_CONFLICT');return {version:old.version,action:old.action};}
   const raw=(await tx`SELECT valid FROM lead_import_review_row WHERE review_id=${r.id} AND sheet_index=${b.sheet} AND row_number=${b.row}`)[0];if(!raw)throw new HttpError(404,'IMPORT_REVIEW_ROW_NOT_FOUND');
   if(!raw.valid&&b.action!=='SKIP')throw new HttpError(409,'IMPORT_REVIEW_ROW_INVALID');
   const latest=(await tx`SELECT version FROM lead_import_review_decision WHERE review_id=${r.id} AND sheet_index=${b.sheet} AND row_number=${b.row} ORDER BY version DESC LIMIT 1`)[0];
   if((latest?.version??0)!==b.version)throw new HttpError(409,'IMPORT_REVIEW_DECISION_CONFLICT');
   const session=await importScope(tx,actor,request,j.branch_id,j.campaign_id);
   // The decision version is per row, not the job's progress version.
   await reviewAudit(tx,j,{id:r.id,version:b.version+1},'IMPORT_REVIEW_DECIDED',actor.id,{sessionId:session,requestId:b.requestId,sheet:b.sheet,row:b.row,action:b.action});
   await tx`INSERT INTO lead_import_review_decision(review_id,sheet_index,row_number,version,request_key,session_id,action)
    VALUES(${r.id},${b.sheet},${b.row},${b.version+1},${b.requestId},${session},${b.action})`;return {version:b.version+1,action:b.action};
  });
 });
 app.get<{Params:{id:string;reviewId:string};Querystring:{sheet:number;row:number;before?:number}}>(root+'/:reviewId/decisions',{schema:{params:reviewParams,querystring:{type:'object',additionalProperties:false,required:['sheet','row'],properties:{sheet,row,before:{type:'integer',minimum:1}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const {r}=await importReview(tx,actor,request,request.params.id,request.params.reviewId);const q=request.query;
   const items=await tx`SELECT version,action,created_at FROM lead_import_review_decision WHERE review_id=${r.id} AND sheet_index=${q.sheet} AND row_number=${q.row}
    AND (${q.before??null}::integer IS NULL OR version<${q.before??null}) ORDER BY version DESC LIMIT 26`;
   return {items:items.slice(0,25),nextVersion:items.length>25?items[24]!.version:null};
  });
 });
 for(const action of ['retry','cancel'] as const)app.post<{Params:{id:string;reviewId:string};Body:{version:number}}>(root+'/:reviewId/'+action,{schema:{params:reviewParams,body:versionBody}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const {j,r}=await importReview(tx,actor,request,request.params.id,request.params.reviewId);if(r.version!==request.body.version)throw new HttpError(409,'IMPORT_REVIEW_VERSION_CONFLICT');
   const session=await importScope(tx,actor,request,j.branch_id,j.campaign_id);
   if(action==='cancel'){if(['CANCELLED','STALE'].includes(r.state))throw new HttpError(409,'IMPORT_REVIEW_NOT_CANCELLABLE');await cancelReview(tx,j,r,session);}
   else{if(!r.current||r.state!=='FAILED')throw new HttpError(409,'IMPORT_REVIEW_NOT_RETRYABLE');await reviewAudit(tx,j,{...r,version:r.version+1},'IMPORT_REVIEW_RETRIED',actor.id,{sessionId:session});
    await tx`UPDATE lead_import_review SET state='VALIDATING',version=version+1,attempt_count=0,error_code=NULL,next_run_at=clock_timestamp() WHERE id=${r.id}`;}
   return {version:r.version+1};
  });
 });
}
