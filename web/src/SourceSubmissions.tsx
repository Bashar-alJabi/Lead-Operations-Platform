import { useEffect,useRef,useState } from 'react';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'fr'|'en';
type Item={ submission_id:string;external_event_id:string;state:string;version:number;evaluations:number;error_code:string|null;codes:string[];
  mapping_version:number|null;binding_version:number|null;mapped_fields:number;mapped_contact_fields:number;source_timestamp:string;lead_id:string|null };
type History={ version:number;state:string;reason:string;created_at:string;snapshot:{ errorCode:string|null;mappingVersion:number|null;codes:string[] } };
type ContactReview={ version:number;fingerprint:string;contact:{ name:string;phone:string|null;email:string|null }|null;
  items:{ id:string;name:string;phone:string|null;email:string|null }[];nextAfter:string|null;adminRequired:boolean };
const matchingLabels={
  ar:{ review:'مراجعة مطابقة Contact',choose:'اختيار Contact المطابقة',reason:'سبب اعتماد المطابقة',resolve:'اعتماد المطابقة وإنشاء Lead',admin:'تتطلب هذه المطابقة مراجعة Super Admin بسبب نطاق جهات الاتصال.',refresh:'تحديث المطابقة',created:'Lead المنشأة' },
  fr:{ review:'Revoir la correspondance Contact',choose:'Choisir le Contact correspondant',reason:'Motif de la correspondance',resolve:'Confirmer et créer le Lead',admin:'Cette correspondance nécessite un Super Admin en raison du périmètre des Contacts.',refresh:'Actualiser la correspondance',created:'Lead créé' },
  en:{ review:'Review Contact match',choose:'Matching Contact',reason:'Contact match reason',resolve:'Confirm match and create Lead',admin:'This match requires a Super Admin because of Contact scope.',refresh:'Refresh Contact match',created:'Created Lead' },
} as const;
const labels={
  ar:{ title:'مراجعة بيانات المصدر',hint:'VALIDATED تعني صلاحية التحويل وانتظار إنشاء Lead. PROCESSED تعني نجاح الإنشاء والمطابقة والحقول والتوزيع؛ البيانات الأصلية محفوظة.',empty:'لا توجد بيانات مصدر في هذا النطاق.',refresh:'تحديث بيانات المصدر',state:'حالة معالجة المصدر',all:'كل الحالات',history:'تاريخ معالجة المصدر',reason:'سبب إعادة معالجة المصدر',reprocess:'إعادة معالجة المصدر',more:'المزيد',fields:'حقول محولة',contact:'حقول Contact محولة' },
  fr:{ title:'Revue des soumissions source',hint:'VALIDATED confirme la conversion et attend la création. PROCESSED confirme le Lead, la correspondance, les champs et le routage ; les données originales sont conservées.',empty:'Aucune soumission dans ce périmètre.',refresh:'Actualiser les soumissions',state:'État de traitement source',all:'Tous les états',history:'Historique du traitement source',reason:'Motif de retraitement source',reprocess:'Retraiter la soumission',more:'Plus',fields:'Champs convertis',contact:'Champs Contact convertis' },
  en:{ title:'Source submission review',hint:'VALIDATED confirms conversion and awaits creation. PROCESSED confirms Lead creation, matching, fields and routing; original data is preserved.',empty:'No source submissions in this scope.',refresh:'Refresh source submissions',state:'Source processing state',all:'All states',history:'Source processing history',reason:'Source reprocess reason',reprocess:'Reprocess source submission',more:'More',fields:'Mapped fields',contact:'Mapped Contact fields' },
} as const;
export function SourceSubmissions({ connectionId,campaignId,locale,api }: { connectionId?:string;campaignId?:string;locale:Locale;api:Api }) {
  const t=labels[locale];const mt=matchingLabels[locale];const [items,setItems]=useState<Item[]>([]);const [cursor,setCursor]=useState<string|null>(null);const [state,setState]=useState('');
  const [reviewId,setReviewId]=useState('');const [review,setReview]=useState<ContactReview|null>(null);const [choice,setChoice]=useState('');const [matchReason,setMatchReason]=useState('');
  const reviewSelection=useRef('');reviewSelection.current=reviewId;
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
  async function loadReview(id:string,after?:string) {
    const result=await api<ContactReview>(`/api/sources/submissions/${id}/contact-review`+(after ? '?after='+after : ''));
    if (reviewSelection.current!==id) return;
    setReview((old)=>after && old?.fingerprint===result.fingerprint ? { ...result,items:[...old.items,...result.items] } : result);
    if (!after) setChoice('');
  }
  useEffect(()=> { setItems([]);setCursor(null);setHistoryId('');setHistory([]);setReviewId('');setReview(null);setReasons({});void run(()=>load()); },[scope]);
  useEffect(()=> { setReview(null);setChoice('');setMatchReason('');if (reviewId) void run(()=>loadReview(reviewId)); },[reviewId]);
  useEffect(()=> { setHistory([]);setBefore(null);if (historyId) void run(()=>loadHistory(historyId)); },[historyId]);
  async function reprocess(item:Item) {
    await api(`/api/sources/submissions/${item.submission_id}/reprocess`,{ method:'POST',body:JSON.stringify({ version:item.version,reason:reasons[item.submission_id] ?? '' }) });
    setReasons((old)=>({ ...old,[item.submission_id]:'' }));await load();if (historyId===item.submission_id) await loadHistory(item.submission_id);
  }
  return <section className="panel source-submissions"><h4>{t.title}</h4><p>{t.hint}</p>{error && <p role="alert" className="error">{error}</p>}
    <label>{t.state}<select aria-label={t.state} value={state} onChange={(e)=>setState(e.target.value)}><option value="">{t.all}</option>
      {['PENDING','NEEDS_ATTENTION','VALIDATED','PROCESSED'].map((s)=><option key={s}>{s}</option>)}</select></label>
    <button className="secondary" disabled={busy} onClick={()=>void run(()=>load())}>{t.refresh}</button>{!items.length && <p>{t.empty}</p>}
    {items.map((item)=><section className="panel" key={item.submission_id} data-submission-id={item.submission_id}><h5>Lead {item.external_event_id}</h5>
      <p>{item.state} · v{item.version} · {item.source_timestamp} · #{item.evaluations}</p><p>{item.submission_id}</p>
      {item.error_code && <p>{item.error_code}</p>}<ul>{item.codes.map((code)=><li key={code}>{code}</li>)}</ul>
      <p>Mapping v{item.mapping_version ?? '—'} · Binding v{item.binding_version ?? '—'} · {t.fields}: {item.mapped_fields} · {t.contact}: {item.mapped_contact_fields}</p>
      {item.lead_id && <p>{mt.created}: {item.lead_id}</p>}
      {item.error_code==='CONTACT_AMBIGUOUS' && <button disabled={busy} onClick={()=>setReviewId(item.submission_id)}>{mt.review}</button>}
      <button className="secondary" disabled={busy} onClick={()=>setHistoryId(item.submission_id)}>{t.history}</button>
      {item.state!=='PENDING' && !item.lead_id && <><label>{t.reason}<input aria-label={t.reason} maxLength={500} value={reasons[item.submission_id] ?? ''}
        onChange={(e)=>setReasons({ ...reasons,[item.submission_id]:e.target.value })}/></label><button disabled={busy || !reasons[item.submission_id]?.trim()}
          onClick={()=>void run(()=>reprocess(item))}>{t.reprocess}</button></>}
    </section>)}{cursor && <button disabled={busy} onClick={()=>void run(()=>load(cursor))}>{t.more}</button>}
    {reviewId && <section className="panel source-contact-review"><h5>{mt.review}</h5><button disabled={busy} onClick={()=>void run(()=>loadReview(reviewId))}>{mt.refresh}</button>
      {review && <><p>{review.contact?.name || '—'} · {review.contact?.phone || '—'} · {review.contact?.email || '—'}</p>
        {review.adminRequired && <p>{mt.admin}</p>}
        <label>{mt.choose}<select aria-label={mt.choose} disabled={busy || review.adminRequired} value={choice} onChange={(e)=>setChoice(e.target.value)}>
          <option value="">—</option>{review.items.map((c)=><option key={c.id} value={c.id}>{c.name || c.id} · {c.phone || '—'} · {c.email || '—'}</option>)}</select></label>
        {review.nextAfter && <button disabled={busy} onClick={()=>void run(()=>loadReview(reviewId,review.nextAfter!))}>{t.more}</button>}
        <label>{mt.reason}<input aria-label={mt.reason} maxLength={500} disabled={busy || review.adminRequired} value={matchReason} onChange={(e)=>setMatchReason(e.target.value)}/></label>
        <button disabled={busy || review.adminRequired || !choice || !matchReason.trim()} onClick={()=>void run(async()=> {
          await api(`/api/sources/submissions/${reviewId}/resolve-contact`,{ method:'POST',body:JSON.stringify({ version:review.version,fingerprint:review.fingerprint,contactId:choice,reason:matchReason }) });
          setReviewId('');setReview(null);await load();if (historyId===reviewId) await loadHistory(reviewId);
        })}>{mt.resolve}</button></>}
    </section>}
    {historyId && <section className="panel"><h5>{t.history}</h5><ul>{history.map((h)=><li key={h.version}>v{h.version} · {h.state} · {h.created_at} · {h.reason}
      <p>{h.snapshot.errorCode} · Mapping v{h.snapshot.mappingVersion ?? '—'}</p><ul>{h.snapshot.codes.map((c)=><li key={c}>{c}</li>)}</ul></li>)}</ul>
      {before && <button disabled={busy} onClick={()=>void run(()=>loadHistory(historyId,before))}>{t.more}</button>}</section>}
  </section>;
}
