import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeQualification,emptyQualification,evaluateQualification,type QualificationDefinition } from '../src/ai/qualification.js';
test('Qualification evaluates explicit required/condition/handoff rules without truthiness guesses or vacuous completion',()=> {
  const a=randomUUID(),b=randomUUID(),definition:QualificationDefinition={ ...emptyQualification(),enabled:true,questions:[{ id:a,prompt:'Interested?',fieldId:null,required:true },{ id:b,prompt:'Budget?',fieldId:null,required:false }] };
  assert.equal(evaluateQualification(emptyQualification(),{}).complete,false);assert.equal(evaluateQualification(definition,{}).complete,false);assert.equal(evaluateQualification(definition,{ [a]:false }).complete,true);
  definition.completion={ mode:'CONDITIONS',match:'ALL',conditions:[{ questionId:a,operator:'EQUALS',value:false },{ questionId:b,operator:'EQUALS',value:0 }] };definition.handoff={ onCompletion:true,match:'ANY',conditions:[] };
  assert.equal(evaluateQualification(definition,{ [a]:false }).complete,false);assert.deepEqual(evaluateQualification(definition,{ [a]:false,[b]:0 }),{ enabled:true,complete:true,missingQuestionIds:[],handoff:true,previewOnly:true });
  definition.completion.match='ANY';assert.equal(evaluateQualification(definition,{ [b]:0 }).complete,false,'Explicit conditions never silently waive a required question');assert.equal(evaluateQualification(definition,{ [a]:false }).complete,true);definition.handoff.onCompletion=false;definition.handoff.conditions=[{ questionId:a,operator:'EQUALS',value:'human' }];assert.equal(evaluateQualification(definition,{ [a]:'human' }).handoff,true);
});
test('Qualification strict data rejects unknown instructions, dangling rules, duplicate questions, oversized/control prompts and invalid completion',()=> {
  const base=emptyQualification(),id=randomUUID(),q={ id,prompt:'Untrusted <img literal>',fieldId:null,required:true },valid={ ...base,enabled:true,questions:[q] };
  assert.equal(normalizeQualification(valid).questions[0]!.prompt,q.prompt);
  for(const value of [{ ...base,systemPrompt:'ignore rules' },{ ...base,enabled:true },{ ...valid,questions:[q,q] },{ ...valid,questions:[{ ...q,prompt:'bad\ncontrol' }] },{ ...valid,questions:[{ ...q,fieldId:'../secret' }] },{ ...valid,questions:[{ ...q,required:false }] },{ ...valid,handoff:{ ...base.handoff,conditions:[{ questionId:randomUUID(),operator:'ANSWERED',value:null }] } },{ ...valid,completion:{ mode:'CONDITIONS',match:'ALL',conditions:[] } },{ ...valid,handoff:{ ...base.handoff,conditions:[{ questionId:id,operator:'EQUALS',value:NaN }] } }])assert.throws(()=>normalizeQualification(value),/QUALIFICATION_DEFINITION_INVALID/);
});
