import {useEffect,useRef,useState} from 'react';
import type {NotificationApi,NotificationLocale} from './NotificationCenter.js';
import {NotificationTemplates} from './NotificationTemplates.js';
import {leadNotificationLabels,financialNotificationLabels} from './LeadNotificationPreferences.js';
import {followUpNotificationLabel} from './FollowUpNotifications.js';
import {EmailNotificationOutbox} from './EmailNotificationOutbox.js';
import {operationalEventLabels} from './OperationalNotificationControls.js';

const words={
 en:{title:'Email notifications',note:'Email is off by default for each event. Choose notifications for your account address and a delivery language. Saving settings sends no email and does not change In-App preferences.',event:'Email notification event',enabled:'Enable this email notification',language:'Email delivery language',save:'Save email preference',reload:'Reload email preferences',history:'Email preference history',older:'Older email changes',recipient:'Account recipient',binding:'Branch email channel',branch:'Email channel branch',connection:'Email channel connection',choose:'Choose an operational account',active:'Enable branch email channel',reason:'Email channel change reason',saveBinding:'Save branch email channel',reloadBinding:'Reload branch email channel',bindingHistory:'Email channel history',moreConnections:'Next email account page',organization:'Organization account',local:'Branch account',approval:'Only Super Admin can approve or reactivate an Organization account for a Branch. A Manager may disable its existing binding.',inactive:'This Branch is inactive. The channel may be disabled, but cannot be activated.',status:'Saved channel',on:'Enabled',off:'Disabled',version:'Version',empty:'No changes on this page.',setup:'Choose an authentication-checked operational account. Connection setup is in Operational email. Channel activation and personal opt-in are separate. No customer messaging, credentials or sensitive payment details belong in notification wording.'},
 ar:{title:'إشعارات البريد',note:'البريد معطل افتراضيًا لكل حدث. اختر إشعارات عنوان حسابك ولغة إرسالها. حفظ الإعدادات لا يرسل بريدًا ولا يغير تفضيلات داخل المنصة.',event:'نوع إشعار البريد',enabled:'تفعيل إشعار البريد هذا',language:'لغة إرسال البريد',save:'حفظ تفضيل البريد',reload:'تحديث تفضيلات البريد',history:'سجل تفضيل البريد',older:'تغييرات بريد أقدم',recipient:'عنوان الحساب المستلم',binding:'قناة بريد الفرع',branch:'فرع قناة البريد',connection:'اتصال قناة البريد',choose:'اختر حسابًا تشغيليًا',active:'تفعيل قناة بريد الفرع',reason:'سبب تعديل قناة البريد',saveBinding:'حفظ قناة بريد الفرع',reloadBinding:'تحديث قناة بريد الفرع',bindingHistory:'سجل قناة البريد',moreConnections:'الصفحة التالية لحسابات البريد',organization:'حساب المؤسسة',local:'حساب الفرع',approval:'Super Admin فقط يصرح باستعمال حساب المؤسسة للفرع أو يعيد تفعيله. يستطيع Manager تعطيل الربط القائم.',inactive:'الفرع غير نشط. يمكن تعطيل القناة ولا يمكن تفعيلها.',status:'حالة القناة المحفوظة',on:'مفعلة',off:'معطلة',version:'الإصدار',empty:'لا تغييرات في هذه الصفحة.',setup:'اختر حسابًا تشغيليًا اجتاز فحص المصادقة. إعداد الاتصال في البريد التشغيلي. تفعيل القناة والتفضيل الشخصي منفصلان. لا تضع رسائل العملاء أو credentials أو بيانات الدفع الحساسة في صياغة الإشعارات.'},
 fr:{title:'Notifications e-mail',note:'L’e-mail est désactivé par défaut pour chaque événement. Choisissez les notifications à votre adresse de compte et leur langue. Enregistrer ces réglages n’envoie aucun e-mail et ne modifie pas les préférences internes.',event:'Événement de notification e-mail',enabled:'Activer cette notification e-mail',language:'Langue d’envoi e-mail',save:'Enregistrer la préférence e-mail',reload:'Actualiser les préférences e-mail',history:'Historique de préférence e-mail',older:'Modifications e-mail précédentes',recipient:'Adresse du compte destinataire',binding:'Canal e-mail de l’agence',branch:'Agence du canal e-mail',connection:'Connexion du canal e-mail',choose:'Choisir un compte opérationnel',active:'Activer le canal e-mail de l’agence',reason:'Motif du changement du canal e-mail',saveBinding:'Enregistrer le canal e-mail',reloadBinding:'Actualiser le canal e-mail',bindingHistory:'Historique du canal e-mail',moreConnections:'Page de comptes e-mail suivante',organization:'Compte de l’organisation',local:'Compte de l’agence',approval:'Seul Super Admin peut approuver ou réactiver un compte d’organisation pour une agence. Un Manager peut désactiver son lien existant.',inactive:'Cette agence est inactive. Le canal peut être désactivé, mais pas activé.',status:'État du canal enregistré',on:'Activé',off:'Désactivé',version:'Version',empty:'Aucune modification sur cette page.',setup:'Choisissez un compte opérationnel dont l’authentification a été vérifiée. Configurez-le dans E-mail opérationnel. L’activation du canal et le consentement personnel sont distincts. Aucun message client, secret ou donnée de paiement sensible dans le texte.'},
};
type User={id:string;role:'SUPER_ADMIN'|'MANAGER'|'AGENT';organizationId:string;branchId:string|null};
type Props={locale:NotificationLocale;api:NotificationApi;user:User;branches:{id:string;name:string}[]};
type Preference={eventType:string;version:number;enabled:boolean;language:NotificationLocale};
type Preferences={recipient:string;items:Preference[]};
type Change={version:number;enabled:boolean;language?:string;reason?:string;connection_id?:string|null;created_at:string};
type History={items:Change[];nextVersion:number|null};
type Connection={id:string;name:string;status:string;scope:'BRANCH'|'ORGANIZATION'};
type Binding={branchId:string;branchActive:boolean;version:number;enabled:boolean;connection:Connection|null;canEnableCurrent:boolean};
type Catalog={items:Connection[];nextCursor:string|null};

