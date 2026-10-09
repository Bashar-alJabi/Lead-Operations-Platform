import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyAIBehaviorPolicy, normalizeAIBehaviorPolicy, inheritAIBehaviorPolicy, evaluateAIBehaviorPolicy, aiMandatoryHandoffTriggers, type AIBehaviorPreviewContext } from '../src/ai/behavior-policy.js';
const policy = { ...emptyAIBehaviorPolicy(), formality: 'Formal approved language', disclosure: { mode: 'FIRST_AI_MESSAGE' as const, text: 'I am the AI assistant.' }, handoff: { initialContactWithoutAgent: false, transitionMessage: 'The team will follow up.', misunderstandingLimit: 3 }, returningContact: { closedConversation: 'REOPEN_EXISTING' as const, closedLead: 'CREATE_NEW' as const } };
const context: AIBehaviorPreviewContext = { leadLifecycle: 'OPEN', controllerType: 'AI', conversationState: 'AI_ACTIVE', resolution: 'UNIQUE', explicitCampaignReference: false, requiredLeadData: false, disclosureAlreadySent: false, humanAvailable: false, trigger: 'NONE', misunderstandingCount: 0, qualificationHandoffRequired: false };
test('AI behavior policy validates strict approved presentation and non-overridable handoff boundaries; inheritance preserves empty overrides and Campaign returning isolation', () => {
  assert.deepEqual(normalizeAIBehaviorPolicy(policy), policy);
  for (const bad of [{ ...policy, disclosure: { ...policy.disclosure, mode: 'HIDE_AI' } }, { ...policy, disclosure: { ...policy.disclosure, text: '  ' } }, { ...policy, formality: '\u0000' }, { ...policy, formality: '\ud800' }, { ...policy, handoff: { ...policy.handoff, stopOnHumanTakeover: false } }, { ...policy, handoff: { ...policy.handoff, misunderstandingLimit: 0 } }, { ...policy, returningContact: { ...policy.returningContact, closedLead: 'AUTO_PAY' } }, { ...policy, allowedTools: ['ALL'] }]) assert.throws(() => normalizeAIBehaviorPolicy(bad));
  const inherited = inheritAIBehaviorPolicy(policy, { ...emptyAIBehaviorPolicy(), formality: '' });
  assert.equal(inherited.effective.formality, ''); assert.equal(inherited.sources.formality, 'CAMPAIGN'); assert.equal(inherited.sources.disclosure, 'BRANCH'); assert.equal(inherited.effective.returningContact, null);
  assert.equal(evaluateAIBehaviorPolicy(policy, context).disclosure, policy.disclosure.text);
  assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, disclosureAlreadySent: true }).disclosure, null);
  assert.equal(evaluateAIBehaviorPolicy({ ...policy, disclosure: { ...policy.disclosure, mode: 'EVERY_AI_MESSAGE' } }, { ...context, disclosureAlreadySent: true }).disclosure, policy.disclosure.text);
  for (const trigger of aiMandatoryHandoffTriggers) { const p = evaluateAIBehaviorPolicy(policy, { ...context, trigger }); assert.equal(p.handoff.action, 'WAITING_FOR_HUMAN'); assert.equal(p.handoff.notifyManager, true); assert.equal(p.handoff.aiMayContinueSensitiveTopic, false); assert.equal(p.sendAllowed, false); }
  assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, trigger: 'UNKNOWN_ANSWER', humanAvailable: true }).handoff.action, 'REQUEST_HANDOFF');
  assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, trigger: 'REPEATED_MISUNDERSTANDING', misunderstandingCount: 2 }).handoff.action, 'NO_HANDOFF_TRIGGER');
  assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, trigger: 'REPEATED_MISUNDERSTANDING', misunderstandingCount: 3 }).handoff.action, 'WAITING_FOR_HUMAN');
  assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, trigger: 'QUALIFICATION', qualificationHandoffRequired: false }).handoff.action, 'NO_HANDOFF_TRIGGER');
  assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, trigger: 'QUALIFICATION', qualificationHandoffRequired: true }).handoff.action, 'WAITING_FOR_HUMAN');
});
test('Returning-contact decisions fail to review on ambiguous or archived context, require explicit closed/new rules and never reactivate AI after handoff or Human control', () => {
  for (const change of [{ resolution: 'AMBIGUOUS' as const }, { resolution: 'UNRESOLVED' as const }, { leadLifecycle: 'ARCHIVED' as const }]) assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, ...change }).returning.action, 'REVIEW');
  assert.equal(evaluateAIBehaviorPolicy(emptyAIBehaviorPolicy(), { ...context, conversationState: 'CLOSED' }).returning.action, 'REVIEW');
  assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, conversationState: 'CLOSED' }).returning.action, 'REOPEN_EXISTING');
  assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, leadLifecycle: 'CLOSED' }).returning.action, 'REVIEW');
  assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, leadLifecycle: 'CLOSED', explicitCampaignReference: true, requiredLeadData: true }).returning.action, 'CREATE_NEW');
  assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, controllerType: 'HUMAN', conversationState: 'HUMAN_ACTIVE' }).returning.action, 'HUMAN');
  for (const conversationState of ['AI_HANDOFF_REQUIRED', 'WAITING_FOR_HUMAN'] as const) assert.equal(evaluateAIBehaviorPolicy(policy, { ...context, conversationState }).returning.action, 'HUMAN_REVIEW');
  assert.equal(evaluateAIBehaviorPolicy(policy, context).returning.action, 'AI_ELIGIBLE'); assert.equal(evaluateAIBehaviorPolicy(policy, context).returning.mutationsAllowed, false);
});
