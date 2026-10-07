import { HttpError } from '../security.js';
import { boundedResponse } from '../media/meta-provider.js';

export type PaymentConfig={ mode:'TEST'|'LIVE' };
export type PaymentCredentials={ apiKey:string };
export type PaymentProviderOptions={ accountRef:string;country:string;defaultCurrency:string;currencies:string[];paymentMethods:string[];
  chargesEnabled:boolean;cardPayments:'ACTIVE'|'INACTIVE'|'PENDING'|'UNKNOWN' };
export type PaymentWebhookInspection={ mode:'TEST'|'LIVE';endpointId:string;url:string;enabled:boolean;enabledEvents:string[] };
export const stripePaymentEvents=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'] as const;
export type PaymentConnectionAdapter={
  verify(config:PaymentConfig,credentials:PaymentCredentials):Promise<{ mode:'TEST'|'LIVE' }>;
  inspect?(config:PaymentConfig,credentials:PaymentCredentials):Promise<{ mode:'TEST'|'LIVE';options:PaymentProviderOptions }>;
  inspectWebhook?(config:PaymentConfig,credentials:PaymentCredentials,endpointId:string):Promise<PaymentWebhookInspection>;
};
export class PaymentProviderError extends Error {
  constructor(public code:'PAYMENT_PROVIDER_AUTH_FAILED'|'PAYMENT_PROVIDER_RATE_LIMITED'|'PAYMENT_PROVIDER_UNAVAILABLE'
    |'PAYMENT_PROVIDER_RESPONSE_INVALID'|'PAYMENT_MODE_MISMATCH'|'PAYMENT_PROVIDER_OPTIONS_UNSUPPORTED'|'PAYMENT_WEBHOOK_UNSUPPORTED'
    |'PAYMENT_WEBHOOK_ENDPOINT_MISMATCH'|'PAYMENT_WEBHOOK_EVENTS_MISSING'|'PAYMENT_WEBHOOK_ENDPOINT_DISABLED') { super(code); }
}
export function validatePaymentCredentials(config:PaymentConfig,credentials:PaymentCredentials,provider='STRIPE'):void {
  if(provider!=='STRIPE')throw new HttpError(400,'PAYMENT_PROVIDER_UNSUPPORTED');
  if(!config || Object.keys(config).join(',')!=='mode')throw new HttpError(400,'PAYMENT_CONFIG_INVALID');
  const mode=config.mode==='TEST' ? 'test' : config.mode==='LIVE' ? 'live' : null;
  if (!mode || !credentials || typeof credentials.apiKey!=='string' || credentials.apiKey.length>4096
    || !new RegExp(`^(rk|sk)_${mode}_[A-Za-z0-9]{16,}$`).test(credentials.apiKey))
    throw new HttpError(400,'PAYMENT_CREDENTIAL_MODE_INVALID');
}
async function stripeRead(path:string,credentials:PaymentCredentials):Promise<unknown> {
  let response:Response;
  try { response=await fetch('https://api.stripe.com'+path,{ method:'GET',redirect:'error',
    headers:{ authorization:'Bearer '+credentials.apiKey },signal:AbortSignal.timeout(8000) }); }
  catch { throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE'); }
  if (response.status===401 || response.status===403) throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');
  if (response.status===429) throw new PaymentProviderError('PAYMENT_PROVIDER_RATE_LIMITED');
  if (!response.ok) throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE');
  try { return JSON.parse((await boundedResponse(response,path==='/v1/balance' ? 65536 : 262144)).toString('utf8')) as unknown; }
  catch { throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID'); }
}
export function normalizePaymentProviderOptions(value:unknown):PaymentProviderOptions {
  const data=value as Partial<PaymentProviderOptions>|null;
  const list=(value:unknown,pattern:RegExp,max:number):string[]=> {
    if(!Array.isArray(value) || value.length<1 || value.length>max || value.some((item)=>typeof item!=='string' || !pattern.test(item))
      || new Set(value).size!==value.length) throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');return [...value].sort();
  };
  if(!data || typeof data!=='object' || Array.isArray(data) || typeof data.accountRef!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(data.accountRef)
    || typeof data.country!=='string' || !/^[A-Z]{2}$/.test(data.country) || typeof data.defaultCurrency!=='string' || !/^[A-Z]{3}$/.test(data.defaultCurrency)
    || typeof data.chargesEnabled!=='boolean' || !['ACTIVE','INACTIVE','PENDING','UNKNOWN'].includes(data.cardPayments ?? '')) throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const currencies=list(data.currencies,/^[A-Z]{3}$/,256);const paymentMethods=list(data.paymentMethods,/^[A-Za-z][A-Za-z0-9_:-]{0,39}$/,100);
  if(!currencies.includes(data.defaultCurrency))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  return { accountRef:data.accountRef,country:data.country,defaultCurrency:data.defaultCurrency,currencies,paymentMethods,chargesEnabled:data.chargesEnabled,cardPayments:data.cardPayments! };
}
// Read-only probes. Balance, bank and business details never enter DTO/history.
export const stripeConnectionAdapter:PaymentConnectionAdapter={ async verify(config,credentials) {
  validatePaymentCredentials(config,credentials);const data=await stripeRead('/v1/balance',credentials);
  if (!data || typeof data!=='object' || Array.isArray(data) || (data as { object?:unknown }).object!=='balance'
    || typeof (data as { livemode?:unknown }).livemode!=='boolean') throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const mode=(data as { livemode:boolean }).livemode ? 'LIVE' : 'TEST';
  if (mode!==config.mode) throw new PaymentProviderError('PAYMENT_MODE_MISMATCH');
  return { mode };
},async inspect(config,credentials) {
  const verified=await stripeConnectionAdapter.verify(config,credentials);
  const account=await stripeRead('/v1/account',credentials) as Record<string,unknown>|null;
  if(!account || Array.isArray(account) || account.object!=='account' || typeof account.id!=='string' || !/^acct_[A-Za-z0-9]{6,100}$/.test(account.id)
    || typeof account.country!=='string' || !/^[A-Z]{2}$/.test(account.country)
    || typeof account.default_currency!=='string' || !/^[a-z]{3}$/.test(account.default_currency))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const spec=await stripeRead('/v1/country_specs/'+account.country,credentials) as Record<string,unknown>|null;
  if(!spec || Array.isArray(spec) || spec.object!=='country_spec' || spec.id!==account.country || !Array.isArray(spec.supported_payment_currencies)
    || spec.supported_payment_currencies.some((code)=>typeof code!=='string' || !/^[a-z]{3}$/.test(code)))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const capabilities=account.capabilities as { card_payments?:unknown }|null;
  if(capabilities!==undefined && capabilities!==null && (typeof capabilities!=='object' || Array.isArray(capabilities)))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const card=capabilities?.card_payments;
  if(card!==undefined && !['active','inactive','pending'].includes(card as string))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  return { ...verified,options:normalizePaymentProviderOptions({ accountRef:account.id,country:account.country,defaultCurrency:account.default_currency.toUpperCase(),
    currencies:spec.supported_payment_currencies.map((code:string)=>code.toUpperCase()),paymentMethods:spec.supported_payment_methods,
    chargesEnabled:account.charges_enabled,cardPayments:typeof card==='string' ? card.toUpperCase() : 'UNKNOWN' }) };
},async inspectWebhook(config,credentials,endpointId) {
  validatePaymentCredentials(config,credentials);
  if(!/^we_[A-Za-z0-9]{6,100}$/.test(endpointId))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const data=await stripeRead('/v1/webhook_endpoints/'+endpointId,credentials) as Record<string,unknown>|null;
  if(!data || Array.isArray(data) || data.object!=='webhook_endpoint' || data.id!==endpointId || typeof data.livemode!=='boolean'
    || typeof data.url!=='string' || data.url.length>2048 || !['enabled','disabled'].includes(data.status as string)
    || !Array.isArray(data.enabled_events) || data.enabled_events.length<1 || data.enabled_events.length>256
    || data.enabled_events.some((e)=>typeof e!=='string' || !/^(\*|[a-z][a-z0-9_.]{1,127})$/.test(e)))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const mode=data.livemode ? 'LIVE' : 'TEST';if(mode!==config.mode)throw new PaymentProviderError('PAYMENT_MODE_MISMATCH');
  return { mode,endpointId,url:data.url,enabled:data.status==='enabled',enabledEvents:[...new Set(data.enabled_events as string[])].sort() };
} };

export type PaymentAdapterRegistry=Readonly<Record<string,PaymentConnectionAdapter>>;
export const paymentConnectionAdapters:PaymentAdapterRegistry={ STRIPE:stripeConnectionAdapter };
