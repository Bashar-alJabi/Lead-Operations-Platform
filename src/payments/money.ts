import { HttpError } from '../security.js';
export type CurrencyPrecision={ scale:number;quantum:string };
export type PaymentMoney={ currency:string;amount:string;minor:string;scale:number;quantum:string };
// Representation only. Method/account currency availability and provider min/max are separate gates.
export function paymentMoney(amount:string,currency:string,precision:CurrencyPrecision):PaymentMoney {
  if(typeof currency!=='string' || !/^[A-Z]{3}$/.test(currency) || !Intl.supportedValuesOf('currency').includes(currency))throw new HttpError(400,'PAYMENT_CURRENCY_INVALID');
  if(!precision || !Number.isInteger(precision.scale) || precision.scale<0 || precision.scale>4 || !/^[1-9][0-9]{0,4}$/.test(precision.quantum))throw new HttpError(400,'PAYMENT_PRECISION_INVALID');
  if(typeof amount!=='string' || amount.length>32 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(amount))throw new HttpError(400,'PAYMENT_AMOUNT_INVALID');
  const [whole,fraction='']=amount.split('.');if(fraction.length>precision.scale)throw new HttpError(400,'PAYMENT_AMOUNT_PRECISION_INVALID');
  const padded=fraction.padEnd(precision.scale,'0');const minor=BigInt(whole!)*10n**BigInt(precision.scale)+BigInt(padded || '0');
  if(minor<=0n || minor>BigInt(Number.MAX_SAFE_INTEGER))throw new HttpError(400,'PAYMENT_AMOUNT_INVALID');
  if(minor%BigInt(precision.quantum)!==0n)throw new HttpError(400,'PAYMENT_AMOUNT_PRECISION_INVALID');
  return { currency,amount:whole!+(precision.scale ? '.'+padded : ''),minor:minor.toString(),...precision };
}
