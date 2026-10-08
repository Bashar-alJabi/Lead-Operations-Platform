import { boundedResponse } from '../media/meta-provider.js';
import { HttpError } from '../security.js';
import { validatePaymentCredentials,type PaymentConfig,type PaymentCredentials,type StripePaymentCredentials } from './providers.js';
import { paymentMoney,type CurrencyPrecision,type PaymentMoney } from './money.js';
import { PaymentCheckoutError } from './provider-errors.js';
import { paypalCheckoutAdapter } from './paypal-checkout.js';
import type { PaymentPlanSelection } from './eligibility.js';
export { PaymentCheckoutError } from './provider-errors.js';

export type CheckoutIntent={ id:string;accountRef:string;money:PaymentMoney;name:string;successUrl:string;cancelUrl:string;plan?:PaymentPlanSelection;ipnUrl?:string };
export type CheckoutSnapshot={ sessionId:string;url:string|null;expiresAt:string|null;mode:'TEST'|'LIVE';currency:string;minor:string;
  intentId:string;status:'OPEN'|'COMPLETE'|'EXPIRED';paymentStatus:'PAID'|'UNPAID';paymentRef:string|null;providerEvidence?:Record<string,string|number> };
export type PaymentCheckoutAdapter={ currencyPrecision(currency:string):CurrencyPrecision;idempotencyRetentionMs:number|null;dispatchBudgetMs?:number;writeReplay?:'PROVIDER_KEY'|'NEVER';
  create(config:PaymentConfig,credentials:PaymentCredentials,intent:CheckoutIntent,admit?:(intent:Readonly<CheckoutIntent>)=>Promise<boolean>):Promise<CheckoutSnapshot>;
  retrieve(config:PaymentConfig,credentials:PaymentCredentials,intent:CheckoutIntent,sessionId:string,receiptResourceId?:string):Promise<CheckoutSnapshot> };
