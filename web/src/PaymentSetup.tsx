import { useEffect,useRef,useState } from 'react';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'en'|'fr';
type Connection={ id:string;name:string;provider:string;branch_id:string|null;config:{ mode:'TEST'|'LIVE' };version:number;status:string;
  last_error_code:string|null;last_success_at:string|null;last_failure_at:string|null;secret_configured:boolean;capabilities:{ authenticationVerified?:boolean } };
type Probe={ id:string;connection_version:number;state:string;error_code:string|null;created_at:string;finished_at:string|null };
const labels={
  ar:{ title:'اتصالات الدفع',guide:'أنشئ حسابًا أو Sandbox لدى Stripe. من API keys أنشئ Restricted Key بصلاحية قراءة Balance لاختبار الاتصال، واختر TEST أو LIVE المطابقة. استخدم مفاتيح اختبار مخصصة أثناء التطوير.',
    note:'هذا الفحص يثبتAuthentication فقط. Payment links وwebhook وEnrollment غير جاهزة في هذه المرحلة؛ لا يعتبرCustomer claim أوsuccess page دفعًا مؤكدًا.',
    name:'اسم اتصال الدفع',scope:'فرع اتصال الدفع',org:'المؤسسة',provider:'مزود الدفع',mode:'بيئة الدفع',key:'مفتاح API للدفع',save:'حفظ اتصال الدفع',add:'اتصال دفع جديد',edit:'تعديل اتصال الدفع',
    secret:'السر محفوظ ومشفّر؛ لا يعاد عرضه. اترك حقل المفتاح فارغًا للاحتفاظ به، أو أدخل مفتاحًا بديلًا لتدويره.',
    test:'اختبار Authentication',disable:'تعطيل اتصال الدفع',reconnect:'إعادة ربط اتصال الدفع',reason:'سبب تغيير اتصال الدفع',refresh:'تحديث اتصالات الدفع',more:'المزيد من اتصالات الدفع',history:'تاريخ اختبارات الدفع',moreHistory:'المزيد من تاريخ الدفع',empty:'لا اتصالات دفع.',status:'الحالة',version:'نسخة الإعداد',success:'آخر نجاح',failure:'آخر فشل',pending:'الفحص لم يثبت جاهزية الدفع.',result:'نتيجة اختبار الدفع' },
  en:{ title:'Payment connections',guide:'Create a Stripe account or sandbox. In API keys create a restricted key with Balance read access for this probe, then select the matching TEST or LIVE mode. Use dedicated test keys during development.',
    note:'This probe verifies authentication only. Payment links, webhook and Enrollment are not ready in this stage; customer claims or success pages never confirm payment.',
    name:'Payment connection name',scope:'Payment connection branch',org:'Organization',provider:'Payment provider',mode:'Payment environment',key:'Payment API key',save:'Save payment connection',add:'New payment connection',edit:'Edit payment connection',
    secret:'Credentials are encrypted and never redisplayed. Leave the key empty to retain it or enter a replacement to rotate it.',
    test:'Test authentication',disable:'Disable payment connection',reconnect:'Reconnect payment connection',reason:'Payment connection change reason',refresh:'Refresh payment connections',more:'More payment connections',history:'Payment test history',moreHistory:'More payment history',empty:'No payment connections.',status:'Status',version:'Configuration version',success:'Last success',failure:'Last failure',pending:'Authentication does not establish payment readiness.',result:'Payment test result' },
  fr:{ title:'Connexions de paiement',guide:'Créez un compte Stripe ou un sandbox. Créez une clé restreinte avec lecture du solde pour ce test, puis choisissez TEST ou LIVE correspondant. Utilisez des clés de test dédiées en développement.',
    note:'Ce test vérifie uniquement l’authentification. Liens de paiement, webhook et Enrollment ne sont pas prêts à cette étape ; une déclaration client ou une page de succès ne confirme jamais un paiement.',
    name:'Nom de connexion de paiement',scope:'Agence de paiement',org:'Organisation',provider:'Fournisseur de paiement',mode:'Environnement de paiement',key:'Clé API de paiement',save:'Enregistrer la connexion',add:'Nouvelle connexion de paiement',edit:'Modifier la connexion',
    secret:'Identifiants chiffrés et jamais réaffichés. Laissez la clé vide pour la conserver ou saisissez une nouvelle clé pour la remplacer.',
    test:'Tester l’authentification',disable:'Désactiver la connexion',reconnect:'Reconnecter la connexion',reason:'Motif du changement',refresh:'Actualiser les connexions',more:'Autres connexions',history:'Historique des tests',moreHistory:'Suite de l’historique',empty:'Aucune connexion.',status:'État',version:'Version',success:'Dernier succès',failure:'Dernier échec',pending:'L’authentification ne valide pas le paiement.',result:'Résultat du test' },
};
export function PaymentSetup({ locale,role,branches,api }: { locale:Locale;role:'SUPER_ADMIN'|'MANAGER';branches:{ id:string;name:string }[];api:Api }) {
  const t=labels[locale];const [items,setItems]=useState<Connection[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [selected,setSelected]=useState<Connection|null>(null);const selectedRef=useRef<string|null>(null);
  const [name,setName]=useState('');const [branchId,setBranchId]=useState('');const [mode,setMode]=useState<'TEST'|'LIVE'>('TEST');
  const [key,setKey]=useState('');const [reason,setReason]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const [notice,setNotice]=useState('');const [probes,setProbes]=useState<Probe[]>([]);const [probeCursor,setProbeCursor]=useState<string|null>(null);
  async function load(next?:string) { const page=await api<{ items:Connection[];nextCursor:string|null }>('/api/payments/connections'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setItems((prior)=>next ? [...prior,...page.items] : page.items);setCursor(page.nextCursor);
    const id=selectedRef.current;if(id) { const updated=page.items.find((item)=>item.id===id) ?? await api<Connection>('/api/payments/connections/'+id);
      if(selectedRef.current===id)setSelected(updated); } }
  useEffect(()=>{ void load().catch((e)=>setError(String(e))); },[]);
  async function history(id:string,next?:string) { const page=await api<{ items:Probe[];nextCursor:string|null }>(`/api/payments/connections/${id}/history`+(next ? '?cursor='+encodeURIComponent(next) : ''));
    if(selectedRef.current!==id)return;setProbes((prior)=>next ? [...prior,...page.items] : page.items);setProbeCursor(page.nextCursor); }
  function choose(item:Connection|null) { selectedRef.current=item?.id ?? null;setSelected(item);setName(item?.name ?? '');setBranchId(item?.branch_id ?? '');setMode(item?.config.mode ?? 'TEST');
    setKey('');setReason('');setNotice('');setError('');setProbes([]);setProbeCursor(null);if(item)void history(item.id).catch((e)=>setError(String(e))); }
  async function save() { setBusy(true);setError('');setNotice('');try {
    const input={ name,provider:'STRIPE',config:{ mode },...(role==='SUPER_ADMIN' ? { branchId:branchId || null } : {}),
      ...(key ? { credentials:{ apiKey:key } } : {}),...(selected ? { version:selected.version } : {}) };
    const result=await api<{ id?:string;version:number;status:string }>('/api/payments/connections'+(selected ? '/'+selected.id : ''),{ method:selected ? 'PUT' : 'POST',body:JSON.stringify(input) });
    setKey('');const id=selected?.id ?? result.id!;selectedRef.current=id;await load();await history(id);setNotice(result.status);
  } catch(e) { setError(String(e)); } finally { setBusy(false); } }
  async function action(kind:'test'|'disable'|'reconnect') { if(!selected)return;setBusy(true);setError('');setNotice('');const id=selected.id;
    try { const result=await api<{ state?:string;status?:string;errorCode?:string|null }>(`/api/payments/connections/${id}/${kind}`,{
      method:'POST',body:JSON.stringify({ version:selected.version,...(kind==='test' ? {} : { reason }) }) });setNotice(result.state ?? result.status ?? ''); }
    catch(e) { setError(String(e)); } finally { await load().catch((e)=>setError(String(e)));await history(id).catch((e)=>setError(String(e)));setBusy(false); } }
  return <section className="payment-setup"><h2>{t.title}</h2><p>{t.guide} <a href="https://docs.stripe.com/keys" target="_blank" rel="noopener noreferrer">Stripe API keys</a></p><p role="status">{t.note}</p>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{t.result}: <bdi>{notice}</bdi></p>}
    <div className="actions"><button disabled={busy} className="secondary" onClick={()=>choose(null)}>{t.add}</button>
      <button disabled={busy} className="secondary" onClick={()=>void load().catch((e)=>setError(String(e)))}>{t.refresh}</button></div>
    <section className="panel"><h3>{selected ? t.edit : t.add}</h3><form className="campaign-form" onSubmit={(event)=>{ event.preventDefault();void save(); }}>
      <label>{t.name}<input aria-label={t.name} required maxLength={100} value={name} disabled={busy || selected?.status==='DISABLED'} onChange={(e)=>setName(e.target.value)} /></label>
      <label>{t.provider}<select aria-label={t.provider} disabled><option>Stripe</option></select></label>
      {role==='SUPER_ADMIN' && <label>{t.scope}<select aria-label={t.scope} value={branchId} disabled={busy || Boolean(selected)} onChange={(e)=>setBranchId(e.target.value)}>
        <option value="">{t.org}</option>{branches.map((b)=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
      <label>{t.mode}<select aria-label={t.mode} value={mode} disabled={busy || selected?.status==='DISABLED'} onChange={(e)=>setMode(e.target.value as 'TEST'|'LIVE')}><option>TEST</option><option>LIVE</option></select></label>
      <label>{t.key}<input aria-label={t.key} type="password" autoComplete="off" required={!selected} value={key} maxLength={4096} disabled={busy || selected?.status==='DISABLED'} onChange={(e)=>setKey(e.target.value)} /></label>
      <button disabled={busy || selected?.status==='DISABLED'}>{t.save}</button>
    </form>{selected?.secret_configured && <p>{t.secret}</p>}</section>
    {!items.length && <p>{t.empty}</p>}{items.length>0 && <section className="panel table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.scope}</th><th>{t.mode}</th><th>{t.status}</th><th>{t.edit}</th></tr></thead>
      <tbody>{items.map((item)=><tr key={item.id}><td>{item.name}</td><td>{branches.find((b)=>b.id===item.branch_id)?.name ?? t.org}</td><td><bdi>{item.config.mode}</bdi></td>
        <td><bdi>{item.status}</bdi>{item.last_error_code && <small><bdi>{item.last_error_code}</bdi></small>}</td><td><button disabled={busy} className="link" onClick={()=>choose(item)}>{t.edit}</button></td></tr>)}</tbody></table></section>}
    {cursor && <button disabled={busy} className="secondary" onClick={()=>void load(cursor).catch((e)=>setError(String(e)))}>{t.more}</button>}
    {selected && <section className="panel"><h3>{selected.name}</h3><dl className="inbound-target-summary"><div><dt>{t.version}</dt><dd>{selected.version}</dd></div><div><dt>{t.status}</dt><dd><bdi>{selected.status}</bdi></dd></div>
      <div><dt>{t.success}</dt><dd>{selected.last_success_at ? new Date(selected.last_success_at).toLocaleString(locale) : '—'}</dd></div>
      <div><dt>{t.failure}</dt><dd>{selected.last_failure_at ? new Date(selected.last_failure_at).toLocaleString(locale) : '—'}</dd></div></dl>
      <p>{t.pending} <bdi>{selected.last_error_code}</bdi></p><button disabled={busy || selected.status==='DISABLED'} onClick={()=>void action('test')}>{t.test}</button>
      <label>{t.reason}<input aria-label={t.reason} maxLength={500} value={reason} onChange={(e)=>setReason(e.target.value)} /></label>
      <button disabled={busy || reason.trim().length<3} className="secondary" onClick={()=>void action(selected.status==='DISABLED' ? 'reconnect' : 'disable')}>{selected.status==='DISABLED' ? t.reconnect : t.disable}</button>
      <h4>{t.history}</h4><ul>{probes.map((probe)=><li key={probe.id}><time>{new Date(probe.created_at).toLocaleString(locale)}</time> · <bdi>{probe.state}</bdi> · {t.version} {probe.connection_version}{probe.error_code && <> · <bdi>{probe.error_code}</bdi></>}</li>)}</ul>
      {probeCursor && <button disabled={busy} className="secondary" onClick={()=>void history(selected.id,probeCursor).catch((e)=>setError(String(e)))}>{t.moreHistory}</button>}
    </section>}
  </section>;
}
