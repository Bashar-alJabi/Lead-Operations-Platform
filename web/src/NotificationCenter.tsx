import {useEffect,useRef,useState} from 'react';
import {NotificationTemplates} from './NotificationTemplates.js';
import {SLANotificationPreference} from './SLANotificationPreference.js';
export type NotificationApi=<T>(path:string,options?:RequestInit)=>Promise<T>;
export type NotificationLocale='ar'|'en'|'fr';
const words={
 en:{title:'Notifications',refresh:'Refresh notifications',more:'Older notifications',empty:'No notifications on this page.',unread:'Unread only',read:'Mark read',markUnread:'Mark unread',open:'Open Lead',history:'Read status history',waiting:'Waiting for human acceptance',past:'Historical handoff request',preferences:'Notification preferences',enabled:'In-App human handoff notifications',save:'Save notification preference',note:'Preferences affect your notification center. Events and read status are retained. The waiting handoff queue remains available. Reassignment immediately removes access for the previous owner.',version:'Version',readStatus:'Read',unreadStatus:'Unread'},
 ar:{title:'الإشعارات',refresh:'تحديث الإشعارات',more:'إشعارات أقدم',empty:'لا إشعارات في هذه الصفحة.',unread:'غير المقروءة فقط',read:'تحديد كمقروء',markUnread:'تحديد كغير مقروء',open:'فتح الفرصة',history:'سجل حالة القراءة',waiting:'بانتظار قبول موظف',past:'طلب تحويل بشري سابق',preferences:'تفضيلات الإشعارات',enabled:'إشعارات التحويل البشري داخل المنصة',save:'حفظ تفضيل الإشعارات',note:'تؤثر التفضيلات على مركز إشعاراتك. تُحفظ الأحداث وحالة القراءة، وتبقى قائمة التحويل البشري متاحة. إعادة الإسناد تزيل الوصول من المالك السابق فورًا.',version:'الإصدار',readStatus:'مقروء',unreadStatus:'غير مقروء'},
 fr:{title:'Notifications',refresh:'Actualiser les notifications',more:'Notifications précédentes',empty:'Aucune notification sur cette page.',unread:'Non lues uniquement',read:'Marquer comme lue',markUnread:'Marquer comme non lue',open:'Ouvrir le prospect',history:'Historique de lecture',waiting:'En attente de prise en charge humaine',past:'Demande de transfert précédente',preferences:'Préférences de notification',enabled:'Notifications de transfert humain dans la plateforme',save:'Enregistrer la préférence',note:'Les préférences affectent votre centre de notifications. Les événements et les états de lecture sont conservés. La file de transfert reste disponible. La réattribution retire immédiatement l’accès du propriétaire précédent.',version:'Version',readStatus:'Lue',unreadStatus:'Non lue'},
};
type Item={id:string;eventType:string;leadId:string;createdAt:string;version:number;isRead:boolean;waiting:boolean;title:string;body:string};
type Feed={items:Item[];nextCursor:string|null};
type Preference={enabled:boolean;version:number};
type History={items:{version:number;is_read:boolean;created_at:string}[];nextVersion:number|null};
export function NotificationCenter({locale,api,user,branches,onOpenLead,onChanged}:{locale:NotificationLocale;api:NotificationApi;user:{id:string;role:'SUPER_ADMIN'|'MANAGER'|'AGENT';organizationId:string;branchId:string|null};branches:{id:string;name:string}[];onOpenLead:(id:string)=>void;onChanged:()=>void}) {
 const t=words[locale],[feed,setFeed]=useState<Feed|null>(null),[pref,setPref]=useState<Preference|null>(null),[unreadOnly,setUnreadOnly]=useState(false),[history,setHistory]=useState<History|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),epoch=useRef(0);
 useEffect(()=>{void read();return()=>{++epoch.current;};},[locale,user.id,unreadOnly]);
 async function read(cursor?:string) {
  const n=++epoch.current;setFeed(null);setPref(null);setHistory(null);setError('');setBusy(true);
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
   <p>{item.isRead?t.readStatus:t.unreadStatus} · {item.waiting?t.waiting:item.eventType==='AI_HANDOFF_SLA_EXCEEDED'?{ar:'تنبيه استجابة سابق',en:'Historical response alert',fr:'Alerte de réponse historique'}[locale]:t.past}</p>
   <button disabled={busy} onClick={()=>void change('/api/notifications/'+item.id+'/state',{version:item.version,isRead:!item.isRead})}>{item.isRead?t.markUnread:t.read}</button>
   <button disabled={busy} onClick={()=>onOpenLead(item.leadId)}>{t.open}</button><button disabled={busy} onClick={()=>void readHistory(item.id)}>{t.history}</button>
  </article>)}{feed.nextCursor&&<button disabled={busy} onClick={()=>void read(feed.nextCursor!)}>{t.more}</button>}</>}
  {history&&<section data-notification-history><h3>{t.history}</h3>{history.items.map(h=><p key={h.version}>{t.version} {h.version} · {h.is_read?t.readStatus:t.unreadStatus} · {new Date(h.created_at).toLocaleString(locale)}</p>)}</section>}
  {pref&&<fieldset data-notification-preferences style={{minWidth:0}}><legend>{t.preferences}</legend><p>{t.note}</p><label><input type="checkbox" disabled={busy} checked={pref.enabled} onChange={e=>setPref({...pref,enabled:e.target.checked})}/>{t.enabled}</label>
   <button disabled={busy} onClick={()=>void change('/api/notification-preferences',{version:pref.version,enabled:pref.enabled})}>{t.save}</button></fieldset>}
  {user.role!=='AGENT'&&<NotificationTemplates locale={locale} api={api} user={{...user,role:user.role}} branches={branches}/>}
  <SLANotificationPreference locale={locale} api={api} userId={user.id} onChanged={()=>{onChanged();void read();}}/>
 </section>;
}
