import { useEffect, useRef, useState } from 'react';
type Locale='ar'|'en'|'fr';type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Method={ id:string;name:string;version:number;currencies:string[];preparationAvailable:boolean;issues:string[] };
type Intent={ id:string;methodName:string;methodVersion:number;amount:string;currency:string;createdAt:string;state:'PREPARED';customerUrl:null };
const labels={
  ar:{ title:'طلبات روابط الدفع',note:'يمكن حفظ طلب بعد فحص الطريقة والحساب وWebhook. الطلب المحفوظ ليس رابط دفع: لم يُرسل إلى المزود، ولا يؤكد الدفع أو الاشتراك. إصدار الرابط والتأكيد المالي قيد التنفيذ.',
    method:'طريقة طلب الدفع',amount:'مبلغ طلب الدفع',currency:'عملة طلب الدفع',prepare:'حفظ طلب رابط الدفع',refresh:'تحديث طلبات الدفع',more:'طلبات دفع إضافية',moreMethods:'طرق طلب إضافية',choose:'اختر طريقة',
    empty:'لا توجد طلبات محفوظة.',saved:'حُفظ الطلب مرة واحدة. لم يصدر رابط دفع بعد.',pending:'محفوظ — لم يصدر رابط بعد',unavailable:'طريقة غير جاهزة',hint:'أدخل المبلغ بأرقام إنجليزية ونقطة عشرية، دون تقريب أو فواصل الآلاف.',date:'تاريخ الطلب' },
  en:{ title:'Payment link requests',note:'A request can be saved after checking the method, account and webhook. A saved request is not a payment link: it has not been sent to the provider and confirms neither payment nor enrollment. Link issuance and financial processing are in progress.',
    method:'Payment request method',amount:'Payment request amount',currency:'Payment request currency',prepare:'Save payment link request',refresh:'Refresh payment requests',more:'More payment requests',moreMethods:'More request methods',choose:'Choose a method',
    empty:'No saved requests.',saved:'Request saved once. No payment link has been issued yet.',pending:'Saved — no link issued yet',unavailable:'Method not ready',hint:'Use English digits and a decimal point, without rounding or thousands separators.',date:'Request date' },
  fr:{ title:'Demandes de liens de paiement',note:'Une demande peut être enregistrée après vérification du moyen, du compte et du webhook. Elle ne constitue pas un lien de paiement : aucun envoi au fournisseur, paiement ou inscription n’est confirmé. Émission et traitement financier en cours.',
    method:'Moyen de la demande',amount:'Montant de la demande',currency:'Devise de la demande',prepare:'Enregistrer la demande de lien',refresh:'Actualiser les demandes',more:'Autres demandes',moreMethods:'Autres moyens',choose:'Choisir un moyen',
    empty:'Aucune demande enregistrée.',saved:'Demande enregistrée une fois. Aucun lien émis.',pending:'Enregistrée — aucun lien émis',unavailable:'Moyen indisponible',hint:'Utilisez des chiffres anglais et un point décimal, sans arrondi ni séparateur de milliers.',date:'Date de demande' },
} as const;
export function LeadPaymentRequests({ locale,leadId,api }: { locale:Locale;leadId:string;api:Api }) {
  const t=labels[locale];const [methods,setMethods]=useState<Method[]>([]);const [items,setItems]=useState<Intent[]>([]);
  const [methodCursor,setMethodCursor]=useState<string|null>(null);const [cursor,setCursor]=useState<string|null>(null);
  const [methodId,setMethodId]=useState('');const [amount,setAmount]=useState('');const [currency,setCurrency]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState(false);
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
      {item.methodName} · <bdi>{item.amount} {item.currency}</bdi> · {t.pending} · <span>{t.date}: {new Date(item.createdAt).toLocaleString(locale)}</span>
    </li>)}</ul>{cursor && <button className="secondary" disabled={busy} onClick={()=>void action(()=>loadRequests(cursor))}>{t.more}</button>}
  </section>;
}
