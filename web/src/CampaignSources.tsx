import { useEffect,useRef,useState } from 'react';
import { SourceFieldMapping } from './SourceFieldMapping';
import { SourceSubmissions } from './SourceSubmissions';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Locale='ar'|'fr'|'en';
type Connection={ id:string;name:string;branch_id:string|null;status:string;version:number };
type Resource={ id:string;name:string;external_id:string;active:boolean;connection_version:number;provider_status:string|null;
  questions:{ key:string|null;label:string|null;type:string }[] };
type Binding={ id:string;connection_id:string;resource_id:string;version:number;active:boolean;external_campaign_id:string|null;
  external_adset_id:string|null;external_ad_id:string|null;form_name:string;form_external_id:string;page_name:string;page_external_id:string;
  connection_name:string;current_connection_version:number;issues:string[] };
type History={ version:number;reason:string;created_at:string;snapshot:{ active:boolean;externalCampaignId:string|null;externalAdSetId:string|null;externalAdId:string|null } };
const labels={
  ar:{ title:'ربط مصادر الحملة',intro:'كل شرط خارجي محدد يجب أن يتطابق مع الحدث؛ الشرط الفارغ يقبل أي قيمة. يمنع النظام تفعيل ربطين قد يطابقان الحدث نفسه، حتى عبر فروع مختلفة. تفعيل الربط وحده لا يهيئ استقبال Leads.',connection:'اتصال مصدر الحملة',page:'Page مصدر الحملة',form:'Form مصدر الحملة',campaign:'External Campaign ID (اختياري)',adset:'External Ad Set ID (اختياري)',ad:'External Ad ID (اختياري)',active:'تفعيل اختيار المصدر',reason:'سبب تغيير الربط',add:'ربط Form جديدة',save:'حفظ ربط المصدر',cancel:'إلغاء تعديل الربط',edit:'تعديل الربط',disable:'تعطيل الربط',history:'تاريخ الربط',more:'المزيد',refresh:'تحديث الربط',empty:'لا يوجد ربط مصدر للحملة.',shared:'مصدر مشترك مخول لهذا الفرع',questions:'أسئلة المصدر',note:'نشر Mapping صالحة مطلوب. استقبال Webhook غير مهيأ؛ الحملة غير جاهزة لتلقي Leads.' },
  fr:{ title:'Sources de la campagne',intro:'Chaque critère renseigné doit correspondre à l’événement ; un critère vide accepte toute valeur. Deux liaisons pouvant correspondre au même événement ne peuvent être actives, même entre agences. Activer une liaison ne valide pas la réception des prospects.',connection:'Connexion source de campagne',page:'Page source de campagne',form:'Formulaire source de campagne',campaign:'External Campaign ID (facultatif)',adset:'External Ad Set ID (facultatif)',ad:'External Ad ID (facultatif)',active:'Activer la sélection source',reason:'Motif de modification de liaison',add:'Relier un nouveau formulaire',save:'Enregistrer la liaison source',cancel:'Annuler la modification',edit:'Modifier la liaison',disable:'Désactiver la liaison',history:'Historique de liaison',more:'Plus',refresh:'Actualiser les liaisons',empty:'Aucune liaison source.',shared:'Source partagée autorisée pour cette agence',questions:'Questions source',note:'Un mapping publié valide est requis. La réception webhook reste non configurée ; la campagne ne peut pas recevoir de prospects.' },
  en:{ title:'Campaign source bindings',intro:'Every specified external criterion must match the event; an empty criterion accepts any value. Bindings that could match the same event cannot both be active, including across branches. Activating a binding alone does not configure lead intake.',connection:'Campaign source connection',page:'Campaign source Page',form:'Campaign source Form',campaign:'External Campaign ID (optional)',adset:'External Ad Set ID (optional)',ad:'External Ad ID (optional)',active:'Enable source selection',reason:'Binding change reason',add:'Bind another Form',save:'Save source binding',cancel:'Cancel binding edit',edit:'Edit binding',disable:'Disable binding',history:'Binding history',more:'More',refresh:'Refresh bindings',empty:'No campaign source binding.',shared:'Shared source authorized for this branch',questions:'Source questions',note:'A valid published mapping is required. Webhook intake remains unconfigured; the campaign cannot receive leads.' },
} as const;
export function CampaignSources({ campaignId,locale,api }: { campaignId:string;locale:Locale;api:Api }) {
  const t=labels[locale];const root='/api/sources/campaigns/'+campaignId;
  const [bindings,setBindings]=useState<Binding[]>([]);const [after,setAfter]=useState<string|null>(null);
  const [connections,setConnections]=useState<Connection[]>([]);const [connectionAfter,setConnectionAfter]=useState<string|null>(null);
  const [connectionId,setConnectionId]=useState('');const selectedConnection=useRef('');selectedConnection.current=connectionId;
  const [pages,setPages]=useState<Resource[]>([]);const [pageAfter,setPageAfter]=useState<string|null>(null);
  const [pageId,setPageId]=useState('');const selectedPage=useRef('');selectedPage.current=pageId;
  const [forms,setForms]=useState<Resource[]>([]);const [formAfter,setFormAfter]=useState<string|null>(null);const [formId,setFormId]=useState('');
  const [editing,setEditing]=useState<Binding|null>(null);const [showEditor,setShowEditor]=useState(false);
  const [fields,setFields]=useState({ campaign:'',adset:'',ad:'',active:false,reason:'' });const [requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const [historyId,setHistoryId]=useState('');const historySelection=useRef('');historySelection.current=historyId;
  const [mappingId,setMappingId]=useState('');
  const [history,setHistory]=useState<History[]>([]);const [before,setBefore]=useState<number|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function run(work:()=>Promise<void>) { setBusy(true);setError('');try { await work(); } catch (failure) { setError(String(failure)); } finally { setBusy(false); } }
  async function load(next?:string) {
    const result=await api<{ items:Binding[];nextAfter:string|null }>(root+'/bindings'+(next ? '?after='+next : ''));
    setBindings((old)=>next ? [...old,...result.items] : result.items);setAfter(result.nextAfter);
  }
  async function loadConnections(next?:string) {
    const result=await api<{ items:Connection[];nextAfter:string|null }>(root+'/connections'+(next ? '?after='+next : ''));
    setConnections((old)=>next ? [...old,...result.items] : result.items);setConnectionAfter(result.nextAfter);
  }
  async function resources(id:string,kind:'PAGE'|'FORM',parent?:string,next?:string) {
    const query=new URLSearchParams({ kind,...(parent ? { pageId:parent } : {}),...(next ? { after:next } : {}) });
    const result=await api<{ items:Resource[];nextAfter:string|null }>(root+'/connections/'+id+'/resources?'+query);
    if (selectedConnection.current!==id || (parent && selectedPage.current!==parent)) return;
    if (kind==='PAGE') { setPages((old)=>next ? [...old,...result.items] : result.items);setPageAfter(result.nextAfter); }
    else { setForms((old)=>next ? [...old,...result.items] : result.items);setFormAfter(result.nextAfter); }
  }
  async function loadHistory(id:string,next?:number) {
    const result=await api<{ items:History[];nextBefore:number|null }>(root+'/bindings/'+id+'/history'+(next ? '?beforeVersion='+next : ''));
    if (historySelection.current!==id) return;setHistory((old)=>next ? [...old,...result.items] : result.items);setBefore(result.nextBefore);
  }
  useEffect(()=> { void run(async()=> { await Promise.all([load(),loadConnections()]); }); },[]);
  useEffect(()=> { setPages([]);setPageId('');setForms([]);setFormId('');setPageAfter(null);setFormAfter(null);
    if (connectionId) void run(()=>resources(connectionId,'PAGE')); },[connectionId]);
  useEffect(()=> { setForms([]);setFormId('');setFormAfter(null);if (connectionId && pageId) void run(()=>resources(connectionId,'FORM',pageId)); },[pageId]);
  useEffect(()=> { setHistory([]);setBefore(null);if (historyId) void run(()=>loadHistory(historyId)); },[historyId]);
  const conn=connections.find((c)=>c.id===connectionId);const form=forms.find((f)=>f.id===formId);
  function start(binding?:Binding) {
    setEditing(binding ?? null);setShowEditor(true);setRequestId(crypto.randomUUID());setError('');
    setFields({ campaign:binding?.external_campaign_id ?? '',adset:binding?.external_adset_id ?? '',ad:binding?.external_ad_id ?? '',active:binding?.active ?? false,reason:'' });
    if (!binding) { setConnectionId('');setPageId('');setFormId(''); }
  }
  async function save() {
    const body={ externalCampaignId:fields.campaign || null,externalAdSetId:fields.adset || null,externalAdId:fields.ad || null,active:fields.active,reason:fields.reason,
      connectionVersion:editing?.current_connection_version ?? conn!.version,...(editing ? { version:editing.version } : { connectionId,formId,requestId }) };
    await api(root+'/bindings'+(editing ? '/'+editing.id : ''),{ method:editing ? 'PUT' : 'POST',body:JSON.stringify(body) });
    setShowEditor(false);setEditing(null);await load();if (historyId) await loadHistory(historyId);
  }
  async function disable(binding:Binding) {
    await api(root+'/bindings/'+binding.id,{ method:'PUT',body:JSON.stringify({ externalCampaignId:binding.external_campaign_id,
      externalAdSetId:binding.external_adset_id,externalAdId:binding.external_ad_id,active:false,reason:fields.reason,
      connectionVersion:binding.current_connection_version,version:binding.version }) });
    await load();if (historyId===binding.id) await loadHistory(binding.id);
  }
  const input=(key:'campaign'|'adset'|'ad',label:string)=><label>{label}<input aria-label={label} maxLength={30} pattern="[0-9]{1,30}"
    value={fields[key]} onChange={(event)=>setFields({ ...fields,[key]:event.target.value })}/></label>;
  return <section className="panel campaign-sources"><h3>{t.title}</h3><p>{t.intro}</p><p>{t.note}</p>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions"><button disabled={busy} onClick={()=>start()}>{t.add}</button><button className="secondary" disabled={busy} onClick={()=>void run(async()=> { await Promise.all([load(),loadConnections()]); })}>{t.refresh}</button></div>
    {!bindings.length && <p>{t.empty}</p>}
    {bindings.map((b)=><section className="panel" key={b.id} data-binding-id={b.id}><h4>{b.form_name} · {b.form_external_id}</h4>
      <p>{b.connection_name} · {b.page_name} · {b.page_external_id} · v{b.version} · {b.active ? 'ACTIVE' : 'INACTIVE'}</p>
      <p>Campaign: {b.external_campaign_id ?? '—'} · Ad Set: {b.external_adset_id ?? '—'} · Ad: {b.external_ad_id ?? '—'}</p>
      <ul>{b.issues.map((issue)=><li key={issue}>{issue}</li>)}</ul><div className="actions">
        <button disabled={busy} onClick={()=>start(b)}>{t.edit}</button><button className="secondary" disabled={busy} onClick={()=>setHistoryId(b.id)}>{t.history}</button>
        <button disabled={busy} onClick={()=>setMappingId(b.id)}>Field Mapping</button></div>
    </section>)}
    {after && <button disabled={busy} onClick={()=>void run(()=>load(after))}>{t.more}</button>}
    {showEditor && <form className="workflow-form" onSubmit={(event)=> { event.preventDefault();void run(save); }}>
      {editing ? <p>{editing.connection_name} · {editing.page_name} · {editing.form_name}</p> : <>
        <label>{t.connection}<select required aria-label={t.connection} value={connectionId} onChange={(event)=>setConnectionId(event.target.value)}><option value="">—</option>
          {connections.map((c)=><option key={c.id} value={c.id}>{c.name} · {c.status}{!c.branch_id ? ` · ${t.shared}` : ''}</option>)}</select></label>
        {connectionAfter && <button type="button" disabled={busy} onClick={()=>void run(()=>loadConnections(connectionAfter))}>{t.more}</button>}
        <label>{t.page}<select required aria-label={t.page} value={pageId} onChange={(event)=>setPageId(event.target.value)}><option value="">—</option>
          {pages.map((p)=><option key={p.id} value={p.id}>{p.name} · {p.external_id}</option>)}</select></label>
        {pageAfter && <button type="button" disabled={busy} onClick={()=>void run(()=>resources(connectionId,'PAGE',undefined,pageAfter))}>{t.more}</button>}
        <label>{t.form}<select required aria-label={t.form} value={formId} onChange={(event)=>setFormId(event.target.value)}><option value="">—</option>
          {forms.map((f)=><option key={f.id} value={f.id}>{f.name} · {f.external_id} · {f.provider_status ?? '—'}</option>)}</select></label>
        {formAfter && <button type="button" disabled={busy} onClick={()=>void run(()=>resources(connectionId,'FORM',pageId,formAfter))}>{t.more}</button>}
        {form && <div><h4>{t.questions}</h4><ul>{form.questions.map((q,i)=><li key={i}>{q.label ?? q.key ?? q.type} · {q.type}</li>)}</ul></div>}
      </>}
      {input('campaign',t.campaign)}{input('adset',t.adset)}{input('ad',t.ad)}
      <label className="check-row"><input type="checkbox" checked={fields.active} onChange={(event)=>setFields({ ...fields,active:event.target.checked })}/>{t.active}</label>
      <label>{t.reason}<textarea aria-label={t.reason} required maxLength={500} value={fields.reason} onChange={(event)=>setFields({ ...fields,reason:event.target.value })}/></label>
      <div className="actions"><button disabled={busy || (!editing && !formId)}>{t.save}</button>
        {editing?.active && <button type="button" className="secondary" disabled={busy || !fields.reason.trim()} onClick={()=>void run(async()=> { await disable(editing);setShowEditor(false);setEditing(null); })}>{t.disable}</button>}
        <button type="button" className="secondary" onClick={()=>setShowEditor(false)}>{t.cancel}</button></div>
    </form>}
    {historyId && <section className="panel"><h4>{t.history}</h4><ul>{history.map((h)=><li key={h.version}>v{h.version} · {h.snapshot.active ? 'ACTIVE' : 'INACTIVE'} · {h.created_at} · {h.reason}
      <p>Campaign: {h.snapshot.externalCampaignId ?? '—'} · Ad Set: {h.snapshot.externalAdSetId ?? '—'} · Ad: {h.snapshot.externalAdId ?? '—'}</p></li>)}</ul>
      {before && <button disabled={busy} onClick={()=>void run(()=>loadHistory(historyId,before))}>{t.more}</button>}</section>}
    {mappingId && <SourceFieldMapping key={mappingId} campaignId={campaignId} bindingId={mappingId} locale={locale} api={api} onChanged={load}/>}
    <SourceSubmissions key={campaignId} campaignId={campaignId} locale={locale} api={api}/>
  </section>;
}
