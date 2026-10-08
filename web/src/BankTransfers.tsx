import { useEffect,useRef,useState } from 'react';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'en'|'fr';
type Props={ locale:Locale;api:Api };
const copy={
  title:['التحويل البنكي','Bank Transfer','Virement bancaire'],setup:['إعداد التحويل البنكي','Bank Transfer setup','Configuration du virement'],
  note:['لا تصريح العميل أو إيصال مرفوع يثبت الدفع. اعتماد يدوي بعد مراجعة حركة مسوّاة في البنك، أو feed موقّعة من مصدر مصرفي معتمد فقط.',
    'Customer claims and uploaded receipts do not prove payment. Only authorized review of a settled bank transaction or a signed feed from an approved bank source confirms payment.',
    'Déclarations client et reçus téléversés ne prouvent pas le paiement. Seuls le rapprochement autorisé d’une opération bancaire réglée ou un flux signé approuvé confirment le paiement.'],
  name:['الاسم','Name','Nom'],branch:['الفرع','Branch','Agence'],beneficiary:['المستفيد','Beneficiary','Bénéficiaire'],account:['معرّف الحساب البنكي الكامل','Bank account identifier','Identifiant du compte bancaire'],
  bank:['اسم البنك','Bank name','Nom de la banque'],instructions:['تعليمات التحويل','Transfer instructions','Instructions de virement'],currencies:['العملات، مفصولة بفاصلة','Currencies, comma separated','Devises, séparées par virgule'],
  reason:['سبب الإجراء','Action reason','Motif'],save:['حفظ حساب التحويل','Save transfer account','Enregistrer le compte'],refresh:['تحديث التحويلات','Refresh transfers','Actualiser les virements'],
  accountRefresh:['تحديث الحسابات','Refresh bank accounts','Actualiser les comptes'],method:['طريقة التحويل','Transfer method','Méthode de virement'],amount:['مبلغ التحويل','Transfer amount','Montant du virement'],currency:['عملة التحويل','Transfer currency','Devise du virement'],
  request:['إنشاء طلب تحويل','Create transfer request','Créer une demande de virement'],choose:['اختر','Choose','Choisir'],reference:['مرجع التحويل','Transfer reference','Référence du virement'],
  pending:['بانتظار مطابقة موثوقة — لا Payment أو Enrollment مؤكدة','Awaiting trusted reconciliation — no confirmed Payment or Enrollment','Rapprochement fiable attendu — aucun Payment ou Enrollment confirmé'],
  manual:['اعتماد يدوي من مستخدم مخوّل','Authorized manual reconciliation','Rapprochement manuel autorisé'],feed:['تأكيد من feed مصرفية موثوقة','Trusted bank feed confirmation','Confirmation par flux bancaire fiable'],
  transaction:['مرجع الحركة البنكية المسوّاة','Settled bank transaction ID','Identifiant de l’opération bancaire réglée'],settled:['وقت التسوية في البنك','Bank settlement time','Date du règlement bancaire'],
  attest:['راجعت سجل البنك المستقل وطابقت المستفيد والمرجع والمال؛ لم أعتمد تصريح العميل أو صورة إيصال','I reviewed the independent bank record and matched beneficiary, reference and money; I did not rely on a customer claim or receipt image',
    'J’ai vérifié le relevé bancaire indépendant et rapproché bénéficiaire, référence et montant ; aucune déclaration client ou image de reçu ne suffit'],
  approve:['اعتماد التحويل بعد التحقق البنكي','Approve after bank verification','Approuver après vérification bancaire'],
  source:['مصدر مصرفي آلي معتمد، اختياري','Approved automatic bank source, optional','Source bancaire automatique approuvée, facultative'],
  sourceNote:['لا Bank API مفترضة. يتطلب connector مستقلًا موثوقًا، ومفتاح HMAC مخصصًا. الإعداد ليس Live Verification.',
    'No Bank API is assumed. Requires an independent trusted connector and a dedicated HMAC key. Configuration is not Live Verification.',
    'Aucune Bank API supposée. Un connecteur indépendant fiable et une clé HMAC dédiée sont requis. La configuration ne prouve pas une vérification Live.'],
  description:['وصف المصدر ومراجعته','Source description and review','Description et revue de la source'],secret:['مفتاح HMAC المخصص','Dedicated HMAC secret','Secret HMAC dédié'],
  trust:['راجعت أن المصدر يتحقق من البنك مستقلًا عن العميل','I reviewed that the source verifies bank records independently of the customer','J’ai vérifié que la source contrôle les relevés bancaires indépendamment du client'],
  connect:['اعتماد مصدر جديد وتدوير المفتاح','Approve source and rotate key','Approuver la source et renouveler la clé'],disable:['تعطيل الحساب','Disable account','Désactiver le compte'],enable:['تفعيل الحساب','Enable account','Activer le compte'],
  disableSource:['تعطيل المصدر الآلي','Disable automatic source','Désactiver la source automatique'],details:['التاريخ والمصدر والأحداث','History, source and events','Historique, source et événements'],retry:['إعادة المطابقة بعد معالجة السبب','Retry reconciliation after fixing the cause','Relancer le rapprochement après correction'],attempts:['سجل المحاولات','Attempt history','Historique des tentatives'],
  more:['المزيد','More','Suite'],copy:['نسخ تعليمات التحويل','Copy transfer instructions','Copier les instructions de virement'],copied:['تم النسخ','Copied','Copié'],
  edit:['تعديل الاسم والتعليمات','Edit name and instructions','Modifier le nom et les instructions'],cancel:['إلغاء التعديل','Cancel edit','Annuler la modification'],
} as const;
function labels(locale:Locale) { const index=locale==='ar' ? 0 : locale==='en' ? 1 : 2;return (key:keyof typeof copy)=>copy[key][index]; }
const post=(body:unknown)=>({ method:'POST',body:JSON.stringify(body) });
type Account={ id:string;name:string;branch_id:string;mode:string;beneficiary:string;account_identifier:string;bank_name:string;instructions:string;active:boolean;version:number;currencies:string[] };
type Source={ id:string;description:string;active:boolean;callbackUrl:string;verification:string };
type Event={ id:string;reference:string;transaction_id:string;amount:string;currency:string;state:string;error_code:string|null;attempts:number;version:number };
type AccountHistory={ version:number;created_at:string;snapshot:{ mode:string;beneficiary:string;account_identifier:string;instructions:string;active:boolean;reason:string } };
type Attempt={ number:number;outcome:string;error_code:string|null;finished_at:string };
type Method={ id:string;name:string;version:number;currencies:string[];provider:string;preparationAvailable:boolean };
type Transfer={ id:string;reference:string;method_name:string;amount:string;currency:string;mode:string;beneficiary:string;account_identifier:string;bank_name:string;instructions:string;
  payment_id:string|null;payment_state:string|null;enrollment_id:string|null;confirmation_source:string|null;transaction_id:string|null;reason:string|null;settled_at:string|null;confirmed_at:string|null };

