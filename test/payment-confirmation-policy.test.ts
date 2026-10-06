import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentConfirmationTransition } from '../src/payments/confirmation-policy.js';
import type { CheckoutSnapshot } from '../src/payments/checkout-provider.js';
const pending:CheckoutSnapshot={ sessionId:'cs_test_Synthetic123',url:null,expiresAt:'2030-01-01T00:00:00Z',mode:'TEST',currency:'USD',minor:'1250',intentId:'opaque',status:'COMPLETE',paymentStatus:'UNPAID',paymentRef:null };
test('a normalized resource update with unpaid provider proof cannot confirm payment',()=> {
  assert.deepEqual(paymentConfirmationTransition(pending,'RESOURCE_UPDATED',null),{ observed:'PENDING',apply:true });
  assert.deepEqual(paymentConfirmationTransition(pending,'PAYMENT_FAILED','PENDING'),{ observed:'FAILED',apply:true });
  assert.throws(()=>paymentConfirmationTransition({ ...pending,paymentStatus:'PAID' },'RESOURCE_UPDATED',null));
  assert.throws(()=>paymentConfirmationTransition({ ...pending,status:'OPEN',paymentStatus:'PAID',paymentRef:'pi_Synthetic123' },'RESOURCE_UPDATED',null));
  assert.throws(()=>paymentConfirmationTransition({ ...pending,paymentStatus:'PAID',paymentRef:'pi_Synthetic123' },'UNSUPPORTED',null));
});
test('confirmed payments retain money across every stale failure/expiry; trusted paid proof can confirm prior failure',()=> {
  const paid={ ...pending,paymentStatus:'PAID' as const,paymentRef:'pi_Synthetic123' };
  for(const current of ['PENDING','FAILED','EXPIRED'] as const)assert.deepEqual(paymentConfirmationTransition(paid,'RESOURCE_UPDATED',current),{ observed:'CONFIRMED',apply:true });
  for(const event of ['RESOURCE_UPDATED','PAYMENT_FAILED'] as const) {
    assert.equal(paymentConfirmationTransition(pending,event,'CONFIRMED').apply,false);
    assert.equal(paymentConfirmationTransition({ ...pending,status:'EXPIRED' },event,'CONFIRMED').apply,false);
  }
  assert.equal(paymentConfirmationTransition(paid,'RESOURCE_UPDATED','CONFIRMED').apply,false);
  assert.equal(paymentConfirmationTransition({ ...pending,status:'EXPIRED' },'RESOURCE_UPDATED','FAILED').apply,false);
  assert.equal(paymentConfirmationTransition(pending,'PAYMENT_FAILED','EXPIRED').apply,false);
});
