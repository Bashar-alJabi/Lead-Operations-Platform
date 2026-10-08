import { HttpError } from '../security.js';
import { boundedResponse } from '../media/meta-provider.js';
import { almaConnectionAdapter,almaOrigin,validateAlmaCredentials } from './alma-connection.js';
import { normalizeEligibilityRequest,type PaymentPlanSelection } from './eligibility.js';
import { PaymentCheckoutError,PaymentProviderError } from './provider-errors.js';
import type { CheckoutIntent } from './checkout-provider.js';
import type { PaymentConfig,PaymentCredentials } from './providers.js';
export type AlmaHostedIntent=CheckoutIntent&{ plan:PaymentPlanSelection;ipnUrl:string };
export type AlmaProcessingStatus='awaiting_authorization'|'authorized'|'captured'|'canceled';
export type AlmaHostedSnapshot={ paymentId:string;intentId:string;merchantId:string;mode:'TEST'|'LIVE';currency:'EUR';minor:string;plan:PaymentPlanSelection;
  processingStatus:AlmaProcessingStatus;customerUrl:string|null;expiresAt:null;refundMinor:string;completelyRefunded:boolean };
export type AlmaPaymentEvidence={ schemaVersion:1;source:'INDEPENDENT_ALMA_PAYMENT_READ';paymentId:string;intentId:string;merchantId:string;mode:'TEST'|'LIVE';currency:'EUR';minor:string;
  installments:number;deferredMonths:number;deferredDays:number;processingStatus:AlmaProcessingStatus;refundMinor:string;refundState:'NONE'|'PARTIAL'|'FULL';paymentStatus:'PAID'|'UNPAID' };
