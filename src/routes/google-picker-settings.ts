import type {FastifyInstance} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest} from '../security.js';
import {sealOpaque} from '../credentials.js';
import {googleConnection,googleSession} from '../google/connections.js';
const params={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}} as const;
export function registerGooglePickerSettingsRoutes(app:FastifyInstance,db:Database) {
 app.get<{Params:{id:string}}>('/api/google/connections/:id/picker',{schema:{params}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   const c=await googleConnection(tx,actor,request.params.id);await googleSession(tx,actor,request);
   const s=(await tx`SELECT version,connection_version,project_number,key_revision,updated_at FROM google_picker_settings WHERE connection_id=${c.id}`)[0];
   return {configured:!!s,verification:s?'CONFIGURED_NOT_VERIFIED':'NOT_CONFIGURED',version:s?.version??0,projectNumber:s?.project_number??null,keyRevision:s?.key_revision??null,
    configuredConnectionVersion:s?.connection_version??null,connectionVersion:c.version,updatedAt:s?.updated_at??null};
  });
 });
 app.put<{Params:{id:string};Body:{version:number;connectionVersion:number;projectNumber:string;apiKey?:string;reason:string}}>('/api/google/connections/:id/picker',{
  schema:{params,body:{type:'object',additionalProperties:false,required:['version','connectionVersion','projectNumber','reason'],properties:{version:{type:'integer',minimum:0},connectionVersion:{type:'integer',minimum:1},
   projectNumber:{type:'string',pattern:'^[1-9][0-9]{0,29}$'},apiKey:{type:'string',pattern:'^[A-Za-z0-9_-]{16,256}$'},reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$'}}}}
 },async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),p=request.body;
  if(p.reason.trim().length<3)throw new HttpError(400,'GOOGLE_TEXT_INVALID');
  return db.begin(async tx=>{
   const c=await googleConnection(tx,actor,request.params.id,true),session=await googleSession(tx,actor,request);
   if(c.version!==p.connectionVersion)throw new HttpError(409,'GOOGLE_VERSION_CONFLICT');if(c.status==='DISABLED')throw new HttpError(409,'GOOGLE_CONNECTION_DISABLED');
   const old=(await tx`SELECT * FROM google_picker_settings WHERE connection_id=${c.id} FOR UPDATE`)[0];if((old?.version??0)!==p.version)throw new HttpError(409,'GOOGLE_PICKER_VERSION_CONFLICT');
   if(!old&&!p.apiKey)throw new HttpError(400,'GOOGLE_PICKER_KEY_REQUIRED');
   const s=p.apiKey?sealOpaque('google-picker:'+c.id,p.apiKey):null,version=(old?.version??0)+1;
   const values={connection_version:c.version,project_number:p.projectNumber,ciphertext:s?.ciphertext??old!.ciphertext,nonce:s?.nonce??old!.nonce,auth_tag:s?.authTag??old!.auth_tag,
    key_version:s?.keyVersion??old!.key_version,key_revision:s?version:old!.key_revision,actor_id:actor.id,session_id:session,actor_role:actor.role,actor_branch_id:actor.branchId,reason:p.reason.trim(),version};
   if(old)await tx`UPDATE google_picker_settings SET ${tx(values)} WHERE connection_id=${c.id}`;
   else await tx`INSERT INTO google_picker_settings ${tx({connection_id:c.id,...values})}`;
   return {version,keyRevision:values.key_revision,configured:true,verification:'CONFIGURED_NOT_VERIFIED'};
  });
 });
 app.get<{Params:{id:string};Querystring:{before?:number;limit?:number}}>('/api/google/connections/:id/picker/history',{
  schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:100}}}}
 },async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),limit=request.query.limit??20;return db.begin(async tx=>{
   const c=await googleConnection(tx,actor,request.params.id);await googleSession(tx,actor,request);
   const rows=await tx`SELECT version,connection_version,project_number,key_revision,secret_changed,actor_id,reason,created_at FROM google_picker_settings_history
    WHERE connection_id=${c.id} AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT ${limit+1}`;
   return {items:rows.slice(0,limit),nextVersion:rows.length>limit?rows[limit-1]!.version:null};
  });
 });
}
