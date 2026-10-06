import { useEffect, useRef, useState } from 'react';
type Locale='ar'|'en'|'fr';type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Method={ id:string;name:string;version:number;currencies:string[];preparationAvailable:boolean;issues:string[] };
type Intent={ id:string;methodName:string;methodVersion:number;amount:string;currency:string;createdAt:string;state:string;customerUrl:string|null;
  errorCode:string|null;expiresAt:string|null;paymentState:string|null;paymentReference:string|null;confirmedAt:string|null;enrollmentId:string|null;enrolledAt:string|null };
const states={ ar:{ QUEUED:'بانتظار الإصدار',RUNNING:'جارٍ إصدار الرابط',RETRY:'إعادة محاولة مجدولة',ACCEPTED:'صدر الرابط',FAILED:'فشل الإصدار',BLOCKED:'الإصدار محجوب',NEEDS_ATTENTION:'يحتاج مراجعة — لا تفترض فشل الدفع',PENDING:'بانتظار الدفع',EXPIRED:'منتهي',CONFIRMED:'دفع مؤكد' },
  en:{ QUEUED:'Waiting for issuance',RUNNING:'Issuing link',RETRY:'Scheduled retry',ACCEPTED:'Link issued',FAILED:'Failed',BLOCKED:'Issuance blocked',NEEDS_ATTENTION:'Needs attention — do not assume payment failed',PENDING:'Payment pending',EXPIRED:'Expired',CONFIRMED:'Payment confirmed' },
  fr:{ QUEUED:'Émission en attente',RUNNING:'Émission en cours',RETRY:'Nouvelle tentative prévue',ACCEPTED:'Lien émis',FAILED:'Échec',BLOCKED:'Émission bloquée',NEEDS_ATTENTION:'À examiner — paiement non déterminé',PENDING:'Paiement en attente',EXPIRED:'Expiré',CONFIRMED:'Paiement confirmé' } };
const financeLabels={ ar:{ open:'فتح رابط الدفع',copy:'نسخ رابط الدفع',copied:'نُسخ الرابط.',expires:'انتهاء الرابط',payment:'حالة الدفع',enrolled:'اشتراك مؤكد',reference:'مرجع الدفع',history:'محاولات الإصدار' },
  en:{ open:'Open payment link',copy:'Copy payment link',copied:'Link copied.',expires:'Link expiry',payment:'Payment status',enrolled:'Enrollment confirmed',reference:'Payment reference',history:'Issuance attempts' },
  fr:{ open:'Ouvrir le lien de paiement',copy:'Copier le lien de paiement',copied:'Lien copié.',expires:'Expiration du lien',payment:'État du paiement',enrolled:'Inscription confirmée',reference:'Référence du paiement',history:'Tentatives d’émission' } };
