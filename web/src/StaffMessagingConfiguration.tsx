import {useEffect,useState} from 'react';
import {eventLabel} from './EmailNotificationSettings.js';
import type {NotificationApi,NotificationLocale} from './NotificationCenter.js';

const labels={
 ar:{title:'إعداد إشعارات Messaging الداخلية',preferences:'تفضيل Messaging الشخصي',bindings:'قالب إشعار الفرع',branch:'فرع الإشعار الداخلي',event:'حدث Messaging الداخلي',language:'لغة Messaging الداخلية',template:'مرسل وقالب معتمدان',choose:'اختر المرسل والقالب',enabled:'تفعيل الحدث',reason:'سبب تعديل قالب الإشعار الداخلي',save:'حفظ إعداد Messaging الداخلي',savePreference:'حفظ تفضيل Messaging',refresh:'تحديث الإعداد',history:'السجل',older:'إصدارات أقدم',more:'المزيد من القوالب',empty:'لا تغييرات محفوظة.',on:'مفعّل',off:'معطّل',consent:'أكد رقمك وموافقتك أولًا من «حسابي».',missing:'خصص مرسلًا داخليًا للفرع وأضف قالبًا نصيًا معتمدًا في إعداد Messaging.',stale:'تغير القالب المحفوظ. اختر قالبًا معتمدًا وأعد الحفظ.'},
 en:{title:'Internal messaging notifications',preferences:'Personal messaging preference',bindings:'Branch staff notification template',branch:'Internal notification branch',event:'Internal messaging event',language:'Internal messaging language',template:'Approved sender and template',choose:'Choose sender and template',enabled:'Enable event',reason:'Internal template change reason',save:'Save internal messaging binding',savePreference:'Save messaging preference',refresh:'Reload settings',history:'History',older:'Older changes',more:'More templates',empty:'No changes saved.',on:'Enabled',off:'Disabled',consent:'Confirm your number and consent in My account first.',missing:'Reserve a branch sender and add an approved static text template in Messaging setup.',stale:'The saved template changed. Select an approved template and save again.'},
 fr:{title:'Notifications de messagerie interne',preferences:'Préférence personnelle',bindings:'Modèle de notification de l’agence',branch:'Agence de notification interne',event:'Événement de messagerie interne',language:'Langue de messagerie interne',template:'Expéditeur et modèle approuvés',choose:'Choisir un expéditeur et un modèle',enabled:'Activer l’événement',reason:'Motif de modification du modèle interne',save:'Enregistrer le modèle interne',savePreference:'Enregistrer la préférence',refresh:'Recharger les réglages',history:'Historique',older:'Modifications précédentes',more:'Plus de modèles',empty:'Aucune modification enregistrée.',on:'Activé',off:'Désactivé',consent:'Confirmez votre numéro et votre consentement dans Mon compte.',missing:'Réservez un expéditeur d’agence et ajoutez un modèle texte statique approuvé dans Messagerie.',stale:'Le modèle a changé. Sélectionnez un modèle approuvé et enregistrez-le.'},
} as const;
const root='/api/notification-messaging';
const eventTypes=['AI_HANDOFF_REQUESTED','AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE',
 'PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED','CONVERSATION_NEEDS_ATTENTION','AUTOMATION_NOTICE','LEAD_NEEDS_ATTENTION','INBOUND_REVIEW_REQUIRED','INTEGRATION_ALERT','SYSTEM_ALERT'];
type User={role:'SUPER_ADMIN'|'MANAGER'|'AGENT';branchId:string|null};
type Props={locale:NotificationLocale;api:NotificationApi;user:User;branches:{id:string;name:string}[]};
type History={items:{version:number;changedAt:string;snapshot:{enabled:boolean;language:string;reason?:string}}[];nextVersion:number|null};
type Choice={senderId:string;templateId:string;senderName:string;templateName:string;providerLanguage:string;preview:string};
type Catalog={items:Choice[];nextCursor:string|null};
type Binding=Pick<Choice,'senderId'|'templateId'|'senderName'|'templateName'>&{version:number;enabled:boolean;templateCurrent:boolean};
type Preference={eventType:string;version:number;enabled:boolean;language:NotificationLocale};
const identity=(row:Pick<Choice,'senderId'|'templateId'>)=>row.senderId+':'+row.templateId;

