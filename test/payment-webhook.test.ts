import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { checkedWebhookInspection,parseStripePaymentReceipt,validateStripeWebhookSecret,verifyStripePaymentSignature } from '../src/payments/webhook.js';
import { stripeConnectionAdapter,stripePaymentEvents } from '../src/payments/providers.js';
const secret='whsec_'+'SyntheticWebhookOnly'.repeat(3);
const raw=Buffer.from(JSON.stringify({ id:'evt_Synthetic123',object:'event',type:'checkout.session.completed',livemode:false,created:1234567890,
  data:{ object:{ id:'cs_test_Synthetic123',object:'checkout.session',amount_total:1250,currency:'usd',customer_email:'private@example.test' } } }));
const sig=(body=raw,time=1234567900)=>`t=${time},v1=${createHmac('sha256',secret).update(time+'.').update(body).digest('hex')}`;
test('Stripe payment signatures use exact raw bytes, bounded constant-time v1 candidates and a nonzero fresh timestamp tolerance',()=> {
  validateStripeWebhookSecret(secret);assert.throws(()=>validateStripeWebhookSecret('whsec_bad'));
  verifyStripePaymentSignature(raw,sig(),secret,1234567900);verifyStripePaymentSignature(raw,sig()+',v1='+'0'.repeat(64),secret,1234567900);
  for(const header of [undefined,sig(raw,1234567599),sig(raw,1234568201),sig()+',t=1234567900','t=nan,v1='+'0'.repeat(64),'x'.repeat(4097)])
    assert.throws(()=>verifyStripePaymentSignature(raw,header,secret,1234567900));
  assert.throws(()=>verifyStripePaymentSignature(Buffer.concat([raw,Buffer.from(' ')]),sig(),secret,1234567900));
  assert.throws(()=>verifyStripePaymentSignature(raw,sig(),secret+'different',1234567900));
});
test('Snapshot payment receipts enforce mode, own account and typed envelope while semantic dedup ignores formatting and mutable delivery counters',()=> {
  const event=parseStripePaymentReceipt(raw,'TEST');assert.equal(event.created,1234567890);assert.equal(event.objectId,'cs_test_Synthetic123');
  const value=JSON.parse(raw.toString());value.pending_webhooks=2;value.request={ id:'different' };
  assert.deepEqual(parseStripePaymentReceipt(Buffer.from(JSON.stringify(value,null,2)),'TEST').semanticHash,event.semanticHash);
  value.data.object.amount_total=2500;assert.notDeepEqual(parseStripePaymentReceipt(Buffer.from(JSON.stringify(value)),'TEST').semanticHash,event.semanticHash);
  for(const patch of [{ livemode:true },{ account:'acct_elsewhere' },{ context:'acct_elsewhere' },{ id:'bad' },{ created:1.2 },{ data:{ object:{ id:'pi_other',object:'payment_intent' } } }])
    assert.throws(()=>parseStripePaymentReceipt(Buffer.from(JSON.stringify({ ...JSON.parse(raw.toString()),...patch })),'TEST'));
  assert.throws(()=>parseStripePaymentReceipt(Buffer.from([0xff]),'TEST'));
  let nested:unknown={};for(let n=0;n<26;n++)nested={ nested };value.data.object.metadata=nested;
  assert.throws(()=>parseStripePaymentReceipt(Buffer.from(JSON.stringify(value)),'TEST'));
});
test('Payment webhook inspections require exact endpoint/mode/URL, supported event subscriptions and enabled status and discard provider extras',async(t)=> {
  const expected={ mode:'TEST' as const,endpointId:'we_Synthetic123',callbackUrl:'https://platform.test/api/webhooks/payments/stripe/id' };
  const value={ mode:expected.mode,endpointId:expected.endpointId,url:expected.callbackUrl,enabled:true,enabledEvents:[...stripePaymentEvents],secret:'private' };
  assert.equal('secret' in checkedWebhookInspection(value,expected),false);
  assert.deepEqual(checkedWebhookInspection({ ...value,enabledEvents:['*'] },expected).enabledEvents,['*']);
  for(const patch of [{ mode:'LIVE' as const },{ endpointId:'we_other' },{ url:'https://elsewhere.test' },{ enabled:false },{ enabledEvents:['checkout.session.completed'] }])
    assert.throws(()=>checkedWebhookInspection({ ...value,...patch },expected));
  let payload:Record<string,unknown>={ object:'webhook_endpoint',id:expected.endpointId,livemode:false,url:expected.callbackUrl,status:'enabled',enabled_events:[...stripePaymentEvents],secret:'private' };
  let status=200;let calls=0;
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=> { calls++;assert.equal(String(input),'https://api.stripe.com/v1/webhook_endpoints/we_Synthetic123');
    assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.ok(init?.signal);return new Response(JSON.stringify(payload),{ status }); });
  const credentials={ apiKey:'rk_test_'+'SyntheticOnly123'.repeat(3) };
  const adapter=await stripeConnectionAdapter.inspectWebhook!({ mode:'TEST' },credentials,expected.endpointId);
  assert.equal('secret' in adapter,false);assert.equal(adapter.enabled,true);
  await assert.rejects(stripeConnectionAdapter.inspectWebhook!({ mode:'TEST' },credentials,'we_../../bad'));assert.equal(calls,1);
  status=403;await assert.rejects(stripeConnectionAdapter.inspectWebhook!({ mode:'TEST' },credentials,expected.endpointId),/PAYMENT_PROVIDER_AUTH_FAILED/);
  status=429;await assert.rejects(stripeConnectionAdapter.inspectWebhook!({ mode:'TEST' },credentials,expected.endpointId),/PAYMENT_PROVIDER_RATE_LIMITED/);
  status=200;payload={ ...payload,livemode:true };await assert.rejects(stripeConnectionAdapter.inspectWebhook!({ mode:'TEST' },credentials,expected.endpointId),/PAYMENT_MODE_MISMATCH/);
  payload={ ...payload,livemode:false,enabled_events:['x'.repeat(300000)] };await assert.rejects(stripeConnectionAdapter.inspectWebhook!({ mode:'TEST' },credentials,expected.endpointId),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
});
