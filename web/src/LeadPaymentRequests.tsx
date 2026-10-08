import { useEffect, useRef, useState } from 'react';
type Locale='ar'|'en'|'fr';type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Plan={ installments:number;deferredMonths:number;deferredDays:number };
type Method={ id:string;name:string;version:number;currencies:string[];provider:string;plans:(Plan&{ minMinor:string;maxMinor:string })[];preparationAvailable:boolean;issues:string[] };
type Intent={ id:string;methodName:string;methodVersion:number;amount:string;currency:string;createdAt:string;state:string;customerUrl:string|null;
  errorCode:string|null;expiresAt:string|null;paymentState:string|null;paymentReference:string|null;confirmedAt:string|null;enrollmentId:string|null;enrolledAt:string|null;
  provider:string;plan:Plan|null;linkSource:string|null;verificationState:string|null;verificationError:string|null;captureState:string|null;captureError:string|null;captureAvailable:boolean };
type FinancialHistory={ id:string;session_id:string;session_status:string;payment_status:string;verified_at:string };
const almaLabels={
  ar:{ plan:'خطة طلب Alma',count:'أقساط',months:'شهور تأجيل',days:'أيام تأجيل',note:'اختر خطة صراحة؛ يُعاد فحص أهليتها للمبلغ قبل الإصدار. إشعار Alma غير الموقّع وعودة العميل لا يثبتان الدفع. القراءة المالية المستقلة المطابقة وحالة captured هما المطلوبان قبل تأكيد الاشتراك.',read:'حالة الفحص المستقل',history:'تاريخ الفحص المالي الموثوق',more:'فحوص مالية أقدم',recovered:'رابط مستعاد من قراءة مستقلة؛ لم يُنشأ دفع جديد.',review:'تحتاج المراجعة إلى Manager أوSuper Admin من إعداد الدفع؛ لا تعِد إنشاء الطلب عند نتيجة UNKNOWN.' },
  en:{ plan:'Alma request plan',count:'installments',months:'deferred months',days:'deferred days',note:'Explicitly select a plan; amount eligibility is rechecked before issuance. Unsigned Alma notifications and customer returns do not prove payment. Matching independent financial reads and captured status are required before enrollment.',read:'Independent read status',history:'Trusted financial read history',more:'Older financial reads',recovered:'Link recovered from an independent read; no new payment was created.',review:'A Manager or Super Admin must review payment setup. Do not recreate the request after UNKNOWN.' },
  fr:{ plan:'Plan de la demande Alma',count:'échéances',months:'mois différés',days:'jours différés',note:'Choisissez explicitement un plan ; éligibilité du montant revérifiée avant émission. Notification Alma non signée et retour client ne prouvent pas le paiement. Lecture financière indépendante conforme et état captured requis avant inscription.',read:'État de lecture indépendante',history:'Historique des lectures financières fiables',more:'Lectures financières antérieures',recovered:'Lien récupéré par lecture indépendante ; aucun nouveau paiement créé.',review:'Un Manager ouSuper Admin doit examiner la configuration. Ne recréez pas la demande après UNKNOWN.' },
};
const states={ ar:{ QUEUED:'بانتظار الإصدار',RUNNING:'جارٍ إصدار الرابط',RETRY:'إعادة محاولة مجدولة',ACCEPTED:'صدر الرابط',FAILED:'فشل الإصدار',BLOCKED:'الإصدار محجوب',NEEDS_ATTENTION:'يحتاج مراجعة — لا تفترض فشل الدفع',PENDING:'بانتظار الدفع',EXPIRED:'منتهي',CONFIRMED:'دفع مؤكد' },
  en:{ QUEUED:'Waiting for issuance',RUNNING:'Issuing link',RETRY:'Scheduled retry',ACCEPTED:'Link issued',FAILED:'Failed',BLOCKED:'Issuance blocked',NEEDS_ATTENTION:'Needs attention — do not assume payment failed',PENDING:'Payment pending',EXPIRED:'Expired',CONFIRMED:'Payment confirmed' },
  fr:{ QUEUED:'Émission en attente',RUNNING:'Émission en cours',RETRY:'Nouvelle tentative prévue',ACCEPTED:'Lien émis',FAILED:'Échec',BLOCKED:'Émission bloquée',NEEDS_ATTENTION:'À examiner — paiement non déterminé',PENDING:'Paiement en attente',EXPIRED:'Expiré',CONFIRMED:'Paiement confirmé' } };