function Changes({locale,history,older}:{locale:NotificationLocale;history:History;older:(version:number)=>void}) {
 const t=labels[locale];
 return <>{history.items.length===0?<p>{t.empty}</p>:<ul>{history.items.map(item=><li key={item.version}>
  {new Date(item.changedAt).toLocaleString(locale)} · {item.snapshot.enabled?t.on:t.off} · {item.snapshot.language}
  {item.snapshot.reason&&<> · <bdi>{item.snapshot.reason}</bdi></>}
 </li>)}</ul>}{history.nextVersion&&<button type="button" onClick={()=>older(history.nextVersion!)}>{t.older}</button>}</>;
}

function BranchBinding({api,locale,branches,user}:Props) {
 const t=labels[locale];
 const [branch,setBranch]=useState(user.branchId??branches[0]?.id??'');
 const [event,setEvent]=useState('LEAD_ASSIGNED'),[language,setLanguage]=useState<NotificationLocale>(locale);
 const [binding,setBinding]=useState<{binding:Binding|null}|null>(null),[options,setOptions]=useState<Catalog|null>(null);
 const [option,setOption]=useState(''),[reason,setReason]=useState(''),[enabled,setEnabled]=useState(false);
 const [history,setHistory]=useState<History|null>(null),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const path=`${root}/branches/${branch}/bindings/${event}/${language}`;
 useEffect(()=>{
  let active=true;
  setBinding(null);setOptions(null);setHistory(null);setReason('');setError('');
  if(branch)void Promise.all([api<{binding:Binding|null}>(path),api<Catalog>(path+'/options')]).then(([record,choices])=>{
   if(active){setBinding(record);setOptions(choices);setOption(record.binding?identity(record.binding):'');setEnabled(record.binding?.enabled??false);}
  }).catch(failure=>{if(active)setError(String(failure));});
  return()=>{active=false;};
 },[path,refresh]);
 const selected=options?.items.find(row=>identity(row)===option);
 const old=binding?.binding;
 const allowedChoice=selected??(old&&identity(old)===option?old:null);
 async function run(action:()=>Promise<void>) {
  setBusy(true);setError('');
  try{await action();}catch(failure){setBinding(null);setOptions(null);setHistory(null);setError(String(failure));}
  finally{setBusy(false);}
 }
 async function save(){
  if(!allowedChoice)return;
  await run(async()=>{
   await api(path,{method:'PUT',body:JSON.stringify({version:old?.version??0,enabled,senderId:allowedChoice.senderId,
    templateId:allowedChoice.templateId,reason})});setRefresh(n=>n+1);
  });
 }
 const readHistory=(before?:number)=>void run(async()=>setHistory(await api<History>(path+'/history'+(before?`?before=${before}`:''))));
 return <section className="panel form-panel" data-staff-messaging-binding><h4>{t.bindings}</h4>
  {user.role==='SUPER_ADMIN'&&<label>{t.branch}<select aria-label={t.branch} disabled={busy} value={branch} onChange={e=>setBranch(e.target.value)}>
   {branches.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
  <label>{t.event}<select aria-label={t.event} value={event} disabled={busy} onChange={e=>setEvent(e.target.value)}>
   {eventTypes.map(type=><option key={type} value={type}>{eventLabel(type,locale)}</option>)}</select></label>
  <label>{t.language}<select aria-label={t.language} value={language} disabled={busy} onChange={e=>setLanguage(e.target.value as NotificationLocale)}>
   <option value="ar">العربية</option><option value="en">English</option><option value="fr">Français</option></select></label>
  <button type="button" disabled={busy} onClick={()=>setRefresh(n=>n+1)}>{t.refresh}</button>
  {error&&<p role="alert">{error}</p>}
  {binding&&options&&<>
   {!options.items.length&&<p>{t.missing}</p>}{old?.enabled&&!old.templateCurrent&&<p>{t.stale}</p>}
   <form onSubmit={e=>{e.preventDefault();void save();}}>
    <label>{t.template}<select aria-label={t.template} required value={option} disabled={busy} onChange={e=>setOption(e.target.value)}>
     <option value="">{t.choose}</option>
     {old&&!options.items.some(row=>identity(row)===identity(old))&&<option value={identity(old)}>{old.senderName} · {old.templateName}</option>}
     {options.items.map(row=><option key={identity(row)} value={identity(row)}>{row.senderName} · {row.templateName} ({row.providerLanguage})</option>)}
    </select></label>
    {selected&&<p dir="auto" style={{overflowWrap:'anywhere',whiteSpace:'pre-wrap'}}>{selected.preview}</p>}
    <label><input type="checkbox" checked={enabled} disabled={busy} onChange={e=>setEnabled(e.target.checked)}/>{t.enabled}</label>
    <label>{t.reason}<input value={reason} required minLength={3} maxLength={500} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
    <button disabled={busy||!allowedChoice}>{t.save}</button>
   </form>
   {options.nextCursor&&<button disabled={busy} onClick={()=>void run(async()=>{
    const next=await api<Catalog>(path+'/options?after='+encodeURIComponent(options.nextCursor!));
    setOptions({items:[...options.items,...next.items],nextCursor:next.nextCursor});
   })}>{t.more}</button>}
   <button disabled={busy} onClick={()=>readHistory()}>{t.history}</button>{history&&<Changes locale={locale} history={history} older={readHistory}/>}
  </>}
 </section>;
}

function PersonalPreference({api,locale}:Props) {
 const t=labels[locale],path=root+'/preferences';
 const [data,setData]=useState<{consented:boolean;items:Preference[]}|null>(null),[event,setEvent]=useState('LEAD_ASSIGNED');
 const [draft,setDraft]=useState<Preference|null>(null),[history,setHistory]=useState<History|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const preference=draft?.eventType===event?draft:data?.items.find(item=>item.eventType===event);
 useEffect(()=>{
  let active=true;
  void api<{consented:boolean;items:Preference[]}>(path).then(value=>{if(active)setData(value);})
   .catch(failure=>{if(active)setError(String(failure));});
  return()=>{active=false;};
 },[]);
 async function run(action:()=>Promise<void>) {
  setBusy(true);setError('');
  try{await action();}catch(failure){setData(null);setDraft(null);setHistory(null);setError(String(failure));}
  finally{setBusy(false);}
 }
 async function read(){setData(await api<{consented:boolean;items:Preference[]}>(path));setDraft(null);setHistory(null);}
 const changes=(before?:number)=>void run(async()=>setHistory(await api<History>(path+'/'+event+'/history'+(before?`?before=${before}`:''))));
 return <section className="panel form-panel" data-staff-messaging-preference><h4>{t.preferences}</h4>
  <button disabled={busy} onClick={()=>void run(read)}>{t.refresh}</button>{error&&<p role="alert">{error}</p>}
  {data&&preference&&<>
   {!data.consented&&<p>{t.consent}</p>}
   <label>{t.event}<select aria-label={t.event} value={event} disabled={busy} onChange={e=>{setEvent(e.target.value);setDraft(null);setHistory(null);}}>
    {data.items.map(choice=><option key={choice.eventType} value={choice.eventType}>{eventLabel(choice.eventType,locale)}</option>)}</select></label>
   <label>{t.language}<select aria-label={t.language} value={preference.language} disabled={busy} onChange={e=>setDraft({...preference,language:e.target.value as NotificationLocale})}>
    <option value="ar">العربية</option><option value="en">English</option><option value="fr">Français</option></select></label>
   <label><input type="checkbox" checked={preference.enabled} disabled={busy||!data.consented&&!preference.enabled}
    onChange={e=>setDraft({...preference,enabled:e.target.checked})}/>{t.enabled}</label>
   <button disabled={busy||!data.consented&&preference.enabled} onClick={()=>void run(async()=>{
    await api(path+'/'+event,{method:'PUT',body:JSON.stringify({enabled:preference.enabled,language:preference.language,version:preference.version})});await read();
   })}>{t.savePreference}</button>
   <button disabled={busy} onClick={()=>changes()}>{t.history}</button>{history&&<Changes locale={locale} history={history} older={changes}/>}
  </>}
 </section>;
}

function StaffMessagingActivity({api,locale}:Props) {
 const t={
  ar:{title:'نشاط Messaging الداخلي',empty:'لا إشعارات مجهّزة.',PREPARED:'مجهّز',SUPPRESSED:'أوقف لتغيّر الإعداد',
   WAITING:'بانتظار التسليم',SENDING:'قيد الإرسال',ACCEPTED:'قبله المزود للمعالجة',UNKNOWN:'نتيجة غير مؤكدة',
   REJECTED:'رفضه المزود',RETRYING:'بانتظار إعادة المحاولة',history:'سجل التسليم'},
  en:{title:'Internal messaging activity',empty:'No prepared notifications.',PREPARED:'Prepared',SUPPRESSED:'Suppressed after a change',
   WAITING:'Waiting for dispatch',SENDING:'Sending',ACCEPTED:'Accepted by provider',UNKNOWN:'Outcome unknown',
   REJECTED:'Rejected by provider',RETRYING:'Waiting to retry',history:'Dispatch history'},
  fr:{title:'Activité de messagerie interne',empty:'Aucune notification préparée.',PREPARED:'Préparée',SUPPRESSED:'Bloquée après modification',
   WAITING:'En attente d’envoi',SENDING:'En cours d’envoi',ACCEPTED:'Acceptée par le fournisseur',UNKNOWN:'Résultat inconnu',
   REJECTED:'Rejetée par le fournisseur',RETRYING:'En attente de réessai',history:'Historique d’envoi'},
 }[locale];
 type State='PREPARED'|'SUPPRESSED'|'WAITING'|'SENDING'|'ACCEPTED'|'UNKNOWN'|'REJECTED'|'RETRYING';
 type Page={items:{id:string;eventType:string;language:NotificationLocale;preparedAt:string;state:State}[];nextCursor:string|null};
 type DispatchHistory={items:{version:number;state:State;attempts:number;changedAt:string}[]};
 const [feed,setFeed]=useState<Page|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [history,setHistory]=useState<{id:string;items:DispatchHistory['items']}|null>(null);
 async function read(readCurrent:()=>Promise<void>){
  setBusy(true);setError('');setHistory(null);
  try{await readCurrent();}
  catch(failure){setFeed(null);setError(String(failure));}
  finally{setBusy(false);}
 }
 const load=(cursor?:string)=>read(async()=>setFeed(await api<Page>(root+'/outbox'+(cursor?'?cursor='+encodeURIComponent(cursor):''))));
 const openHistory=(id:string)=>read(async()=>{
  const result=await api<DispatchHistory>(root+'/outbox/'+id+'/history');setHistory({id,items:result.items});
 });
 return <section className="panel" data-staff-messaging-activity><h4>{t.title}</h4>
  <button disabled={busy} onClick={()=>void load()}>{labels[locale].refresh}</button>
  {error&&<p role="alert">{error}</p>}
  {feed&&(feed.items.length?<ul>{feed.items.map(item=><li key={item.id}>
   {eventLabel(item.eventType,locale)} · {item.language} · {t[item.state]} · {new Date(item.preparedAt).toLocaleString(locale)}
   <button type="button" className="link" disabled={busy} onClick={()=>void openHistory(item.id)}>{t.history}</button>
   {history?.id===item.id&&<ul>{history.items.map(entry=><li key={entry.version}>
    {t[entry.state]} · {new Date(entry.changedAt).toLocaleString(locale)}
   </li>)}</ul>}
  </li>)}</ul>:<p>{t.empty}</p>)}
  {feed?.nextCursor&&<button disabled={busy} onClick={()=>void load(feed.nextCursor!)}>{labels[locale].older}</button>}
 </section>;
}

export function StaffMessagingConfiguration(props:Props) {
 const [open,setOpen]=useState(false);
 return <details onToggle={event=>setOpen(event.currentTarget.open)}><summary>{labels[props.locale].title}</summary>
  {open&&props.user.role!=='AGENT'&&<BranchBinding {...props}/>}
  {open&&props.user.role!=='SUPER_ADMIN'&&<><PersonalPreference {...props}/><StaffMessagingActivity {...props}/></>}
 </details>;
}
