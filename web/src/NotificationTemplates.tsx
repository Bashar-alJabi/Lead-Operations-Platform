import {useEffect,useRef,useState} from 'react';
import type {NotificationApi,NotificationLocale} from './NotificationCenter.js';
import {leadNotificationEvents,leadNotificationLabels,financialNotificationEvents,financialNotificationLabels,type LeadNotificationEvent,type FinancialNotificationEvent} from './LeadNotificationPreferences.js';
import {followUpNotificationLabel} from './FollowUpNotifications.js';
const words={
 en:{title:'Notification wording',scope:'Wording scope',branch:'Branch',campaign:'Campaign',global:'Organization default',select:'Choose a resource',resource:'Wording resource',load:'Load wording',active:'Use this wording',subject:'Notification title',body:'Notification body',reason:'Wording change reason',save:'Save notification wording',preview:'Preview with sample values',defaults:'Safe default wording',note:'Plain text only. Available placeholders: {{campaign}}, {{owner}}. For each language: active Campaign → Branch → Organization wording → safe default. Disabling a template uses the next fallback. These notifications do not send customer messages.',history:'Wording history',more:'Older wording changes',campaigns:'Next campaign page',first:'First campaign page',sampleCampaign:'Sample campaign',sampleOwner:'Sample owner'},
 ar:{title:'صياغة الإشعارات',scope:'نطاق الصياغة',branch:'الفرع',campaign:'الحملة',global:'الافتراضي للمؤسسة',select:'اختر نطاقًا',resource:'نطاق إعداد الصياغة',load:'تحميل الصياغة',active:'استخدام هذه الصياغة',subject:'عنوان الإشعار',body:'نص الإشعار',reason:'سبب تعديل الصياغة',save:'حفظ صياغة الإشعار',preview:'معاينة بقيم نموذجية',defaults:'الصياغة الافتراضية الآمنة',note:'نص عادي فقط. المتغيرات المتاحة: {{campaign}} و{{owner}}. لكل لغة: صياغة الحملة النشطة ← الفرع ← المؤسسة ← الافتراضي الآمن. تعطيل الصياغة يستخدم البديل التالي. لا ترسل هذه الإشعارات رسائل للعملاء.',history:'سجل الصياغة',more:'تغييرات أقدم للصياغة',campaigns:'الصفحة التالية للحملات',first:'الصفحة الأولى للحملات',sampleCampaign:'حملة نموذجية',sampleOwner:'موظف نموذجي'},
 fr:{title:'Texte des notifications',scope:'Portée du texte',branch:'Agence',campaign:'Campagne',global:'Par défaut pour l’organisation',select:'Choisir une ressource',resource:'Ressource du texte',load:'Charger le texte',active:'Utiliser ce texte',subject:'Titre de notification',body:'Corps de notification',reason:'Motif du changement de texte',save:'Enregistrer le texte',preview:'Aperçu avec valeurs exemples',defaults:'Texte par défaut sûr',note:'Texte brut uniquement. Variables : {{campaign}}, {{owner}}. Pour chaque langue : Campagne active → Agence → Organisation → texte sûr. Désactiver un texte utilise le suivant. Ces notifications n’envoient pas de messages aux clients.',history:'Historique du texte',more:'Modifications précédentes',campaigns:'Page de campagnes suivante',first:'Première page de campagnes',sampleCampaign:'Campagne exemple',sampleOwner:'Responsable exemple'},
};
type Policy={version:number;title:string;body:string;active:boolean;defaults:{title:string;body:string}};
type History={items:{version:number;title:string;body:string;reason:string;created_at:string}[];nextVersion:number|null};
type Scope='GLOBAL'|'BRANCH'|'CAMPAIGN';
export function NotificationTemplates({locale,api,user,branches}:{locale:NotificationLocale;api:NotificationApi;user:{role:'SUPER_ADMIN'|'MANAGER';organizationId:string;branchId:string|null};branches:{id:string;name:string}[]}) {
 const t=words[locale],[scope,setScope]=useState<Scope>('BRANCH'),[branch,setBranch]=useState(user.branchId??branches[0]?.id??''),[campaign,setCampaign]=useState(''),[campaigns,setCampaigns]=useState<{id:string;name:string}[]>([]),[next,setNext]=useState<string|null>(null),[policy,setPolicy]=useState<Policy|null>(null),[history,setHistory]=useState<History|null>(null),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),epoch=useRef(0);
 const [event,setEvent]=useState<'AI_HANDOFF_REQUESTED'|'AI_HANDOFF_SLA_EXCEEDED'|'FOLLOW_UP_DUE'|LeadNotificationEvent|FinancialNotificationEvent>('AI_HANDOFF_REQUESTED');
 const id=scope==='GLOBAL'?user.organizationId:scope==='BRANCH'?branch:campaign,root='/api/notification-templates/'+(event==='AI_HANDOFF_REQUESTED'?'':event+'/')+scope+'/'+id+'/'+locale;
 useEffect(()=>{++epoch.current;setPolicy(null);setHistory(null);setReason('');setError('');setBusy(false);return()=>{++epoch.current;};},[scope,id,locale,event]);
 const campaignEpoch=useRef(0);
 useEffect(()=>{if(scope==='CAMPAIGN')void readCampaigns();return()=>{++campaignEpoch.current;};},[scope,branch]);
 async function readCampaigns(cursor?:string) {
  const n=++campaignEpoch.current;setBusy(true);setCampaign('');setCampaigns([]);setNext(null);setPolicy(null);setHistory(null);setError('');
  try{const page=await api<{items:{id:string;name:string}[];nextCursor:string|null}>('/api/campaigns?limit=20&branchId='+branch+(cursor?'&cursor='+encodeURIComponent(cursor):''));if(n===campaignEpoch.current){setCampaigns(page.items);setNext(page.nextCursor);}}
  catch(e){if(n===campaignEpoch.current)setError(String(e));}finally{if(n===campaignEpoch.current)setBusy(false);}
 }
 async function read() {
  const n=++epoch.current;setPolicy(null);setHistory(null);setError('');setBusy(true);
  try{const p=await api<Policy>(root);if(n===epoch.current){setPolicy(p);setReason('');}}catch(e){if(n===epoch.current)setError(String(e));}finally{if(n===epoch.current)setBusy(false);}
 }
 async function save() {
  if(!policy)return;const n=++epoch.current;setBusy(true);setError('');
  try{await api(root,{method:'PUT',body:JSON.stringify({version:policy.version,title:policy.title,body:policy.body,active:policy.active,reason})});const p=await api<Policy>(root);if(n===epoch.current){setPolicy(p);setReason('');setHistory(null);}}
  catch(e){if(n===epoch.current){setPolicy(null);setHistory(null);setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}
 }
 async function readHistory(older=false) {
  const n=++epoch.current;setBusy(true);setError('');
  try{const h=await api<History>(root+'/history'+(older&&history?.nextVersion?'?before='+history.nextVersion:''));if(n===epoch.current)setHistory(h);}
  catch(e){if(n===epoch.current){setPolicy(null);setHistory(null);setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}
 }
 const preview=(text:string)=>text.replace(/\{\{(campaign|owner)\}\}/g,(_m,key)=>key==='campaign'?t.sampleCampaign:t.sampleOwner);
 return <section className="panel" data-notification-templates style={{minWidth:0,overflowWrap:'anywhere'}}><h3>{t.title}</h3><p>{t.note}</p>
  <label>{{ar:'نوع حدث الإشعار',en:'Notification event',fr:'Événement de notification'}[locale]}<select aria-label={{ar:'نوع حدث الإشعار',en:'Notification event',fr:'Événement de notification'}[locale]} disabled={busy} value={event} onChange={e=>setEvent(e.target.value as typeof event)}><option value="AI_HANDOFF_REQUESTED">{{ar:'طلب التحويل البشري',en:'Human handoff requested',fr:'Transfert humain demandé'}[locale]}</option><option value="AI_HANDOFF_SLA_EXCEEDED">{{ar:'تجاوز مدة الاستجابة',en:'Human response target exceeded',fr:'Délai de réponse dépassé'}[locale]}</option>{leadNotificationEvents.map(k=><option key={k} value={k}>{leadNotificationLabels[locale][k]}</option>)}<option value="FOLLOW_UP_DUE">{followUpNotificationLabel[locale]}</option>{financialNotificationEvents.map(k=><option key={k} value={k}>{financialNotificationLabels[locale][k]}</option>)}</select></label>
  <label>{t.scope}<select aria-label={t.scope} disabled={busy} value={scope} onChange={e=>setScope(e.target.value as Scope)}><option value="BRANCH">{t.branch}</option><option value="CAMPAIGN">{t.campaign}</option>{user.role==='SUPER_ADMIN'&&<option value="GLOBAL">{t.global}</option>}</select></label>
  {scope!=='GLOBAL'&&<label>{t.branch}<select aria-label={t.branch} disabled={busy} value={branch} onChange={e=>setBranch(e.target.value)}>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
  {scope==='CAMPAIGN'&&<><label>{t.resource}<select aria-label={t.resource} disabled={busy} value={campaign} onChange={e=>setCampaign(e.target.value)}><option value="">{t.select}</option>{campaigns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button disabled={busy} onClick={()=>void readCampaigns()}>{t.first}</button>{next&&<button disabled={busy} onClick={()=>void readCampaigns(next!)}>{t.campaigns}</button>}</>}
  <button disabled={busy||!id} onClick={()=>void read()}>{t.load}</button>{error&&<p role="alert">{error}</p>}
  {policy&&<><label><input type="checkbox" disabled={busy} checked={policy.active} onChange={e=>setPolicy({...policy,active:e.target.checked})}/>{t.active}</label>
   <label>{t.subject}<input disabled={busy} value={policy.title} maxLength={160} onChange={e=>setPolicy({...policy,title:e.target.value})}/></label>
   <label>{t.body}<textarea aria-label={t.body} disabled={busy} value={policy.body} maxLength={1000} onChange={e=>setPolicy({...policy,body:e.target.value})} style={{width:'100%',minHeight:'6rem'}}/></label>
   <label>{t.reason}<input disabled={busy} value={reason} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>
   <button disabled={busy||reason.trim().length<3} onClick={()=>void save()}>{t.save}</button><button disabled={busy} onClick={()=>void readHistory()}>{t.history}</button>
   <section data-notification-preview><h4>{t.preview}</h4><p dir="auto">{preview(policy.title)}</p><p dir="auto" style={{whiteSpace:'pre-wrap'}}>{preview(policy.body)}</p></section>
   <h4>{t.defaults}</h4><p dir="auto">{preview(policy.defaults.title)}</p><p dir="auto">{preview(policy.defaults.body)}</p>
   {history?.items.map(h=><article key={h.version}><p>{h.version} · {new Date(h.created_at).toLocaleString(locale)}</p><p dir="auto">{h.title}</p><p dir="auto">{h.body}</p><p dir="auto">{h.reason}</p></article>)}{history?.nextVersion&&<button disabled={busy} onClick={()=>void readHistory(true)}>{t.more}</button>}
  </>}
 </section>;
}
