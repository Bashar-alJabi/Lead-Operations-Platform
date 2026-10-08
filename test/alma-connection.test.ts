import test from 'node:test';
import assert from 'node:assert/strict';
import { almaConnectionAdapter,almaOrigin,validateAlmaCredentials } from '../src/payments/alma-connection.js';
import { checkedPaymentAuthentication,paymentConnectionAdapters,validatePaymentCredentials } from '../src/payments/providers.js';
const config={ mode:'TEST' } as const;const credentials={ apiKey:'AlmaSyntheticTestOnlyOpaqueKey_123456' };
const merchant={ id:'merchant_Synthetic123',name:'private merchant name',email:'private@alma.test',can_create_payments:true,bank_account:'private bank data' };

test('Alma opaque key and exact config select fixed origins without assuming mode prefixes or accepting a foreign credential shape',()=> {
  assert.equal(paymentConnectionAdapters.ALMA,almaConnectionAdapter);
  validateAlmaCredentials(config,credentials);validatePaymentCredentials(config,credentials,'ALMA');
  assert.equal(almaOrigin('TEST'),'https://api.sandbox.getalma.eu');assert.equal(almaOrigin('LIVE'),'https://api.getalma.eu');
  assert.throws(()=>almaOrigin('OTHER' as any),/PAYMENT_CONFIG_INVALID/);
  for(const value of [{},null,{ apiKey:'short' },{ apiKey:'\n'+credentials.apiKey },{ apiKey:credentials.apiKey+' ' },{ apiKey:'é'.repeat(30) },{ apiKey:'x'.repeat(4097) },
    { clientId:'SyntheticPair123456',clientSecret:'SyntheticPair123456' },{ ...credentials,clientId:'unwanted' }])
    assert.throws(()=>validateAlmaCredentials(config,value as any),/PAYMENT_CREDENTIAL_MODE_INVALID/);
  for(const value of [null,{ mode:'OTHER' },{ mode:'TEST',expectedMerchantId:'ABCD234EFGH56' },{ mode:'TEST',url:'https://foreign.test' }])
    assert.throws(()=>validateAlmaCredentials(value as any,credentials),/PAYMENT_CONFIG_INVALID/);
  assert.throws(()=>validatePaymentCredentials(config,credentials),/PAYMENT_CREDENTIAL_MODE_INVALID/);
});

test('Alma actual read-only merchant probe returns only a checked versioned identity, no money, capabilities, PII or secret',async(t)=> {
  const urls:string[]=[];t.mock.method(globalThis,'fetch',async(target:string,options:RequestInit)=> {
    urls.push(target);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.signal);assert.equal(options.body,undefined);
    assert.equal((options.headers as Record<string,string>).authorization,'Alma-Auth '+credentials.apiKey);
    return new Response(JSON.stringify(merchant));
  });
  for(const mode of ['TEST','LIVE'] as const) {
    const expected={ schemaVersion:1,profile:'ALMA_ME_V1',accountRef:merchant.id,mode };
    const verified=await almaConnectionAdapter.verify({ mode },credentials);assert.deepEqual(verified,{ mode,authentication:expected });
    assert.deepEqual(checkedPaymentAuthentication(verified.authentication,'ALMA',{ mode }),expected);
  }
  assert.deepEqual(urls,['https://api.sandbox.getalma.eu/v1/me/extended-data','https://api.getalma.eu/v1/me/extended-data']);
  assert.equal(checkedPaymentAuthentication(undefined,'STRIPE',config),null);
  const valid={ schemaVersion:1,profile:'ALMA_ME_V1',accountRef:merchant.id,mode:'TEST' };
  for(const value of [null,[],{}, { ...valid,mode:'LIVE' },{ ...valid,profile:'STRIPE' },{ ...valid,schemaVersion:2 },{ ...valid,accountRef:'../secret' },{ ...valid,secret:credentials.apiKey }])
    assert.throws(()=>checkedPaymentAuthentication(value,'ALMA',config),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  assert.throws(()=>checkedPaymentAuthentication(valid,'PAYPAL',config),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
});

test('Alma HTTP auth/rate/transport/malformed failures are bounded, safe and have one request with no hidden retry',async(t)=> {
  let make=()=>new Response(JSON.stringify(merchant));let calls=0;let transport=false;
  t.mock.method(globalThis,'fetch',async()=>{ calls++;if(transport)throw new Error(credentials.apiKey);return make(); });
  for(const [status,code] of [[401,'AUTH_FAILED'],[403,'AUTH_FAILED'],[429,'RATE_LIMITED'],[500,'UNAVAILABLE'],[302,'UNAVAILABLE']] as const) {
    make=()=>new Response(credentials.apiKey,{ status });const prior=calls;await assert.rejects(almaConnectionAdapter.verify(config,credentials),new RegExp('PAYMENT_PROVIDER_'+code));assert.equal(calls,prior+1);
  }
  for(const value of [null,[],{}, { ...merchant,id:'../../private' },{ ...merchant,id:'<script>' },{ ...merchant,id:'x'.repeat(129) },{ ...merchant,id:5 },'x'.repeat(262145)]) {
    make=()=>new Response(JSON.stringify(value));await assert.rejects(almaConnectionAdapter.verify(config,credentials),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  }
  make=()=>new Response(new Uint8Array([0xff]));await assert.rejects(almaConnectionAdapter.verify(config,credentials),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  transport=true;await assert.rejects(almaConnectionAdapter.verify(config,credentials),(error:unknown)=>error instanceof Error && error.message==='PAYMENT_PROVIDER_UNAVAILABLE');
});
