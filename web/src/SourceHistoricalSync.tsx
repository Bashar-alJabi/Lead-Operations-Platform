import { useEffect,useRef,useState } from 'react';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'fr'|'en';
type Job={ id:string;formId:string;state:string;phase:string;version:number;from:string;until:string;pages:number;scanned:number;attempts:number;errorCode:string|null;createdAt:string;
  counts?:{ matched:number;staged:number;known:number;imported:number;duplicates:number;conflicts:number;processed:number;attention:number } };
type Item={ externalLeadId:string;sourceTimestamp:string;result:string;submissionId:string|null;processingState:string|null };
type Attempt={ number:number;state:string;errorCode:string|null;startedAt:string };
const labels={
  en:{ title:'Historical Meta sync',hint:'Preview the records Meta currently makes available for this Form. The UTC range includes From and excludes Until. The application filters original timestamps while scanning available pages. Preview creates no operational Leads. Confirming import queues the existing mapping, Contact review and Lead workflow; it sends no customer message.',from:'Historical From (UTC)',until:'Historical Until (UTC)',preview:'Create historical preview',refresh:'Refresh historical jobs',more:'More historical jobs',select:'View historical job',reason:'Historical action reason',confirm:'Confirm historical import',cancel:'Cancel historical job',retry:'Retry historical job',results:'Historical results',moreResults:'More historical results',attempts:'Historical attempts',moreAttempts:'More historical attempts',summary:'Matched / known / imported / duplicates / conflicts / Leads created / Needs Attention',scan:'Pages / scanned',notice:'Imported means preserved Source Submissions, not guaranteed Lead creation. Review unresolved records in Source submissions. Unknown total until preview finishes.',empty:'No historical jobs.',range:'UTC range',state:'State',id:'Provider Lead ID',time:'Original timestamp',result:'Result / processing' },
  ar:{ title:'مزامنة Meta التاريخية',hint:'عاين السجلات التي يتيحها Meta حاليًا لهذه Form. النطاق UTC يشمل البداية ويستثني النهاية؛ يطبق التطبيق النطاق على timestamps الأصلية أثناء قراءة الصفحات المتاحة. المعاينة لا تنشئ Leads تشغيلية. تأكيد الاستيراد يمر عبر Mapping ومراجعة Contact ومسار Lead الحالي، ولا يرسل رسالة للعميل.',from:'بداية السجل التاريخي (UTC)',until:'نهاية السجل التاريخي (UTC)',preview:'إنشاء معاينة تاريخية',refresh:'تحديث المزامنات التاريخية',more:'مزامنات تاريخية إضافية',select:'عرض المزامنة التاريخية',reason:'سبب الإجراء التاريخي',confirm:'تأكيد الاستيراد التاريخي',cancel:'إلغاء المزامنة التاريخية',retry:'إعادة محاولة المزامنة التاريخية',results:'نتائج المزامنة التاريخية',moreResults:'نتائج تاريخية إضافية',attempts:'محاولات المزامنة التاريخية',moreAttempts:'محاولات تاريخية إضافية',summary:'المطابقة / المعروفة / المستوردة / المكررة / التعارضات / Leads المنشأة / تحتاج مراجعة',scan:'الصفحات / السجلات المقروءة',notice:'المستوردة تعني Source Submissions محفوظة؛ إنشاء Lead يعتمد القواعد الحالية. راجع الحالات غير المحسومة في مراجعة المصدر. العدد النهائي غير معروف حتى انتهاء المعاينة.',empty:'لا توجد مزامنات تاريخية.',range:'نطاق UTC',state:'الحالة',id:'معرف Lead لدى المزود',time:'التوقيت الأصلي',result:'النتيجة / المعالجة' },
  fr:{ title:'Synchronisation historique Meta',hint:'Prévisualisez les enregistrements actuellement disponibles pour ce formulaire chez Meta. La plage UTC inclut le début et exclut la fin ; les dates originales sont filtrées par l’application pendant la pagination. La prévisualisation ne crée aucun prospect opérationnel. L’import suit le mapping et la vérification Contact existants, sans envoyer de message client.',from:'Début historique (UTC)',until:'Fin historique (UTC)',preview:'Créer une prévisualisation historique',refresh:'Actualiser les synchronisations historiques',more:'Autres synchronisations historiques',select:'Voir la synchronisation historique',reason:'Motif de l’action historique',confirm:'Confirmer l’import historique',cancel:'Annuler la synchronisation historique',retry:'Réessayer la synchronisation historique',results:'Résultats historiques',moreResults:'Autres résultats historiques',attempts:'Tentatives historiques',moreAttempts:'Autres tentatives historiques',summary:'Correspondances / connues / importées / doublons / conflits / prospects créés / à vérifier',scan:'Pages / enregistrements lus',notice:'Importé signifie une soumission source conservée, sans garantir la création du prospect. Consultez les soumissions à vérifier. Total inconnu avant la fin de la prévisualisation.',empty:'Aucune synchronisation historique.',range:'Plage UTC',state:'État',id:'Identifiant du prospect fournisseur',time:'Date originale',result:'Résultat / traitement' },
} as const;
const states:Record<string,[string,string,string]>={ PENDING:['قيد انتظار المعاينة','Prévisualisation en attente','Preview queued'],RUNNING:['المعاينة جارية','Prévisualisation en cours','Preview running'],PREVIEW_READY:['المعاينة جاهزة','Prévisualisation prête','Preview ready'],IMPORTING:['الاستيراد جارٍ','Import en cours','Import running'],SUCCEEDED:['حفظ الاستيراد مكتمل','Import conservé','Import preserved'],FAILED:['فشلت المزامنة','Échec','Failed'],BLOCKED:['المزامنة محجوبة','Bloquée','Blocked'],CANCELLED:['ألغيت المزامنة','Annulée','Cancelled'] };
const contextHint=['إذا تغيرت إعدادات الاتصال أوالموارد، أكمل الإعداد الحالي ثم ألغِ هذه المهمة وأنشئ معاينة جديدة. لا تستبدل المعاينة السابقة. إعادة المحاولة تستأنف فقط ضمن الإصدارات والصلاحيات الأصلية.',
  'Si la configuration ou les ressources ont changé, terminez la configuration actuelle, annulez cette tâche et créez une nouvelle prévisualisation. Une reprise exige les versions et autorisations originales.',
  'If connection configuration or resources changed, complete current setup, cancel this job and create a new preview. Retry resumes only with the original versions and current authorization.'];
