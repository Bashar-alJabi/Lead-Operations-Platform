import type {FastifyInstance} from 'fastify';
import type {Database} from '../db.js';
import {principalFromRequest,HttpError} from '../security.js';
import {googleSheetsAdapter,type GoogleSheetsAdapter} from '../google/sheets.js';
import {beginGooglePicker,googlePickerStatus,googlePickerBootstrap,cancelGooglePicker,selectGoogleSpreadsheet} from '../google/picker.js';
import {googlePickerDocument} from '../google/picker-document.js';
import {googleConnection,googleSession,googleSetup} from '../google/connections.js';
import {decodeCursor,encodeCursor} from '../pagination.js';
const uuid={type:'string',format:'uuid'} as const,params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const page={type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',maxLength:256}}} as const;
export function registerGooglePickerRoutes(app:FastifyInstance,db:Database,adapter:GoogleSheetsAdapter=googleSheetsAdapter()){
 app.post<{Params:{id:string};Body:{connectionVersion:number;settingsVersion:number;requestId:string;locale:'ar'|'en'|'fr'}}>('/api/google/connections/:id/picker/tickets',{
  schema:{params,body:{type:'object',additionalProperties:false,required:['connectionVersion','settingsVersion','requestId','locale'],properties:{connectionVersion:{type:'integer',minimum:1},settingsVersion:{type:'integer',minimum:1},requestId:uuid,locale:{enum:['ar','en','fr']}}}},config:{rateLimit:{max:10,timeWindow:'15 minutes'}}
 },async(request,reply)=>{reply.header('Cache-Control','private, no-store');return beginGooglePicker(db,await principalFromRequest(request,db),request,request.params.id,request.body);});
 app.get<{Params:{id:string}}>('/api/google/picker/tickets/:id',{schema:{params}},async(request,reply)=>{reply.header('Cache-Control','private, no-store');return googlePickerStatus(db,await principalFromRequest(request,db),request,request.params.id);});
 app.get<{Params:{id:string}}>('/api/google/picker/tickets/:id/open',{schema:{params}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db),t=await googlePickerStatus(db,actor,request,request.params.id);if(!t.current||t.expired||!['WAITING','PICKING'].includes(t.state))throw new HttpError(409,'GOOGLE_PICKER_NOT_OPEN');
  const connectionId=await db.begin(async tx=>{const row=(await tx`SELECT connection_id FROM google_picker_ticket WHERE id=${t.id}`)[0]!;await googleConnection(tx,actor,row.connection_id);await googleSession(tx,actor,request);return row.connection_id as string;});
  const document=googlePickerDocument({ticketId:t.id,connectionId,locale:t.locale,origin:new URL(googleSetup().returnUrl).origin});
  return reply.header('Cache-Control','private, no-store').header('Content-Security-Policy',document.csp).header('Referrer-Policy','strict-origin-when-cross-origin').header('X-Frame-Options','DENY').type('text/html; charset=utf-8').send(document.html);
 });
 app.post<{Params:{id:string};Body:Record<string,never>}>('/api/google/picker/tickets/:id/bootstrap',{
  schema:{params,body:{type:'object',additionalProperties:false,properties:{}}},config:{rateLimit:{max:10,timeWindow:'15 minutes'}}
 },async(request,reply)=>{reply.header('Cache-Control','private, no-store').header('Referrer-Policy','no-referrer');return googlePickerBootstrap(db,await principalFromRequest(request,db),request,request.params.id);});
 app.post<{Params:{id:string};Body:Record<string,never>}>('/api/google/picker/tickets/:id/cancel',{schema:{params,body:{type:'object',additionalProperties:false,properties:{}}}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');return cancelGooglePicker(db,await principalFromRequest(request,db),request,request.params.id);
 });
 app.post<{Params:{id:string};Body:{spreadsheetId:string}}>('/api/google/picker/tickets/:id/selection',{
  schema:{params,body:{type:'object',additionalProperties:false,required:['spreadsheetId'],properties:{spreadsheetId:{type:'string',pattern:'^[A-Za-z0-9_-]{1,200}$'}}}},config:{rateLimit:{max:20,timeWindow:'15 minutes'}}
 },async(request,reply)=>{reply.header('Cache-Control','private, no-store');return selectGoogleSpreadsheet(db,adapter,await principalFromRequest(request,db),request,request.params.id,request.body.spreadsheetId);});
 app.get<{Params:{id:string};Querystring:{limit?:number;cursor?:string}}>('/api/google/connections/:id/resources',{schema:{params,querystring:page}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),limit=request.query.limit??20,cursor=decodeCursor(request.query.cursor);return db.begin(async tx=>{
   const c=await googleConnection(tx,actor,request.params.id);await googleSession(tx,actor,request);
   const rows=await tx`SELECT id,spreadsheet_id,metadata->>'title' AS title,jsonb_array_length(metadata->'sheets') AS sheet_count,active,version,connection_version,updated_at,created_at::text AS cursor_time
    FROM google_resource WHERE connection_id=${c.id} AND (${cursor?.timestamp??null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp??null}::timestamptz,${cursor?.id??null}::uuid))
    ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;const items=rows.slice(0,limit),last=items.at(-1);return {items:items.map(({cursor_time,...r})=>r),nextCursor:rows.length>limit&&last?encodeCursor({timestamp:last.cursor_time,id:last.id}):null};
  });
 });
 app.get<{Params:{id:string}}>('/api/google/resources/:id',{schema:{params}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   const found=(await tx`SELECT connection_id FROM google_resource WHERE id=${request.params.id}`)[0];if(!found)throw new HttpError(404,'GOOGLE_RESOURCE_NOT_FOUND');
   await googleConnection(tx,actor,found.connection_id);await googleSession(tx,actor,request);
   return (await tx`SELECT id,connection_id,spreadsheet_id,metadata-'sheets' AS metadata,jsonb_array_length(metadata->'sheets') AS sheet_count,active,version,connection_version,updated_at FROM google_resource WHERE id=${request.params.id}`)[0];
  });
 });
 app.get<{Params:{id:string};Querystring:{afterIndex?:number;afterId?:number;limit?:number}}>('/api/google/resources/:id/sheets',{
  schema:{params,querystring:{type:'object',additionalProperties:false,properties:{afterIndex:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},afterId:{type:'integer',minimum:0,maximum:2147483647},limit:{type:'integer',minimum:1,maximum:100}}}}
 },async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),q=request.query,limit=q.limit??25;
  if((q.afterIndex===undefined)!==(q.afterId===undefined))throw new HttpError(400,'GOOGLE_CURSOR_INVALID');return db.begin(async tx=>{
   const r=(await tx`SELECT connection_id FROM google_resource WHERE id=${request.params.id}`)[0];if(!r)throw new HttpError(404,'GOOGLE_RESOURCE_NOT_FOUND');await googleConnection(tx,actor,r.connection_id);await googleSession(tx,actor,request);
   const rows=await tx`SELECT s FROM google_resource r CROSS JOIN LATERAL jsonb_array_elements(r.metadata->'sheets') d(s) WHERE r.id=${request.params.id}
    AND (${q.afterIndex??null}::bigint IS NULL OR ((s->>'index')::bigint,(s->>'id')::bigint)>(${q.afterIndex??null}::bigint,${q.afterId??null}::bigint))
    ORDER BY (s->>'index')::bigint,(s->>'id')::bigint LIMIT ${limit+1}`;const items=rows.slice(0,limit).map(r=>r.s),last=items.at(-1);return {items,next:rows.length>limit&&last?{index:last.index,id:last.id}:null};
  });
 });
 app.get<{Params:{id:string};Querystring:{before?:number;limit?:number}}>('/api/google/resources/:id/history',{
  schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:100}}}}
 },async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),limit=request.query.limit??20;return db.begin(async tx=>{
   const r=(await tx`SELECT connection_id FROM google_resource WHERE id=${request.params.id}`)[0];if(!r)throw new HttpError(404,'GOOGLE_RESOURCE_NOT_FOUND');await googleConnection(tx,actor,r.connection_id);await googleSession(tx,actor,request);
   const rows=await tx`SELECT version,active,source_ticket_id,metadata->>'title' AS title,jsonb_array_length(metadata->'sheets') AS sheet_count,actor_id,reason,created_at FROM google_resource_history WHERE resource_id=${request.params.id}
    AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT ${limit+1}`;return {items:rows.slice(0,limit),nextVersion:rows.length>limit?rows[limit-1]!.version:null};
  });
 });
 app.post<{Params:{id:string};Body:{version:number;connectionVersion:number;reason:string}}>('/api/google/resources/:id/disable',{
  schema:{params,body:{type:'object',additionalProperties:false,required:['version','connectionVersion','reason'],properties:{version:{type:'integer',minimum:1},connectionVersion:{type:'integer',minimum:1},reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$'}}}}
 },async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const actor=await principalFromRequest(request,db),p=request.body;if(p.reason.trim().length<3)throw new HttpError(400,'GOOGLE_TEXT_INVALID');return db.begin(async tx=>{
   const found=(await tx`SELECT connection_id FROM google_resource WHERE id=${request.params.id}`)[0];if(!found)throw new HttpError(404,'GOOGLE_RESOURCE_NOT_FOUND');
   const c=await googleConnection(tx,actor,found.connection_id,true),session=await googleSession(tx,actor,request),r=(await tx`SELECT * FROM google_resource WHERE id=${request.params.id} FOR UPDATE`)[0]!;
   if(r.version!==p.version||c.version!==p.connectionVersion)throw new HttpError(409,'GOOGLE_RESOURCE_VERSION_CONFLICT');
   return (await tx`UPDATE google_resource SET active=false,version=version+1,connection_version=${c.version},actor_id=${actor.id},session_id=${session},actor_role=${actor.role},actor_branch_id=${actor.branchId},reason=${p.reason.trim()} WHERE id=${r.id} RETURNING id,version,active`)[0];
  });
 });
}
