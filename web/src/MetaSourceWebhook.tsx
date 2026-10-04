import { useEffect,useState } from 'react';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'fr'|'en';
type Attempt={ id:string;action:string;state:string;subscribed:boolean|null;error_code:string|null;started_at:string };
type Health={ callbackPath:string;handshakeVerified:boolean;signedCallbackVerified:boolean;handshakeAt:string|null;lastIncomingAt:string|null;
  pending:number;running:number;failed:number;blocked:number;retrieved:number;oldestPendingAt:string|null;appIdConfigured:boolean;subscription:{ state:string;subscribed:boolean|null;current:boolean;error_code:string|null }|null };
type Event={ id:string;external_page_id:string;external_form_id:string;external_lead_id:string;source_created_at:string;received_at:string;
  state:string;version:number;attempts:number;failures:number;recoveries:number;error_code:string|null;available_at:string;submission_id:string|null };
type RetrievalAttempt={ attempt_number:number;state:string;error_code:string|null;started_at:string;finished_at:string|null };
const labels={
  ar:{ title:'Webhook المصدر واشتراك Page',instructions:'من Meta App Dashboard الخاص بالمؤسسة اختر Webhooks → Page. أدخل Callback URL أدناه ورمز التحقق نفسه الذي حفظته عند إنشاء المصدر، ثم Verify and Save واشترك في leadgen. يلزم HTTPS عام وصلاحيات Pages وLead Ads وLeads Access وApp Review المناسبة. اختر Page مكتشفة، ثم اشترك عبر الزر واختبر الحالة. إذا رفض المزود، راجع صلاحيات التطبيق وإسناد Page وLeads Access لدى Meta وأعد الاختبار. استخدم أداة Lead Ads Testing لدى Meta لإرسال حدث اختبار؛ تحديث الحالة هنا يقرأ التحقق الفعلي ولا يولد حدثاً وهمياً.',url:'Callback URL للمصدر',app:'App ID مطلوب للاشتراك واختباره؛ أدخله من تعديل المصدر ثم أعد اكتشاف Pages.',token:'رمز التحقق لا يعرض مجدداً. استخدم القيمة المحفوظة لديك؛ لاستبدالها عدّل credentials وأعد إعداد المصدر.',handshake:'تحقق Callback لدى Meta',signed:'وصول حدث موقع صحيح',yes:'متحقق',no:'لم يتحقق',refresh:'تحديث حالة Webhook',subscribe:'اشترك في Page leadgen',test:'اختبر اشتراك Page',subscription:'اشتراك Page المحددة',stale:'نتيجة قديمة؛ أعد الاختبار',unknown:'غير مختبر',on:'مشتركة',off:'غير مشتركة',pending:'أحداث محفوظة تنتظر المعالجة',last:'آخر حدث وارد',oldest:'أقدم حدث ينتظر',notReady:'حفظ الإشعارات يعمل. جلب بيانات Lead ومعالجتها غير مهيأ بعد؛ نجاح الاشتراك أو التوقيع لا يعني إنشاء Lead.',history:'سجل محاولات الاشتراك',events:'إشعارات المصدر المحفوظة',more:'المزيد',empty:'لا سجلات بعد.' },
  en:{ title:'Source Webhook and Page subscription',instructions:'In your organization’s Meta App Dashboard, select Webhooks → Page. Enter the Callback URL below and the same verification token saved with this source, then Verify and Save and select leadgen. Public HTTPS, suitable Pages/Lead Ads permissions, Leads Access and App Review are required. Choose a discovered Page, subscribe using the button, then test its status. If Meta rejects it, review app permissions, Page assignment and Leads Access at Meta and test again. Use Meta’s Lead Ads Testing tool to send a test event; refreshing here reads actual verification and never generates a fake event.',url:'Source Callback URL',app:'App ID is required to subscribe and test. Enter it in Edit source, then rediscover Pages.',token:'The verification token is never redisplayed. Use your saved value; to replace it, edit credentials and reconfigure this source.',handshake:'Meta Callback verification',signed:'Valid signed event received',yes:'Verified',no:'Not verified',refresh:'Refresh Webhook status',subscribe:'Subscribe Page to leadgen',test:'Test Page subscription',subscription:'Selected Page subscription',stale:'Outdated result; test again',unknown:'Not tested',on:'Subscribed',off:'Not subscribed',pending:'Saved events awaiting processing',last:'Last incoming event',oldest:'Oldest pending event',notReady:'Notifications are stored. Lead retrieval and processing are not configured yet; subscription or signature success does not mean a Lead was created.',history:'Subscription attempt history',events:'Saved source notifications',more:'More',empty:'No records yet.' },
  fr:{ title:'Webhook source et abonnement Page',instructions:'Dans le Meta App Dashboard de votre organisation, choisissez Webhooks → Page. Saisissez le Callback URL ci-dessous et le même jeton de vérification enregistré, puis Verify and Save et leadgen. HTTPS public, permissions Pages/Lead Ads, Leads Access et App Review adaptés sont nécessaires. Choisissez une Page découverte, abonnez-la puis testez. En cas de refus, vérifiez les permissions et l’accès à la Page chez Meta. Utilisez Lead Ads Testing de Meta pour un événement de test ; actualiser ici lit la vérification réelle sans événement fictif.',url:'Callback URL source',app:'App ID requis pour l’abonnement et le test. Ajoutez-le dans Modifier la source puis redécouvrez les Pages.',token:'Le jeton de vérification n’est jamais réaffiché. Utilisez votre valeur enregistrée ; pour le remplacer, modifiez les secrets et reconfigurez.',handshake:'Vérification Callback Meta',signed:'Événement signé valide reçu',yes:'Vérifié',no:'Non vérifié',refresh:'Actualiser le Webhook',subscribe:'Abonner la Page à leadgen',test:'Tester l’abonnement Page',subscription:'Abonnement Page sélectionnée',stale:'Résultat ancien ; retestez',unknown:'Non testé',on:'Abonnée',off:'Non abonnée',pending:'Événements enregistrés en attente',last:'Dernier événement reçu',oldest:'Plus ancien en attente',notReady:'Les notifications sont enregistrées. La récupération et le traitement des prospects ne sont pas configurés ; un abonnement ou une signature valide ne signifie pas qu’un Lead est créé.',history:'Historique des abonnements',events:'Notifications source enregistrées',more:'Plus',empty:'Aucun enregistrement.' },
} as const;
export function MetaSourceWebhook({ locale,connection,page,api,changed }:{ locale:Locale;connection:{ id:string;version:number;status:string };
  page?:{ id:string;version:number;active:boolean;connection_version:number };api:Api;changed:()=>Promise<void> }) {
  const t=labels[locale];const root=`/api/sources/meta/connections/${connection.id}`;
  const [health,setHealth]=useState<Health|null>(null);const [attempts,setAttempts]=useState<Attempt[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [events,setEvents]=useState<Event[]>([]);const [eventCursor,setEventCursor]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const [eventId,setEventId]=useState('');const [retrievalAttempts,setRetrievalAttempts]=useState<RetrievalAttempt[]>([]);const [beforeAttempt,setBeforeAttempt]=useState<number|null>(null);
  const [reason,setReason]=useState('');
  const words=locale==='ar' ? { retrieved:'تم جلب بياناتها',running:'قيد الجلب',failed:'فشل الجلب',blocked:'جلب محجوب',details:'محاولات جلب المصدر',reason:'سبب إعادة جلب المصدر',retry:'أعد محاولة الجلب',hint:'راجع فشل المصدر وأصلحه قبل إعادة المحاولة. لا تستبدل الإعادة Source Submission محفوظة؛ تطبيق Mapping وإنشاء Lead يتبعان مرحلة intake.',attempts:'عدد محاولات الجلب' }
    : locale==='fr' ? { retrieved:'Données récupérées',running:'Récupération en cours',failed:'Récupération échouée',blocked:'Récupération bloquée',details:'Tentatives de récupération source',reason:'Motif de nouvelle récupération',retry:'Relancer la récupération',hint:'Corrigez l’échec avant de relancer. Une soumission enregistrée n’est jamais remplacée ; Mapping et création du Lead suivront.',attempts:'Nombre de tentatives' }
      : { retrieved:'Source data retrieved',running:'Retrieval running',failed:'Retrieval failed',blocked:'Retrieval blocked',details:'Source retrieval attempts',reason:'Source retrieval retry reason',retry:'Retry source retrieval',hint:'Fix the source failure before retrying. Retrieval never replaces a saved Submission; Mapping and Lead creation follow in the intake stage.',attempts:'Retrieval attempts' };
  async function retrievalHistory(id:string,before?:number) {
    const result=await api<{ items:RetrievalAttempt[];nextBeforeAttempt:number|null }>(root+'/webhook-events/'+id+'/attempts'+(before ? '?beforeAttempt='+before : ''));
    setEventId(id);setRetrievalAttempts((old)=>before ? [...old,...result.items] : result.items);setBeforeAttempt(result.nextBeforeAttempt);
  }
  async function retry(event:Event) {
    await api(root+'/webhook-events/'+event.id+'/retry',{ method:'POST',body:JSON.stringify({ version:event.version,reason }) });
    setReason('');await Promise.all([refresh(),retrievalHistory(event.id)]);
  }
  async function history(next?:string) {
    if (!page) return;const query=new URLSearchParams({ pageId:page.id,...(next ? { cursor:next } : {}) });
    const result=await api<{ items:Attempt[];nextCursor:string|null }>(root+'/subscription-history?'+query);
    setAttempts((old)=>next ? [...old,...result.items] : result.items);setCursor(result.nextCursor);
  }
  async function notifications(next?:string) {
    const result=await api<{ items:Event[];nextCursor:string|null }>(root+'/webhook-events'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setEvents((old)=>next ? [...old,...result.items] : result.items);setEventCursor(result.nextCursor);
  }
  async function refresh() { const value=await api<Health>(root+'/webhook'+(page ? '?pageId='+page.id : ''));setHealth(value);await Promise.all([history(),notifications()]); }
  async function run(work:()=>Promise<void>) { setBusy(true);setError('');try { await work(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  useEffect(()=> { void run(refresh); },[]);
  async function check(subscribe:boolean) {
    if (!page) return;
    try { await api(root+'/subscription',{ method:'POST',body:JSON.stringify({ version:connection.version,pageId:page.id,pageVersion:page.version,subscribe }) }); }
    finally { await Promise.all([refresh(),changed()]); }
  }
  const allowed=!!page?.active && page.connection_version===connection.version && connection.status!=='DISABLED' && health?.appIdConfigured;
  return <section className="panel source-webhook"><h4>{t.title}</h4><p>{t.instructions}</p>
    <p><a href="https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/" target="_blank" rel="noopener noreferrer">Meta · Lead Ads Webhooks / Testing</a></p>
    {error && <p className="error" role="alert">{error}</p>}
    {health && <><label>{t.url}<input aria-label={t.url} readOnly dir="ltr" value={new URL(health.callbackPath,window.location.origin).toString()}/></label><p>{t.token}</p>
      <p>{t.handshake}: {health.handshakeVerified ? t.yes : t.no} · {health.handshakeAt ?? '—'}</p><p>{t.signed}: {health.signedCallbackVerified ? t.yes : t.no}</p>
      {!health.appIdConfigured && <p>{t.app}</p>}<p>{words.hint}</p><p>{t.pending}: {health.pending} · {t.last}: {health.lastIncomingAt ?? '—'} · {t.oldest}: {health.oldestPendingAt ?? '—'}</p>
      <p>{words.retrieved}: {health.retrieved} · {words.running}: {health.running} · {words.failed}: {health.failed} · {words.blocked}: {health.blocked}</p>
      {page && <p>{t.subscription}: {health.subscription ? !health.subscription.current ? t.stale : health.subscription.state==='SUCCEEDED' ? health.subscription.subscribed ? t.on : t.off : health.subscription.state : t.unknown}{health.subscription?.error_code && ` · ${health.subscription.error_code}`}</p>}</>}
    <div className="actions"><button disabled={busy} onClick={()=>void run(refresh)}>{t.refresh}</button><button disabled={busy || !allowed} onClick={()=>void run(()=>check(false))}>{t.test}</button>
      <button disabled={busy || !allowed} onClick={()=>void run(()=>check(true))}>{t.subscribe}</button></div>
    {page && <><h5>{t.history}</h5>{!attempts.length && <p>{t.empty}</p>}<ul>{attempts.map((a)=><li key={a.id}>{a.action} · {a.state} · {a.subscribed==null ? '—' : a.subscribed ? t.on : t.off} · {a.started_at}{a.error_code && ` · ${a.error_code}`}</li>)}</ul>
      {cursor && <button disabled={busy} onClick={()=>void run(()=>history(cursor))}>{t.more}</button>}</>}
    <h5>{t.events}</h5>{!events.length && <p>{t.empty}</p>}<ul>{events.map((e)=><li key={e.id}>Page {e.external_page_id} · Form {e.external_form_id} · Lead {e.external_lead_id} · {e.source_created_at} · {e.received_at}
      <p>{e.state} · {words.attempts}: {e.attempts}{e.error_code && ` · ${e.error_code}`}{e.submission_id && <span> · Submission {e.submission_id}</span>}</p>
      <button disabled={busy} onClick={()=>void run(()=>retrievalHistory(e.id))}>{words.details}</button>
      {eventId===e.id && <section className="panel"><ul>{retrievalAttempts.map((a)=><li key={a.attempt_number}>#{a.attempt_number} · {a.state} · {a.started_at}{a.error_code && ` · ${a.error_code}`}</li>)}</ul>
        {beforeAttempt && <button disabled={busy} onClick={()=>void run(()=>retrievalHistory(e.id,beforeAttempt))}>{t.more}</button>}
        {['FAILED','BLOCKED'].includes(e.state) && <><label>{words.reason}<input aria-label={words.reason} value={reason} maxLength={500} onChange={(v)=>setReason(v.target.value)}/></label>
          <button disabled={busy || !reason.trim() || connection.status==='DISABLED'} onClick={()=>void run(()=>retry(e))}>{words.retry}</button></>}
      </section>}</li>)}</ul>
    {eventCursor && <button disabled={busy} onClick={()=>void run(()=>notifications(eventCursor))}>{t.more}</button>}
  </section>;
}