export function SourceHistoricalSync({ locale,connection,form,api }:{ locale:Locale;connection:{ id:string;version:number;status:string };form?:{ id:string;version:number;active:boolean;connection_version:number };api:Api }) {
  const t=labels[locale];const root=`/api/sources/meta/connections/${connection.id}/historical`;
  const [jobs,setJobs]=useState<Job[]>([]);const [cursor,setCursor]=useState<string|null>(null);const [selected,setSelected]=useState<Job|null>(null);
  const selectedId=useRef('');const mounted=useRef(true);
  const [items,setItems]=useState<Item[]>([]);const [after,setAfter]=useState<string|null>(null);const [attempts,setAttempts]=useState<Attempt[]>([]);const [before,setBefore]=useState<number|null>(null);
  const [from,setFrom]=useState('');const [until,setUntil]=useState('');const [reason,setReason]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const intent=useRef<{ key:string;id:string }|null>(null);
  async function run(work:()=>Promise<void>) { setBusy(true);setError('');try { await work(); } catch(e) { if (mounted.current) setError(e instanceof Error ? e.message : 'SOURCE_HISTORICAL_FAILED'); } finally { if (mounted.current) setBusy(false); } }
  async function load(next?:string) {
    const r=await api<{ items:Job[];nextCursor:string|null }>(root+(next ? '?cursor='+encodeURIComponent(next) : ''));
    if (mounted.current) { setJobs((old)=>next ? [...old,...r.items] : r.items);setCursor(r.nextCursor); }
  }
  async function results(id:string,next?:string) {
    const r=await api<{ items:Item[];nextAfter:string|null }>(root+'/'+id+'/results'+(next ? '?after='+encodeURIComponent(next) : ''));
    if (mounted.current && selectedId.current===id) { setItems((old)=>next ? [...old,...r.items] : r.items);setAfter(r.nextAfter); }
  }
  async function history(id:string,next?:number) {
    const r=await api<{ items:Attempt[];nextBefore:number|null }>(root+'/'+id+'/attempts'+(next ? '?before='+next : ''));
    if (mounted.current && selectedId.current===id) { setAttempts((old)=>next ? [...old,...r.items] : r.items);setBefore(r.nextBefore); }
  }
  async function view(id:string) {
    selectedId.current=id;setSelected(null);setItems([]);setAttempts([]);setAfter(null);setBefore(null);
    const j=await api<Job>(root+'/'+id);if (!mounted.current || selectedId.current!==id) return;
    setSelected(j);await results(id);await history(id);
  }
  useEffect(()=> { mounted.current=true;void run(()=>load());return ()=> { mounted.current=false;selectedId.current=''; }; },[connection.id]);
  async function preview() {
    if (!form) return;const key=JSON.stringify([form.id,from,until,connection.version]);
    if (intent.current?.key!==key) intent.current={ key,id:crypto.randomUUID() };
    const r=await api<{ id:string }>(root,{ method:'POST',body:JSON.stringify({ version:connection.version,formId:form.id,requestId:intent.current.id,
      from:from+':00Z',until:until+':00Z' }) });intent.current=null;await load();await view(r.id);
  }
  async function action(name:'confirm'|'cancel'|'retry') {
    if (!selected) return;const id=selected.id;
    await api(root+'/'+id+'/'+name,{ method:'POST',body:JSON.stringify({ version:selected.version,reason }) });setReason('');await load();await view(id);
  }
  const state=(value:string)=>states[value]?.[locale==='ar' ? 0 : locale==='fr' ? 1 : 2] ?? value;
  return <section className="panel source-historical"><h4>{t.title}</h4><p>{t.hint}</p><p>{t.notice}</p>{error && <p className="error" role="alert">{error}</p>}
    <form className="workflow-form" onSubmit={(event)=> { event.preventDefault();void run(preview); }}>
      <label>{t.from}<input aria-label={t.from} type="datetime-local" required value={from} onChange={(event)=>setFrom(event.target.value)}/></label>
      <label>{t.until}<input aria-label={t.until} type="datetime-local" required value={until} onChange={(event)=>setUntil(event.target.value)}/></label>
      <button disabled={busy || !form?.active || form.connection_version!==connection.version || connection.status==='DISABLED'}>{t.preview}</button>
    </form><button className="secondary" disabled={busy} onClick={()=>void run(async()=> { await load();if (selectedId.current) await view(selectedId.current); })}>{t.refresh}</button>
    {!jobs.length && <p>{t.empty}</p>}<ul>{jobs.map((j)=><li key={j.id}>{state(j.state)} · <bdi dir="ltr">{j.from} → {j.until}</bdi> · <bdi dir="ltr">{j.createdAt}</bdi>{' '}<button className="link" disabled={busy} onClick={()=>void run(()=>view(j.id))}>{t.select}</button></li>)}</ul>
    {cursor && <button disabled={busy} onClick={()=>void run(()=>load(cursor))}>{t.more}</button>}
    {selected && <section><p role="status">{t.state}: {state(selected.state)}</p><p>{t.range}: <bdi dir="ltr">{selected.from} → {selected.until}</bdi></p><p>{t.scan}: <bdi dir="ltr">{selected.pages} / {selected.scanned}</bdi></p>
      {selected.errorCode && <><p>{selected.errorCode}</p><p>{contextHint[locale==='ar' ? 0 : locale==='fr' ? 1 : 2]}</p></>}
      {selected.counts && <dl>{(['matched','known','imported','duplicates','conflicts','processed','attention'] as const).map((key,index)=><div key={key}>
        <dt>{t.summary.split('/')[index]?.trim()}</dt><dd>{selected.counts![key]}</dd></div>)}</dl>}
      {!['SUCCEEDED','CANCELLED'].includes(selected.state) && <><label>{t.reason}<textarea aria-label={t.reason} maxLength={500} value={reason} onChange={(event)=>setReason(event.target.value)}/></label>
        <div className="actions">{selected.state==='PREVIEW_READY' && <button disabled={busy || !reason.trim()} onClick={()=>void run(()=>action('confirm'))}>{t.confirm}</button>}
          {['FAILED','BLOCKED'].includes(selected.state) && <button disabled={busy || !reason.trim()} onClick={()=>void run(()=>action('retry'))}>{t.retry}</button>}
          <button className="secondary" disabled={busy || !reason.trim()} onClick={()=>void run(()=>action('cancel'))}>{t.cancel}</button></div></>}
      <h5>{t.results}</h5><div className="table-scroll"><table><thead><tr><th>{t.id}</th><th>{t.time}</th><th>{t.result}</th></tr></thead><tbody>{items.map((i)=><tr key={i.externalLeadId}><td>{i.externalLeadId}</td><td><bdi dir="ltr">{i.sourceTimestamp}</bdi></td><td>{i.result} · {i.processingState ?? '—'}</td></tr>)}</tbody></table></div>
      {after && <button disabled={busy} onClick={()=>void run(()=>results(selected.id,after))}>{t.moreResults}</button>}
      <h5>{t.attempts}</h5><ul>{attempts.map((a)=><li key={a.number}>{a.number} · {a.state} · <bdi dir="ltr">{a.startedAt}</bdi> · {a.errorCode ?? '—'}</li>)}</ul>
      {before && <button disabled={busy} onClick={()=>void run(()=>history(selected.id,before))}>{t.moreAttempts}</button>}
    </section>}
  </section>;
}
