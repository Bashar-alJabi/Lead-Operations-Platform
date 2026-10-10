import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiCustomerTools, emptyAIToolPolicy, inheritAIToolPolicy, normalizeAIToolPolicy } from '../src/ai/tool-policy.js';
test('Customer tool approvals use explicit known names, deterministic isolation, inheritance and empty denial without disabling global guardrails', () => {
  assert.deepEqual(inheritAIToolPolicy(emptyAIToolPolicy(), emptyAIToolPolicy()), { allowedTools: [], source: 'UNCONFIGURED' });
  const branch = normalizeAIToolPolicy({ allowedTools: ['updateQualificationField', 'getCampaignKnowledge', 'requestHumanHandoff'] });
  assert.deepEqual(inheritAIToolPolicy(branch, emptyAIToolPolicy()), { allowedTools: ['getCampaignKnowledge', 'requestHumanHandoff', 'updateQualificationField'], source: 'BRANCH' });
  assert.deepEqual(inheritAIToolPolicy(branch, { allowedTools: [] }), { allowedTools: [], source: 'CAMPAIGN' });
  assert.deepEqual(inheritAIToolPolicy(branch, { allowedTools: ['sendConversationMessage'] }), { allowedTools: ['sendConversationMessage'], source: 'CAMPAIGN' });
  const full = normalizeAIToolPolicy({ allowedTools: [...aiCustomerTools].reverse() }); assert.deepEqual(full.allowedTools, aiCustomerTools);
  assert.deepEqual(branch.allowedTools, ['getCampaignKnowledge', 'requestHumanHandoff', 'updateQualificationField']);
  for (const raw of [null, [], {}, { allowedTools: undefined }, { allowedTools: 'all' }, { allowedTools: [null] }, { allowedTools: ['SQL'] }, { allowedTools: ['confirmPayment'] }, { allowedTools: ['enrollLead'] }, { allowedTools: ['grantPermission'] }, { allowedTools: ['getLeadContext', 'getLeadContext'] }, { allowedTools: [' getLeadContext'] }, { allowedTools: [], noSecrets: false }]) assert.throws(() => normalizeAIToolPolicy(raw));
});
