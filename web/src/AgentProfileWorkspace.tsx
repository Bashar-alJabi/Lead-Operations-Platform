import { useEffect,useState } from 'react';

type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'en'|'fr';
type Profile={name:string;capacity:number|null;active:boolean;branchActive:boolean;credential_state:string;version:number;openLeadCount:number};
type Entry={version:number;previousName:string;name:string;previousCapacity:number|null;capacity:number|null;reason:string;changedAt:string};
type History={items:Entry[];nextBefore:number|null};
const empty:History={items:[],nextBefore:null};
const labels={
  ar:{title:'ملف الوكيل',name:'اسم الوكيل',capacity:'السعة الافتراضية',open:'الفرص المفتوحة المعيّنة',reason:'سبب تعديل الملف',
    save:'حفظ ملف الوكيل',refresh:'تحديث الملف وعبء العمل',history:'سجل ملف الوكيل',more:'تغييرات أقدم',
    active:'نشط',inactive:'معطّل',invited:'بانتظار قبول الدعوة',unlimited:'بلا حد',
    note:'اترك السعة فارغة عند عدم تحديد حد. القيمة صفر توقف الإسناد التلقائي عند تطبيق السعة الافتراضية.',
    conflict:'تغيّر الملف في جلسة أخرى. حدّثه قبل إعادة المحاولة.',error:'تعذّر تنفيذ الطلب.'},
  en:{title:'Agent profile',name:'Agent name',capacity:'Default capacity',open:'Assigned open leads',reason:'Profile change reason',
    save:'Save agent profile',refresh:'Refresh profile and workload',history:'Agent profile history',more:'Older changes',
    active:'Active',inactive:'Disabled',invited:'Invitation pending',unlimited:'Unlimited',
    note:'Leave capacity empty for no default limit. Zero stops automatic assignment when the default capacity applies.',
    conflict:'The profile changed in another session. Refresh it before trying again.',error:'The request failed.'},
  fr:{title:'Profil du conseiller',name:'Nom du conseiller',capacity:'Capacité par défaut',open:'Prospects ouverts attribués',reason:'Motif du changement de profil',
    save:'Enregistrer le profil',refresh:'Actualiser le profil et la charge',history:'Historique du profil',more:'Changements précédents',
    active:'Actif',inactive:'Désactivé',invited:'Invitation en attente',unlimited:'Illimitée',
    note:'Une capacité vide indique l’absence de limite par défaut. Zéro suspend l’attribution automatique lorsque la capacité par défaut s’applique.',
    conflict:'Le profil a changé dans une autre session. Actualisez-le avant de réessayer.',error:'La requête a échoué.'},
};

export const agentProfileLabel=(locale:Locale)=>labels[locale].title;

export function AgentProfileWorkspace({id,locale,api,onChanged}:{id:string;locale:Locale;api:Api;onChanged:()=>Promise<void>}) {
  const t=labels[locale],root='/api/users/'+id+'/agent-profile';
  const [profile,setProfile]=useState<Profile|null>(null);
  const [history,setHistory]=useState<History>(empty);
  const [name,setName]=useState('');
  const [capacity,setCapacity]=useState('');
  const [reason,setReason]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);

  async function run(action:()=>Promise<void>) {
    setBusy(true);setError('');
    try { await action(); }
    catch (failure) {
      const code=failure instanceof Error?failure.message:String(failure);
      if (/AUTH_REQUIRED|ACCESS_REVOKED|NOT_FOUND|FORBIDDEN/.test(code)) {
        setProfile(null);setHistory(empty);setName('');setCapacity('');setReason('');
      }
      setError(code);
    } finally { setBusy(false); }
  }
  async function readHistory(before?:number) {
    const next=await api<History>(root+'/history'+(before?'?before='+before:''));
    setHistory(previous=>before?{...next,items:[...previous.items,...next.items]}:next);
  }
  async function read() {
    const [next]=await Promise.all([api<Profile>(root),readHistory()]);
    setProfile(next);setName(next.name);setCapacity(next.capacity?.toString()??'');setReason('');
  }
  const limit=capacity===''?null:Number(capacity);
  const canSave=profile?.branchActive && name.trim() && (limit===null || Number.isInteger(limit)&&limit>=0&&limit<=2147483647)
    && (name.trim()!==profile.name||limit!==profile.capacity) && reason.trim().length>=3;
  async function save(current:Profile) {
    await api(root,{method:'PUT',body:JSON.stringify({name,capacity:limit,reason,version:current.version})});
    await Promise.all([read(),onChanged()]);
  }
  useEffect(()=>{void run(read);},[]);

  const showCapacity=(value:number|null)=>value??t.unlimited;
  return <section className="panel" data-agent-profile aria-busy={busy}>
    <h3>{t.title}</h3>
    <button type="button" className="secondary" disabled={busy} onClick={()=>void run(read)}>{t.refresh}</button>
    {error&&<p role="alert">{error.includes('VERSION_CONFLICT')?t.conflict:t.error}</p>}
    {profile&&<>
      <p>{profile.active?(profile.credential_state==='INVITED'?t.invited:t.active):t.inactive}</p>
      <p>{t.open}{' · '}<strong>{profile.openLeadCount}</strong></p>
      <form className="workflow-form" onSubmit={event=>{event.preventDefault();void run(()=>save(profile));}}>
        <label>{t.name}<input required maxLength={200} value={name} onChange={event=>setName(event.target.value)} disabled={busy||!profile.branchActive} /></label>
        <label>{t.capacity}<input type="number" dir="ltr" min={0} max={2147483647} value={capacity}
          onChange={event=>setCapacity(event.target.value)} disabled={busy||!profile.branchActive} /></label>
        <p>{t.note}</p>
        <label>{t.reason}<input required maxLength={500} minLength={3} value={reason} onChange={event=>setReason(event.target.value)} disabled={busy||!profile.branchActive} /></label>
        <button disabled={busy||!canSave}>{t.save}</button>
      </form>
    </>}
    {history.items.length>0&&<><h4>{t.history}</h4><ul>{history.items.map(entry=><li key={entry.version}>
      <bdi>{entry.previousName} → {entry.name}</bdi>{' · '}
      <bdi>{showCapacity(entry.previousCapacity)} → {showCapacity(entry.capacity)}</bdi>{' · '}{entry.reason}{' · '}
      <time dateTime={entry.changedAt}>{new Date(entry.changedAt).toLocaleString(locale)}</time></li>)}</ul></>}
    {history.nextBefore&&<button type="button" disabled={busy} onClick={()=>void run(()=>readHistory(history.nextBefore!))}>{t.more}</button>}
  </section>;
}
