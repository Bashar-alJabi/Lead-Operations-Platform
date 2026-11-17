import type {FastifyInstance} from 'fastify';import type {Database} from '../db.js';
import {principalFromRequest,HttpError} from '../security.js';
import {managedGoogleSharing,googleOperationalCampaign,googleOperationalResource} from '../google/resource-access.js';
import {googleSession} from '../google/connections.js';
const uuid={type:'string',format:'uuid'} as const,params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const accessParams={...params,required:['id','branchId'],properties:{id:uuid,branchId:uuid}} as const;
const paging={type:'object',additionalProperties:false,properties:{after:uuid,limit:{type:'integer',minimum:1,maximum:100}}} as const;
export function registerGoogleResourceAccessRoutes(app:FastifyInstance,db:Database){
 app.get<{Querystring:{after?:string;limit?:number}}>('/api/google/campaigns',{schema:{querystring:paging}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),limit=request.query.limit??20;return db.begin(async tx=>{
   await googleSession(tx,actor,request);
   const rows=await tx`SELECT ca.id,ca.name FROM campaign ca JOIN branch b ON b.id=ca.branch_id WHERE ca.organization_id=${actor.organizationId} AND b.active AND b.organization_id=${actor.organizationId}
    AND (${actor.role==='SUPER_ADMIN'} OR ca.branch_id=${actor.branchId}) AND (${request.query.after??null}::uuid IS NULL OR ca.id>${request.query.after??null}::uuid) ORDER BY ca.id LIMIT ${limit+1}`;
   return {items:rows.slice(0,limit),nextAfter:rows.length>limit?rows[limit-1]!.id:null};
  });
 });
 app.get<{Params:{id:string};Querystring:{after?:string;limit?:number}}>('/api/google/resources/:id/access/branches',{schema:{params,querystring:paging}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),limit=request.query.limit??20;return db.begin(async tx=>{
   await managedGoogleSharing(tx,actor,request,request.params.id);
   const rows=await tx`SELECT id,name FROM branch WHERE organization_id=${actor.organizationId} AND active AND (${request.query.after??null}::uuid IS NULL OR id>${request.query.after??null}::uuid) ORDER BY id LIMIT ${limit+1}`;
   return {items:rows.slice(0,limit),nextAfter:rows.length>limit?rows[limit-1]!.id:null};
  });
 });
 app.get<{Params:{id:string};Querystring:{after?:string;limit?:number}}>('/api/google/resources/:id/access',{schema:{params,querystring:paging}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),limit=request.query.limit??20;return db.begin(async tx=>{
   await managedGoogleSharing(tx,actor,request,request.params.id);const rows=await tx`SELECT a.branch_id,b.name,a.active,a.version,a.reason,a.updated_at FROM google_resource_access a JOIN branch b ON b.id=a.branch_id
    WHERE a.resource_id=${request.params.id} AND (${request.query.after??null}::uuid IS NULL OR a.branch_id>${request.query.after??null}::uuid) ORDER BY a.branch_id LIMIT ${limit+1}`;
   return {items:rows.slice(0,limit),nextAfter:rows.length>limit?rows[limit-1]!.branch_id:null};
  });
 });
 app.get<{Params:{id:string;branchId:string}}>('/api/google/resources/:id/access/:branchId',{schema:{params:accessParams}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   await managedGoogleSharing(tx,actor,request,request.params.id);
   const b=(await tx`SELECT id,name,active FROM branch WHERE id=${request.params.branchId} AND organization_id=${actor.organizationId}`)[0];if(!b)throw new HttpError(404,'GOOGLE_BRANCH_NOT_FOUND');
   const row=(await tx`SELECT active,version,reason,updated_at FROM google_resource_access WHERE resource_id=${request.params.id} AND branch_id=${b.id}`)[0];return {branch:b,...(row??{active:false,version:0,reason:null})};
  });
 });
 app.put<{Params:{id:string;branchId:string};Body:{version:number;connectionVersion:number;resourceVersion:number;active:boolean;reason:string}}>('/api/google/resources/:id/access/:branchId',{
  schema:{params:accessParams,body:{type:'object',additionalProperties:false,required:['version','connectionVersion','resourceVersion','active','reason'],properties:{version:{type:'integer',minimum:0},connectionVersion:{type:'integer',minimum:1},resourceVersion:{type:'integer',minimum:1},active:{type:'boolean'},reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$'}}}}
 },async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),p=request.body;if(p.reason.trim().length<3)throw new HttpError(400,'GOOGLE_TEXT_INVALID');return db.begin(async tx=>{
   const {c,r,session}=await managedGoogleSharing(tx,actor,request,request.params.id,true);
   if(c.version!==p.connectionVersion||r.version!==p.resourceVersion)throw new HttpError(409,'GOOGLE_RESOURCE_VERSION_CONFLICT');
   if(!(await tx`SELECT 1 FROM branch WHERE id=${request.params.branchId} AND organization_id=${actor.organizationId} AND (${!p.active} OR active) FOR SHARE`).length)throw new HttpError(404,'GOOGLE_BRANCH_NOT_FOUND');
   if(p.active&&(!r.active||c.status!=='CONNECTED'||r.connection_version!==c.version))throw new HttpError(409,'GOOGLE_RESOURCE_UNAVAILABLE');
   const old=(await tx`SELECT version FROM google_resource_access WHERE resource_id=${r.id} AND branch_id=${request.params.branchId} FOR UPDATE`)[0];if((old?.version??0)!==p.version)throw new HttpError(409,'GOOGLE_RESOURCE_ACCESS_VERSION_CONFLICT');
   const values={active:p.active,version:p.version+1,connection_version:c.version,resource_version:r.version,actor_id:actor.id,session_id:session,reason:p.reason.trim()};
   const rows=old?await tx`UPDATE google_resource_access SET ${tx(values)} WHERE resource_id=${r.id} AND branch_id=${request.params.branchId} RETURNING version,active`:
    await tx`INSERT INTO google_resource_access ${tx({resource_id:r.id,branch_id:request.params.branchId,...values})} RETURNING version,active`;return rows[0];
  });
 });
 app.get<{Params:{id:string;branchId:string};Querystring:{before?:number;limit?:number}}>('/api/google/resources/:id/access/:branchId/history',{
  schema:{params:accessParams,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:100}}}}
 },async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),limit=request.query.limit??20;return db.begin(async tx=>{
   await managedGoogleSharing(tx,actor,request,request.params.id);if(!(await tx`SELECT 1 FROM branch WHERE id=${request.params.branchId} AND organization_id=${actor.organizationId}`).length)throw new HttpError(404,'GOOGLE_BRANCH_NOT_FOUND');
   const rows=await tx`SELECT version,active,connection_version,resource_version,actor_id,reason,created_at FROM google_resource_access_history WHERE resource_id=${request.params.id} AND branch_id=${request.params.branchId}
    AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT ${limit+1}`;return {items:rows.slice(0,limit),nextBefore:rows.length>limit?rows[limit-1]!.version:null};
  });
 });
 app.get<{Params:{id:string};Querystring:{after?:string;limit?:number}}>('/api/google/campaigns/:id/resources',{schema:{params,querystring:paging}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),limit=request.query.limit??20;return db.begin(async tx=>{
   const camp=await googleOperationalCampaign(tx,actor,request,request.params.id);const rows=await tx`SELECT r.id,r.spreadsheet_id,r.metadata->>'title' AS title,jsonb_array_length(r.metadata->'sheets') AS sheet_count,r.version,r.connection_version,c.name AS connection_name
    FROM google_available_resource a JOIN google_resource r ON r.id=a.resource_id JOIN integration_connection c ON c.id=r.connection_id WHERE a.organization_id=${actor.organizationId} AND a.branch_id=${camp.branch_id}
    AND (${request.query.after??null}::uuid IS NULL OR r.id>${request.query.after??null}::uuid) ORDER BY r.id LIMIT ${limit+1}`;return {items:rows.slice(0,limit),nextAfter:rows.length>limit?rows[limit-1]!.id:null};
  });
 });
 app.get<{Params:{id:string;resourceId:string};Querystring:{afterIndex?:number;afterId?:number;limit?:number}}>('/api/google/campaigns/:id/resources/:resourceId/sheets',{
  schema:{params:{...params,required:['id','resourceId'],properties:{id:uuid,resourceId:uuid}},querystring:{type:'object',additionalProperties:false,properties:{afterIndex:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},afterId:{type:'integer',minimum:0,maximum:2147483647},limit:{type:'integer',minimum:1,maximum:100}}}}
 },async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),q=request.query,limit=q.limit??25;if((q.afterIndex===undefined)!==(q.afterId===undefined))throw new HttpError(400,'GOOGLE_CURSOR_INVALID');
  return db.begin(async tx=>{const {resource:r}=await googleOperationalResource(tx,actor,request,request.params.id,request.params.resourceId);
   const rows=await tx`SELECT s FROM google_resource r CROSS JOIN LATERAL jsonb_array_elements(r.metadata->'sheets') d(s) WHERE r.id=${r.id}
    AND (${q.afterIndex??null}::bigint IS NULL OR ((s->>'index')::bigint,(s->>'id')::bigint)>(${q.afterIndex??null}::bigint,${q.afterId??null}::bigint)) ORDER BY (s->>'index')::bigint,(s->>'id')::bigint LIMIT ${limit+1}`;
   const items=rows.slice(0,limit).map(r=>r.s),last=items.at(-1);return {items,next:rows.length>limit&&last?{index:last.index,id:last.id}:null};
  });
 });
}
