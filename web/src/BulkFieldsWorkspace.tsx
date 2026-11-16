import {useEffect,useRef,useState} from 'react';
import {FieldInput,type FieldRow} from './LeadFields.js';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Selected={id:string;version:number;label:string};
type Snapshot={id:string;leadVersion:number;definitionVersion:number;bindingVersion:number;valueVersion?:number;status:string;error?:string};
type Result={id:string;status:string;error?:string};
type RequestBody={requestId:string;confirmed:true;fieldId:string;operation:string;value:unknown;items:Omit<Snapshot,'status'|'error'>[]};
const labels={
 en:{title:'Bulk campaign fields',basis:'Uses each lead’s current field permissions and versions. Status and tags belong to the selected Campaign field. Each result is independent.',field:'Field to change',value:'New value or tags',operation:'Field operation',set:'Set value',add:'Add tags',remove:'Remove tags',apply:'Review and apply field change',retry:'Retry the same request',refresh:'Reload field choices',empty:'Select leads with an editable campaign field.',loading:'Checking selected leads…',error:'Unable to complete this request. The same request can be retried safely. Refresh selection if access or versions changed.',result:'Field results by lead',confirm:'Apply this field operation? Eligible leads',of:'of selected',notices:'Some selected leads are no longer eligible. Their failure is retained in the results.',yes:'Yes',no:'No'},
 ar:{title:'حقول الحملات جماعيًا',basis:'تُراجع صلاحية ونسخة الحقل لكل فرصة حاليًا. الحالة والوسوم تتبع حقل الحملة المختار. نتيجة كل عنصر مستقلة.',field:'الحقل المطلوب تغييره',value:'القيمة أو الوسوم الجديدة',operation:'عملية الحقل',set:'تعيين القيمة',add:'إضافة وسوم',remove:'إزالة وسوم',apply:'مراجعة وتطبيق تغيير الحقل',retry:'إعادة الطلب نفسه',refresh:'تحديث خيارات الحقول',empty:'حدّد فرصًا ذات حقل حملة قابل للتحرير.',loading:'جاري فحص الفرص المحددة…',error:'تعذّر إكمال الطلب. يمكن إعادة الطلب نفسه بأمان. حدّث التحديد إذا تغيرت الصلاحية أو النسخ.',result:'نتائج الحقول لكل فرصة',confirm:'تطبيق عملية الحقل؟ الفرص المؤهلة',of:'من المحدد',notices:'بعض الفرص المحددة لم تعد مؤهلة. تُحفظ نتيجة فشلها ضمن النتائج.',yes:'نعم',no:'لا'},
 fr:{title:'Champs de campagne en lot',basis:'Chaque prospect conserve ses droits et versions actuels. Statut et tags appartiennent au champ de campagne choisi. Résultats indépendants.',field:'Champ à modifier',value:'Nouvelle valeur ou tags',operation:'Opération du champ',set:'Définir la valeur',add:'Ajouter des tags',remove:'Retirer des tags',apply:'Vérifier et appliquer le champ',retry:'Réessayer la même requête',refresh:'Actualiser les champs',empty:'Sélectionnez des prospects avec un champ modifiable.',loading:'Vérification de la sélection…',error:'Impossible de terminer. La même requête peut être réessayée sans doublon. Actualisez la sélection si les droits ou versions ont changé.',result:'Résultats des champs par prospect',confirm:'Appliquer cette opération ? Prospects éligibles',of:'sur sélectionnés',notices:'Certains prospects ne sont plus éligibles. Leur échec figure dans les résultats.',yes:'Oui',no:'Non'},
} as const;
export function BulkFieldsWorkspace({locale,api,selected}:{locale:'ar'|'en'|'fr';api:Api;selected:Selected[]}){
 const t=labels[locale],epoch=useRef(0),key=selected.map(l=>l.id).join(','),[fields,setFields]=useState<FieldRow[]>([]),[fieldId,setFieldId]=useState(''),[value,setValue]=useState<unknown>(null),[tags,setTags]=useState(''),[operation,setOperation]=useState('SET'),
  [results,setResults]=useState<Result[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(false),[retry,setRetry]=useState<{body:RequestBody;failed:Result[]}|null>(null);
 const field=fields.find(f=>f.id===fieldId);
 async function choices(){const n=++epoch.current;setFields([]);setFieldId('');setValue(null);setTags('');setRetry(null);setError(false);
  if(!selected[0]){setBusy(false);return;}setBusy(true);try{const r=await api<{items:FieldRow[]}>('/api/leads/'+selected[0].id+'/fields');if(n===epoch.current)setFields(r.items.filter(f=>f.editable&&f.definition_active&&f.binding_active));}catch{if(n===epoch.current){setResults([]);setError(true);}}finally{if(n===epoch.current)setBusy(false);}}
 useEffect(()=>{setResults([]);setBusy(false);void choices();return()=>{epoch.current++;};},[key]);
 // Locale does not change Human authority or intent: keep any in-flight/retry request.
 useEffect(()=>{setError(false);},[locale]);
 async function send(body:RequestBody,failed:Result[],n:number){
  setRetry({body,failed});const r=await api<{results:Result[]}>('/api/leads/bulk/fields',{method:'POST',body:JSON.stringify(body)});
  if(n!==epoch.current)return;setRetry(r.results.some(i=>i.error==='BULK_REQUEST_PAUSED'||i.error==='BULK_ITEM_RETRYABLE')?{body,failed}:null);setResults([...failed,...r.results]);
 }
 async function apply(){const n=++epoch.current;setBusy(true);setError(false);setResults([]);setRetry(null);
  try{if(!field?.definition_version)throw Error();const r=await api<{items:Snapshot[]}>('/api/leads/bulk/fields/preview',{method:'POST',body:JSON.stringify({fieldId,definitionVersion:field.definition_version,ids:selected.map(l=>l.id)})});if(n!==epoch.current)return;
   const wanted=new Map(selected.map(l=>[l.id,l.version])),eligible=r.items.filter(i=>i.status==='ELIGIBLE'&&i.leadVersion===wanted.get(i.id)),failed=r.items.filter(i=>!eligible.includes(i)).map(i=>({id:i.id,status:'FAILED',error:i.error??'LEAD_VERSION_CONFLICT'}));
   setResults(failed);if(!eligible.length)return;
   if(!window.confirm(`${t.confirm}: ${eligible.length} ${t.of}: ${selected.length}\n${field.label} · ${operation}\n${failed.length?t.notices:''}`))return;
   const raw=field.field_type==='TAGS'?tags.split(',').map(v=>v.trim()).filter(Boolean):field.field_type==='DATETIME'&&typeof value==='string'?new Date(value).toISOString():value;
   const body:RequestBody={requestId:crypto.randomUUID(),confirmed:true,fieldId,operation,value:raw,items:eligible.map(({id,leadVersion,definitionVersion,bindingVersion,valueVersion})=>({id,leadVersion,definitionVersion,bindingVersion,...(valueVersion?{valueVersion}:{})}))};
   await send(body,failed,n);
  }catch{if(n===epoch.current)setError(true);}finally{if(n===epoch.current)setBusy(false);}}
 async function resend(){if(!retry)return;const n=++epoch.current;setBusy(true);setError(false);try{await send(retry.body,retry.failed,n);}catch{if(n===epoch.current)setError(true);}finally{if(n===epoch.current)setBusy(false);}}
 return <section className="panel" data-bulk-fields><h3>{t.title}</h3><p>{t.basis}</p>{error&&<p role="alert">{t.error}</p>}{busy&&<p role="status">{t.loading}</p>}
  <button type="button" disabled={busy||!selected.length} onClick={()=>void choices()}>{t.refresh}</button>
  <form onSubmit={e=>{e.preventDefault();void apply();}}><fieldset className="workflow-form" disabled={busy}>
   <label>{t.field}<select aria-label={t.field} disabled={busy} value={fieldId} onChange={e=>{setFieldId(e.target.value);setValue(null);setTags('');setOperation('SET');setRetry(null);setResults([]);}}><option value="">—</option>{fields.map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
   {field&&<><label>{t.operation}<select aria-label={t.operation} value={operation} disabled={busy} onChange={e=>{setOperation(e.target.value);setRetry(null);}}><option value="SET">{t.set}</option>{field.field_type==='TAGS'&&<><option value="ADD_TAGS">{t.add}</option><option value="REMOVE_TAGS">{t.remove}</option></>}</select></label>
    <label>{t.value}{field.field_type==='TAGS'?<input aria-label={t.value} disabled={busy} value={tags} onChange={e=>{setTags(e.target.value);setRetry(null);}}/>:<FieldInput field={field} value={value} onChange={v=>{setValue(v);setRetry(null);}} ariaLabel={t.value} booleanLabels={{yes:t.yes,no:t.no}}/>}</label></>}
   <button disabled={busy||!field||!selected.length||selected.length>50}>{t.apply}</button>
  </fieldset></form>{!fields.length&&!busy&&<p>{t.empty}</p>}{retry&&<button disabled={busy} onClick={()=>void resend()}>{t.retry}</button>}
  {!!results.length&&<div data-bulk-field-results role="status"><h4>{t.result}</h4>{results.map(r=><p key={r.id} data-bulk-result={r.id}>{selected.find(l=>l.id===r.id)?.label??r.id}: {r.status}{r.error?' · '+r.error:''}</p>)}</div>}
 </section>;
}
