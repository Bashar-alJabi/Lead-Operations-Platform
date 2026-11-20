import {useEffect,useState} from 'react';
import type {NotificationApi,NotificationLocale} from './NotificationCenter.js';

export const operationalEventTypes=['INBOUND_REVIEW_REQUIRED','INTEGRATION_ALERT','SYSTEM_ALERT'] as const;
export const operationalEventLabels={
 ar:{INBOUND_REVIEW_REQUIRED:'مراجعة رسالة واردة',INTEGRATION_ALERT:'تنبيه اتصال',SYSTEM_ALERT:'تنبيه النظام'},
 en:{INBOUND_REVIEW_REQUIRED:'Inbound review',INTEGRATION_ALERT:'Integration alert',SYSTEM_ALERT:'System alert'},
 fr:{INBOUND_REVIEW_REQUIRED:'Révision entrante',INTEGRATION_ALERT:'Alerte d’intégration',SYSTEM_ALERT:'Alerte système'},
};
export const operationalConditionLabels={
 ar:{UNRESOLVED:'رسالة تحتاج مراجعة',ERROR:'خطأ في الاتصال',WARNING:'تحذير في الاتصال',DISCONNECTED:'الاتصال منقطع',AUTH_EXPIRED:'انتهت صلاحية المصادقة',LEAD_NOTIFICATION_FAILED:'تعذّر تجهيز تنبيه فرصة'},
 en:{UNRESOLVED:'Message needs review',ERROR:'Connection error',WARNING:'Connection warning',DISCONNECTED:'Disconnected',AUTH_EXPIRED:'Authorization expired',LEAD_NOTIFICATION_FAILED:'Lead alert preparation failed'},
 fr:{UNRESOLVED:'Message à examiner',ERROR:'Erreur de connexion',WARNING:'Avertissement de connexion',DISCONNECTED:'Connexion interrompue',AUTH_EXPIRED:'Autorisation expirée',LEAD_NOTIFICATION_FAILED:'Échec de la préparation d’une alerte prospect'},
};
const words={
 ar:{title:'تفضيلات التنبيهات التشغيلية',event:'نوع التنبيه التشغيلي',enable:'تفعيل التنبيه داخل المنصة',save:'حفظ التفضيل التشغيلي',failures:'التنبيهات التشغيلية المتعثرة',retry:'إعادة تجهيز التنبيه التشغيلي',reload:'تحديث التنبيهات المتعثرة'},
 en:{title:'Operational alert preferences',event:'Operational alert type',enable:'Enable in-app alert',save:'Save operational preference',failures:'Failed operational alerts',retry:'Retry alert publication',reload:'Reload failed operational alerts'},
 fr:{title:'Préférences des alertes opérationnelles',event:'Type d’alerte opérationnelle',enable:'Activer l’alerte dans la plateforme',save:'Enregistrer la préférence',failures:'Alertes opérationnelles en échec',retry:'Relancer la publication',reload:'Actualiser les alertes en échec'},
};
type EventType=typeof operationalEventTypes[number];
type Preference={version:number;enabled:boolean};
type Failure={id:string;eventType:EventType;version:number;changedAt:string};
const failuresPath='/api/notifications/operational/failures';

export function OperationalNotificationControls({locale,api,onChanged}:{
 locale:NotificationLocale;api:NotificationApi;onChanged:()=>void;
}) {
 const t=words[locale];
 const [event,setEvent]=useState<EventType>('INBOUND_REVIEW_REQUIRED');
 const [preference,setPreference]=useState<{event:EventType;value:Preference}|null>(null);
 const [failures,setFailures]=useState<Failure[]>([]);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const path='/api/notification-preferences/'+event;
 const value=preference?.event===event?preference.value:null;
 useEffect(()=>{
  let active=true;
  void api<Preference>(path).then(value=>{if(active)setPreference({event,value});})
   .catch(failure=>{if(active)setError(String(failure));});
  return()=>{active=false;};
 },[event]);
 useEffect(()=>{
  let active=true;
  void api<{items:Failure[]}>(failuresPath).then(result=>{if(active)setFailures(result.items);})
   .catch(failure=>{if(active)setError(String(failure));});
  return()=>{active=false;};
 },[]);
 async function save() {
  if(!value)return;
  await run(async()=>{
   await api(path,{method:'PUT',body:JSON.stringify({version:value.version,enabled:value.enabled})});
   setPreference({event,value:await api<Preference>(path)});
   onChanged();
  });
 }
 async function run(work:()=>Promise<void>) {
  setBusy(true);setError('');
  try{await work();}
  catch(failure){setPreference(null);setFailures([]);setError(String(failure));}
  finally{setBusy(false);}
 }
 async function reloadFailures(retry?:Failure) {
  await run(async()=>{
   if(retry)await api(failuresPath+'/'+retry.id+'/retry',{method:'POST',body:JSON.stringify({version:retry.version})});
   setFailures((await api<{items:Failure[]}>(failuresPath)).items);
  });
 }
 return <section data-operational-notification-controls>
  <fieldset><legend>{t.title}</legend>
   <label>{t.event}<select value={event} disabled={busy} onChange={e=>{setError('');setEvent(e.target.value as EventType);}}>
    {operationalEventTypes.map(type=><option key={type} value={type}>{operationalEventLabels[locale][type]}</option>)}
   </select></label>
   {value&&<>
    <label><input type="checkbox" checked={value.enabled} disabled={busy}
     onChange={e=>setPreference({event,value:{...value,enabled:e.target.checked}})}/>{t.enable}</label>
    <button disabled={busy} onClick={()=>void save()}>{t.save}</button>
   </>}
  </fieldset>
  {error&&<p role="alert">{error}</p>}
  <button disabled={busy} onClick={()=>void reloadFailures()}>{t.reload}</button>
  {failures.length>0&&<><h3>{t.failures}</h3><ul>{failures.map(failure=><li key={failure.id}>
   {operationalEventLabels[locale][failure.eventType]} · <time dateTime={failure.changedAt}>{new Date(failure.changedAt).toLocaleString(locale)}</time>{' '}
   <button disabled={busy} onClick={()=>void reloadFailures(failure)}>{t.retry}</button>
  </li>)}</ul></>}
 </section>;
}
