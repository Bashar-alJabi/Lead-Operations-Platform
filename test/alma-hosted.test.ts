import test,{ type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { almaHostedAdapter,type AlmaHostedIntent } from '../src/payments/alma-hosted.js';
import { almaEligibilityMoney } from '../src/payments/eligibility.js';
import { PaymentCheckoutError } from '../src/payments/provider-errors.js';
import type { PaymentConfig } from '../src/payments/providers.js';
const credentials={ apiKey:'AlmaSyntheticFinancialKeyOnly_123456' };const config={ mode:'TEST' as const };
const id='payment_AlmaSynthetic123';const merchant='merchant_AlmaSynthetic456';
// Explicit test double for application admission, not a verified runtime authorization.
const admitTestWrite=async()=>true;
const intent:AlmaHostedIntent={ id:'12345678-1234-4123-8123-123456789abc',accountRef:merchant,money:almaEligibilityMoney('100','EUR'),plan:{ installments:3,deferredMonths:0,deferredDays:0 },
  name:'Synthetic hosted method',successUrl:'https://platform.test/?paymentReturn=success',cancelUrl:'https://platform.test/?paymentReturn=cancel',ipnUrl:'https://api.platform.test/webhooks/payments/synthetic' };
const payment=()=>({ id,merchant_id:merchant,purchase_amount:10000,installments_count:3,deferred_months:0,deferred_days:0,
  processing_status:'awaiting_authorization',state:'paid',is_deferred_capture:false,capture_method:'automatic',is_completely_refunded:false,amount_already_refunded:0,
  url:'https://pay.sandbox.getalma.eu/'+id,custom_data:{ intentId:intent.id,instructions:'untrusted' },customer:{ name:'private PII' },fees:{ private:'never proof' },expires_after:2880 });
function fixture(t:TestContext) {
  let raw:unknown=payment();let account=merchant;let eligible=true;let failure=0;let lost=false;const calls:{ url:string;method:string;body:unknown }[]=[];
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> {
    assert.equal(init.redirect,'error');assert.ok(init.signal);assert.equal(new Headers(init.headers).get('authorization'),'Alma-Auth '+credentials.apiKey);
    assert.equal(new Headers(init.headers).get('idempotency-key'),null);calls.push({ url:target,method:init.method!,body:init.body ? JSON.parse(init.body as string) : undefined });
    if(target.endsWith('/extended-data'))return new Response(JSON.stringify({ id:account,bank:'private PII' }));
    if(target.endsWith('/eligibility')){ const request=JSON.parse(init.body as string);return new Response(JSON.stringify([{ ...request.queries[0],eligible,customer_fee:'private PII' }])); }
    assert.ok([ 'https://api.sandbox.getalma.eu/v1/payments','https://api.sandbox.getalma.eu/v1/payments/'+id ].includes(target));
    if(lost)throw new Error(credentials.apiKey);if(failure)return new Response(credentials.apiKey,{ status:failure });return new Response(JSON.stringify(raw));
  });
  return { calls,set:(values:{ raw?:unknown;account?:string;eligible?:boolean;failure?:number;lost?:boolean })=>{ if(Object.hasOwn(values,'raw'))raw=values.raw;if(values.account!==undefined)account=values.account;
    if(values.eligible!==undefined)eligible=values.eligible;if(values.failure!==undefined)failure=values.failure;if(values.lost!==undefined)lost=values.lost; } };
}
test('Alma actual hosted creation performs fresh merchant/eligibility preflight and one explicit automatic write without fake guarantee, expiry or Paid from acknowledgement',async(t)=> {
  const transport=fixture(t);const result=await almaHostedAdapter.create(config,credentials,intent,admitTestWrite);assert.equal(result.paymentId,id);assert.equal(result.customerUrl,payment().url);
  assert.equal(result.expiresAt,null);assert.equal(Object.hasOwn(result,'paymentStatus'),false);assert.equal(JSON.stringify(result).includes('private'),false);
  assert.equal(almaHostedAdapter.writeReplay,'NEVER');assert.equal(Object.hasOwn(almaHostedAdapter,'idempotencyRetentionMs'),false);assert.equal(transport.calls.length,3);
  assert.deepEqual(transport.calls.map((c)=>c.method),['GET','POST','POST']);assert.deepEqual(transport.calls[2]!.body,{ origin:'online',payment:{ purchase_amount:10000,installments_count:3,deferred_months:0,deferred_days:0,
    capture_method:'automatic',return_url:intent.successUrl,customer_cancel_url:intent.cancelUrl,failure_return_url:intent.cancelUrl,ipn_callback_url:intent.ipnUrl,custom_data:{ intentId:intent.id } } });
  transport.set({ raw:{ ...payment(),processing_status:'captured' } });const captured=await almaHostedAdapter.create(config,credentials,intent,admitTestWrite);assert.equal(captured.customerUrl,null);
  assert.equal(Object.hasOwn(captured,'paymentStatus'),false,'creation response never establishes independent paid evidence');
});
test('Alma financial evidence comes only from independently retrieved captured merchant gross money with matching intent and plan; approval, old paid state and refunds cannot enroll',async(t)=> {
  const transport=fixture(t);for(const status of ['awaiting_authorization','authorized','captured','canceled']) {
    transport.set({ raw:{ ...payment(),processing_status:status } });const evidence=await almaHostedAdapter.retrievePayment(config,credentials,intent,id);
    assert.equal(evidence.source,'INDEPENDENT_ALMA_PAYMENT_READ');assert.equal(evidence.paymentStatus,status==='captured' ? 'PAID' : 'UNPAID');assert.equal(evidence.minor,'10000');
  }
  for(const [amount,full,state] of [[100,false,'PARTIAL'],[10000,true,'FULL']] as const) {
    transport.set({ raw:{ ...payment(),processing_status:'captured',amount_already_refunded:amount,is_completely_refunded:full } });
    const evidence=await almaHostedAdapter.retrievePayment(config,credentials,intent,id);assert.equal(evidence.paymentStatus,'UNPAID');assert.equal(evidence.refundState,state);
  }
  assert.ok(transport.calls.every((c)=>c.method==='GET'));assert.equal(JSON.stringify(transport.calls).includes('/capture'),false);
});
test('Alma independently retrieved native proof rejects mismatched merchant/resource/intent/exact money/plan and incomplete or manually captured/refund claims',async(t)=> {
  const transport=fixture(t);
  for(const patch of [{ id:'payment_ForeignSynthetic' },{ merchant_id:'merchant_ForeignSynthetic' },{ purchase_amount:10001 },{ purchase_amount:'10000' },{ currency:'USD' },
    { custom_data:{ intentId:'foreign' } },{ installments_count:4 },{ deferred_days:30 },{ deferred_months:undefined },{ processing_status:'paid' },{ processing_status:undefined },
    { capture_method:'manual' },{ is_deferred_capture:true },{ is_deferred_capture:undefined },{ is_completely_refunded:undefined },{ amount_already_refunded:10001 },{ amount_already_refunded:-1 },{ is_completely_refunded:true }]) {
    transport.set({ raw:{ ...payment(),processing_status:'captured',...patch } });await assert.rejects(almaHostedAdapter.retrievePayment(config,credentials,intent,id),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  }
  transport.set({ account:'merchant_ForeignSynthetic',raw:payment() });const before=transport.calls.length;
  await assert.rejects(almaHostedAdapter.retrievePayment(config,credentials,intent,id),/PAYMENT_ACCOUNT_MISMATCH/);assert.equal(transport.calls.length,before+1);
});
test('Alma hosted links and operational return/callback inputs enforce safe fixed identity URLs without provider I/O for malformed intent',async(t)=> {
  const transport=fixture(t);
  for(const url of ['https://foreign.test/'+id,'https://pay.getalma.eu/'+id,'https://pay.sandbox.getalma.eu/payment_Foreign','https://pay.sandbox.getalma.eu/'+id+'?token=other',
    'https://user:secret@pay.sandbox.getalma.eu/'+id,'https://pay.sandbox.getalma.eu:444/'+id,'https://pay.sandbox.getalma.eu/'+id+'#fragment','javascript:alert(1)']) {
    transport.set({ raw:{ ...payment(),url } });await assert.rejects(almaHostedAdapter.create(config,credentials,intent,admitTestWrite),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  }
  transport.set({ raw:{ ...payment(),url:'https://pay.sandbox.getalma.eu/'+id.slice('payment_'.length) } });assert.ok((await almaHostedAdapter.create(config,credentials,intent,admitTestWrite)).customerUrl);
  const before=transport.calls.length;
  for(const patch of [{ plan:{ installments:0,deferredMonths:0,deferredDays:0 } },{ money:{ ...intent.money,minor:'1' } },{ accountRef:'../foreign' },{ id:'foreign' },
    { successUrl:'javascript:alert(1)' },{ cancelUrl:'https://other.test/cancel' },{ ipnUrl:'https://api.platform.test/callback?customer=claim' },{ ipnUrl:'https://user:secret@api.platform.test/callback' }])
    await assert.rejects(almaHostedAdapter.create(config,credentials,{ ...intent,...patch },admitTestWrite));
  await assert.rejects(almaHostedAdapter.retrieve(config,credentials,intent,'../arbitrary'));assert.equal(transport.calls.length,before);
});
test('Alma unresolved financial writes stay UNKNOWN and have no hidden retries or replacement key, while preflight denial is known to precede payment creation',async(t)=> {
  const transport=fixture(t);
  for(const status of [400,409,429,503]) {
    transport.set({ failure:status });const before=transport.calls.length;
    await assert.rejects(almaHostedAdapter.create(config,credentials,intent,admitTestWrite),(e:unknown)=>e instanceof PaymentCheckoutError && e.certainty==='UNKNOWN' && !e.message.includes(credentials.apiKey));
    assert.equal(transport.calls.length,before+3);
  }
  transport.set({ failure:0,lost:true });const before=transport.calls.length;
  await assert.rejects(almaHostedAdapter.create(config,credentials,intent,admitTestWrite),(e:unknown)=>e instanceof PaymentCheckoutError && e.certainty==='UNKNOWN');assert.equal(transport.calls.length,before+3);
  transport.set({ lost:false,raw:{} });await assert.rejects(almaHostedAdapter.create(config,credentials,intent,admitTestWrite),(e:unknown)=>e instanceof PaymentCheckoutError && e.certainty==='UNKNOWN');
  transport.set({ raw:payment(),eligible:false });const denied=transport.calls.length;await assert.rejects(almaHostedAdapter.create(config,credentials,intent,admitTestWrite),/PAYMENT_ACCOUNT_NOT_READY/);assert.equal(transport.calls.length,denied+2);
  transport.set({ eligible:true,account:'merchant_ForeignSynthetic' });const foreign=transport.calls.length;await assert.rejects(almaHostedAdapter.create(config,credentials,intent,admitTestWrite),/PAYMENT_ACCOUNT_MISMATCH/);assert.equal(transport.calls.length,foreign+2);
});

test('Alma create requires explicit application admission only after successful fresh reads and never writes on missing, revoked or failed authorization',async(t)=> {
  const transport=fixture(t);
  await assert.rejects(almaHostedAdapter.create(config,credentials,intent,undefined as never),/PAYMENT_WRITE_ADMISSION_REQUIRED/);assert.equal(transport.calls.length,0);
  let decisions=0;await assert.rejects(almaHostedAdapter.create(config,credentials,intent,async(snapshot)=> {
    decisions++;assert.equal(transport.calls.length,2);assert.equal(snapshot.id,intent.id);return false;
  }),(e:unknown)=>e instanceof PaymentCheckoutError && e.code==='PAYMENT_ACCESS_REVOKED' && e.certainty==='REJECTED');
  assert.equal(decisions,1);assert.equal(transport.calls.length,2);
  await assert.rejects(almaHostedAdapter.create(config,credentials,intent,async()=>{ throw new Error(credentials.apiKey+' private ACL failure'); }),
    (e:unknown)=>e instanceof PaymentCheckoutError && e.code==='PAYMENT_WRITE_ADMISSION_REQUIRED' && e.certainty==='REJECTED' && !e.message.includes(credentials.apiKey));
  transport.set({ eligible:false });const before=transport.calls.length;
  await assert.rejects(almaHostedAdapter.create(config,credentials,intent,async()=>{ decisions++;return true; }),/PAYMENT_ACCOUNT_NOT_READY/);
  assert.equal(transport.calls.length,before+2);assert.equal(decisions,1);assert.ok(transport.calls.every((c)=>c.url.endsWith('/extended-data') || c.url.endsWith('/eligibility')));
});

test('Alma fresh preflight followed by revoked admission blocks actual payment write, including an async denial arriving after eligibility',async(t)=> {
  let active=true;let admitted=false;const urls:string[]=[];
  t.mock.method(globalThis,'fetch',async(target:string)=> {
    urls.push(target);if(target.endsWith('/extended-data'))return new Response(JSON.stringify({ id:merchant }));
    assert.equal(target,'https://api.sandbox.getalma.eu/v2/payments/eligibility');active=false;
    return new Response(JSON.stringify([{ installments_count:3,deferred_months:0,deferred_days:0,eligible:true }]));
  });
  await assert.rejects(almaHostedAdapter.create(config,credentials,intent,async()=>{ admitted=true;await Promise.resolve();return active; }),/PAYMENT_ACCESS_REVOKED/);
  assert.equal(admitted,true);assert.equal(urls.length,2);assert.equal(urls.some((url)=>url.endsWith('/v1/payments')),false);
});

test('Alma creation freezes original intent, plan, money, return targets, mode and credential across preflight and admission awaits',async(t)=> {
  const mutable=structuredClone(intent);const key={ ...credentials };const environment:PaymentConfig={ ...config };let admitted=false;
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> {
    assert.equal(new Headers(init.headers).get('authorization'),'Alma-Auth '+credentials.apiKey);assert.ok(target.startsWith('https://api.sandbox.getalma.eu/'));
    if(target.endsWith('/extended-data')) {
      mutable.money.minor='99999';mutable.money.amount='999.99';mutable.plan.installments=4;mutable.accountRef='merchant_Foreign';mutable.successUrl='https://foreign.test';
      key.apiKey='OtherCredentialNeverAllowed_123456';environment.mode='LIVE';return new Response(JSON.stringify({ id:merchant }));
    }
    const body=JSON.parse(init.body as string);if(target.endsWith('/eligibility')) {
      assert.equal(body.purchase_amount,10000);assert.equal(body.queries[0].installments_count,3);
      return new Response(JSON.stringify([{ ...body.queries[0],eligible:true }]));
    }
    assert.equal(admitted,true);assert.equal(body.payment.purchase_amount,10000);assert.equal(body.payment.installments_count,3);assert.equal(body.payment.return_url,intent.successUrl);
    return new Response(JSON.stringify(payment()));
  });
  const result=await almaHostedAdapter.create(environment,key,mutable,async(original)=> {
    assert.ok(Object.isFrozen(original));assert.ok(Object.isFrozen(original.money));assert.ok(Object.isFrozen(original.plan));
    assert.equal(original.accountRef,merchant);assert.equal(original.money.minor,'10000');assert.equal(original.plan.installments,3);admitted=true;await Promise.resolve();return true;
  });assert.equal(result.merchantId,merchant);assert.equal(result.minor,'10000');assert.equal(result.plan.installments,3);
});
