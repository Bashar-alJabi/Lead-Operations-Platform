import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentMoney } from '../src/payments/money.js';
import { stripeCurrencyPrecision,stripeCheckoutAdapter,PaymentCheckoutError,type CheckoutIntent } from '../src/payments/checkout-provider.js';
const id='fc4f50bf-529f-4c45-8936-c30c94ef298c';
const intent:CheckoutIntent={ id,accountRef:'acct_SyntheticCheckout123',money:paymentMoney('12.50','USD',stripeCurrencyPrecision('USD')),name:'Allowed payment method',
  successUrl:'https://platform.test/payments/return',cancelUrl:'https://platform.test/payments/cancel' };
const credentials={ apiKey:'rk_test_'+'SyntheticCheckoutOnly'.repeat(3) };const config={ mode:'TEST' as const };
const session=()=>({ id:'cs_test_SyntheticCheckout123',object:'checkout.session',mode:'payment',livemode:false,status:'open',payment_status:'unpaid',
  amount_total:1250,currency:'usd',client_reference_id:id,metadata:{ platform_intent_id:id,private:'never returned' },expires_at:2000000000,payment_intent:null,
  url:'https://checkout.stripe.com/c/pay/cs_test_SyntheticCheckout123#opaque',customer_details:{ email:'private@example.test' } });
