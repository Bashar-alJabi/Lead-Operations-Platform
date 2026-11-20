import {useEffect,useRef,useState} from 'react';
import type {NotificationApi,NotificationLocale} from './NotificationCenter.js';
const words={
 ar:{title:'قائمة بريد الإشعارات الشخصية',note:'تظهر هنا إشعارات حسابك التي جرى تجهيزها للبريد وما زلت مخولًا بفتح فرصها. الانتظار لا يثبت قبول البريد أو وصوله. التفعيل لا يعيد إرسال الأحداث السابقة.',refresh:'تحديث قائمة البريد',older:'إشعارات بريد أقدم',empty:'لا رسائل بريد في هذه الصفحة.',waiting:'بانتظار الإرسال',language:'لغة الإرسال',version:'إصدار التفضيل'},
 en:{title:'Your notification email queue',note:'Email prepared for your account is shown while you retain access to its lead. Queued does not mean accepted or delivered. Activation does not resend previous events.',refresh:'Refresh email queue',older:'Older queued emails',empty:'No emails on this page.',waiting:'Waiting to send',language:'Delivery language',version:'Preference version'},
 fr:{title:'Votre file d’e-mails de notification',note:'Les e-mails préparés pour votre compte restent visibles si vous avez accès au prospect. En attente ne signifie ni accepté ni livré. L’activation ne renvoie pas les événements précédents.',refresh:'Actualiser la file e-mail',older:'E-mails précédents',empty:'Aucun e-mail sur cette page.',waiting:'En attente d’envoi',language:'Langue d’envoi',version:'Version de préférence'},
};
const states = {
 ar:{WAITING:'بانتظار الإرسال',SENDING:'قيد الإرسال',ACCEPTED:'قبله مزوّد البريد',UNKNOWN:'نتيجة الإرسال غير معروفة',SUPPRESSED:'توقف بسبب تغيّر الإعدادات أو الصلاحية',DEAD_LETTER:'تعذّر تجهيز البريد للإرسال'},
 en:{WAITING:'Waiting to send',SENDING:'Sending',ACCEPTED:'Accepted by mail provider',UNKNOWN:'Send outcome unknown',SUPPRESSED:'Stopped after settings or access changed',DEAD_LETTER:'Could not prepare email for sending'},
 fr:{WAITING:'En attente d’envoi',SENDING:'Envoi en cours',ACCEPTED:'Accepté par le fournisseur',UNKNOWN:'Résultat d’envoi inconnu',SUPPRESSED:'Arrêt après modification des réglages ou de l’accès',DEAD_LETTER:'Préparation de l’e-mail impossible'},
};
const actions = {
 ar:{retry:'إعادة التجهيز',history:'آخر تغيّرات الحالة',pages:'دفعات تجهيز تحتاج مراجعة',unknown:'راجع مزوّد البريد للتحقق من النتيجة. إعادة الإرسال معطلة لهذه المحاولة.'},
 en:{retry:'Retry preparation',history:'Recent status changes',pages:'Preparation batches needing review',unknown:'Check the mail provider for the outcome. Resending is disabled for this attempt.'},
 fr:{retry:'Relancer la préparation',history:'Derniers changements d’état',pages:'Lots de préparation à examiner',unknown:'Vérifiez le résultat auprès du fournisseur. Le renvoi est désactivé pour cette tentative.'},
};
type State = keyof typeof states.en;
type Change = {state:State;version:number;changedAt:string};
type Item = Change & {id:string;eventType:string;language:NotificationLocale;preferenceVersion:number;createdAt:string;history:Change[]};
type Feed = {items:Item[];nextCursor:string|null};
type PageFailure = {id:string;version:number;eventType:string;changedAt:string};
export function EmailNotificationOutbox({locale,api,userId,eventLabel,canManage}:{locale:NotificationLocale;api:NotificationApi;userId:string;eventLabel:(event:string,locale:NotificationLocale)=>string;canManage:boolean}){
 const t=words[locale],labels=states[locale],a=actions[locale],epoch=useRef(0);
 const [data,setData]=useState<Feed|null>(null),[failures,setFailures]=useState<PageFailure[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{void read();return()=>{++epoch.current;};},[locale,userId]);
 async function read(cursor?:string){
  const n=++epoch.current;setData(null);setFailures([]);setError('');setBusy(true);
  try{
   const [feed,pages]=await Promise.all([
    api<Feed>('/api/notification-email/deliveries'+(cursor?'?cursor='+encodeURIComponent(cursor):'')),
    canManage?api<{items:PageFailure[]}>('/api/notification-email/page-failures'):null,
   ]);
   if(n===epoch.current){setData(feed);setFailures(pages?.items??[]);}
  }catch(e){if(n===epoch.current)setError(String(e));}
  finally{if(n===epoch.current)setBusy(false);}
 }
 async function retry(resource:'deliveries'|'page-failures',id:string,version:number){
  const n=++epoch.current;setData(null);setFailures([]);setError('');setBusy(true);
  try{
   await api('/api/notification-email/'+resource+'/'+id+'/retry',{method:'POST',body:JSON.stringify({version})});
   if(n===epoch.current)await read();
  }catch(e){if(n===epoch.current)setError(String(e));}
  finally{if(n===epoch.current)setBusy(false);}
 }
 return <section className="panel" data-email-outbox style={{minInlineSize:0,overflowWrap:'anywhere'}}><h3>{t.title}</h3><p>{t.note}</p>
  <button disabled={busy} onClick={()=>void read()}>{t.refresh}</button>{error&&<p role="alert">{error}</p>}
  {data&&<div data-email-outbox-detail>{!data.items.length&&<p>{t.empty}</p>}{data.items.map(item=><article key={item.id} data-email-outbox-item={item.id}>
   <h4>{eventLabel(item.eventType,locale)}</h4><p>{labels[item.state]} · {t.language}: {item.language}</p>
   <time dateTime={item.changedAt}>{new Date(item.changedAt).toLocaleString(locale)}</time>
   {item.state==='UNKNOWN'&&<p>{a.unknown}</p>}
   {item.state==='DEAD_LETTER'&&<button disabled={busy} onClick={()=>void retry('deliveries',item.id,item.version)}>{a.retry}</button>}
   {item.history.length>0&&<details><summary>{a.history}</summary><ul>{item.history.map(change=><li key={change.version}>
    {labels[change.state]} · <time dateTime={change.changedAt}>{new Date(change.changedAt).toLocaleString(locale)}</time>
   </li>)}</ul></details>}
  </article>)}{data.nextCursor&&<button disabled={busy} onClick={()=>void read(data.nextCursor!)}>{t.older}</button>}</div>}
 {canManage&&failures.length>0&&<section data-email-page-failures><h4>{a.pages}</h4><ul>{failures.map(failure=><li key={failure.id}>
  {eventLabel(failure.eventType,locale)} · <time dateTime={failure.changedAt}>{new Date(failure.changedAt).toLocaleString(locale)}</time>{' '}
  <button disabled={busy} onClick={()=>void retry('page-failures',failure.id,failure.version)}>{a.retry}</button>
 </li>)}</ul></section>}
 </section>;
}
