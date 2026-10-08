import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripeConnectionAdapter,validatePaymentCredentials } from '../src/payments/providers.js';
const config={ mode:'TEST' } as const;const credentials={ apiKey:'rk_test_'+ 'syntheticOnly'.repeat(3) };

test('only configured provider profiles accept credentials and reject foreign provider config before I/O',()=> {
  for(const provider of ['MOLLIE','BANK_TRANSFER','constructor'])
    assert.throws(()=>validatePaymentCredentials(config,credentials,provider),/PAYMENT_PROVIDER_UNSUPPORTED/);
  const foreignConfig={ ...config,profileId:'foreign-profile' };
  assert.throws(()=>validatePaymentCredentials(foreignConfig,credentials),/PAYMENT_CONFIG_INVALID/);
  assert.throws(()=>validatePaymentCredentials(null as unknown as typeof config,credentials),/PAYMENT_CONFIG_INVALID/);
});
test('payment API keys are scoped to selected environment and restricted server keys, never publishable/organization/control keys',()=> {
  validatePaymentCredentials(config,credentials);
  for(const apiKey of ['pk_test_'+ 'a'.repeat(20),'sk_live_'+ 'a'.repeat(20),'sk_org_'+ 'a'.repeat(20),'rk_test_short',credentials.apiKey+'\n',' rk_test_'+ 'a'.repeat(20)])
    assert.throws(()=>validatePaymentCredentials(config,{ apiKey }),/PAYMENT_CREDENTIAL_MODE_INVALID/);
});
test('Stripe authentication probe uses fixed GET, no redirects, bounded signal and returns mode without financial data',(t)=> {
  t.mock.method(globalThis,'fetch',async(url:string,options:RequestInit)=> {
    assert.equal(url,'https://api.stripe.com/v1/balance');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    assert.equal((options.headers as Record<string,string>).authorization,'Bearer '+credentials.apiKey);assert.ok(options.signal);
    return new Response(JSON.stringify({ object:'balance',livemode:false,available:[{ amount:999999,currency:'usd' }],pending:[],private:'never-return' }));
  });return assert.doesNotReject(async()=>assert.deepEqual(await stripeConnectionAdapter.verify(config,credentials),{ mode:'TEST' }));
});
test('Stripe probe failures are finite safe codes, including mode drift, malformed/oversized data and network failure',async(t)=> {
  let response=new Response('',{ status:401 });let fail=false;
  t.mock.method(globalThis,'fetch',async()=>{ if(fail)throw new Error('unsafe-provider-secret');return response; });
  for(const [status,code] of [[401,'PAYMENT_PROVIDER_AUTH_FAILED'],[403,'PAYMENT_PROVIDER_AUTH_FAILED'],[429,'PAYMENT_PROVIDER_RATE_LIMITED'],[500,'PAYMENT_PROVIDER_UNAVAILABLE']] as const) {
    response=new Response('unsafe-provider-body',{ status });await assert.rejects(stripeConnectionAdapter.verify(config,credentials),new RegExp(code)); }
  for(const data of [null,[],{}, { object:'balance',livemode:'false' }]) {
    response=new Response(JSON.stringify(data));await assert.rejects(stripeConnectionAdapter.verify(config,credentials),/PAYMENT_PROVIDER_RESPONSE_INVALID/); }
  response=new Response(JSON.stringify({ object:'balance',livemode:true }));await assert.rejects(stripeConnectionAdapter.verify(config,credentials),/PAYMENT_MODE_MISMATCH/);
  response=new Response('x'.repeat(65537));await assert.rejects(stripeConnectionAdapter.verify(config,credentials),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  fail=true;await assert.rejects(stripeConnectionAdapter.verify(config,credentials),/PAYMENT_PROVIDER_UNAVAILABLE/);
});
