import test from 'node:test';
import assert from 'node:assert/strict';
import { paypalOrdersAdapter,paypalCurrencyPrecision } from '../src/payments/paypal-orders.js';
import { paymentMoney } from '../src/payments/money.js';
import { PaymentCheckoutError,type CheckoutIntent,paymentCheckoutAdapters } from '../src/payments/checkout-provider.js';
const id='92066d41-c5d6-423a-87ea-d56a10a6a67a';const orderId='SYNTHETICORDER123';const captureId='SYNTHETICCAPTURE123';
const intent:CheckoutIntent={ id,accountRef:'MERCHANTTEST1',name:'Expected campaign payment',money:paymentMoney('25','USD',paypalCurrencyPrecision('USD')),
  successUrl:'https://platform.test/payments/return',cancelUrl:'https://platform.test/payments/cancel' };
const credentials={ clientId:'SyntheticOrdersClient_123456',clientSecret:'SyntheticOrdersSecret_123456' };const config={ mode:'TEST' as const };
const oauth=()=>Response.json({ access_token:'SyntheticOrdersToken123456',token_type:'Bearer',app_id:'APP-Synthetic123',expires_in:3600 });
const capture=(status='COMPLETED')=>({ id:captureId,status,final_capture:true,amount:{ value:'25.00',currency_code:'USD' },payee:{ merchant_id:intent.accountRef },
  supplementary_data:{ related_ids:{ order_id:orderId } },private:'ignored buyer PII' });
const order=(status='PAYER_ACTION_REQUIRED')=>({ id:orderId,status,intent:'CAPTURE',purchase_units:[{ reference_id:id,custom_id:id,amount:{ value:'25.00',currency_code:'USD' },
  payee:{ merchant_id:intent.accountRef,email_address:'private-buyer@fixture.test' },...(status==='COMPLETED' ? { payments:{ captures:[capture()] } } : {}) }],
  links:[{ rel:'payer-action',method:'GET',href:'https://www.sandbox.paypal.com/checkoutnow?token='+orderId }],payer:{ private:'never shown' } });
