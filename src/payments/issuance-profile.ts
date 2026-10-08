import { HttpError } from '../security.js';
import { normalizePaymentProviderOptions } from './providers.js';
import type { PaymentConfig } from './providers.js';
export const paypalCurrencies=['AUD','BRL','CAD','CHF','CNY','CZK','DKK','EUR','GBP','HKD','HUF','ILS','JPY','MXN','MYR','NOK','NZD','PHP','PLN','RUB','SEK','SGD','THB','TWD','USD'];
// A configured beneficiary and protocol currency representation are not merchant capability verification.
type Capabilities={ paymentOptionsVersion?:number;paymentOptions?:unknown };
export function paymentIssuanceOptions(provider:string,config:PaymentConfig,capabilities:Capabilities,version:number) {
  if(provider==='PAYPAL') {
    if(typeof config.expectedMerchantId!=='string' || !/^[2-9A-HJ-NP-Z]{13}$/.test(config.expectedMerchantId))throw new HttpError(409,'PAYMENT_BENEFICIARY_REQUIRED');
    return { profile:'PAYPAL_ORDERS_V2',accountRef:config.expectedMerchantId,currencies:[...paypalCurrencies],beneficiaryVerification:'CONFIGURED_EXPECTATION' };
  }
  if(capabilities.paymentOptionsVersion!==version || !capabilities.paymentOptions)throw new HttpError(409,'PAYMENT_OPTIONS_REQUIRED');
  return normalizePaymentProviderOptions(capabilities.paymentOptions);
}
