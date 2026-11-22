import { useEffect, useState } from 'react';
import { WorkingHoursEditor } from './WorkingHoursEditor.js';

type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'en'|'fr';
type BranchTime={timezone:string;version:number;active:boolean};
type Entry={version:number;previousTimezone:string;timezone:string;reason:string;changedAt:string};
type History={items:Entry[];nextBefore:number|null};
const empty:History={items:[],nextBefore:null};
const labels={
  ar:{title:'المنطقة الزمنية للفرع',timezone:'المنطقة الزمنية',reason:'سبب تغيير المنطقة الزمنية',save:'حفظ المنطقة الزمنية',
    refresh:'تحديث إعداد المنطقة الزمنية',history:'سجل تغييرات المنطقة الزمنية',more:'تغييرات أقدم',
    help:'تُقيّم ساعات العمل ونوافذ الإرسال المستقبلية وفق هذه المنطقة. تظل مواعيد المتابعات المحفوظة على توقيتها المحدد.',
    conflict:'تغيّر الإعداد في جلسة أخرى. حدّثه قبل إعادة المحاولة.',invalid:'اختر اسم منطقة زمنية صالحًا مثل Asia/Damascus.',error:'تعذّر تنفيذ الطلب.'},
  en:{title:'Branch timezone',timezone:'Timezone',reason:'Timezone change reason',save:'Save timezone',
    refresh:'Refresh timezone settings',history:'Timezone change history',more:'Older changes',
    help:'Future working-hours and sending checks use this timezone. Saved follow-up due times retain their scheduled instant.',
    conflict:'The timezone changed in another session. Refresh it before trying again.',invalid:'Use a valid timezone name such as Asia/Damascus.',error:'The request failed.'},
  fr:{title:'Fuseau horaire de l’agence',timezone:'Fuseau horaire',reason:'Motif du changement de fuseau',save:'Enregistrer le fuseau horaire',
    refresh:'Actualiser le fuseau horaire',history:'Historique du fuseau horaire',more:'Changements précédents',
    help:'Les vérifications des horaires et de l’envoi utilisent ce fuseau. Les échéances déjà enregistrées conservent leur instant prévu.',
    conflict:'Le fuseau a changé dans une autre session. Actualisez-le avant de réessayer.',invalid:'Utilisez un fuseau valide comme Asia/Damascus.',error:'La requête a échoué.'},
};

export function BranchTimeWorkspace({id,locale,api,onChanged}:{id:string;locale:Locale;api:Api;onChanged:()=>Promise<void>}) {
  const t=labels[locale],root='/api/branches/'+id+'/timezone';
  const [detail,setDetail]=useState<BranchTime|null>(null);
  const [history,setHistory]=useState<History>(empty);
  const [timezone,setTimezone]=useState('');
  const [reason,setReason]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  async function run(action:()=>Promise<void>) {
    setBusy(true);setError('');
    try { await action(); }
    catch (failure) {
      const code=failure instanceof Error?failure.message:String(failure);
      if (/AUTH_REQUIRED|ACCESS_REVOKED|NOT_FOUND|FORBIDDEN/.test(code)) {
        setDetail(null);setHistory(empty);setTimezone('');setReason('');
      }
      setError(code);
    } finally { setBusy(false); }
  }
  async function readHistory(before?:number) {
    const next=await api<History>(root+'/history'+(before?'?before='+before:''));
    setHistory(previous=>before?{...next,items:[...previous.items,...next.items]}:next);
  }
  async function read() {
    const [next]=await Promise.all([api<BranchTime>(root),readHistory()]);
    setDetail(next);setTimezone(next.timezone);setReason('');
  }
  async function save(current:BranchTime) {
    const changed=await api<BranchTime>(root,{method:'PUT',body:JSON.stringify({timezone,reason,version:current.version})});
    setDetail(changed);setTimezone(changed.timezone);setReason('');
    await Promise.all([readHistory(),onChanged()]);
  }
  useEffect(()=>{void run(read);},[]);

  return <>
    <section className="panel" data-branch-timezone aria-busy={busy}>
      <h3>{t.title}</h3><p>{t.help}</p>
      <button type="button" className="secondary" disabled={busy} onClick={()=>void run(read)}>{t.refresh}</button>
      {error&&<p role="alert">{error.includes('VERSION_CONFLICT')?t.conflict:error.includes('INVALID_TIMEZONE')?t.invalid:t.error}</p>}
      {detail&&<form className="workflow-form" onSubmit={event=>{event.preventDefault();void run(()=>save(detail));}}>
        <label>{t.timezone}<input dir="ltr" required maxLength={100} disabled={busy||!detail.active} value={timezone}
          onChange={event=>setTimezone(event.target.value)} /></label>
        <label>{t.reason}<input required minLength={3} maxLength={500} disabled={busy||!detail.active} value={reason}
          onChange={event=>setReason(event.target.value)} /></label>
        <button disabled={busy||!detail.active||!timezone||timezone===detail.timezone||reason.trim().length<3}>{t.save}</button>
      </form>}
      {history.items.length>0&&<><h4>{t.history}</h4><ul>{history.items.map(entry=><li key={entry.version}>
        <bdi>{entry.previousTimezone} → {entry.timezone}</bdi>{' · '}{entry.reason}{' · '}
        <time dateTime={entry.changedAt}>{new Date(entry.changedAt).toLocaleString(locale)}</time></li>)}</ul></>}
      {history.nextBefore&&<button type="button" disabled={busy} onClick={()=>void run(()=>readHistory(history.nextBefore!))}>{t.more}</button>}
    </section>
    <WorkingHoursEditor key={detail?.version??0} scope="BRANCH" id={id} locale={locale} api={api} initiallyOpen />
  </>;
}
