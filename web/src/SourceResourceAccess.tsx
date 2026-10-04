import { useEffect,useRef,useState } from 'react';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'fr'|'en';
type Grant={ branch_id:string;name:string;active:boolean;version:number;change_reason:string };
type History={ version:number;active:boolean;reason:string;created_at:string };
const labels={
  ar:{ title:'مشاركة Form مع الفروع',note:'اختر الفروع المخولة باستعمال هذه Form فقط. Manager ترى المصدر وأسئلة Form الممنوحة من إعداد الحملة، دون credentials أو مزامنة الاتصال. إلغاء المنحة يعطل bindings التابعة ولا يمحو تاريخها؛ إعادة المنحة لا تعيد تفعيلها تلقائياً.',branch:'الفرع المخول للمصدر',active:'السماح باستعمال Form',reason:'سبب تغيير منحة المصدر',save:'حفظ منحة المصدر',more:'المزيد',history:'تاريخ منحة المصدر',empty:'لا توجد منح لهذه Form.' },
  fr:{ title:'Partager le formulaire avec les agences',note:'Autorisez seulement les agences qui peuvent utiliser ce formulaire. Le Manager voit la source et les questions autorisées depuis la campagne, sans secrets ni synchronisation de connexion. Révoquer l’accès désactive les liaisons sans effacer leur historique ; réautoriser ne les réactive pas.',branch:'Agence autorisée pour la source',active:'Autoriser ce formulaire',reason:'Motif de modification d’accès',save:'Enregistrer l’accès source',more:'Plus',history:'Historique d’accès source',empty:'Aucun accès accordé.' },
  en:{ title:'Share Form with branches',note:'Authorize only the branches allowed to use this Form. Managers see their granted source and Form questions from campaign setup, without credentials or connection sync. Revoking access disables its bindings while retaining history; granting access again does not reactivate them.',branch:'Authorized source branch',active:'Allow Form use',reason:'Source access change reason',save:'Save source access',more:'More',history:'Source access history',empty:'No access granted for this Form.' },
} as const;
export function SourceResourceAccess({ connectionId,formId,locale,branches,api }: { connectionId:string;formId:string;locale:Locale;
  branches:{ id:string;name:string }[];api:Api }) {
  const t=labels[locale];const root=`/api/sources/meta/connections/${connectionId}/resources/${formId}/access`;
  const [items,setItems]=useState<Grant[]>([]);const [after,setAfter]=useState<string|null>(null);
  const [branchId,setBranchId]=useState('');const selected=useRef('');selected.current=branchId;
  const [active,setActive]=useState(true);const [reason,setReason]=useState('');
  const [history,setHistory]=useState<History[]>([]);const [before,setBefore]=useState<number|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const current=items.find((g)=>g.branch_id===branchId);
  async function run(work:()=>Promise<void>) { setBusy(true);setError('');try { await work(); } catch (failure) { setError(String(failure)); } finally { setBusy(false); } }
  async function load(next?:string) {
    const result=await api<{ items:Grant[];nextAfter:string|null }>(root+(next ? '?after='+next : ''));
    setItems((old)=>next ? [...old,...result.items] : result.items);setAfter(result.nextAfter);
  }
  async function loadHistory(id:string,next?:number) {
    const result=await api<{ items:History[];nextBefore:number|null }>(root+'/'+id+'/history'+(next ? '?beforeVersion='+next : ''));
    if (selected.current!==id) return;setHistory((old)=>next ? [...old,...result.items] : result.items);setBefore(result.nextBefore);
  }
  useEffect(()=> { void run(()=>load()); },[]);
  useEffect(()=> { setActive(current?.active ?? true);setReason('');setHistory([]);setBefore(null);
    if (branchId) void run(()=>loadHistory(branchId)); },[branchId,current?.version]);
  async function save() {
    await api(root+'/'+branchId,{ method:'PUT',body:JSON.stringify({ version:current?.version ?? 0,active,reason }) });await load();
  }
  return <section className="panel source-resource-access"><h4>{t.title}</h4><p>{t.note}</p>{error && <p role="alert" className="error">{error}</p>}
    {!items.length && <p>{t.empty}</p>}<ul>{items.map((g)=><li key={g.branch_id}>{g.name} · v{g.version} · {g.active ? 'ACTIVE' : 'INACTIVE'} · {g.change_reason}</li>)}</ul>
    {after && <button disabled={busy} onClick={()=>void run(()=>load(after))}>{t.more}</button>}
    <form className="workflow-form" onSubmit={(event)=> { event.preventDefault();void run(save); }}>
      <label>{t.branch}<select aria-label={t.branch} required disabled={busy} value={branchId} onChange={(event)=>setBranchId(event.target.value)}><option value="">—</option>
        {branches.map((b)=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <label className="check-row"><input type="checkbox" disabled={busy} checked={active} onChange={(event)=>setActive(event.target.checked)}/>{t.active}</label>
      <label>{t.reason}<textarea aria-label={t.reason} required maxLength={500} disabled={busy} value={reason} onChange={(event)=>setReason(event.target.value)}/></label>
      <button disabled={busy || !branchId}>{t.save}</button>
    </form>{branchId && <><h4>{t.history}</h4><ul>{history.map((h)=><li key={h.version}>v{h.version} · {h.active ? 'ACTIVE' : 'INACTIVE'} · {h.created_at} · {h.reason}</li>)}</ul>
      {before && <button disabled={busy} onClick={()=>void run(()=>loadHistory(branchId,before))}>{t.more}</button>}</>}
  </section>;
}
