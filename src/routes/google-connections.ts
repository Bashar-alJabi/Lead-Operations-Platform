import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyReply} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest,requireRole} from '../security.js';
import {sealSecret} from '../credentials.js';
import {decodeCursor,encodeCursor} from '../pagination.js';
import {googleSheetsAdapter,googleSheetsScopes,type GoogleSheetsAdapter} from '../google/sheets.js';
import {googleConnection,googleSession,googleRevision,googleSetup,startGoogleAuthorization,completeGoogleAuthorization,checkGoogleConnection} from '../google/connections.js';
const uuid={type:'string',format:'uuid'} as const,version={type:'integer',minimum:1} as const;
const params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const text=(min:number,max:number)=>({type:'string',minLength:min,maxLength:max,pattern:'^[^\\x00-\\x1f\\x7f]+$'});
const name=text(1,100),reason=text(3,500),secret=text(1,4096);
const page={type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',maxLength:256}}} as const;
type Page={limit?:number;cursor?:string};
function checked(value:string,min=1,max=100){const v=value.trim();if(v.length<min||v.length>max)throw new HttpError(400,'GOOGLE_TEXT_INVALID');return v;}
function privateReply(reply:FastifyReply){reply.header('Cache-Control','private, no-store').header('Referrer-Policy','no-referrer');}
export function registerGoogleConnectionRoutes(app:FastifyInstance,db:Database,adapter:GoogleSheetsAdapter=googleSheetsAdapter()) {
 app.get('/api/google/setup',async(request,reply)=>{
  privateReply(reply);const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');
  await db.begin(tx=>googleSession(tx,actor,request));return {redirectUri:googleSetup().redirectUri,scopes:[...googleSheetsScopes],verification:'Live Verification Pending External Credential/Approval'};
 });
 app.get<{Querystring:Page}>('/api/google/connections',{schema:{querystring:page}},async(request,reply)=>{
  privateReply(reply);const actor=await principalFromRequest(request,db),limit=request.query.limit??20,cursor=decodeCursor(request.query.cursor);
  return db.begin(async(tx)=>{
   await googleSession(tx,actor,request);
   const rows=await tx`SELECT c.id,c.name,c.branch_id,c.provider,c.version,c.status,c.config->>'clientId' AS client_id,c.last_error_code,c.last_success_at,c.last_failure_at,c.created_at::text AS cursor_time,
    EXISTS(SELECT 1 FROM google_connection_subject s WHERE s.connection_id=c.id) AS account_pinned
    FROM integration_connection c WHERE c.kind='GOOGLE' AND c.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})
    AND (${cursor?.timestamp??null}::timestamptz IS NULL OR (c.created_at,c.id)<(${cursor?.timestamp??null}::timestamptz,${cursor?.id??null}::uuid))
    ORDER BY c.created_at DESC,c.id DESC LIMIT ${limit+1}`;
   const items=rows.slice(0,limit),last=items.at(-1);return {items:items.map(({cursor_time,...c})=>c),nextCursor:rows.length>limit&&last?encodeCursor({timestamp:last.cursor_time,id:last.id}):null};
  });
 });
 app.get<{Params:{id:string}}>('/api/google/connections/:id',{schema:{params}},async(request,reply)=>{
  privateReply(reply);const actor=await principalFromRequest(request,db);return db.begin(async(tx)=>{
   const c=await googleConnection(tx,actor,request.params.id);await googleSession(tx,actor,request);
   return {id:c.id,name:c.name,branch_id:c.branch_id,provider:c.provider,version:c.version,status:c.status,client_id:c.config.clientId,
    last_error_code:c.last_error_code,last_success_at:c.last_success_at,last_failure_at:c.last_failure_at,
    account_pinned:(await tx`SELECT 1 FROM google_connection_subject WHERE connection_id=${c.id}`).length>0};
  });
 });
 app.post<{Body:{name:string;branchId:string|null;clientId:string;clientSecret:string;reason:string}}>('/api/google/connections',{
  schema:{body:{type:'object',additionalProperties:false,required:['name','branchId','clientId','clientSecret','reason'],properties:{name,branchId:{anyOf:[uuid,{type:'null'}]},clientId:{type:'string',pattern:'^[A-Za-z0-9._-]{1,220}\\.apps\\.googleusercontent\\.com$'},clientSecret:secret,reason}}}
 },async(request,reply)=>{
  privateReply(reply);const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const p=request.body;
  const result=await db.begin(async(tx)=>{
   if(actor.role!=='SUPER_ADMIN'&&(!p.branchId||actor.branchId!==p.branchId))throw new HttpError(403,'GOOGLE_SCOPE_FORBIDDEN');
   if(p.branchId&&!(await tx`SELECT 1 FROM branch WHERE id=${p.branchId} AND organization_id=${actor.organizationId} AND active FOR SHARE`).length)throw new HttpError(404,'BRANCH_NOT_FOUND');
   const session=await googleSession(tx,actor,request),id=randomUUID(),sealed=sealSecret(id,p.clientSecret);
   const c=(await tx`INSERT INTO integration_connection(id,organization_id,branch_id,kind,provider,name,config,created_by)
    VALUES(${id},${actor.organizationId},${p.branchId},'GOOGLE','GOOGLE_SHEETS',${checked(p.name)},${tx.json({clientId:p.clientId})},${actor.id}) RETURNING *`)[0]!;
   await tx`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag,key_version) VALUES(${id},${sealed.ciphertext},${sealed.nonce},${sealed.authTag},${sealed.keyVersion})`;
   await googleRevision(tx,c,actor,session,checked(p.reason,3,500),true);return {id,version:c.version,status:c.status};
  });reply.code(201);return result;
 });
 app.put<{Params:{id:string};Body:{name:string;clientSecret?:string;version:number;reason:string}}>('/api/google/connections/:id',{
  schema:{params,body:{type:'object',additionalProperties:false,required:['name','version','reason'],properties:{name,clientSecret:secret,version,reason}}}
 },async(request,reply)=>{
  privateReply(reply);const actor=await principalFromRequest(request,db),p=request.body;return db.begin(async(tx)=>{
   const c=await googleConnection(tx,actor,request.params.id,true),session=await googleSession(tx,actor,request);
   if(c.version!==p.version)throw new HttpError(409,'GOOGLE_VERSION_CONFLICT');if(c.status==='DISABLED')throw new HttpError(409,'GOOGLE_CONNECTION_DISABLED');
   if(p.clientSecret){const s=sealSecret(c.id,p.clientSecret);await tx`UPDATE connection_secret SET ciphertext=${s.ciphertext},nonce=${s.nonce},auth_tag=${s.authTag},key_version=${s.keyVersion},updated_at=clock_timestamp() WHERE connection_id=${c.id}`;}
   const row=(await tx`UPDATE integration_connection SET name=${checked(p.name)},version=version+1,status='NOT_CONFIGURED',capabilities='{}',last_error_code=NULL,updated_at=clock_timestamp() WHERE id=${c.id} RETURNING *`)[0]!;
   await googleRevision(tx,row,actor,session,checked(p.reason,3,500),!!p.clientSecret);return {id:row.id,version:row.version,status:row.status};
  });
 });
 for(const action of ['disable','reconnect'] as const)app.post<{Params:{id:string};Body:{version:number;reason:string}}>(`/api/google/connections/:id/${action}`,{
  schema:{params,body:{type:'object',additionalProperties:false,required:['version','reason'],properties:{version,reason}}}
 },async(request,reply)=>{
  privateReply(reply);const actor=await principalFromRequest(request,db);return db.begin(async(tx)=>{
   const c=await googleConnection(tx,actor,request.params.id,true),session=await googleSession(tx,actor,request);if(c.version!==request.body.version)throw new HttpError(409,'GOOGLE_VERSION_CONFLICT');
   const row=(await tx`UPDATE integration_connection SET status=${action==='disable'?'DISABLED':'NOT_CONFIGURED'},version=version+1,capabilities='{}',last_error_code=NULL,updated_at=clock_timestamp() WHERE id=${c.id} RETURNING *`)[0]!;
   await googleRevision(tx,row,actor,session,checked(request.body.reason,3,500),false);return {id:row.id,version:row.version,status:row.status};
  });
 });
 app.post<{Params:{id:string};Body:{version:number}}>('/api/google/connections/:id/authorize',{
  schema:{params,body:{type:'object',additionalProperties:false,required:['version'],properties:{version}}},config:{rateLimit:{max:10,timeWindow:'15 minutes'}}
 },async(request,reply)=>{privateReply(reply);const actor=await principalFromRequest(request,db);return startGoogleAuthorization(db,actor,request,request.params.id,request.body.version);});
 app.get<{Querystring:{state:string;code?:string;error?:string}}>('/api/google/callback',{
  schema:{querystring:{type:'object',required:['state'],additionalProperties:{type:'string',maxLength:8192},properties:{state:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},code:text(1,8192),error:text(1,200)}}},config:{rateLimit:{max:30,timeWindow:'15 minutes'}}
 },async(request,reply)=>{
  privateReply(reply);if(request.query.code&&request.query.error)throw new HttpError(400,'GOOGLE_CALLBACK_INVALID');
  const actor=await principalFromRequest(request,db),target=await completeGoogleAuthorization(db,adapter,actor,request,request.query);return reply.redirect(target);
 });
 app.post<{Params:{id:string};Body:{version:number}}>('/api/google/connections/:id/test',{
  schema:{params,body:{type:'object',additionalProperties:false,required:['version'],properties:{version}}},config:{rateLimit:{max:10,timeWindow:'15 minutes'}}
 },async(request,reply)=>{
  privateReply(reply);const actor=await principalFromRequest(request,db),r=await checkGoogleConnection(db,adapter,actor,request,request.params.id,request.body.version);
  if(!r.allowed)throw new HttpError(403,'GOOGLE_ACCESS_REVOKED');return {state:r.state,errorCode:r.errorCode,verification:'Live Verification Pending External Credential/Approval'};
 });
 app.get<{Params:{id:string};Querystring:Page}>('/api/google/connections/:id/operations',{schema:{params,querystring:page}},async(request,reply)=>{
  privateReply(reply);const actor=await principalFromRequest(request,db),limit=request.query.limit??20,cursor=decodeCursor(request.query.cursor);return db.begin(async(tx)=>{
   const c=await googleConnection(tx,actor,request.params.id);await googleSession(tx,actor,request);
   const rows=await tx`SELECT id,kind,state,connection_version,error_code,created_at,expires_at,finished_at,created_at::text AS cursor_time FROM google_oauth_operation WHERE connection_id=${c.id}
    AND (${cursor?.timestamp??null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp??null}::timestamptz,${cursor?.id??null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;
   const items=rows.slice(0,limit),last=items.at(-1);return {items:items.map(({cursor_time,...o})=>o),nextCursor:rows.length>limit&&last?encodeCursor({timestamp:last.cursor_time,id:last.id}):null};
  });
 });
 app.get<{Params:{id:string};Querystring:{before?:number;limit?:number}}>('/api/google/connections/:id/history',{
  schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:version,limit:{type:'integer',minimum:1,maximum:100}}}}
 },async(request,reply)=>{
  privateReply(reply);const actor=await principalFromRequest(request,db),limit=request.query.limit??20;return db.begin(async(tx)=>{
   const c=await googleConnection(tx,actor,request.params.id);await googleSession(tx,actor,request);
   const rows=await tx`SELECT version,name,status,reason,secret_changed,created_at FROM google_connection_revision WHERE connection_id=${c.id}
    AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT ${limit+1}`;
   return {items:rows.slice(0,limit),nextVersion:rows.length>limit?rows[limit-1]!.version:null};
  });
 });
}
