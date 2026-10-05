import { createHash } from 'node:crypto';
import { HttpError,type Principal } from '../security.js';
import type { Database } from '../db.js';
import { validateFieldValue,type FieldType,type FieldOption,type FieldValidation } from '../fields.js';
import type { SourceQuestion } from './meta-provider.js';
export const sourceTransforms=['TEXT','NUMBER','BOOLEAN','LIST','CURRENCY'] as const;
export type SourceTransform=typeof sourceTransforms[number];
export type MappingEntry={ sourceKey:string;kind:'CONTACT_NAME'|'CONTACT_PHONE'|'CONTACT_EMAIL'|'LEAD_FIELD';fieldId?:string;
  transform:SourceTransform;optionMap:{ source:string;target:string }[] };
export type MappingTarget={ id:string;key:string;label:string;field_type:FieldType;value_mode:string;options:FieldOption[];
  validation:FieldValidation;version:number;binding_version:number;required_stage:string };
export type SourceValue={ key:string;values:string[] };
export function sourceCatalogHash(questions:SourceQuestion[]):Buffer { return createHash('sha256').update(JSON.stringify(questions)).digest(); }
export function mappingTargetHash(target:MappingTarget):string {
  return createHash('sha256').update(JSON.stringify([target.id,target.field_type,target.value_mode,target.options,target.validation,target.version,target.binding_version,target.required_stage])).digest('hex');
}
export async function mappingTargets(db:Database,actor:Principal,campaignId:string,ids:string[],lock=false):Promise<MappingTarget[]> {
  return loadMappingTargets(db,actor.organizationId,campaignId,ids,actor.role==='MANAGER',lock);
}
// Runtime executes an approved publication within its Campaign, independently of the reviewing user's field visibility.
export async function sourceRuntimeTargets(db:Database,organizationId:string,campaignId:string,ids:string[],lock=false):Promise<MappingTarget[]> {
  return loadMappingTargets(db,organizationId,campaignId,ids,false,lock);
}
async function loadMappingTargets(db:Database,organizationId:string,campaignId:string,ids:string[],manager:boolean,lock:boolean):Promise<MappingTarget[]> {
  if (!ids.length) return [];
  const select=db`SELECT fd.id,fd.key,fd.label,fd.field_type,fd.value_mode,fd.options,fd.validation,fd.version,cf.version AS binding_version,cf.required_stage
    FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id JOIN campaign c ON c.id=cf.campaign_id
    WHERE cf.campaign_id=${campaignId} AND fd.id IN ${db(ids)} AND cf.active AND fd.active AND fd.organization_id=${organizationId}
      AND (fd.branch_id IS NULL OR fd.branch_id=c.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=c.id)
      AND fd.value_mode IN ('SOURCE','MANUAL') AND fd.field_type<>'CALCULATED'
      AND (${!manager} OR (cf.visible_to_manager AND (fd.value_mode='SOURCE' OR cf.editable_by_manager)))`;
  // Lock definitions as well as field bindings to prevent publishing after a concurrent definition change.
  const rows=lock ? await db`${select} ORDER BY fd.id FOR SHARE OF fd,cf` : await select;
  return rows as unknown as MappingTarget[];
}
export function validateMappingEntries(entries:MappingEntry[],questions:SourceQuestion[],targets:MappingTarget[]):string[] {
  const keys=new Map<string,number>();for (const q of questions) if (q.key) keys.set(q.key,(keys.get(q.key) ?? 0)+1);
  const byId=new Map(targets.map((f)=>[f.id,f]));const used=new Set<string>();const warnings=new Set<string>();
  if (questions.some((q)=>!q.key)) warnings.add('SOURCE_QUESTION_KEY_MISSING');
  for (const e of entries) {
    if (keys.get(e.sourceKey)!==1) throw new HttpError(400,'SOURCE_MAPPING_QUESTION_UNKNOWN_OR_AMBIGUOUS');
    if (e.kind!=='LEAD_FIELD' && e.fieldId) throw new HttpError(400,'SOURCE_MAPPING_TARGET_INVALID');
    const key=e.kind==='LEAD_FIELD' ? 'FIELD:'+e.fieldId : e.kind;
    if (used.has(key)) throw new HttpError(400,'SOURCE_MAPPING_DUPLICATE_TARGET');used.add(key);
    const target=e.kind==='LEAD_FIELD' ? byId.get(e.fieldId!) : null;
    if (e.kind==='LEAD_FIELD' && (!target || !['SOURCE','MANUAL'].includes(target.value_mode) || target.field_type==='CALCULATED')) throw new HttpError(404,'SOURCE_MAPPING_TARGET_NOT_FOUND');
    const type=target?.field_type ?? (e.kind==='CONTACT_PHONE' ? 'PHONE' : e.kind==='CONTACT_EMAIL' ? 'EMAIL' : 'TEXT');
    const requiredTransform=['NUMBER','PERCENTAGE','DURATION'].includes(type) ? 'NUMBER' : type==='BOOLEAN' ? 'BOOLEAN'
      : type==='CURRENCY' ? 'CURRENCY' : ['MULTI_SELECT','TAGS'].includes(type) ? 'LIST' : 'TEXT';
    if (e.transform!==requiredTransform) throw new HttpError(400,'SOURCE_MAPPING_TRANSFORM_INVALID');
    if (new Set(e.optionMap.map((o)=>o.source)).size!==e.optionMap.length || e.optionMap.some((o)=>!o.source.trim() || !o.target.trim())) throw new HttpError(400,'SOURCE_MAPPING_OPTION_INVALID');
    if (e.optionMap.length && !['SINGLE_SELECT','MULTI_SELECT','STATUS','INTEREST','TAGS'].includes(type)) throw new HttpError(400,'SOURCE_MAPPING_OPTION_NOT_ALLOWED');
    if (target && type!=='TAGS' && e.optionMap.some((o)=>!target.options.some((allowed)=>allowed.active && allowed.value===o.target))) throw new HttpError(400,'SOURCE_MAPPING_OPTION_INVALID');
    const question=questions.find((q)=>q.key===e.sourceKey)!;
    if (question.type.toUpperCase()==='CUSTOM' || ['NUMBER','BOOLEAN','CURRENCY','LIST'].includes(e.transform)) warnings.add('SOURCE_MAPPING_VALUE_VALIDATION_REQUIRED');
  }
  if (questions.some((q)=>q.key && !entries.some((e)=>e.sourceKey===q.key))) warnings.add('SOURCE_QUESTION_UNMAPPED');
  return [...warnings];
}
export function suggestMapping(question:SourceQuestion,targets:MappingTarget[]):Pick<MappingEntry,'kind'|'fieldId'|'transform'>|null {
  if (!question.key) return null;const key=question.key.normalize('NFKC').toLowerCase().replace(/[\s-]+/g,'_');
  const contact:Record<string,MappingEntry['kind']>={ full_name:'CONTACT_NAME',name:'CONTACT_NAME',phone_number:'CONTACT_PHONE',phone:'CONTACT_PHONE',email:'CONTACT_EMAIL' };
  // Suggestions need explicit user review; aliases are never used to fabricate a provider question key.
  if (Object.hasOwn(contact,key)) return { kind:contact[key]!,transform:'TEXT' };
  const candidates=targets.filter((t)=>t.key===key);if (candidates.length!==1) return null;const target=candidates[0]!;
  return { kind:'LEAD_FIELD',fieldId:target.id,transform:['NUMBER','PERCENTAGE','DURATION'].includes(target.field_type) ? 'NUMBER'
    : target.field_type==='BOOLEAN' ? 'BOOLEAN' : target.field_type==='CURRENCY' ? 'CURRENCY' : ['MULTI_SELECT','TAGS'].includes(target.field_type) ? 'LIST' : 'TEXT' };
}
function convert(entry:MappingEntry,values:string[],target:MappingTarget|null):unknown {
  const list=values.map((v)=>v.trim());const options=new Map(entry.optionMap.map((o)=>[o.source,o.target]));
  if (!list.length || list.every((v)=>!v)) return null;
  if (entry.transform==='LIST') return list.map((v)=>options.get(v) ?? v);
  if (list.length!==1 || !list[0]) throw new HttpError(400,'SOURCE_MAPPING_SCALAR_REQUIRED');const value=list[0];
  if (entry.transform==='TEXT') return options.get(value) ?? value;
  if (entry.transform==='BOOLEAN') { if (!['true','false'].includes(value.toLowerCase())) throw new HttpError(400,'SOURCE_MAPPING_BOOLEAN_INVALID');return value.toLowerCase()==='true'; }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new HttpError(400,'SOURCE_MAPPING_NUMBER_INVALID');
  return entry.transform==='CURRENCY' ? { amount:Number(value),currency:target!.validation.currency } : Number(value);
}
export function previewSourceMapping(entries:MappingEntry[],questions:SourceQuestion[],targets:MappingTarget[],values:SourceValue[],requiredIds:string[]) {
  const warnings=validateMappingEntries(entries,questions,targets);const source=new Map<string,string[]>();
  for (const v of values) { if (source.has(v.key)) throw new HttpError(400,'SOURCE_MAPPING_DUPLICATE_INPUT');source.set(v.key,v.values); }
  const byId=new Map(targets.map((t)=>[t.id,t]));const contact:Partial<Record<'name'|'phone'|'email',string>>={};
  const fields:{ fieldId:string;value:unknown }[]=[];const errors:{ sourceKey:string|null;code:string }[]=[];
  for (const entry of entries) {
    const target=entry.kind==='LEAD_FIELD' ? byId.get(entry.fieldId!)! : null;
    try {
      const converted=convert(entry,source.get(entry.sourceKey) ?? [],target);if (converted===null) continue;
      const type=target?.field_type ?? (entry.kind==='CONTACT_PHONE' ? 'PHONE' : entry.kind==='CONTACT_EMAIL' ? 'EMAIL' : 'TEXT');
      const value=validateFieldValue(type,converted,target?.options ?? [],target?.validation ?? { maxLength:entry.kind==='CONTACT_NAME' ? 200 : 500 });
      if (target) fields.push({ fieldId:target.id,value });else contact[entry.kind==='CONTACT_NAME' ? 'name' : entry.kind==='CONTACT_PHONE' ? 'phone' : 'email']=value as string;
    } catch (error) { if (!(error instanceof HttpError)) throw error;errors.push({ sourceKey:entry.sourceKey,code:error.code }); }
  }
  if (requiredIds.some((id)=>!fields.some((f)=>f.fieldId===id))) errors.push({ sourceKey:null,code:'SOURCE_REQUIRED_VALUE_MISSING' });
  return { valid:errors.length===0,contact,fields,errors,warnings };
}
