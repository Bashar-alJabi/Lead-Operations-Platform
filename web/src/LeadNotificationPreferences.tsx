import {useEffect,useRef,useState} from 'react';
import type {NotificationApi,NotificationLocale} from './NotificationCenter.js';
export const leadNotificationEvents=['LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED'] as const;
export type LeadNotificationEvent=typeof leadNotificationEvents[number];
export const financialNotificationEvents=['PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED'] as const;
export type FinancialNotificationEvent=typeof financialNotificationEvents[number];
export const financialNotificationLabels={ar:{PAYMENT_CONFIRMED:'تأكيد دفع',ENROLLMENT_CONFIRMED:'تأكيد تسجيل'},en:{PAYMENT_CONFIRMED:'Payment confirmed',ENROLLMENT_CONFIRMED:'Enrollment confirmed'},fr:{PAYMENT_CONFIRMED:'Paiement confirmé',ENROLLMENT_CONFIRMED:'Inscription confirmée'}};
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
const financialWords={
 ar:{...words.ar,title:'إشعارات الدفع والتسجيل',event:'نوع تفضيل الإشعارات المالية',reload:'تحديث تفضيل الإشعارات المالية',save:'حفظ تفضيل الإشعارات المالية'},
 en:{...words.en,title:'Payment and enrollment notifications',event:'Financial notification preference event',reload:'Reload financial notification preference',save:'Save financial notification preference'},
 fr:{...words.fr,title:'Notifications de paiement et d’inscription',event:'Événement de préférence financière',reload:'Actualiser la préférence financière',save:'Enregistrer la préférence financière'},
};
// Both groups share the same strictly typed backend preference contract and failure clearing.
export function LeadNotificationPreferences({api,locale,userId,onChanged,financial=false}:{api:NotificationApi;locale:NotificationLocale;userId:string;onChanged:()=>void;financial?:boolean}){
 const t=(financial?financialWords:words)[locale],events=financial?financialNotificationEvents:leadNotificationEvents,labels={...leadNotificationLabels[locale],...financialNotificationLabels[locale]},[event,setEvent]=useState<LeadNotificationEvent|FinancialNotificationEvent>(financial?'PAYMENT_CONFIRMED':'LEAD_CREATED'),[value,setValue]=useState<Preference|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),epoch=useRef(0),root='/api/notification-preferences/'+event;
 useEffect(()=>{void read();return()=>{++epoch.current;};},[locale,userId,event]);
 async function read(){const n=++epoch.current;setValue(null);setError('');setBusy(true);try{const r=await api<Preference>(root);if(n===epoch.current)setValue(r);}catch(e){if(n===epoch.current)setError(String(e));}finally{if(n===epoch.current)setBusy(false);}}
 async function save(){if(!value)return;const n=++epoch.current;setBusy(true);setError('');try{await api(root,{method:'PUT',body:JSON.stringify({version:value.version,enabled:value.enabled})});const r=await api<Preference>(root);if(n===epoch.current){setValue(r);onChanged();}}catch(e){if(n===epoch.current){setValue(null);setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}}
 return <fieldset {...(financial?{'data-financial-notification-preferences':true}:{'data-lead-notification-preferences':true})} style={{minWidth:0}}><legend>{t.title}</legend><p>{t.note}</p>
  <label>{t.event}<select aria-label={t.event} disabled={busy} value={event} onChange={e=>setEvent(e.target.value as LeadNotificationEvent|FinancialNotificationEvent)}>{events.map(k=><option key={k} value={k}>{labels[k]}</option>)}</select></label>
  <button disabled={busy} onClick={()=>void read()}>{t.reload}</button>{error&&<p role="alert">{error}</p>}{value&&<>
   <label><input type="checkbox" aria-label={t.enabled} disabled={busy} checked={value.enabled} onChange={e=>setValue({...value,enabled:e.target.checked})}/>{t.enabled}</label>
   <button disabled={busy} onClick={()=>void save()}>{t.save}</button></>}
 </fieldset>;
}
