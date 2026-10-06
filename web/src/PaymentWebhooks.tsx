import { useEffect,useRef,useState } from 'react';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'en'|'fr';
type Row={ id:string;version:number;state:string;connection_version:number;mode:string;external_endpoint_id:string|null;callback_url:string;created_at:string;last_signed_at:string|null };
type Probe={ id:string;state:string;error_code:string|null;created_at:string;finished_at:string|null;connection_version:number;snapshot:{ enabledEvents:string[] }|null };
type Detail=Row&{ current:boolean;endpointVerified:boolean;signedDeliveryVerified:boolean;webhookReady:boolean;financialProcessingReady:boolean;publicHttps:boolean;requiredEvents:string[];latestProbe:Probe|null };
type Event={ id:string;external_event_id:string;event_type:string;mode:string;provider_created_at:string;received_at:string;state:string;attempts:number;error_code:string|null };
const recoveryLabels={ ar:{ retry:'إعادة التحقق من الإيصال',history:'محاولات تأكيد الإيصال' },en:{ retry:'Retry receipt verification',history:'Receipt verification attempts' },fr:{ retry:'Vérifier à nouveau l’événement',history:'Tentatives de vérification' } };
const labels={
  en:{ title:'Payment webhooks',guide:'Prepare a callback here. This profile uses a v1 Account webhook (we_), not a v2 destination (ed_) or Connect/thin events. In Stripe Developers Dashboard → Webhooks → Create an event destination, register the exact callback URL and the events below in the matching sandbox/live mode. If needed, choose Developers Dashboard in Stripe Developers preferences. Copy the endpoint ID (we_) and signing secret (whsec_) here. The restricted key needs Webhook Endpoints read access.',
    proof:'The endpoint test checks provider configuration. Send a test event from Workbench, then refresh to verify signed delivery separately. A receipt alone does not confirm payment: the worker verifies its server-created request, account, session and exact money. PROCESSED means verified; check the Lead for payment and enrollment status.',
    rotation:'Credentials and callback identity are immutable. For secret or destination rotation prepare a new endpoint, verify it and retain the old endpoint for pending payments. Disabling this endpoint stops its receipts; also disable it in Workbench after pending payments are reconciled.',
    local:'This local HTTP URL cannot receive public Stripe deliveries. Deployment needs the public HTTPS application origin; local tests use signed synthetic events.',
    prepare:'Prepare payment callback',reason:'Webhook change reason',endpoint:'Stripe endpoint ID',secret:'Payment signing secret',save:'Save webhook credentials',test:'Test payment endpoint',disable:'Disable payment webhook',refresh:'Refresh payment webhooks',more:'More payment webhooks',select:'Review payment webhook',copy:'Copy payment callback URL',copied:'Callback URL copied',url:'Payment callback URL',version:'Webhook version',current:'Current configuration',endpointStatus:'Provider endpoint verified',signed:'Signed delivery verified',yes:'Yes',no:'No',state:'State',events:'Required snapshot events',history:'Payment webhook test history',moreHistory:'More webhook history',received:'Received payment events',moreEvents:'More received events',empty:'No payment webhooks.',emptyEvents:'No signed events received.',created:'Provider event time',receivedAt:'Received at',noPaid:'Stored receipt, not a payment confirmation.',secretNote:'The signing secret is encrypted, never redisplayed. No API key or customer data appears in this history.' },
  ar:{ title:'Webhooks الدفع',guide:'جهّز callback هنا. هذه profile تستخدم v1 Account webhook بهوية we_، ولا تقبل v2 destination بهوية ed_ أوConnect/thin events. من Stripe Developers Dashboard → Webhooks → Create an event destination سجّل العنوان نفسه والأحداث أدناه في بيئة Sandbox أوLive المطابقة. عند الحاجة اختر Developers Dashboard من Developers preferences لدى Stripe. انسخ Endpoint ID الذي يبدأ بـwe_ وSigning Secret الذي يبدأ بـwhsec_ هنا. يحتاج المفتاح لصلاحية قراءة Webhook Endpoints.',
    proof:'اختبار Endpoint يفحص إعداد المزود. أرسل Test event من Workbench ثم حدّث للتحقق من وصول موقّع بصورة مستقلة. الإيصال وحده لا يؤكد الدفع: يفحص Worker الطلب المحفوظ والحساب والجلسة والمبلغ الدقيق. PROCESSED تعني التحقق؛ راجع Lead لمعرفة حالة الدفع والاشتراك.',
    rotation:'السر وهوية callback ثابتان بعد الحفظ. لتدوير السر أوالعنوان جهّز Endpoint جديدة وافحصها، واحتفظ بالقديمة للمدفوعات المعلقة. تعطيل Endpoint هذه يوقف استقبالها؛ عطّلها أيضًا في Workbench بعد تسوية المدفوعات المعلقة.',
    local:'عنوان HTTP المحلي لا يستقبل أحداث Stripe العامة. يحتاج النشر إلى عنوان HTTPS العام للتطبيق؛ الاختبارات المحلية تستخدم أحداثًا اصطناعية موقّعة.',
    prepare:'تجهيز callback للدفع',reason:'سبب تغيير Webhook',endpoint:'Stripe Endpoint ID',secret:'سر توقيع الدفع',save:'حفظ بيانات Webhook',test:'اختبار Endpoint الدفع',disable:'تعطيل Webhook الدفع',refresh:'تحديث Webhooks الدفع',more:'المزيد من Webhooks الدفع',select:'مراجعة Webhook الدفع',copy:'نسخ عنوان callback للدفع',copied:'تم نسخ عنوان callback',url:'عنوان callback للدفع',version:'نسخة Webhook',current:'الإعداد الحالي',endpointStatus:'تم التحقق من Endpoint المزود',signed:'تم التحقق من وصول موقّع',yes:'نعم',no:'لا',state:'الحالة',events:'Snapshot events المطلوبة',history:'تاريخ اختبارات Webhook الدفع',moreHistory:'المزيد من تاريخ Webhook',received:'أحداث الدفع المستلمة',moreEvents:'المزيد من الأحداث',empty:'لا Webhooks للدفع.',emptyEvents:'لا أحداث موقّعة مستلمة.',created:'وقت الحدث عند المزود',receivedAt:'وقت الاستلام',noPaid:'استلام محفوظ وليس تأكيدًا للدفع.',secretNote:'سر التوقيع مشفّر ولا يعاد عرضه. لا تظهر مفاتيح API أوبيانات العميل في هذا التاريخ.' },
  fr:{ title:'Webhooks de paiement',guide:'Préparez le callback ici. Ce profil utilise un webhook Account v1 (we_), pas une destination v2 (ed_) ni Connect/thin events. Dans Stripe Developers Dashboard → Webhooks → Create an event destination, enregistrez l’URL exacte et les événements ci-dessous dans le mode sandbox/live correspondant. Au besoin, choisissez Developers Dashboard dans les préférences Developers de Stripe. Copiez l’identifiant (we_) et le secret (whsec_). La clé restreinte nécessite la lecture Webhook Endpoints.',
    proof:'Le test contrôle la configuration du fournisseur. Envoyez un événement de test puis actualisez pour vérifier la livraison signée. La réception seule ne confirme pas le paiement : le worker vérifie la demande, le compte, la session et le montant exact. PROCESSED indique la vérification ; consultez le Lead pour le paiement et l’inscription.',
    rotation:'Le secret et l’identité du callback restent immuables. Pour une rotation, préparez et vérifiez un nouveau endpoint et conservez l’ancien pour les paiements en attente. La désactivation arrête ses réceptions ; désactivez-le aussi dans Workbench après rapprochement.',
    local:'Cette URL HTTP locale ne reçoit pas les livraisons publiques Stripe. Le déploiement nécessite l’origine HTTPS publique de l’application ; les tests locaux utilisent des événements signés synthétiques.',
    prepare:'Préparer le callback de paiement',reason:'Motif du changement webhook',endpoint:'Identifiant endpoint Stripe',secret:'Secret de signature de paiement',save:'Enregistrer les identifiants webhook',test:'Tester le endpoint de paiement',disable:'Désactiver le webhook de paiement',refresh:'Actualiser les webhooks de paiement',more:'Autres webhooks de paiement',select:'Examiner le webhook de paiement',copy:'Copier l’URL callback de paiement',copied:'URL callback copiée',url:'URL callback de paiement',version:'Version du webhook',current:'Configuration actuelle',endpointStatus:'Endpoint fournisseur vérifié',signed:'Livraison signée vérifiée',yes:'Oui',no:'Non',state:'État',events:'Événements snapshot requis',history:'Historique des tests webhook',moreHistory:'Suite de l’historique webhook',received:'Événements de paiement reçus',moreEvents:'Autres événements reçus',empty:'Aucun webhook de paiement.',emptyEvents:'Aucun événement signé reçu.',created:'Date fournisseur',receivedAt:'Date de réception',noPaid:'Réception conservée, pas une confirmation de paiement.',secretNote:'Secret chiffré et jamais réaffiché. L’historique ne contient ni clé API ni données client.' },
};
export function PaymentWebhooks({ connectionId,connectionVersion,disabled,locale,api }:{ connectionId:string;connectionVersion:number;disabled:boolean;locale:Locale;api:Api }) {
  const t=labels[locale];const root='/api/payments/connections/'+connectionId;const selectedRef=useRef<string|null>(null);
  const [items,setItems]=useState<Row[]>([]);const [cursor,setCursor]=useState<string|null>(null);const [selected,setSelected]=useState<Detail|null>(null);
  const [reason,setReason]=useState('');const [endpointId,setEndpointId]=useState('');const [secret,setSecret]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [history,setHistory]=useState<Probe[]>([]);const [historyCursor,setHistoryCursor]=useState<string|null>(null);
  const [events,setEvents]=useState<Event[]>([]);const [eventCursor,setEventCursor]=useState<string|null>(null);
  const [receiptAttempts,setReceiptAttempts]=useState<{ number:number;state:string;error_code:string|null }[]>([]);
  async function load(next?:string) { const page=await api<{ items:Row[];nextCursor:string|null }>(root+'/webhooks'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setItems((prior)=>next ? [...prior,...page.items] : page.items);setCursor(page.nextCursor); }
  async function eventPage(next?:string) { const page=await api<{ items:Event[];nextCursor:string|null }>(root+'/webhook-events'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setEvents((prior)=>next ? [...prior,...page.items] : page.items);setEventCursor(page.nextCursor); }
  async function inspect(id:string,next?:string) { const detail=await api<Detail>(root+'/webhooks/'+id);
    const page=await api<{ items:Probe[];nextCursor:string|null }>(root+'/webhooks/'+id+'/history'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    if(selectedRef.current!==id)return;setSelected(detail);setHistory((prior)=>next ? [...prior,...page.items] : page.items);setHistoryCursor(page.nextCursor); }
  async function refresh() { await load();await eventPage();const id=selectedRef.current;if(id)await inspect(id); }
  useEffect(()=>{ setSecret('');void refresh().catch((e)=>setError(String(e))); },[connectionVersion,disabled]);
  async function action(kind:'prepare'|'configure'|'test'|'disable') {
    setBusy(true);setError('');setNotice('');const current=selectedRef.current;
    try { if(kind==='prepare') { const created=await api<Detail>(root+'/webhooks',{ method:'POST',body:JSON.stringify({ connectionVersion,reason }) });
        selectedRef.current=created.id;setSelected(created);setHistory([]);setHistoryCursor(null);setSecret('');setEndpointId(''); }
      else if(selected && current===selected.id) { const payload=kind==='configure' ? { version:selected.version,endpointId,signingSecret:secret,reason }
          : kind==='test' ? { version:selected.version,connectionVersion } : { version:selected.version,reason };
        await api(root+'/webhooks/'+current+'/'+kind,{ method:'POST',body:JSON.stringify(payload) }); }
      setSecret('');await refresh();
    }catch(e){ setSecret('');setError(String(e));await refresh().catch(()=>{}); }finally{ setBusy(false); }
  }
  const yes=(v:boolean)=>v ? t.yes : t.no;
  return <section className="payment-webhooks panel"><h4>{t.title}</h4><p>{t.guide} <a href="https://docs.stripe.com/development/dashboard/webhooks" target="_blank" rel="noreferrer">Stripe Account Webhooks</a></p><p>{t.proof}</p><p>{t.rotation}</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <label>{t.reason}<input aria-label={t.reason} value={reason} maxLength={500} onChange={(e)=>setReason(e.target.value)} /></label>
    <button disabled={busy || disabled || reason.trim().length<3} onClick={()=>void action('prepare')}>{t.prepare}</button>
    <button className="secondary" disabled={busy} onClick={()=>void refresh().catch((e)=>setError(String(e)))}>{t.refresh}</button>
    {items.length===0 && <p>{t.empty}</p>}<ul>{items.map((w)=><li key={w.id}><bdi>{w.mode}</bdi> · <bdi>{w.state}</bdi> · {t.version} {w.version} · <bdi>{w.external_endpoint_id ?? w.id}</bdi>{' '}
      <button className="secondary" disabled={busy} onClick={()=>{ selectedRef.current=w.id;setSelected(null);setSecret('');setEndpointId('');setHistory([]);setError('');void inspect(w.id).catch((e)=>setError(String(e))); }}>{t.select}</button></li>)}</ul>
    {cursor && <button className="secondary" disabled={busy} onClick={()=>void load(cursor).catch((e)=>setError(String(e)))}>{t.more}</button>}
    {selected && <section className="payment-webhook-detail"><h5><bdi>{selected.external_endpoint_id ?? selected.id}</bdi></h5>
      <label>{t.url}<textarea aria-label={t.url} readOnly rows={3} dir="ltr" value={selected.callback_url} /></label>
      <button className="secondary" onClick={()=>void navigator.clipboard.writeText(selected.callback_url).then(()=>setNotice(t.copied)).catch((e)=>setError(String(e)))}>{t.copy}</button>
      {!selected.publicHttps && <p>{t.local}</p>}<p>{t.events}: <bdi>{selected.requiredEvents.join(', ')}</bdi></p>
      <dl className="inbound-target-summary"><div><dt>{t.current}</dt><dd>{yes(selected.current)}</dd></div><div><dt>{t.endpointStatus}</dt><dd>{yes(selected.endpointVerified)}</dd></div>
        <div><dt>{t.signed}</dt><dd>{yes(selected.signedDeliveryVerified)}</dd></div><div><dt>{t.state}</dt><dd><bdi>{selected.state}</bdi></dd></div></dl>
      <p>{t.secretNote}</p>
      {selected.state==='DRAFT' && <form onSubmit={(e)=>{ e.preventDefault();void action('configure'); }}>
        <label>{t.endpoint}<input aria-label={t.endpoint} autoComplete="off" value={endpointId} maxLength={103} onChange={(e)=>setEndpointId(e.target.value)} /></label>
        <label>{t.secret}<input aria-label={t.secret} type="password" autoComplete="new-password" value={secret} maxLength={206} onChange={(e)=>setSecret(e.target.value)} /></label>
        <button disabled={busy || disabled || !selected.current || reason.trim().length<3 || !endpointId || !secret}>{t.save}</button></form>}
      <button disabled={busy || disabled || !selected.current || selected.state!=='CONFIGURED'} onClick={()=>void action('test')}>{t.test}</button>
      <button className="secondary" disabled={busy || selected.state==='DISABLED' || reason.trim().length<3} onClick={()=>void action('disable')}>{t.disable}</button>
      <h5>{t.history}</h5><ul>{history.map((p)=><li key={p.id}><time>{new Date(p.created_at).toLocaleString(locale)}</time> · <bdi>{p.state}</bdi> · <bdi>{p.error_code}</bdi>
        {p.snapshot && <p><bdi>{p.snapshot.enabledEvents.join(', ')}</bdi></p>}</li>)}</ul>
      {historyCursor && <button className="secondary" disabled={busy} onClick={()=>void inspect(selected.id,historyCursor).catch((e)=>setError(String(e)))}>{t.moreHistory}</button>}
    </section>}
    <h5>{t.received}</h5><p>{t.noPaid}</p>{events.length===0 && <p>{t.emptyEvents}</p>}<ul className="payment-webhook-events">{events.map((e)=><li key={e.id}><bdi>{e.external_event_id}</bdi> · <bdi>{e.event_type}</bdi> · <bdi>{e.mode}</bdi> · <bdi>{e.state}</bdi>
      <p>{t.created}: <time>{new Date(e.provider_created_at).toLocaleString(locale)}</time> · {t.receivedAt}: <time>{new Date(e.received_at).toLocaleString(locale)}</time></p><p><bdi>{e.error_code}</bdi></p>
      <button className="secondary" disabled={busy} onClick={()=>{ void api<{ items:typeof receiptAttempts }>(root+'/webhook-events/'+e.id+'/attempts').then((page)=>setReceiptAttempts(page.items)).catch((error)=>setError(String(error))); }}>{recoveryLabels[locale].history}</button>
      {e.state==='NEEDS_ATTENTION' && e.attempts<5 && <button disabled={busy || reason.trim().length<3} onClick={()=> {
        setBusy(true);setError('');void api(root+'/webhook-events/'+e.id+'/retry',{ method:'POST',body:JSON.stringify({ attempts:e.attempts,reason }) })
          .then(()=>eventPage()).catch((error)=>setError(String(error))).finally(()=>setBusy(false));
      }}>{recoveryLabels[locale].retry}</button>}</li>)}</ul>
    {!!receiptAttempts.length && <ol>{receiptAttempts.map((a)=><li key={a.number}><bdi>{a.number}: {a.state} {a.error_code}</bdi></li>)}</ol>}
    {eventCursor && <button className="secondary" disabled={busy} onClick={()=>void eventPage(eventCursor).catch((e)=>setError(String(e)))}>{t.moreEvents}</button>}
  </section>;
}
