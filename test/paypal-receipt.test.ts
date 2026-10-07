import test from 'node:test';
import assert from 'node:assert/strict';
import { paypalReceiptAdapter } from '../src/payments/paypal-receipt.js';
import { checkedPaymentReceipt,type PaymentReceiptEnvelope } from '../src/payments/receipt-provider.js';
import { paymentReceiptAdapters } from '../src/payments/receipt-adapters.js';
import { paymentConfirmationTransition } from '../src/payments/confirmation-policy.js';
import { testPayPalEvent } from './paypal-test-support.js';
const hint='72066d41-c5d6-423a-87ea-d56a10a6a67a';
function checked(event:any) {
  return checkedPaymentReceipt(paypalReceiptAdapter,Buffer.from(JSON.stringify(event)),{ externalId:event.id,eventType:event.event_type,mode:'TEST',
    resourceId:event.resource.id,resourceType:event.resource_type.replaceAll('-','.') });
}
test('PayPal capture normalization keeps original capture identity and a separate related-order lookup without money or payee authority',()=> {
  for(const event_type of ['PAYMENT.CAPTURE.COMPLETED','PAYMENT.CAPTURE.PENDING','PAYMENT.CAPTURE.DECLINED']) {
    const event=testPayPalEvent();const decoded=checked({ ...event,event_type,resource:{ ...event.resource,custom_id:hint,tool:'grant payment permissions',amount:{ value:'99999.99',currency_code:'XYZ' } } });
    assert.equal(decoded.resourceId,'SYNTHETICCAPTURE123');assert.equal(decoded.resourceType,'capture');assert.equal(decoded.lookupResourceId,'SYNTHETICORDER123');
    assert.equal(decoded.intentHint,hint);assert.equal(decoded.kind,event_type.endsWith('DECLINED') ? 'PAYMENT_FAILED' : 'RESOURCE_UPDATED');assert.equal(decoded.profileId,'paypal-orders-v2');
    for(const claim of ['99999.99','XYZ','private-buyer','SYNTHETICMERCHANT','grant payment permissions','amount','payment_status'])assert.equal(JSON.stringify(decoded).includes(claim),false);
    assert.equal('paymentStatus' in decoded,false);
  }
  assert.equal(paymentReceiptAdapters.PAYPAL,undefined,'normalization cannot activate financial processing');
});
test('PayPal order approval requests a separate capture flow and cannot drive a paid transition even with a forged paid snapshot',()=> {
  const event={ ...testPayPalEvent(),event_type:'CHECKOUT.ORDER.APPROVED',resource_type:'checkout-order',resource:{ id:'SYNTHETICORDER123',status:'COMPLETED',
    purchase_units:[{ reference_id:hint,custom_id:hint,amount:{ value:'9999.00',currency_code:'USD' } }] } };
  const decoded=checked(event);assert.equal(decoded.kind,'APPROVAL_REQUIRED');assert.equal(decoded.lookupResourceId,event.resource.id);assert.equal(decoded.intentHint,hint);
  assert.equal(decoded.resourceType,'checkout.order');assert.equal(decoded.resourceId,event.resource.id);
  for(const purchase_units of [[],[{ reference_id:hint,custom_id:hint },{ reference_id:hint,custom_id:hint }],[{ reference_id:hint,custom_id:'different' }],[{ reference_id:{ claim:hint },custom_id:hint }]])
    assert.equal(checked({ ...event,resource:{ ...event.resource,purchase_units } }).intentHint,null);
  assert.throws(()=>paymentConfirmationTransition({ sessionId:event.resource.id,url:null,expiresAt:'2030-01-01T00:00:00.000Z',mode:'TEST',currency:'USD',minor:'2500',intentId:hint,
    status:'COMPLETE',paymentStatus:'PAID',paymentRef:'FAKEAPPROVALCLAIM' },decoded.kind,null),/PAYMENT_CAPTURE_CONFIRMATION_REQUIRED/);
});
test('PayPal missing or malformed order references never guess from capture ID or untrusted custom id; unsupported events are lookup-free',()=> {
  const event=testPayPalEvent();const { supplementary_data:ignored,...resource }=event.resource;
  const missing=checked({ ...event,resource:{ ...resource,custom_id:hint } });assert.equal(missing.lookupResourceId,null);assert.equal(missing.intentHint,null);
  for(const order_id of [null,42,'https://foreign.test/order','../order','lowercase','X'.repeat(37),['SYNTHETICORDER123']])
    assert.throws(()=>checked({ ...event,resource:{ ...event.resource,supplementary_data:{ related_ids:{ order_id } } } }),/PAYMENT_RECEIPT_CONTENT_INVALID/);
  for(const custom_id of ['not-a-uuid',null,42,{ uuid:hint }])assert.equal(checked({ ...event,resource:{ ...event.resource,custom_id } }).intentHint,null);
  const unsupported=checked({ ...event,event_type:'PAYMENT.CAPTURE.REFUNDED',resource:{ ...event.resource,custom_id:hint } });
  assert.equal(unsupported.kind,'UNSUPPORTED');assert.equal(unsupported.lookupResourceId,null);assert.equal(unsupported.intentHint,null);
  assert.throws(()=>checked({ ...event,resource:{ ...event.resource,id:'capture-lowercase' } }),/PAYMENT_RECEIPT_CONTENT_INVALID/);
});
test('receipt lookup extension preserves immutable original identity and finite schema checks without leaking undeclared metadata',()=> {
  const event=testPayPalEvent();const raw=Buffer.from(JSON.stringify(event));const expected={ externalId:event.id,eventType:event.event_type,mode:'TEST' as const,
    resourceId:event.resource.id,resourceType:'capture' };const valid=checked(event);
  for(const patch of [{ lookupResourceId:undefined },{ lookupResourceId:42 },{ lookupResourceId:'../secret' },{ lookupResourceId:'X'.repeat(129) },{ lookupResourceId:['order'] },
    { lookupResourceId:null,intentHint:hint },{ resourceId:valid.lookupResourceId },{ resourceType:'checkout.order' },{ kind:'UNSUPPORTED',resourceKind:'UNSUPPORTED',lookupResourceId:'order',intentHint:null }])
    assert.throws(()=>checkedPaymentReceipt({ decode:()=>({ ...valid,...patch }) as PaymentReceiptEnvelope },raw,expected),/PAYMENT_RECEIPT_CONTENT_INVALID/);
  const normalized=checkedPaymentReceipt({ decode:()=>({ ...valid,secret:'raw provider private value' }) },raw,expected);assert.equal(Object.hasOwn(normalized,'secret'),false);
  for(const data of [Buffer.from('null'),Buffer.from([0xff]),Buffer.alloc(65537)])assert.throws(()=>checkedPaymentReceipt(paypalReceiptAdapter,data,expected),/PAYMENT_RECEIPT_CONTENT_INVALID/);
});
