import type postgres from 'postgres';
import { HttpError } from '../security.js';
import { paymentMoney, type CurrencyPrecision } from './money.js';
import { openOpaque } from '../credentials.js';
import type { CheckoutSnapshot } from './checkout-provider.js';
import { paymentIssuanceOptions } from './issuance-profile.js';
import { normalizePaymentPlan,type PaymentPlanSelection } from './eligibility.js';
import { normalizePaymentMerchantOffers } from './merchant-offers.js';

export type PaymentLinkRequest = { requestId:string;methodId:string;methodVersion:number;amount:string;currency:string;plan?:PaymentPlanSelection };
export function normalizedLinkRequest(input:PaymentLinkRequest, precision:CurrencyPrecision) {
  return { requestId:input.requestId.toLowerCase(),methodId:input.methodId.toLowerCase(),methodVersion:input.methodVersion,
    money:paymentMoney(input.amount,input.currency,precision),plan:input.plan===undefined ? null : normalizePaymentPlan(input.plan) };
}

export function availablePaymentPlans(row:postgres.Row) {
  if(row.provider!=='ALMA' || row.capabilities.merchantOffersVersion!==row.connection_version)return [];
  try { const offers=normalizePaymentMerchantOffers(row.capabilities.merchantOffers);
    if(offers.accountRef!==row.capabilities.authentication?.accountRef || offers.mode!==row.config.mode)return [];
    return offers.plans.filter((p)=>p.allowed);
  }catch { return []; }
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
  if(row.provider==='BANK_TRANSFER') {
    if(row.connection_status!=='CONNECTED' || row.capabilities.bankAccountConfigured!==true)issues.push('BANK_ACCOUNT_NOT_READY');
    return issues;
  }
  if(row.connection_status==='DISABLED')issues.push('CONNECTION_DISABLED');
  else if(!['CONNECTED','WARNING'].includes(row.connection_status) || row.capabilities.authenticationVerified!==true)issues.push('PAYMENT_AUTHENTICATION_REQUIRED');
  if(row.provider==='ALMA') {
    try { paymentIssuanceOptions(row.provider,row.config,row.capabilities,row.connection_version); }catch { issues.push('PAYMENT_AUTHENTICATION_REQUIRED'); }
    if(!availablePaymentPlans(row).length)issues.push('PAYMENT_MERCHANT_OFFERS_REQUIRED');
    if(!row.notification_ready)issues.push('PAYMENT_NOTIFICATION_SETUP_REQUIRED');
  }else if(row.provider==='PAYPAL') {
    try { const options=paymentIssuanceOptions(row.provider,row.config,row.capabilities,row.connection_version);
      if(Array.isArray(row.currencies) && row.currencies.some((code:string)=>!options.currencies.includes(code)))issues.push('PAYMENT_CURRENCY_NOT_OFFERED');
    }catch { issues.push('PAYMENT_BENEFICIARY_REQUIRED'); }
  }else if(row.capabilities.paymentOptionsVersion!==row.connection_version || !row.capabilities.paymentOptions)issues.push('PAYMENT_OPTIONS_REQUIRED');
  else if(row.capabilities.paymentOptions.chargesEnabled!==true)issues.push('PAYMENT_ACCOUNT_NOT_READY');
  if(row.provider!=='ALMA' && !row.webhook_ready)issues.push('PAYMENT_WEBHOOK_VERIFICATION_REQUIRED');
  return issues;
}

