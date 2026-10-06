import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaymentMethod,paymentMethodIssues,type PaymentMethodInput } from '../src/payments/methods.js';
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';const b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const input:PaymentMethodInput={ name:'  Tuition <script>  ',branchId:a,connectionId:b,currencies:['USD','EUR'],active:true,
  agents:{ mode:'SELECTED',ids:[b,a.toUpperCase()] },campaigns:{ mode:'ALL',ids:[] },reason:'  reviewed by branch  ' };
test('Payment Method normalization uses known currency codes and deterministic explicit availability without changing untrusted names',()=> {
  const normalized=normalizePaymentMethod(input);assert.equal(normalized.name,'Tuition <script>');assert.equal(normalized.reason,'reviewed by branch');
  assert.deepEqual(normalized.currencies,['EUR','USD']);assert.deepEqual(normalized.agents.ids,[a,b]);assert.deepEqual(input.currencies,['USD','EUR']);
});
test('Payment Method validation rejects unknown/duplicate currencies, malformed/duplicate IDs, empty selected rules, controls and bounds',()=> {
  for(const currencies of [[],['XYZ'],['usd'],['USD','USD'],Array(33).fill('USD')])assert.throws(()=>normalizePaymentMethod({ ...input,currencies }),/PAYMENT_CURRENCIES_INVALID/);
  for(const agents of [{ mode:'ALL',ids:[a] },{ mode:'SELECTED',ids:[] },{ mode:'SELECTED',ids:[a,a.toUpperCase()] },{ mode:'SELECTED',ids:['not-uuid'] },{ mode:'UNKNOWN',ids:[] }])
    assert.throws(()=>normalizePaymentMethod({ ...input,agents:agents as PaymentMethodInput['agents'] }),/PAYMENT_AVAILABILITY_INVALID/);
  assert.throws(()=>normalizePaymentMethod({ ...input,name:'a\nname' }),/NAME_INVALID/);assert.throws(()=>normalizePaymentMethod({ ...input,reason:'  ' }),/REASON_INVALID/);
});
test('Authentication-only health never makes Payment Methods operationally available; configured active and current branch/Connection gates are independent',()=> {
  const row={ active:true,branch_active:true,connection_status:'WARNING',provider:'STRIPE',connection_version:2,webhook_ready:false,capabilities:{ authenticationVerified:true } };
  assert.deepEqual(paymentMethodIssues(row),['PAYMENT_OPTIONS_REQUIRED','PAYMENT_WEBHOOK_VERIFICATION_REQUIRED']);
  assert.deepEqual(paymentMethodIssues({ ...row,active:false,branch_active:false,connection_status:'DISABLED' }),['PAYMENT_METHOD_INACTIVE','BRANCH_DISABLED','CONNECTION_DISABLED','PAYMENT_OPTIONS_REQUIRED','PAYMENT_WEBHOOK_VERIFICATION_REQUIRED']);
  assert.ok(paymentMethodIssues({ ...row,connection_status:'AUTH_EXPIRED' }).includes('PAYMENT_AUTHENTICATION_REQUIRED'));
  assert.deepEqual(paymentMethodIssues({ ...row,connection_status:'CONNECTED',webhook_ready:true,capabilities:{ authenticationVerified:true,paymentOptionsVersion:2,paymentOptions:{ chargesEnabled:true } } }),[]);
});
