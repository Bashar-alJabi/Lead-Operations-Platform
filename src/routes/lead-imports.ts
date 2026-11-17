import type {FastifyInstance} from 'fastify';
import type {Database} from '../db.js';
import type {MediaStorage} from '../media/storage.js';
import {HttpError,principalFromRequest,requireRole} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {importMaxBytes} from '../imports/types.js';
import {importScope,importFile,importAvailable,importAudit,changeImport,uploadImport,type UploadInput} from '../imports/service.js';
import {registerImportMappingRoutes} from './import-mapping.js';
import {registerImportReviewRoutes} from './import-review.js';
import {registerImportApprovalRoutes} from './import-approval.js';
import {registerImportExecutionRoutes} from './import-execution.js';

const uuid={type:'string',format:'uuid'} as const;
const params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const versionBody={type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1}}} as const;
const uuidPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function registerLeadImportRoutes(app:FastifyInstance,db:Database,storage?:MediaStorage){
 registerImportMappingRoutes(app,db);
 registerImportReviewRoutes(app,db);
 registerImportApprovalRoutes(app,db);
 registerImportExecutionRoutes(app,db);
 const root='/api/lead-imports';const uploading=new Set<string>();
 app.get<{Querystring:{kind:'BRANCH'|'CAMPAIGN';branchId?:string;after?:string}}>(root+'/catalog',{schema:{querystring:{type:'object',additionalProperties:false,required:['kind'],properties:{kind:{type:'string',enum:['BRANCH','CAMPAIGN']},branchId:uuid,after:uuid}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');reply.header('Cache-Control','no-store');
  return db.begin(async tx=>{
   if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'IMPORT_ACCESS_REVOKED');const q=request.query;
   if(q.kind==='CAMPAIGN'&&!q.branchId)throw new HttpError(400,'IMPORT_BRANCH_REQUIRED');
   const items=q.kind==='BRANCH'?await tx`SELECT id,name FROM branch WHERE organization_id=${actor.organizationId} AND active
    AND (${actor.role==='SUPER_ADMIN'} OR id=${actor.branchId}) AND (${q.after??null}::uuid IS NULL OR id>${q.after??null}::uuid) ORDER BY id LIMIT 26`:
    await tx`SELECT c.id,c.name FROM campaign c JOIN branch b ON b.id=c.branch_id WHERE c.organization_id=${actor.organizationId} AND b.organization_id=c.organization_id
     AND b.active AND b.id=${q.branchId!} AND (${actor.role==='SUPER_ADMIN'} OR b.id=${actor.branchId})
     AND (${q.after??null}::uuid IS NULL OR c.id>${q.after??null}::uuid) ORDER BY c.id LIMIT 26`;
   return {items:items.slice(0,25),nextId:items.length>25?items[24]!.id:null};
  });
 });
 app.register(async scope=>{
  scope.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
  scope.addHook('onRequest',async request=>{
   const actor=await principalFromRequest(request,db),q=request.query as Partial<UploadInput>;
   requireRole(actor,'SUPER_ADMIN','MANAGER');if(typeof q.branchId!=='string'||typeof q.campaignId!=='string'||!uuidPattern.test(q.branchId)||!uuidPattern.test(q.campaignId))throw new HttpError(400,'INVALID_REQUEST');
   await db.begin(tx=>importScope(tx,actor,request,q.branchId!,q.campaignId!));
   if(uploading.size>=2)throw new HttpError(429,'IMPORT_UPLOAD_BUSY');uploading.add(request.id);
  });scope.addHook('onResponse',async request=>{uploading.delete(request.id);});scope.addHook('onRequestAbort',async request=>{uploading.delete(request.id);});
  scope.post<{Querystring:UploadInput}>(root,{bodyLimit:importMaxBytes,config:{rateLimit:{max:10,timeWindow:'1 minute'}},schema:{querystring:{
   type:'object',additionalProperties:false,required:['branchId','campaignId','label','format','delimiter','requestId'],properties:{
    branchId:uuid,campaignId:uuid,requestId:uuid,label:{type:'string',minLength:1,maxLength:200,pattern:'^[^\\x00-\\x1f\\x7f]+$'},
    format:{type:'string',enum:['CSV','XLSX','XLS']},delimiter:{type:'string',enum:[',',';','\t']},
   }}}},async(request,reply)=>{
   if(!Buffer.isBuffer(request.body))throw new HttpError(400,'IMPORT_FILE_INVALID');
   const actor=await principalFromRequest(request,db);const result=await uploadImport(db,actor,request,request.body,request.query,storage);
   return reply.code(202).header('Cache-Control','no-store').send(result);
  });
 });
 app.get<{Querystring:{after?:string}}>(root,{schema:{querystring:{type:'object',additionalProperties:false,properties:{after:uuid}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');reply.header('Cache-Control','no-store');
  // Labels and scope metadata are also private. Current permission is checked in SQL, not just the UI.
  return db.begin(async tx=>{if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'IMPORT_ACCESS_REVOKED');
  const rows=await tx`SELECT j.id,j.label,j.state,j.version,j.expires_at<=clock_timestamp() AS expired,j.created_at FROM lead_import_file j
   WHERE j.actor_id=${actor.id} AND j.organization_id=${actor.organizationId} AND j.actor_role=${actor.role} AND j.branch_scope IS NOT DISTINCT FROM ${actor.branchId}::uuid
    AND lead_import_authority(j) AND (${request.query.after??null}::uuid IS NULL OR j.id>${request.query.after??null}::uuid) ORDER BY j.id LIMIT 11`;
  return {items:rows.slice(0,10),nextId:rows.length>10?rows[9]!.id:null,maxBytes:importMaxBytes,maxRows:10000};});
 });
 app.get<{Params:{id:string};Querystring:{before?:number}}>(root+'/:id',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id);
   const h=await tx`SELECT version,state,attempt_count,row_count,error_code,created_at FROM lead_import_file_history WHERE file_id=${j.id}
    AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT 26`;
   const sheets=j.state==='REVIEW'&&!j.expired?await tx`SELECT sheet_index,name,headers,header_row,row_count FROM lead_import_sheet WHERE file_id=${j.id} ORDER BY sheet_index`:[];
   return {id:j.id,label:j.label,format:j.format,state:j.state,version:j.version,expired:j.expired,purged:Boolean(j.purged_at),rowCount:j.row_count,
    errorCode:(j as unknown as {error_code:string|null}).error_code,cleanupError:j.purged_at?null:(j as unknown as {cleanup_error_code:string|null}).cleanup_error_code,sheets,history:h.slice(0,25),nextVersion:h.length>25?h[24]!.version:null};
  });
 });
 app.get<{Params:{id:string};Querystring:{sheet:number;after?:number}}>(root+'/:id/rows',{schema:{params,querystring:{type:'object',additionalProperties:false,required:['sheet'],properties:{sheet:{type:'integer',minimum:0,maximum:9},after:{type:'integer',minimum:1,maximum:1048576}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id,true);importAvailable(j);if(j.state!=='REVIEW')throw new HttpError(409,'IMPORT_PREVIEW_NOT_READY');
   const sheet=(await tx`SELECT sheet_index,name,headers,header_row,row_count FROM lead_import_sheet WHERE file_id=${j.id} AND sheet_index=${request.query.sheet}`)[0];
   if(!sheet)throw new HttpError(404,'IMPORT_SHEET_NOT_FOUND');
   const rows=await tx`SELECT row_number,cells FROM lead_import_row WHERE file_id=${j.id} AND sheet_index=${request.query.sheet} AND row_number>${request.query.after??1} ORDER BY row_number LIMIT 26`;
   return {sheet,items:rows.slice(0,25),nextRow:rows.length>25?rows[24]!.row_number:null};
  });
 });
 for(const action of ['cancel','retry'] as const)app.post<{Params:{id:string};Body:{version:number}}>(root+'/:id/'+action,{schema:{params,body:versionBody}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id,true);importAvailable(j);
   if(j.version!==request.body.version)throw new HttpError(409,'IMPORT_VERSION_CONFLICT');
   if(action==='retry'&&(j.state!=='DEAD_LETTER'||j.purged_at))throw new HttpError(409,'IMPORT_RETRY_NOT_ALLOWED');
   const session=await importScope(tx,actor,request,j.branch_id,j.campaign_id);
   await importAudit(tx,j,action==='cancel'?'IMPORT_FILE_CANCELLED':'IMPORT_FILE_RETRIED',actor.id,{version:j.version+1,sessionId:session});
   const next=await changeImport(tx,j,{state:action==='cancel'?'CANCELLED':'WAITING',...(action==='retry'?{attempt:0}:{})});
   if(action==='cancel'){await tx`DELETE FROM lead_import_row WHERE file_id=${j.id}`;await tx`DELETE FROM lead_import_sheet WHERE file_id=${j.id}`;}
   return {state:next.state,version:next.version};
  });
 });
}
