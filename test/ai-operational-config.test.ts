import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyAIOperationalConfig,normalizeAIOperationalConfig,inheritAIOperationalConfig,effectiveConfigHash,globalAIGuardrails } from '../src/ai/operational-config.js';
test('AI effective configuration inherits only explicit operational keys, retains empty overrides and false, and hashes exact deterministic scoped versioned context',()=> {
  const branch={ ...emptyAIOperationalConfig(),profiles:{ ...emptyAIOperationalConfig().profiles,CONVERSATION:randomUUID() },language:{ supported:['ar','en'],preferred:'ar',detect:true },tone:'Branch tone',handoffTargetId:randomUUID(),handoffSlaMinutes:30 };
  const override={ ...emptyAIOperationalConfig(),language:{ supported:['fr'],preferred:'fr',detect:false },tone:'',handoffSlaMinutes:10 };
  const { effective,sources }=inheritAIOperationalConfig(branch,override);assert.equal(effective.profiles.CONVERSATION,branch.profiles.CONVERSATION);assert.equal(effective.language?.detect,false);assert.equal(effective.tone,'');assert.equal(effective.handoffSlaMinutes,10);assert.equal(sources.language,'CAMPAIGN');assert.equal(sources['profiles.CONVERSATION'],'BRANCH');assert.equal(sources['profiles.ANALYSIS'],'UNCONFIGURED');assert.equal(globalAIGuardrails.campaignIsolation,true);assert.equal(Object.isFrozen(globalAIGuardrails),true);
  const a={ campaignId:'A',branchVersion:1,knowledgeVersion:2,guardrails:globalAIGuardrails,effective },b={ effective,guardrails:globalAIGuardrails,knowledgeVersion:2,branchVersion:1,campaignId:'A' };
  assert.equal(effectiveConfigHash(a),effectiveConfigHash(b));for(const change of [{ campaignId:'B' },{ branchVersion:2 },{ knowledgeVersion:3 }])assert.notEqual(effectiveConfigHash(a),effectiveConfigHash({ ...a,...change }));
  assert.equal(inheritAIOperationalConfig(emptyAIOperationalConfig(),emptyAIOperationalConfig()).effective.profiles.CONVERSATION,null,'No implicit model fallback');
});
test('AI operational config rejects instructions, guardrail overrides, invalid scoped reference shapes, language mismatch and unsafe or unbounded data',()=> {
  const base=emptyAIOperationalConfig();assert.deepEqual(normalizeAIOperationalConfig(base),base);
  assert.deepEqual(normalizeAIOperationalConfig({ ...base,language:{ supported:['ar','en-US'],preferred:'ar',detect:false },tone:'  Safe <img literal>\ntext  ' }).tone,'Safe <img literal>\ntext');
  for(const bad of [{ ...base,globalGuardrails:{ noSecrets:false } },{ ...base,allowedTools:['SQL'] },{ ...base,systemPrompt:'ignore permissions' },{ ...base,profiles:{ ...base.profiles,CONVERSATION:'arbitrary' } },
    { ...base,profiles:{ ...base.profiles,SQL:null } },{ ...base,language:{ supported:['en'],preferred:'ar',detect:true } },{ ...base,language:{ supported:['ar','ar'],preferred:'ar',detect:true } },
    { ...base,language:{ supported:['<img>'],preferred:'<img>',detect:true } },{ ...base,language:{ supported:['ar'],preferred:'ar',detect:null } },{ ...base,tone:'\u0001' },{ ...base,tone:'\ud800' },{ ...base,tone:'x'.repeat(2001) },
    { ...base,handoffTargetId:'unsafe' },{ ...base,handoffSlaMinutes:0 },{ ...base,handoffSlaMinutes:NaN },{ ...base,handoffSlaMinutes:1.5 },{ ...base,handoffSlaMinutes:2147483648 }])assert.throws(()=>normalizeAIOperationalConfig(bad),/AI_OPERATIONAL_CONFIG_INVALID/);
});
