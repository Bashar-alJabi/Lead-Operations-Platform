import { HttpError } from '../security.js';
import { boundedResponse } from '../media/meta-provider.js';
import { paypalAccessToken,paypalOrigin } from './paypal-connection.js';
import { PaymentProviderError } from './provider-errors.js';
import { PaymentCheckoutError,type CheckoutIntent } from './checkout-provider.js';
import { paymentMoney,type CurrencyPrecision } from './money.js';
import type { PaymentConfig,PaymentCredentials } from './providers.js';
const currencies=new Set(['AUD','BRL','CAD','CNY','CZK','DKK','EUR','HKD','HUF','ILS','JPY','MYR','MXN','TWD','NZD','NOK','PHP','PLN','GBP','RUB','SGD','SEK','CHF','THB','USD']);
const zero=new Set(['HUF','JPY','TWD']);
export function paypalCurrencyPrecision(currency:string):CurrencyPrecision {
  if(!currencies.has(currency))throw new HttpError(400,'PAYMENT_CURRENCY_PROFILE_UNSUPPORTED');return { scale:zero.has(currency) ? 0 : 2,quantum:'1' };
}
export type PayPalCaptureStatus='COMPLETED'|'PENDING'|'DECLINED'|'FAILED'|'REFUNDED'|'PARTIALLY_REFUNDED';
export type PayPalOrderSnapshot={ orderId:string;intentId:string;merchantId:string;mode:'TEST'|'LIVE';currency:string;minor:string;
  status:'CREATED'|'PAYER_ACTION_REQUIRED'|'APPROVED'|'COMPLETED'|'VOIDED';approvalUrl:string|null;expiresAt:null;
  capture:{ id:string;status:PayPalCaptureStatus }|null };
export type PayPalPaymentEvidence={ schemaVersion:1;source:'INDEPENDENT_ORDER_CAPTURE_READ';orderId:string;captureId:string;intentId:string;
  merchantId:string;mode:'TEST'|'LIVE';currency:string;minor:string;captureStatus:PayPalCaptureStatus;paymentStatus:'PAID'|'UNPAID' };