export function linkIntentDto(row:postgres.Row) {
  let customerUrl:string|null=null;
  if(row.url_available && (row.independent_ciphertext || row.checkout_ciphertext)) {
    const snapshot=JSON.parse(row.independent_ciphertext ? openOpaque('payment-independent-checkout:'+row.independent_proof_id,{ ciphertext:row.independent_ciphertext,nonce:row.independent_nonce,
      authTag:row.independent_auth_tag,keyVersion:row.independent_key_version }) : openOpaque('payment-checkout:'+row.id,{ ciphertext:row.checkout_ciphertext,nonce:row.checkout_nonce,
      authTag:row.checkout_auth_tag,keyVersion:row.checkout_key_version })) as CheckoutSnapshot;
    customerUrl=snapshot.status==='OPEN' ? snapshot.url : null;
  }
  return { id:row.id,methodName:row.method_name,methodVersion:row.method_version,amount:row.amount,currency:row.currency,
    createdAt:row.created_at,state:row.dispatch_state ?? 'QUEUED',errorCode:row.dispatch_error ?? null,customerUrl,
    expiresAt:row.checkout_expires_at ?? null,paymentState:row.payment_state ?? null,paymentReference:row.payment_ref ?? null,
    confirmedAt:row.confirmed_at ?? null,enrollmentId:row.enrollment_id ?? null,enrolledAt:row.enrolled_at ?? null,
    provider:row.provider,plan:row.selected_plan ?? null,linkSource:customerUrl ? row.independent_ciphertext ? 'INDEPENDENT_READ' : 'CREATION_ACK' : null,
    verificationState:row.read_state ?? null,verificationError:row.read_error ?? null,captureState:row.capture_state ?? null,captureError:row.capture_error ?? null,
    captureAvailable:row.provider==='PAYPAL' && row.dispatch_state==='ACCEPTED' && (!row.capture_state || row.capture_state==='BLOCKED') && row.payment_state!=='CONFIRMED',
    financialProcessingReady:true };
}

export async function linkIntentRows(tx:postgres.TransactionSql,leadId:string,limit:number,timestamp:string|null=null,id:string|null=null,onlyIntentId:string|null=null) {
  return tx`SELECT i.id,i.provider,i.selected_plan,i.method_name,i.method_version,i.amount,i.currency,i.created_at,d.state AS dispatch_state,d.error_code AS dispatch_error,
    a.expires_at AS checkout_expires_at,a.ciphertext AS checkout_ciphertext,a.nonce AS checkout_nonce,a.auth_tag AS checkout_auth_tag,a.key_version AS checkout_key_version,
    ((a.expires_at IS NULL OR a.expires_at>clock_timestamp()) AND d.state='ACCEPTED' OR r.session_status='OPEN') AND (p.state IS NULL OR p.state='PENDING')
      AND NOT EXISTS(SELECT 1 FROM payment_capture_job cj WHERE cj.intent_id=i.id)
      AND NOT EXISTS(SELECT 1 FROM payment_confirmation f WHERE f.intent_id=i.id AND f.session_status<>'OPEN')
      AND NOT EXISTS(SELECT 1 FROM payment_independent_read_confirmation f WHERE f.intent_id=i.id AND f.session_status<>'OPEN') AS url_available,
    r.proof_id AS independent_proof_id,r.ciphertext AS independent_ciphertext,r.nonce AS independent_nonce,r.auth_tag AS independent_auth_tag,r.key_version AS independent_key_version,
    j.state AS read_state,j.error_code AS read_error,
    p.state AS payment_state,p.payment_ref,p.confirmed_at,e.id AS enrollment_id,e.enrolled_at,cj.state AS capture_state,cj.error_code AS capture_error
    FROM payment_link_intent i JOIN payment_dispatch d ON d.intent_id=i.id LEFT JOIN payment_checkout_ack a ON a.intent_id=i.id
    LEFT JOIN payment_record p ON p.intent_id=i.id LEFT JOIN enrollment e ON e.payment_id=p.id LEFT JOIN payment_capture_job cj ON cj.intent_id=i.id
    LEFT JOIN LATERAL(SELECT s.*,f.session_status,f.attempt_id FROM payment_independent_read_confirmation f JOIN payment_independent_checkout_snapshot s ON s.proof_id=f.id
      WHERE f.intent_id=i.id ORDER BY f.verified_at DESC,f.id DESC LIMIT 1) r ON true
    LEFT JOIN LATERAL(SELECT job.state,job.error_code FROM payment_untrusted_notification n JOIN payment_independent_read_job job ON job.notification_id=n.id
      WHERE n.connection_id=i.connection_id AND n.mode=i.mode AND n.resource_id=COALESCE(p.session_id,a.session_id)
      ORDER BY n.received_at DESC,n.id DESC LIMIT 1) j ON i.provider='ALMA'
    WHERE i.lead_id=${leadId} AND (${onlyIntentId}::uuid IS NULL OR i.id=${onlyIntentId}::uuid)
      AND (${timestamp}::timestamptz IS NULL OR (i.created_at,i.id)<(${timestamp}::timestamptz,${id}::uuid))
    ORDER BY i.created_at DESC,i.id DESC LIMIT ${limit}`;
}
