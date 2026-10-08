import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaymentMerchantOffers } from '../src/payments/merchant-offers.js';
import { almaConnectionAdapter } from '../src/payments/alma-connection.js';
const plan={ installments:3,deferredMonths:0,deferredDays:0,allowed:true,minMinor:'10000',maxMinor:'300000' };
const offers={ schemaVersion:1,profile:'ALMA_FEE_PLANS_V1',accountRef:'merchant_Synthetic123',mode:'TEST',plans:[plan] };

test('merchant offers normalize exact bounded plans without fabricated currency, fees or eligibility and reject ambiguous or undeclared shape',()=> {
  assert.deepEqual(normalizePaymentMerchantOffers(offers),offers);
  assert.deepEqual(normalizePaymentMerchantOffers({ ...offers,plans:[] }).plans,[]);
  assert.deepEqual(normalizePaymentMerchantOffers({ ...offers,plans:[{ ...plan,installments:4 },plan] }).plans.map((p)=>p.installments),[3,4]);
  for(const patch of [{ installments:0 },{ installments:1.5 },{ installments:65536 },{ deferredMonths:-1 },{ deferredDays:'30' },{ allowed:1 },
    { minMinor:'01' },{ minMinor:'-1' },{ minMinor:'300001' },{ maxMinor:'9007199254740992' },{ maxMinor:300000 },{ secret:'private' }])
    assert.throws(()=>normalizePaymentMerchantOffers({ ...offers,plans:[{ ...plan,...patch }] }),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  for(const value of [null,[],{}, { ...offers,profile:'STRIPE' },{ ...offers,schemaVersion:2 },{ ...offers,mode:'OTHER' },{ ...offers,accountRef:'../../foreign' },
    { ...offers,currency:'EUR' },{ ...offers,plans:[plan,plan] },{ ...offers,plans:Array(257).fill(plan) },{ ...offers,plans:[null] }])
    assert.throws(()=>normalizePaymentMerchantOffers(value),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
});

test('Alma actual offers probe binds read-only fee plans to independently read merchant and strips all private provider data',async(t)=> {
  const credential={ apiKey:'AlmaSyntheticOffersKeyOnly_123456' };const urls:string[]=[];
  let raw:unknown=[{ kind:'general',installments_count:4,deferred_months:0,deferred_days:0,allowed:1,min_purchase_amount:10000,max_purchase_amount:600000,customer_fee_variable:130,private:'never DTO' },
    { kind:'general',installments_count:1,deferred_months:0,deferred_days:30,allowed:false,min_purchase_amount:5000,max_purchase_amount:300000 }];
  t.mock.method(globalThis,'fetch',async(target:string,options:RequestInit)=> {
    urls.push(target);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);assert.ok(options.signal);
    assert.equal(new Headers(options.headers).get('authorization'),'Alma-Auth '+credential.apiKey);
    if(target.endsWith('/extended-data'))return new Response(JSON.stringify({ id:offers.accountRef,bank:'private' }));
    assert.equal(target,'https://api.sandbox.getalma.eu/v1/me/fee-plans?kind=general&only=all&deferred=true');return new Response(JSON.stringify(raw));
  });
  const inspected=await almaConnectionAdapter.inspectOffers!({ mode:'TEST' },credential);
  assert.equal(inspected.offers.accountRef,inspected.authentication.accountRef);assert.equal(inspected.offers.plans[0]!.installments,1);
  assert.equal(inspected.offers.plans[1]!.allowed,true);assert.equal(inspected.offers.plans[1]!.maxMinor,'600000');
  assert.equal(urls.length,2);assert.equal(JSON.stringify(inspected).includes('private'),false);assert.equal(Object.hasOwn(inspected.offers,'currencies'),false);
  for(const value of [null,{}, [{ kind:'pos' }], [{ kind:'general',installments_count:3,deferred_months:0,deferred_days:0,allowed:'true',min_purchase_amount:1,max_purchase_amount:2 }],
    [{ kind:'general',installments_count:3,deferred_months:0,deferred_days:0,allowed:true,min_purchase_amount:9007199254740992,max_purchase_amount:9007199254740992 }]]) {
    raw=value;const previousCalls:number=urls.length;await assert.rejects(almaConnectionAdapter.inspectOffers!({ mode:'TEST' },credential),/PAYMENT_PROVIDER_RESPONSE_INVALID/);assert.equal(urls.length,previousCalls+2);
  }
});
