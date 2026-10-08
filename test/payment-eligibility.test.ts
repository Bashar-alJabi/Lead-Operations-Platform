import test from 'node:test';
import assert from 'node:assert/strict';
import { almaEligibilityMoney,normalizePaymentPlan,normalizeEligibilityRequest,checkedPaymentEligibility } from '../src/payments/eligibility.js';
import { almaConnectionAdapter } from '../src/payments/alma-connection.js';
const plan={ installments:3,deferredMonths:0,deferredDays:0 };
const request={ money:almaEligibilityMoney('100','EUR'),plan };
const result={ schemaVersion:1,profile:'ALMA_ELIGIBILITY_V2',accountRef:'merchant_Synthetic123',mode:'TEST',...request,eligible:true };
test('Alma eligibility enforces exact EUR cents int32 and an explicit bounded plan without default, rounding or unrelated evidence',()=> {
  assert.deepEqual(request.money,{ amount:'100.00',currency:'EUR',minor:'10000',scale:2,quantum:'1' });
  assert.equal(almaEligibilityMoney('21474836.47','EUR').minor,'2147483647');
  for(const [amount,currency] of [['21474836.48','EUR'],['0','EUR'],['1.001','EUR'],['01','EUR'],['1','USD'],['1e2','EUR'],['-1','EUR']])assert.throws(()=>almaEligibilityMoney(amount!,currency!));
  for(const patch of [{ installments:0 },{ installments:65536 },{ installments:1.5 },{ deferredMonths:-1 },{ deferredDays:'0' },{ secret:'untrusted' }])assert.throws(()=>normalizePaymentPlan({ ...plan,...patch }));
  assert.throws(()=>normalizePaymentPlan({}));assert.throws(()=>normalizePaymentPlan(null));
  assert.deepEqual(checkedPaymentEligibility(result,request),result);
  for(const patch of [{ money:{ ...request.money,minor:'9999' } },{ money:{ ...request.money,amount:'100' } },{ money:{ ...request.money,scale:0 } },{ money:{ ...request.money,quantum:'100' } },{ plan:{ ...plan,deferredDays:1 } },
    { eligible:1 },{ eligible:'true' },{ mode:'OTHER' },{ schemaVersion:2 },{ profile:'CLAIM_PAID' },{ accountRef:'../foreign' },{ secret:'private' }])assert.throws(()=>checkedPaymentEligibility({ ...result,...patch },request),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  assert.throws(()=>normalizeEligibilityRequest({ ...request,foo:1 }));
});
test('Alma actual V2 eligibility uses independently read merchant and one selected query, strips fees/reasons/PII and rejects mismatched query results',async(t)=> {
  const credentials={ apiKey:'AlmaSyntheticEligibilityKeyOnly_123456' };const calls:{ url:string;method:string }[]=[];
  let raw:unknown=[{ eligible:true,installments_count:3,deferred_months:0,deferred_days:0,reasons:{ merchant:'private' },payment_plan:[{ private:'never stored' }],customer_total_cost_amount:100 }];
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=> {
    calls.push({ url,method:init.method! });assert.equal(init.redirect,'error');assert.ok(init.signal);
    assert.equal(new Headers(init.headers).get('authorization'),'Alma-Auth '+credentials.apiKey);
    if(url.endsWith('/extended-data')){ assert.equal(init.method,'GET');assert.equal(init.body,undefined);return new Response(JSON.stringify({ id:result.accountRef,bank:'private' })); }
    assert.equal(url,'https://api.sandbox.getalma.eu/v2/payments/eligibility');assert.equal(init.method,'POST');assert.equal(new Headers(init.headers).get('idempotency-key'),null);
    assert.deepEqual(JSON.parse(init.body as string),{ purchase_amount:10000,origin:'online',queries:[{ installments_count:3,deferred_months:0,deferred_days:0 }] });
    return new Response(JSON.stringify(raw));
  });
  const good=await almaConnectionAdapter.inspectEligibility!({ mode:'TEST' },credentials,request);assert.deepEqual(good.eligibility,result);assert.equal(calls.length,2);assert.equal(JSON.stringify(good).includes('private'),false);
  raw=[{ eligible:false,installments_count:3,deferred_months:0,deferred_days:0,reasons:{ merchant:'do not expose' } }];
  assert.equal((await almaConnectionAdapter.inspectEligibility!({ mode:'TEST' },credentials,request)).eligibility.eligible,false);
  for(const value of [null,{},[],[raw,raw],[{ eligible:1,installments_count:3,deferred_months:0,deferred_days:0 }],
    [{ eligible:true,installments_count:4,deferred_months:0,deferred_days:0 }],[{ eligible:true,installments_count:3,deferred_months:1,deferred_days:0 }]]) {
    raw=value;const prior:number=calls.length;await assert.rejects(almaConnectionAdapter.inspectEligibility!({ mode:'TEST' },credentials,request),/PAYMENT_PROVIDER_RESPONSE_INVALID/);assert.equal(calls.length,prior+2);
  }
  const count=calls.length;await assert.rejects(almaConnectionAdapter.inspectEligibility!({ mode:'TEST' },credentials,{ ...request,money:{ ...request.money,minor:'1' } }));assert.equal(calls.length,count);
});
test('Alma eligibility exposes finite transport failures without hidden retries, merchant or raw error disclosure',async(t)=> {
  const credentials={ apiKey:'AlmaSyntheticEligibilityKeyOnly_123456' };let status=401;let throwIo=false;let calls=0;
  t.mock.method(globalThis,'fetch',async(url:string)=>{ calls++;if(url.endsWith('/extended-data'))return new Response(JSON.stringify({ id:result.accountRef }));
    if(throwIo)throw new Error(credentials.apiKey);return new Response(credentials.apiKey,{ status }); });
  for(const [code,expected] of [[401,'AUTH_FAILED'],[403,'AUTH_FAILED'],[429,'RATE_LIMITED'],[503,'UNAVAILABLE'],[200,'RESPONSE_INVALID']] as const) {
    status=code;const prior=calls;await assert.rejects(almaConnectionAdapter.inspectEligibility!({ mode:'LIVE' },credentials,request),new RegExp('PAYMENT_PROVIDER_'+expected));assert.equal(calls,prior+2);
  }
  throwIo=true;const prior=calls;await assert.rejects(almaConnectionAdapter.inspectEligibility!({ mode:'LIVE' },credentials,request),/PAYMENT_PROVIDER_UNAVAILABLE/);assert.equal(calls,prior+2);
});