const financeLabels={ ar:{ open:'فتح رابط الدفع',copy:'نسخ رابط الدفع',copied:'نُسخ الرابط.',expires:'انتهاء الرابط',payment:'حالة الدفع',enrolled:'اشتراك مؤكد',reference:'مرجع الدفع',history:'محاولات الإصدار' },
  en:{ open:'Open payment link',copy:'Copy payment link',copied:'Link copied.',expires:'Link expiry',payment:'Payment status',enrolled:'Enrollment confirmed',reference:'Payment reference',history:'Issuance attempts' },
  fr:{ open:'Ouvrir le lien de paiement',copy:'Copier le lien de paiement',copied:'Lien copié.',expires:'Expiration du lien',payment:'État du paiement',enrolled:'Inscription confirmée',reference:'Référence du paiement',history:'Tentatives d’émission' } };
const captureLabels={ ar:{ action:'طلب تنفيذ PayPal capture',history:'محاولات PayPal capture',state:'حالة تنفيذ capture',note:'يقرأ Worker موافقة العميل من PayPal قبل التنفيذ. قبول capture لا يؤكد الدفع؛ التأكيد يحتاج إيصالًا موقّعًا وقراءة مالية مستقلة.',accepted:'قبِل المزود التنفيذ — بانتظار التأكيد المالي',expiry:'المزود لم يحدد انتهاء الرابط؛ لا تفترض بقاءه صالحًا.' },
  en:{ action:'Request PayPal capture',history:'PayPal capture attempts',state:'Capture execution status',note:'The worker reads buyer approval from PayPal before execution. Capture acceptance does not confirm payment; a signed receipt and independent financial reads are required.',accepted:'Provider accepted capture — awaiting financial confirmation',expiry:'The provider did not specify link expiry; continued validity is not guaranteed.' },
  fr:{ action:'Demander la capture PayPal',history:'Tentatives de capture PayPal',state:'État de la capture',note:'Le worker vérifie l’approbation auprès de PayPal avant exécution. La capture acceptée ne confirme pas le paiement ; un événement signé et une lecture financière indépendante sont requis.',accepted:'Capture acceptée — confirmation financière attendue',expiry:'Le fournisseur n’a pas indiqué d’expiration ; la validité du lien n’est pas garantie.' } };
