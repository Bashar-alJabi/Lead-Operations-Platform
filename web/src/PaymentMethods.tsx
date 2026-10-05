import { useEffect,useRef,useState } from 'react';
type Locale='ar'|'en'|'fr';type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Option={ id:string;name:string;status?:string;active?:boolean };
type Rule={ mode:'ALL'|'SELECTED';ids:string[] };
type Method={ id:string;name:string;branch_id:string;connection_id:string;connection_name:string;connection_status:string;currencies:string[];
  version:number;active:boolean;available:boolean;issues:string[];agents:Rule;campaigns:Rule;agentSelections:Option[];campaignSelections:Option[] };
type History={ version:number;reason:string;created_at:string;snapshot:{ name:string;connectionId:string;active:boolean;currencies:string[];agents:Rule;campaigns:Rule } };
const labels={
  en:{ title:'Branch payment methods',name:'Payment method name',branch:'Payment method branch',connection:'Method provider connection',currencies:'Method currencies',active:'Method enabled',
    agents:'Agent availability',campaigns:'Campaign availability',all:'All in this branch',selected:'Selected only',agentChoices:'Allowed payment Agents',campaignChoices:'Allowed payment Campaigns',
    reason:'Payment method change reason',save:'Save payment method',add:'New payment method',edit:'Edit payment method',refresh:'Refresh payment methods',more:'More payment methods',
    history:'Payment method history',moreHistory:'More method history',connectionsMore:'More method connections',agentsMore:'More payment Agents',campaignsMore:'More payment Campaigns',
    empty:'No payment methods.',choose:'Choose',version:'Version',disabled:'Disabled',state:'State',note:'Enabling a method configures availability. Payment links require a verified payment flow; authentication alone is insufficient. Currency support must also be checked with the provider.',
    leadTitle:'Available payment methods',leadRefresh:'Refresh Lead payment methods',leadMore:'More Lead payment methods',leadEmpty:'No methods allowed for this Lead and user.',ready:'Ready' },
  ar:{ title:'طرق الدفع للفروع',name:'اسم طريقة الدفع',branch:'فرع طريقة الدفع',connection:'اتصال مزود الطريقة',currencies:'عملات الطريقة',active:'الطريقة مفعلة',
    agents:'إتاحة الوكلاء',campaigns:'إتاحة الحملات',all:'الجميع في الفرع',selected:'المحددون فقط',agentChoices:'وكلاء الدفع المسموحون',campaignChoices:'حملات الدفع المسموحة',
    reason:'سبب تغيير طريقة الدفع',save:'حفظ طريقة الدفع',add:'طريقة دفع جديدة',edit:'تعديل طريقة الدفع',refresh:'تحديث طرق الدفع',more:'المزيد من طرق الدفع',
    history:'تاريخ طريقة الدفع',moreHistory:'المزيد من تاريخ الطريقة',connectionsMore:'المزيد من اتصالات الطريقة',agentsMore:'المزيد من وكلاء الدفع',campaignsMore:'المزيد من حملات الدفع',
    empty:'لا طرق دفع.',choose:'اختر',version:'النسخة',disabled:'معطلة',state:'الحالة',note:'تفعيل الطريقة يحدد إتاحتها. رابط الدفع يتطلب تدفق دفع متحققًا؛ Authentication وحدها لا تكفي. يجب التحقق من دعم العملة لدى المزود أيضًا.',
    leadTitle:'طرق الدفع المتاحة',leadRefresh:'تحديث طرق دفع الفرصة',leadMore:'المزيد من طرق دفع الفرصة',leadEmpty:'لا طرق مسموحة لهذه الفرصة والمستخدم.',ready:'جاهزة' },
  fr:{ title:'Moyens de paiement des agences',name:'Nom du moyen de paiement',branch:'Agence du moyen',connection:'Connexion du moyen',currencies:'Devises du moyen',active:'Moyen activé',
    agents:'Disponibilité des agents',campaigns:'Disponibilité des campagnes',all:'Tous dans cette agence',selected:'Sélection uniquement',agentChoices:'Agents autorisés au paiement',campaignChoices:'Campagnes autorisées au paiement',
    reason:'Motif de modification du moyen',save:'Enregistrer le moyen',add:'Nouveau moyen de paiement',edit:'Modifier le moyen',refresh:'Actualiser les moyens',more:'Autres moyens',
    history:'Historique du moyen',moreHistory:'Suite de l’historique du moyen',connectionsMore:'Autres connexions du moyen',agentsMore:'Autres agents autorisés',campaignsMore:'Autres campagnes autorisées',
    empty:'Aucun moyen.',choose:'Choisir',version:'Version',disabled:'Désactivé',state:'État',note:'L’activation configure la disponibilité. Un lien nécessite un flux de paiement validé ; l’authentification seule ne suffit pas. Vérifiez aussi les devises prises en charge par le fournisseur.',
    leadTitle:'Moyens de paiement disponibles',leadRefresh:'Actualiser les moyens du prospect',leadMore:'Autres moyens du prospect',leadEmpty:'Aucun moyen autorisé pour ce prospect et cet utilisateur.',ready:'Prêt' },
};
export function PaymentMethods({ locale,role,branches,api }: { locale:Locale;role:'SUPER_ADMIN'|'MANAGER';branches:Option[];api:Api }) {
  const t=labels[locale];const [items,setItems]=useState<Method[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [selected,setSelected]=useState<Method|null>(null);const [name,setName]=useState('');const [branchId,setBranchId]=useState(role==='MANAGER' ? branches[0]?.id ?? '' : '');
  const [connectionId,setConnectionId]=useState('');const [currencies,setCurrencies]=useState('');const [active,setActive]=useState(false);
  const [agents,setAgents]=useState<Rule>({ mode:'ALL',ids:[] });const [campaigns,setCampaigns]=useState<Rule>({ mode:'ALL',ids:[] });
  const [reason,setReason]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [options,setOptions]=useState<Record<string,Option[]>>({ CONNECTION:[],AGENT:[],CAMPAIGN:[] });const [optionCursors,setOptionCursors]=useState<Record<string,string|null>>({});
  const [currencyCodes,setCurrencyCodes]=useState<string[]>([]);const [history,setHistory]=useState<History[]>([]);const [before,setBefore]=useState<number|null>(null);
  const selectionRef=useRef<string|null>(null);const branchRef=useRef(branchId);branchRef.current=branchId;
  async function load(next?:string) { const page=await api<{ items:Method[];nextCursor:string|null }>('/api/payments/methods'+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setItems((old)=>next ? [...old,...page.items] : page.items);setCursor(page.nextCursor); }
  async function loadHistory(id:string,next?:number) { const page=await api<{ items:History[];nextVersion:number|null }>(`/api/payments/methods/${id}/history`+(next ? '?before='+next : ''));
    if(selectionRef.current!==id)return;setHistory((old)=>next ? [...old,...page.items] : page.items);setBefore(page.nextVersion); }
  async function loadOptions(kind:string,next?:string) { const scope=branchRef.current;if(!scope)return;
    const page=await api<{ items:Option[];nextCursor:string|null }>(`/api/payments/method-options?branchId=${scope}&kind=${kind}`+(next ? '&cursor='+encodeURIComponent(next) : ''));
    if(branchRef.current!==scope)return;setOptions((old)=>({ ...old,[kind]:next ? [...(old[kind] ?? []),...page.items] : page.items }));setOptionCursors((old)=>({ ...old,[kind]:page.nextCursor })); }
  useEffect(()=>{ void Promise.all([load(),api<{ items:string[] }>('/api/payments/currencies').then((result)=>setCurrencyCodes(result.items))]).catch((e)=>setError(String(e))); },[]);
  useEffect(()=>{ if(!branchId && role==='MANAGER' && branches[0])setBranchId(branches[0].id); },[branches]);
  useEffect(()=>{ setOptions({ CONNECTION:[],AGENT:[],CAMPAIGN:[] });setOptionCursors({});if(branchId)void Promise.all(['CONNECTION','AGENT','CAMPAIGN'].map((kind)=>loadOptions(kind))).catch((e)=>setError(String(e))); },[branchId]);
  async function choose(item:Method|null) { selectionRef.current=item?.id ?? null;setError('');setNotice('');setReason('');setHistory([]);setBefore(null);
    if(!item) { setSelected(null);setName('');setConnectionId('');setCurrencies('');setActive(false);setAgents({ mode:'ALL',ids:[] });setCampaigns({ mode:'ALL',ids:[] });return; }
    setBusy(true);try { const detail=await api<Method>('/api/payments/methods/'+item.id);if(selectionRef.current!==item.id)return;
      setSelected(detail);setName(detail.name);setBranchId(detail.branch_id);setConnectionId(detail.connection_id);setCurrencies(detail.currencies.join(', '));setActive(detail.active);
      setAgents(detail.agents);setCampaigns(detail.campaigns);await loadHistory(detail.id);
    }catch(e){ setError(String(e)); }finally{ setBusy(false); }
  }
  async function save() { setBusy(true);setError('');setNotice('');try {
    const result=await api<{ id:string;version:number }>('/api/payments/methods'+(selected ? '/'+selected.id : ''),{ method:selected ? 'PUT' : 'POST',body:JSON.stringify({
      name,branchId,connectionId,currencies:currencies.split(',').map((code)=>code.trim().toUpperCase()),active,agents,campaigns,reason,...(selected ? { version:selected.version } : {}) }) });
    selectionRef.current=result.id;await load();const detail=await api<Method>('/api/payments/methods/'+result.id);setSelected(detail);setName(detail.name);setCurrencies(detail.currencies.join(', '));
    await loadHistory(result.id);setNotice(t.version+' '+result.version);
  }catch(e){ setError(String(e)); }finally{ setBusy(false); }
  }
  function choices(kind:string,extra:Option[]=[]):Option[] { return [...new Map([...(options[kind] ?? []),...extra].map((item)=>[item.id,item])).values()]; }
  const connectionChoices=choices('CONNECTION',selected ? [{ id:selected.connection_id,name:selected.connection_name,status:selected.connection_status }] : []);
  function ruleEditor(kind:'AGENT'|'CAMPAIGN',rule:Rule,change:(value:Rule)=>void) { const agent=kind==='AGENT';const title=agent ? t.agents : t.campaigns;const label=agent ? t.agentChoices : t.campaignChoices;
    return <div><label>{title}<select aria-label={title} value={rule.mode} disabled={busy} onChange={(e)=>change({ mode:e.target.value as Rule['mode'],ids:[] })}>
      <option value="ALL">{t.all}</option><option value="SELECTED">{t.selected}</option></select></label>
      {rule.mode==='SELECTED' && <label>{label}<select aria-label={label} multiple size={4} value={rule.ids} disabled={busy}
        onChange={(e)=>change({ mode:'SELECTED',ids:[...e.target.selectedOptions].map((item)=>item.value) })}>
        {choices(kind,agent ? selected?.agentSelections : selected?.campaignSelections).map((item)=><option key={item.id} value={item.id}>{item.name}{item.active===false ? ' · '+t.disabled : ''}</option>)}
      </select></label>}{optionCursors[kind] && <button type="button" className="secondary" disabled={busy} onClick={()=>void loadOptions(kind,optionCursors[kind]!).catch((e)=>setError(String(e)))}>{agent ? t.agentsMore : t.campaignsMore}</button>}
    </div>;
  }
  return <section className="payment-methods"><h2>{t.title}</h2><p>{t.note}</p>{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="actions"><button className="secondary" disabled={busy} onClick={()=>void choose(null)}>{t.add}</button><button className="secondary" disabled={busy} onClick={()=>void load().catch((e)=>setError(String(e)))}>{t.refresh}</button></div>
    <form className="panel campaign-form" onSubmit={(e)=>{ e.preventDefault();void save(); }}>
      <label>{t.name}<input aria-label={t.name} required maxLength={100} disabled={busy} value={name} onChange={(e)=>setName(e.target.value)} /></label>
      <label>{t.branch}<select aria-label={t.branch} required value={branchId} disabled={busy || Boolean(selected) || role==='MANAGER'} onChange={(e)=>{
        setBranchId(e.target.value);setConnectionId('');setAgents({ mode:'ALL',ids:[] });setCampaigns({ mode:'ALL',ids:[] }); }}><option value="">{t.choose}</option>
        {branches.map((b)=><option value={b.id} key={b.id}>{b.name}</option>)}</select></label>
      <label>{t.connection}<select aria-label={t.connection} value={connectionId} required disabled={busy || !branchId} onChange={(e)=>setConnectionId(e.target.value)}><option value="">{t.choose}</option>
        {connectionChoices.map((item)=><option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
      {optionCursors.CONNECTION && <button type="button" className="secondary" disabled={busy} onClick={()=>void loadOptions('CONNECTION',optionCursors.CONNECTION!).catch((e)=>setError(String(e)))}>{t.connectionsMore}</button>}
      <label>{t.currencies}<input aria-label={t.currencies} required maxLength={200} value={currencies} disabled={busy} placeholder="USD, EUR" list="payment-currency-codes" onChange={(e)=>setCurrencies(e.target.value)} /></label>
      <datalist id="payment-currency-codes">{currencyCodes.map((code)=><option key={code} value={code} />)}</datalist>
      <label className="checkbox"><input aria-label={t.active} type="checkbox" checked={active} disabled={busy} onChange={(e)=>setActive(e.target.checked)} />{t.active}</label>
      {ruleEditor('AGENT',agents,setAgents)}{ruleEditor('CAMPAIGN',campaigns,setCampaigns)}
      <label>{t.reason}<input aria-label={t.reason} required minLength={3} maxLength={500} disabled={busy} value={reason} onChange={(e)=>setReason(e.target.value)} /></label>
      <button disabled={busy || !branchId || !connectionId}>{t.save}</button>
    </form>
    {!items.length && <p>{t.empty}</p>}{items.length>0 && <div className="panel table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.branch}</th><th>{t.currencies}</th><th>{t.state}</th><th>{t.edit}</th></tr></thead>
      <tbody>{items.map((item)=><tr key={item.id}><td>{item.name}</td><td>{branches.find((b)=>b.id===item.branch_id)?.name ?? item.branch_id}</td><td><bdi>{item.currencies.join(', ')}</bdi></td>
        <td>{item.active ? t.active : t.disabled}{item.issues.map((code)=><small key={code}><bdi>{code}</bdi></small>)}</td><td><button disabled={busy} className="link" onClick={()=>void choose(item)}>{t.edit}</button></td></tr>)}</tbody></table></div>}
    {cursor && <button className="secondary" disabled={busy} onClick={()=>void load(cursor).catch((e)=>setError(String(e)))}>{t.more}</button>}
    {selected && <section className="panel"><h3>{t.history}: {selected.name}</h3><p>{t.version}: {selected.version}</p><ul>{history.map((entry)=><li key={entry.version}>
      <time>{new Date(entry.created_at).toLocaleString(locale)}</time> · {t.version} {entry.version} · {entry.snapshot.name} · <bdi>{entry.snapshot.currencies.join(', ')}</bdi> · {entry.reason}
    </li>)}</ul>{before && <button className="secondary" disabled={busy} onClick={()=>void loadHistory(selected.id,before).catch((e)=>setError(String(e)))}>{t.moreHistory}</button>}</section>}
  </section>;
}
export function LeadPaymentMethods({ locale,leadId,api }: { locale:Locale;leadId:string;api:Api }) {
  const t=labels[locale];const [items,setItems]=useState<Pick<Method,'id'|'name'|'currencies'|'available'|'issues'>[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  async function load(next?:string) { setBusy(true);setError('');try { const page=await api<{ items:typeof items;nextCursor:string|null }>(`/api/leads/${leadId}/payment-methods`+(next ? '?cursor='+encodeURIComponent(next) : ''));
    setItems((old)=>next ? [...old,...page.items] : page.items);setCursor(page.nextCursor); }catch(e){ setItems([]);setCursor(null);setError(String(e)); }finally{ setBusy(false); } }
  useEffect(()=>{ void load(); },[leadId]);
  return <section className="lead-payment-methods"><h3>{t.leadTitle}</h3>{error && <p role="alert" className="error">{error}</p>}
    <button className="secondary" disabled={busy} onClick={()=>void load()}>{t.leadRefresh}</button>{!items.length && !busy && !error && <p>{t.leadEmpty}</p>}
    <ul>{items.map((item)=><li key={item.id}>{item.name} · <bdi>{item.currencies.join(', ')}</bdi> · {item.available ? t.ready : item.issues.map((code)=><bdi key={code}>{code} </bdi>)}</li>)}</ul>
    {cursor && <button className="secondary" disabled={busy} onClick={()=>void load(cursor)}>{t.leadMore}</button>}
  </section>;
}
