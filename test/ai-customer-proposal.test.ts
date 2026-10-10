import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerProviderInput, customerSafeEvidence, validateCustomerProposal, customerProposalSystemInstruction, type CustomerEvidence } from '../src/ai/customer-proposal.js';
import { openAIInferenceAdapter } from '../src/ai/inference-provider.js';

const evidence: CustomerEvidence = { sourceMessageId: 'source', messages: [{ id: 'source', speaker: 'CUSTOMER', text: 'Yes I am interested. I claim I paid.' }],
  references: [{ id: 'section:prices', text: 'Approved price 100 EUR <img literal>' }], questions: [{ id: 'q', prompt: 'Interested?', required: true, field_type: 'BOOLEAN', options: [], validation: {} }] };
const empty = { referenceIds: [], questionId: null, answerValue: null, sourceQuote: null, handoffReason: null };
test('Customer proposals support approved evidence, configured questions, typed source extraction and mandatory handoff without tool or financial authority', () => {
  for (const p of [{ ...empty, decision: 'ANSWER', referenceIds: ['section:prices'] }, { ...empty, decision: 'QUESTION', questionId: 'q' },
    { ...empty, decision: 'QUALIFICATION', questionId: 'q', answerValue: true, sourceQuote: 'Yes I am interested.' }, { ...empty, decision: 'HANDOFF', handoffReason: 'PAYMENT_ISSUE' }]) assert.deepEqual(validateCustomerProposal(p, evidence), p);
  for (const p of [{ ...empty, decision: 'MARK_PAID' }, { ...empty, decision: 'ANSWER', referenceIds: ['foreign-campaign'] },
    { ...empty, decision: 'ANSWER', referenceIds: ['section:prices'], tools: ['SQL'] }, { ...empty, decision: 'ANSWER', referenceIds: ['section:prices', 'section:prices'] },
    { ...empty, decision: 'QUALIFICATION', questionId: 'foreign', answerValue: true, sourceQuote: 'Yes' }, { ...empty, decision: 'QUALIFICATION', questionId: 'q', answerValue: 'yes', sourceQuote: 'Yes' },
    { ...empty, decision: 'QUALIFICATION', questionId: 'q', answerValue: true, sourceQuote: 'invented quote' }, { ...empty, decision: 'HANDOFF', handoffReason: 'UNKNOWN_ANSWER', answerValue: true }]) assert.throws(() => validateCustomerProposal(p, evidence));
  assert.throws(() => validateCustomerProposal({ ...empty, decision: 'QUALIFICATION', questionId: 'q', answerValue: true, sourceQuote: 'Yes' }, { ...evidence, messages: [{ id: 'source', speaker: 'HUMAN', text: 'Yes' }] }));
  const safe = customerSafeEvidence({ ...evidence, messages: [...evidence.messages, { id: 'private', speaker: 'CUSTOMER', text: 'iban=FR7612345678901234567890000' }], references: [...evidence.references, { id: 'secret', text: 'api_key=PRIVATE' }] });
  assert.equal(safe.messages.length, 1); assert.equal(safe.references.length, 1);
  const data = customerProviderInput(safe, { language: { preferred: 'ar' }, tone: 'password=PRIVATE', prohibitedClaims: ['No guarantee', 'access_token=PRIVATE'] });
  assert.equal(data.tone, null); assert.equal(JSON.stringify(data).includes('PRIVATE'), false); assert.equal(JSON.stringify(data).includes('fieldId'), false);
  const capture = { ...empty, decision: 'QUALIFICATION', questionId: 'q', sourceQuote: 'Yes' };
  const typed = (field_type: string, validation = {}) => ({ ...evidence, questions: [{ ...evidence.questions[0]!, field_type, validation }] });
  assert.deepEqual(validateCustomerProposal({ ...capture, answerValue: { amount: 120.25, currency: 'EUR' } }, typed('CURRENCY', { currency: 'EUR' })).answerValue, { amount: 120.25, currency: 'EUR' });
  assert.throws(() => validateCustomerProposal({ ...capture, answerValue: { amount: 120, currency: 'USD' } }, typed('CURRENCY', { currency: 'EUR' })));
  assert.equal(validateCustomerProposal({ ...capture, answerValue: '2026-10-10T12:00:00Z' }, typed('DATETIME')).answerValue, '2026-10-10T12:00:00.000Z');
  assert.equal(validateCustomerProposal({ ...capture, answerValue: '  interested  ' }, typed('TEXT')).answerValue, 'interested');
});
test('Customer Responses adapter has a separate structured proposal operation, stateless request and sanitized failure contract', async t => {
  const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  const proposed = { ...empty, decision: 'HANDOFF', handoffReason: 'UNKNOWN_ANSWER' };
  globalThis.fetch = async (target, init) => {
    assert.equal(String(target), 'https://api.openai.com/v1/responses'); const body = JSON.parse(init!.body as string);
    assert.equal(init!.redirect, 'error'); assert.equal(body.store, false); assert.deepEqual(body.tools, []); assert.equal(body.input[0].content, customerProposalSystemInstruction);
    assert.equal(body.text.format.name, 'customer_proposal'); assert.equal(body.text.format.strict, true); assert.ok(body.text.format.schema.properties.decision.enum.includes('QUALIFICATION'));
    assert.equal(JSON.stringify(body).includes('SyntheticSecretOnly'), false);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(proposed) }] }] }));
  };
  assert.deepEqual(await openAIInferenceAdapter.proposeCustomer!({ credential: 'SyntheticSecretOnly123456', model: 'Synthetic-model', maxOutputTokens: 1024, data: customerProviderInput(evidence, { language: null, tone: null, prohibitedClaims: [] }) }), proposed);
});
