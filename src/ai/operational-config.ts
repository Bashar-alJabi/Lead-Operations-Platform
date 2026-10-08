import { createHash } from 'node:crypto';
import { HttpError } from '../security.js';

export const aiTasks=['CONVERSATION','SUMMARIZATION','CLASSIFICATION','ANALYSIS'] as const;
export type AITask=typeof aiTasks[number];
export type AIOperationalConfig={ profiles:Record<AITask,string|null>;language:{ supported:string[];preferred:string;detect:boolean }|null;
  tone:string|null;handoffTargetId:string|null;handoffSlaMinutes:number|null };
export const globalAIGuardrails=Object.freeze({ version:1,permissionBoundary:true,approvedToolsOnly:true,noUnrestrictedDatabase:true,noSecrets:true,
  branchIsolation:true,campaignIsolation:true,publishedKnowledgeOnly:true,noInventedBusinessClaims:true,trustedPaymentConfirmationOnly:true,
  untrustedContentIsData:true,humanTakeoverStopsAutomaticSend:true,centralMessagingPolicyRequired:true,requiredAudit:true });
export function emptyAIOperationalConfig():AIOperationalConfig { return { profiles:{ CONVERSATION:null,SUMMARIZATION:null,CLASSIFICATION:null,ANALYSIS:null },language:null,tone:null,handoffTargetId:null,handoffSlaMinutes:null }; }
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const tag=/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
function keys(value:unknown,expected:string[]):value is Record<string,unknown> { return !!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===expected.length && expected.every((key)=>Object.hasOwn(value,key)); }
export function normalizeAIOperationalConfig(raw:unknown):AIOperationalConfig {
  const invalid=()=>{ throw new HttpError(400,'AI_OPERATIONAL_CONFIG_INVALID'); };
  if(!keys(raw,['profiles','language','tone','handoffTargetId','handoffSlaMinutes']) || !keys(raw.profiles,[...aiTasks]))return invalid();
  for(const task of aiTasks)if(raw.profiles[task]!==null && (typeof raw.profiles[task]!=='string' || !uuid.test(raw.profiles[task])))return invalid();
  if(raw.language!==null) {
    if(!keys(raw.language,['supported','preferred','detect']) || !Array.isArray(raw.language.supported) || raw.language.supported.length<1 || raw.language.supported.length>10
      || raw.language.supported.some((s)=>typeof s!=='string' || s.length>35 || !tag.test(s)) || new Set(raw.language.supported).size!==raw.language.supported.length
      || typeof raw.language.preferred!=='string' || !raw.language.supported.includes(raw.language.preferred) || typeof raw.language.detect!=='boolean')return invalid();
  }
  if(raw.tone!==null && (typeof raw.tone!=='string' || raw.tone.length>2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.tone) || Buffer.from(raw.tone).toString()!==raw.tone))return invalid();
  if(raw.handoffTargetId!==null && (typeof raw.handoffTargetId!=='string' || !uuid.test(raw.handoffTargetId)))return invalid();
  if(raw.handoffSlaMinutes!==null && (!Number.isInteger(raw.handoffSlaMinutes) || (raw.handoffSlaMinutes as number)<1 || (raw.handoffSlaMinutes as number)>2147483647))return invalid();
  return { profiles:{ ...raw.profiles } as AIOperationalConfig['profiles'],language:raw.language ? { ...(raw.language as NonNullable<AIOperationalConfig['language']>),supported:[...(raw.language.supported as string[])] } : null,
    tone:raw.tone===null ? null : (raw.tone as string).trim(),handoffTargetId:raw.handoffTargetId as string|null,handoffSlaMinutes:raw.handoffSlaMinutes as number|null };
}
export function inheritAIOperationalConfig(branch:AIOperationalConfig,campaign:AIOperationalConfig) {
  const effective=emptyAIOperationalConfig(),sources:Record<string,'CAMPAIGN'|'BRANCH'|'UNCONFIGURED'>={};
  for(const task of aiTasks) { effective.profiles[task]=campaign.profiles[task] ?? branch.profiles[task];sources['profiles.'+task]=campaign.profiles[task]!==null ? 'CAMPAIGN' : branch.profiles[task]!==null ? 'BRANCH' : 'UNCONFIGURED'; }
  for(const key of ['language','tone','handoffTargetId','handoffSlaMinutes'] as const) {
    Object.assign(effective,{ [key]:campaign[key] ?? branch[key] });sources[key]=campaign[key]!==null ? 'CAMPAIGN' : branch[key]!==null ? 'BRANCH' : 'UNCONFIGURED';
  }return { effective,sources };
}
export function effectiveConfigHash(snapshot:unknown):string {
  function canonical(value:unknown):unknown { if(Array.isArray(value))return value.map(canonical);if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical((value as Record<string,unknown>)[key])]));return value; }
  return createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex');
}
const nullableUuid={ type:['string','null'],format:'uuid' } as const;
export const aiOperationalSchema={ type:'object',additionalProperties:false,required:['profiles','language','tone','handoffTargetId','handoffSlaMinutes'],properties:{
  profiles:{ type:'object',additionalProperties:false,required:aiTasks,properties:Object.fromEntries(aiTasks.map((task)=>[task,nullableUuid])) },
  language:{ anyOf:[{ type:'null' },{ type:'object',additionalProperties:false,required:['supported','preferred','detect'],properties:{ supported:{ type:'array',minItems:1,maxItems:10,uniqueItems:true,items:{ type:'string',maxLength:35,pattern:'^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' } },preferred:{ type:'string',maxLength:35 },detect:{ type:'boolean' } } }] },
  tone:{ type:['string','null'],maxLength:2000 },handoffTargetId:nullableUuid,handoffSlaMinutes:{ type:['integer','null'],minimum:1,maximum:2147483647 },
} } as const;
