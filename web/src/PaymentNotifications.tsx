import { useEffect,useRef,useState } from 'react';
type Locale='ar'|'en'|'fr';type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Endpoint={ id:string;version:number;connection_version:number;account_ref:string;mode:string;state:string;callback_url:string;current:boolean;publicHttps:boolean };
type Notification={ id:string;resource_id:string;mode:string;trust:'UNVERIFIED';received_at:string };
type History={ version:number;state:string;reason:string;created_at:string };
const labels={
  ar:{ title:'إشعارات Alma',guide:'Alma ترسل GET غير موقّعة مع pid إلى callback المرفقة بطلب الدفع. جهّز العنوان هنا؛ ستُرفق عند إصدار الدفع من المنصة. لا يوجد سر توقيع أوفحص مزوّر لهوية المرسل. الإشعار وعودة العميل وادعاؤه ليست إثبات دفع؛ يلزم فحص مالي مستقل من المزود.',
    partial:'الإصدار والتأكيد المالي لـAlma غير مفعّلين بعد. الإشعارات هنا محفوظة وغير متحققة، ولا تنشئ Payment أوEnrollment.',
    local:'هذا عنوان HTTP محلي، وليس عنوانًا عامًا يمكن لـAlma الوصول إليه. يلزم أصل HTTPS العام للتطبيق عند النشر.',
    retention:'تعطيل الاتصال أوتدوير مفتاحه لا يحذف الإشعارات ولا يوقف endpoint تاريخية مفعّلة. عطّل endpoint صراحة لإيقاف استقبالها؛ إعادة تفعيلها تتطلب إعدادها وحسابها الأصليين الحاليين.',
    reason:'سبب تغيير إشعارات Alma',prepare:'تجهيز callback لـAlma',refresh:'تحديث إشعارات Alma',review:'مراجعة callback لـAlma',more:'المزيد من callbacks لـAlma',disable:'تعطيل callback لـAlma',reconnect:'إعادة تفعيل callback لـAlma',
    url:'عنوان callback لـAlma',copy:'نسخ callback لـAlma',copied:'تم نسخ callback لـAlma',current:'الإعداد الحالي',yes:'نعم',no:'لا',version:'نسخة',history:'تاريخ callback لـAlma',moreHistory:'المزيد من تاريخ callback لـAlma',received:'إشعارات غير متحققة',moreEvents:'المزيد من إشعارات Alma',empty:'لا callbacks لـAlma.',emptyEvents:'لم تصل إشعارات.',account:'حساب المزود',state:'الحالة',status:'UNVERIFIED — استلام فقط دون إثبات مالي' },
  en:{ title:'Alma notifications',guide:'Alma sends unsigned GET with pid to the callback attached to a payment request. Prepare the URL here; it will be attached when the platform issues a payment. There is no signing secret or simulated sender verification. Notifications, customer returns and claims are not paid evidence; independent financial provider reads are required.',
    partial:'Alma issuance and financial confirmation are not activated yet. Notifications here are stored and unverified; they create no Payment or Enrollment.',
    local:'This is a local HTTP URL, not a public URL reachable by Alma. Deployment requires the public HTTPS application origin.',
    retention:'Disabling a connection or rotating its key retains history and does not stop an enabled historical endpoint. Explicitly disable the endpoint to stop reception; reconnection requires its original account and configuration to be current.',
    reason:'Alma notification change reason',prepare:'Prepare Alma callback',refresh:'Refresh Alma notifications',review:'Review Alma callback',more:'More Alma callbacks',disable:'Disable Alma callback',reconnect:'Reconnect Alma callback',
    url:'Alma callback URL',copy:'Copy Alma callback',copied:'Alma callback copied',current:'Current configuration',yes:'Yes',no:'No',version:'Version',history:'Alma callback history',moreHistory:'More Alma callback history',received:'Unverified notifications',moreEvents:'More Alma notifications',empty:'No Alma callbacks.',emptyEvents:'No notifications received.',account:'Provider account',state:'State',status:'UNVERIFIED — receipt only, no financial proof' },
  fr:{ title:'Notifications Alma',guide:'Alma envoie un GET non signé avec pid au callback joint à la demande de paiement. Préparez l’URL ici ; elle sera jointe lors de l’émission par la plateforme. Aucun secret de signature ni vérification simulée de l’expéditeur. Notification, retour oudéclaration client ne prouvent pas le paiement ; lecture financière indépendante du fournisseur obligatoire.',
    partial:'Émission et confirmation financière Alma pas encore activées. Notifications conservées et non vérifiées ; aucun Payment ni Enrollment créé.',
    local:'URL HTTP locale, inaccessible publiquement par Alma. Le déploiement nécessite l’origine HTTPS publique de l’application.',
    retention:'Désactiver une connexion ouchanger sa clé conserve l’historique et ne stoppe pas un endpoint historique actif. Désactivez explicitement le endpoint ; réactivation uniquement pour son compte et sa configuration d’origine actuels.',
    reason:'Motif de changement des notifications Alma',prepare:'Préparer le callback Alma',refresh:'Actualiser les notifications Alma',review:'Examiner le callback Alma',more:'Autres callbacks Alma',disable:'Désactiver le callback Alma',reconnect:'Réactiver le callback Alma',
    url:'URL callback Alma',copy:'Copier le callback Alma',copied:'Callback Alma copié',current:'Configuration actuelle',yes:'Oui',no:'Non',version:'Version',history:'Historique du callback Alma',moreHistory:'Suite de l’historique Alma',received:'Notifications non vérifiées',moreEvents:'Autres notifications Alma',empty:'Aucun callback Alma.',emptyEvents:'Aucune notification reçue.',account:'Compte fournisseur',state:'État',status:'UNVERIFIED — réception seule, sans preuve financière' },
};
export function PaymentNotifications({ connectionId,connectionVersion,canPrepare,locale,api }: {
  connectionId:string;connectionVersion:number;canPrepare:boolean;locale:Locale;api:Api
}) {
  const t=labels[locale];const root='/api/payments/connections/'+connectionId;const selectedRef=useRef<string|null>(null);const generation=useRef(0);
  const [items,setItems]=useState<Endpoint[]>([]);const [cursor,setCursor]=useState<string|null>(null);const [selected,setSelected]=useState<Endpoint|null>(null);
  const [notifications,setNotifications]=useState<Notification[]>([]);const [notificationCursor,setNotificationCursor]=useState<string|null>(null);
  const [history,setHistory]=useState<History[]>([]);const [before,setBefore]=useState<number|null>(null);
  const [reason,setReason]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  async function load(next?:string) {
    const g=generation.current;const result=await api<{ items:Endpoint[];nextCursor:string|null }>(root+'/notification-endpoints'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    if(g!==generation.current)return;setItems((p)=>next ? [...p,...result.items] : result.items);setCursor(result.nextCursor);
  }
  async function received(next?:string) {
    const g=generation.current;const result=await api<{ items:Notification[];nextCursor:string|null }>(root+'/untrusted-notifications'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    if(g!==generation.current)return;setNotifications((p)=>next ? [...p,...result.items] : result.items);setNotificationCursor(result.nextCursor);
  }
  async function inspect(id:string,next?:number) {
    const g=generation.current;const [detail,result]=await Promise.all([api<Endpoint>(root+'/notification-endpoints/'+id),
      api<{ items:History[];nextVersion:number|null }>(root+'/notification-endpoints/'+id+'/history'+(next ? '?before='+next : ''))]);
    if(g!==generation.current || selectedRef.current!==id)return;setSelected(detail);setHistory((p)=>next ? [...p,...result.items] : result.items);setBefore(result.nextVersion);
  }
  async function refresh() { await Promise.all([load(),received()]);const id=selectedRef.current;if(id)await inspect(id); }
  useEffect(()=>{ generation.current++;void refresh().catch((e)=>setError(String(e)));return ()=>{ generation.current++; }; },[connectionVersion,canPrepare]);
  async function run(work:()=>Promise<unknown>) { setBusy(true);setError('');setNotice('');try { await work(); }catch(e){ setError(String(e)); }finally { setBusy(false); } }
  async function action(kind:'prepare'|'disable'|'reconnect') {
    try { if(kind==='prepare') { const made=await api<Endpoint>(root+'/notification-endpoints',{ method:'POST',body:JSON.stringify({ connectionVersion,reason }) });
        selectedRef.current=made.id;setSelected(made); }
      else if(selected)await api(root+'/notification-endpoints/'+selected.id+'/'+kind,{ method:'POST',body:JSON.stringify({ version:selected.version,reason }) });
    }finally { await refresh(); }
  }
  return <section className="payment-notifications panel"><h4>{t.title}</h4><p>{t.guide} <a href="https://docs.almapay.com/docs/custom-integration-technical-guide" target="_blank" rel="noopener noreferrer">Alma IPN</a></p>
    <p>{t.partial}</p><p>{t.retention}</p>{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <label>{t.reason}<input aria-label={t.reason} value={reason} maxLength={500} disabled={busy} onChange={(e)=>setReason(e.target.value)} /></label>
    <button disabled={busy || !canPrepare || reason.trim().length<3} onClick={()=>void run(()=>action('prepare'))}>{t.prepare}</button>
    <button className="secondary" disabled={busy} onClick={()=>void run(refresh)}>{t.refresh}</button>
    {!items.length && <p>{t.empty}</p>}<ul>{items.map((item)=><li key={item.id}><bdi>{item.account_ref}</bdi> · <bdi>{item.mode}</bdi> · <bdi>{item.state}</bdi> · {t.version} {item.connection_version}{' '}
      <button className="secondary" disabled={busy} onClick={()=>void run(async()=>{ selectedRef.current=item.id;setSelected(null);setHistory([]);await inspect(item.id); })}>{t.review}</button></li>)}</ul>
    {cursor && <button className="secondary" disabled={busy} onClick={()=>void run(()=>load(cursor))}>{t.more}</button>}
    {selected && <section className="payment-notification-detail"><label>{t.url}<textarea aria-label={t.url} dir="ltr" readOnly rows={3} value={selected.callback_url} /></label>
      <button className="secondary" disabled={busy} onClick={()=>void navigator.clipboard.writeText(selected.callback_url).then(()=>setNotice(t.copied)).catch((e)=>setError(String(e)))}>{t.copy}</button>
      {!selected.publicHttps && <p>{t.local}</p>}
      <dl className="inbound-target-summary"><div><dt>{t.account}</dt><dd><bdi>{selected.account_ref}</bdi></dd></div><div><dt>{t.current}</dt><dd>{selected.current ? t.yes : t.no}</dd></div>
        <div><dt>{t.state}</dt><dd><bdi>{selected.state}</bdi></dd></div><div><dt>{t.version}</dt><dd>{selected.version}</dd></div></dl>
      <button className="secondary" disabled={busy || selected.state!=='ENABLED' || reason.trim().length<3} onClick={()=>void run(()=>action('disable'))}>{t.disable}</button>
      <button disabled={busy || !selected.current || selected.state!=='DISABLED' || reason.trim().length<3} onClick={()=>void run(()=>action('reconnect'))}>{t.reconnect}</button>
      <h5>{t.history}</h5><ul>{history.map((item)=><li key={item.version}><time>{new Date(item.created_at).toLocaleString(locale)}</time> · {t.version} {item.version} · <bdi>{item.state}</bdi><p>{item.reason}</p></li>)}</ul>
      {before && <button className="secondary" disabled={busy} onClick={()=>void run(()=>inspect(selected.id,before))}>{t.moreHistory}</button>}
    </section>}
    <h5>{t.received}</h5>{!notifications.length && <p>{t.emptyEvents}</p>}<ul className="payment-untrusted-notifications">{notifications.map((item)=><li key={item.id}><bdi>{item.resource_id}</bdi> · <bdi>{item.mode}</bdi>
      <p>{t.status}</p><time>{new Date(item.received_at).toLocaleString(locale)}</time></li>)}</ul>
    {notificationCursor && <button className="secondary" disabled={busy} onClick={()=>void run(()=>received(notificationCursor))}>{t.moreEvents}</button>}
  </section>;
}
