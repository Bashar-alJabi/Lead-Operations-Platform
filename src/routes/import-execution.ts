import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest,requireRole,type Principal} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {importFile,importScope} from '../imports/service.js';
import {lockImportResult,changeImportResult,importResultAudit,intakeApprovedImport,currentImportRow} from '../imports/intake.js';
import {lockSourceIdentities,sourceCandidatePage} from '../sources/intake.js';
const uuid={type:'string',format:'uuid'} as const;
const pair={type:'object',additionalProperties:false,required:['id','datasetId'],properties:{id:uuid,datasetId:uuid}} as const;
const rowParams={type:'object',additionalProperties:false,required:['id','datasetId','submissionId'],properties:{id:uuid,datasetId:uuid,submissionId:uuid}} as const;
const reviewParams={type:'object',additionalProperties:false,required:['submissionId'],properties:{submissionId:uuid}} as const;
const rowQuery={type:'object',additionalProperties:false,dependencies:{afterSheet:['afterRow'],afterRow:['afterSheet']},properties:{afterSheet:{type:'integer',minimum:0,maximum:9},afterRow:{type:'integer',minimum:2,maximum:1048576},state:{type:'string',enum:['WAITING','IMPORTED','SKIPPED','INVALID','NEEDS_ATTENTION','FAILED']}}} as const;
const contactCodes=['CONTACT_AMBIGUOUS','CONTACT_REVIEW_REQUIRES_ADMIN'];
async function reviewScope(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,subid:string){
 requireRole(actor,'SUPER_ADMIN','MANAGER');
 const initial=(await tx`SELECT 1 FROM lead_import_result r JOIN lead_import_dataset_row dr ON dr.submission_id=r.submission_id JOIN lead_import_file f ON f.id=dr.file_id
  WHERE r.submission_id=${subid} AND f.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR f.branch_id=${actor.branchId})`)[0];
 if(!initial)throw new HttpError(404,'IMPORT_CONTACT_REVIEW_NOT_FOUND');
 const locked=await lockImportResult(tx,subid);if(!locked)throw new HttpError(404,'IMPORT_CONTACT_REVIEW_NOT_FOUND');
 const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'IMPORT_ACCESS_REVOKED');
 if(!(await tx`SELECT 1 FROM branch WHERE id=${locked.j.branch_id} AND active`).length)throw new HttpError(409,'IMPORT_SCOPE_NOT_AVAILABLE');
 return {...locked,session};
}
async function mayReadLead(tx:postgres.TransactionSql,actor:Principal,leadId:string){return (await tx`SELECT 1 FROM lead WHERE id=${leadId} AND organization_id=${actor.organizationId}
 AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId}) AND (${actor.role!=='AGENT'} OR assigned_agent_id=${actor.id})`).length>0;}
