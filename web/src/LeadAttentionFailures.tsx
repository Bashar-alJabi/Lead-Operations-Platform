import {useEffect,useRef,useState} from 'react';
import type {NotificationApi,NotificationLocale} from './NotificationCenter.js';
import {attentionReasonLabel} from './notification-attention.js';

type Failure={id:string;leadId:string;reasonCode:string;version:number;changedAt:string};
const words={
 ar:{title:'تنبيهات فرص تعذّر تجهيزها',refresh:'تحديث إخفاقات التنبيه',retry:'إعادة تجهيز التنبيه',open:'مراجعة الفرصة'},
 en:{title:'Lead alerts needing recovery',refresh:'Refresh failed alerts',retry:'Retry alert preparation',open:'Review lead'},
 fr:{title:'Alertes prospect à rétablir',refresh:'Actualiser les alertes en échec',retry:'Relancer la préparation',open:'Examiner le prospect'},
};
const path='/api/notifications/lead-attention/failures';
export function LeadAttentionFailures({locale,api,userId,openLead}:{locale:NotificationLocale;api:NotificationApi;userId:string;openLead:(id:string)=>void}){
 const [items,setItems]=useState<Failure[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const epoch=useRef(0),t=words[locale];
 useEffect(()=>{void load();return()=>{++epoch.current;};},[userId,locale]);
 async function load(retry?:Failure){
  const job=++epoch.current;
  setItems([]);setError('');setBusy(true);
  try{
   if(retry)await api(path+'/'+retry.id+'/retry',{method:'POST',body:JSON.stringify({version:retry.version})});
   const result=await api<{items:Failure[]}>(path);
   if(job===epoch.current)setItems(result.items);
  }catch(e){if(job===epoch.current)setError(String(e));}
  finally{if(job===epoch.current)setBusy(false);}
 }
 return <section id="lead-attention-recovery" data-lead-attention-recovery>
  <button disabled={busy} onClick={()=>void load()}>{t.refresh}</button>{error&&<p role="alert">{error}</p>}
  {items.length>0&&<><h3>{t.title}</h3><ul>{items.map(item=><li key={item.id}>
   <p>{attentionReasonLabel(item.reasonCode,locale)} · <time dateTime={item.changedAt}>{new Date(item.changedAt).toLocaleString(locale)}</time></p>
   <button disabled={busy} onClick={()=>openLead(item.leadId)}>{t.open}</button>
   <button disabled={busy} onClick={()=>void load(item)}>{t.retry}</button>
  </li>)}</ul></>}
 </section>;
}
