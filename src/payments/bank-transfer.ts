import { createHmac,timingSafeEqual } from 'node:crypto';
import { HttpError,sha256 } from '../security.js';
import { paymentMoney } from './money.js';

export function bankText(value:string,min=1,max=200):string {
  const text=value.trim();
  if(text.length<min || text.length>max || /[\x00-\x1f\x7f]/.test(text))throw new HttpError(400,'BANK_TEXT_INVALID');
  return text;
}
export function bankMoney(amount:string,currency:string) {
  if(!Intl.supportedValuesOf('currency').includes(currency))throw new HttpError(400,'PAYMENT_CURRENCY_INVALID');
  const scale=new Intl.NumberFormat('en',{ style:'currency',currency }).resolvedOptions().maximumFractionDigits;
  return paymentMoney(amount,currency,{ scale:scale ?? 2,quantum:'1' });
}
export type BankSettlement={ eventId:string;transactionId:string;mode:'TEST'|'LIVE';accountIdentifier:string;reference:string;
  amount:string;currency:string;settledAt:string;status:'SETTLED' };
export function parseBankSettlement(raw:Buffer,signature:string|undefined,secret:string,now=Date.now()) {
  const parts=/^t=([0-9]{10}),v1=([a-f0-9]{64})$/.exec(signature ?? '');
  if(!parts || Math.abs(now/1000-Number(parts[1]))>300)throw new HttpError(400,'BANK_SIGNATURE_INVALID');
  const expected=createHmac('sha256',secret).update(parts[1]!+'.').update(raw).digest();
  if(!timingSafeEqual(expected,Buffer.from(parts[2]!,'hex')))throw new HttpError(400,'BANK_SIGNATURE_INVALID');
  let p:BankSettlement;try { p=JSON.parse(raw.toString('utf8')); }catch { throw new HttpError(400,'BANK_EVENT_INVALID'); }
  const keys=['eventId','transactionId','mode','accountIdentifier','reference','amount','currency','settledAt','status'];
  if(!p || typeof p!=='object' || Object.keys(p).length!==keys.length || keys.some((k)=>!Object.hasOwn(p,k))
    || keys.some((k)=>typeof p[k as keyof BankSettlement]!=='string') || !['TEST','LIVE'].includes(p.mode) || p.status!=='SETTLED'
    || !/^BT-[A-F0-9]{32}$/.test(p.reference))throw new HttpError(400,'BANK_EVENT_INVALID');
  bankText(p.eventId,1,200);bankText(p.transactionId,1,200);bankText(p.accountIdentifier,3,200);
  if(p.eventId!==p.eventId.trim() || p.transactionId!==p.transactionId.trim() || p.accountIdentifier!==p.accountIdentifier.trim())throw new HttpError(400,'BANK_EVENT_INVALID');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(p.settledAt) || !Number.isFinite(Date.parse(p.settledAt))
    || Date.parse(p.settledAt)>now+60_000)throw new HttpError(400,'BANK_SETTLEMENT_TIME_INVALID');
  const money=bankMoney(p.amount,p.currency);
  return { ...p,amount:money.amount,minor:money.minor,hash:sha256(JSON.stringify({ ...p,amount:money.amount })) };
}
