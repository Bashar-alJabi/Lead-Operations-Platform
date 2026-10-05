import { HttpError } from '../security.js';
import { boundedResponse } from '../media/meta-provider.js';

export type PaymentConfig={ mode:'TEST'|'LIVE' };
export type PaymentCredentials={ apiKey:string };
export type PaymentConnectionAdapter={
  verify(config:PaymentConfig,credentials:PaymentCredentials):Promise<{ mode:'TEST'|'LIVE' }>;
};
export class PaymentProviderError extends Error {
  constructor(public code:'PAYMENT_PROVIDER_AUTH_FAILED'|'PAYMENT_PROVIDER_RATE_LIMITED'|'PAYMENT_PROVIDER_UNAVAILABLE'
    |'PAYMENT_PROVIDER_RESPONSE_INVALID'|'PAYMENT_MODE_MISMATCH') { super(code); }
}
export function validatePaymentCredentials(config:PaymentConfig,credentials:PaymentCredentials):void {
  const mode=config.mode==='TEST' ? 'test' : config.mode==='LIVE' ? 'live' : null;
  if (!mode || !credentials || typeof credentials.apiKey!=='string' || credentials.apiKey.length>4096
    || !new RegExp(`^(rk|sk)_${mode}_[A-Za-z0-9]{16,}$`).test(credentials.apiKey))
    throw new HttpError(400,'PAYMENT_CREDENTIAL_MODE_INVALID');
}
// Authentication probe only; no balance amount is retained or returned to the application.
export const stripeConnectionAdapter:PaymentConnectionAdapter={ async verify(config,credentials) {
  validatePaymentCredentials(config,credentials);
  let response:Response;
  try { response=await fetch('https://api.stripe.com/v1/balance',{ method:'GET',redirect:'error',
    headers:{ authorization:'Bearer '+credentials.apiKey },signal:AbortSignal.timeout(8000) }); }
  catch { throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE'); }
  if (response.status===401 || response.status===403) throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');
  if (response.status===429) throw new PaymentProviderError('PAYMENT_PROVIDER_RATE_LIMITED');
  if (!response.ok) throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE');
  let data:unknown;
  try { data=JSON.parse((await boundedResponse(response,65536)).toString('utf8')); }
  catch { throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID'); }
  if (!data || typeof data!=='object' || Array.isArray(data) || (data as { object?:unknown }).object!=='balance'
    || typeof (data as { livemode?:unknown }).livemode!=='boolean') throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const mode=(data as { livemode:boolean }).livemode ? 'LIVE' : 'TEST';
  if (mode!==config.mode) throw new PaymentProviderError('PAYMENT_MODE_MISMATCH');
  return { mode };
} };

export type PaymentAdapterRegistry=Readonly<Record<string,PaymentConnectionAdapter>>;
export const paymentConnectionAdapters:PaymentAdapterRegistry={ STRIPE:stripeConnectionAdapter };
