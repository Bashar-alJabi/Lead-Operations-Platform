import {useEffect,useRef,useState} from 'react';
import {NotificationTemplates} from './NotificationTemplates.js';
import {SLANotificationPreference} from './SLANotificationPreference.js';
import {LeadNotificationPreferences} from './LeadNotificationPreferences.js';
import {FollowUpNotificationPreference} from './FollowUpNotifications.js';
import {attentionReasonLabel} from './notification-attention.js';
import {EmailNotificationSettings} from './EmailNotificationSettings.js';
import {LeadAttentionFailures} from './LeadAttentionFailures.js';
import {MessagingInboundReview} from './MessagingInboundReview.js';
import {OperationalNotificationControls,operationalConditionLabels} from './OperationalNotificationControls.js';
import {StaffMessagingConfiguration} from './StaffMessagingConfiguration.js';
export type NotificationApi=<T>(path:string,options?:RequestInit)=>Promise<T>;
export type NotificationLocale='ar'|'en'|'fr';
const words={
 en:{title:'Notifications',refresh:'Refresh notifications',more:'Older notifications',empty:'No notifications on this page.',unread:'Unread only',read:'Mark read',markUnread:'Mark unread',open:'Open Lead',history:'Read status history',waiting:'Waiting for human acceptance',past:'Historical handoff request',preferences:'Notification preferences',enabled:'In-App human handoff notifications',save:'Save notification preference',note:'Preferences affect your notification center. Events and read status are retained. The waiting handoff queue remains available. Reassignment immediately removes access for the previous owner.',version:'Version',readStatus:'Read',unreadStatus:'Unread'},
 ar:{title:'الإشعارات',refresh:'تحديث الإشعارات',more:'إشعارات أقدم',empty:'لا إشعارات في هذه الصفحة.',unread:'غير المقروءة فقط',read:'تحديد كمقروء',markUnread:'تحديد كغير مقروء',open:'فتح الفرصة',history:'سجل حالة القراءة',waiting:'بانتظار قبول موظف',past:'طلب تحويل بشري سابق',preferences:'تفضيلات الإشعارات',enabled:'إشعارات التحويل البشري داخل المنصة',save:'حفظ تفضيل الإشعارات',note:'تؤثر التفضيلات على مركز إشعاراتك. تُحفظ الأحداث وحالة القراءة، وتبقى قائمة التحويل البشري متاحة. إعادة الإسناد تزيل الوصول من المالك السابق فورًا.',version:'الإصدار',readStatus:'مقروء',unreadStatus:'غير مقروء'},
 fr:{title:'Notifications',refresh:'Actualiser les notifications',more:'Notifications précédentes',empty:'Aucune notification sur cette page.',unread:'Non lues uniquement',read:'Marquer comme lue',markUnread:'Marquer comme non lue',open:'Ouvrir le prospect',history:'Historique de lecture',waiting:'En attente de prise en charge humaine',past:'Demande de transfert précédente',preferences:'Préférences de notification',enabled:'Notifications de transfert humain dans la plateforme',save:'Enregistrer la préférence',note:'Les préférences affectent votre centre de notifications. Les événements et les états de lecture sont conservés. La file de transfert reste disponible. La réattribution retire immédiatement l’accès du propriétaire précédent.',version:'Version',readStatus:'Lue',unreadStatus:'Non lue'},
};
type Item={automation:{id:string;ruleId:string;ruleVersion:number;name:string;note:string}|null;id:string;eventType:string;leadId:string|null;createdAt:string;version:number;isRead:boolean;waiting:boolean;title:string;body:string;attention:{id:string;reasonCode:string;currentlyNeedsAttention:boolean}|null;followUp:{id:string;observedDueAt:string;currentDueAt:string;status:'OPEN'|'COMPLETED'|'CANCELLED';currentlyDue:boolean}|null;operational:{
 condition:keyof typeof operationalConditionLabels.en;current:boolean;connectionId:string|null;inboundEventId:string|null;integrationKind:string|null;integrationName:string|null;
}|null};
type Feed={items:Item[];nextCursor:string|null};
type Preference={enabled:boolean;version:number};
type History={items:{version:number;is_read:boolean;created_at:string}[];nextVersion:number|null};
export const integrationPages={META:'metaSources',MESSAGING:'messagingSetup',PAYMENT:'paymentSetup',EMAIL:'emailSetup',AI:'aiSetup',GOOGLE:'googleSetup'} as const;
type IntegrationKind=keyof typeof integrationPages;
export function NotificationCenter({locale,api,user,branches,onOpenLead,onOpenIntegration,onChanged}:{locale:NotificationLocale;api:NotificationApi;user:{id:string;role:'SUPER_ADMIN'|'MANAGER'|'AGENT';organizationId:string;branchId:string|null};branches:{id:string;name:string}[];onOpenLead:(id:string)=>void;onOpenIntegration:(kind:IntegrationKind)=>void;onChanged:()=>void}) {
 const t=words[locale],[feed,setFeed]=useState<Feed|null>(null),[pref,setPref]=useState<Preference|null>(null),[unreadOnly,setUnreadOnly]=useState(false),[history,setHistory]=useState<History|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),epoch=useRef(0);
 const [review,setReview]=useState<string|null>(null);
 const operationalWords={
  ar:{current:'تحتاج مراجعة',historical:'تنبيه سابق',review:'فتح مراجعة الرسالة',integration:'فتح إعدادات الاتصال',recover:'عرض تنبيهات الفرص المتعثرة'},
  en:{current:'Needs attention',historical:'Historical alert',review:'Open inbound review',integration:'Open integration settings',recover:'Show failed Lead alerts'},
  fr:{current:'À examiner',historical:'Alerte historique',review:'Ouvrir la révision entrante',integration:'Ouvrir les paramètres d’intégration',recover:'Afficher les alertes prospect en échec'},
 }[locale];
 useEffect(()=>{void read();return()=>{++epoch.current;};},[locale,user.id,unreadOnly]);
 async function read(cursor?:string) {
  const n=++epoch.current;setFeed(null);setPref(null);setHistory(null);setReview(null);setError('');setBusy(true);
  try{const [f,p]=await Promise.all([api<Feed>('/api/notifications?language='+locale+'&unreadOnly='+unreadOnly+(cursor?'&cursor='+encodeURIComponent(cursor):'')),api<Preference>('/api/notification-preferences')]);if(n===epoch.current){setFeed(f);setPref(p);}}
  catch(e){if(n===epoch.current)setError(String(e));}finally{if(n===epoch.current)setBusy(false);}
 }
 async function change(path:string,body:object) {
  const n=++epoch.current;setError('');setBusy(true);
  try{await api(path,{method:'PUT',body:JSON.stringify(body)});if(n===epoch.current){onChanged();await read();}}
  catch(e){if(n===epoch.current){setFeed(null);setPref(null);setHistory(null);setError(String(e));setBusy(false);}}
 }
 async function readHistory(id:string) {
  const n=++epoch.current;setHistory(null);setError('');setBusy(true);
  try{const h=await api<History>('/api/notifications/'+id+'/history');if(n===epoch.current)setHistory(h);}
  catch(e){if(n===epoch.current){setFeed(null);setPref(null);setHistory(null);setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}
 }
 return <section className="panel" data-notification-center><h2>{t.title}</h2><button disabled={busy} onClick={()=>void read()}>{t.refresh}</button>
  <label><input type="checkbox" checked={unreadOnly} disabled={busy} onChange={e=>setUnreadOnly(e.target.checked)}/>{t.unread}</label>
  {error&&<p role="alert">{error}</p>}{feed&&<>{!feed.items.length&&<p>{t.empty}</p>}{feed.items.map(item=><article className="panel" key={item.id} data-notification={item.id} style={{minWidth:0,overflowWrap:'anywhere'}}>
   <h3 dir="auto">{item.title}</h3><p dir="auto" style={{whiteSpace:'pre-wrap'}}>{item.body}</p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(locale)}</time>
   {item.operational&&<div data-operational-alert>
    <p>{item.operational.current?operationalWords.current:operationalWords.historical} · {operationalConditionLabels[locale][item.operational.condition]} {item.operational.integrationName&&<>· <bdi>{item.operational.integrationName}</bdi></>}</p>
    {item.operational.current&&item.operational.inboundEventId&&item.operational.connectionId&&
     <button disabled={busy} onClick={()=>setReview(review===item.id?null:item.id)}>{operationalWords.review}</button>}
    {review===item.id&&item.operational.inboundEventId&&item.operational.connectionId&&
     <MessagingInboundReview key={item.operational.inboundEventId} connectionId={item.operational.connectionId} initialEventId={item.operational.inboundEventId} locale={locale} api={api}/>}
    {item.eventType==='INTEGRATION_ALERT'&&item.operational.integrationKind&&Object.hasOwn(integrationPages,item.operational.integrationKind)&&
     <button disabled={busy} onClick={()=>onOpenIntegration(item.operational!.integrationKind as IntegrationKind)}>{operationalWords.integration}</button>}
    {item.eventType==='SYSTEM_ALERT'&&item.operational.current&&
     <button onClick={()=>document.getElementById('lead-attention-recovery')?.scrollIntoView()}>{operationalWords.recover}</button>}
   </div>}
   {item.attention&&<p data-conversation-attention={item.eventType==='CONVERSATION_NEEDS_ATTENTION'?true:undefined} data-lead-attention={item.eventType==='LEAD_NEEDS_ATTENTION'?true:undefined}>
    <strong>{item.attention.currentlyNeedsAttention
      ?item.eventType==='LEAD_NEEDS_ATTENTION'?{ar:'الفرصة تحتاج مراجعة حاليًا',en:'Lead still needs review',fr:'Le prospect reste à examiner'}[locale]
       :{ar:'المحادثة تحتاج مراجعة حاليًا',en:'Conversation still needs review',fr:'La conversation reste à examiner'}[locale]
      :{ar:'تنبيه مراجعة سابق؛ راجع الحالة الحالية',en:'Historical review notice; check the current state',fr:'Notification historique ; vérifiez l’état actuel'}[locale]}
    </strong> · {attentionReasonLabel(item.attention.reasonCode,locale)}</p>}
   <p>{item.isRead?t.readStatus:t.unreadStatus}{!item.operational&&<> · {item.attention?{ar:'حدث مراجعة محفوظ',en:'Recorded review event',fr:'Événement de vérification enregistré'}[locale]:item.eventType==='FOLLOW_UP_DUE'?item.followUp?.currentlyDue?{ar:'متابعة مستحقة حاليًا',en:'Currently due follow-up',fr:'Suivi actuellement arrivé à échéance'}[locale]:{ar:'تنبيه استحقاق سابق؛ راجع حالة المهمة الحالية',en:'Historical due notice; check the current task',fr:'Notification d’échéance historique ; vérifiez la tâche actuelle'}[locale]:(item.eventType.startsWith('LEAD_')||item.eventType==='PAYMENT_CONFIRMED'||item.eventType==='ENROLLMENT_CONFIRMED'||item.eventType==='AUTOMATION_NOTICE')?{ar:'حدث تشغيلي محفوظ',en:'Recorded operational event',fr:'Événement opérationnel enregistré'}[locale]:item.waiting?t.waiting:item.eventType==='AI_HANDOFF_SLA_EXCEEDED'?{ar:'تنبيه استجابة سابق',en:'Historical response alert',fr:'Alerte de réponse historique'}[locale]:t.past}</>}</p>
   {item.automation&&<p data-automation-notice>{item.automation.name} · {t.version} {item.automation.ruleVersion}<br/>{item.automation.note}</p>}
   {item.followUp&&<p>{{ar:'الموعد المرصود',en:'Observed due time',fr:'Échéance observée'}[locale]}: {new Date(item.followUp.observedDueAt).toLocaleString(locale)} · {{ar:'الموعد الحالي',en:'Current due time',fr:'Échéance actuelle'}[locale]}: {new Date(item.followUp.currentDueAt).toLocaleString(locale)} · {{OPEN:{ar:'مفتوحة',en:'Open',fr:'Ouverte'},COMPLETED:{ar:'مكتملة',en:'Completed',fr:'Terminée'},CANCELLED:{ar:'ملغاة',en:'Cancelled',fr:'Annulée'}}[item.followUp.status]?.[locale]}</p>}
   <button disabled={busy} onClick={()=>void change('/api/notifications/'+item.id+'/state',{version:item.version,isRead:!item.isRead})}>{item.isRead?t.markUnread:t.read}</button>
   {item.leadId&&<button disabled={busy} onClick={()=>onOpenLead(item.leadId!)}>{t.open}</button>}<button disabled={busy} onClick={()=>void readHistory(item.id)}>{t.history}</button>
  </article>)}{feed.nextCursor&&<button disabled={busy} onClick={()=>void read(feed.nextCursor!)}>{t.more}</button>}</>}
  {history&&<section data-notification-history><h3>{t.history}</h3>{history.items.map(h=><p key={h.version}>{t.version} {h.version} · {h.is_read?t.readStatus:t.unreadStatus} · {new Date(h.created_at).toLocaleString(locale)}</p>)}</section>}
  {pref&&<fieldset data-notification-preferences style={{minWidth:0}}><legend>{t.preferences}</legend><p>{t.note}</p><label><input type="checkbox" disabled={busy} checked={pref.enabled} onChange={e=>setPref({...pref,enabled:e.target.checked})}/>{t.enabled}</label>
   <button disabled={busy} onClick={()=>void change('/api/notification-preferences',{version:pref.version,enabled:pref.enabled})}>{t.save}</button></fieldset>}
  {user.role!=='AGENT'&&<NotificationTemplates locale={locale} api={api} user={{...user,role:user.role}} branches={branches}/>}
  <SLANotificationPreference locale={locale} api={api} userId={user.id} onChanged={()=>{onChanged();void read();}}/>
  <LeadNotificationPreferences locale={locale} api={api} userId={user.id} onChanged={()=>{onChanged();void read();}}/>
  <FollowUpNotificationPreference locale={locale} api={api} userId={user.id} onChanged={()=>{onChanged();void read();}}/>
  <LeadNotificationPreferences financial locale={locale} api={api} userId={user.id} onChanged={()=>{onChanged();void read();}}/>
  {user.role!=='AGENT'&&<LeadAttentionFailures locale={locale} api={api} userId={user.id} openLead={onOpenLead}/>}
  {user.role!=='AGENT'&&<OperationalNotificationControls locale={locale} api={api} onChanged={()=>{onChanged();void read();}}/>}
  <EmailNotificationSettings locale={locale} api={api} user={user} branches={branches}/>
  <StaffMessagingConfiguration locale={locale} api={api} user={user} branches={branches}/>
 </section>;
}
