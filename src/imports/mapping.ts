import type postgres from 'postgres';
import {validateFieldValue,type FieldType,type FieldOption,type FieldValidation} from '../fields.js';
import {normalizeSourceContact,type NormalizedContact} from '../contacts.js';
import {HttpError,type Principal} from '../security.js';
import type {ImportFile} from './service.js';

export type ImportMappingEntry={column:number;kind:'CONTACT_NAME'|'CONTACT_PHONE'|'CONTACT_EMAIL'|'LEAD_FIELD';fieldId?:string};
export type ImportMappingTarget={id:string;key:string;label:string;field_type:FieldType;value_mode:string;options:FieldOption[];validation:FieldValidation;required_stage:string};
export type MappedRow={rowNumber:number;valid:boolean;contact:NormalizedContact|null;fields:{fieldId:string;value:postgres.JSONValue}[];errors:{column:number|null;code:string}[]};

// Same typed domain validator as individual Fields and source intake. No locale guesses or formula evaluation.
export function convertImportCell(raw:string|null,type:FieldType,validation:FieldValidation):unknown{
 const value=raw?.trim();if(!value)return null;
 if(type==='BOOLEAN'){if(!/^(true|false)$/i.test(value))throw new HttpError(400,'IMPORT_BOOLEAN_REQUIRED');return value.toLowerCase()==='true';}
 if(type==='MULTI_SELECT'||type==='TAGS'){
  try{const list:unknown=JSON.parse(value);if(!Array.isArray(list))throw Error();return list;}catch{throw new HttpError(400,'IMPORT_JSON_ARRAY_REQUIRED');}
 }
 if(['NUMBER','PERCENTAGE','DURATION','CURRENCY'].includes(type)){
  if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)||!Number.isFinite(Number(value)))throw new HttpError(400,'IMPORT_DECIMAL_REQUIRED');
  return type==='CURRENCY'?{amount:Number(value),currency:validation.currency}:Number(value);
 }
 return value;
}
export function validateImportMapping(entries:ImportMappingEntry[],width:number,targets:ImportMappingTarget[]){
 if(!entries.length||entries.length>64)throw new HttpError(400,'IMPORT_MAPPING_REQUIRED');
 const columns=new Set<number>(),used=new Set<string>(),byId=new Map(targets.map(t=>[t.id,t]));
 for(const e of entries){
  if(!Number.isInteger(e.column)||e.column<0||e.column>=width||columns.has(e.column))throw new HttpError(400,'IMPORT_MAPPING_COLUMN_INVALID');columns.add(e.column);
  if(!['CONTACT_NAME','CONTACT_PHONE','CONTACT_EMAIL','LEAD_FIELD'].includes(e.kind)||e.kind!=='LEAD_FIELD'&&e.fieldId)throw new HttpError(400,'IMPORT_MAPPING_TARGET_INVALID');
  const key=e.kind==='LEAD_FIELD'?'FIELD:'+e.fieldId:e.kind;if(used.has(key))throw new HttpError(400,'IMPORT_MAPPING_DUPLICATE_TARGET');used.add(key);
  if(e.kind==='LEAD_FIELD'&&!byId.has(e.fieldId!))throw new HttpError(404,'IMPORT_MAPPING_FIELD_NOT_AVAILABLE');
 }
}
export function mapImportRow(rowNumber:number,cells:(string|null)[],entries:ImportMappingEntry[],targets:ImportMappingTarget[],missingRequired:boolean):MappedRow{
 const byId=new Map(targets.map(t=>[t.id,t])),contact:Partial<Record<'name'|'phone'|'email',string>>={},fields:MappedRow['fields']=[],errors:MappedRow['errors']=[];
 for(const e of entries){const target=e.kind==='LEAD_FIELD'?byId.get(e.fieldId!)!:null;
  try{
   const type=target?.field_type??(e.kind==='CONTACT_PHONE'?'PHONE':e.kind==='CONTACT_EMAIL'?'EMAIL':'TEXT');
   const validation=target?.validation??{maxLength:e.kind==='CONTACT_NAME'?200:e.kind==='CONTACT_PHONE'?50:320};
   const converted=convertImportCell(cells[e.column]??null,type,validation);if(converted===null)continue;
   const value=validateFieldValue(type,converted,target?.options??[],validation) as postgres.JSONValue;
   if(target)fields.push({fieldId:target.id,value});else contact[e.kind==='CONTACT_NAME'?'name':e.kind==='CONTACT_PHONE'?'phone':'email']=value as string;
  }catch(e2){if(!(e2 instanceof HttpError))throw e2;errors.push({column:e.column,code:e2.code});}
 }
 if(missingRequired||targets.some(t=>t.required_stage==='LEAD_CREATION'&&!fields.some(f=>f.fieldId===t.id)))errors.push({column:null,code:'IMPORT_REQUIRED_VALUE_MISSING'});
 let normalized:NormalizedContact|null=null;try{normalized=normalizeSourceContact(contact);}catch(e){if(!(e instanceof HttpError))throw e;errors.push({column:null,code:e.code});}
 return {rowNumber,valid:!errors.length,contact:normalized,fields,errors};
}
export async function importMappingHash(tx:postgres.TransactionSql,fileId:string):Promise<string>{return(await tx`SELECT lead_import_mapping_config(j) hash FROM lead_import_file j WHERE id=${fileId}`)[0]!.hash;}
export async function importMappingTargets(tx:postgres.TransactionSql,j:ImportFile,ids:string[]):Promise<ImportMappingTarget[]>{
 if(!ids.length)return [];
 return await tx`SELECT fd.id,fd.key,fd.label,fd.field_type,fd.value_mode,fd.options,fd.validation,cf.required_stage
  FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id JOIN campaign c ON c.id=cf.campaign_id
  WHERE c.id=${j.campaign_id} AND c.organization_id=${j.organization_id} AND fd.organization_id=c.organization_id AND fd.id IN ${tx(ids)}
   AND (fd.branch_id IS NULL OR fd.branch_id=c.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=c.id)
   AND cf.active AND fd.active AND fd.value_mode IN ('MANUAL','SOURCE') AND fd.field_type<>'CALCULATED'
   AND (${j.actor_role==='SUPER_ADMIN'} OR cf.visible_to_manager AND (fd.value_mode='SOURCE' OR cf.editable_by_manager))
  ORDER BY fd.id FOR SHARE OF fd,cf` as unknown as ImportMappingTarget[];
}
export async function currentImportMapping(tx:postgres.TransactionSql,j:ImportFile,sheet:number,version?:number){
 const mapping=(await tx`SELECT version,request_key,entries,configuration_hash,created_at FROM lead_import_mapping_revision
  WHERE file_id=${j.id} AND sheet_index=${sheet} AND (${version??null}::integer IS NULL OR version=${version??null}) ORDER BY version DESC LIMIT 1`)[0];
 if(!mapping)return null;
 if(mapping.configuration_hash!==await importMappingHash(tx,j.id))throw new HttpError(409,'IMPORT_MAPPING_CONFIGURATION_CHANGED');
 const entries=mapping.entries as ImportMappingEntry[],targets=await importMappingTargets(tx,j,entries.filter(e=>e.kind==='LEAD_FIELD').map(e=>e.fieldId!));
 const s=(await tx`SELECT headers FROM lead_import_sheet WHERE file_id=${j.id} AND sheet_index=${sheet}`)[0];
 if(!s)throw new HttpError(404,'IMPORT_SHEET_NOT_FOUND');validateImportMapping(entries,s.headers.length,targets);
 return {mapping,targets};
}
// Read-only advice, not a Contact merge or an approval. Hidden/shared candidates never leave this service.
export async function importContactMatches(tx:postgres.TransactionSql,actor:Principal,j:ImportFile,rows:MappedRow[]){
 const input=rows.filter(r=>r.contact?.phoneNormalized||r.contact?.emailNormalized).map(r=>({row:r.rowNumber,phone:r.contact!.phoneNormalized,email:r.contact!.emailNormalized}));
 if(!input.length)return new Map<number,unknown>();
 const matches=await tx`WITH input AS(SELECT * FROM jsonb_to_recordset(${tx.json(input)}) AS x(row integer,phone text,email text))
  SELECT i.row,CASE WHEN a.n>1 THEN 'AMBIGUOUS' WHEN a.n=1 THEN 'MATCH' ELSE 'NONE' END state,a.restricted,
   COALESCE(v.candidates,'[]'::jsonb) candidates FROM input i
  CROSS JOIN LATERAL(SELECT count(*)::integer n,COALESCE(bool_or(NOT visible),false) restricted FROM
   (SELECT c.id,(${actor.role==='SUPER_ADMIN'} OR EXISTS(SELECT 1 FROM lead l WHERE l.contact_id=c.id AND l.branch_id=${j.branch_id})
    AND NOT EXISTS(SELECT 1 FROM lead l WHERE l.contact_id=c.id AND l.branch_id<>${j.branch_id})) visible
    FROM contact c WHERE c.organization_id=${j.organization_id}
     AND ((i.phone IS NOT NULL AND c.phone_normalized=i.phone) OR (i.email IS NOT NULL AND c.email_normalized=i.email))) found) a
  CROSS JOIN LATERAL(SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'phone',phone,'email',email) ORDER BY id) candidates FROM
   (SELECT c.id,c.name,c.phone,c.email FROM contact c WHERE c.organization_id=${j.organization_id}
    AND ((i.phone IS NOT NULL AND c.phone_normalized=i.phone) OR (i.email IS NOT NULL AND c.email_normalized=i.email))
    AND (${actor.role==='SUPER_ADMIN'} OR EXISTS(SELECT 1 FROM lead l WHERE l.contact_id=c.id AND l.branch_id=${j.branch_id})
     AND NOT EXISTS(SELECT 1 FROM lead l WHERE l.contact_id=c.id AND l.branch_id<>${j.branch_id})) ORDER BY c.id LIMIT 5) visible) v`;
 return new Map(matches.map(m=>[m.row as number,{state:m.restricted?'RESTRICTED':m.state,restricted:m.restricted,candidates:m.candidates}]));
}
