import { HttpError } from '../security.js';
import { boundedResponse } from '../media/meta-provider.js';
import type { PaymentConfig,PaymentCredentials,PayPalPaymentCredentials,PaymentConnectionAdapter } from './providers.js';
import { PaymentProviderError } from './provider-errors.js';

export function validatePayPalCredentials(config:PaymentConfig,credentials:PaymentCredentials):asserts credentials is PayPalPaymentCredentials {
  if(!config || !['TEST','LIVE'].includes(config.mode) || Object.keys(config).join(',')!=='mode')throw new HttpError(400,'PAYMENT_CONFIG_INVALID');
  if(!credentials || Object.keys(credentials).sort().join(',')!=='clientId,clientSecret'
    || !('clientId' in credentials) || typeof credentials.clientId!=='string' || !/^[A-Za-z0-9_-]{16,1024}$/.test(credentials.clientId)
    || typeof credentials.clientSecret!=='string' || !/^[A-Za-z0-9_-]{16,4096}$/.test(credentials.clientSecret))
    throw new HttpError(400,'PAYMENT_CREDENTIAL_MODE_INVALID');
}
export function paypalOrigin(mode:PaymentConfig['mode']):string {
  if(mode==='TEST')return 'https://api-m.sandbox.paypal.com';
  if(mode==='LIVE')return 'https://api-m.paypal.com';
  throw new HttpError(400,'PAYMENT_CONFIG_INVALID');
}
// Technical credential exchange only. No capture/order/customer action, hidden retry, persisted token or dynamic URL.
export async function paypalAccessToken(config:PaymentConfig,credentials:PaymentCredentials):Promise<{ accessToken:string;expiresIn:number;appId:string }> {
  validatePayPalCredentials(config,credentials);let response:Response;
  try { response=await fetch(paypalOrigin(config.mode)+'/v1/oauth2/token',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{
      authorization:'Basic '+Buffer.from(credentials.clientId+':'+credentials.clientSecret).toString('base64'),
      'content-type':'application/x-www-form-urlencoded',accept:'application/json' },body:'grant_type=client_credentials' }); }
  catch { throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE'); }
  if([400,401,403].includes(response.status))throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');
  if(response.status===429)throw new PaymentProviderError('PAYMENT_PROVIDER_RATE_LIMITED');
  if(!response.ok)throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE');
  let data:Record<string,unknown>|null;
  try { data=JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(await boundedResponse(response,65536))); }
  catch { throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID'); }
  if(!data || Array.isArray(data) || typeof data.access_token!=='string' || !/^[A-Za-z0-9._~+\/=-]{16,4096}$/.test(data.access_token)
    || typeof data.token_type!=='string' || !/^Bearer$/i.test(data.token_type) || !Number.isSafeInteger(data.expires_in) || (data.expires_in as number)<=0
    || typeof data.app_id!=='string' || !/^APP-[A-Za-z0-9]{8,100}$/.test(data.app_id))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  return { accessToken:data.access_token,expiresIn:data.expires_in as number,appId:data.app_id };
}
export const paypalConnectionAdapter:PaymentConnectionAdapter={ async verify(config,credentials) {
  await paypalAccessToken(config,credentials);
  // Mode comes from the fixed selected environment, not from a client-supplied scope or untrusted response field.
  // OAuth acceptance proves app authentication; it proves neither payee identity, capture capability nor paid money.
  return { mode:config.mode };
},async inspectWebhook(config,credentials,endpointId) {
  if(!/^[A-Z0-9]{8,64}$/.test(endpointId))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const { accessToken }=await paypalAccessToken(config,credentials);let response:Response;
  try { response=await fetch(paypalOrigin(config.mode)+'/v1/notifications/webhooks/'+endpointId,{
    method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{ authorization:'Bearer '+accessToken,accept:'application/json' } }); }
  catch { throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE'); }
  if([401,403].includes(response.status))throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');
  if(response.status===429)throw new PaymentProviderError('PAYMENT_PROVIDER_RATE_LIMITED');
  if(!response.ok)throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE');
  let data:Record<string,unknown>|null;
  try { data=JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(await boundedResponse(response,65536))); }
  catch { throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID'); }
  if(!data || Array.isArray(data) || data.id!==endpointId || typeof data.url!=='string' || data.url.length>2048
    || !Array.isArray(data.event_types) || data.event_types.length<1 || data.event_types.length>256
    || data.event_types.some((e)=>!e || typeof e!=='object' || Array.isArray(e) || typeof e.name!=='string'
      || !/^(\*|[A-Z][A-Z0-9_.-]{1,127})$/.test(e.name) || (e.status!==undefined && !['ENABLED','DISABLED'].includes(e.status))))
    throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  return { mode:config.mode,endpointId,url:data.url,enabled:true,
    enabledEvents:[...new Set(data.event_types.filter((e)=>e.status!=='DISABLED').map((e)=>e.name as string))].sort() };
} };
