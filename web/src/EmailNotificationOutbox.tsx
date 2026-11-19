import {useEffect,useRef,useState} from 'react';
import type {NotificationApi,NotificationLocale} from './NotificationCenter.js';
const words={
 ar:{title:'قائمة بريد الإشعارات الشخصية',note:'تظهر هنا إشعارات حسابك التي جرى تجهيزها للبريد وما زلت مخولًا بفتح فرصها. الانتظار لا يثبت قبول البريد أو وصوله. التفعيل لا يعيد إرسال الأحداث السابقة.',refresh:'تحديث قائمة البريد',older:'إشعارات بريد أقدم',empty:'لا رسائل بريد في هذه الصفحة.',waiting:'بانتظار الإرسال',language:'لغة الإرسال',version:'إصدار التفضيل'},
 en:{title:'Your notification email queue',note:'Email prepared for your account is shown while you retain access to its lead. Queued does not mean accepted or delivered. Activation does not resend previous events.',refresh:'Refresh email queue',older:'Older queued emails',empty:'No emails on this page.',waiting:'Waiting to send',language:'Delivery language',version:'Preference version'},
 fr:{title:'Votre file d’e-mails de notification',note:'Les e-mails préparés pour votre compte restent visibles si vous avez accès au prospect. En attente ne signifie ni accepté ni livré. L’activation ne renvoie pas les événements précédents.',refresh:'Actualiser la file e-mail',older:'E-mails précédents',empty:'Aucun e-mail sur cette page.',waiting:'En attente d’envoi',language:'Langue d’envoi',version:'Version de préférence'},
};
type Feed={items:{id:string;state:'WAITING';eventType:string;language:NotificationLocale;preferenceVersion:number;createdAt:string;leadId:string}[];nextCursor:string|null};
export function EmailNotificationOutbox({locale,api,userId,eventLabel}:{locale:NotificationLocale;api:NotificationApi;userId:string;eventLabel:(event:string,locale:NotificationLocale)=>string}){
 const t=words[locale],epoch=useRef(0),[data,setData]=useState<Feed|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{void read();return()=>{++epoch.current;};},[locale,userId]);
 async function read(cursor?:string){const n=++epoch.current;setData(null);setError('');setBusy(true);try{
  const d=await api<Feed>('/api/notification-email/deliveries'+(cursor?'?cursor='+encodeURIComponent(cursor):''));if(n===epoch.current)setData(d);
 }catch(e){if(n===epoch.current)setError(String(e));}finally{if(n===epoch.current)setBusy(false);}}
 return <section className="panel" data-email-outbox style={{minInlineSize:0,overflowWrap:'anywhere'}}><h3>{t.title}</h3><p>{t.note}</p>
  <button disabled={busy} onClick={()=>void read()}>{t.refresh}</button>{error&&<p role="alert">{error}</p>}
  {data&&<div data-email-outbox-detail>{!data.items.length&&<p>{t.empty}</p>}{data.items.map(item=><article key={item.id} data-email-outbox-item={item.id}>
   <h4>{eventLabel(item.eventType,locale)}</h4><p>{t.waiting} · {t.language}: {item.language} · {t.version}: {item.preferenceVersion}</p>
   <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(locale)}</time>
  </article>)}{data.nextCursor&&<button disabled={busy} onClick={()=>void read(data.nextCursor!)}>{t.older}</button>}</div>}
 </section>;
}
