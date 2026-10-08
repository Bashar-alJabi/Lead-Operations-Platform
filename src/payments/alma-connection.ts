import { HttpError } from '../security.js';
import { boundedResponse } from '../media/meta-provider.js';
import { PaymentProviderError } from './provider-errors.js';
import type { PaymentConfig,PaymentCredentials,AlmaPaymentCredentials,PaymentConnectionAdapter,PaymentAuthenticationSnapshot } from './providers.js';
import { normalizePaymentMerchantOffers } from './merchant-offers.js';
import { checkedPaymentEligibility,normalizeEligibilityRequest,type PaymentEligibilityRequest } from './eligibility.js';

export function validateAlmaCredentials(config:PaymentConfig,credentials:PaymentCredentials):asserts credentials is AlmaPaymentCredentials {
  if(!config || !['TEST','LIVE'].includes(config.mode) || Object.keys(config).join(',')!=='mode')throw new HttpError(400,'PAYMENT_CONFIG_INVALID');
  // Alma documents an opaque key, not a Stripe-like mode prefix. Mode is selected by the fixed API environment.
  if(!credentials || Object.keys(credentials).join(',')!=='apiKey' || !('apiKey' in credentials)
    || typeof credentials.apiKey!=='string' || !/^[\x21-\x7e]{20,4096}$/.test(credentials.apiKey))
    throw new HttpError(400,'PAYMENT_CREDENTIAL_MODE_INVALID');
}
export function almaOrigin(mode:PaymentConfig['mode']):string {
  if(mode==='TEST')return 'https://api.sandbox.getalma.eu';
  if(mode==='LIVE')return 'https://api.getalma.eu';
  throw new HttpError(400,'PAYMENT_CONFIG_INVALID');
}
async function almaRead(config:PaymentConfig,credentials:PaymentCredentials,path:'/v1/me/extended-data'|'/v1/me/fee-plans?kind=general&only=all&deferred=true'|'/v2/payments/eligibility',body?:PaymentEligibilityRequest):Promise<unknown> {
  validateAlmaCredentials(config,credentials);let response:Response;
  try { response=await fetch(almaOrigin(config.mode)+path,{
    method:body ? 'POST' : 'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{
      authorization:'Alma-Auth '+credentials.apiKey,accept:'application/json','content-type':'application/json' },...(body ? { body:JSON.stringify({
        purchase_amount:Number(body.money.minor),origin:'online',queries:[{ installments_count:body.plan.installments,deferred_months:body.plan.deferredMonths,deferred_days:body.plan.deferredDays }] }) } : {}) }); }
  catch { throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE'); }
  if([401,403].includes(response.status))throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');
  if(response.status===429)throw new PaymentProviderError('PAYMENT_PROVIDER_RATE_LIMITED');
  if(!response.ok)throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE');
  let data:unknown;
  try { data=JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(await boundedResponse(response,262144))); }
  catch { throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID'); }
  return data;
}
export const almaConnectionAdapter:PaymentConnectionAdapter={ async verify(config,credentials) {
  const data=await almaRead(config,credentials,'/v1/me/extended-data');
  const id=data && typeof data==='object' && !Array.isArray(data) ? (data as Record<string,unknown>).id : null;
  // Technical safe identifier bounds; no guessed provider prefix, fake country or business capability.
  if(typeof id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const authentication:PaymentAuthenticationSnapshot={ schemaVersion:1,profile:'ALMA_ME_V1',accountRef:id,mode:config.mode };
  return { mode:config.mode,authentication };
},async inspectOffers(config,credentials) {
  const identity=await almaConnectionAdapter.verify(config,credentials);
  const raw=await almaRead(config,credentials,'/v1/me/fee-plans?kind=general&only=all&deferred=true');
  if(!Array.isArray(raw) || raw.length>256)throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const plans=raw.map((p:unknown)=> {
    const value=p as Record<string,unknown>|null;
    if(!value || typeof value!=='object' || Array.isArray(value) || value.kind!=='general'
      || ![true,false,0,1].includes(value.allowed as boolean|number)
      || typeof value.min_purchase_amount!=='number' || !Number.isSafeInteger(value.min_purchase_amount)
      || typeof value.max_purchase_amount!=='number' || !Number.isSafeInteger(value.max_purchase_amount))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
    return { installments:value.installments_count,deferredMonths:value.deferred_months,deferredDays:value.deferred_days,
      allowed:value.allowed===true || value.allowed===1,minMinor:String(value.min_purchase_amount),maxMinor:String(value.max_purchase_amount) };
  });
  const offers=normalizePaymentMerchantOffers({ schemaVersion:1,profile:'ALMA_FEE_PLANS_V1',accountRef:identity.authentication!.accountRef,mode:config.mode,plans });
  return { mode:config.mode,authentication:identity.authentication!,offers };
},async inspectEligibility(config,credentials,input) {
  const request=normalizeEligibilityRequest(input);const identity=await almaConnectionAdapter.verify(config,credentials);
  // Eligibility is an assessment, not payment creation. Exactly one explicitly selected query, no provider default plan.
  const raw=await almaRead(config,credentials,'/v2/payments/eligibility',request);
  if(!Array.isArray(raw) || raw.length!==1 || !raw[0] || typeof raw[0]!=='object' || Array.isArray(raw[0]))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const result=raw[0] as Record<string,unknown>;
  const eligibility=checkedPaymentEligibility({ schemaVersion:1,profile:'ALMA_ELIGIBILITY_V2',accountRef:identity.authentication!.accountRef,mode:config.mode,
    money:request.money,plan:{ installments:result.installments_count,deferredMonths:result.deferred_months,deferredDays:result.deferred_days },eligible:result.eligible },request);
  return { mode:config.mode,authentication:identity.authentication!,eligibility };
} };
