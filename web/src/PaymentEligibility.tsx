import { useEffect,useState } from 'react';
type Locale='ar'|'en'|'fr';
type Plan={ installments:number;deferredMonths:number;deferredDays:number };
export type Eligibility={ schemaVersion:1;profile:'ALMA_ELIGIBILITY_V2';accountRef:string;mode:string;money:{ amount:string;currency:string;minor:string };plan:Plan;eligible:boolean };
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
const labels={
  ar:{ title:'أهلية خطة Alma للمبلغ',guide:'اختر خطة ومبلغًا صراحة. هذا فحص مبلغ شراء EUR لدى المزود، دون موافقة ائتمانية نهائية للعميل ودون إصدار رابط أوتأكيد دفع. يعاد فحص الأهلية عند الإصدار؛ النتيجة تخص المبلغ والخطة المعروضين فقط.',
    amount:'مبلغ فحص أهلية Alma (EUR)',plan:'خطة فحص أهلية Alma',choose:'اختر خطة',inspect:'فحص أهلية خطة Alma',yes:'الخطة مؤهلة للمبلغ المفحوص',no:'الخطة غير مؤهلة للمبلغ المفحوص',last:'آخر نتيجة فحص',history:'أهلية تاريخية',count:'أقساط',months:'شهور تأجيل',days:'أيام تأجيل' },
  en:{ title:'Alma plan eligibility for amount',guide:'Explicitly select a plan and amount. This assesses an EUR purchase amount with the provider, without final customer credit approval, link issuance or paid confirmation. Eligibility is rechecked at issuance; results apply only to their displayed amount and plan.',
    amount:'Alma eligibility amount (EUR)',plan:'Alma eligibility plan',choose:'Choose a plan',inspect:'Inspect Alma plan eligibility',yes:'Plan eligible for the assessed amount',no:'Plan not eligible for the assessed amount',last:'Latest assessment',history:'Historical eligibility',count:'installments',months:'deferred months',days:'deferred days' },
  fr:{ title:'Éligibilité Alma du plan pour le montant',guide:'Choisissez explicitement un plan et un montant. Évaluation d’un achat EUR auprès du fournisseur, sans accord de crédit final du client, émission de lien ou confirmation de paiement. Éligibilité revérifiée à l’émission ; résultat limité au montant et au plan affichés.',
    amount:'Montant d’éligibilité Alma (EUR)',plan:'Plan d’éligibilité Alma',choose:'Choisir un plan',inspect:'Vérifier l’éligibilité du plan Alma',yes:'Plan éligible pour le montant évalué',no:'Plan non éligible pour le montant évalué',last:'Dernière évaluation',history:'Éligibilité historique',count:'échéances',months:'mois différés',days:'jours différés' },
};
export function EligibilityDetails({ data,locale,historical=false }: { data:Eligibility;locale:Locale;historical?:boolean }) {
  const t=labels[locale];return <div className={historical ? 'payment-eligibility-history' : 'payment-eligibility-result'}><h5>{historical ? t.history : t.last}</h5>
    <p><bdi>{data.money.amount} {data.money.currency}</bdi> · <bdi>{data.accountRef}</bdi> · <bdi>{data.mode}</bdi></p>
    <p>{data.plan.installments} {t.count} · {data.plan.deferredMonths} {t.months} · {data.plan.deferredDays} {t.days}</p><p>{data.eligible ? t.yes : t.no}</p></div>;
}
export function PaymentEligibility({ locale,connectionId,version,disabled,plans,current,api,onRefresh }: {
  locale:Locale;connectionId:string;version:number;disabled:boolean;plans:(Plan&{ allowed:boolean })[];current:Eligibility|null;api:Api;onRefresh:()=>Promise<void>
}) {
  const t=labels[locale];const [amount,setAmount]=useState('');const [plan,setPlan]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{ setAmount('');setPlan('');setError(''); },[connectionId,version]);
  const offered=plans.filter((p)=>p.allowed);const key=(p:Plan)=>JSON.stringify({ installments:p.installments,deferredMonths:p.deferredMonths,deferredDays:p.deferredDays });
  async function inspect() {
    if(!plan || !offered.some((p)=>key(p)===plan))return;setBusy(true);setError('');
    try { await api(`/api/payments/connections/${connectionId}/test`,{ method:'POST',body:JSON.stringify({ version,eligibility:{ amount,currency:'EUR',plan:JSON.parse(plan) } }) }); }
    catch(e){ setError(String(e)); }finally { await onRefresh().catch((e)=>setError(String(e)));setBusy(false); }
  }
  return <section className="payment-eligibility"><h4>{t.title}</h4><p>{t.guide}</p>{error && <p role="alert" className="error">{error}</p>}
    <form onSubmit={(e)=>{ e.preventDefault();void inspect(); }}><label>{t.amount}<input aria-label={t.amount} required inputMode="decimal" maxLength={32} disabled={busy || disabled} value={amount} onChange={(e)=>setAmount(e.target.value)} /></label>
      <label>{t.plan}<select aria-label={t.plan} required disabled={busy || disabled} value={plan} onChange={(e)=>setPlan(e.target.value)}><option value="">{t.choose}</option>
        {offered.map((p)=><option key={key(p)} value={key(p)}>{p.installments} {t.count} · {p.deferredMonths} {t.months} · {p.deferredDays} {t.days}</option>)}</select></label>
      <button disabled={busy || disabled || !plan}>{t.inspect}</button></form>{current && <EligibilityDetails data={current} locale={locale} />}</section>;
}
