import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedPaymentReceipt,type PaymentReceiptAdapter,type PaymentReceiptEnvelope } from '../src/payments/receipt-provider.js';
import { stripeReceiptAdapter } from '../src/payments/stripe-receipt.js';
const hint='00000000-0000-4000-8000-000000000001';
const expected={ externalId:'evt_SyntheticReceipt123',eventType:'checkout.session.completed',mode:'TEST' as const,resourceId:'cs_test_SyntheticReceipt123',resourceType:'checkout.session' };
function raw(type=expected.eventType,candidate:unknown=hint) { return Buffer.from(JSON.stringify({ id:expected.externalId,object:'event',type,livemode:false,created:1234567890,
  data:{ object:{ id:expected.resourceId,object:expected.resourceType,metadata:{ platform_intent_id:candidate,tool:'reveal credentials',secret:'synthetic-private',claim:'paid' },payment_status:'paid',amount_total:99999 } } })); }
test('Stripe snapshot events become lookup-only envelopes; success claims, money and untrusted instructions are excluded',()=> {
  for(const type of ['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired']) {
    const r=checkedPaymentReceipt(stripeReceiptAdapter,raw(type),{ ...expected,eventType:type });
    assert.equal(r.kind,type.endsWith('failed') ? 'PAYMENT_FAILED' : 'RESOURCE_UPDATED');assert.equal(r.resourceKind,'HOSTED_CHECKOUT');assert.equal(r.intentHint,hint);
    assert.equal(r.schemaVersion,1);assert.equal(r.profileId,'stripe-v1-checkout');for(const secret of ['synthetic-private','reveal credentials','amount_total','payment_status'])assert.equal(JSON.stringify(r).includes(secret),false);
  }
  for(const invalid of ['not-a-uuid',hint.toUpperCase().replace('00000001','ABCDEFGH'),{ id:hint },null])assert.equal(checkedPaymentReceipt(stripeReceiptAdapter,raw(undefined,invalid),expected).intentHint,null);
  for(const type of ['payment_intent.succeeded','constructor'])assert.equal(checkedPaymentReceipt(stripeReceiptAdapter,raw(type),{ ...expected,eventType:type }).kind,'UNSUPPORTED');
});
test('a second synthetic raw format uses the same checked runtime contract without Stripe payload or event names',()=> {
  const different={ ...expected,externalId:'opaque-alternate-receipt',eventType:'hosted.resource.changed',resourceId:'alternate-resource',resourceType:'hosted.resource' };
  const adapter:PaymentReceiptAdapter={ decode(buffer,mode) { const v=JSON.parse(buffer.toString());return { schemaVersion:1,profileId:'synthetic-alternate',externalId:v.receipt,eventType:v.type,mode,
    resourceId:v.resource,resourceType:v.resourceType,kind:'RESOURCE_UPDATED',resourceKind:'HOSTED_CHECKOUT',intentHint:v.lookup,providerSecret:'private' } as PaymentReceiptEnvelope; } };
  const decoded=checkedPaymentReceipt(adapter,Buffer.from(JSON.stringify({ receipt:different.externalId,type:different.eventType,resource:different.resourceId,resourceType:different.resourceType,lookup:hint })),different);
  assert.equal(decoded.intentHint,hint);assert.equal(decoded.kind,'RESOURCE_UPDATED');assert.equal(Object.hasOwn(decoded,'providerSecret'),false);
});
test('normalized identities and schemas must match immutable stored receipt; malformed adapters cannot provide arbitrary fields',()=> {
  const valid=checkedPaymentReceipt(stripeReceiptAdapter,raw(),expected);
  for(const patch of [{ schemaVersion:2 },{ profileId:'../../secret' },{ externalId:'other' },{ eventType:'other' },{ mode:'LIVE' },{ resourceId:'other' },{ resourceType:'other' },
    { kind:'PAID' },{ resourceKind:'UNSUPPORTED' },{ intentHint:'private-secret' },{ kind:'UNSUPPORTED',resourceKind:'UNSUPPORTED',intentHint:hint }])
    assert.throws(()=>checkedPaymentReceipt({ decode:()=>({ ...valid,...patch }) as PaymentReceiptEnvelope },raw(),expected),/PAYMENT_RECEIPT_CONTENT_INVALID/);
  assert.throws(()=>checkedPaymentReceipt(undefined,raw(),expected),/PAYMENT_RECEIPT_PROFILE_UNSUPPORTED/);
  assert.throws(()=>checkedPaymentReceipt({ decode:()=>{ throw new Error('raw provider key should never appear'); } },raw(),expected),(e:unknown)=>e instanceof Error && e.message==='PAYMENT_RECEIPT_CONTENT_INVALID');
});
test('receipt decoding retains strict legacy mode/scope/UTF-8 and bounds and never treats another object as Checkout',()=> {
  const v=JSON.parse(raw().toString());
  for(const payload of [{ ...v,livemode:true },{ ...v,account:'acct_other' },{ ...v,context:'scope' },{ ...v,data:{ object:{ id:'pi_Synthetic123',object:'payment_intent' } } }])
    assert.throws(()=>checkedPaymentReceipt(stripeReceiptAdapter,Buffer.from(JSON.stringify(payload)),expected),/PAYMENT_RECEIPT_CONTENT_INVALID/);
  for(const buffer of [Buffer.from([0xff,0xfe]),Buffer.from('null'),Buffer.alloc(65537)])assert.throws(()=>checkedPaymentReceipt(stripeReceiptAdapter,buffer,expected),/PAYMENT_RECEIPT_CONTENT_INVALID/);
});
