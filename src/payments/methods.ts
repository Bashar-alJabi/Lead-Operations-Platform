import { HttpError } from '../security.js';
import type postgres from 'postgres';
import { preparationIssues } from './link-intent.js';
import { paymentCheckoutAdapters } from './checkout-provider.js';

export const paymentCurrencies=Intl.supportedValuesOf('currency');
const knownCurrencies=new Set(paymentCurrencies);
export type PaymentAvailability={ mode:'ALL'|'SELECTED';ids:string[] };
export type PaymentMethodInput={ name:string;branchId:string;connectionId:string;currencies:string[];active:boolean;
  agents:PaymentAvailability;campaigns:PaymentAvailability;reason:string;version?:number };
export function normalizePaymentMethod(input:PaymentMethodInput):PaymentMethodInput {
  const name=input.name.trim();const reason=input.reason.trim();
  if (!name || name.length>100 || /[\x00-\x1f\x7f]/.test(name)) throw new HttpError(400,'PAYMENT_METHOD_NAME_INVALID');
  if (reason.length<3 || reason.length>500 || /[\x00-\x1f\x7f]/.test(reason)) throw new HttpError(400,'PAYMENT_METHOD_REASON_INVALID');
  if (!Array.isArray(input.currencies) || input.currencies.length<1 || input.currencies.length>32
    || input.currencies.some((code)=>!knownCurrencies.has(code)) || new Set(input.currencies).size!==input.currencies.length)
    throw new HttpError(400,'PAYMENT_CURRENCIES_INVALID');
  const normalize=(rule:PaymentAvailability)=> {
    if (!rule || !['ALL','SELECTED'].includes(rule.mode) || !Array.isArray(rule.ids) || rule.ids.length>200
      || rule.ids.some((id)=>typeof id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      || new Set(rule.ids.map((id)=>id.toLowerCase())).size!==rule.ids.length
      || (rule.mode==='ALL' ? rule.ids.length!==0 : rule.ids.length===0)) throw new HttpError(400,'PAYMENT_AVAILABILITY_INVALID');
    return { mode:rule.mode,ids:rule.ids.map((id)=>id.toLowerCase()).sort() };
  };
  return { ...input,name,reason,currencies:[...input.currencies].sort(),agents:normalize(input.agents),campaigns:normalize(input.campaigns) };
}
export function paymentMethodIssues(row:postgres.Row):string[] {
  const issues=preparationIssues(row);
  if(row.provider!=='BANK_TRANSFER' && !paymentCheckoutAdapters[row.provider])issues.push('PAYMENT_CHECKOUT_UNSUPPORTED');
  return issues;
}
