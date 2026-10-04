import { useEffect,useState } from 'react';
type Locale='ar'|'fr'|'en';type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Entry={ sourceKey:string;kind:'CONTACT_NAME'|'CONTACT_PHONE'|'CONTACT_EMAIL'|'LEAD_FIELD';fieldId?:string;
  transform:'TEXT'|'NUMBER'|'BOOLEAN'|'LIST'|'CURRENCY';optionMap:{ source:string;target:string }[] };
type Target={ id:string;key:string;label:string;field_type:string;value_mode:string;required_stage:string;options:{ value:string;label:string;active:boolean }[] };
type Suggestion=Pick<Entry,'kind'|'fieldId'|'transform'|'sourceKey'>;
type Detail={ latest:{ version:number;status:string;entries:Entry[];targets:Target[];redacted:boolean }|null;publishedVersion:number|null;
  bindingVersion:number;connectionVersion:number;resourceVersion:number;configured:boolean;issues:string[];draftWarnings:string[];intakeReady:false;
  questions:{ key:string|null;label:string|null;type:string;options:{ key:string|null;value:string|null }[] }[] };
type Preview={ valid:boolean;contact:Record<string,string>;fields:{ fieldId:string;value:unknown }[];errors:{ sourceKey:string|null;code:string }[];warnings:string[] };
type History={ version:number;status:string;reason:string;createdAt:string;entries:Entry[];redacted:boolean };
const labels={
  ar:{ title:'ربط حقول المصدر',note:'تُطبق النسخة المنشورة فقط على المعالجة المقبلة؛ حفظ Draft لا يبدل النسخة المنشورة. Preview لا تنشئ Lead ولا تغير البيانات. لا تمحو نسخة Mapping بيانات Source أو Operational السابقة؛ إعادة المعالجة الصريحة تنفذ مع intake.',add:'إضافة ربط حقل',source:'حقل المصدر',target:'حقل المنصة',transform:'تحويل القيمة',remove:'إزالة ربط الحقل',suggest:'اقتراح الربط',name:'اسم Contact',phone:'هاتف Contact',email:'بريد Contact',reason:'سبب تغيير Mapping',draft:'حفظ Mapping كمسودة',publish:'نشر Mapping',preview:'معاينة Mapping',samples:'قيم Source للمعاينة (قيمة في كل سطر)',refresh:'تحديث Mapping',more:'المزيد',history:'تاريخ Mapping',noKey:'السؤال لا يملك key وحيدة؛ لا يمكن تخمين الربط.',optionSource:'قيمة خيار المصدر',optionTarget:'قيمة خيار المنصة',optionAdd:'إضافة تحويل خيار',optionRemove:'إزالة تحويل الخيار',status:'حالة Mapping',ready:'الإعداد منشور وصالح؛ استقبال Leads ما زال غير مهيأ.',rules:'TEXT قيمة واحدة؛ NUMBER رقم عشري؛ BOOLEAN true/false فقط؛ LIST قيمة لكل سطر؛ CURRENCY تستعمل عملة الحقل المحددة. كل قيمة تفحص بقواعد الحقل.',valid:'المعاينة صحيحة',invalid:'المعاينة تحتوي أخطاء' },
  fr:{ title:'Mapping des champs source',note:'Seule la version publiée sera utilisée pour les prochaines soumissions ; un brouillon ne remplace pas cette version. La prévisualisation ne crée aucun prospect et ne modifie aucune donnée. Le mapping ne réécrit pas les données source ou opérationnelles ; le retraitement explicite accompagne l’intake.',add:'Ajouter un mapping',source:'Champ source',target:'Champ de plateforme',transform:'Transformation',remove:'Retirer le mapping',suggest:'Suggérer le mapping',name:'Nom du Contact',phone:'Téléphone du Contact',email:'Email du Contact',reason:'Motif de modification du mapping',draft:'Enregistrer le brouillon',publish:'Publier le mapping',preview:'Prévisualiser le mapping',samples:'Valeurs source de prévisualisation (une par ligne)',refresh:'Actualiser le mapping',more:'Plus',history:'Historique du mapping',noKey:'Question sans clé unique ; aucune clé ne sera devinée.',optionSource:'Valeur d’option source',optionTarget:'Valeur d’option cible',optionAdd:'Ajouter une conversion d’option',optionRemove:'Retirer la conversion',status:'État du mapping',ready:'Configuration publiée et valide ; la réception des prospects reste non configurée.',rules:'TEXT : une valeur ; NUMBER : décimal ; BOOLEAN : true/false ; LIST : une valeur par ligne ; CURRENCY : devise du champ. Chaque valeur est validée.',valid:'Prévisualisation valide',invalid:'Erreurs de prévisualisation' },
  en:{ title:'Source field mapping',note:'Only the published version will apply to new submissions; a draft does not replace it. Preview creates no lead and changes no data. Mapping does not rewrite prior source or operational data; explicit reprocessing accompanies intake.',add:'Add field mapping',source:'Source field',target:'Platform field',transform:'Value transformation',remove:'Remove field mapping',suggest:'Suggest mapping',name:'Contact name',phone:'Contact phone',email:'Contact email',reason:'Mapping change reason',draft:'Save mapping draft',publish:'Publish mapping',preview:'Preview mapping',samples:'Source preview values (one per line)',refresh:'Refresh mapping',more:'More',history:'Mapping history',noKey:'Question has no unique key; mapping cannot guess one.',optionSource:'Source option value',optionTarget:'Platform option value',optionAdd:'Add option conversion',optionRemove:'Remove option conversion',status:'Mapping status',ready:'Configuration is published and valid; lead intake remains unconfigured.',rules:'TEXT: one value; NUMBER: decimal; BOOLEAN: true/false only; LIST: one value per line; CURRENCY: the field’s configured currency. Every value is validated.',valid:'Preview is valid',invalid:'Preview contains errors' },
} as const;
export function SourceFieldMapping({ campaignId,bindingId,locale,api,onChanged }: { campaignId:string;bindingId:string;locale:Locale;api:Api;onChanged:()=>Promise<void> }) {
  const t=labels[locale];const root=`/api/sources/campaigns/${campaignId}/bindings/${bindingId}/mapping`;
  const [detail,setDetail]=useState<Detail|null>(null);const [entries,setEntries]=useState<Entry[]>([]);const [targets,setTargets]=useState<Target[]>([]);
  const [suggestions,setSuggestions]=useState<Suggestion[]>([]);const [after,setAfter]=useState<string|null>(null);
  const [samples,setSamples]=useState<Record<string,string>>({});const [reason,setReason]=useState('');
  const [preview,setPreview]=useState<Preview|null>(null);const [history,setHistory]=useState<History[]>([]);const [before,setBefore]=useState<number|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function run(work:()=>Promise<void>) { setBusy(true);setError('');try { await work(); } catch (failure) { setError(String(failure)); } finally { setBusy(false); } }
  async function load(next?:string) {
    const targetResult=await api<{ items:Target[];nextAfter:string|null;suggestions:Suggestion[] }>(root+'/targets'+(next ? '?after='+next : ''));
    if (next) { setTargets((old)=>[...new Map([...old,...targetResult.items].map((item)=>[item.id,item])).values()]);setSuggestions((old)=>[...new Map([...old,...targetResult.suggestions].map((item)=>[item.sourceKey,item])).values()]); }
    else { const result=await api<Detail>(root);setDetail(result);setEntries(result.latest?.entries ?? []);setReason('');setPreview(null);
      setTargets([...new Map([...(result.latest?.targets ?? []),...targetResult.items].map((item)=>[item.id,item])).values()]);setSuggestions(targetResult.suggestions); }
    setAfter(targetResult.nextAfter);
  }
  async function loadHistory(next?:number) { const result=await api<{ items:History[];nextBefore:number|null }>(root+'/history'+(next ? '?beforeVersion='+next : ''));
    setHistory((old)=>next ? [...old,...result.items] : result.items);setBefore(result.nextBefore); }
  useEffect(()=> { void run(async()=> { await load();await loadHistory(); }); },[]);
  const sourceQuestions=detail?.questions.filter((q)=>q.key && detail.questions.filter((other)=>other.key===q.key).length===1) ?? [];
  function change(index:number,value:Entry) { setEntries((old)=>old.map((entry,i)=>i===index ? value : entry));setPreview(null); }
  function targetTransform(type:string):Entry['transform'] { return ['NUMBER','PERCENTAGE','DURATION'].includes(type) ? 'NUMBER' : type==='BOOLEAN' ? 'BOOLEAN'
    : type==='CURRENCY' ? 'CURRENCY' : ['MULTI_SELECT','TAGS'].includes(type) ? 'LIST' : 'TEXT'; }
  const versions=()=>({ bindingVersion:detail!.bindingVersion,connectionVersion:detail!.connectionVersion,resourceVersion:detail!.resourceVersion });
  async function save(status:'DRAFT'|'PUBLISHED') { await api(root,{ method:'PUT',body:JSON.stringify({ ...versions(),version:detail!.latest?.version ?? 0,entries,status,reason }) });
    await load();await loadHistory();await onChanged(); }
  async function check() { const result=await api<Preview>(root+'/preview',{ method:'POST',body:JSON.stringify({ ...versions(),entries,
    values:sourceQuestions.map((q)=>({ key:q.key!,values:(Object.hasOwn(samples,q.key!) ? samples[q.key!]! : '').split('\n').filter((v)=>v.trim()) })) }) });setPreview(result); }
  function suggest() {
    const used=new Set(entries.map((e)=>e.kind==='LEAD_FIELD' ? 'FIELD:'+e.fieldId : e.kind));
    const added:Entry[]=[];for (const s of suggestions) { const id=s.kind==='LEAD_FIELD' ? 'FIELD:'+s.fieldId : s.kind;
      if (used.has(id) || entries.some((e)=>e.sourceKey===s.sourceKey)) continue;used.add(id);added.push({ ...s,optionMap:[] }); }
    setEntries([...entries,...added].slice(0,100));setPreview(null);
  }
  if (!detail) return <section className="panel source-field-mapping"><h4>{t.title}</h4>{error && <p role="alert" className="error">{error}</p>}</section>;
  return <section className="panel source-field-mapping"><h4>{t.title}</h4><p>{t.note}</p><p>{t.rules}</p>{error && <p role="alert" className="error">{error}</p>}
    <p>{t.status}: {detail.latest?.status ?? '—'} · v{detail.latest?.version ?? 0} · Published v{detail.publishedVersion ?? '—'}</p>
    {detail.configured ? <p>{t.ready}</p> : <ul>{detail.issues.map((issue)=><li key={issue}>{issue}</li>)}</ul>}
    {!!detail.draftWarnings.length && <ul>{detail.draftWarnings.map((warning)=><li key={warning}>{warning}</li>)}</ul>}
    {detail.questions.some((q)=>!q.key || detail.questions.filter((other)=>other.key===q.key).length>1) && <p>{t.noKey}</p>}
    <div className="actions"><button disabled={busy || entries.length>=100 || !sourceQuestions.length} onClick={()=> { setEntries([...entries,{ sourceKey:sourceQuestions[0]!.key!,kind:'CONTACT_NAME',transform:'TEXT',optionMap:[] }]);setPreview(null); }}>{t.add}</button>
      <button disabled={busy} onClick={suggest}>{t.suggest}</button><button className="secondary" disabled={busy} onClick={()=>void run(load)}>{t.refresh}</button></div>
    {entries.map((entry,index)=> { const target=targets.find((f)=>f.id===entry.fieldId);const question=detail.questions.find((q)=>q.key===entry.sourceKey);
      return <fieldset className="panel mapping-entry" key={index}><legend>{index+1}</legend><div className="workflow-form">
        <label>{t.source}<select aria-label={`${t.source} ${index+1}`} disabled={busy} value={entry.sourceKey} onChange={(event)=>change(index,{ ...entry,sourceKey:event.target.value })}>
          {!sourceQuestions.some((q)=>q.key===entry.sourceKey) && <option value={entry.sourceKey}>{entry.sourceKey} · unavailable</option>}
          {sourceQuestions.map((q)=><option key={q.key!} value={q.key!}>{q.label ?? q.key} · {q.key} · {q.type}</option>)}</select></label>
        <label>{t.target}<select aria-label={`${t.target} ${index+1}`} disabled={busy} value={entry.kind==='LEAD_FIELD' ? 'FIELD:'+entry.fieldId : entry.kind} onChange={(event)=> {
          const value=event.target.value;const field=targets.find((f)=>'FIELD:'+f.id===value);change(index,field ? { ...entry,kind:'LEAD_FIELD',fieldId:field.id,transform:targetTransform(field.field_type),optionMap:[] }
            : { sourceKey:entry.sourceKey,kind:value as Entry['kind'],transform:'TEXT',optionMap:[] }); }}>
          <option value="CONTACT_NAME">{t.name}</option><option value="CONTACT_PHONE">{t.phone}</option><option value="CONTACT_EMAIL">{t.email}</option>
          {targets.map((f)=><option key={f.id} value={'FIELD:'+f.id}>{f.label} · {f.field_type} · {f.required_stage}</option>)}</select></label>
        <label>{t.transform}<select aria-label={`${t.transform} ${index+1}`} disabled={busy} value={entry.transform} onChange={(event)=>change(index,{ ...entry,transform:event.target.value as Entry['transform'] })}>
          {['TEXT','NUMBER','BOOLEAN','LIST','CURRENCY'].map((v)=><option key={v} value={v}>{v}</option>)}</select></label>
        <button className="secondary" disabled={busy} onClick={()=> { setEntries(entries.filter((_,i)=>i!==index));setPreview(null); }}>{t.remove}</button>
      </div>
      {!!question?.options.length && <p>{question.options.map((o)=>`${o.key ?? '—'}: ${o.value ?? '—'}`).join(' · ')}</p>}
      {target && ['SINGLE_SELECT','MULTI_SELECT','STATUS','INTEREST','TAGS'].includes(target.field_type) && <>
        {entry.optionMap.map((option,i)=><div className="workflow-form" key={i}><label>{t.optionSource}<input aria-label={`${t.optionSource} ${index+1}.${i+1}`} maxLength={512} disabled={busy} value={option.source}
          onChange={(event)=>change(index,{ ...entry,optionMap:entry.optionMap.map((o,j)=>j===i ? { ...o,source:event.target.value } : o) })}/></label>
          <label>{t.optionTarget}{target.field_type==='TAGS' ? <input maxLength={100} value={option.target} disabled={busy} onChange={(event)=>change(index,{ ...entry,optionMap:entry.optionMap.map((o,j)=>j===i ? { ...o,target:event.target.value } : o) })}/>
            : <select aria-label={`${t.optionTarget} ${index+1}.${i+1}`} disabled={busy} value={option.target} onChange={(event)=>change(index,{ ...entry,optionMap:entry.optionMap.map((o,j)=>j===i ? { ...o,target:event.target.value } : o) })}><option value="">—</option>
              {target.options.filter((o)=>o.active).map((o)=><option value={o.value} key={o.value}>{o.label}</option>)}</select>}</label>
          <button className="secondary" disabled={busy} onClick={()=>change(index,{ ...entry,optionMap:entry.optionMap.filter((_,j)=>j!==i) })}>{t.optionRemove}</button></div>)}
        <button disabled={busy || entry.optionMap.length>=100} onClick={()=>change(index,{ ...entry,optionMap:[...entry.optionMap,{ source:'',target:'' }] })}>{t.optionAdd}</button>
      </>}
    </fieldset>; })}
    {after && <button disabled={busy} onClick={()=>void run(()=>load(after))}>{t.more}</button>}
    <label>{t.reason}<textarea aria-label={t.reason} disabled={busy} maxLength={500} value={reason} onChange={(event)=>setReason(event.target.value)}/></label>
    <div className="actions"><button disabled={busy || !reason.trim()} onClick={()=>void run(()=>save('DRAFT'))}>{t.draft}</button><button disabled={busy || !reason.trim()} onClick={()=>void run(()=>save('PUBLISHED'))}>{t.publish}</button></div>
    <h5>{t.samples}</h5><div className="workflow-form">{sourceQuestions.map((q)=><label key={q.key!}>{q.label ?? q.key}<textarea aria-label={'Preview '+q.key} disabled={busy} maxLength={20000} value={Object.hasOwn(samples,q.key!) ? samples[q.key!]! : ''}
      onChange={(event)=> { setSamples({ ...samples,[q.key!]:event.target.value });setPreview(null); }}/></label>)}</div>
    <button disabled={busy} onClick={()=>void run(check)}>{t.preview}</button>{preview && <section role="status" className="panel"><p>{preview.valid ? t.valid : t.invalid}</p>
      <ul>{preview.errors.map((e,i)=><li key={i}>{e.sourceKey ?? '—'} · {e.code}</li>)}{preview.warnings.map((w)=><li key={w}>{w}</li>)}</ul>
      <ul>{Object.entries(preview.contact).map(([key,value])=><li key={key}>{key}: {value}</li>)}{preview.fields.map((f)=><li key={f.fieldId}>{targets.find((t)=>t.id===f.fieldId)?.label ?? f.fieldId}: {JSON.stringify(f.value)}</li>)}</ul></section>}
    <h5>{t.history}</h5><ul>{history.map((h)=><li key={h.version}>v{h.version} · {h.status} · {h.reason} · {h.createdAt}
      <ul>{h.entries.map((e,i)=><li key={i}>{e.sourceKey} → {e.kind==='LEAD_FIELD' ? targets.find((t)=>t.id===e.fieldId)?.label ?? e.fieldId : e.kind} · {e.transform}</li>)}</ul></li>)}</ul>
    {before && <button disabled={busy} onClick={()=>void run(()=>loadHistory(before))}>{t.more}</button>}
  </section>;
}
