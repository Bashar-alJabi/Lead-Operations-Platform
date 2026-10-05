import { useEffect,useRef,useState } from 'react';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'fr'|'en';
type Item={ submission_id:string;external_event_id:string;state:string;version:number;evaluations:number;error_code:string|null;codes:string[];
  mapping_version:number|null;binding_version:number|null;mapped_fields:number;mapped_contact_fields:number;source_timestamp:string;lead_id:string|null };
type History={ version:number;state:string;reason:string;created_at:string;snapshot:{ errorCode:string|null;mappingVersion:number|null;codes:string[] } };
const labels={
  ar:{ title:'مراجعة بيانات المصدر',hint:'تُفحص البيانات الأصلية باستخدام الربط وMapping المنشورة الحالية. VALIDATED تعني صلاحية التحويل؛ لم تُنشأ Contact أوLead من هذه البيانات بعد.',empty:'لا توجد بيانات مصدر في هذا النطاق.',refresh:'تحديث بيانات المصدر',state:'حالة معالجة المصدر',all:'كل الحالات',history:'تاريخ معالجة المصدر',reason:'سبب إعادة معالجة المصدر',reprocess:'إعادة معالجة المصدر',more:'المزيد',fields:'حقول محولة',contact:'حقول Contact محولة' },
  fr:{ title:'Revue des soumissions source',hint:'Les données originales sont évaluées avec la liaison et le mapping publié actuels. VALIDATED confirme la conversion ; aucun Contact ou Lead n’a encore été créé.',empty:'Aucune soumission dans ce périmètre.',refresh:'Actualiser les soumissions',state:'État de traitement source',all:'Tous les états',history:'Historique du traitement source',reason:'Motif de retraitement source',reprocess:'Retraiter la soumission',more:'Plus',fields:'Champs convertis',contact:'Champs Contact convertis' },
  en:{ title:'Source submission review',hint:'Original data is evaluated against current bindings and published mapping. VALIDATED confirms conversion; no Contact or Lead has been created from these submissions yet.',empty:'No source submissions in this scope.',refresh:'Refresh source submissions',state:'Source processing state',all:'All states',history:'Source processing history',reason:'Source reprocess reason',reprocess:'Reprocess source submission',more:'More',fields:'Mapped fields',contact:'Mapped Contact fields' },
} as const;
export function SourceSubmissions({ connectionId,campaignId,locale,api }: { connectionId?:string;campaignId?:string;locale:Locale;api:Api }) {
  const t=labels[locale];const [items,setItems]=useState<Item[]>([]);const [cursor,setCursor]=useState<string|null>(null);const [state,setState]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [reasons,setReasons]=useState<Record<string,string>>({});
  const [history,setHistory]=useState<History[]>([]);const [historyId,setHistoryId]=useState('');const selected=useRef('');selected.current=historyId;
  const [before,setBefore]=useState<number|null>(null);const selection=useRef('');const scope=JSON.stringify([connectionId,campaignId,state]);selection.current=scope;
  async function run(work:()=>Promise<void>) { setBusy(true);setError('');try { await work(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  async function load(next?:string) {
    const key=scope;const query=new URLSearchParams();if (connectionId) query.set('connectionId',connectionId);if (campaignId) query.set('campaignId',campaignId);
    if (state) query.set('state',state);if (next) query.set('cursor',next);
    const result=await api<{ items:Item[];nextCursor:string|null }>('/api/sources/submissions?'+query);
    if (selection.current!==key) return;setItems((old)=>next ? [...old,...result.items] : result.items);setCursor(result.nextCursor);
  }
  async function loadHistory(id:string,version?:number) {
    const result=await api<{ items:History[];nextBefore:number|null }>(`/api/sources/submissions/${id}/history`+(version ? '?beforeVersion='+version : ''));
    if (selected.current!==id) return;setHistory((old)=>version ? [...old,...result.items] : result.items);setBefore(result.nextBefore);
  }
  useEffect(()=> { setItems([]);setCursor(null);setHistoryId('');setHistory([]);setReasons({});void run(()=>load()); },[scope]);
  useEffect(()=> { setHistory([]);setBefore(null);if (historyId) void run(()=>loadHistory(historyId)); },[historyId]);
  async function reprocess(item:Item) {
    await api(`/api/sources/submissions/${item.submission_id}/reprocess`,{ method:'POST',body:JSON.stringify({ version:item.version,reason:reasons[item.submission_id] ?? '' }) });
    setReasons((old)=>({ ...old,[item.submission_id]:'' }));await load();if (historyId===item.submission_id) await loadHistory(item.submission_id);
  }
  return <section className="panel source-submissions"><h4>{t.title}</h4><p>{t.hint}</p>{error && <p role="alert" className="error">{error}</p>}
    <label>{t.state}<select aria-label={t.state} value={state} onChange={(e)=>setState(e.target.value)}><option value="">{t.all}</option>
      {['PENDING','NEEDS_ATTENTION','VALIDATED'].map((s)=><option key={s}>{s}</option>)}</select></label>
    <button className="secondary" disabled={busy} onClick={()=>void run(()=>load())}>{t.refresh}</button>{!items.length && <p>{t.empty}</p>}
    {items.map((item)=><section className="panel" key={item.submission_id} data-submission-id={item.submission_id}><h5>Lead {item.external_event_id}</h5>
      <p>{item.state} · v{item.version} · {item.source_timestamp} · #{item.evaluations}</p><p>{item.submission_id}</p>
      {item.error_code && <p>{item.error_code}</p>}<ul>{item.codes.map((code)=><li key={code}>{code}</li>)}</ul>
      <p>Mapping v{item.mapping_version ?? '—'} · Binding v{item.binding_version ?? '—'} · {t.fields}: {item.mapped_fields} · {t.contact}: {item.mapped_contact_fields}</p>
      <button className="secondary" disabled={busy} onClick={()=>setHistoryId(item.submission_id)}>{t.history}</button>
      {item.state!=='PENDING' && !item.lead_id && <><label>{t.reason}<input aria-label={t.reason} maxLength={500} value={reasons[item.submission_id] ?? ''}
        onChange={(e)=>setReasons({ ...reasons,[item.submission_id]:e.target.value })}/></label><button disabled={busy || !reasons[item.submission_id]?.trim()}
          onClick={()=>void run(()=>reprocess(item))}>{t.reprocess}</button></>}
    </section>)}{cursor && <button disabled={busy} onClick={()=>void run(()=>load(cursor))}>{t.more}</button>}
    {historyId && <section className="panel"><h5>{t.history}</h5><ul>{history.map((h)=><li key={h.version}>v{h.version} · {h.state} · {h.created_at} · {h.reason}
      <p>{h.snapshot.errorCode} · Mapping v{h.snapshot.mappingVersion ?? '—'}</p><ul>{h.snapshot.codes.map((c)=><li key={c}>{c}</li>)}</ul></li>)}</ul>
      {before && <button disabled={busy} onClick={()=>void run(()=>loadHistory(historyId,before))}>{t.more}</button>}</section>}
  </section>;
}
