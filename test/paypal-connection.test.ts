import test from 'node:test';
import assert from 'node:assert/strict';
import { paypalConnectionAdapter,paypalAccessToken,validatePayPalCredentials,paypalOrigin } from '../src/payments/paypal-connection.js';
import { validatePaymentCredentials } from '../src/payments/providers.js';
const credentials={ clientId:'SyntheticPayPalClientOnly_123456',clientSecret:'SyntheticPayPalSecretOnly_123456' };
const config={ mode:'TEST' } as const;
const payload={ access_token:'SyntheticAccessTokenOnly_123456',token_type:'Bearer',app_id:'APP-Synthetic123456',expires_in:3600,private:'not-returned' };

test('PayPal credentials are an exact client pair, mode selects fixed hosts and foreign key/URL/config fails before any exchange',()=> {
  validatePayPalCredentials(config,credentials);validatePaymentCredentials(config,credentials,'PAYPAL');
  validatePayPalCredentials({ mode:'TEST',expectedMerchantId:'ABCD234EFGH56' },credentials);
  for(const expectedMerchantId of [null,42,'','ABCD234EFGH5','abcd234efgh56','ABCD234EFGH51','ABCD234EFGHO2','ABCD234EFGHI2','ABCD234EFGH02','<img src=x>'])
    assert.throws(()=>validatePayPalCredentials({ mode:'TEST',expectedMerchantId } as any,credentials),/PAYMENT_CONFIG_INVALID/);
  assert.throws(()=>validatePaymentCredentials({ mode:'TEST',expectedMerchantId:'ABCD234EFGH56' },{ apiKey:'rk_test_'+'SyntheticAccount'.repeat(2) }),/PAYMENT_CONFIG_INVALID/);
  assert.equal(paypalOrigin('LIVE'),'https://api-m.paypal.com');assert.equal(paypalOrigin('TEST'),'https://api-m.sandbox.paypal.com');
  for(const value of [{ apiKey:'rk_test_12345678901234567890' },{ clientId:credentials.clientId },{ ...credentials,apiKey:'unwanted' },{ ...credentials,clientSecret:'secret\ncontrol' },{ ...credentials,clientId:'../../foreign' }])
    assert.throws(()=>validatePayPalCredentials(config,value as typeof credentials),/PAYMENT_CREDENTIAL_MODE_INVALID/);
  const foreign={ ...config,url:'https://foreign.test' };assert.throws(()=>validatePayPalCredentials(foreign,credentials),/PAYMENT_CONFIG_INVALID/);
  assert.throws(()=>validatePaymentCredentials(config,credentials),/PAYMENT_CREDENTIAL_MODE_INVALID/);
});
test('PayPal OAuth exchanges only against selected fixed endpoint and returns safe authentication, never merchant readiness, token or scopes',async(t)=> {
  const urls:string[]=[];t.mock.method(globalThis,'fetch',async(url:string,options:RequestInit)=> {
    urls.push(url);assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.ok(options.signal);
    assert.equal(options.body,'grant_type=client_credentials');assert.equal((options.headers as Record<string,string>).authorization,'Basic '+Buffer.from(credentials.clientId+':'+credentials.clientSecret).toString('base64'));
    return new Response(JSON.stringify({ ...payload,scope:'pretend paid with customer secret' }));
  });
  assert.deepEqual(await paypalConnectionAdapter.verify(config,credentials),{ mode:'TEST' });
  assert.deepEqual(await paypalConnectionAdapter.verify({ ...config,expectedMerchantId:'ABCD234EFGH56' },credentials),{ mode:'TEST' },'a configured payee is not provider verification');
  assert.deepEqual(await paypalConnectionAdapter.verify({ mode:'LIVE' },credentials),{ mode:'LIVE' });
  assert.deepEqual(urls,['https://api-m.sandbox.paypal.com/v1/oauth2/token','https://api-m.sandbox.paypal.com/v1/oauth2/token','https://api-m.paypal.com/v1/oauth2/token']);
  assert.deepEqual(await paypalAccessToken(config,credentials),{ accessToken:payload.access_token,expiresIn:3600,appId:payload.app_id });
});
test('PayPal failures are bounded safe codes with one exchange and no raw secrets or unsafe token response accepted',async(t)=> {
  let response:()=>Response=()=>new Response(JSON.stringify(payload));let failure=false;let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{ calls++;if(failure)throw new Error(credentials.clientSecret);return response(); });
  for(const [status,code] of [[400,'AUTH_FAILED'],[401,'AUTH_FAILED'],[403,'AUTH_FAILED'],[429,'RATE_LIMITED'],[500,'UNAVAILABLE']] as const) {
    response=()=>new Response(credentials.clientSecret,{ status });const before=calls;await assert.rejects(paypalConnectionAdapter.verify(config,credentials),new RegExp('PAYMENT_PROVIDER_'+code));assert.equal(calls,before+1);
  }
  for(const patch of [{ access_token:'bad\nheader' },{ token_type:'Basic' },{ expires_in:0 },{ expires_in:'3600' },{ app_id:'unknown' }]) {
    response=()=>new Response(JSON.stringify({ ...payload,...patch }));await assert.rejects(paypalConnectionAdapter.verify(config,credentials),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  }
  for(const data of [null,[],{},'x'.repeat(65537)]) {
    response=()=>new Response(JSON.stringify(data));await assert.rejects(paypalConnectionAdapter.verify(config,credentials),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  }
  response=()=>new Response(new Uint8Array([0xff]));await assert.rejects(paypalConnectionAdapter.verify(config,credentials),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  failure=true;await assert.rejects(paypalConnectionAdapter.verify(config,credentials),(error:unknown)=>error instanceof Error && error.message==='PAYMENT_PROVIDER_UNAVAILABLE');
});