const labels={
  ar:{ title:'طلبات روابط الدفع',note:'يصدر Worker الرابط بعد إعادة التحقق من الصلاحيات والطريقة والحساب ومصدر التأكيد. فتح الرابط أوصفحة النجاح لا يؤكد الدفع. يتطلب الاشتراك تحققًا ماليًا موثوقًا لدى المزود.',
    method:'طريقة طلب الدفع',amount:'مبلغ طلب الدفع',currency:'عملة طلب الدفع',prepare:'حفظ طلب رابط الدفع',refresh:'تحديث طلبات الدفع',more:'طلبات دفع إضافية',moreMethods:'طرق طلب إضافية',choose:'اختر طريقة',
    empty:'لا توجد طلبات محفوظة.',saved:'حُفظ الطلب مرة واحدة. تابع حالة الإصدار أدناه.',unavailable:'طريقة غير جاهزة',hint:'أدخل المبلغ بأرقام إنجليزية ونقطة عشرية، دون تقريب أو فواصل الآلاف.',date:'تاريخ الطلب' },
  en:{ title:'Payment link requests',note:'The worker issues a link after rechecking access, method, account and confirmation source. Opening a link or success page does not confirm payment. Enrollment requires trusted financial verification with the provider.',
    method:'Payment request method',amount:'Payment request amount',currency:'Payment request currency',prepare:'Save payment link request',refresh:'Refresh payment requests',more:'More payment requests',moreMethods:'More request methods',choose:'Choose a method',
    empty:'No saved requests.',saved:'Request saved once. Track issuance below.',unavailable:'Method not ready',hint:'Use English digits and a decimal point, without rounding or thousands separators.',date:'Request date' },
  fr:{ title:'Demandes de liens de paiement',note:'Le worker émet le lien après vérification des droits, du moyen, du compte et de la source de confirmation. Ouvrir le lien oula page de succès ne confirme pas le paiement. L’inscription exige une vérification financière fiable auprès du fournisseur.',
    method:'Moyen de la demande',amount:'Montant de la demande',currency:'Devise de la demande',prepare:'Enregistrer la demande de lien',refresh:'Actualiser les demandes',more:'Autres demandes',moreMethods:'Autres moyens',choose:'Choisir un moyen',
    empty:'Aucune demande enregistrée.',saved:'Demande enregistrée une fois. Consultez son état ci-dessous.',unavailable:'Moyen indisponible',hint:'Utilisez des chiffres anglais et un point décimal, sans arrondi ni séparateur de milliers.',date:'Date de demande' },
} as const;
export function LeadPaymentRequests({ locale,leadId,api,onPrepareMessage }: { locale:Locale;leadId:string;api:Api;onPrepareMessage:(intentId:string)=>void }) {
  const t=labels[locale];const [methods,setMethods]=useState<Method[]>([]);const [items,setItems]=useState<Intent[]>([]);
  const [methodCursor,setMethodCursor]=useState<string|null>(null);const [cursor,setCursor]=useState<string|null>(null);
  const [methodId,setMethodId]=useState('');const [amount,setAmount]=useState('');const [currency,setCurrency]=useState('');
  const [plan,setPlan]=useState('');const a=almaLabels[locale];const planKey=(p:Plan)=>JSON.stringify({ installments:p.installments,deferredMonths:p.deferredMonths,deferredDays:p.deferredDays });
  const [financialHistory,setFinancialHistory]=useState<FinancialHistory[]>([]);const [financialCursor,setFinancialCursor]=useState<string|null>(null);const [financialIntent,setFinancialIntent]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState(false);
  const [copied,setCopied]=useState(false);const [attempts,setAttempts]=useState<{ number:number;state:string;error_code:string|null }[]>([]);
  const pending=useRef<{ fingerprint:string;requestId:string }|null>(null);const generation=useRef(0);
  const selected=methods.find((m)=>m.id===methodId);const root=`/api/leads/${leadId}`;
  async function loadMethods(next?:string) { const page=await api<{ items:Method[];nextCursor:string|null }>(root+'/payment-link-options'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setMethods((old)=>next ? [...old,...page.items.filter((m)=>m.provider!=='BANK_TRANSFER')] : page.items.filter((m)=>m.provider!=='BANK_TRANSFER'));setMethodCursor(page.nextCursor); }
  async function loadRequests(next?:string) { const page=await api<{ items:Intent[];nextCursor:string|null }>(root+'/payment-link-requests'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setItems((old)=>next ? [...old,...page.items] : page.items);setCursor(page.nextCursor); }
  useEffect(()=> { const version=++generation.current;setBusy(true);setError('');
    setMethodId('');setPlan('');setAmount('');setCurrency('');setFinancialHistory([]);setFinancialIntent(null);setFinancialCursor(null);
    void Promise.all([api<{ items:Method[];nextCursor:string|null }>(root+'/payment-link-options'),api<{ items:Intent[];nextCursor:string|null }>(root+'/payment-link-requests')])
      .then(([options,requests])=>{ if(version!==generation.current)return;setMethods(options.items.filter((m)=>m.provider!=='BANK_TRANSFER'));setMethodCursor(options.nextCursor);setItems(requests.items);setCursor(requests.nextCursor); })
      .catch((e)=>{ if(version===generation.current)setError(String(e)); }).finally(()=>{ if(version===generation.current)setBusy(false); });
    return ()=>{ generation.current++; };
  },[leadId]);
  async function action(run:()=>Promise<void>) { setBusy(true);setError('');try { await run(); }catch(e){ setError(String(e)); }finally{ setBusy(false); } }
  async function readFinancial(id:string,cursor?:string) {
    const version=generation.current;
    const result=await api<{ items:FinancialHistory[];nextCursor:string|null }>(root+'/payment-link-requests/'+id+'/financial-history'+(cursor ? '?cursor='+encodeURIComponent(cursor) : ''));
    if(version!==generation.current)return;
    setFinancialIntent(id);setFinancialHistory((p)=>cursor ? [...p,...result.items] : result.items);setFinancialCursor(result.nextCursor);
  }
  async function save() {
    if(!selected || !selected.preparationAvailable)return;
    if(selected.provider==='ALMA' && (!plan || !selected.plans.some((p)=>planKey(p)===plan)))return;
    const body={ methodId:selected.id,methodVersion:selected.version,amount,currency,...(selected.provider==='ALMA' ? { plan:JSON.parse(plan) as Plan } : {}) };const fingerprint=JSON.stringify(body);
    if(pending.current?.fingerprint!==fingerprint)pending.current={ fingerprint,requestId:crypto.randomUUID() };
    await api(root+'/payment-link-requests',{ method:'POST',body:JSON.stringify({ ...body,requestId:pending.current!.requestId }) });
    pending.current=null;setAmount('');setNotice(true);await loadRequests();await loadMethods();
  }
  return <section className="lead-payment-requests"><h3>{t.title}</h3><p>{t.note}</p>{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{t.saved}</p>}
    <button className="secondary" disabled={busy} onClick={()=>void action(async()=>{ await loadMethods();await loadRequests(); })}>{t.refresh}</button>
    <form onSubmit={(e)=>{ e.preventDefault();void action(save); }}><label>{t.method}<select aria-label={t.method} required disabled={busy} value={methodId}
      onChange={(e)=>{ const id=e.target.value;setMethodId(id);setPlan('');setCurrency(methods.find((m)=>m.id===id)?.currencies[0] ?? '');setNotice(false); }}>
      <option value="">{t.choose}</option>{methods.map((m)=><option key={m.id} value={m.id} disabled={!m.preparationAvailable}>{m.name}{m.preparationAvailable ? '' : ' · '+t.unavailable}</option>)}</select></label>
      <label>{t.amount}<input aria-label={t.amount} inputMode="decimal" required maxLength={32} value={amount} disabled={busy} onChange={(e)=>{ setAmount(e.target.value);setNotice(false); }} /></label><p>{t.hint}</p>
      <label>{t.currency}<select aria-label={t.currency} required disabled={busy || !selected} value={currency} onChange={(e)=>{ setCurrency(e.target.value);setNotice(false); }}>
        <option value="">—</option>{selected?.currencies.map((code)=><option key={code}>{code}</option>)}</select></label>
      {selected?.provider==='ALMA' && <><p>{a.note}</p><label>{a.plan}<select aria-label={a.plan} required disabled={busy} value={plan} onChange={(e)=>setPlan(e.target.value)}><option value="">{t.choose}</option>
        {selected.plans.map((p)=><option key={planKey(p)} value={planKey(p)}>{p.installments} {a.count} · {p.deferredMonths} {a.months} · {p.deferredDays} {a.days}</option>)}</select></label></>}
      <button disabled={busy || !selected?.preparationAvailable || selected.provider==='ALMA' && !plan}>{t.prepare}</button></form>
    <ul>{methods.filter((m)=>!m.preparationAvailable).map((m)=><li key={m.id}>{m.name}: {m.issues.map((issue)=><bdi key={issue}>{issue} </bdi>)}</li>)}</ul>
    {methodCursor && <button className="secondary" disabled={busy} onClick={()=>void action(()=>loadMethods(methodCursor))}>{t.moreMethods}</button>}
    {!items.length && !busy && !error && <p>{t.empty}</p>}<ul className="payment-request-history">{items.map((item)=><li key={item.id} data-payment-request={item.id}>
      {item.methodName} · <bdi>{item.amount} {item.currency}</bdi> · {states[locale][item.state as keyof typeof states.en] ?? item.state} · <span>{t.date}: {new Date(item.createdAt).toLocaleString(locale)}</span>
      {item.errorCode && <p><bdi>{item.errorCode}</bdi></p>}
      {item.expiresAt && <p>{financeLabels[locale].expires}: {new Date(item.expiresAt).toLocaleString(locale)}</p>}
      {['PAYPAL','ALMA'].includes(item.provider) && item.customerUrl && !item.expiresAt && <p>{captureLabels[locale].expiry}</p>}
      {item.provider==='ALMA' && <><p>{a.note}</p>{item.plan && <p>{item.plan.installments} {a.count} · {item.plan.deferredMonths} {a.months} · {item.plan.deferredDays} {a.days}</p>}
        {item.linkSource==='INDEPENDENT_READ' && <p>{a.recovered}</p>}{item.verificationState && <p>{a.read}: <bdi>{item.verificationState} {item.verificationError}</bdi></p>}
        {(item.state==='NEEDS_ATTENTION' && item.paymentState!=='CONFIRMED' || item.verificationState==='NEEDS_ATTENTION') && <p>{a.review}</p>}
        <button className="secondary" disabled={busy} onClick={()=>void action(()=>readFinancial(item.id))}>{a.history}</button></>}
      {item.customerUrl && <p><a href={item.customerUrl} target="_blank" rel="noopener noreferrer">{financeLabels[locale].open}</a>{' '}
        <button className="secondary" disabled={busy} onClick={()=>void action(async()=>{ await navigator.clipboard.writeText(item.customerUrl!);setCopied(true); })}>{financeLabels[locale].copy}</button>{' '}
        <button className="secondary" disabled={busy} onClick={()=>onPrepareMessage(item.id)}>{locale==='ar' ? 'تجهيز رسالة برابط الدفع' : locale==='fr' ? 'Préparer un message de paiement' : 'Prepare payment message'}</button></p>}
      {item.paymentState && <p>{financeLabels[locale].payment}: {states[locale][item.paymentState as keyof typeof states.en] ?? item.paymentState}</p>}
      {item.provider==='PAYPAL' && <p>{captureLabels[locale].note}</p>}
      {item.captureState && <p>{captureLabels[locale].state}: {item.captureState==='ACCEPTED' && item.paymentState!=='CONFIRMED' ? captureLabels[locale].accepted : item.captureState} <bdi>{item.captureError}</bdi></p>}
      {item.captureAvailable && <button disabled={busy} onClick={()=>void action(async()=>{
        await api(root+'/payment-link-requests/'+item.id+'/capture',{ method:'POST',body:'{}' });await loadRequests();
      })}>{captureLabels[locale].action}</button>}
      {item.captureState && <button className="secondary" disabled={busy} onClick={()=>void action(async()=>{
        setAttempts((await api<{ items:typeof attempts }>(root+'/payment-link-requests/'+item.id+'/capture-attempts')).items);
      })}>{captureLabels[locale].history}</button>}
      {item.paymentReference && <p>{financeLabels[locale].reference}: <bdi>{item.paymentReference}</bdi></p>}
      {item.enrollmentId && item.enrolledAt && <p>{financeLabels[locale].enrolled}: {new Date(item.enrolledAt).toLocaleString(locale)}</p>}
      <button className="secondary" disabled={busy} onClick={()=>void action(async()=>{ setAttempts((await api<{ items:typeof attempts }>(root+'/payment-link-requests/'+item.id+'/attempts')).items); })}>{financeLabels[locale].history}</button>
    </li>)}</ul>{copied && <p role="status">{financeLabels[locale].copied}</p>}
    {!!attempts.length && <ol>{attempts.map((attempt)=><li key={attempt.number}><bdi>{attempt.number}: {attempt.state} {attempt.error_code}</bdi></li>)}</ol>}
    {financialIntent && <section className="lead-financial-history"><h4>{a.history}</h4><ol>{financialHistory.map((h)=><li key={h.id}><bdi>{h.session_id} · {h.session_status} · {h.payment_status}</bdi> · <time>{new Date(h.verified_at).toLocaleString(locale)}</time></li>)}</ol>
      {financialCursor && <button className="secondary" disabled={busy} onClick={()=>void action(()=>readFinancial(financialIntent,financialCursor))}>{a.more}</button>}</section>}
    {cursor && <button className="secondary" disabled={busy} onClick={()=>void action(()=>loadRequests(cursor))}>{t.more}</button>}
  </section>;
}
