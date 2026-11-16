import {Readable} from 'node:stream';
import type {FastifyInstance} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest} from '../security.js';
import {decodeCursor,encodeCursor} from '../pagination.js';
import {operationalFilterProperties} from '../lead-query.js';
import {exportColumns,exportSession,exportFieldScope,exportJob,exportVisible,exportAudit,transitionExport,previewExport,createExport,exportHeader,exportPage,type ExportInput,type ExportCursor} from '../exports/service.js';
const uuid={type:'string',format:'uuid'} as const,idParam={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const properties={filters:{type:'object',additionalProperties:false,properties:{...operationalFilterProperties,sort:{enum:['CREATED_ASC','CREATED_DESC']}}},
 columns:{type:'array',maxItems:12,uniqueItems:true,items:{enum:exportColumns}},fieldIds:{type:'array',maxItems:24,uniqueItems:true,items:uuid},selectedIds:{type:'array',maxItems:50,uniqueItems:true,items:uuid}} as const;
const inputSchema={type:'object',additionalProperties:false,required:['filters','columns','fieldIds','selectedIds'],properties} as const;
export function registerLeadExportRoutes(app:FastifyInstance,db:Database){
 app.get<{Querystring:{campaignId:string;after?:string}}>('/api/lead-exports/fields',{schema:{querystring:{type:'object',additionalProperties:false,required:['campaignId'],properties:{campaignId:uuid,after:uuid}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   await exportSession(tx,actor,request);
   // Same metadata authority as Lead details; no Values, provider credentials or draft knowledge.
   const rows=await tx`SELECT fd.id,fd.key,fd.label,fd.field_type FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id JOIN campaign c ON c.id=cf.campaign_id
    WHERE ${exportFieldScope(tx,actor,request.query.campaignId)} AND (${actor.role==='SUPER_ADMIN'} OR cf.show_in_details OR cf.show_in_table)
     AND (${request.query.after??null}::uuid IS NULL OR fd.id>${request.query.after??null}::uuid) ORDER BY fd.id LIMIT 26`;
   return {items:rows.slice(0,25),nextCursor:rows.length>25?rows[24]!.id:null};
  });
 });
 app.post<{Body:ExportInput}>('/api/lead-exports/preview',{schema:{body:inputSchema}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{await exportSession(tx,actor,request);return previewExport(tx,actor,request.body);});
 });
 app.post<{Body:ExportInput&{requestId:string;confirmed:true}}>('/api/lead-exports',{schema:{body:{...inputSchema,required:[...inputSchema.required,'requestId','confirmed'],properties:{...properties,requestId:uuid,confirmed:{const:true}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);const result=await createExport(db,actor,request,request.body);reply.code(202);return result;
 });
 app.get<{Querystring:{cursor?:string;limit?:number}}>('/api/lead-exports',{schema:{querystring:{type:'object',additionalProperties:false,properties:{cursor:{type:'string',maxLength:256},limit:{type:'integer',minimum:1,maximum:25}}}}},async request=>{
  const actor=await principalFromRequest(request,db),cursor=decodeCursor(request.query.cursor),limit=request.query.limit??10;
  return db.begin(async tx=>{await exportSession(tx,actor,request);
   const rows=await tx`SELECT id,state,version,error_code,expires_at,created_at,created_at::text AS cursor_at,
    actor_role=${actor.role} AND branch_scope IS NOT DISTINCT FROM ${actor.branchId}::uuid AND lead_export_manifest_visible(j) AS accessible
    FROM lead_export_job j WHERE actor_id=${actor.id} AND organization_id=${actor.organizationId}
     AND (${cursor?.timestamp??null}::text::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;
   const items=rows.slice(0,limit),last=items.at(-1);return {items,nextCursor:rows.length>limit&&last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};
  });
 });
 app.get<{Params:{id:string}}>('/api/lead-exports/:id',{schema:{params:idParam}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{await exportSession(tx,actor,request);const j=await exportJob(tx,actor,request.params.id);await exportVisible(tx,actor,j);
   const history=await tx`SELECT version,state,row_count,failure_count,error_code,created_at FROM lead_export_history WHERE job_id=${j.id} ORDER BY version DESC LIMIT 26`;
   return {id:j.id,state:j.state,version:j.version,rowCount:j.row_count,errorCode:j.error_code,history:history.slice(0,25),nextHistoryVersion:history.length>25?history[24]!.version:null};
  });
 });
 app.get<{Params:{id:string};Querystring:{before:number}}>('/api/lead-exports/:id/history',{schema:{params:idParam,querystring:{type:'object',additionalProperties:false,required:['before'],properties:{before:{type:'integer',minimum:1}}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   await exportSession(tx,actor,request);const j=await exportJob(tx,actor,request.params.id);await exportVisible(tx,actor,j);
   const rows=await tx`SELECT version,state,row_count,failure_count,error_code,created_at FROM lead_export_history WHERE job_id=${j.id} AND version<${request.query.before} ORDER BY version DESC LIMIT 26`;
   return {items:rows.slice(0,25),nextHistoryVersion:rows.length>25?rows[24]!.version:null};
  });
 });
 for(const action of ['cancel','retry'] as const)app.post<{Params:{id:string};Body:{version:number}}>('/api/lead-exports/:id/'+action,{schema:{params:idParam,body:{type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1}}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   const session=await exportSession(tx,actor,request),j=await exportJob(tx,actor,request.params.id,true);
   if(j.version!==request.body.version)throw new HttpError(409,'EXPORT_VERSION_CONFLICT');
   if(j.expired||['CANCELLED','EXPIRED'].includes(j.state))throw new HttpError(410,'EXPORT_UNAVAILABLE');
   if(action==='retry'){
    if(!['DEAD_LETTER','REVOKED'].includes(j.state))throw new HttpError(409,'EXPORT_NOT_RECOVERABLE');await exportVisible(tx,actor,j);
    await exportAudit(tx,j,'LEAD_EXPORT_RECOVERED',actor.id,{sessionId:session});const r=await transitionExport(tx,j,{state:'WAITING',failures:0});return {version:r.version};
   }
   await exportAudit(tx,j,'LEAD_EXPORT_CANCELLED',actor.id,{sessionId:session});const r=await transitionExport(tx,j,{state:'CANCELLED'});await tx`DELETE FROM lead_export_member WHERE job_id=${j.id}`;return {version:r.version};
  });
 });
 app.get<{Params:{id:string}}>('/api/lead-exports/:id/download',{schema:{params:idParam}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db),snapshot=await db.begin(async tx=>{
   await exportSession(tx,actor,request);const job=await exportJob(tx,actor,request.params.id);const fields=await exportVisible(tx,actor,job);
   if(job.state!=='DONE')throw new HttpError(409,'EXPORT_NOT_READY');await exportAudit(tx,job,'LEAD_EXPORT_DOWNLOAD_STARTED',actor.id,{count:job.row_count});
   return {job,fields};
  });
  let stopped=false;reply.raw.once('close',()=>{stopped=true;});
  async function* body(){
   yield Buffer.from('\uFEFF'+exportHeader({filters:snapshot.job.filters,columns:snapshot.job.columns,fieldIds:snapshot.job.field_ids,selectedIds:snapshot.job.selected_ids},snapshot.fields),'utf8');
   let cursor:ExportCursor=null,count=0;
   while(!stopped){const page=await db.begin(async tx=>{
    await exportSession(tx,actor,request);const current=await exportJob(tx,actor,snapshot.job.id);
    if(current.expired||current.state!=='DONE')throw new HttpError(410,'EXPORT_UNAVAILABLE');
    const result=await exportPage(tx,actor,current,cursor,snapshot.fields);await exportSession(tx,actor,request);return result;
   });if(stopped)return;if(!page.count)break;count+=page.count;cursor=page.next;yield Buffer.from(page.csv,'utf8');}
   if(!stopped&&count!==snapshot.job.row_count)throw new Error('EXPORT_DOWNLOAD_INCOMPLETE');
  }
  return reply.header('Cache-Control','no-store').header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="leads-'+snapshot.job.id+'.csv"').header('X-Content-Type-Options','nosniff').send(Readable.from(body(),{objectMode:false,highWaterMark:64*1024}));
 });
}
