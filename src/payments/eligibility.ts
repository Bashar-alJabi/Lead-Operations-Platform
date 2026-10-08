import { HttpError } from '../security.js';
import { paymentMoney,type PaymentMoney } from './money.js';
import { PaymentProviderError } from './provider-errors.js';
export type PaymentPlanSelection={ installments:number;deferredMonths:number;deferredDays:number };
export type PaymentEligibilityRequest={ money:PaymentMoney;plan:PaymentPlanSelection };
export type PaymentEligibilitySnapshot=PaymentEligibilityRequest&{ schemaVersion:1;profile:'ALMA_ELIGIBILITY_V2';accountRef:string;mode:'TEST'|'LIVE';eligible:boolean };
const exact=(value:unknown,keys:string):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===keys;
export function normalizePaymentPlan(value:unknown):PaymentPlanSelection {
  if(!exact(value,'deferredDays,deferredMonths,installments') || ['installments','deferredMonths','deferredDays'].some((key)=>typeof value[key]!=='number'
    || !Number.isSafeInteger(value[key]) || (value[key] as number)<(key==='installments' ? 1 : 0) || (value[key] as number)>65535))throw new HttpError(400,'PAYMENT_PLAN_INVALID');
  return { installments:value.installments as number,deferredMonths:value.deferredMonths as number,deferredDays:value.deferredDays as number };
}
// Current Alma V2 eligibility explicitly uses int32 EUR cents, not inferred account currencies.
export function almaEligibilityMoney(amount:string,currency:string):PaymentMoney {
  if(currency!=='EUR')throw new HttpError(400,'PAYMENT_CURRENCY_PROFILE_UNSUPPORTED');
  const money=paymentMoney(amount,currency,{ scale:2,quantum:'1' });
  if(BigInt(money.minor)>2147483647n)throw new HttpError(400,'PAYMENT_AMOUNT_INVALID');return money;
}
export function normalizeEligibilityRequest(value:unknown):PaymentEligibilityRequest {
  if(!exact(value,'money,plan') || !exact(value.money,'amount,currency,minor,quantum,scale'))throw new HttpError(400,'PAYMENT_ELIGIBILITY_REQUEST_INVALID');
  const raw=value.money;const money=almaEligibilityMoney(raw.amount as string,raw.currency as string);const plan=normalizePaymentPlan(value.plan);
  if(raw.amount!==money.amount || raw.minor!==money.minor || raw.scale!==money.scale || raw.quantum!==money.quantum)throw new HttpError(400,'PAYMENT_ELIGIBILITY_REQUEST_INVALID');
  return { money,plan };
}
export function checkedPaymentEligibility(value:unknown,request:PaymentEligibilityRequest):PaymentEligibilitySnapshot {
  try {
    if(!exact(value,'accountRef,eligible,mode,money,plan,profile,schemaVersion') || value.schemaVersion!==1 || value.profile!=='ALMA_ELIGIBILITY_V2'
      || typeof value.accountRef!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.accountRef)
      || !['TEST','LIVE'].includes(value.mode as string) || typeof value.eligible!=='boolean')throw new Error('invalid');
    const normalized=normalizeEligibilityRequest({ money:value.money,plan:value.plan });const expected=normalizeEligibilityRequest(request);
    if(JSON.stringify(normalized)!==JSON.stringify(expected))throw new Error('mismatch');
    return { schemaVersion:1,profile:'ALMA_ELIGIBILITY_V2',accountRef:value.accountRef,mode:value.mode as 'TEST'|'LIVE',...normalized,eligible:value.eligible };
  }catch { throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID'); }
}