export function registerImportExecutionRoutes(app:FastifyInstance,db:Database){
 const root='/api/lead-imports/:id/approved-datasets/:datasetId';
 app.post<{Params:{id:string;datasetId:string};Body:{requestId:string}}>(root+'/execute',{schema:{params:pair,body:{type:'object',additionalProperties:false,required:['requestId'],properties:{requestId:uuid}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');reply.code(202);
  return db.begin(async tx=>{const j=await importFile(tx,actor,request,request.params.id,true),dataset=request.params.datasetId;
   if(!(await tx`SELECT 1 FROM lead_import_dataset WHERE id=${dataset} AND file_id=${j.id}`).length)throw new HttpError(404,'IMPORT_DATASET_NOT_FOUND');
   const old=(await tx`SELECT id,request_key FROM lead_import_execution WHERE dataset_id=${dataset}`)[0];
   if(old){if(old.request_key!==request.body.requestId)throw new HttpError(409,'IMPORT_EXECUTION_ALREADY_STARTED');return {id:old.id};}
   if(!(await tx`SELECT lead_import_execution_allowed(${dataset}) allowed`)[0]!.allowed)throw new HttpError(409,'IMPORT_INTAKE_AUTHORITY_UNAVAILABLE');
   const id=randomUUID(),session=await importScope(tx,actor,request,j.branch_id,j.campaign_id);
   await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(${j.organization_id},${j.branch_id},${actor.id},'IMPORT_EXECUTION_STARTED','LEAD_IMPORT_EXECUTION',${id},${tx.json({datasetId:dataset,sessionId:session,requestId:request.body.requestId})})`;
   await tx`INSERT INTO lead_import_execution(id,dataset_id,request_key,session_id) VALUES(${id},${dataset},${request.body.requestId},${session})`;
   await tx`INSERT INTO lead_import_result(submission_id,execution_id,state) SELECT submission_id,${id},CASE disposition WHEN 'READY_FOR_INTAKE' THEN 'WAITING' ELSE disposition END
    FROM lead_import_dataset_row WHERE dataset_id=${dataset}`;return {id};
  });
 });
 app.get<{Params:{id:string;datasetId:string}}>(root+'/execution',{schema:{params:pair}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id);
   if(!(await tx`SELECT 1 FROM lead_import_dataset WHERE id=${request.params.datasetId} AND file_id=${j.id}`).length)throw new HttpError(404,'IMPORT_DATASET_NOT_FOUND');
   const ex=(await tx`SELECT id,created_at FROM lead_import_execution WHERE dataset_id=${request.params.datasetId}`)[0];
   if(!ex)return {execution:null};const counts=await tx`SELECT state,count(*)::int count FROM lead_import_result WHERE execution_id=${ex.id} GROUP BY state`;
   const d=(await tx`SELECT total,duplicate_count FROM lead_import_dataset WHERE id=${request.params.datasetId}`)[0]!;
   return {execution:{...ex,...d,counts:Object.fromEntries(counts.map(c=>[c.state,c.count]))}};
  });
 });
 app.get<{Params:{id:string;datasetId:string};Querystring:{afterSheet?:number;afterRow?:number;state?:string}}>(root+'/execution/rows',{schema:{params:pair,querystring:rowQuery}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id),q=request.query;
   if(!(await tx`SELECT 1 FROM lead_import_dataset WHERE id=${request.params.datasetId} AND file_id=${j.id}`).length)throw new HttpError(404,'IMPORT_DATASET_NOT_FOUND');
   const rows=await tx`SELECT r.submission_id,dr.sheet_index,dr.row_number,dr.duplicate,r.state,r.version,r.failure_count,r.error_code,r.updated_at,
    CASE WHEN l.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId}) THEN l.id ELSE NULL END lead_id
    FROM lead_import_result r JOIN lead_import_dataset_row dr ON dr.submission_id=r.submission_id LEFT JOIN lead l ON l.id=r.lead_id
    WHERE dr.dataset_id=${request.params.datasetId} AND (${q.state??null}::text IS NULL OR r.state=${q.state??null})
    AND (dr.sheet_index,dr.row_number)>(${q.afterSheet??-1},${q.afterRow??0}) ORDER BY dr.sheet_index,dr.row_number LIMIT 26`;
   return {items:rows.slice(0,25),next:rows.length>25?{sheet:rows[24]!.sheet_index,row:rows[24]!.row_number}:null};
  });
 });
 app.get<{Params:{id:string;datasetId:string;submissionId:string};Querystring:{before?:number}}>(root+'/execution/rows/:submissionId/history',{schema:{params:rowParams,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1,maximum:2147483647}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   await importFile(tx,actor,request,request.params.id);if(!(await tx`SELECT 1 FROM lead_import_dataset_row WHERE submission_id=${request.params.submissionId} AND dataset_id=${request.params.datasetId} AND file_id=${request.params.id}`).length)throw new HttpError(404,'IMPORT_RESULT_NOT_FOUND');
   const h=await tx`SELECT version,state,failure_count,error_code,created_at FROM lead_import_result_history WHERE submission_id=${request.params.submissionId}
    AND (${request.query.before??null}::int IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT 26`;
   return {items:h.slice(0,25),nextVersion:h.length>25?h[24]!.version:null};
  });
 });
 app.post<{Params:{id:string;datasetId:string;submissionId:string};Body:{version:number;requestId:string}}>(root+'/execution/rows/:submissionId/retry',{schema:{params:rowParams,body:{type:'object',additionalProperties:false,required:['version','requestId'],properties:{version:{type:'integer',minimum:1,maximum:2147483647},requestId:uuid}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const p=request.params,b=request.body;
   if(!(await tx`SELECT 1 FROM lead_import_dataset_row dr JOIN lead_import_file f ON f.id=dr.file_id WHERE dr.submission_id=${p.submissionId} AND dr.dataset_id=${p.datasetId}
    AND f.id=${p.id} AND f.actor_id=${actor.id} AND f.organization_id=${actor.organizationId}`).length)throw new HttpError(404,'IMPORT_RESULT_NOT_FOUND');
   const locked=await lockImportResult(tx,p.submissionId);if(!locked)throw new HttpError(404,'IMPORT_RESULT_NOT_FOUND');const {j,r}=locked;
   await importFile(tx,actor,request,p.id);const session=await importScope(tx,actor,request,j.branch_id,j.campaign_id);
   const old=(await tx`SELECT result_version FROM lead_import_retry WHERE submission_id=${r.submission_id} AND request_key=${b.requestId}`)[0];
   if(old){if(old.result_version!==b.version)throw new HttpError(409,'IMPORT_RETRY_REQUEST_CONFLICT');return {version:old.result_version+1};}
   if(r.version!==b.version)throw new HttpError(409,'IMPORT_RESULT_VERSION_CONFLICT');if(!['FAILED','NEEDS_ATTENTION'].includes(r.state))throw new HttpError(409,'IMPORT_RETRY_NOT_ALLOWED');
   await currentImportRow(tx,j,locked.row);
   await importResultAudit(tx,j,r.submission_id,'IMPORT_ROW_RETRY',actor.id,{version:r.version,sessionId:session,requestId:b.requestId});
   await tx`INSERT INTO lead_import_retry(submission_id,request_key,result_version,session_id) VALUES(${r.submission_id},${b.requestId},${r.version},${session})`;
   await changeImportResult(tx,j,r,'WAITING',null,null,0);return {version:r.version+1};
  });
 });
 app.get<{Querystring:{after?:string}}>('/api/import-contact-reviews',{schema:{querystring:{type:'object',additionalProperties:false,properties:{after:uuid}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'IMPORT_ACCESS_REVOKED');
   const items=await tx`SELECT r.submission_id,r.version,r.error_code,f.branch_id,f.campaign_id,dr.sheet_index,dr.row_number FROM lead_import_result r
    JOIN lead_import_dataset_row dr ON dr.submission_id=r.submission_id JOIN lead_import_file f ON f.id=dr.file_id JOIN branch b ON b.id=f.branch_id
    WHERE f.organization_id=${actor.organizationId} AND b.active AND (${actor.role==='SUPER_ADMIN'} OR f.branch_id=${actor.branchId})
    AND r.state='NEEDS_ATTENTION' AND r.error_code IN ${tx(contactCodes)} AND (${request.query.after??null}::uuid IS NULL OR r.submission_id>${request.query.after??null}::uuid)
    ORDER BY r.submission_id LIMIT 26`;return {items:items.slice(0,25),nextId:items.length>25?items[24]!.submission_id:null};
  });
 });
 app.get<{Params:{submissionId:string};Querystring:{after?:string}}>('/api/import-contact-reviews/:submissionId/candidates',{schema:{params:reviewParams,querystring:{type:'object',additionalProperties:false,properties:{after:uuid}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const {j,r,row}=await reviewScope(tx,actor,request,request.params.submissionId);
   if(r.state!=='NEEDS_ATTENTION'||!contactCodes.includes(r.error_code!))throw new HttpError(409,'IMPORT_CONTACT_REVIEW_NOT_OPEN');
   await lockSourceIdentities(tx as unknown as Database,j.organization_id,row.contact);
   const page=await sourceCandidatePage(tx as unknown as Database,j.organization_id,row.contact,actor,request.query.after??null,25);
   return {...page,items:page.adminRequired?[]:page.items,nextAfter:page.adminRequired?null:page.nextAfter,version:r.version};
  });
 });
 app.post<{Params:{submissionId:string};Body:{version:number;requestId:string;contactId:string;reason:string}}>('/api/import-contact-reviews/:submissionId/resolve',{schema:{params:reviewParams,body:{type:'object',additionalProperties:false,required:['version','requestId','contactId','reason'],properties:{version:{type:'integer',minimum:1,maximum:2147483647},requestId:uuid,contactId:uuid,reason:{type:'string',minLength:1,maxLength:500}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const locked=await reviewScope(tx,actor,request,request.params.submissionId),b=request.body;
   const old=(await tx`SELECT * FROM lead_import_attempt WHERE submission_id=${locked.r.submission_id} AND request_key=${b.requestId}`)[0];
   if(old){if(old.resolver_id!==actor.id||old.contact_id!==b.contactId||old.reason!==b.reason.trim()||old.result_version!==b.version+1)throw new HttpError(409,'IMPORT_RESOLUTION_REQUEST_CONFLICT');
    if(!await mayReadLead(tx,actor,old.lead_id))throw new HttpError(404,'LEAD_NOT_FOUND');return {id:old.lead_id,state:'IMPORTED',version:old.result_version};}
   if(locked.r.state!=='NEEDS_ATTENTION'||!contactCodes.includes(locked.r.error_code!))throw new HttpError(409,'IMPORT_CONTACT_REVIEW_NOT_OPEN');
   if(locked.r.version!==b.version)throw new HttpError(409,'IMPORT_RESULT_VERSION_CONFLICT');if(!b.reason.trim())throw new HttpError(400,'IMPORT_RESOLUTION_REASON_REQUIRED');
   return intakeApprovedImport(tx,locked,{actor,sessionId:locked.session,requestId:b.requestId,contactId:b.contactId,reason:b.reason.trim()});
  });
 });
}