const resourceId=/^[A-Z0-9]{1,36}$/;
const captureStatuses=['COMPLETED','PENDING','DECLINED','FAILED','REFUNDED','PARTIALLY_REFUNDED'];
function input(intent:CheckoutIntent):void {
  if(!intent || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(intent.id)
    || !/^[A-Z0-9]{13}$/.test(intent.accountRef) || typeof intent.name!=='string' || !intent.name.trim() || intent.name.length>100 || /[\x00-\x1f\x7f]/.test(intent.name))throw new HttpError(400,'PAYMENT_INTENT_INVALID');
  const normalized=paymentMoney(intent.money.amount,intent.money.currency,paypalCurrencyPrecision(intent.money.currency));
  if(normalized.minor!==intent.money.minor || normalized.scale!==intent.money.scale || normalized.quantum!==intent.money.quantum)throw new HttpError(400,'PAYMENT_INTENT_INVALID');
  for(const value of [intent.successUrl,intent.cancelUrl]) {
    let url:URL;try { url=new URL(value); }catch { throw new HttpError(400,'PAYMENT_RETURN_URL_INVALID'); }
    if(value.length>2048 || /[\x00-\x1f\x7f]/.test(value) || url.username || url.password || !['https:','http:'].includes(url.protocol)
      || (url.protocol==='http:' && (process.env.NODE_ENV==='production' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new HttpError(400,'PAYMENT_RETURN_URL_INVALID');
  }
  if(new URL(intent.successUrl).origin!==new URL(intent.cancelUrl).origin)throw new HttpError(400,'PAYMENT_RETURN_URL_INVALID');
}
async function token(config:PaymentConfig,credentials:PaymentCredentials):Promise<string> {
  try { return (await paypalAccessToken(config,credentials)).accessToken; }
  catch(error) { if(error instanceof PaymentProviderError) {
    const code=error.code==='PAYMENT_PROVIDER_AUTH_FAILED' ? 'PAYMENT_PROVIDER_AUTH_FAILED' : error.code==='PAYMENT_PROVIDER_RATE_LIMITED' ? 'PAYMENT_PROVIDER_RATE_LIMITED'
      : error.code==='PAYMENT_PROVIDER_RESPONSE_INVALID' ? 'PAYMENT_PROVIDER_RESPONSE_INVALID' : 'PAYMENT_PROVIDER_UNAVAILABLE';
    throw new PaymentCheckoutError(code,code==='PAYMENT_PROVIDER_AUTH_FAILED' ? 'REJECTED' : 'RETRYABLE'); }throw error; }
}
async function request(config:PaymentConfig,accessToken:string,path:string,body?:object,key?:string):Promise<unknown> {
  const write=body!==undefined;let response:Response;
  try { response=await fetch(paypalOrigin(config.mode)+path,{ method:write ? 'POST' : 'GET',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{ authorization:'Bearer '+accessToken,accept:'application/json',...(write ? { 'content-type':'application/json','PayPal-Request-Id':key!,Prefer:'return=representation' } : {}) },
    ...(write ? { body:JSON.stringify(body) } : {}) }); }
  catch { throw new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE',write ? 'UNKNOWN' : 'RETRYABLE'); }
  if([401,403].includes(response.status))throw new PaymentCheckoutError('PAYMENT_PROVIDER_AUTH_FAILED','REJECTED');
  if(response.status===429) { const delay=Number(response.headers.get('retry-after'));throw new PaymentCheckoutError('PAYMENT_PROVIDER_RATE_LIMITED','RETRYABLE',Number.isFinite(delay)&&delay>0 ? Math.min(Math.ceil(delay),3600) : null); }
  if(response.status>=500)throw new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE',write ? 'UNKNOWN' : 'RETRYABLE');
  let data:unknown;try { data=JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(await boundedResponse(response,262144))); }
  catch { throw new PaymentCheckoutError('PAYMENT_PROVIDER_RESPONSE_INVALID',write ? 'UNKNOWN' : 'RETRYABLE'); }
  if(!response.ok) {
    const name=(data as { name?:unknown }|null)?.name;
    const details=(data as { details?:unknown }|null)?.details;
    const ambiguous=name==='DUPLICATE_REQUEST_ID' || (Array.isArray(details) && details.some((d)=>d && typeof d==='object' && ['DUPLICATE_REQUEST_ID','PREVIOUS_REQUEST_IN_PROGRESS'].includes(d.issue)));
    if(write && (response.status===409 || ambiguous))throw new PaymentCheckoutError('PAYMENT_IDEMPOTENCY_CONFLICT',ambiguous ? 'UNKNOWN' : 'RETRYABLE');
    throw new PaymentCheckoutError('PAYMENT_PROVIDER_REJECTED','REJECTED');
  }return data;
}
function exactAmount(value:unknown,intent:CheckoutIntent):boolean {
  try { const amount=value as { currency_code?:string;value?:string }|null;
    return !!amount && amount.currency_code===intent.money.currency && typeof amount.value==='string'
      && paymentMoney(amount.value,intent.money.currency,paypalCurrencyPrecision(intent.money.currency)).minor===intent.money.minor;
  }catch { return false; }
}
function order(value:unknown,config:PaymentConfig,intent:CheckoutIntent,expectedId?:string,write=false):PayPalOrderSnapshot {
  const invalid=()=>new PaymentCheckoutError('PAYMENT_SESSION_MISMATCH',write ? 'UNKNOWN' : 'REJECTED');
  const data=value as Record<string,any>|null;
  if(!data || Array.isArray(data) || typeof data.id!=='string' || !resourceId.test(data.id) || (expectedId!==undefined && data.id!==expectedId)
    || data.intent!=='CAPTURE' || !['CREATED','PAYER_ACTION_REQUIRED','APPROVED','COMPLETED','VOIDED'].includes(data.status)
    || !Array.isArray(data.purchase_units) || data.purchase_units.length!==1)throw invalid();
  const unit=data.purchase_units[0];
  if(!unit || typeof unit!=='object' || unit.reference_id!==intent.id || unit.custom_id!==intent.id || unit.payee?.merchant_id!==intent.accountRef || !exactAmount(unit.amount,intent))throw invalid();
  const payments=unit.payments;if(payments!=null && (typeof payments!=='object' || Array.isArray(payments) || (payments.authorizations!==undefined && (!Array.isArray(payments.authorizations) || payments.authorizations.length))))throw invalid();
  const captures=payments?.captures ?? [];if(!Array.isArray(captures) || captures.length>1)throw invalid();
  let capture:PayPalOrderSnapshot['capture']=null;
  if(captures.length) { const c=captures[0];if(!c || typeof c.id!=='string' || !resourceId.test(c.id) || !captureStatuses.includes(c.status)
      || c.final_capture!==true || !exactAmount(c.amount,intent) || (c.payee!==undefined && c.payee?.merchant_id!==intent.accountRef))throw invalid();
    capture={ id:c.id,status:c.status }; }
  if((data.status==='COMPLETED' && capture===null) || (capture!==null && data.status!=='COMPLETED'))throw invalid();
  let approvalUrl:string|null=null;
  if(['CREATED','PAYER_ACTION_REQUIRED'].includes(data.status)) {
    if(!Array.isArray(data.links) || data.links.length>100)throw invalid();const links=data.links.filter((link:any)=>link && ['approve','payer-action'].includes(link.rel));
    if(links.length!==1 || links[0].method!=='GET' || typeof links[0].href!=='string' || links[0].href.length>8192 || /[\x00-\x1f\x7f]/.test(links[0].href))throw invalid();
    try { const url=new URL(links[0].href);if(url.protocol!=='https:' || url.hostname!==(config.mode==='TEST' ? 'www.sandbox.paypal.com' : 'www.paypal.com')
        || url.port || url.username || url.password || url.hash || !['/checkoutnow','/checkoutnow/'].includes(url.pathname)
        || url.searchParams.getAll('token').length!==1 || url.searchParams.get('token')!==data.id || [...url.searchParams.keys()].some((key)=>key!=='token'))throw invalid();
      approvalUrl=links[0].href;
    }catch { throw invalid(); }
  }
  // Provider order expiry is not supplied by this response. No fabricated date or paid claim from order approval.
  return { orderId:data.id,intentId:intent.id,merchantId:intent.accountRef,mode:config.mode,currency:intent.money.currency,minor:intent.money.minor,
    status:data.status,approvalUrl,expiresAt:null,capture };
}
async function read(config:PaymentConfig,accessToken:string,intent:CheckoutIntent,id:string) {
  return order(await request(config,accessToken,'/v2/checkout/orders/'+id),config,intent,id);
}
export const paypalOrdersAdapter={ currencyPrecision:paypalCurrencyPrecision,idempotencyRetentionMs:6*3600000,
  async create(config:PaymentConfig,credentials:PaymentCredentials,intent:CheckoutIntent):Promise<PayPalOrderSnapshot> {
    input(intent);const accessToken=await token(config,credentials);
    const body={ intent:'CAPTURE',purchase_units:[{ reference_id:intent.id,custom_id:intent.id,description:intent.name,payee:{ merchant_id:intent.accountRef },
      amount:{ currency_code:intent.money.currency,value:intent.money.amount } }],payment_source:{ paypal:{ experience_context:{
      return_url:intent.successUrl,cancel_url:intent.cancelUrl,user_action:'PAY_NOW',shipping_preference:'NO_SHIPPING' } } } };
    return order(await request(config,accessToken,'/v2/checkout/orders',body,'lop-order:'+intent.id),config,intent,undefined,true);
  },async retrieve(config:PaymentConfig,credentials:PaymentCredentials,intent:CheckoutIntent,id:string):Promise<PayPalOrderSnapshot> {
    input(intent);if(!resourceId.test(id))throw new HttpError(400,'PAYMENT_SESSION_ID_INVALID');return read(config,await token(config,credentials),intent,id);
  },async capture(config:PaymentConfig,credentials:PaymentCredentials,intent:CheckoutIntent,id:string):Promise<{ order:PayPalOrderSnapshot;writePerformed:boolean }> {
    input(intent);if(!resourceId.test(id))throw new HttpError(400,'PAYMENT_SESSION_ID_INVALID');const accessToken=await token(config,credentials);
    const before=await read(config,accessToken,intent,id);
    if(before.status==='COMPLETED')return { order:before,writePerformed:false };
    if(before.status!=='APPROVED')throw new PaymentCheckoutError('PAYMENT_APPROVAL_REQUIRED','REJECTED');
    return { order:order(await request(config,accessToken,'/v2/checkout/orders/'+id+'/capture',{},'lop-capture:'+intent.id),config,intent,id,true),writePerformed:true };
  },async retrievePayment(config:PaymentConfig,credentials:PaymentCredentials,intent:CheckoutIntent,id:string,captureId:string):Promise<PayPalPaymentEvidence> {
    input(intent);if(!resourceId.test(id) || !resourceId.test(captureId))throw new HttpError(400,'PAYMENT_SESSION_ID_INVALID');const accessToken=await token(config,credentials);
    const current=await read(config,accessToken,intent,id);
    if(current.status!=='COMPLETED' || current.capture?.id!==captureId)throw new PaymentCheckoutError('PAYMENT_CAPTURE_MISMATCH','REJECTED');
    const data=await request(config,accessToken,'/v2/payments/captures/'+captureId) as Record<string,any>|null;
    if(!data || Array.isArray(data) || data.id!==captureId || !captureStatuses.includes(data.status) || data.final_capture!==true
      || data.payee?.merchant_id!==intent.accountRef || data.supplementary_data?.related_ids?.order_id!==id || !exactAmount(data.amount,intent))
      throw new PaymentCheckoutError('PAYMENT_CAPTURE_MISMATCH','REJECTED');
    return { schemaVersion:1,source:'INDEPENDENT_ORDER_CAPTURE_READ',orderId:id,captureId,intentId:intent.id,merchantId:intent.accountRef,
      mode:config.mode,currency:intent.money.currency,minor:intent.money.minor,captureStatus:data.status,paymentStatus:data.status==='COMPLETED' ? 'PAID' : 'UNPAID' };
  },
};
// Not registered for customer issuance until durable capture, native confirmation guards and scoped UI are integrated.
