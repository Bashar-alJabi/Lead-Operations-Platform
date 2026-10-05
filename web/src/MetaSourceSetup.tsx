import { useEffect,useRef,useState } from 'react';
import { SourceResourceAccess } from './SourceResourceAccess';
import { MetaSourceWebhook } from './MetaSourceWebhook';
import { SourceSubmissions } from './SourceSubmissions';
import { SourceHistoricalSync } from './SourceHistoricalSync';
type Locale='ar'|'fr'|'en';type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Connection={ id:string;name:string;branch_id:string|null;status:string;version:number;config:{ graphVersion:string;appId?:string };
  last_success_at:string|null;last_failure_at:string|null;last_error_code:string|null };
type Resource={ id:string;external_id:string;name:string;active:boolean;version:number;connection_version:number;provider_status:string|null;
  questions:{ key:string|null;label:string|null;type:string;options:{ key:string|null;value:string|null }[] }[] };
type Sync={ id:string;resource_kind:string;state:string;resource_count:number|null;error_code:string|null;started_at:string };
const labels={
  ar:{ title:'مصادر Meta',intro:'أنشئ تطبيق Meta للمؤسسة وأكمل App Review وصلاحيات Pages وLead Ads وLeads Access المطلوبة لدى المزود. أدخل User access token مخول لاكتشاف Pages وPage tokens، وApp Secret ورمز تحقق خاص بالتطبيق. الاتصال مستقل عن WhatsApp؛ اكتشاف الموارد لا يثبت استقبال Leads.',add:'إضافة مصدر Meta',edit:'تعديل المصدر',name:'اسم المصدر',scope:'نطاق المصدر',org:'المؤسسة',branch:'الفرع',version:'إصدار Graph API',token:'رمز وصول Meta',secret:'App Secret للمصدر',verify:'رمز تحقق المصدر',save:'حفظ المصدر',cancel:'إلغاء',select:'اختيار المصدر',pages:'Pages المتاحة',forms:'Forms المتاحة',pickPage:'اختيار Page',pickForm:'اختيار Form',discover:'اختبار واكتشاف Pages',discoverForms:'اكتشاف Forms',disable:'تعطيل المصدر',enable:'إعادة إعداد المصدر',more:'المزيد',refresh:'تحديث القائمة',history:'سجل المزامنة',status:'الحالة',questions:'أسئلة Form',hint:'الأسرار لا تعرض بعد الحفظ؛ اتركها جميعاً فارغة للاحتفاظ بها أو أدخل الثلاثة لاستبدالها.',empty:'لا توجد موارد مكتشفة.',notReady:'أكمل إعداد المصدر وراجع جاهزية Campaign قبل تفعيلها. Discovery وحدها لا تثبت Webhook أوالربط أوإنشاء Lead.',lastSuccess:'آخر نجاح',lastFailure:'آخر فشل',inactive:'غير متاحة',active:'متاحة' },
  fr:{ title:'Sources Meta',intro:'Créez une application Meta pour votre organisation avec la validation et les autorisations Pages/Lead Ads/Leads Access requises. Saisissez un jeton utilisateur autorisé à découvrir les Pages et leurs jetons, le secret et un jeton de vérification. Cette connexion est distincte de WhatsApp ; la découverte ne valide pas la réception des prospects.',add:'Ajouter une source Meta',edit:'Modifier la source',name:'Nom de la source',scope:'Portée de la source',org:'Organisation',branch:'Agence',version:'Version Graph API',token:'Jeton Meta',secret:'Secret de l’application source',verify:'Jeton de vérification source',save:'Enregistrer la source',cancel:'Annuler',select:'Choisir la source',pages:'Pages disponibles',forms:'Formulaires disponibles',pickPage:'Choisir une Page',pickForm:'Choisir un formulaire',discover:'Tester et découvrir les Pages',discoverForms:'Découvrir les formulaires',disable:'Désactiver la source',enable:'Reconfigurer la source',more:'Plus',refresh:'Actualiser',history:'Historique de synchronisation',status:'État',questions:'Questions du formulaire',hint:'Les secrets ne sont jamais réaffichés. Laissez les trois vides pour les conserver, ou remplacez les trois.',empty:'Aucune ressource découverte.',notReady:'Configurez la source et vérifiez la campagne avant son activation. La découverte seule ne valide ni Webhook, ni liaison, ni création.',lastSuccess:'Dernier succès',lastFailure:'Dernier échec',inactive:'Indisponible',active:'Disponible' },
  en:{ title:'Meta sources',intro:'Create a Meta app for your organization with the provider’s required App Review, Pages/Lead Ads permissions and Leads Access. Enter a User access token authorized to discover Pages and Page tokens, the App Secret and a private verification token. This connection is separate from WhatsApp; discovery does not verify lead delivery.',add:'Add Meta source',edit:'Edit source',name:'Source name',scope:'Source scope',org:'Organization',branch:'Branch',version:'Source Graph API version',token:'Meta access token',secret:'Source App Secret',verify:'Source verification token',save:'Save source',cancel:'Cancel',select:'Select source',pages:'Available Pages',forms:'Available Forms',pickPage:'Select Page',pickForm:'Select Form',discover:'Test and discover Pages',discoverForms:'Discover Forms',disable:'Disable source',enable:'Reconfigure source',more:'More',refresh:'Refresh catalog',history:'Sync history',status:'Status',questions:'Form questions',hint:'Secrets are never redisplayed. Leave all three blank to retain them, or replace all three.',empty:'No discovered resources.',notReady:'Complete source setup and check campaign readiness before activation. Discovery alone verifies neither Webhook, bindings nor Lead creation.',lastSuccess:'Last success',lastFailure:'Last failure',inactive:'Unavailable',active:'Available' },
} as const;
export function MetaSourceSetup({ locale,role,branches,api }: { locale:Locale;role:'SUPER_ADMIN'|'MANAGER';branches:{ id:string;name:string }[];api:Api }) {
  const t=labels[locale];const root='/api/sources/meta/connections';
  const [items,setItems]=useState<Connection[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [selectedId,setSelectedId]=useState('');const selection=useRef('');selection.current=selectedId;
  const [pages,setPages]=useState<Resource[]>([]);const [forms,setForms]=useState<Resource[]>([]);
  const [pageId,setPageId]=useState('');const pageSelection=useRef('');pageSelection.current=pageId;
  const [pageAfter,setPageAfter]=useState<string|null>(null);const [formAfter,setFormAfter]=useState<string|null>(null);const [formId,setFormId]=useState('');
  const [history,setHistory]=useState<Sync[]>([]);const [historyCursor,setHistoryCursor]=useState<string|null>(null);
  const [editor,setEditor]=useState<'new'|'edit'|null>(null);const [fields,setFields]=useState({ name:'',branchId:'',graphVersion:'',appId:'',accessToken:'',appSecret:'',verifyToken:'' });
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const selected=items.find((item)=>item.id===selectedId);const page=pages.find((item)=>item.id===pageId);const form=forms.find((item)=>item.id===formId);
  async function load(next?:string) {
    const result=await api<{ items:Connection[];nextCursor:string|null }>(root+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setItems((old)=>next ? [...old,...result.items] : result.items);setCursor(result.nextCursor);
  }
  async function resources(id:string,kind:'PAGE'|'FORM',parent?:string,next?:string) {
    const query=new URLSearchParams({ kind,...(parent ? { pageId:parent } : {}),...(next ? { after:next } : {}) });
    const result=await api<{ items:Resource[];nextAfter:string|null }>(`${root}/${id}/resources?${query}`);
    if (selection.current!==id || (parent && pageSelection.current!==parent)) return;
    if (kind==='PAGE') { setPages((old)=>next ? [...old,...result.items] : result.items);setPageAfter(result.nextAfter); }
    else { setForms((old)=>next ? [...old,...result.items] : result.items);setFormAfter(result.nextAfter); }
  }
  async function syncHistory(id:string,next?:string) {
    const result=await api<{ items:Sync[];nextCursor:string|null }>(`${root}/${id}/sync-history${next ? '?cursor='+encodeURIComponent(next) : ''}`);
    if (selection.current!==id) return;setHistory((old)=>next ? [...old,...result.items] : result.items);setHistoryCursor(result.nextCursor);
  }
  async function run(work:()=>Promise<void>) { setBusy(true);setError('');try { await work(); } catch (failure) { setError(String(failure)); } finally { setBusy(false); } }
  useEffect(()=> { void run(()=>load()); },[]);
  useEffect(()=> {
    setPages([]);setForms([]);setPageId('');setFormId('');setPageAfter(null);setFormAfter(null);setHistory([]);setHistoryCursor(null);setEditor(null);
    if (selectedId) void run(async()=> { await Promise.all([resources(selectedId,'PAGE'),syncHistory(selectedId)]); });
  },[selectedId]);
  useEffect(()=> { setForms([]);setFormId('');setFormAfter(null);if (pageId && selectedId) void run(()=>resources(selectedId,'FORM',pageId)); },[pageId]);
  async function discover(targetPage?:string) {
    if (!selected) return;
    try { await api(`${root}/${selected.id}/discover`,{ method:'POST',body:JSON.stringify({ version:selected.version,...(targetPage ? { pageId:targetPage } : {}) }) }); }
    finally { await Promise.all([load(),resources(selected.id,'PAGE'),syncHistory(selected.id),...(targetPage ? [resources(selected.id,'FORM',targetPage)] : [])]); }
  }
  function openEditor(mode:'new'|'edit') { setError('');setEditor(mode);setFields({ name:mode==='edit' ? selected!.name : '',branchId:mode==='edit' ? selected!.branch_id ?? '' : '',
    graphVersion:mode==='edit' ? selected!.config.graphVersion : '',appId:mode==='edit' ? selected!.config.appId ?? '' : '',accessToken:'',appSecret:'',verifyToken:'' }); }
  async function save() {
    const replaced=!!(fields.accessToken || fields.appSecret || fields.verifyToken);
    const body={ name:fields.name,config:{ graphVersion:fields.graphVersion,...(fields.appId ? { appId:fields.appId } : {}) },...(editor==='new' && role==='SUPER_ADMIN' && fields.branchId ? { branchId:fields.branchId } : {}),
      ...(editor==='new' || replaced ? { credentials:{ accessToken:fields.accessToken,appSecret:fields.appSecret,verifyToken:fields.verifyToken } } : {}),...(editor==='edit' ? { version:selected!.version } : {}) };
    const result=await api<{ id?:string }>(root+(editor==='edit' ? '/'+selected!.id : ''),{ method:editor==='edit' ? 'PUT' : 'POST',body:JSON.stringify(body) });
    setFields({ name:'',branchId:'',graphVersion:'',appId:'',accessToken:'',appSecret:'',verifyToken:'' });setEditor(null);await load();
    if (result.id) setSelectedId(result.id);else if (selectedId) await Promise.all([resources(selectedId,'PAGE'),syncHistory(selectedId),...(pageId ? [resources(selectedId,'FORM',pageId)] : [])]);
  }
  async function toggle() {
    if (!selected) return;
    await api(`${root}/${selected.id}/${selected.status==='DISABLED' ? 'enable' : 'disable'}`,{ method:'POST',body:JSON.stringify({ version:selected.version }) });
    await Promise.all([load(),resources(selected.id,'PAGE'),syncHistory(selected.id),...(pageId ? [resources(selected.id,'FORM',pageId)] : [])]);
  }
  const secretRequired=editor==='new' || !!(fields.accessToken || fields.appSecret || fields.verifyToken);
  const input=(key:'name'|'graphVersion'|'appId'|'accessToken'|'appSecret'|'verifyToken',label:string)=><label>{label}<input aria-label={label}
    type={['accessToken','appSecret','verifyToken'].includes(key) ? 'password' : 'text'} autoComplete="off"
    required={key==='name' || key==='graphVersion' || (key!=='appId' && secretRequired)} maxLength={key==='name' ? 100 : key==='graphVersion' ? 10 : key==='appId' ? 30 : key==='accessToken' ? 4096 : 512}
    value={fields[key]} onChange={(event)=>setFields({ ...fields,[key]:event.target.value })}/></label>;
  return <section className="panel meta-source-setup"><h2>{t.title}</h2><p>{t.intro}</p>
    <p><a href="https://developers.facebook.com/docs/pages-api/getting-started/" target="_blank" rel="noopener noreferrer">Meta Pages · access tokens</a>
      {' · '}<a href="https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/" target="_blank" rel="noopener noreferrer">Meta Lead Ads · permissions and Leads Access</a></p>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions"><button disabled={busy} onClick={()=>openEditor('new')}>{t.add}</button><button className="secondary" disabled={busy} onClick={()=>void run(()=>load())}>{t.refresh}</button></div>
    <div className="table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.scope}</th><th>{t.status}</th><th/></tr></thead><tbody>
      {items.map((item)=><tr key={item.id}><td>{item.name}</td><td>{item.branch_id ? branches.find((b)=>b.id===item.branch_id)?.name ?? t.branch : t.org}</td><td>{item.status}{item.last_error_code && <small>{item.last_error_code}</small>}</td>
        <td><button className="link" disabled={busy} onClick={()=>setSelectedId(item.id)}>{t.select}</button></td></tr>)}
    </tbody></table></div>{cursor && <button disabled={busy} onClick={()=>void run(()=>load(cursor))}>{t.more}</button>}
    {editor && <form className="workflow-form" onSubmit={(event)=> { event.preventDefault();void run(save); }}>
      {input('name',t.name)}{input('graphVersion',t.version)}{editor==='new' && role==='SUPER_ADMIN' && <label>{t.scope}<select aria-label={t.scope} value={fields.branchId} onChange={(event)=>setFields({ ...fields,branchId:event.target.value })}>
        <option value="">{t.org}</option>{branches.map((b)=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
      {input('appId',locale==='ar' ? 'معرف تطبيق Meta للمصدر' : locale==='fr' ? 'Identifiant de l’application Meta source' : 'Source Meta App ID')}
      {input('accessToken',t.token)}{input('appSecret',t.secret)}{input('verifyToken',t.verify)}<p>{t.hint}</p><button disabled={busy}>{t.save}</button>
      <button type="button" className="secondary" onClick={()=> { setEditor(null);setFields({ ...fields,accessToken:'',appSecret:'',verifyToken:'' }); }}>{t.cancel}</button>
    </form>}
    {selected && <section className="panel"><h3>{selected.name}</h3><p>{t.status}: {selected.status} · {selected.version}</p><p>{t.notReady}</p>
      {selected.last_error_code && <p>{selected.last_error_code}</p>}<p>{t.lastSuccess}: {selected.last_success_at ?? '—'} · {t.lastFailure}: {selected.last_failure_at ?? '—'}</p>
      <div className="actions"><button disabled={busy || selected.status==='DISABLED'} onClick={()=>openEditor('edit')}>{t.edit}</button><button disabled={busy} onClick={()=>void run(toggle)}>{selected.status==='DISABLED' ? t.enable : t.disable}</button>
        <button disabled={busy || selected.status==='DISABLED'} onClick={()=>void run(()=>discover())}>{t.discover}</button></div>
      <h4>{t.pages}</h4>{!pages.length && <p>{t.empty}</p>}<label>{t.pickPage}<select aria-label={t.pickPage} value={pageId} onChange={(event)=>setPageId(event.target.value)}><option value="">—</option>
        {pages.map((item)=><option key={item.id} value={item.id}>{item.name} · {item.external_id} · {item.active && item.connection_version===selected.version ? t.active : t.inactive}</option>)}</select></label>
      {pageAfter && <button disabled={busy} onClick={()=>void run(()=>resources(selected.id,'PAGE',undefined,pageAfter))}>{t.more}</button>}
      <button disabled={busy || !page?.active || page.connection_version!==selected.version || selected.status==='DISABLED'} onClick={()=>void run(()=>discover(pageId))}>{t.discoverForms}</button>
      <MetaSourceWebhook key={`${selected.id}:${selected.version}:${pageId}:${page?.version ?? 0}`} locale={locale} connection={selected} page={page} api={api} changed={()=>load()}/>
      <SourceSubmissions key={selected.id} connectionId={selected.id} locale={locale} api={api}/>
      <h4>{t.forms}</h4>{!forms.length && <p>{t.empty}</p>}<label>{t.pickForm}<select aria-label={t.pickForm} value={formId} onChange={(event)=>setFormId(event.target.value)}><option value="">—</option>
        {forms.map((item)=><option key={item.id} value={item.id}>{item.name} · {item.external_id} · {item.provider_status ?? '—'} · {item.active && item.connection_version===selected.version ? t.active : t.inactive}</option>)}</select></label>
      {formAfter && <button disabled={busy} onClick={()=>void run(()=>resources(selected.id,'FORM',pageId,formAfter))}>{t.more}</button>}
      {form && <section className="panel"><h4>{t.questions}</h4><ul>{form.questions.map((q,index)=><li key={index}>{q.label ?? q.key ?? q.type} · {q.type} · {q.key ?? '—'}
        {!!q.options.length && <ul>{q.options.map((o,i)=><li key={i}>{o.key ?? '—'}: {o.value ?? '—'}</li>)}</ul>}</li>)}</ul></section>}
      {role==='SUPER_ADMIN' && !selected.branch_id && form && <SourceResourceAccess key={form.id} connectionId={selected.id} formId={form.id} locale={locale} branches={branches} api={api}/>}
      <SourceHistoricalSync key={`${selected.id}:${selected.version}`} locale={locale} connection={selected} form={form} api={api}/>
      <h4>{t.history}</h4><ul>{history.map((item)=><li key={item.id}>{item.resource_kind} · {item.state} · {item.resource_count ?? '—'} · {item.started_at}{item.error_code && ` · ${item.error_code}`}</li>)}</ul>
      {historyCursor && <button disabled={busy} onClick={()=>void run(()=>syncHistory(selected.id,historyCursor))}>{t.more}</button>}
    </section>}
  </section>;
}
