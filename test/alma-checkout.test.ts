import test from 'node:test';
import assert from 'node:assert/strict';
import { almaCheckoutAdapter } from '../src/payments/alma-checkout.js';
import { paymentCheckoutAdapters,type CheckoutIntent } from '../src/payments/checkout-provider.js';
import { almaEligibilityMoney } from '../src/payments/eligibility.js';
const merchant='merchant_CheckoutSynthetic123';const paymentId='payment_CheckoutSynthetic123';
const intent:CheckoutIntent={ id:'12345678-1234-4123-8123-123456789abc',accountRef:merchant,money:almaEligibilityMoney('100','EUR'),name:'Explicit Alma plan',
  plan:{ installments:3,deferredMonths:0,deferredDays:0 },successUrl:'https://app.test/?paymentReturn=success',cancelUrl:'https://app.test/?paymentReturn=cancel',ipnUrl:'https://app.test/api/webhooks/payments/alma/test' };
test('Alma generic checkout keeps creation acknowledgement UNPAID and uses one independent snapshot for status and exact financial evidence',async(t)=> {
  let calls=0;let captured=true;
  t.mock.method(globalThis,'fetch',async(target:string)=> {
    calls++;if(target.endsWith('/extended-data'))return new Response(JSON.stringify({ id:merchant }));
    if(target.endsWith('/eligibility'))return new Response(JSON.stringify([{ installments_count:3,deferred_months:0,deferred_days:0,eligible:true }]));
    return new Response(JSON.stringify({ id:paymentId,merchant_id:merchant,purchase_amount:10000,installments_count:3,deferred_months:0,deferred_days:0,
      processing_status:captured ? 'captured' : 'authorized',state:'paid',is_deferred_capture:false,amount_already_refunded:0,is_completely_refunded:false,
      custom_data:{ intentId:intent.id },url:'https://pay.sandbox.getalma.eu/'+paymentId }));
  });
  const config={ mode:'TEST' as const };const credentials={ apiKey:'AlmaCheckoutSyntheticKeyOnly_123456' };
  const ack=await almaCheckoutAdapter.create(config,credentials,intent,async()=>true);
  assert.equal(calls,3);assert.equal(ack.paymentStatus,'UNPAID');assert.equal(ack.paymentRef,null);assert.equal(ack.providerEvidence,undefined);assert.equal(ack.expiresAt,null);
  assert.equal(ack.url,null);assert.equal(ack.status,'COMPLETE');
  const before=calls;const verified=await almaCheckoutAdapter.retrieve(config,credentials,intent,paymentId);
  assert.equal(calls,before+2,'one Merchant and one Payment read, no inconsistent double snapshot');
  assert.equal(verified.paymentStatus,'PAID');assert.equal(verified.providerEvidence!.source,'INDEPENDENT_ALMA_PAYMENT_READ');assert.equal(verified.providerEvidence!.processingStatus,'captured');
  assert.equal(verified.providerEvidence!.captureMode,'AUTOMATIC');
  captured=false;const approved=await almaCheckoutAdapter.retrieve(config,credentials,intent,paymentId);
  assert.equal(approved.paymentStatus,'UNPAID');assert.equal(approved.status,'OPEN');assert.equal(approved.paymentRef,null);assert.equal(approved.providerEvidence!.processingStatus,'authorized');
});
test('Registered Alma checkout requires explicit plan and admission and never assumes a provider write retention guarantee',async(t)=> {
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{ calls++;throw new Error('unexpected financial I/O'); });
  const config={ mode:'TEST' as const };const credentials={ apiKey:'AlmaCheckoutSyntheticKeyOnly_123456' };
  await assert.rejects(almaCheckoutAdapter.create(config,credentials,{ ...intent,plan:undefined },async()=>true),/PAYMENT_INTENT_INVALID/);
  await assert.rejects(almaCheckoutAdapter.create(config,credentials,intent),/PAYMENT_WRITE_ADMISSION_REQUIRED/);assert.equal(calls,0);
  assert.equal(almaCheckoutAdapter.writeReplay,'NEVER');assert.equal(almaCheckoutAdapter.idempotencyRetentionMs,null);assert.equal(paymentCheckoutAdapters.ALMA,almaCheckoutAdapter);
  assert.deepEqual(almaCheckoutAdapter.currencyPrecision('EUR'),{ scale:2,quantum:'1' });assert.throws(()=>almaCheckoutAdapter.currencyPrecision('USD'));
});
