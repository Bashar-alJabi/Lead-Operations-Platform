import { useEffect,useRef,useState } from 'react';
import { PaymentMethods } from './PaymentMethods.js';
import { PaymentWebhooks } from './PaymentWebhooks.js';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'en'|'fr';
type Connection={ id:string;name:string;provider:string;branch_id:string|null;config:{ mode:'TEST'|'LIVE';expectedMerchantId?:string };version:number;status:string;
  last_error_code:string|null;last_success_at:string|null;last_failure_at:string|null;secret_configured:boolean;
  capabilities:{ authenticationVerified?:boolean;paymentOptions?:ProviderOptions;paymentOptionsVersion?:number;paymentOptionsAt?:string } };
type ProviderOptions={ accountRef:string;country:string;defaultCurrency:string;currencies:string[];paymentMethods:string[];chargesEnabled:boolean;cardPayments:string };
type Probe={ id:string;connection_version:number;state:string;error_code:string|null;created_at:string;finished_at:string|null;purpose:string;options_snapshot:ProviderOptions|null };
type BeneficiaryConfiguration={ id:string;connection_version:number;mode:string;expected_merchant_id:string|null;actor_role:string;created_at:string };
const beneficiaryLabels={
  ar:{ merchant:'PayPal Merchant ID المتوقع',guide:'انسخ PayPal Merchant ID من Account Settings → Business information للحساب Business المقصود. في TEST استخدم حساب Sandbox Business المرتبط بالتطبيق. يمكن تركه فارغًا لإعداد Authentication فقط.',
    note:'هذا إعداد للمستفيد المتوقع، وليس هوية مفحوصة أو تأكيد دفع. OAuth لا يثبت المستفيد أو صلاحيات capture أو العملات المقبولة. تغيير الإعداد يُلزم إعادة الفحوص؛ طلبات الدفع التاريخية ستحتفظ بالمستفيد الأصلي.',
    history:'تاريخ إعداد مستفيد PayPal',refresh:'تحديث تاريخ المستفيد',more:'المزيد من تاريخ المستفيد',empty:'لا تاريخ إعداد مسجل بعد.',missing:'لم يُحدد مستفيد',configured:'إعداد فقط — لم يُثبت لدى المزود',help:'تعليمات Merchant ID' },
  en:{ merchant:'Expected PayPal Merchant ID',guide:'Copy PayPal Merchant ID from Account Settings → Business information for the intended Business account. In TEST use the Sandbox Business account associated with the app. Leave empty for authentication setup only.',
    note:'This configures the expected beneficiary; it is not verified identity or payment confirmation. OAuth does not prove payee, capture capability or accepted currencies. Changes require new checks; historical payment requests will retain the original payee.',
    history:'PayPal beneficiary configuration history',refresh:'Refresh beneficiary history',more:'More beneficiary history',empty:'No recorded configuration history yet.',missing:'No beneficiary configured',configured:'Configured expectation — not provider verified',help:'Merchant ID instructions' },
  fr:{ merchant:'PayPal Merchant ID attendu',guide:'Copiez PayPal Merchant ID dans Account Settings → Business information du compte Business prévu. En TEST, utilisez le compte Sandbox Business associé à l’application. Laissez vide pour configurer seulement l’authentification.',
    note:'Ce choix configure le bénéficiaire attendu ; il ne vérifie ni identité ni paiement. OAuth ne prouve pas le bénéficiaire, les droits de capture ou les devises acceptées. Toute modification exige de nouveaux contrôles ; les demandes historiques conserveront le bénéficiaire initial.',
    history:'Historique du bénéficiaire PayPal',refresh:'Actualiser l’historique du bénéficiaire',more:'Suite de l’historique du bénéficiaire',empty:'Aucun historique enregistré.',missing:'Aucun bénéficiaire configuré',configured:'Bénéficiaire configuré — non vérifié par le fournisseur',help:'Instructions Merchant ID' },
};
const paypalLabels={
  ar:{ guide:'أنشئ REST App لحساب Business في PayPal Developer Dashboard → Apps & Credentials. اختر Sandbox للتطوير أوLive المقصودة، ثم انسخ Client ID وClient Secret للبيئة نفسها. استخدم حساب Sandbox مخصصًا للاختبارات.',
    clientId:'PayPal Client ID',clientSecret:'PayPal Client Secret',note:'اختبار OAuth يثبت Authentication للتطبيق فقط، ولا يثبت حساب المستفيد أوإتمام capture. يلزم إعداد حساب المستفيد وWebhook والتحقق المالي قبل إصدار الروابط؛ صفحة النجاح أوادعاء العميل لا يؤكدان الدفع.' },
  en:{ guide:'Create a REST App for a PayPal Business account in Developer Dashboard → Apps & Credentials. Select Sandbox for development or the intended Live environment, then copy the matching Client ID and Client Secret. Use a dedicated sandbox account for testing.',
    clientId:'PayPal Client ID',clientSecret:'PayPal Client Secret',note:'The OAuth test verifies app authentication only, not payee identity or completed capture. Payee and webhook verification are required before issuing links; a success page or customer claim never confirms payment.' },
  fr:{ guide:'Créez une REST App pour un compte PayPal Business dans Developer Dashboard → Apps & Credentials. Choisissez Sandbox pour le développement ouLive prévue, puis copiez Client ID et Client Secret correspondants. Utilisez un compte sandbox dédié aux tests.',
    clientId:'PayPal Client ID',clientSecret:'PayPal Client Secret',note:'Le test OAuth vérifie seulement l’authentification de l’application, pas le bénéficiaire ni le capture confirmé. Bénéficiaire et webhook doivent être vérifiés avant émission ; page de succès oudéclaration client ne confirment pas le paiement.' },
};
const labels={
  ar:{ title:'اتصالات الدفع',guide:'أنشئ حسابًا أو Sandbox لدى Stripe. من API keys أنشئ Restricted Key بصلاحية قراءة Balance لاختبار الاتصال، واختر TEST أو LIVE المطابقة. استخدم مفاتيح اختبار مخصصة أثناء التطوير.',
    note:'هذا الفحص يثبت Authentication فقط. يلزم فحص خيارات الحساب وWebhook قبل إصدار الروابط. تحتاج Checkout Sessions لصلاحيات create/read وAccount read. يؤكد Worker الدفع بعد التحقق من إيصال وجلسة المزود؛ Customer claim أوsuccess page لا تؤكد الدفع.',
    name:'اسم اتصال الدفع',scope:'فرع اتصال الدفع',org:'المؤسسة',provider:'مزود الدفع',mode:'بيئة الدفع',key:'مفتاح API للدفع',save:'حفظ اتصال الدفع',add:'اتصال دفع جديد',edit:'تعديل اتصال الدفع',
    secret:'السر محفوظ ومشفّر؛ لا يعاد عرضه. اترك حقل المفتاح فارغًا للاحتفاظ به، أو أدخل مفتاحًا بديلًا لتدويره.',
    test:'اختبار Authentication',disable:'تعطيل اتصال الدفع',reconnect:'إعادة ربط اتصال الدفع',reason:'سبب تغيير اتصال الدفع',refresh:'تحديث اتصالات الدفع',more:'المزيد من اتصالات الدفع',history:'تاريخ اختبارات الدفع',moreHistory:'المزيد من تاريخ الدفع',empty:'لا اتصالات دفع.',status:'الحالة',version:'نسخة الإعداد',success:'آخر نجاح',failure:'آخر فشل',pending:'الفحص لم يثبت جاهزية الدفع.',result:'نتيجة اختبار الدفع' },
  en:{ title:'Payment connections',guide:'Create a Stripe account or sandbox. In API keys create a restricted key with Balance read access for this probe, then select the matching TEST or LIVE mode. Use dedicated test keys during development.',
    note:'This probe verifies authentication only. Account options and webhook verification are required before issuing links. Checkout Sessions need create/read and Account read permissions. The worker confirms payment using a trusted receipt and provider session. Customer claims or success pages never confirm payment.',
    name:'Payment connection name',scope:'Payment connection branch',org:'Organization',provider:'Payment provider',mode:'Payment environment',key:'Payment API key',save:'Save payment connection',add:'New payment connection',edit:'Edit payment connection',
    secret:'Credentials are encrypted and never redisplayed. Leave the key empty to retain it or enter a replacement to rotate it.',
    test:'Test authentication',disable:'Disable payment connection',reconnect:'Reconnect payment connection',reason:'Payment connection change reason',refresh:'Refresh payment connections',more:'More payment connections',history:'Payment test history',moreHistory:'More payment history',empty:'No payment connections.',status:'Status',version:'Configuration version',success:'Last success',failure:'Last failure',pending:'Authentication does not establish payment readiness.',result:'Payment test result' },
  fr:{ title:'Connexions de paiement',guide:'Créez un compte Stripe ou un sandbox. Créez une clé restreinte avec lecture du solde pour ce test, puis choisissez TEST ou LIVE correspondant. Utilisez des clés de test dédiées en développement.',
    note:'Ce test vérifie uniquement l’authentification. Options du compte et webhook doivent être vérifiés avant émission. Checkout Sessions exige create/read et Account read. Le worker confirme avec un événement fiable et la session du fournisseur ; déclaration client ou page de succès ne suffisent pas.',
    name:'Nom de connexion de paiement',scope:'Agence de paiement',org:'Organisation',provider:'Fournisseur de paiement',mode:'Environnement de paiement',key:'Clé API de paiement',save:'Enregistrer la connexion',add:'Nouvelle connexion de paiement',edit:'Modifier la connexion',
    secret:'Identifiants chiffrés et jamais réaffichés. Laissez la clé vide pour la conserver ou saisissez une nouvelle clé pour la remplacer.',
    test:'Tester l’authentification',disable:'Désactiver la connexion',reconnect:'Reconnecter la connexion',reason:'Motif du changement',refresh:'Actualiser les connexions',more:'Autres connexions',history:'Historique des tests',moreHistory:'Suite de l’historique',empty:'Aucune connexion.',status:'État',version:'Version',success:'Dernier succès',failure:'Dernier échec',pending:'L’authentification ne valide pas le paiement.',result:'Résultat du test' },
};
const optionLabels={
  en:{ inspect:'Inspect payment options',title:'Provider payment options',country:'Account country',defaultCurrency:'Default currency',currencies:'Country payment currencies',methods:'Country payment methods',charges:'Charges enabled',card:'Card payments capability',at:'Options inspected at',yes:'Yes',no:'No',
    guide:'For this read-only inspection, the key also needs read access to your Account and Country Specs. Country options do not prove account activation, Checkout write permission, or webhook readiness.' },
  ar:{ inspect:'فحص خيارات الدفع',title:'خيارات الدفع لدى المزود',country:'بلد الحساب',defaultCurrency:'العملة الافتراضية',currencies:'عملات الدفع للبلد',methods:'طرق الدفع للبلد',charges:'قبول المدفوعات مفعّل',card:'صلاحية الدفع بالبطاقة',at:'وقت فحص الخيارات',yes:'نعم',no:'لا',
    guide:'يتطلب هذا الفحص للقراءة فقط صلاحية قراءة Account وCountry Specs للمفتاح أيضًا. خيارات البلد لا تثبت تفعيل الحساب أوصلاحية إنشاء Checkout أوجاهزية Webhook.' },
  fr:{ inspect:'Inspecter les options de paiement',title:'Options de paiement du fournisseur',country:'Pays du compte',defaultCurrency:'Devise par défaut',currencies:'Devises de paiement du pays',methods:'Moyens de paiement du pays',charges:'Paiements activés',card:'Capacité de paiement par carte',at:'Date de vérification des options',yes:'Oui',no:'Non',
    guide:'Ce contrôle en lecture seule nécessite aussi l’accès en lecture au compte et à Country Specs. Les options du pays ne prouvent ni l’activation du compte, ni les droits de création Checkout, ni la disponibilité du webhook.' },
};
export function PaymentSetup({ locale,role,branches,api }: { locale:Locale;role:'SUPER_ADMIN'|'MANAGER';branches:{ id:string;name:string }[];api:Api }) {
  const t=labels[locale];const ot=optionLabels[locale];const [items,setItems]=useState<Connection[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [selected,setSelected]=useState<Connection|null>(null);const selectedRef=useRef<string|null>(null);
  const [name,setName]=useState('');const [branchId,setBranchId]=useState('');const [mode,setMode]=useState<'TEST'|'LIVE'>('TEST');
  const [provider,setProvider]=useState<'STRIPE'|'PAYPAL'>('STRIPE');const [clientId,setClientId]=useState('');const [clientSecret,setClientSecret]=useState('');const pt=paypalLabels[locale];
  const [expectedMerchantId,setExpectedMerchantId]=useState('');const bt=beneficiaryLabels[locale];const [editVersion,setEditVersion]=useState<number|null>(null);
  const [beneficiaries,setBeneficiaries]=useState<BeneficiaryConfiguration[]>([]);const [beneficiaryCursor,setBeneficiaryCursor]=useState<string|null>(null);
  const [key,setKey]=useState('');const [reason,setReason]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const [notice,setNotice]=useState('');const [probes,setProbes]=useState<Probe[]>([]);const [probeCursor,setProbeCursor]=useState<string|null>(null);
  async function load(next?:string) { const page=await api<{ items:Connection[];nextCursor:string|null }>('/api/payments/connections'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setItems((prior)=>next ? [...prior,...page.items] : page.items);setCursor(page.nextCursor);
    const id=selectedRef.current;if(id) { const updated=page.items.find((item)=>item.id===id) ?? await api<Connection>('/api/payments/connections/'+id);
      if(selectedRef.current===id)setSelected(updated); } }
  useEffect(()=>{ void load().catch((e)=>setError(String(e))); },[]);
  async function history(id:string,next?:string) { const page=await api<{ items:Probe[];nextCursor:string|null }>(`/api/payments/connections/${id}/history`+(next ? '?cursor='+encodeURIComponent(next) : ''));
    if(selectedRef.current!==id)return;setProbes((prior)=>next ? [...prior,...page.items] : page.items);setProbeCursor(page.nextCursor); }
  async function beneficiaryHistory(id:string,next?:string) { const page=await api<{ items:BeneficiaryConfiguration[];nextCursor:string|null }>(`/api/payments/connections/${id}/beneficiary-history`+(next ? '?cursor='+encodeURIComponent(next) : ''));
    if(selectedRef.current!==id)return;setBeneficiaries((prior)=>next ? [...prior,...page.items] : page.items);setBeneficiaryCursor(page.nextCursor); }
  function choose(item:Connection|null) { selectedRef.current=item?.id ?? null;setSelected(item);setName(item?.name ?? '');setBranchId(item?.branch_id ?? '');setMode(item?.config.mode ?? 'TEST');
    setProvider(item?.provider==='PAYPAL' ? 'PAYPAL' : 'STRIPE');setClientId('');setClientSecret('');
    setExpectedMerchantId(item?.config.expectedMerchantId ?? '');setEditVersion(item?.version ?? null);setBeneficiaries([]);setBeneficiaryCursor(null);
    if(item?.provider==='PAYPAL')void beneficiaryHistory(item.id).catch((e)=>setError(String(e)));
    setKey('');setReason('');setNotice('');setError('');setProbes([]);setProbeCursor(null);if(item)void history(item.id).catch((e)=>setError(String(e))); }
  async function save() { setBusy(true);setError('');setNotice('');try {
    const input={ name,provider,config:{ mode,...(provider==='PAYPAL' && expectedMerchantId ? { expectedMerchantId } : {}) },...(role==='SUPER_ADMIN' ? { branchId:branchId || null } : {}),
      ...(provider==='STRIPE' ? key ? { credentials:{ apiKey:key } } : {} : clientId || clientSecret ? { credentials:{ clientId,clientSecret } } : {}),...(selected ? { version:editVersion } : {}) };
    const result=await api<{ id?:string;version:number;status:string }>('/api/payments/connections'+(selected ? '/'+selected.id : ''),{ method:selected ? 'PUT' : 'POST',body:JSON.stringify(input) });
    setKey('');setEditVersion(result.version);const id=selected?.id ?? result.id!;selectedRef.current=id;await load();await history(id);
    if(provider==='PAYPAL')await beneficiaryHistory(id);setNotice(result.status);
  } catch(e) { setError(String(e)); } finally { setClientId('');setClientSecret('');setBusy(false); } }
  async function action(kind:'test'|'options'|'disable'|'reconnect') { if(!selected)return;setBusy(true);setError('');setNotice('');const id=selected.id;
    try { const result=await api<{ state?:string;status?:string;errorCode?:string|null;version?:number }>(`/api/payments/connections/${id}/${kind==='options' ? 'test' : kind}`,{
      method:'POST',body:JSON.stringify({ version:selected.version,...(kind==='options' ? { inspectOptions:true } : kind==='test' ? {} : { reason }) }) });
      if(result.version!==undefined && editVersion===selected.version)setEditVersion(result.version);setNotice(result.state ?? result.status ?? ''); }
    catch(e) { setError(String(e)); } finally { await load().catch((e)=>setError(String(e)));await history(id).catch((e)=>setError(String(e)));setBusy(false); } }
  return <section className="payment-setup"><h2>{t.title}</h2><p>{provider==='STRIPE' ? t.guide : pt.guide}{' '}
    <a href={provider==='STRIPE' ? 'https://docs.stripe.com/keys' : 'https://developer.paypal.com/api/rest/authentication/'} target="_blank" rel="noopener noreferrer">{provider==='STRIPE' ? 'Stripe API keys' : 'PayPal REST credentials'}</a></p><p role="status">{provider==='STRIPE' ? t.note : pt.note}</p>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{t.result}: <bdi>{notice}</bdi></p>}
    <div className="actions"><button disabled={busy} className="secondary" onClick={()=>choose(null)}>{t.add}</button>
      <button disabled={busy} className="secondary" onClick={()=>void load().catch((e)=>setError(String(e)))}>{t.refresh}</button></div>
    <section className="panel"><h3>{selected ? t.edit : t.add}</h3><form className="campaign-form" onSubmit={(event)=>{ event.preventDefault();void save(); }}>
      <label>{t.name}<input aria-label={t.name} required maxLength={100} value={name} disabled={busy || selected?.status==='DISABLED'} onChange={(e)=>setName(e.target.value)} /></label>
      <label>{t.provider}<select aria-label={t.provider} value={provider} disabled={busy || Boolean(selected)} onChange={(e)=>{ setProvider(e.target.value as typeof provider);setKey('');setClientId('');setClientSecret('');setExpectedMerchantId(''); }}>
        <option value="STRIPE">Stripe</option><option value="PAYPAL">PayPal</option></select></label>
      {role==='SUPER_ADMIN' && <label>{t.scope}<select aria-label={t.scope} value={branchId} disabled={busy || Boolean(selected)} onChange={(e)=>setBranchId(e.target.value)}>
        <option value="">{t.org}</option>{branches.map((b)=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
      <label>{t.mode}<select aria-label={t.mode} value={mode} disabled={busy || selected?.status==='DISABLED'} onChange={(e)=>setMode(e.target.value as 'TEST'|'LIVE')}><option>TEST</option><option>LIVE</option></select></label>
      {provider==='PAYPAL' && <><label>{bt.merchant}<input aria-label={bt.merchant} autoComplete="off" pattern="[2-9A-HJ-NP-Z]{13}" maxLength={13}
        value={expectedMerchantId} disabled={busy || selected?.status==='DISABLED'} onChange={(e)=>setExpectedMerchantId(e.target.value)} /></label>
        <p>{bt.guide} <a href="https://www.paypal.com/us/cshelp/article/how-do-i-find-my-secure-merchant-id-on-my-paypal-account-help538" target="_blank" rel="noopener noreferrer">{bt.help}</a></p><p>{bt.note}</p></>}
      {provider==='STRIPE' ? <label>{t.key}<input aria-label={t.key} type="password" autoComplete="off" required={!selected} value={key} maxLength={4096} disabled={busy || selected?.status==='DISABLED'} onChange={(e)=>setKey(e.target.value)} /></label>
        : <><label>{pt.clientId}<input aria-label={pt.clientId} autoComplete="off" required={!selected || !!clientSecret} value={clientId} maxLength={1024} disabled={busy || selected?.status==='DISABLED'} onChange={(e)=>setClientId(e.target.value)} /></label>
          <label>{pt.clientSecret}<input aria-label={pt.clientSecret} type="password" autoComplete="new-password" required={!selected || !!clientId} value={clientSecret} maxLength={4096} disabled={busy || selected?.status==='DISABLED'} onChange={(e)=>setClientSecret(e.target.value)} /></label></>}
      <button disabled={busy || selected?.status==='DISABLED'}>{t.save}</button>
    </form>{selected?.secret_configured && <p>{t.secret}</p>}</section>
    {!items.length && <p>{t.empty}</p>}{items.length>0 && <section className="panel table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.provider}</th><th>{t.scope}</th><th>{t.mode}</th><th>{t.status}</th><th>{t.edit}</th></tr></thead>
      <tbody>{items.map((item)=><tr key={item.id}><td>{item.name}</td><td><bdi>{item.provider}</bdi></td><td>{branches.find((b)=>b.id===item.branch_id)?.name ?? t.org}</td><td><bdi>{item.config.mode}</bdi></td>
        <td><bdi>{item.status}</bdi>{item.last_error_code && <small><bdi>{item.last_error_code}</bdi></small>}</td><td><button disabled={busy} className="link" onClick={()=>choose(item)}>{t.edit}</button></td></tr>)}</tbody></table></section>}
    {cursor && <button disabled={busy} className="secondary" onClick={()=>void load(cursor).catch((e)=>setError(String(e)))}>{t.more}</button>}
    {selected && <section className="panel"><h3>{selected.name}</h3><dl className="inbound-target-summary"><div><dt>{t.version}</dt><dd>{selected.version}</dd></div><div><dt>{t.status}</dt><dd><bdi>{selected.status}</bdi></dd></div>
      <div><dt>{t.success}</dt><dd>{selected.last_success_at ? new Date(selected.last_success_at).toLocaleString(locale) : '—'}</dd></div>
      <div><dt>{t.failure}</dt><dd>{selected.last_failure_at ? new Date(selected.last_failure_at).toLocaleString(locale) : '—'}</dd></div></dl>
      <p>{t.pending} <bdi>{selected.last_error_code}</bdi></p><button disabled={busy || selected.status==='DISABLED'} onClick={()=>void action('test')}>{t.test}</button>
      {selected.provider==='STRIPE' && <><p>{ot.guide}</p><button disabled={busy || selected.status==='DISABLED'} onClick={()=>void action('options')}>{ot.inspect}</button></>}
      {selected.capabilities.paymentOptions && selected.capabilities.paymentOptionsVersion===selected.version && <section className="payment-provider-options"><h4>{ot.title}</h4>
        <dl className="inbound-target-summary"><div><dt>{ot.country}</dt><dd><bdi>{selected.capabilities.paymentOptions.country}</bdi></dd></div>
          <div><dt>{ot.defaultCurrency}</dt><dd><bdi>{selected.capabilities.paymentOptions.defaultCurrency}</bdi></dd></div>
          <div><dt>{ot.charges}</dt><dd>{selected.capabilities.paymentOptions.chargesEnabled ? ot.yes : ot.no}</dd></div>
          <div><dt>{ot.card}</dt><dd><bdi>{selected.capabilities.paymentOptions.cardPayments}</bdi></dd></div>
          <div><dt>{ot.at}</dt><dd>{selected.capabilities.paymentOptionsAt ? new Date(selected.capabilities.paymentOptionsAt).toLocaleString(locale) : '—'}</dd></div></dl>
        <p>{ot.currencies}: <bdi>{selected.capabilities.paymentOptions.currencies.join(', ')}</bdi></p><p>{ot.methods}: <bdi>{selected.capabilities.paymentOptions.paymentMethods.join(', ')}</bdi></p>
      </section>}
      <label>{t.reason}<input aria-label={t.reason} maxLength={500} value={reason} onChange={(e)=>setReason(e.target.value)} /></label>
      <button disabled={busy || reason.trim().length<3} className="secondary" onClick={()=>void action(selected.status==='DISABLED' ? 'reconnect' : 'disable')}>{selected.status==='DISABLED' ? t.reconnect : t.disable}</button>
      <h4>{t.history}</h4><ul>{probes.map((probe)=><li key={probe.id}><time>{new Date(probe.created_at).toLocaleString(locale)}</time> · <bdi>{probe.purpose}</bdi> · <bdi>{probe.state}</bdi> · {t.version} {probe.connection_version}{probe.error_code && <> · <bdi>{probe.error_code}</bdi></>}
        {probe.options_snapshot && <p>{ot.country}: <bdi>{probe.options_snapshot.country}</bdi> · {ot.currencies}: <bdi>{probe.options_snapshot.currencies.join(', ')}</bdi></p>}</li>)}</ul>
      {probeCursor && <button disabled={busy} className="secondary" onClick={()=>void history(selected.id,probeCursor).catch((e)=>setError(String(e)))}>{t.moreHistory}</button>}
      {selected.provider==='PAYPAL' && <section className="payment-beneficiary-history"><h4>{bt.history}</h4><p>{bt.configured}</p>
        {!beneficiaries.length && <p>{bt.empty}</p>}<ul>{beneficiaries.map((item)=><li key={item.id}><time>{new Date(item.created_at).toLocaleString(locale)}</time> · {t.version} {item.connection_version} · <bdi>{item.mode}</bdi> · <bdi>{item.expected_merchant_id ?? bt.missing}</bdi> · <bdi>{item.actor_role}</bdi></li>)}</ul>
        <button disabled={busy} className="secondary" onClick={()=>void beneficiaryHistory(selected.id).catch((e)=>setError(String(e)))}>{bt.refresh}</button>
        {beneficiaryCursor && <button disabled={busy} className="secondary" onClick={()=>void beneficiaryHistory(selected.id,beneficiaryCursor).catch((e)=>setError(String(e)))}>{bt.more}</button>}
      </section>}
      <PaymentWebhooks key={selected.id} provider={selected.provider as 'STRIPE'|'PAYPAL'} connectionId={selected.id} connectionVersion={selected.version} disabled={selected.status==='DISABLED'} locale={locale} api={api} />
    </section>}
    <PaymentMethods locale={locale} role={role} branches={branches} api={api} />
  </section>;
}