const zero=new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','VND','VUV','XAF','XOF','XPF']);
export function stripeCurrencyPrecision(currency:string):CurrencyPrecision {
  if(!Intl.supportedValuesOf('currency').includes(currency))throw new HttpError(400,'PAYMENT_CURRENCY_INVALID');
  if(currency==='ISK' || currency==='UGX')return { scale:2,quantum:'100' };
  if(zero.has(currency))return { scale:0,quantum:'1' };
  // Stripe charges default to two decimals, including CLDR zero-decimal HUF/AFN; payout/ISO precision is not charge precision.
  const digits=new Intl.NumberFormat('en',{ style:'currency',currency }).resolvedOptions().maximumFractionDigits;
  if(digits===undefined || digits>2)throw new HttpError(400,'PAYMENT_CURRENCY_PROFILE_UNSUPPORTED');
  return { scale:2,quantum:'1' };
}
function checkedIntent(intent:CheckoutIntent):void {
  if(!intent || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(intent.id)
    || !/^acct_[A-Za-z0-9]{6,100}$/.test(intent.accountRef) || typeof intent.name!=='string' || !intent.name.trim() || intent.name.length>100 || /[\x00-\x1f\x7f]/.test(intent.name))throw new HttpError(400,'PAYMENT_INTENT_INVALID');
  const normalized=paymentMoney(intent.money.amount,intent.money.currency,stripeCurrencyPrecision(intent.money.currency));
  if(normalized.minor!==intent.money.minor || normalized.scale!==intent.money.scale || normalized.quantum!==intent.money.quantum)throw new HttpError(400,'PAYMENT_INTENT_INVALID');
  for(const target of [intent.successUrl,intent.cancelUrl]) {
    let url:URL;try { url=new URL(target); }catch{ throw new HttpError(400,'PAYMENT_RETURN_URL_INVALID'); }
    if(target.length>2048 || /[\x00-\x1f\x7f]/.test(target) || url.username || url.password || !['https:','http:'].includes(url.protocol)
      || (url.protocol==='http:' && (process.env.NODE_ENV==='production' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new HttpError(400,'PAYMENT_RETURN_URL_INVALID');
  }
  if(new URL(intent.successUrl).origin!==new URL(intent.cancelUrl).origin)throw new HttpError(400,'PAYMENT_RETURN_URL_INVALID');
}
async function request(path:string,credentials:StripePaymentCredentials,body?:URLSearchParams,key?:string):Promise<unknown> {
  const write=body!==undefined;let response:Response;
  try { response=await fetch('https://api.stripe.com'+path,{ method:write ? 'POST' : 'GET',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{ authorization:'Bearer '+credentials.apiKey,...(write ? { 'content-type':'application/x-www-form-urlencoded','idempotency-key':key! } : {}) },...(write ? { body:body.toString() } : {}) }); }
  catch { throw new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE',write ? 'UNKNOWN' : 'RETRYABLE'); }
  if(response.status===401 || response.status===403)throw new PaymentCheckoutError('PAYMENT_PROVIDER_AUTH_FAILED','REJECTED');
  if(response.status===429) { const delay=Number(response.headers.get('retry-after'));throw new PaymentCheckoutError('PAYMENT_PROVIDER_RATE_LIMITED','RETRYABLE',Number.isFinite(delay) && delay>0 ? Math.min(Math.ceil(delay),3600) : null); }
  if(response.status>=500)throw new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE',write ? 'UNKNOWN' : 'RETRYABLE');
  let data:unknown;try { data=JSON.parse((await boundedResponse(response,262144)).toString('utf8')); }
  catch { throw new PaymentCheckoutError('PAYMENT_PROVIDER_RESPONSE_INVALID',write ? 'UNKNOWN' : 'RETRYABLE'); }
  if(!response.ok) {
    const error=(data as { error?:{ type?:unknown;code?:unknown } }|null)?.error;
    if(write && error?.type==='idempotency_error')throw new PaymentCheckoutError('PAYMENT_IDEMPOTENCY_CONFLICT','UNKNOWN');
    if(write && response.status===409)throw new PaymentCheckoutError('PAYMENT_IDEMPOTENCY_CONFLICT','RETRYABLE');
    throw new PaymentCheckoutError('PAYMENT_PROVIDER_REJECTED',response.status>=400 && response.status<500 ? 'REJECTED' : write ? 'UNKNOWN' : 'RETRYABLE');
  }
  return data;
}
async function checkAccount(config:PaymentConfig,credentials:PaymentCredentials,intent:CheckoutIntent,creating=false) {
  validatePaymentCredentials(config,credentials);checkedIntent(intent);const data=await request('/v1/account',credentials) as Record<string,unknown>|null;
  if(!data || data.object!=='account' || data.id!==intent.accountRef)throw new PaymentCheckoutError('PAYMENT_ACCOUNT_MISMATCH','REJECTED');
  if(typeof data.charges_enabled!=='boolean')throw new PaymentCheckoutError('PAYMENT_PROVIDER_RESPONSE_INVALID','REJECTED');
  if(creating && !data.charges_enabled)throw new PaymentCheckoutError('PAYMENT_ACCOUNT_NOT_READY','REJECTED');
}
function snapshot(value:unknown,config:PaymentConfig,intent:CheckoutIntent,write=false):CheckoutSnapshot {
  const certainty=write ? 'UNKNOWN' : 'REJECTED';const data=value as Record<string,unknown>|null;
  if(!data || Array.isArray(data) || data.object!=='checkout.session' || typeof data.id!=='string' || !/^cs_(test|live)_[A-Za-z0-9]{6,180}$/.test(data.id)
    || !data.id.startsWith(config.mode==='TEST' ? 'cs_test_' : 'cs_live_')
    || data.mode!=='payment' || typeof data.livemode!=='boolean' || (data.livemode ? 'LIVE' : 'TEST')!==config.mode
    || !['open','complete','expired'].includes(data.status as string) || !['paid','unpaid'].includes(data.payment_status as string)
    || (data.payment_status==='paid' && data.status!=='complete')
    || !Number.isSafeInteger(data.amount_total) || String(data.amount_total)!==intent.money.minor || data.currency!==intent.money.currency.toLowerCase()
    || data.client_reference_id!==intent.id || (data.metadata as { platform_intent_id?:unknown }|null)?.platform_intent_id!==intent.id
    || !Number.isSafeInteger(data.expires_at) || (data.expires_at as number)<0 || (data.expires_at as number)>253402300799
    || (data.payment_intent!==null && (typeof data.payment_intent!=='string' || !/^pi_[A-Za-z0-9]{6,180}$/.test(data.payment_intent))))throw new PaymentCheckoutError('PAYMENT_SESSION_MISMATCH',certainty);
  let url:string|null=null;
  if(data.url!==null) {
    try { if(typeof data.url!=='string' || data.url.length>8192 || /[\x00-\x1f\x7f]/.test(data.url))throw new Error();const parsed=new URL(data.url);
      if(parsed.protocol!=='https:' || parsed.hostname!=='checkout.stripe.com' || parsed.username || parsed.password || parsed.port
        || !['/c/pay/'+data.id,'/pay/'+data.id].includes(parsed.pathname))throw new Error();url=data.url;
    }catch{ throw new PaymentCheckoutError('PAYMENT_SESSION_MISMATCH',certainty); }
  }
  if(data.status==='open' && url===null)throw new PaymentCheckoutError('PAYMENT_SESSION_MISMATCH',certainty);
  return { sessionId:data.id,url,expiresAt:new Date((data.expires_at as number)*1000).toISOString(),mode:config.mode,currency:intent.money.currency,
    minor:intent.money.minor,intentId:intent.id,status:(data.status as string).toUpperCase() as CheckoutSnapshot['status'],
    paymentStatus:(data.payment_status as string).toUpperCase() as CheckoutSnapshot['paymentStatus'],paymentRef:data.payment_intent as string|null };
}
export const stripeCheckoutAdapter:PaymentCheckoutAdapter={ currencyPrecision:stripeCurrencyPrecision,idempotencyRetentionMs:24*60*60*1000,
  async create(config,credentials,intent) {
    validatePaymentCredentials(config,credentials);
    await checkAccount(config,credentials,intent,true);
    const form=new URLSearchParams({ mode:'payment',success_url:intent.successUrl,cancel_url:intent.cancelUrl,client_reference_id:intent.id,
      'metadata[platform_intent_id]':intent.id,'payment_intent_data[metadata][platform_intent_id]':intent.id,
      'line_items[0][quantity]':'1','line_items[0][price_data][currency]':intent.money.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]':intent.money.minor,'line_items[0][price_data][product_data][name]':intent.name });
    return snapshot(await request('/v1/checkout/sessions',credentials,form,'lop-payment:'+intent.id),config,intent,true);
  },async retrieve(config,credentials,intent,sessionId) {
    validatePaymentCredentials(config,credentials);
    if(!/^cs_(test|live)_[A-Za-z0-9]{6,180}$/.test(sessionId))throw new HttpError(400,'PAYMENT_SESSION_ID_INVALID');
    await checkAccount(config,credentials,intent);const result=snapshot(await request('/v1/checkout/sessions/'+sessionId,credentials),config,intent);
    if(result.sessionId!==sessionId)throw new PaymentCheckoutError('PAYMENT_SESSION_MISMATCH','REJECTED');return result;
  },
};
export const paymentCheckoutAdapters:Readonly<Record<string,PaymentCheckoutAdapter>>={ STRIPE:stripeCheckoutAdapter,PAYPAL:paypalCheckoutAdapter };
