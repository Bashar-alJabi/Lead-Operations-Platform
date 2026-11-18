import type {FastifyInstance} from 'fastify';import type {Database} from '../db.js';import {principalFromRequest} from '../security.js';
import {exportSession} from '../exports/service.js';
import {googleExportTargets,prepareGoogleExport,ownedGoogleExport,visibleGoogleExport,googleExportReceipt,actOnGoogleExport,type GoogleExportIntent} from '../google/export-preparation.js';
const uuid={type:'string',format:'uuid'} as const,params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const reason={type:'string',minLength:3,maxLength:500,pattern:'\\S.*\\S'} as const;
export function registerGoogleExportRoutes(app:FastifyInstance,db:Database){
 app.get<{Params:{id:string};Querystring:{after?:string}}>('/api/lead-exports/:id/google-targets',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{after:uuid}}}},async request=>{
  const actor=await principalFromRequest(request,db);return googleExportTargets(db,actor,request,request.params.id,request.query.after??null);
 });
 app.post<{Params:{id:string};Body:GoogleExportIntent}>('/api/lead-exports/:id/google-preparations',{schema:{params,body:{type:'object',additionalProperties:false,required:['resourceId','resourceVersion','connectionVersion','requestId','reason','confirmed'],properties:{resourceId:uuid,resourceVersion:{type:'integer',minimum:1},connectionVersion:{type:'integer',minimum:1},requestId:uuid,reason,confirmed:{const:true}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.code(202);return prepareGoogleExport(db,actor,request,request.params.id,request.body);
 });
 app.get<{Querystring:{after?:string}}>('/api/google/exports',{schema:{querystring:{type:'object',additionalProperties:false,properties:{after:uuid}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{await exportSession(tx,actor,request);
   const rows=await tx`SELECT id,state,version,created_at,actor_role=${actor.role} AND branch_scope IS NOT DISTINCT FROM ${actor.branchId}::uuid accessible FROM google_export_job
    WHERE actor_id=${actor.id} AND organization_id=${actor.organizationId} AND (${request.query.after??null}::uuid IS NULL OR id<${request.query.after??null}::uuid) ORDER BY id DESC LIMIT 11`;
   return {items:rows.slice(0,10),nextCursor:rows.length>10?rows[9]!.id:null};
  });
 });
 app.get<{Params:{id:string}}>('/api/google/exports/:id',{schema:{params}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{await exportSession(tx,actor,request);const j=await ownedGoogleExport(tx,actor,request.params.id);await visibleGoogleExport(tx,actor,j);
   const history=await tx`SELECT version,state,prepared_rows,failures,error_code,reason,created_at FROM google_export_history WHERE job_id=${j.id} ORDER BY version DESC LIMIT 21`;
   return {...googleExportReceipt(j),header:j.header_cells,history:history.slice(0,20),nextHistoryVersion:history.length>20?history[19]!.version:null};
  });
 });
 app.get<{Params:{id:string};Querystring:{after?:number}}>('/api/google/exports/:id/rows',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{after:{type:'integer',minimum:0,maximum:10000}}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{await exportSession(tx,actor,request);const j=await ownedGoogleExport(tx,actor,request.params.id);await visibleGoogleExport(tx,actor,j);
   const rows=await tx`SELECT row_number,cells FROM google_export_row WHERE job_id=${j.id} AND row_number>${request.query.after??0} ORDER BY row_number LIMIT 26`;
   await exportSession(tx,actor,request);return {items:rows.slice(0,25),nextCursor:rows.length>25?rows[24]!.row_number:null};
  });
 });
 app.get<{Params:{id:string};Querystring:{before:number}}>('/api/google/exports/:id/history',{schema:{params,querystring:{type:'object',additionalProperties:false,required:['before'],properties:{before:{type:'integer',minimum:1}}}}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{await exportSession(tx,actor,request);const j=await ownedGoogleExport(tx,actor,request.params.id);await visibleGoogleExport(tx,actor,j);
   const rows=await tx`SELECT version,state,prepared_rows,failures,error_code,reason,created_at FROM google_export_history WHERE job_id=${j.id} AND version<${request.query.before} ORDER BY version DESC LIMIT 21`;
   return {items:rows.slice(0,20),nextHistoryVersion:rows.length>20?rows[19]!.version:null};
  });
 });
 for(const action of ['cancel','recover'] as const)app.post<{Params:{id:string};Body:{version:number;reason:string}}>('/api/google/exports/:id/'+action,{schema:{params,body:{type:'object',additionalProperties:false,required:['version','reason'],properties:{version:{type:'integer',minimum:1},reason}}}},async request=>{
  const actor=await principalFromRequest(request,db);return actOnGoogleExport(db,actor,request,request.params.id,request.body,action==='cancel');
 });
}
