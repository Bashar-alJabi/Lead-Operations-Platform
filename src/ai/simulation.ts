import { HttpError } from '../security.js';
import type { EffectiveCampaignContext } from './effective-context.js';
export type SimulationReference={ id:string;text:string };
export const simulationReasons=['UNKNOWN_ANSWER','OUT_OF_SCOPE','CUSTOMER_REQUEST','COMPLAINT','SENSITIVE_SCENARIO','PRICING_EXCEPTION','LEGAL_EXCEPTION','PAYMENT_ISSUE','LOW_CONFIDENCE'] as const;
export type SimulationProposal={ decision:'ANSWER'|'HANDOFF';referenceIds:string[];handoffReason:typeof simulationReasons[number]|null };
export function simulationQuestion(raw:string):string {
  if(typeof raw!=='string' || raw.length>4000 || raw.trim().length<1 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw) || Buffer.from(raw).toString()!==raw)throw new HttpError(400,'AI_SIMULATION_QUESTION_INVALID');return raw.trim();
}
export function validateSimulationProposal(raw:unknown,references:SimulationReference[]):SimulationProposal {
  const invalid=()=>{ throw new HttpError(502,'AI_SIMULATION_RESPONSE_INVALID'); };
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return invalid();const p=raw as Record<string,unknown>;
  if(Object.keys(p).length!==3 || !['decision','referenceIds','handoffReason'].every(k=>Object.hasOwn(p,k)) || !Array.isArray(p.referenceIds) || p.referenceIds.length>8 || p.referenceIds.some(id=>typeof id!=='string' || !references.some(r=>r.id===id)) || new Set(p.referenceIds).size!==p.referenceIds.length)return invalid();
  if(p.decision==='ANSWER') { if(!p.referenceIds.length || p.handoffReason!==null)return invalid(); }
  else if(p.decision==='HANDOFF') { if(p.referenceIds.length || !simulationReasons.includes(p.handoffReason as typeof simulationReasons[number]))return invalid(); }
  else return invalid();return p as SimulationProposal;
}
export function simulationResult(proposal:SimulationProposal,references:SimulationReference[]) {
  const p=validateSimulationProposal(proposal,references),selected=p.referenceIds.map(id=>references.find(r=>r.id===id)!);
  // The model selects evidence; it cannot add an unverified commercial claim to the displayed answer.
  return { decision:p.decision,handoffReason:p.handoffReason,references:selected,answer:selected.map(r=>r.text).join('\n\n'),
    expectedAction:p.decision==='HANDOFF' ? 'requestHumanHandoff' : null,toolsExecuted:[],sendAllowed:false,mutationsAllowed:false };
}
export const simulationOutputSchema={ type:'object',additionalProperties:false,required:['decision','referenceIds','handoffReason'],properties:{
  decision:{ type:'string',enum:['ANSWER','HANDOFF'] },referenceIds:{ type:'array',items:{ type:'string' } },handoffReason:{ anyOf:[{ type:'null' },{ type:'string',enum:simulationReasons }] },
} };
export function simulationProviderInput(context:EffectiveCampaignContext,question:string,references:SimulationReference[]) {
  // Only Campaign business data crosses this boundary. No user/session IDs, credentials, other tasks or Lead data.
  return { question,references,prohibitedClaims:context.knowledge?.content.prohibitedClaims ?? [],
    language:context.effective.language,tone:context.effective.tone,formality:context.behavior.effective.formality,
    disclosure:context.behavior.effective.disclosure,handoff:context.behavior.effective.handoff,
    qualification:context.qualification.definition,followup:context.followup.definition };
}
