import { PaymentProviderError } from './provider-errors.js';
export type MerchantOfferPlan={ installments:number;deferredMonths:number;deferredDays:number;allowed:boolean;minMinor:string;maxMinor:string };
export type PaymentMerchantOffers={ schemaVersion:1;profile:'ALMA_FEE_PLANS_V1';accountRef:string;mode:'TEST'|'LIVE';plans:MerchantOfferPlan[] };
const invalid=()=>new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
export function normalizePaymentMerchantOffers(value:unknown):PaymentMerchantOffers {
  const data=value as Partial<PaymentMerchantOffers>|null;
  if(!data || typeof data!=='object' || Array.isArray(data) || Object.keys(data).sort().join(',')!=='accountRef,mode,plans,profile,schemaVersion'
    || data.schemaVersion!==1 || data.profile!=='ALMA_FEE_PLANS_V1' || !['TEST','LIVE'].includes(data.mode ?? '')
    || typeof data.accountRef!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(data.accountRef)
    || !Array.isArray(data.plans) || data.plans.length>256)throw invalid();
  const seen=new Set<string>();const integer=(v:unknown,min:number)=>typeof v==='number' && Number.isSafeInteger(v) && v>=min && v<=65535;
  const minor=(v:unknown):v is string=>typeof v==='string' && /^(0|[1-9][0-9]{0,15})$/.test(v) && BigInt(v)<=BigInt(Number.MAX_SAFE_INTEGER);
  const plans=data.plans.map((p)=> {
    if(!p || typeof p!=='object' || Array.isArray(p) || Object.keys(p).sort().join(',')!=='allowed,deferredDays,deferredMonths,installments,maxMinor,minMinor'
      || !integer(p.installments,1) || !integer(p.deferredMonths,0) || !integer(p.deferredDays,0) || typeof p.allowed!=='boolean'
      || !minor(p.minMinor) || !minor(p.maxMinor) || BigInt(p.minMinor)>BigInt(p.maxMinor))throw invalid();
    const key=[p.installments,p.deferredMonths,p.deferredDays].join(':');if(seen.has(key))throw invalid();seen.add(key);
    return { installments:p.installments,deferredMonths:p.deferredMonths,deferredDays:p.deferredDays,allowed:p.allowed,minMinor:p.minMinor,maxMinor:p.maxMinor };
  }).sort((a,b)=>a.installments-b.installments || a.deferredMonths-b.deferredMonths || a.deferredDays-b.deferredDays);
  return { schemaVersion:1,profile:'ALMA_FEE_PLANS_V1',accountRef:data.accountRef,mode:data.mode!,plans };
}
