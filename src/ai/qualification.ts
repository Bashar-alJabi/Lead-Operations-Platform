import { isDeepStrictEqual } from 'node:util';
import type postgres from 'postgres';
import { HttpError } from '../security.js';
export type QualificationCondition={ questionId:string;operator:'ANSWERED'|'EQUALS';value:postgres.JSONValue };
export type QualificationDefinition={ enabled:boolean;questions:{ id:string;prompt:string;fieldId:string|null;required:boolean }[];
  completion:{ mode:'ALL_REQUIRED'|'CONDITIONS';match:'ALL'|'ANY';conditions:QualificationCondition[] };
  handoff:{ onCompletion:boolean;match:'ALL'|'ANY';conditions:QualificationCondition[] } };
export const emptyQualification=():QualificationDefinition=>({ enabled:false,questions:[],completion:{ mode:'ALL_REQUIRED',match:'ALL',conditions:[] },handoff:{ onCompletion:false,match:'ALL',conditions:[] } });
const invalid=()=>{ throw new HttpError(400,'QUALIFICATION_DEFINITION_INVALID'); };
function exact(v:unknown,keys:string[]):Record<string,unknown> { if(!v || typeof v!=='object' || Array.isArray(v) || Object.keys(v).length!==keys.length || keys.some((k)=>!Object.hasOwn(v,k)))return invalid();return v as Record<string,unknown>; }
const uuid=(v:unknown)=>typeof v==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
export function normalizeQualification(value:unknown):QualificationDefinition {
  const input=exact(value,['enabled','questions','completion','handoff']);if(typeof input.enabled!=='boolean' || !Array.isArray(input.questions) || input.questions.length>40)return invalid();
  const questions=input.questions.map((v)=> { const q=exact(v,['id','prompt','fieldId','required']);if(!uuid(q.id) || typeof q.prompt!=='string' || !q.prompt.trim() || q.prompt.length>500 || /[\u0000-\u001f\u007f]/.test(q.prompt) || Buffer.from(q.prompt).toString()!==q.prompt || q.fieldId!==null && !uuid(q.fieldId) || typeof q.required!=='boolean')return invalid();return { id:q.id as string,prompt:q.prompt.trim(),fieldId:q.fieldId as string|null,required:q.required }; });
  if(new Set(questions.map((q)=>q.id)).size!==questions.length)return invalid();
  const conditions=(value:unknown):QualificationCondition[]=> { if(!Array.isArray(value) || value.length>40)return invalid();return value.map((v)=> {
    const c=exact(v,['questionId','operator','value']);let serialized:string|undefined;try { serialized=JSON.stringify(c.value); }catch { return invalid(); }
    if(!questions.some((q)=>q.id===c.questionId) || !['ANSWERED','EQUALS'].includes(c.operator as string) || c.operator==='ANSWERED' && c.value!==null || c.operator==='EQUALS' && c.value==null || !serialized || Buffer.byteLength(serialized)>4096 || !isDeepStrictEqual(c.value,JSON.parse(serialized)))return invalid();
    return { questionId:c.questionId as string,operator:c.operator as QualificationCondition['operator'],value:JSON.parse(serialized) as postgres.JSONValue };
  }); };
  const c=exact(input.completion,['mode','match','conditions']),h=exact(input.handoff,['onCompletion','match','conditions']);
  if(!['ALL_REQUIRED','CONDITIONS'].includes(c.mode as string) || !['ALL','ANY'].includes(c.match as string) || !['ALL','ANY'].includes(h.match as string) || typeof h.onCompletion!=='boolean')return invalid();
  const completion={ mode:c.mode as QualificationDefinition['completion']['mode'],match:c.match as 'ALL'|'ANY',conditions:conditions(c.conditions) },handoff={ onCompletion:h.onCompletion,match:h.match as 'ALL'|'ANY',conditions:conditions(h.conditions) };
  if(completion.mode==='ALL_REQUIRED' && (completion.conditions.length>0 || completion.match!=='ALL') || input.enabled && (questions.length===0 || completion.mode==='ALL_REQUIRED' && !questions.some((q)=>q.required) || completion.mode==='CONDITIONS' && !completion.conditions.length))return invalid();
  const result={ enabled:input.enabled,questions,completion,handoff };if(Buffer.byteLength(JSON.stringify(result,null,1))>65536)return invalid();return result;
}
const answered=(v:unknown)=>v!==null && v!==undefined && v!=='' && (!Array.isArray(v) || v.length>0);
export function evaluateQualification(definition:QualificationDefinition,answers:Record<string,unknown>) {
  const match=(conditions:QualificationCondition[],mode:'ALL'|'ANY')=>conditions.length>0 && (mode==='ALL' ? conditions.every : conditions.some).call(conditions,(c)=>answered(answers[c.questionId]) && (c.operator==='ANSWERED' || isDeepStrictEqual(c.value,answers[c.questionId])));
  const missing=definition.questions.filter((q)=>q.required && !answered(answers[q.id])).map((q)=>q.id);
  const complete=definition.enabled && missing.length===0 && (definition.completion.mode==='ALL_REQUIRED' ? definition.questions.some((q)=>q.required) : match(definition.completion.conditions,definition.completion.match));
  return { enabled:definition.enabled,complete,missingQuestionIds:missing,handoff:definition.enabled && (definition.handoff.onCompletion && complete || match(definition.handoff.conditions,definition.handoff.match)),previewOnly:true };
}
const conditionSchema={ type:'object',additionalProperties:false,required:['questionId','operator','value'],properties:{ questionId:{ type:'string',format:'uuid' },operator:{ type:'string',enum:['ANSWERED','EQUALS'] },value:{} } } as const;
export const qualificationSchema={ type:'object',additionalProperties:false,required:['enabled','questions','completion','handoff'],properties:{ enabled:{ type:'boolean' },questions:{ type:'array',maxItems:40,items:{ type:'object',additionalProperties:false,required:['id','prompt','fieldId','required'],properties:{ id:{ type:'string',format:'uuid' },prompt:{ type:'string',minLength:1,maxLength:500 },fieldId:{ anyOf:[{ type:'null' },{ type:'string',format:'uuid' }] },required:{ type:'boolean' } } } },
  completion:{ type:'object',additionalProperties:false,required:['mode','match','conditions'],properties:{ mode:{ type:'string',enum:['ALL_REQUIRED','CONDITIONS'] },match:{ type:'string',enum:['ALL','ANY'] },conditions:{ type:'array',maxItems:40,items:conditionSchema } } },
  handoff:{ type:'object',additionalProperties:false,required:['onCompletion','match','conditions'],properties:{ onCompletion:{ type:'boolean' },match:{ type:'string',enum:['ALL','ANY'] },conditions:{ type:'array',maxItems:40,items:conditionSchema } } },
} } as const;