const labels={
  ar:{ title:'طلبات روابط الدفع',note:'يصدر Worker الرابط بعد إعادة التحقق من الصلاحيات والطريقة والحساب وWebhook. فتح الرابط أو صفحة النجاح لا يؤكد الدفع. يؤكد الاشتراك فقط بعد إيصال موثوق والتحقق من الدفع لدى المزود.',
    method:'طريقة طلب الدفع',amount:'مبلغ طلب الدفع',currency:'عملة طلب الدفع',prepare:'حفظ طلب رابط الدفع',refresh:'تحديث طلبات الدفع',more:'طلبات دفع إضافية',moreMethods:'طرق طلب إضافية',choose:'اختر طريقة',
    empty:'لا توجد طلبات محفوظة.',saved:'حُفظ الطلب مرة واحدة. تابع حالة الإصدار أدناه.',unavailable:'طريقة غير جاهزة',hint:'أدخل المبلغ بأرقام إنجليزية ونقطة عشرية، دون تقريب أو فواصل الآلاف.',date:'تاريخ الطلب' },
  en:{ title:'Payment link requests',note:'The worker issues a link after rechecking access, method, account and webhook. Opening a link or success page does not confirm payment. Enrollment requires a trusted receipt and payment verification with the provider.',
    method:'Payment request method',amount:'Payment request amount',currency:'Payment request currency',prepare:'Save payment link request',refresh:'Refresh payment requests',more:'More payment requests',moreMethods:'More request methods',choose:'Choose a method',
    empty:'No saved requests.',saved:'Request saved once. Track issuance below.',unavailable:'Method not ready',hint:'Use English digits and a decimal point, without rounding or thousands separators.',date:'Request date' },
  fr:{ title:'Demandes de liens de paiement',note:'Le worker émet le lien après vérification des droits, du moyen, du compte et du webhook. Ouvrir le lien ou la page de succès ne confirme pas le paiement. L’inscription exige un événement fiable et la vérification auprès du fournisseur.',
    method:'Moyen de la demande',amount:'Montant de la demande',currency:'Devise de la demande',prepare:'Enregistrer la demande de lien',refresh:'Actualiser les demandes',more:'Autres demandes',moreMethods:'Autres moyens',choose:'Choisir un moyen',
    empty:'Aucune demande enregistrée.',saved:'Demande enregistrée une fois. Consultez son état ci-dessous.',unavailable:'Moyen indisponible',hint:'Utilisez des chiffres anglais et un point décimal, sans arrondi ni séparateur de milliers.',date:'Date de demande' },
} as const;
export function LeadPaymentRequests({ locale,leadId,api }: { locale:Locale;leadId:string;api:Api }) {
  const t=labels[locale];const [methods,setMethods]=useState<Method[]>([]);const [items,setItems]=useState<Intent[]>([]);
  const [methodCursor,setMethodCursor]=useState<string|null>(null);const [cursor,setCursor]=useState<string|null>(null);
  const [methodId,setMethodId]=useState('');const [amount,setAmount]=useState('');const [currency,setCurrency]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState(false);
  const [copied,setCopied]=useState(false);const [attempts,setAttempts]=useState<{ number:number;state:string;error_code:string|null }[]>([]);
  const pending=useRef<{ fingerprint:string;requestId:string }|null>(null);const generation=useRef(0);
  const selected=methods.find((m)=>m.id===methodId);const root=`/api/leads/${leadId}`;
  async function loadMethods(next?:string) { const page=await api<{ items:Method[];nextCursor:string|null }>(root+'/payment-link-options'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setMethods((old)=>next ? [...old,...page.items] : page.items);setMethodCursor(page.nextCursor); }
  async function loadRequests(next?:string) { const page=await api<{ items:Intent[];nextCursor:string|null }>(root+'/payment-link-requests'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setItems((old)=>next ? [...old,...page.items] : page.items);setCursor(page.nextCursor); }
  useEffect(()=> { const version=++generation.current;setBusy(true);setError('');
    void Promise.all([api<{ items:Method[];nextCursor:string|null }>(root+'/payment-link-options'),api<{ items:Intent[];nextCursor:string|null }>(root+'/payment-link-requests')])
      .then(([options,requests])=>{ if(version!==generation.current)return;setMethods(options.items);setMethodCursor(options.nextCursor);setItems(requests.items);setCursor(requests.nextCursor); })
      .catch((e)=>{ if(version===generation.current)setError(String(e)); }).finally(()=>{ if(version===generation.current)setBusy(false); });
    return ()=>{ generation.current++; };
  },[leadId]);
  async function action(run:()=>Promise<void>) { setBusy(true);setError('');try { await run(); }catch(e){ setError(String(e)); }finally{ setBusy(false); } }
  async function save() {
    if(!selected || !selected.preparationAvailable)return;
    const body={ methodId:selected.id,methodVersion:selected.version,amount,currency };const fingerprint=JSON.stringify(body);
    if(pending.current?.fingerprint!==fingerprint)pending.current={ fingerprint,requestId:crypto.randomUUID() };
    await api(root+'/payment-link-requests',{ method:'POST',body:JSON.stringify({ ...body,requestId:pending.current!.requestId }) });
    pending.current=null;setAmount('');setNotice(true);await loadRequests();await loadMethods();
  }
  return <section className="lead-payment-requests"><h3>{t.title}</h3><p>{t.note}</p>{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{t.saved}</p>}
    <button className="secondary" disabled={busy} onClick={()=>void action(async()=>{ await loadMethods();await loadRequests(); })}>{t.refresh}</button>
    <form onSubmit={(e)=>{ e.preventDefault();void action(save); }}><label>{t.method}<select aria-label={t.method} required disabled={busy} value={methodId}
      onChange={(e)=>{ const id=e.target.value;setMethodId(id);setCurrency(methods.find((m)=>m.id===id)?.currencies[0] ?? '');setNotice(false); }}>
      <option value="">{t.choose}</option>{methods.map((m)=><option key={m.id} value={m.id} disabled={!m.preparationAvailable}>{m.name}{m.preparationAvailable ? '' : ' · '+t.unavailable}</option>)}</select></label>
      <label>{t.amount}<input aria-label={t.amount} inputMode="decimal" required maxLength={32} value={amount} disabled={busy} onChange={(e)=>{ setAmount(e.target.value);setNotice(false); }} /></label><p>{t.hint}</p>
      <label>{t.currency}<select aria-label={t.currency} required disabled={busy || !selected} value={currency} onChange={(e)=>{ setCurrency(e.target.value);setNotice(false); }}>
        <option value="">—</option>{selected?.currencies.map((code)=><option key={code}>{code}</option>)}</select></label>
      <button disabled={busy || !selected?.preparationAvailable}>{t.prepare}</button></form>
    <ul>{methods.filter((m)=>!m.preparationAvailable).map((m)=><li key={m.id}>{m.name}: {m.issues.map((issue)=><bdi key={issue}>{issue} </bdi>)}</li>)}</ul>
    {methodCursor && <button className="secondary" disabled={busy} onClick={()=>void action(()=>loadMethods(methodCursor))}>{t.moreMethods}</button>}
    {!items.length && !busy && !error && <p>{t.empty}</p>}<ul className="payment-request-history">{items.map((item)=><li key={item.id}>
      {item.methodName} · <bdi>{item.amount} {item.currency}</bdi> · {states[locale][item.state as keyof typeof states.en] ?? item.state} · <span>{t.date}: {new Date(item.createdAt).toLocaleString(locale)}</span>
      {item.errorCode && <p><bdi>{item.errorCode}</bdi></p>}
      {item.expiresAt && <p>{financeLabels[locale].expires}: {new Date(item.expiresAt).toLocaleString(locale)}</p>}
      {item.customerUrl && <p><a href={item.customerUrl} target="_blank" rel="noopener noreferrer">{financeLabels[locale].open}</a>{' '}
        <button className="secondary" disabled={busy} onClick={()=>void action(async()=>{ await navigator.clipboard.writeText(item.customerUrl!);setCopied(true); })}>{financeLabels[locale].copy}</button></p>}
      {item.paymentState && <p>{financeLabels[locale].payment}: {states[locale][item.paymentState as keyof typeof states.en] ?? item.paymentState}</p>}
      {item.paymentReference && <p>{financeLabels[locale].reference}: <bdi>{item.paymentReference}</bdi></p>}
      {item.enrollmentId && item.enrolledAt && <p>{financeLabels[locale].enrolled}: {new Date(item.enrolledAt).toLocaleString(locale)}</p>}
      <button className="secondary" disabled={busy} onClick={()=>void action(async()=>{ setAttempts((await api<{ items:typeof attempts }>(root+'/payment-link-requests/'+item.id+'/attempts')).items); })}>{financeLabels[locale].history}</button>
    </li>)}</ul>{copied && <p role="status">{financeLabels[locale].copied}</p>}
    {!!attempts.length && <ol>{attempts.map((attempt)=><li key={attempt.number}><bdi>{attempt.number}: {attempt.state} {attempt.error_code}</bdi></li>)}</ol>}
    {cursor && <button className="secondary" disabled={busy} onClick={()=>void action(()=>loadRequests(cursor))}>{t.more}</button>}
  </section>;
}
