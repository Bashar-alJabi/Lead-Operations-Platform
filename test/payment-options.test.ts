import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaymentProviderOptions,stripeConnectionAdapter } from '../src/payments/providers.js';
const config={ mode:'TEST' } as const;const credentials={ apiKey:'rk_test_'+ 'syntheticOptions'.repeat(3) };
const options={ accountRef:'merchant:Independent123',country:'US',defaultCurrency:'USD',currencies:['USD','EUR'],paymentMethods:['card','PAYPAL'],chargesEnabled:false,cardPayments:'UNKNOWN' };
test('Payment provider option normalization is independent of provider identity and retains only safe bounded fields',()=> {
  const normalized=normalizePaymentProviderOptions({ ...options,bank:'unsafe-bank',secret:'never-store',business:{ name:'private' } });
  assert.deepEqual(normalized,{ ...options,currencies:['EUR','USD'],paymentMethods:['PAYPAL','card'] });assert.equal(JSON.stringify(normalized).includes('private'),false);
  for(const data of [null,[],{}, { ...options,accountRef:'https://evil.test' },{ ...options,currencies:[] },{ ...options,currencies:['USD','USD'] },{ ...options,defaultCurrency:'ZZZ' },
    { ...options,currencies:Array(257).fill('USD') },{ ...options,paymentMethods:['bad\nmethod'] },{ ...options,chargesEnabled:'true' },{ ...options,cardPayments:'yes' }])
    assert.throws(()=>normalizePaymentProviderOptions(data),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
});
test('Stripe options use current-key Account then exact Country Spec on fixed hosts and discard financial/PII/provider metadata',async(t)=> {
  const calls:string[]=[];t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=> {
    calls.push(url);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.ok(init.signal);assert.equal((init.headers as Record<string,string>).authorization,'Bearer '+credentials.apiKey);
    const data=url.endsWith('/balance') ? { object:'balance',livemode:false,available:[{ amount:4567 }] } : url.endsWith('/account') ? {
      object:'account',id:'acct_SyntheticOptions123',country:'US',default_currency:'usd',charges_enabled:false,capabilities:{ card_payments:'pending' },business_profile:{ name:'private-business' },email:'private@mail.test',external_accounts:['bank'] }
      : { object:'country_spec',id:'US',supported_payment_currencies:['usd','eur'],supported_payment_methods:['card','ach'],supported_bank_account_currencies:{ private:'bank' } };
    return new Response(JSON.stringify(data));
  });
  assert.deepEqual(await stripeConnectionAdapter.inspect!(config,credentials),{ mode:'TEST',options:{ accountRef:'acct_SyntheticOptions123',country:'US',defaultCurrency:'USD',
    currencies:['EUR','USD'],paymentMethods:['ach','card'],chargesEnabled:false,cardPayments:'PENDING' } });
  assert.deepEqual(calls,['https://api.stripe.com/v1/balance','https://api.stripe.com/v1/account','https://api.stripe.com/v1/country_specs/US']);
});
test('Stripe inspection rejects country/path injection, mismatched specs, mode drift, permission/rate errors and malformed/bounded responses',async(t)=> {
  let account:unknown={ object:'account',id:'acct_Synthetic123',country:'US',default_currency:'usd',charges_enabled:true,capabilities:{} };
  let spec:unknown={ object:'country_spec',id:'US',supported_payment_currencies:['usd'],supported_payment_methods:['card'] };let status=200;let live=false;let oversized=false;
  const calls:string[]=[];t.mock.method(globalThis,'fetch',async(url:string)=> { calls.push(url);if(url.endsWith('/balance'))return new Response(JSON.stringify({ object:'balance',livemode:live }));
    return new Response(oversized ? 'x'.repeat(262145) : JSON.stringify(url.endsWith('/account') ? account : spec),{ status }); });
  for(const bad of [null,[],{ object:'account',id:'acct_Synthetic123',country:'../balance',default_currency:'usd' },{ object:'account',id:'evil-account',country:'US',default_currency:'usd' }]) {
    account=bad;calls.length=0;await assert.rejects(stripeConnectionAdapter.inspect!(config,credentials),/RESPONSE_INVALID/);assert.equal(calls.length,2); }
  account={ object:'account',id:'acct_Synthetic123',country:'US',default_currency:'usd',charges_enabled:true,capabilities:{} };
  for(const bad of [null,[],{ ...(spec as object),id:'GB' },{ ...(spec as object),supported_payment_currencies:['usd','USD'] }]) {
    spec=bad;await assert.rejects(stripeConnectionAdapter.inspect!(config,credentials),/RESPONSE_INVALID/); }
  spec={ object:'country_spec',id:'US',supported_payment_currencies:['usd'],supported_payment_methods:['card'] };
  for(const [code,expected] of [[403,'AUTH_FAILED'],[429,'RATE_LIMITED'],[503,'UNAVAILABLE']] as const) { status=code;await assert.rejects(stripeConnectionAdapter.inspect!(config,credentials),new RegExp(expected)); }
  status=200;oversized=true;await assert.rejects(stripeConnectionAdapter.inspect!(config,credentials),/RESPONSE_INVALID/);oversized=false;live=true;calls.length=0;
  await assert.rejects(stripeConnectionAdapter.inspect!(config,credentials),/MODE_MISMATCH/);assert.equal(calls.length,1);
});
