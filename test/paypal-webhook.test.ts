import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPayPalPaymentSignature,PayPalCertificateCache,paypalCertificateUrl,parsePayPalPaymentReceipt } from '../src/payments/paypal-webhook.js';
import { paypalConnectionAdapter } from '../src/payments/paypal-connection.js';
import { checkedWebhookInspection } from '../src/payments/webhook.js';
import { paypalPaymentEvents } from '../src/payments/webhook-profile.js';
import { testPayPalCertificate,testPayPalHeaders,testPayPalInstant,testPayPalEvent,testPayPalCertUrl } from './paypal-test-support.js';
const credentials={ clientId:'SyntheticClient_123456789',clientSecret:'SyntheticSecret_123456789' };const endpointId='SYNTHETICWEBHOOK123';
const callbackUrl='https://app.example.test/api/webhooks/payments/paypal/synthetic';
test('PayPal actual webhook inspection uses fixed OAuth/read endpoint and strips provider metadata without financial readiness',async(t)=> {
  const calls:{ url:string;method:string|undefined }[]=[];let events:unknown=paypalPaymentEvents.map((name)=>({ name,status:'ENABLED' }));
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=> { calls.push({ url,method:init.method });assert.equal(init.redirect,'error');assert.ok(init.signal);
    if(url.endsWith('/v1/oauth2/token'))return new Response(JSON.stringify({ access_token:'SyntheticAccessToken123456',token_type:'Bearer',expires_in:3600,app_id:'APP-Synthetic123' }));
    assert.equal(url,'https://api-m.sandbox.paypal.com/v1/notifications/webhooks/'+endpointId);assert.equal(init.method,'GET');
    assert.equal((init.headers as Record<string,string>).authorization,'Bearer SyntheticAccessToken123456');
    return new Response(JSON.stringify({ id:endpointId,url:callbackUrl,event_types:events,links:[{ href:'http://private.invalid' }],private:'never shown' })); });
  const result=checkedWebhookInspection(await paypalConnectionAdapter.inspectWebhook!({ mode:'TEST' },credentials,endpointId),{ mode:'TEST',endpointId,callbackUrl },'PAYPAL');
  assert.deepEqual(result,{ mode:'TEST',endpointId,url:callbackUrl,enabled:true,enabledEvents:[...paypalPaymentEvents].sort() });assert.equal(calls.length,2);
  assert.throws(()=>checkedWebhookInspection({ ...result,url:'https://wrong.test' },{ mode:'TEST',endpointId,callbackUrl },'PAYPAL'),/PAYMENT_WEBHOOK_ENDPOINT_MISMATCH/);
  assert.throws(()=>checkedWebhookInspection({ ...result,enabledEvents:['PAYMENT.CAPTURE.COMPLETED'] },{ mode:'TEST',endpointId,callbackUrl },'PAYPAL'),/PAYMENT_WEBHOOK_EVENTS_MISSING/);
  events=[null];await assert.rejects(paypalConnectionAdapter.inspectWebhook!({ mode:'TEST' },credentials,endpointId),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  const n=calls.length;await assert.rejects(paypalConnectionAdapter.inspectWebhook!({ mode:'TEST' },credentials,'we_WrongProvider'),/PAYMENT_PROVIDER_RESPONSE_INVALID/);assert.equal(calls.length,n);
});
test('PayPal RSA verifies original bytes and exact webhook context with concurrent bounded certificate reuse',async(t)=> {
  let calls=0;t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=> { calls++;assert.equal(url,testPayPalCertUrl);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.ok(init.signal);return new Response(testPayPalCertificate); });
  const raw=Buffer.from(JSON.stringify(testPayPalEvent(),null,2));const headers=testPayPalHeaders(raw,endpointId);const cache=new PayPalCertificateCache();
  await Promise.all(Array.from({ length:8 },()=>verifyPayPalPaymentSignature(raw,headers,endpointId,'TEST',testPayPalInstant/1000,cache)));assert.equal(calls,1);
  await assert.rejects(verifyPayPalPaymentSignature(Buffer.from(JSON.stringify(testPayPalEvent())),headers,endpointId,'TEST',testPayPalInstant/1000,cache),/SIGNATURE_INVALID/);
  await assert.rejects(verifyPayPalPaymentSignature(raw,headers,'OTHERWEBHOOK123','TEST',testPayPalInstant/1000,cache),/SIGNATURE_INVALID/);
  const old=testPayPalHeaders(raw,endpointId,new Date(testPayPalInstant-73*3600000).toISOString());
  await assert.rejects(verifyPayPalPaymentSignature(raw,old,endpointId,'TEST',testPayPalInstant/1000,cache),/SIGNATURE_INVALID/);
  const future=testPayPalHeaders(raw,endpointId,new Date(testPayPalInstant+301000).toISOString());
  await assert.rejects(verifyPayPalPaymentSignature(raw,future,endpointId,'TEST',testPayPalInstant/1000,cache),/SIGNATURE_INVALID/);
  for(const change of [{ 'paypal-transmission-id':['duplicated'] },{ 'paypal-auth-algo':'none' },{ 'paypal-transmission-sig':headers['paypal-transmission-sig']+'\n' },{ 'paypal-transmission-time':'2026-02-30T00:00:00Z' }])
    await assert.rejects(verifyPayPalPaymentSignature(raw,{ ...headers,...change },endpointId,'TEST',testPayPalInstant/1000,cache),/SIGNATURE_INVALID/);
  assert.equal(calls,1);
});
test('PayPal certificate URLs reject SSRF, wrong environment, redirects and malformed or unavailable certificates without hidden retries',async(t)=> {
  for(const url of ['http://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-A','https://127.0.0.1/v1/notifications/certs/CERT-A',
    testPayPalCertUrl+'?redirect=1',testPayPalCertUrl+'#x',testPayPalCertUrl.replace('api-m.sandbox','api-m'),
    testPayPalCertUrl.replace('CERT-SYNTHETIC-ONLY','%2e%2e'),testPayPalCertUrl.replace('api-m.sandbox.paypal.com','api-m.sandbox.paypal.com.evil.test')])
    assert.throws(()=>paypalCertificateUrl(url,'TEST'),/SIGNATURE_INVALID/);
  const raw=Buffer.from(JSON.stringify(testPayPalEvent()));const headers=testPayPalHeaders(raw,endpointId);let calls=0;let data:string|Error='not a certificate';let status=200;
  t.mock.method(globalThis,'fetch',async()=> { calls++;if(data instanceof Error)throw data;return new Response(data,{ status }); });
  await assert.rejects(verifyPayPalPaymentSignature(raw,headers,endpointId,'TEST',testPayPalInstant/1000,new PayPalCertificateCache()),/SIGNATURE_INVALID/);assert.equal(calls,1);
  data='x'.repeat(16385);await assert.rejects(verifyPayPalPaymentSignature(raw,headers,endpointId,'TEST',testPayPalInstant/1000,new PayPalCertificateCache()),/SIGNATURE_INVALID/);
  data=new Error('private transport detail');await assert.rejects(verifyPayPalPaymentSignature(raw,headers,endpointId,'TEST',testPayPalInstant/1000,new PayPalCertificateCache()),/CERTIFICATE_UNAVAILABLE/);
  data='private provider error';status=503;await assert.rejects(verifyPayPalPaymentSignature(raw,headers,endpointId,'TEST',testPayPalInstant/1000,new PayPalCertificateCache()),/CERTIFICATE_UNAVAILABLE/);assert.equal(calls,4);
});
test('PayPal receipts retain encrypted-source input and canonical duplicate identity without granting money authority',()=> {
  const event=testPayPalEvent();const a=parsePayPalPaymentReceipt(Buffer.from(JSON.stringify(event)),'TEST');
  const b=parsePayPalPaymentReceipt(Buffer.from(JSON.stringify({ resource:event.resource,create_time:event.create_time,resource_type:event.resource_type,event_type:event.event_type,id:event.id,summary:'safe ignored description' },null,2)),'TEST');
  assert.deepEqual(a.semanticHash,b.semanticHash);assert.equal(a.objectType,'capture');assert.equal(a.created,Date.parse(event.create_time)/1000);
  assert.equal((a as unknown as { paymentStatus?:string }).paymentStatus,undefined);assert.equal(a.externalId,event.id);
  for(const change of [{ resource:[] },{ id:'evt_WrongProvider' },{ event_type:'checkout.session.completed' },{ resource_type:'checkout-order' },{ create_time:'2026-02-30T00:00:00Z' }])
    assert.throws(()=>parsePayPalPaymentReceipt(Buffer.from(JSON.stringify({ ...event,...change })),'TEST'),/PAYLOAD_INVALID/);
  assert.throws(()=>parsePayPalPaymentReceipt(Buffer.from([255]),'TEST'),/PAYLOAD_INVALID/);
  assert.throws(()=>parsePayPalPaymentReceipt(Buffer.from('x'.repeat(65537)),'TEST'),/PAYLOAD_INVALID/);
});
test('PayPal certificate cache applies expiry, bounded eviction and concurrent backpressure with no arbitrary URL fetch',async(t)=> {
  let calls=0;let pause=false;const releases:(()=>void)[]=[];
  t.mock.method(globalThis,'fetch',async()=> { calls++;if(pause)await new Promise<void>((resolve)=>releases.push(resolve));return new Response(testPayPalCertificate); });
  const cache=new PayPalCertificateCache();const url=(n:number)=>testPayPalCertUrl+'-'+n;
  for(let n=0;n<129;n++)await cache.read(url(n),testPayPalInstant,'TEST');assert.equal(calls,129);
  await cache.read(url(0),testPayPalInstant,'TEST');assert.equal(calls,130);await cache.read(url(0),testPayPalInstant,'TEST');assert.equal(calls,130);
  await cache.read(url(0),testPayPalInstant+3600001,'TEST');assert.equal(calls,131);
  await assert.rejects(cache.read('https://private.invalid/',testPayPalInstant,'TEST'),/SIGNATURE_INVALID/);assert.equal(calls,131);
  const busy=new PayPalCertificateCache();pause=true;const jobs=Array.from({ length:16 },(_,n)=>busy.read(url(1000+n),testPayPalInstant,'TEST'));
  await assert.rejects(busy.read(url(2000),testPayPalInstant,'TEST'),/CERTIFICATE_BUSY/);
  assert.equal(releases.length,16);releases.forEach((release)=>release());await Promise.all(jobs);
});
