import type postgres from 'postgres';
import { HttpError } from '../security.js';
import { paymentMoney, type CurrencyPrecision } from './money.js';
import { openOpaque } from '../credentials.js';
import type { CheckoutSnapshot } from './checkout-provider.js';

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

export function linkIntentDto(row:postgres.Row) {
  let customerUrl:string|null=null;
  if(row.url_available && row.checkout_ciphertext) {
    const snapshot=JSON.parse(openOpaque('payment-checkout:'+row.id,{ ciphertext:row.checkout_ciphertext,nonce:row.checkout_nonce,
      authTag:row.checkout_auth_tag,keyVersion:row.checkout_key_version })) as CheckoutSnapshot;
    customerUrl=snapshot.status==='OPEN' ? snapshot.url : null;
  }
  return { id:row.id,methodName:row.method_name,methodVersion:row.method_version,amount:row.amount,currency:row.currency,
    createdAt:row.created_at,state:row.dispatch_state ?? 'QUEUED',errorCode:row.dispatch_error ?? null,customerUrl,
    expiresAt:row.checkout_expires_at ?? null,paymentState:row.payment_state ?? null,paymentReference:row.payment_ref ?? null,
    confirmedAt:row.confirmed_at ?? null,enrollmentId:row.enrollment_id ?? null,enrolledAt:row.enrolled_at ?? null,
    financialProcessingReady:true };
}

export async function linkIntentRows(tx:postgres.TransactionSql,leadId:string,limit:number,timestamp:string|null=null,id:string|null=null,onlyIntentId:string|null=null) {
  return tx`SELECT i.id,i.method_name,i.method_version,i.amount,i.currency,i.created_at,d.state AS dispatch_state,d.error_code AS dispatch_error,
    a.expires_at AS checkout_expires_at,a.ciphertext AS checkout_ciphertext,a.nonce AS checkout_nonce,a.auth_tag AS checkout_auth_tag,a.key_version AS checkout_key_version,
    a.expires_at>clock_timestamp() AND d.state='ACCEPTED' AND (p.state IS NULL OR p.state='PENDING')
      AND NOT EXISTS(SELECT 1 FROM payment_confirmation f WHERE f.intent_id=i.id AND f.session_status<>'OPEN') AS url_available,
    p.state AS payment_state,p.payment_ref,p.confirmed_at,e.id AS enrollment_id,e.enrolled_at
    FROM payment_link_intent i JOIN payment_dispatch d ON d.intent_id=i.id LEFT JOIN payment_checkout_ack a ON a.intent_id=i.id
    LEFT JOIN payment_record p ON p.intent_id=i.id LEFT JOIN enrollment e ON e.payment_id=p.id
    WHERE i.lead_id=${leadId} AND (${onlyIntentId}::uuid IS NULL OR i.id=${onlyIntentId}::uuid)
      AND (${timestamp}::timestamptz IS NULL OR (i.created_at,i.id)<(${timestamp}::timestamptz,${id}::uuid))
    ORDER BY i.created_at DESC,i.id DESC LIMIT ${limit}`;
}
