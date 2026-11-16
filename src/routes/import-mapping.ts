import type {FastifyInstance} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest} from '../security.js';
import {importAvailable,importFile,importScope,importAudit,type ImportFile} from '../imports/service.js';
import {currentImportMapping,importMappingHash,importMappingTargets,validateImportMapping,mapImportRow,importContactMatches,type ImportMappingEntry} from '../imports/mapping.js';

const uuid={type:'string',format:'uuid'} as const;
const params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const sheet={type:'integer',minimum:0,maximum:9} as const;
function ready(j:ImportFile){importAvailable(j);if(j.state!=='REVIEW'||j.purged_at)throw new HttpError(409,'IMPORT_PREVIEW_NOT_READY');}
export function registerImportMappingRoutes(app:FastifyInstance,db:Database){
 const root='/api/lead-imports/:id';
 app.get<{Params:{id:string};Querystring:{after?:string}}>(root+'/fields',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{after:uuid}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id,true);ready(j);
   const items=await tx`SELECT fd.id,fd.key,fd.label,fd.field_type,fd.value_mode,fd.options,fd.validation,cf.required_stage
    FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id JOIN campaign c ON c.id=cf.campaign_id
    WHERE c.id=${j.campaign_id} AND fd.organization_id=${j.organization_id} AND fd.active AND cf.active
     AND (fd.branch_id IS NULL OR fd.branch_id=c.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=c.id)
     AND fd.value_mode IN ('MANUAL','SOURCE') AND fd.field_type<>'CALCULATED'
     AND (${actor.role==='SUPER_ADMIN'} OR cf.visible_to_manager AND (fd.value_mode='SOURCE' OR cf.editable_by_manager))
     AND (${request.query.after??null}::uuid IS NULL OR fd.id>${request.query.after??null}::uuid) ORDER BY fd.id LIMIT 26`;
   return {configurationHash:await importMappingHash(tx,j.id),items:items.slice(0,25),nextId:items.length>25?items[24]!.id:null};
  });
 });
 app.get<{Params:{id:string};Querystring:{sheet:number;before?:number}}>(root+'/mapping',{schema:{params,querystring:{type:'object',additionalProperties:false,required:['sheet'],properties:{sheet,before:{type:'integer',minimum:1}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id,true);ready(j);const index=request.query.sheet;
   if(!(await tx`SELECT 1 FROM lead_import_sheet WHERE file_id=${j.id} AND sheet_index=${index}`).length)throw new HttpError(404,'IMPORT_SHEET_NOT_FOUND');
   const latest=(await tx`SELECT version,configuration_hash,entries FROM lead_import_mapping_revision WHERE file_id=${j.id} AND sheet_index=${index} ORDER BY version DESC LIMIT 1`)[0];
   const config=await importMappingHash(tx,j.id),current=latest?.configuration_hash===config;
   const value=current?await currentImportMapping(tx,j,index):null;
   const history=await tx`SELECT version,created_at FROM lead_import_mapping_revision WHERE file_id=${j.id} AND sheet_index=${index}
    AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT 26`;
   return {version:latest?.version??0,configurationHash:config,configurationChanged:Boolean(latest&&!current),entries:value?.mapping.entries??[],targets:value?.targets??[],history:history.slice(0,25),nextVersion:history.length>25?history[24]!.version:null};
  });
 });
 app.post<{Params:{id:string};Body:{sheet:number;version:number;configurationHash:string;requestId:string;entries:ImportMappingEntry[]}}>(root+'/mapping',{schema:{params,body:{type:'object',additionalProperties:false,required:['sheet','version','configurationHash','requestId','entries'],properties:{
  sheet,version:{type:'integer',minimum:0},requestId:uuid,configurationHash:{type:'string',pattern:'^[a-f0-9]{64}$'},entries:{type:'array',minItems:1,maxItems:64,items:{type:'object',additionalProperties:false,required:['column','kind'],properties:{column:{type:'integer',minimum:0,maximum:63},kind:{type:'string',enum:['CONTACT_NAME','CONTACT_PHONE','CONTACT_EMAIL','LEAD_FIELD']},fieldId:uuid}}},
 }}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id,true);ready(j);const b=request.body,entries=[...b.entries].sort((a,b)=>a.column-b.column);
   const config=await importMappingHash(tx,j.id);if(config!==b.configurationHash)throw new HttpError(409,'IMPORT_MAPPING_CONFIGURATION_CHANGED');
   const old=(await tx`SELECT sheet_index,version,entries=${tx.json(entries)}::jsonb AS same_entries,configuration_hash FROM lead_import_mapping_revision WHERE file_id=${j.id} AND request_key=${b.requestId}`)[0];
   if(old){if(old.sheet_index!==b.sheet||old.version!==b.version+1||old.configuration_hash!==config||!old.same_entries)throw new HttpError(409,'IMPORT_MAPPING_REQUEST_CONFLICT');return {version:old.version};}
   const latest=(await tx`SELECT version FROM lead_import_mapping_revision WHERE file_id=${j.id} AND sheet_index=${b.sheet} ORDER BY version DESC LIMIT 1`)[0];
   if((latest?.version??0)!==b.version)throw new HttpError(409,'IMPORT_MAPPING_VERSION_CONFLICT');
   const s=(await tx`SELECT headers FROM lead_import_sheet WHERE file_id=${j.id} AND sheet_index=${b.sheet}`)[0];if(!s)throw new HttpError(404,'IMPORT_SHEET_NOT_FOUND');
   const targets=await importMappingTargets(tx,j,entries.filter(e=>e.kind==='LEAD_FIELD').map(e=>e.fieldId!));validateImportMapping(entries,s.headers.length,targets);
   const session=await importScope(tx,actor,request,j.branch_id,j.campaign_id);
   await importAudit(tx,j,'IMPORT_MAPPING_SAVED',actor.id,{sheet:b.sheet,version:b.version+1,sessionId:session,requestId:b.requestId,configurationHash:config});
   await tx`INSERT INTO lead_import_mapping_revision(file_id,sheet_index,version,request_key,session_id,entries,configuration_hash)
    VALUES(${j.id},${b.sheet},${b.version+1},${b.requestId},${session},${tx.json(entries)},${config})`;
   return {version:b.version+1};
  });
 });
 app.get<{Params:{id:string};Querystring:{sheet:number;version:number;after?:number}}>(root+'/validation',{schema:{params,querystring:{type:'object',additionalProperties:false,required:['sheet','version'],properties:{sheet,version:{type:'integer',minimum:1},after:{type:'integer',minimum:1,maximum:1048576}}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);reply.header('Cache-Control','no-store');return db.begin(async tx=>{
   const j=await importFile(tx,actor,request,request.params.id,true);ready(j);const q=request.query,current=await currentImportMapping(tx,j,q.sheet);
   if(!current)throw new HttpError(409,'IMPORT_MAPPING_REQUIRED');if(current.mapping.version!==q.version)throw new HttpError(409,'IMPORT_MAPPING_VERSION_CONFLICT');
   const entries=current.mapping.entries as ImportMappingEntry[],targets=current.targets;
   const missing=(await tx`SELECT EXISTS(SELECT 1 FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
    WHERE cf.campaign_id=${j.campaign_id} AND cf.active AND fd.active AND cf.required_stage='LEAD_CREATION'
     AND NOT(fd.id=ANY(${targets.map(t=>t.id)}::uuid[]))) missing`)[0]!.missing as boolean;
   const raw=await tx`SELECT row_number,cells FROM lead_import_row WHERE file_id=${j.id} AND sheet_index=${q.sheet} AND row_number>${q.after??1} ORDER BY row_number LIMIT 26`;
   const rows=raw.slice(0,25).map(r=>mapImportRow(r.row_number,r.cells,entries,targets,missing)),matches=await importContactMatches(tx,actor,j,rows);
   // Review is current data, not a persisted authorization/result. Intake must revalidate and lock identities.
   return {version:q.version,items:rows.map(r=>({...r,match:matches.get(r.rowNumber)??{state:'NO_IDENTIFIER',restricted:false,candidates:[]}})),nextRow:raw.length>25?raw[24]!.row_number:null};
  });
 });
}