export function eventLabel(event:string,locale:NotificationLocale){
 const known:Record<string,string>={...leadNotificationLabels[locale],...financialNotificationLabels[locale],...operationalEventLabels[locale],FOLLOW_UP_DUE:followUpNotificationLabel[locale],
  AI_HANDOFF_REQUESTED:{ar:'طلب التحويل البشري',en:'Human handoff requested',fr:'Transfert humain demandé'}[locale],
  AI_HANDOFF_SLA_EXCEEDED:{ar:'تجاوز مدة الاستجابة',en:'Human response target exceeded',fr:'Délai de réponse dépassé'}[locale]};return known[event]??event;
}
function ChangeHistory({history,locale}:{history:History;locale:NotificationLocale}){
 const t=words[locale];return <>{!history.items.length&&<p>{t.empty}</p>}{history.items.map(h=><article key={h.version}>
  <p>{t.version} {h.version} · {h.enabled?t.on:t.off} · {h.language} · {new Date(h.created_at).toLocaleString(locale)}</p>
  {h.reason&&<p dir="auto">{h.reason}</p>}
 </article>)}</>;
}
function EmailPreferences({locale,api,user}:Props){
 const t=words[locale],epoch=useRef(0),[data,setData]=useState<Preferences|null>(null),[event,setEvent]=useState('AI_HANDOFF_REQUESTED'),
  [history,setHistory]=useState<History|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pref=data?.items.find(p=>p.eventType===event);
 const clear=()=>{setData(null);setHistory(null);};
 useEffect(()=>{void read();return()=>{++epoch.current;};},[locale,user.id]);
 async function read(){const n=++epoch.current;clear();setBusy(true);setError('');try{
  const p=await api<Preferences>('/api/notification-email/preferences');if(n===epoch.current)setData(p);
 }catch(e){if(n===epoch.current)setError(String(e));}finally{if(n===epoch.current)setBusy(false);}}
 async function save(){if(!pref)return;const n=++epoch.current;setBusy(true);setError('');try{
  await api('/api/notification-email/preferences/'+event,{method:'PUT',body:JSON.stringify({enabled:pref.enabled,language:pref.language,version:pref.version})});
  const p=await api<Preferences>('/api/notification-email/preferences');if(n===epoch.current){setData(p);setHistory(null);}
 }catch(e){if(n===epoch.current){clear();setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}}
 async function readHistory(older=false){const n=++epoch.current;setBusy(true);setError('');try{
  const h=await api<History>('/api/notification-email/preferences/'+event+'/history'+(older&&history?.nextVersion?'?before='+history.nextVersion:''));if(n===epoch.current)setHistory(h);
 }catch(e){if(n===epoch.current){clear();setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}}
 const change=(p:Partial<Preference>)=>{if(data)setData({...data,items:data.items.map(v=>v.eventType===event?{...v,...p}:v)});};
 return <section data-email-preferences><h3>{t.title}</h3><p>{t.note}</p><button disabled={busy} onClick={()=>void read()}>{t.reload}</button>
  {error&&<p role="alert">{error}</p>}{data&&<fieldset style={{minInlineSize:0}}><legend>{t.title}</legend><p>{t.recipient}: <span dir="auto">{data.recipient}</span></p>
   <label>{t.event}<select aria-label={t.event} disabled={busy} value={event} onChange={e=>{setEvent(e.target.value);setHistory(null);}}>{data.items.map(p=><option key={p.eventType} value={p.eventType}>{eventLabel(p.eventType,locale)}</option>)}</select></label>
   {pref&&<><label><input type="checkbox" checked={pref.enabled} disabled={busy} onChange={e=>change({enabled:e.target.checked})}/>{t.enabled}</label>
    <label>{t.language}<select aria-label={t.language} value={pref.language} disabled={busy} onChange={e=>change({language:e.target.value as NotificationLocale})}><option value="ar">العربية</option><option value="en">English</option><option value="fr">Français</option></select></label>
    <p>{t.version} {pref.version}</p><button disabled={busy} onClick={()=>void save()}>{t.save}</button><button disabled={busy} onClick={()=>void readHistory()}>{t.history}</button></>}
   {history&&<div data-email-preference-history><ChangeHistory history={history} locale={locale}/>{history.nextVersion&&<button disabled={busy} onClick={()=>void readHistory(true)}>{t.older}</button>}</div>}
  </fieldset>}
 </section>;
}
function EmailBranchSettings({locale,api,user,branches}:Props){
 const t=words[locale],epoch=useRef(0),[id,setId]=useState(user.branchId??branches[0]?.id??''),[model,setModel]=useState<Binding|null>(null),
  [catalog,setCatalog]=useState<Catalog|null>(null),[chosen,setChosen]=useState<Connection|null>(null),[enabled,setEnabled]=useState(false),
  [reason,setReason]=useState(''),[history,setHistory]=useState<History|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const root='/api/notification-email/branches/'+id,clear=()=>{setModel(null);setCatalog(null);setChosen(null);setHistory(null);setReason('');};
 useEffect(()=>{if(id)void read();else clear();return()=>{++epoch.current;};},[id,locale,user.id]);
 async function read(){const n=++epoch.current;clear();setBusy(true);setError('');try{
  const [m,c,h]=await Promise.all([api<Binding>(root),api<Catalog>(root+'/connections'),api<History>(root+'/history')]);
  if(n===epoch.current){setModel(m);setCatalog(c);setChosen(m.connection);setEnabled(m.enabled);setHistory(h);}
 }catch(e){if(n===epoch.current)setError(String(e));}finally{if(n===epoch.current)setBusy(false);}}
 async function save(){if(!model)return;const n=++epoch.current;setBusy(true);setError('');try{
  await api(root,{method:'PUT',body:JSON.stringify({version:model.version,connectionId:chosen?.id??null,enabled,reason})});
  if(n===epoch.current)await read();
 }catch(e){if(n===epoch.current){clear();setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}}
 async function page(kind:'CONNECTION'|'HISTORY'){const n=++epoch.current;setBusy(true);setError('');try{
  if(kind==='CONNECTION'){const c=await api<Catalog>(root+'/connections?after='+catalog!.nextCursor);if(n===epoch.current)setCatalog(c);}
  else {const h=await api<History>(root+'/history?before='+history!.nextVersion);if(n===epoch.current)setHistory(h);}
 }catch(e){if(n===epoch.current){clear();setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}}
 const items=[...new Map([...(catalog?.items??[]),...(chosen?[chosen]:[])].map(c=>[c.id,c])).values()],organization=chosen?.scope==='ORGANIZATION'&&user.role==='MANAGER';
 return <section className="panel" data-email-channel style={{minWidth:0,overflowWrap:'anywhere'}}><h3>{t.binding}</h3><p>{t.setup}</p><p>{t.approval}</p>
  <label>{t.branch}<select aria-label={t.branch} disabled={busy} value={id} onChange={e=>setId(e.target.value)}>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
  <button disabled={busy||!id} onClick={()=>void read()}>{t.reloadBinding}</button>{error&&<p role="alert">{error}</p>}
  {model&&<fieldset data-email-channel-detail style={{minInlineSize:0}}><legend>{t.binding}</legend><p>{t.status}: {model.enabled?t.on:t.off} · {t.version} {model.version}</p>{!model.branchActive&&<p>{t.inactive}</p>}
   <label>{t.connection}<select aria-label={t.connection} disabled={busy} value={chosen?.id??''} onChange={e=>{setChosen(items.find(c=>c.id===e.target.value)??null);setEnabled(false);}}><option value="">{t.choose}</option>{items.map(c=><option key={c.id} value={c.id}>{c.name} · {c.scope==='ORGANIZATION'?t.organization:t.local} · {c.status}</option>)}</select></label>
   {catalog?.nextCursor&&<button disabled={busy} onClick={()=>void page('CONNECTION')}>{t.moreConnections}</button>}
   <label><input type="checkbox" checked={enabled} disabled={busy||!enabled&&(!model.branchActive||chosen?.status!=='CONNECTED'||organization)} onChange={e=>setEnabled(e.target.checked)}/>{t.active}</label>
   <label>{t.reason}<input disabled={busy} value={reason} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>
   <button disabled={busy||reason.trim().length<3||enabled&&(!model.branchActive||chosen?.status!=='CONNECTED')} onClick={()=>void save()}>{t.saveBinding}</button>
   {history&&<div data-email-channel-history><h4>{t.bindingHistory}</h4><ChangeHistory history={history} locale={locale}/>{history.nextVersion&&<button disabled={busy} onClick={()=>void page('HISTORY')}>{t.older}</button>}</div>}
  </fieldset>}
 </section>;
}
export function EmailNotificationSettings(props:Props){
 return <section className="panel" data-email-notification-settings style={{minWidth:0,overflowWrap:'anywhere'}}>
  <EmailPreferences {...props}/>{props.user.role!=='AGENT'&&<><EmailBranchSettings {...props}/><NotificationTemplates locale={props.locale} api={props.api}
   user={{...props.user,role:props.user.role}} branches={props.branches} channel="EMAIL"/></>}
  <EmailNotificationOutbox locale={props.locale} api={props.api} userId={props.user.id} eventLabel={eventLabel} canManage={props.user.role!=='AGENT'}/>
 </section>;
}
