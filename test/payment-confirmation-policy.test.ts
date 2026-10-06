import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentConfirmationTransition } from '../src/payments/confirmation-policy.js';
import type { CheckoutSnapshot } from '../src/payments/checkout-provider.js';
const pending:CheckoutSnapshot={ sessionId:'cs_test_Synthetic123',url:null,expiresAt:'2030-01-01T00:00:00Z',mode:'TEST',currency:'USD',minor:'1250',intentId:'opaque',status:'COMPLETE',paymentStatus:'UNPAID',paymentRef:null };
test('a completed/success-titled event with unpaid provider proof cannot confirm payment',()=> {
  for(const event of ['checkout.session.completed','checkout.session.async_payment_succeeded'])
    assert.deepEqual(paymentConfirmationTransition(pending,event,null),{ observed:'PENDING',apply:true });
  assert.deepEqual(paymentConfirmationTransition(pending,'checkout.session.async_payment_failed','PENDING'),{ observed:'FAILED',apply:true });
  assert.throws(()=>paymentConfirmationTransition({ ...pending,paymentStatus:'PAID' },'checkout.session.completed',null));
  assert.throws(()=>paymentConfirmationTransition({ ...pending,status:'OPEN',paymentStatus:'PAID',paymentRef:'pi_Synthetic123' },'checkout.session.completed',null));
});
test('confirmed payments retain money across every stale failure/expiry; trusted paid proof can confirm prior failure',()=> {
  const paid={ ...pending,paymentStatus:'PAID' as const,paymentRef:'pi_Synthetic123' };
  for(const current of ['PENDING','FAILED','EXPIRED'] as const)assert.deepEqual(paymentConfirmationTransition(paid,'checkout.session.expired',current),{ observed:'CONFIRMED',apply:true });
  for(const event of ['checkout.session.completed','checkout.session.async_payment_failed','checkout.session.expired']) {
    assert.equal(paymentConfirmationTransition(pending,event,'CONFIRMED').apply,false);
    assert.equal(paymentConfirmationTransition({ ...pending,status:'EXPIRED' },event,'CONFIRMED').apply,false);
  }
  assert.equal(paymentConfirmationTransition(paid,'checkout.session.completed','CONFIRMED').apply,false);
  assert.equal(paymentConfirmationTransition({ ...pending,status:'EXPIRED' },'checkout.session.expired','FAILED').apply,false);
  assert.equal(paymentConfirmationTransition(pending,'checkout.session.async_payment_failed','EXPIRED').apply,false);
});
