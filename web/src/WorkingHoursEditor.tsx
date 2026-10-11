import { useEffect, useRef, useState } from 'react';
type Api = <T>(path:string, options?:RequestInit)=>Promise<T>;
const days = ['mon','tue','wed','thu','fri','sat','sun'] as const;
type Hours = Partial<Record<typeof days[number],[string,string][]>>;
type Policy = { version:number;hours:Hours;timezone:string };
const words = {
  en:{ read:'Configure working hours', close:'Close working hours', unrestricted:'No weekly hours restriction', note:'Hours use the branch time zone. Empty days are closed when restrictions are enabled. Split overnight hours across two days. Existing Lead ownership and conversation control remain unchanged.', add:'Add period', remove:'Remove period', start:'Start', end:'End (24:00 allowed)', reason:'Working hours change reason', save:'Save working hours', history:'Working hours history', more:'Older hours changes', empty:'Closed', all:'Unrestricted', timezone:'Time zone', days:['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'] },
  ar:{ read:'إعداد ساعات العمل',close:'إغلاق إعداد الساعات',unrestricted:'دون تقييد بالساعات الأسبوعية',note:'تُستخدم المنطقة الزمنية للفرع. الأيام الفارغة مغلقة عند تفعيل التقييد. قسّم الفترة العابرة لمنتصف الليل على يومين. ملكية Lead والتحكم بالمحادثة يبقيان كما هما.',add:'إضافة فترة',remove:'إزالة فترة',start:'البداية',end:'النهاية (يمكن 24:00)',reason:'سبب تعديل ساعات العمل',save:'حفظ ساعات العمل',history:'سجل ساعات العمل',more:'تغييرات أقدم للساعات',empty:'مغلق',all:'دون تقييد',timezone:'المنطقة الزمنية',days:['الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت','الأحد'] },
  fr:{ read:'Configurer les horaires',close:'Fermer les horaires',unrestricted:'Sans restriction hebdomadaire',note:'Les horaires utilisent le fuseau de l’agence. Les jours vides sont fermés si les restrictions sont activées. Répartissez les périodes de nuit sur deux jours. La propriété du Lead et le contrôle de la conversation restent inchangés.',add:'Ajouter une période',remove:'Supprimer une période',start:'Début',end:'Fin (24:00 autorisé)',reason:'Motif du changement des horaires',save:'Enregistrer les horaires',history:'Historique des horaires',more:'Changements précédents',empty:'Fermé',all:'Sans restriction',timezone:'Fuseau horaire',days:['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'] },
};
type History = { items:{ version:number;hours:Hours;reason:string;created_at:string }[];nextVersion:number|null };
export function WorkingHoursEditor({ scope,id,locale,api,initiallyOpen=false }: { scope:'BRANCH'|'USER';id:string;locale:'ar'|'en'|'fr';api:Api;initiallyOpen?:boolean }) {
  const t=words[locale],root='/api/'+(scope==='BRANCH'?'branches':'users')+'/'+id+'/working-hours';
  const [policy,setPolicy]=useState<Policy|null>(null),[history,setHistory]=useState<History|null>(null),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),epoch=useRef(0);
  function clear() { ++epoch.current;setPolicy(null);setHistory(null);setReason('');setError('');setBusy(false); }
  useEffect(()=>{clear();if(initiallyOpen)void read();return()=>{++epoch.current;};},[id,scope]);
  async function read() {
    const n=++epoch.current;setBusy(true);setError('');setPolicy(null);setHistory(null);
    try { const p=await api<Policy>(root);if(n===epoch.current){setPolicy(p);setReason('');} }
    catch(e){if(n===epoch.current)setError(String(e));}finally{if(n===epoch.current)setBusy(false);}
  }
  async function save() {
    if(!policy)return;const n=++epoch.current;setBusy(true);setError('');
    try { await api(root,{ method:'PUT',body:JSON.stringify({version:policy.version,hours:policy.hours,reason}) });const p=await api<Policy>(root);
      if(n===epoch.current){setPolicy(p);setReason('');setHistory(null);} }
    catch(e){if(n===epoch.current){setPolicy(null);setHistory(null);setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}
  }
  async function readHistory(older=false) {
    const n=++epoch.current,prior=older?history:null;setBusy(true);setError('');
    try { const h=await api<History>(root+'/history'+(prior?.nextVersion?'?before='+prior.nextVersion:''));if(n===epoch.current)setHistory({...h,items:[...(prior?.items??[]),...h.items]}); }
    catch(e){if(n===epoch.current){setPolicy(null);setHistory(null);setError(String(e));}}finally{if(n===epoch.current)setBusy(false);}
  }
  const unrestricted=policy && !Object.keys(policy.hours).length;
  function ranges(day:typeof days[number],value:[string,string][]) { if(policy)setPolicy({...policy,hours:{...policy.hours,[day]:value}}); }
  return <div data-working-hours={id}><button className="link" disabled={busy} onClick={()=>void read()}>{t.read}</button>{error&&<p role="alert">{error}</p>}
    {policy&&<section className="panel" style={{minWidth:0}}><p>{t.note}</p><p>{t.timezone}: <span dir="ltr">{policy.timezone}</span></p>
      <label><input type="checkbox" disabled={busy} checked={!!unrestricted} onChange={e=>setPolicy({...policy,hours:e.target.checked?{}:Object.fromEntries(days.map(d=>[d,[]]))})}/>{t.unrestricted}</label>
      {!unrestricted&&days.map((day,i)=><fieldset key={day} style={{minWidth:0}}><legend>{t.days[i]}</legend>{!(policy.hours[day]?.length)&&<p>{t.empty}</p>}
        {(policy.hours[day]??[]).map((r,j)=><div key={j} style={{display:'flex',flexWrap:'wrap',gap:'0.5rem'}}>{r.map((v,k)=><label key={k}>{k===0?t.start:t.end}<input dir="ltr" aria-label={t.days[i]+' '+(k===0?t.start:t.end)+' '+(j+1)} disabled={busy} value={v} maxLength={5} placeholder="09:00" style={{width:'7rem',maxWidth:'100%'}} onChange={e=>ranges(day,(policy.hours[day]??[]).map((x,index)=>index===j?x.map((y,pos)=>pos===k?e.target.value:y) as [string,string]:x))}/></label>)}
          <button type="button" disabled={busy} onClick={()=>ranges(day,(policy.hours[day]??[]).filter((_,index)=>index!==j))}>{t.remove}</button></div>)}
        <button type="button" disabled={busy||(policy.hours[day]?.length??0)>=8} onClick={()=>ranges(day,[...(policy.hours[day]??[]),['09:00','17:00']])}>{t.add}</button></fieldset>)}
      <label>{t.reason}<input disabled={busy} value={reason} maxLength={500} onChange={e=>setReason(e.target.value)}/></label><button disabled={busy||reason.trim().length<3} onClick={()=>void save()}>{t.save}</button>
      <button disabled={busy} onClick={()=>void readHistory()}>{t.history}</button><button disabled={busy} onClick={clear}>{t.close}</button>
      {history?.items.map(h=><article key={h.version}><p>{h.version} · <time dateTime={h.created_at}>{new Date(h.created_at).toLocaleString(locale)}</time></p><p dir="auto" style={{overflowWrap:'anywhere'}}>{h.reason}</p>
        {!Object.keys(h.hours).length?<p>{t.all}</p>:days.map((d,i)=><p key={d}>{t.days[i]}: {(h.hours[d]??[]).map(r=>r.join('–')).join(', ')||t.empty}</p>)}</article>)}
      {history?.nextVersion&&<button disabled={busy} onClick={()=>void readHistory(true)}>{t.more}</button>}
    </section>}
  </div>;
}