export function BankTransferSetup({ locale,api,branches }:Props&{ branches:{ id:string;name:string }[] }) {
  const t=labels(locale);const [items,setItems]=useState<Account[]>([]),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [name,setName]=useState(''),[branch,setBranch]=useState(''),[mode,setMode]=useState('TEST'),[beneficiary,setBeneficiary]=useState(''),[account,setAccount]=useState(''),[bank,setBank]=useState(''),[instructions,setInstructions]=useState(''),[currencies,setCurrencies]=useState(''),[reason,setReason]=useState('');
  const [selected,setSelected]=useState<Account|null>(null),[editing,setEditing]=useState<Account|null>(null),[history,setHistory]=useState<AccountHistory[]>([]),[sources,setSources]=useState<Source[]>([]),[events,setEvents]=useState<Event[]>([]),[eventCursor,setEventCursor]=useState<string|null>(null),[sourceCursor,setSourceCursor]=useState<string|null>(null),[historyVersion,setHistoryVersion]=useState<number|null>(null);
  const [description,setDescription]=useState(''),[secret,setSecret]=useState(''),[approved,setApproved]=useState(false),[attempts,setAttempts]=useState<Attempt[]>([]);
  async function load(next:string|null=null) { const p=await api<{ items:Account[];nextCursor:string|null }>('/api/payments/bank-accounts?limit=20'+(next ? '&cursor='+encodeURIComponent(next) : ''));setItems((old)=>next ? [...old,...p.items] : p.items);setCursor(p.nextCursor); }
  async function detail(a:Account) { setSelected(a);setAttempts([]);const [h,s,e]=await Promise.all([
    api<{ items:AccountHistory[];nextVersion:number|null }>(`/api/payments/bank-accounts/${a.id}/history`),api<{ items:Source[];nextCursor:string|null }>(`/api/payments/bank-accounts/${a.id}/sources`),api<{ items:Event[];nextCursor:string|null }>(`/api/payments/bank-accounts/${a.id}/events`)]);
    setHistory(h.items);setHistoryVersion(h.nextVersion);setSources(s.items);setSourceCursor(s.nextCursor);setEvents(e.items);setEventCursor(e.nextCursor); }
  async function run(fn:()=>Promise<void>) { setBusy(true);setError('');try { await fn(); }catch(e){ setError((e as Error).message); }finally { setBusy(false); } }
  useEffect(()=>{ void run(()=>load()); },[api]);
  return <section data-bank-setup><h3>{t('setup')}</h3><p>{t('note')}</p><p>{t('sourceNote')}</p>{error && <p role="alert">{error}</p>}
    <form onSubmit={(e)=>{ e.preventDefault();void run(async()=>{ if(editing)await api(`/api/payments/bank-accounts/${editing.id}`,{ method:'PUT',body:JSON.stringify({ name,instructions,active:editing.active,version:editing.version,reason }) });else await api('/api/payments/bank-accounts',post({ name,branchId:branch,mode,beneficiary,accountIdentifier:account,bankName:bank,instructions,currencies:currencies.split(',').map((s)=>s.trim().toUpperCase()),active:true,reason }));setEditing(null);setName('');setAccount('');await load();if(selected)setSelected(null); }); }}>
      <label>{t('name')}<input aria-label={t('name')} required maxLength={100} value={name} onChange={(e)=>setName(e.target.value)} /></label>
      <label>{t('branch')}<select disabled={!!editing} aria-label={t('branch')} required value={branch} onChange={(e)=>setBranch(e.target.value)}><option value="">{t('choose')}</option>{branches.map((b)=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <label>TEST / LIVE<select disabled={!!editing} aria-label="Bank environment" value={mode} onChange={(e)=>setMode(e.target.value)}><option>TEST</option><option>LIVE</option></select></label>
      <label>{t('beneficiary')}<input disabled={!!editing} aria-label={t('beneficiary')} required maxLength={160} value={beneficiary} onChange={(e)=>setBeneficiary(e.target.value)} /></label>
      <label>{t('account')}<input disabled={!!editing} aria-label={t('account')} required minLength={3} maxLength={200} value={account} onChange={(e)=>setAccount(e.target.value)} /></label>
      <label>{t('bank')}<input disabled={!!editing} aria-label={t('bank')} required maxLength={160} value={bank} onChange={(e)=>setBank(e.target.value)} /></label>
      <label>{t('instructions')}<input aria-label={t('instructions')} maxLength={1000} value={instructions} onChange={(e)=>setInstructions(e.target.value)} /></label>
      <label>{t('currencies')}<input disabled={!!editing} aria-label={t('currencies')} required value={currencies} onChange={(e)=>setCurrencies(e.target.value)} /></label>
      <label>{t('reason')}<input aria-label={t('reason')} required minLength={3} maxLength={500} value={reason} onChange={(e)=>setReason(e.target.value)} /></label><button disabled={busy}>{t('save')}</button>
    </form>{editing && <button disabled={busy} onClick={()=>{ setEditing(null);setName('');setAccount(''); }}>{t('cancel')}</button>}<button disabled={busy} onClick={()=>void run(()=>load())}>{t('accountRefresh')}</button>
    <ul>{items.map((a)=><li key={a.id} data-bank-account={a.id}><strong>{a.name} · {a.mode} · {a.active ? 'ACTIVE' : 'DISABLED'}</strong><p>{a.beneficiary} · {a.account_identifier} · {a.bank_name}</p>
      <button disabled={busy} onClick={()=>{ setEditing(a);setName(a.name);setBranch(a.branch_id);setMode(a.mode);setBeneficiary(a.beneficiary);setAccount(a.account_identifier);setBank(a.bank_name);setInstructions(a.instructions);setCurrencies(a.currencies.join(','));setReason(''); }}>{t('edit')}</button>
      <button disabled={busy} onClick={()=>void run(()=>detail(a))}>{t('details')}</button><button disabled={busy || reason.trim().length<3} onClick={()=>void run(async()=>{ await api(`/api/payments/bank-accounts/${a.id}`,{ method:'PUT',body:JSON.stringify({ name:a.name,instructions:a.instructions,active:!a.active,version:a.version,reason }) });await load();if(selected?.id===a.id)setSelected(null); })}>{t(a.active ? 'disable' : 'enable')}</button></li>)}</ul>
    {cursor && <button disabled={busy} onClick={()=>void run(()=>load(cursor))}>{t('more')}</button>}
    {selected && <section data-bank-source><h4>{selected.name} — {t('source')}</h4><p>{t('sourceNote')}</p>
      <form onSubmit={(e)=>{ e.preventDefault();void run(async()=>{ await api(`/api/payments/bank-accounts/${selected.id}/sources`,post({ description,secret,trustedSourceApproved:approved }));setSecret('');setApproved(false);await detail(selected); }); }}>
        <label>{t('description')}<input aria-label={t('description')} required minLength={3} maxLength={500} value={description} onChange={(e)=>setDescription(e.target.value)} /></label>
        <label>{t('secret')}<input type="password" autoComplete="new-password" aria-label={t('secret')} required minLength={32} maxLength={256} value={secret} onChange={(e)=>setSecret(e.target.value)} /></label>
        <label><input type="checkbox" checked={approved} onChange={(e)=>setApproved(e.target.checked)} />{t('trust')}</label><button disabled={busy || !approved || !selected.active}>{t('connect')}</button>
      </form><button disabled={busy || reason.trim().length<3} onClick={()=>void run(async()=>{ await api(`/api/payments/bank-accounts/${selected.id}/disable-source`,post({ reason }));await detail(selected); })}>{t('disableSource')}</button>
      {sources.map((s)=><p key={s.id}>{s.description} · {s.active ? 'ACTIVE' : 'DISABLED'} · {s.verification}<br/><code>{s.callbackUrl}</code></p>)}
      {sourceCursor && <button disabled={busy} onClick={()=>void run(async()=>{ const p=await api<{ items:Source[];nextCursor:string|null }>(`/api/payments/bank-accounts/${selected.id}/sources?cursor=${encodeURIComponent(sourceCursor)}`);setSources((old)=>[...old,...p.items]);setSourceCursor(p.nextCursor); })}>{t('more')}</button>}
      <button disabled={busy} onClick={()=>void run(()=>detail(selected))}>{t('refresh')}</button>
      <ul>{events.map((e)=><li key={e.id} data-bank-event={e.id}>{e.reference} · {e.amount} {e.currency} · {e.state} · {e.error_code} · {e.attempts}
        <button disabled={busy} onClick={()=>void run(async()=>setAttempts((await api<{ items:Attempt[] }>(`/api/payments/bank-accounts/${selected.id}/events/${e.id}/attempts`)).items))}>{t('attempts')}</button>
        {e.state==='NEEDS_ATTENTION' && <button disabled={busy || e.attempts>=5 || reason.trim().length<3} onClick={()=>void run(async()=>{ await api(`/api/payments/bank-accounts/${selected.id}/events/${e.id}/retry`,post({ version:e.version,reason }));await detail(selected); })}>{t('retry')}</button>}</li>)}</ul>
      {eventCursor && <button disabled={busy} onClick={()=>void run(async()=>{ const p=await api<{ items:Event[];nextCursor:string|null }>(`/api/payments/bank-accounts/${selected.id}/events?cursor=${encodeURIComponent(eventCursor)}`);setEvents((old)=>[...old,...p.items]);setEventCursor(p.nextCursor); })}>{t('more')}</button>}
      <ul>{attempts.map((a)=><li key={a.number}>{a.number} · {a.outcome} · {a.error_code} · {a.finished_at}</li>)}</ul>
      <ul>{history.map((h)=><li key={h.version}>{h.version} · {h.created_at} · {h.snapshot.active ? 'ACTIVE' : 'DISABLED'}<p>{h.snapshot.beneficiary} · {h.snapshot.account_identifier} · {h.snapshot.mode}</p><p>{h.snapshot.instructions}</p><p>{h.snapshot.reason}</p></li>)}</ul>
      {historyVersion && <button disabled={busy} onClick={()=>void run(async()=>{ const p=await api<{ items:AccountHistory[];nextVersion:number|null }>(`/api/payments/bank-accounts/${selected.id}/history?before=${historyVersion}`);setHistory((old)=>[...old,...p.items]);setHistoryVersion(p.nextVersion); })}>{t('more')}</button>}
    </section>}
  </section>;
}

export function LeadBankTransfers({ leadId,role,locale,api }:Props&{ leadId:string;role:string }) {
  const t=labels(locale);const generation=useRef(0);const [methods,setMethods]=useState<Method[]>([]),[methodCursor,setMethodCursor]=useState<string|null>(null),[items,setItems]=useState<Transfer[]>([]),[cursor,setCursor]=useState<string|null>(null);
  const [methodId,setMethodId]=useState(''),[currency,setCurrency]=useState(''),[amount,setAmount]=useState(''),[requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const [selected,setSelected]=useState<Transfer|null>(null),[transaction,setTransaction]=useState(''),[settled,setSettled]=useState(''),[reason,setReason]=useState(''),[verified,setVerified]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false);
  const selectedMethod=methods.find((m)=>m.id===methodId);
  async function load(next:string|null=null) { const v=generation.current;const p=await api<{ items:Transfer[];nextCursor:string|null }>(`/api/leads/${leadId}/bank-transfers?limit=20`+(next ? '&cursor='+encodeURIComponent(next) : ''));if(v!==generation.current)return;setItems((old)=>next ? [...old,...p.items] : p.items);setCursor(p.nextCursor); }
  async function loadMethods(next:string|null=null) { const v=generation.current;const p=await api<{ items:Method[];nextCursor:string|null }>(`/api/leads/${leadId}/payment-methods?limit=50`+(next ? '&cursor='+encodeURIComponent(next) : ''));if(v!==generation.current)return;setMethods((old)=>next ? [...old,...p.items.filter((m)=>m.provider==='BANK_TRANSFER')] : p.items.filter((m)=>m.provider==='BANK_TRANSFER'));setMethodCursor(p.nextCursor); }
  async function run(fn:()=>Promise<void>) { setBusy(true);setError('');try { await fn(); }catch(e){ setError((e as Error).message); }finally { setBusy(false); } }
  useEffect(()=>{ generation.current++;setItems([]);setMethods([]);setSelected(null);setMethodId('');setAmount('');setCurrency('');setRequestId(crypto.randomUUID());void run(async()=>{ await Promise.all([load(),loadMethods()]); });return ()=>{ generation.current++; }; },[leadId,api]);
  return <section data-bank-transfers><h3>{t('title')}</h3><p>{t('note')}</p>{error && <p role="alert">{error}</p>}
    <form onSubmit={(e)=>{ e.preventDefault();void run(async()=>{ await api(`/api/leads/${leadId}/bank-transfers`,post({ requestId,methodId,methodVersion:selectedMethod?.version,amount,currency }));setRequestId(crypto.randomUUID());await load(); }); }}>
      <label>{t('method')}<select aria-label={t('method')} required disabled={busy} value={methodId} onChange={(e)=>{ setMethodId(e.target.value);setCurrency('');setRequestId(crypto.randomUUID()); }}><option value="">{t('choose')}</option>{methods.map((m)=><option key={m.id} value={m.id} disabled={!m.preparationAvailable}>{m.name}</option>)}</select></label>
      <label>{t('amount')}<input aria-label={t('amount')} required disabled={busy} maxLength={32} inputMode="decimal" value={amount} onChange={(e)=>{ setAmount(e.target.value);setRequestId(crypto.randomUUID()); }} /></label>
      <label>{t('currency')}<select aria-label={t('currency')} required disabled={busy} value={currency} onChange={(e)=>{ setCurrency(e.target.value);setRequestId(crypto.randomUUID()); }}><option value="">{t('choose')}</option>{selectedMethod?.currencies.map((c)=><option key={c}>{c}</option>)}</select></label><button disabled={busy || !selectedMethod?.preparationAvailable}>{t('request')}</button>
    </form>{methodCursor && <button disabled={busy} onClick={()=>void run(()=>loadMethods(methodCursor))}>{t('more')}</button>}
    <button disabled={busy} onClick={()=>void run(()=>load())}>{t('refresh')}</button>{copied && <p role="status">{t('copied')}</p>}
    <ul>{items.map((r)=><li key={r.id} data-bank-transfer={r.id}><strong>{r.method_name} · {r.amount} {r.currency} · {r.mode}</strong>
      <p>{t('reference')}: <code>{r.reference}</code></p><p>{r.beneficiary} · {r.account_identifier} · {r.bank_name}</p><p>{r.instructions}</p>
      {r.payment_id ? <><p>Payment: {r.payment_state} · {r.confirmed_at}</p><p>Enrollment: {r.enrollment_id}</p><p>{t(r.confirmation_source==='AUTHORIZED_MANUAL' ? 'manual' : 'feed')} · {r.transaction_id} · {r.settled_at}</p><p>{r.reason}</p></> : <p>{t('pending')}</p>}
      <button disabled={busy} onClick={()=>void run(async()=>{ await navigator.clipboard.writeText(`${r.beneficiary}\n${r.bank_name}\n${r.account_identifier}\n${r.amount} ${r.currency}\n${r.reference}\n${r.instructions}`);setCopied(true); })}>{t('copy')}</button>
      {role!=='AGENT' && !r.payment_id && <button disabled={busy} onClick={()=>{ setSelected(r);setTransaction('');setSettled('');setReason('');setVerified(false); }}>{t('manual')}</button>}
    </li>)}</ul>{cursor && <button disabled={busy} onClick={()=>void run(()=>load(cursor))}>{t('more')}</button>}
    {selected && <form data-bank-approval onSubmit={(e)=>{ e.preventDefault();void run(async()=>{ await api(`/api/leads/${leadId}/bank-transfers/${selected.id}/confirm`,post({ transactionId:transaction,accountIdentifier:selected.account_identifier,reference:selected.reference,amount:selected.amount,currency:selected.currency,settledAt:new Date(settled).toISOString(),reason,bankVerified:verified }));setSelected(null);await load(); }); }}>
      <h4>{t('manual')}</h4><p>{selected.beneficiary} · {selected.account_identifier} · {selected.amount} {selected.currency} · {selected.reference}</p>
      <label>{t('transaction')}<input aria-label={t('transaction')} required maxLength={200} disabled={busy} value={transaction} onChange={(e)=>setTransaction(e.target.value)} /></label>
      <label>{t('settled')}<input type="datetime-local" aria-label={t('settled')} required disabled={busy} value={settled} onChange={(e)=>setSettled(e.target.value)} /></label>
      <label>{t('reason')}<input aria-label={t('reason')} required minLength={3} maxLength={500} disabled={busy} value={reason} onChange={(e)=>setReason(e.target.value)} /></label>
      <label><input type="checkbox" disabled={busy} checked={verified} onChange={(e)=>setVerified(e.target.checked)} />{t('attest')}</label><button disabled={busy || !verified || !transaction || !settled || reason.trim().length<3}>{t('approve')}</button>
    </form>}
  </section>;
}