test('PayPal money profile differs from Stripe and preserves exact provider decimals without claiming account currency capability',()=> {
  for(const currency of ['JPY','HUF','TWD']) { assert.equal(paymentMoney('25',currency,paypalCurrencyPrecision(currency)).minor,'25');assert.throws(()=>paymentMoney('25.00',currency,paypalCurrencyPrecision(currency))); }
  for(const currency of ['USD','EUR','BRL','CNY'])assert.equal(paymentMoney('25.01',currency,paypalCurrencyPrecision(currency)).minor,'2501');
  for(const currency of ['KWD','ISK','AFN','XYZ'])assert.throws(()=>paypalCurrencyPrecision(currency));
  assert.equal(paymentMoney('90071992547409.91','USD',paypalCurrencyPrecision('USD')).minor,'9007199254740991');
  assert.equal(paymentCheckoutAdapters.PAYPAL,undefined);assert.equal(paypalOrdersAdapter.idempotencyRetentionMs,21600000);
});
test('PayPal creates only exact intent and expected payee with stable order keys, safe approval URL and no fabricated expiry or automatic capture',async(t)=> {
  const writes:{ key:string;body:string }[]=[];let current=order();
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> {
    assert.equal(init.redirect,'error');assert.ok(init.signal);
    if(target.endsWith('/v1/oauth2/token'))return oauth();assert.ok(target.startsWith('https://api-m.sandbox.paypal.com/v2/checkout/orders'));
    if(init.method==='POST') { assert.equal(target,'https://api-m.sandbox.paypal.com/v2/checkout/orders');const headers=init.headers as Record<string,string>;
      assert.equal(headers.Prefer,'return=representation');writes.push({ key:headers['PayPal-Request-Id']!,body:init.body as string }); }
    else assert.equal(target,'https://api-m.sandbox.paypal.com/v2/checkout/orders/'+orderId);return Response.json(current);
  });
  const first=await paypalOrdersAdapter.create(config,credentials,intent);await paypalOrdersAdapter.create(config,credentials,intent);
  assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0]!.key,'lop-order:'+id);const payload=JSON.parse(writes[0]!.body);
  assert.deepEqual(payload.purchase_units,[{ reference_id:id,custom_id:id,description:intent.name,payee:{ merchant_id:intent.accountRef },amount:{ currency_code:'USD',value:'25.00' } }]);
  assert.equal(payload.payment_source.paypal.experience_context.return_url,intent.successUrl);assert.equal(payload.payment_source.paypal.experience_context.shipping_preference,'NO_SHIPPING');
  assert.equal(first.expiresAt,null);assert.match(first.approvalUrl!,/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);assert.equal(first.capture,null);assert.equal('paymentStatus' in first,false);
  current=order('APPROVED');const approved=await paypalOrdersAdapter.retrieve(config,credentials,intent,orderId);assert.equal(approved.status,'APPROVED');assert.equal(approved.approvalUrl,null);assert.equal(approved.capture,null);assert.equal(writes.length,2);
  assert.equal(JSON.stringify([first,approved]).includes('private'),false);
});
test('PayPal capture is explicit, verifies approval/identity first, preserves a separate stable key and skips a new write for an already captured order',async(t)=> {
  let current=order('CREATED');let posts=0;const keys:string[]=[];
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> {
    if(target.endsWith('/v1/oauth2/token'))return oauth();
    if(init.method==='POST') { posts++;assert.equal(target,'https://api-m.sandbox.paypal.com/v2/checkout/orders/'+orderId+'/capture');assert.equal(init.body,'{}');keys.push((init.headers as Record<string,string>)['PayPal-Request-Id']!);return Response.json(order('COMPLETED')); }
    return Response.json(current);
  });
  await assert.rejects(paypalOrdersAdapter.capture(config,credentials,intent,orderId),(e)=>e instanceof PaymentCheckoutError && e.code==='PAYMENT_APPROVAL_REQUIRED');assert.equal(posts,0);
  current=order('APPROVED');const a=await paypalOrdersAdapter.capture(config,credentials,intent,orderId);await paypalOrdersAdapter.capture(config,credentials,intent,orderId);
  assert.equal(a.writePerformed,true);assert.deepEqual(keys,['lop-capture:'+id,'lop-capture:'+id]);assert.equal(a.order.capture?.id,captureId);assert.equal('paymentStatus' in a,false);
  current=order('COMPLETED');const recovered=await paypalOrdersAdapter.capture(config,credentials,intent,orderId);assert.equal(recovered.writePerformed,false);assert.equal(posts,2);
  current={ ...order('APPROVED'),purchase_units:[{ ...order('APPROVED').purchase_units[0]!,payee:{ merchant_id:'OTHERACCOUNT1',email_address:'private' } }] };
  await assert.rejects(paypalOrdersAdapter.capture(config,credentials,intent,orderId),/PAYMENT_SESSION_MISMATCH/);assert.equal(posts,2);
});
test('PayPal independent order and capture reads prove exact money, payee, final capture and related order; PENDING never becomes paid',async(t)=> {
  let current=order('COMPLETED');let captured:any=capture();let captureReads=0;
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> { if(target.endsWith('/v1/oauth2/token'))return oauth();assert.equal(init.method,'GET');
    if(target.endsWith('/v2/payments/captures/'+captureId)) { captureReads++;return Response.json(captured); }return Response.json(current); });
  const paid=await paypalOrdersAdapter.retrievePayment(config,credentials,intent,orderId,captureId);assert.equal(paid.paymentStatus,'PAID');assert.equal(paid.source,'INDEPENDENT_ORDER_CAPTURE_READ');assert.equal(paid.minor,'2500');assert.equal(JSON.stringify(paid).includes('private'),false);
  captured=capture('PENDING');assert.equal((await paypalOrdersAdapter.retrievePayment(config,credentials,intent,orderId,captureId)).paymentStatus,'UNPAID');
  for(const patch of [{ id:'OTHERRESOURCE123' },{ final_capture:false },{ amount:{ currency_code:'USD',value:'24.99' } },{ amount:{ currency_code:'EUR',value:'25.00' } },
    { payee:{ merchant_id:'OTHERACCOUNT1' } },{ supplementary_data:{ related_ids:{ order_id:'OTHERORDER123' } } },{ status:'APPROVED' }]) {
    captured={ ...capture(),...patch };await assert.rejects(paypalOrdersAdapter.retrievePayment(config,credentials,intent,orderId,captureId),/PAYMENT_CAPTURE_MISMATCH/);
  }
  const before=captureReads;current=order('APPROVED');await assert.rejects(paypalOrdersAdapter.retrievePayment(config,credentials,intent,orderId,captureId),/PAYMENT_CAPTURE_MISMATCH/);assert.equal(captureReads,before);
});
test('PayPal wrong money, identity, approval URLs and forged or oversized response fail closed before activation and unsafe inputs perform no I/O',async(t)=> {
  let data:unknown=order();let calls=0;
  t.mock.method(globalThis,'fetch',async(target:string)=> { calls++;if(target.endsWith('/v1/oauth2/token'))return oauth();return Response.json(data); });
  for(const patch of [{ id:'../../private' },{ intent:'AUTHORIZE' },{ purchase_units:[] },{ purchase_units:[...order().purchase_units,...order().purchase_units] },
    { purchase_units:[{ ...order().purchase_units[0],custom_id:'some other intent' }] },{ purchase_units:[{ ...order().purchase_units[0],amount:{ value:'25.001',currency_code:'USD' } }] },
    { status:'COMPLETED' },{ links:[{ rel:'payer-action',method:'GET',href:'https://evil.test/?token='+orderId }] },
    { links:[{ rel:'payer-action',method:'GET',href:'https://www.paypal.com/checkoutnow?token='+orderId }] },
    { links:[{ rel:'payer-action',method:'GET',href:'https://www.sandbox.paypal.com/checkoutnow?token=OTHER123' }] },
    { links:[{ rel:'payer-action',method:'GET',href:'https://www.sandbox.paypal.com/checkoutnow?token='+orderId+'&redirect=http://evil.test' }] }]) {
    data={ ...order(),...patch };await assert.rejects(paypalOrdersAdapter.create(config,credentials,intent),(e)=>e instanceof PaymentCheckoutError && e.certainty==='UNKNOWN');
  }
  data={ padded:'x'.repeat(262145) };await assert.rejects(paypalOrdersAdapter.create(config,credentials,intent),/PAYMENT_PROVIDER_RESPONSE_INVALID/);
  const before=calls;await assert.rejects(paypalOrdersAdapter.retrieve(config,credentials,intent,'../../private'));
  await assert.rejects(paypalOrdersAdapter.create(config,credentials,{ ...intent,money:{ ...intent.money,minor:'99999' } }));
  await assert.rejects(paypalOrdersAdapter.create(config,credentials,{ ...intent,successUrl:'http://private.invalid',cancelUrl:'http://private.invalid' }));assert.equal(calls,before);
});
test('PayPal distinguishes OAuth before financial I/O from ambiguous writes, throttling and idempotency conflict without hidden retries or raw error leaks',async(t)=> {
  let failure:'OAUTH'|'NETWORK'|'500'|'400'|'429'|'CONFLICT'|'INVALID'='OAUTH';let posts=0;
  t.mock.method(globalThis,'fetch',async(target:string,init:RequestInit)=> {
    if(target.endsWith('/v1/oauth2/token')) { if(failure==='OAUTH')throw new Error('private secret');return oauth(); }posts++;
    if(failure==='NETWORK')throw new Error('private financial details');if(failure==='INVALID')return new Response('{broken}',{ status:200 });
    return Response.json({ name:'UNPROCESSABLE_ENTITY',details:[{ issue:failure==='CONFLICT' ? 'DUPLICATE_REQUEST_ID' : 'SYNTHETIC',description:'private secret' }] },
      { status:failure==='CONFLICT' ? 422 : Number(failure),headers:{ 'retry-after':'12' } });
  });
  for(const [kind,certainty] of [['OAUTH','RETRYABLE'],['NETWORK','UNKNOWN'],['500','UNKNOWN'],['400','REJECTED'],['429','RETRYABLE'],['CONFLICT','UNKNOWN'],['INVALID','UNKNOWN']] as const) {
    failure=kind;const before=posts;await assert.rejects(paypalOrdersAdapter.create(config,credentials,intent),(e)=> {
      assert.ok(e instanceof PaymentCheckoutError);assert.equal(e.certainty,certainty);assert.equal(e.message.includes('private'),false);if(kind==='429')assert.equal(e.retryAfterSeconds,12);return true;
    });assert.equal(posts,before+(kind==='OAUTH' ? 0 : 1));
  }
});
