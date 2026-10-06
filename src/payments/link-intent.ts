import type postgres from 'postgres';
import { HttpError } from '../security.js';
import { paymentMoney, type CurrencyPrecision } from './money.js';

export type PaymentLinkRequest = { requestId:string;methodId:string;methodVersion:number;amount:string;currency:string };
export function normalizedLinkRequest(input:PaymentLinkRequest, precision:CurrencyPrecision) {
  return { requestId:input.requestId.toLowerCase(),methodId:input.methodId.toLowerCase(),methodVersion:input.methodVersion,
    money:paymentMoney(input.amount,input.currency,precision) };
}

// Deployment return targets are snapshotted, never supplied by the customer or operational user.
export function paymentReturnTargets() {
  let url:URL;try { url=new URL(process.env.APP_ORIGIN ?? ''); }catch{ throw new HttpError(503,'PAYMENT_RETURN_ORIGIN_NOT_CONFIGURED'); }
  if(url.username || url.password || url.search || url.hash || url.pathname!=='/' || url.origin.length>1900
    || !['http:','https:'].includes(url.protocol) || (url.protocol==='http:' && (process.env.NODE_ENV==='production'
      || !['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new HttpError(503,'PAYMENT_RETURN_ORIGIN_NOT_CONFIGURED');
  return { successUrl:url.origin+'/?paymentReturn=success',cancelUrl:url.origin+'/?paymentReturn=cancel' };
}

export function preparationIssues(row:postgres.Row):string[] {
  const issues:string[]=[];
  if(!row.active)issues.push('PAYMENT_METHOD_INACTIVE');
  if(!row.branch_active)issues.push('BRANCH_DISABLED');
  if(row.connection_status==='DISABLED')issues.push('CONNECTION_DISABLED');
  else if(!['CONNECTED','WARNING'].includes(row.connection_status) || row.capabilities.authenticationVerified!==true)issues.push('PAYMENT_AUTHENTICATION_REQUIRED');
  if(row.capabilities.paymentOptionsVersion!==row.connection_version || !row.capabilities.paymentOptions)issues.push('PAYMENT_OPTIONS_REQUIRED');
  else if(row.capabilities.paymentOptions.chargesEnabled!==true)issues.push('PAYMENT_ACCOUNT_NOT_READY');
  if(!row.webhook_ready)issues.push('PAYMENT_WEBHOOK_VERIFICATION_REQUIRED');
  return issues;
}

// PREPARED means durable request only. No URL, provider send or payment confirmation is implied.
export function linkIntentDto(row:postgres.Row) {
  return { id:row.id,methodName:row.method_name,methodVersion:row.method_version,amount:row.amount,currency:row.currency,
    createdAt:row.created_at,state:'PREPARED' as const,customerUrl:null,financialProcessingReady:false };
}