test('Payment money remains exact decimal/BigInt and currency precision is provider-specific, including Stripe ISK/UGX and charge rather than payout HUF/TWD',()=> {
  assert.deepEqual(paymentMoney('12.5','USD',{ scale:2,quantum:'1' }),intent.money);
  assert.equal(paymentMoney('0.01','USD',stripeCurrencyPrecision('USD')).minor,'1');
  assert.equal(paymentMoney('90071992547409.91','USD',stripeCurrencyPrecision('USD')).minor,'9007199254740991');
  for(const c of ['JPY','MGA','VND'])assert.equal(paymentMoney('500',c,stripeCurrencyPrecision(c)).minor,'500');
  for(const c of ['ISK','UGX']) { assert.equal(paymentMoney('5',c,stripeCurrencyPrecision(c)).minor,'500');assert.throws(()=>paymentMoney('5.01',c,stripeCurrencyPrecision(c))); }
  for(const c of ['HUF','TWD','AFN'])assert.equal(paymentMoney('5.25',c,stripeCurrencyPrecision(c)).minor,'525');
  assert.equal(paymentMoney('1.125','KWD',{ scale:3,quantum:'1' }).minor,'1125');assert.throws(()=>stripeCurrencyPrecision('KWD'));
  for(const amount of ['0','-1','1e2','+1','1,25',' 1','01','1.001','90071992547409.92','1'.repeat(33)])assert.throws(()=>paymentMoney(amount,'USD',{ scale:2,quantum:'1' }));
  assert.throws(()=>paymentMoney('1','XYZ',{ scale:2,quantum:'1' }));assert.throws(()=>paymentMoney('1','USD',{ scale:9,quantum:'1' }));
});
test('Hosted Checkout sends only exact server intent, fixed account/session requests and stable idempotency; retrieval returns a bounded safe snapshot without PII',async(t)=> {
  const writes:{ key:string;body:string }[]=[];let current=session();const urls:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,options?:RequestInit)=> {
    const url=String(input);urls.push(url);assert.ok(url.startsWith('https://api.stripe.com/v1/'));assert.equal(options?.redirect,'error');assert.ok(options?.signal);
    if(url.endsWith('/account')) { assert.equal(options?.method,'GET');return Response.json({ object:'account',id:intent.accountRef,charges_enabled:true,bank:'private' }); }
    if(options?.method==='POST') { assert.equal(url,'https://api.stripe.com/v1/checkout/sessions');const headers=options.headers as Record<string,string>;
      assert.equal(headers['content-type'],'application/x-www-form-urlencoded');writes.push({ key:headers['idempotency-key']!,body:options.body as string }); }
    else { assert.equal(url,'https://api.stripe.com/v1/checkout/sessions/'+current.id);assert.equal((options?.headers as Record<string,string>)['idempotency-key'],undefined); }
    return Response.json(current);
  });
  const first=await stripeCheckoutAdapter.create(config,credentials,intent);await stripeCheckoutAdapter.create(config,credentials,intent);
  assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0]!.key,'lop-payment:'+id);const form=new URLSearchParams(writes[0]!.body);
  assert.equal(form.get('line_items[0][price_data][unit_amount]'),'1250');assert.equal(form.get('line_items[0][price_data][currency]'),'usd');
  assert.equal(form.get('client_reference_id'),id);assert.equal(form.get('metadata[platform_intent_id]'),id);assert.equal(form.get('payment_intent_data[metadata][platform_intent_id]'),id);
  assert.equal(form.has('customer_email'),false);assert.equal(form.has('discounts'),false);assert.equal(form.get('mode'),'payment');assert.equal(first.paymentStatus,'UNPAID');
  current={ ...session(),status:'complete',payment_status:'paid',url:null,payment_intent:'pi_SyntheticCheckout123' } as unknown as ReturnType<typeof session>;
  const paid=await stripeCheckoutAdapter.retrieve(config,credentials,intent,current.id);assert.equal(paid.status,'COMPLETE');assert.equal(paid.paymentStatus,'PAID');assert.equal(paid.url,null);
  assert.equal(JSON.stringify(paid).includes('private'),false);assert.equal('customer_details' in paid,false);assert.equal(stripeCheckoutAdapter.idempotencyRetentionMs,86400000);
  const before=urls.length;await assert.rejects(stripeCheckoutAdapter.retrieve(config,credentials,intent,'cs_test_../../bad'));assert.equal(urls.length,before);
  await assert.rejects(stripeCheckoutAdapter.create(config,credentials,{ ...intent,money:{ ...intent.money,minor:'9999' } }));assert.equal(urls.length,before);
});
test('Checkout account/mode/intent/money/URL mismatches and unsafe provider responses cannot become accepted links or financial confirmation',async(t)=> {
  let accountId=intent.accountRef;let charges=true;let data:unknown=session();let posts=0;
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,options?:RequestInit)=> {
    if(String(input).endsWith('/account'))return Response.json({ object:'account',id:accountId,charges_enabled:charges });if(options?.method==='POST')posts++;return Response.json(data);
  });
  accountId='acct_SomeoneElse';await assert.rejects(stripeCheckoutAdapter.create(config,credentials,intent),(e)=>e instanceof PaymentCheckoutError && e.code==='PAYMENT_ACCOUNT_MISMATCH' && e.certainty==='REJECTED');assert.equal(posts,0);accountId=intent.accountRef;
  charges=false;await assert.rejects(stripeCheckoutAdapter.create(config,credentials,intent),(e)=>e instanceof PaymentCheckoutError && e.code==='PAYMENT_ACCOUNT_NOT_READY');assert.equal(posts,0);
  assert.equal((await stripeCheckoutAdapter.retrieve(config,credentials,intent,session().id)).status,'OPEN');charges=true;
  for(const patch of [{ livemode:true },{ id:'cs_live_SyntheticCheckout123' },{ amount_total:1251 },{ amount_total:12.5 },{ currency:'eur' },{ client_reference_id:'other' },{ metadata:{ platform_intent_id:'other' } },
    { url:'https://evil.test/c/pay/'+session().id },{ url:'javascript:alert(1)' },{ url:'https://checkout.stripe.com@evil.test/c/pay/'+session().id },{ url:'https://checkout.stripe.com/c/pay/cs_test_otherSession123' },{ payment_status:'paid' }]) {
    data={ ...session(),...patch };await assert.rejects(stripeCheckoutAdapter.create(config,credentials,intent),(e)=>e instanceof PaymentCheckoutError && e.certainty==='UNKNOWN');
    await assert.rejects(stripeCheckoutAdapter.retrieve(config,credentials,intent,session().id),(e)=>e instanceof PaymentCheckoutError && e.certainty==='REJECTED');
  }
  data={ padding:'x'.repeat(262145) };await assert.rejects(stripeCheckoutAdapter.create(config,credentials,intent),(e)=>e instanceof PaymentCheckoutError && e.certainty==='UNKNOWN');
  const before=posts;await assert.rejects(stripeCheckoutAdapter.create(config,credentials,{ ...intent,successUrl:'http://evil.test',cancelUrl:'http://evil.test' }));assert.equal(posts,before);
});
test('Checkout distinguishes proven rejection, retryable throttling and ambiguous POST without retrying or exposing provider error secrets',async(t)=> {
  let kind:'NETWORK'|'500'|'400'|'401'|'429'|'IDEMPOTENCY'|'409'|'INVALID'='NETWORK';let posts=0;
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,options?:RequestInit)=> {
    if(String(input).endsWith('/account'))return Response.json({ object:'account',id:intent.accountRef,charges_enabled:true });if(options?.method==='POST')posts++;
    if(kind==='NETWORK')throw new Error('private-credential');if(kind==='INVALID')return new Response('{broken}',{ status:200 });
    return Response.json({ error:{ type:kind==='IDEMPOTENCY' ? 'idempotency_error' : 'invalid_request_error',message:'private-credential',request:'private' } },
      { status:kind==='IDEMPOTENCY' ? 400 : Number(kind),headers:{ 'retry-after':'12' } });
  });
  for(const [behavior,certainty] of [['NETWORK','UNKNOWN'],['500','UNKNOWN'],['400','REJECTED'],['401','REJECTED'],['429','RETRYABLE'],['IDEMPOTENCY','UNKNOWN'],['409','RETRYABLE'],['INVALID','UNKNOWN']] as const) {
    kind=behavior;const before=posts;await assert.rejects(stripeCheckoutAdapter.create(config,credentials,intent),(e)=> {
      assert.ok(e instanceof PaymentCheckoutError);assert.equal(e.certainty,certainty);assert.equal(e.message.includes('private'),false);if(kind==='429')assert.equal(e.retryAfterSeconds,12);return true; });assert.equal(posts,before+1);
  }
  kind='500';await assert.rejects(stripeCheckoutAdapter.retrieve(config,credentials,intent,session().id),(e)=>e instanceof PaymentCheckoutError && e.certainty==='RETRYABLE');
});
