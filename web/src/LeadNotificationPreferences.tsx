import {useEffect,useRef,useState} from 'react';
import type {NotificationApi,NotificationLocale} from './NotificationCenter.js';
export const leadNotificationEvents=['LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED'] as const;
export type LeadNotificationEvent=typeof leadNotificationEvents[number];
export const leadNotificationLabels={
 ar:{LEAD_CREATED:'فرصة جديدة',LEAD_ASSIGNED:'إسناد فرصة',LEAD_REASSIGNED:'تغيير الإسناد'},
 en:{LEAD_CREATED:'New lead',LEAD_ASSIGNED:'Lead assigned',LEAD_REASSIGNED:'Lead ownership changed'},
 fr:{LEAD_CREATED:'Nouveau prospect',LEAD_ASSIGNED:'Prospect attribué',LEAD_REASSIGNED:'Attribution modifiée'},
};
const words={
 ar:{title:'إشعارات الفرص والإسناد',event:'نوع تفضيل إشعارات الفرص',enabled:'تفعيل هذا الإشعار داخل المنصة',reload:'تحديث تفضيل إشعارات الفرص',save:'حفظ تفضيل إشعارات الفرص',note:'إشعارات داخل المنصة فقط. الكتم يحتفظ بالأحداث وسجل القراءة. الوصول يتبع صلاحيتك الحالية على الفرصة.'},
 en:{title:'Lead and assignment notifications',event:'Lead notification preference event',enabled:'Enable this In-App notification',reload:'Reload lead notification preference',save:'Save lead notification preference',note:'In-App only. Muting retains events and read history. Access follows your current lead permissions.'},
 fr:{title:'Notifications de prospect et d’attribution',event:'Événement de préférence du prospect',enabled:'Activer cette notification dans la plateforme',reload:'Actualiser la préférence du prospect',save:'Enregistrer la préférence du prospect',note:'Dans la plateforme uniquement. Les événements et l’historique restent conservés. L’accès suit vos droits actuels sur le prospect.'},
};
type Preference={enabled:boolean;version:number};
export function LeadNotificationPreferences({api,locale,userId,onChanged}:{api:NotificationApi;locale:NotificationLocale;userId:string;onChanged:()=>void}){
 const t=words[locale],[event,setEvent]=useState<LeadNotificationEvent>('LEAD_CREATED'),[value,setValue]=useState<Preference|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),epoch=useRef(0),root='/api/notification-preferences/'+event;
 useEffect(()=>{void read();return()=>{++epoch.current;};},[locale,userId,event]);
 async function read(){const n=++epoch.current;setValue(null);setError('');setBusy(true);try{const r=await api<Preference>(root);if(n===epoch.current)setValue(r);}catch(e){if(n===epoch.current)setError(String(e));}finally{if(n===epoch.current)setBusy(false);}}
 async function save(){if(!value)return;const n=++epoch.current;setBusy(true);setError('');try{await api(root,{method:'PUT',body:JSON.stringify({version:value.version,enabled:value.enabled})});const r=await api<Preference>(root);if(n===epoch.current){setValue(r);onChanged();}}catch(e){if(n===epoch.current){setValue(null);setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}}
 return <fieldset data-lead-notification-preferences style={{minWidth:0}}><legend>{t.title}</legend><p>{t.note}</p>
  <label>{t.event}<select aria-label={t.event} disabled={busy} value={event} onChange={e=>setEvent(e.target.value as LeadNotificationEvent)}>{leadNotificationEvents.map(k=><option key={k} value={k}>{leadNotificationLabels[locale][k]}</option>)}</select></label>
  <button disabled={busy} onClick={()=>void read()}>{t.reload}</button>{error&&<p role="alert">{error}</p>}{value&&<>
   <label><input type="checkbox" aria-label={t.enabled} disabled={busy} checked={value.enabled} onChange={e=>setValue({...value,enabled:e.target.checked})}/>{t.enabled}</label>
   <button disabled={busy} onClick={()=>void save()}>{t.save}</button></>}
 </fieldset>;
}