const paymentId=/^payment_[A-Za-z0-9]{1,120}$/;
const invalid=(write=false)=>new PaymentCheckoutError('PAYMENT_PROVIDER_RESPONSE_INVALID',write ? 'UNKNOWN' : 'REJECTED');
function input(intent:AlmaHostedIntent):void {
  if(!intent || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(intent.id)
    || typeof intent.accountRef!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(intent.accountRef)
    || typeof intent.name!=='string' || !intent.name.trim() || intent.name.length>100 || /[\x00-\x1f\x7f]/.test(intent.name))throw new HttpError(400,'PAYMENT_INTENT_INVALID');
  normalizeEligibilityRequest({ money:intent.money,plan:intent.plan });
  for(const value of [intent.successUrl,intent.cancelUrl,intent.ipnUrl]) {
    let url:URL;try { url=new URL(value); }catch { throw new HttpError(400,'PAYMENT_RETURN_URL_INVALID'); }
    if(typeof value!=='string' || value.length>2048 || /[\x00-\x1f\x7f]/.test(value) || url.username || url.password || url.hash || !['https:','http:'].includes(url.protocol)
      || (url.protocol==='https:' && !!url.port) || (url.protocol==='http:' && (process.env.NODE_ENV==='production' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new HttpError(400,'PAYMENT_RETURN_URL_INVALID');
  }
  if(new URL(intent.successUrl).origin!==new URL(intent.cancelUrl).origin || new URL(intent.ipnUrl).search)throw new HttpError(400,'PAYMENT_RETURN_URL_INVALID');
}
async function readOrWrite(config:PaymentConfig,credentials:PaymentCredentials,path:string,body?:object):Promise<unknown> {
  validateAlmaCredentials(config,credentials);const write=body!==undefined;let response:Response;
  try { response=await fetch(almaOrigin(config.mode)+path,{ method:write ? 'POST' : 'GET',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{ authorization:'Alma-Auth '+credentials.apiKey,accept:'application/json','content-type':'application/json' },...(write ? { body:JSON.stringify(body) } : {}) }); }
  catch { throw new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE',write ? 'UNKNOWN' : 'RETRYABLE'); }
  if([401,403].includes(response.status))throw new PaymentCheckoutError('PAYMENT_PROVIDER_AUTH_FAILED','REJECTED');
  if(response.status===429)throw new PaymentCheckoutError('PAYMENT_PROVIDER_RATE_LIMITED',write ? 'UNKNOWN' : 'RETRYABLE');
  if(!response.ok)throw new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE',write ? 'UNKNOWN' : 'RETRYABLE');
  try { return JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(await boundedResponse(response,262144))); }
  catch { throw invalid(write); }
}
function snapshot(raw:unknown,config:PaymentConfig,intent:AlmaHostedIntent,expectedId?:string,write=false):AlmaHostedSnapshot {
  const data=raw as Record<string,unknown>|null;const fail=()=>invalid(write);
  if(!data || typeof data!=='object' || Array.isArray(data) || typeof data.id!=='string' || !paymentId.test(data.id) || (expectedId && data.id!==expectedId)
    || data.merchant_id!==intent.accountRef || typeof data.purchase_amount!=='number' || !Number.isSafeInteger(data.purchase_amount) || String(data.purchase_amount)!==intent.money.minor
    || (data.currency!==undefined && data.currency!=='EUR') || !['awaiting_authorization','authorized','captured','canceled'].includes(data.processing_status as string)
    || !data.custom_data || typeof data.custom_data!=='object' || Array.isArray(data.custom_data) || (data.custom_data as Record<string,unknown>).intentId!==intent.id
    || (data.capture_method!==undefined && data.capture_method!=='automatic') || data.is_deferred_capture!==false
    || typeof data.amount_already_refunded!=='number' || !Number.isSafeInteger(data.amount_already_refunded) || data.amount_already_refunded<0 || data.amount_already_refunded>data.purchase_amount
    || typeof data.is_completely_refunded!=='boolean' || data.is_completely_refunded!==(data.amount_already_refunded===data.purchase_amount))throw fail();
  let plan:PaymentPlanSelection;
  try { plan=normalizeEligibilityRequest({ money:intent.money,plan:{ installments:data.installments_count,deferredMonths:data.deferred_months,deferredDays:data.deferred_days } }).plan; }
  catch { throw fail(); }
  if(plan.installments!==intent.plan.installments || plan.deferredMonths!==intent.plan.deferredMonths || plan.deferredDays!==intent.plan.deferredDays)throw fail();
  let customerUrl:string|null=null;
  if(['awaiting_authorization','authorized'].includes(data.processing_status as string)) {
    if(typeof data.url!=='string' || data.url.length>2048 || /[\x00-\x1f\x7f]/.test(data.url))throw fail();
    try { const url=new URL(data.url);if(url.protocol!=='https:' || url.hostname!==(config.mode==='TEST' ? 'pay.sandbox.getalma.eu' : 'pay.getalma.eu')
      || url.port || url.username || url.password || url.search || url.hash || !['/'+data.id,'/'+data.id.slice('payment_'.length)].includes(url.pathname))throw fail();customerUrl=data.url; }
    catch { throw fail(); }
  }
  // Old installment state, future expiry, customer fees and payer metadata never establish merchant money.
  return { paymentId:data.id,intentId:intent.id,merchantId:intent.accountRef,mode:config.mode,currency:'EUR',minor:intent.money.minor,plan,
    processingStatus:data.processing_status as AlmaProcessingStatus,customerUrl,expiresAt:null,refundMinor:String(data.amount_already_refunded),completelyRefunded:data.is_completely_refunded };
}
export const almaHostedAdapter={ writeReplay:'NEVER' as const,dispatchBudgetMs:30000,
  async create(config:PaymentConfig,credentials:PaymentCredentials,intent:AlmaHostedIntent):Promise<AlmaHostedSnapshot> {
    input(intent);validateAlmaCredentials(config,credentials);
    // Preflight failures are known to occur before payment creation. No hidden retry or invented provider key.
    try { const verified=await almaConnectionAdapter.inspectEligibility!(config,credentials,{ money:intent.money,plan:intent.plan });
      if(verified.eligibility.accountRef!==intent.accountRef)throw new PaymentCheckoutError('PAYMENT_ACCOUNT_MISMATCH','REJECTED');
      if(!verified.eligibility.eligible)throw new PaymentCheckoutError('PAYMENT_ACCOUNT_NOT_READY','REJECTED');
    }catch(error) { if(error instanceof PaymentProviderError) {
        const code=error.code==='PAYMENT_PROVIDER_AUTH_FAILED' ? 'PAYMENT_PROVIDER_AUTH_FAILED' : error.code==='PAYMENT_PROVIDER_RATE_LIMITED' ? 'PAYMENT_PROVIDER_RATE_LIMITED'
          : error.code==='PAYMENT_PROVIDER_RESPONSE_INVALID' ? 'PAYMENT_PROVIDER_RESPONSE_INVALID' : 'PAYMENT_PROVIDER_UNAVAILABLE';
        throw new PaymentCheckoutError(code,'REJECTED');
      }throw error; }
    const raw=await readOrWrite(config,credentials,'/v1/payments',{ origin:'online',payment:{ purchase_amount:Number(intent.money.minor),installments_count:intent.plan.installments,
      deferred_months:intent.plan.deferredMonths,deferred_days:intent.plan.deferredDays,capture_method:'automatic',return_url:intent.successUrl,
      customer_cancel_url:intent.cancelUrl,failure_return_url:intent.cancelUrl,ipn_callback_url:intent.ipnUrl,custom_data:{ intentId:intent.id } } });
    return snapshot(raw,config,intent,undefined,true);
  },
  async retrieve(config:PaymentConfig,credentials:PaymentCredentials,intent:AlmaHostedIntent,id:string):Promise<AlmaHostedSnapshot> {
    input(intent);validateAlmaCredentials(config,credentials);if(!paymentId.test(id))throw new HttpError(400,'PAYMENT_SESSION_INVALID');
    const identity=await almaConnectionAdapter.verify(config,credentials).catch((error)=> { if(error instanceof PaymentProviderError) {
        const code=error.code==='PAYMENT_PROVIDER_AUTH_FAILED' ? 'PAYMENT_PROVIDER_AUTH_FAILED' : error.code==='PAYMENT_PROVIDER_RATE_LIMITED' ? 'PAYMENT_PROVIDER_RATE_LIMITED'
          : error.code==='PAYMENT_PROVIDER_RESPONSE_INVALID' ? 'PAYMENT_PROVIDER_RESPONSE_INVALID' : 'PAYMENT_PROVIDER_UNAVAILABLE';
        throw new PaymentCheckoutError(code,code==='PAYMENT_PROVIDER_AUTH_FAILED' || code==='PAYMENT_PROVIDER_RESPONSE_INVALID' ? 'REJECTED' : 'RETRYABLE'); }throw error; });
    if(identity.authentication?.accountRef!==intent.accountRef)throw new PaymentCheckoutError('PAYMENT_ACCOUNT_MISMATCH','REJECTED');
    return snapshot(await readOrWrite(config,credentials,'/v1/payments/'+id),config,intent,id);
  },
  async retrievePayment(config:PaymentConfig,credentials:PaymentCredentials,intent:AlmaHostedIntent,id:string):Promise<AlmaPaymentEvidence> {
    const payment=await almaHostedAdapter.retrieve(config,credentials,intent,id);
    return { schemaVersion:1,source:'INDEPENDENT_ALMA_PAYMENT_READ',paymentId:payment.paymentId,intentId:payment.intentId,merchantId:payment.merchantId,mode:payment.mode,currency:payment.currency,minor:payment.minor,
      ...payment.plan,processingStatus:payment.processingStatus,refundMinor:payment.refundMinor,refundState:payment.completelyRefunded ? 'FULL' : payment.refundMinor==='0' ? 'NONE' : 'PARTIAL',
      paymentStatus:payment.processingStatus==='captured' && payment.refundMinor==='0' ? 'PAID' : 'UNPAID' };
  },
};
