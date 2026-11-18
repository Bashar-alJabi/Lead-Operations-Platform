import type {FastifyInstance} from 'fastify';import type {Database} from '../db.js';import {principalFromRequest,HttpError} from '../security.js';
import {captureJob,captureReceipt,createGoogleCapture,changeGoogleCapture,type CaptureInput} from '../google/capture.js';import {googleSession} from '../google/connections.js';
import {decodeCursor,encodeCursor} from '../pagination.js';
import {prepareGoogleImport,type GoogleImportInput} from '../google/import-input.js';import {importFile} from '../imports/service.js';
const uuid={type:'string',format:'uuid'} as const,params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const text=(max:number)=>({type:'string',minLength:1,maxLength:max,pattern:'^[^\\x00-\\x1f\\x7f]+$'} as const);
export function registerGoogleCaptureRoutes(app:FastifyInstance,db:Database){
 app.post<{Params:{id:string};Body:GoogleImportInput}>('/api/google/captures/:id/import-input',{schema:{params,body:{type:'object',additionalProperties:false,required:['version','requestId','reason'],properties:{version:{type:'integer',minimum:1,maximum:2147483647},requestId:uuid,reason:text(500)}}},config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');return reply.code(201).send(await prepareGoogleImport(db,await principalFromRequest(request,db),request,request.params.id,request.body));
 });
 app.get<{Params:{id:string}}>('/api/google/captures/:id/import-input',{schema:{params}},async(request,reply)=>{reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
  const g=await captureJob(tx,actor,request,request.params.id),found=(await tx`SELECT id FROM lead_import_file WHERE google_capture_id=${g.id} AND actor_id=${actor.id}`)[0];if(!found)return null;
  const j=await importFile(tx,actor,request,found.id);return {id:j.id,inputKind:j.input_kind,state:j.state,version:j.version};
 });});
 app.post<{Params:{id:string};Body:CaptureInput}>('/api/google/campaigns/:id/captures',{
  schema:{params,body:{type:'object',additionalProperties:false,required:['resourceId','connectionVersion','resourceVersion','sheetId','row','column','rows','columns','requestId','label','reason'],properties:{resourceId:uuid,requestId:uuid,connectionVersion:{type:'integer',minimum:1},resourceVersion:{type:'integer',minimum:1},sheetId:{type:'integer',minimum:0,maximum:2147483647},row:{type:'integer',minimum:1,maximum:2147483647},column:{type:'integer',minimum:1,maximum:18278},rows:{type:'integer',minimum:1,maximum:10000},columns:{type:'integer',minimum:1,maximum:64},label:text(200),reason:text(500)}}},config:{rateLimit:{max:30,timeWindow:'15 minutes'}}
 },async(request,reply)=>{reply.header('Cache-Control','private, no-store');return reply.code(202).send(await createGoogleCapture(db,await principalFromRequest(request,db),request,request.params.id,request.body));});
 app.get<{Querystring:{cursor?:string;limit?:number}}>('/api/google/captures',{
  schema:{querystring:{type:'object',additionalProperties:false,properties:{cursor:{type:'string',maxLength:256},limit:{type:'integer',minimum:1,maximum:100}}}}
 },async(request,reply)=>{reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),cursor=decodeCursor(request.query.cursor),limit=request.query.limit??20;
  return db.begin(async tx=>{await googleSession(tx,actor,request);const rows=await tx`SELECT j.*,j.created_at::text cursor_time,j.expires_at<=clock_timestamp() expired FROM google_capture_job j JOIN branch b ON b.id=j.branch_id JOIN campaign ca ON ca.id=j.campaign_id
    WHERE j.actor_id=${actor.id} AND j.organization_id=${actor.organizationId} AND j.actor_role=${actor.role} AND j.actor_branch_id IS NOT DISTINCT FROM ${actor.branchId}::uuid AND b.active AND ca.branch_id=b.id AND b.organization_id=${actor.organizationId}
    AND (${actor.role==='SUPER_ADMIN'} OR b.id=${actor.branchId}) AND (${cursor?.timestamp??null}::timestamptz IS NULL OR (j.created_at,j.id)<(${cursor?.timestamp??null}::timestamptz,${cursor?.id??null}::uuid)) ORDER BY j.created_at DESC,j.id DESC LIMIT ${limit+1}`;
   const items=rows.slice(0,limit),last=items.at(-1);return {items:items.map(captureReceipt),nextCursor:rows.length>limit&&last?encodeCursor({timestamp:last.cursor_time,id:last.id}):null};
  });
 });
 app.get<{Params:{id:string}}>('/api/google/captures/:id',{schema:{params}},async(request,reply)=>{reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db);return db.begin(async tx=>captureReceipt(await captureJob(tx,actor,request,request.params.id)));});
 app.get<{Params:{id:string};Querystring:{after?:number;limit?:number}}>('/api/google/captures/:id/rows',{
  schema:{params,querystring:{type:'object',additionalProperties:false,properties:{after:{type:'integer',minimum:0,maximum:2147483647},limit:{type:'integer',minimum:1,maximum:100}}}}
 },async(request,reply)=>{reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),limit=request.query.limit??25;return db.begin(async tx=>{
  const found=await captureJob(tx,actor,request,request.params.id);await tx`SELECT id FROM integration_connection WHERE id=${found.connection_id} FOR SHARE`;
  const j=await captureJob(tx,actor,request,request.params.id);if(j.expired||['CANCELLED','EXPIRED'].includes(j.state))throw new HttpError(410,'GOOGLE_CAPTURE_EXPIRED');
  if(j.state!=='READY')throw new HttpError(409,'GOOGLE_CAPTURE_NOT_READY');if(!(await tx`SELECT google_capture_allowed(j) ok FROM google_capture_job j WHERE id=${j.id}`)[0]!.ok)throw new HttpError(403,'GOOGLE_CAPTURE_ACCESS_CHANGED');
  const rows=await tx`SELECT row_number,cells FROM google_capture_row WHERE job_id=${j.id} AND row_number>${request.query.after??0} ORDER BY row_number LIMIT ${limit+1}`;
  return {items:rows.slice(0,limit),nextAfter:rows.length>limit?rows[limit-1]!.row_number:null};
 });});
 app.get<{Params:{id:string};Querystring:{before?:number;limit?:number}}>('/api/google/captures/:id/history',{
  schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:100}}}}
 },async(request,reply)=>{reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),limit=request.query.limit??20;return db.begin(async tx=>{
  const j=await captureJob(tx,actor,request,request.params.id);const rows=await tx`SELECT version,state,captured_rows,payload_bytes,failures,error_code,reason,created_at FROM google_capture_history WHERE job_id=${j.id}
    AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT ${limit+1}`;return {items:rows.slice(0,limit),nextBefore:rows.length>limit?rows[limit-1]!.version:null};
 });});
 for(const action of ['cancel','recover'] as const)app.post<{Params:{id:string};Body:{version:number;reason:string}}>('/api/google/captures/:id/'+action,{
  schema:{params,body:{type:'object',additionalProperties:false,required:['version','reason'],properties:{version:{type:'integer',minimum:1},reason:text(500)}}}
 },async(request,reply)=>{reply.header('Cache-Control','private, no-store');return changeGoogleCapture(db,await principalFromRequest(request,db),request,request.params.id,request.body,action==='cancel');});
}
