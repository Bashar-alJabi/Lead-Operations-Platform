import { useEffect, useState } from 'react';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Sample={ id:string;kind:string;mime:string;sizeBytes:number;state:string;version:number;attemptCount:number;errorCode:string|null;usable:boolean };
type Attempt={ id:string;attempt_number:number;outcome:string;error_code:string|null;started_at:string };
type Rule={ mimes:string[];maxBytes:number };
type Page={ items:Sample[];nextAfter:string|null;rules:Record<string,Rule> };
export function TemplateSamples({ connectionId,status,locale,api }:{ connectionId:string;status:string;locale:'ar'|'fr'|'en';api:Api }) {
  const t={
    ar:{ title:'عينات اعتماد القوالب',note:'ارفع عينة للفحص ثم لاعتماد المزود. العينة لا تُرسل للعميل ولا تعني اعتماد قالب. يجب أن يكون رمز الاتصال تابعاً لتطبيق Meta المصرح بالرفع.',
      kind:'نوع عينة القالب',image:'صورة',video:'فيديو',document:'PDF',file:'ملف عينة الاعتماد',upload:'رفع عينة للفحص',refresh:'تحديث العينات',more:'المزيد من العينات',
      download:'تحميل العينة المفحوصة',retry:'إعادة رفع العينة للمزود',reason:'سبب إعادة محاولة العينة بعد معالجة الفشل',attempts:'محاولات رفع العينة',moreAttempts:'المزيد من المحاولات',
      ready:'مرجع المزود جاهز',stale:'مرجع غير صالح للإعداد الحالي؛ ارفع عينة جديدة',limit:'الحد',none:'لا عينات' },
    fr:{ title:'Échantillons de modèles',note:'Téléversez un fichier pour analyse puis validation du fournisseur. Il ne sera pas envoyé au client et ne signifie pas que le modèle est approuvé. Le jeton doit appartenir à une application Meta autorisée.',
      kind:'Type d’échantillon',image:'Image',video:'Vidéo',document:'PDF',file:'Fichier d’approbation',upload:'Téléverser et analyser',refresh:'Actualiser les échantillons',more:'Plus d’échantillons',
      download:'Télécharger le fichier analysé',retry:'Relancer le téléversement fournisseur',reason:'Motif après correction du problème',attempts:'Tentatives de téléversement',moreAttempts:'Plus de tentatives',
      ready:'Référence fournisseur prête',stale:'Référence obsolète ; téléversez un nouvel échantillon',limit:'Limite',none:'Aucun échantillon' },
    en:{ title:'Template approval samples',note:'Upload a sample for scanning and provider approval. It is never sent to the customer and does not mean a template is approved. The connection token must belong to a Meta app authorized to upload.',
      kind:'Template sample type',image:'Image',video:'Video',document:'PDF',file:'Approval sample file',upload:'Upload sample for scanning',refresh:'Refresh samples',more:'More samples',
      download:'Download scanned sample',retry:'Retry sample provider upload',reason:'Reason after fixing sample failure',attempts:'Sample upload attempts',moreAttempts:'More attempts',
      ready:'Provider reference ready',stale:'Reference is stale; upload a new sample',limit:'Limit',none:'No samples' },
  }[locale];
  const [items,setItems]=useState<Sample[]>([]);const [after,setAfter]=useState<string|null>(null);const [rules,setRules]=useState<Record<string,Rule>>({});
  const [kind,setKind]=useState<'image'|'video'|'document'>('image');const [file,setFile]=useState<File|null>(null);const [key,setKey]=useState(()=>crypto.randomUUID());
  const [fileVersion,setFileVersion]=useState(0);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [reasons,setReasons]=useState<Record<string,string>>({});
  const [attempts,setAttempts]=useState<Record<string,{ items:Attempt[];after:string|null }>>({});
  const base=`/api/messaging/connections/${connectionId}/template-samples`;
  async function load(cursor?:string) {
    const page=await api<Page>(base+(cursor ? '?after='+encodeURIComponent(cursor) : ''));
    setItems((old)=>cursor ? [...old,...page.items] : page.items);setAfter(page.nextAfter);setRules(page.rules);
  }
  useEffect(()=> { setItems([]);setFile(null);setKey(crypto.randomUUID());setFileVersion((old)=>old+1);setReasons({});setAttempts({});
    void load().catch((failure)=>setError(String(failure))); },[connectionId]);
  async function act(task:()=>Promise<void>) { setBusy(true);setError('');try { await task(); }catch(failure) { setError(String(failure)); }finally { setBusy(false); } }
  async function upload() {
    if (!file || !rules[kind]) return;
    if (!rules[kind]!.mimes.includes(file.type) || file.size>rules[kind]!.maxBytes || !file.size) throw new Error('MEDIA_TYPE_OR_SIZE_INVALID');
    await api<Sample>(base+'?'+new URLSearchParams({ kind,mime:file.type,key }),{
      method:'POST',headers:{ 'Content-Type':'application/octet-stream' },body:file });
    setFile(null);setKey(crypto.randomUUID());setFileVersion((old)=>old+1);await load();
  }
  async function download(sample:Sample) {
    const response=await fetch(`/api/messaging/template-samples/${sample.id}/download`,{ credentials:'same-origin' });
    if (!response.ok) throw new Error((await response.json()).error ?? 'DOWNLOAD_FAILED');
    const url=URL.createObjectURL(await response.blob());const anchor=document.createElement('a');anchor.href=url;
    anchor.download=response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'sample.bin';
    anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function history(id:string,cursor?:string) {
    const page=await api<{ items:Attempt[];nextAfter:string|null }>(`/api/messaging/template-samples/${id}/attempts`+(cursor ? '?after='+cursor : ''));
    setAttempts((old)=>({ ...old,[id]:{ items:cursor ? [...(old[id]?.items ?? []),...page.items] : page.items,after:page.nextAfter } }));
  }
  return <section className="panel"><h3>{t.title}</h3><p>{t.note}</p>{error && <p role="alert" className="error">{error}</p>}
    <form className="workflow-form" onSubmit={(event)=> { event.preventDefault();void act(upload); }}>
      <label>{t.kind}<select aria-label={t.kind} value={kind} disabled={busy} onChange={(event)=> { setKind(event.target.value as typeof kind);setFile(null);setKey(crypto.randomUUID());setFileVersion((old)=>old+1); }}>
        <option value="image">{t.image}</option><option value="video">{t.video}</option><option value="document">{t.document}</option></select></label>
      {rules[kind] && <p>{t.limit}: {(rules[kind]!.maxBytes/1024/1024).toFixed(1)} MiB · {rules[kind]!.mimes.join(', ')}</p>}
      <label>{t.file}<input key={fileVersion} type="file" required disabled={busy || status==='DISABLED'} accept={rules[kind]?.mimes.join(',')}
        onChange={(event)=> { setFile(event.target.files?.[0] ?? null);setKey(crypto.randomUUID()); }} /></label>
      <button disabled={busy || !file || !rules[kind] || status==='DISABLED'}>{t.upload}</button>
    </form>
    <button type="button" className="secondary" disabled={busy} onClick={()=>void act(()=>load())}>{t.refresh}</button>
    {!items.length && <p>{t.none}</p>}<ul>{items.map((sample)=><li key={sample.id}>
      <strong>{sample.kind}</strong> · {sample.mime} · {(sample.sizeBytes/1024).toFixed(1)} KiB · {sample.state} · {sample.attemptCount}
      {sample.errorCode && <p role="status">{sample.errorCode}</p>}
      {sample.state==='READY' && <p>{sample.usable ? t.ready : t.stale}</p>}
      <div className="actions"><button type="button" className="secondary" disabled={busy || sample.errorCode==='MEDIA_CONTENT_REJECTED'} onClick={()=>void act(()=>download(sample))}>{t.download}</button>
        <button type="button" className="secondary" disabled={busy} onClick={()=>void act(()=>history(sample.id))}>{t.attempts}</button></div>
      {sample.state==='FAILED' && <div><label>{t.reason}<input maxLength={500} value={reasons[sample.id] ?? ''}
        onChange={(event)=>setReasons((old)=>({ ...old,[sample.id]:event.target.value }))} /></label>
        <button type="button" disabled={busy || status==='DISABLED' || (reasons[sample.id]?.trim().length ?? 0)<10} onClick={()=>void act(async()=> {
          await api(`/api/messaging/template-samples/${sample.id}/retry`,{ method:'POST',body:JSON.stringify({ version:sample.version,reason:reasons[sample.id]!.trim() }) });
          setReasons((old)=>({ ...old,[sample.id]:'' }));await load();await history(sample.id);
        })}>{t.retry}</button></div>}
      {attempts[sample.id] && <ul>{attempts[sample.id]!.items.map((attempt)=><li key={attempt.id}>{attempt.attempt_number} · {attempt.outcome} · {attempt.error_code} · {new Date(attempt.started_at).toLocaleString(locale)}</li>)}</ul>}
      {attempts[sample.id]?.after && <button type="button" disabled={busy} onClick={()=>void act(()=>history(sample.id,attempts[sample.id]!.after!))}>{t.moreAttempts}</button>}
    </li>)}</ul>{after && <button type="button" disabled={busy} onClick={()=>void act(()=>load(after))}>{t.more}</button>}
  </section>;
}
