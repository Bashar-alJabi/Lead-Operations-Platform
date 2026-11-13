import {useEffect,useRef,useState} from 'react';
type Locale='ar'|'en'|'fr';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Rule={id:string;name:string;branch_id:string|null;campaign_id:string|null;campaign_name:string|null;version:number;enabled:boolean;trigger_type:string;lifecycle:string|null;
 owner_condition:string;action_type:string;delay_minutes:number;priority:string;note:string;reason:string};
type Definition={name:string;enabled:boolean;triggerType:string;lifecycle:string|null;ownerCondition:string;actionType:string;delayMinutes:number;priority:string;note:string;reason:string};
type Processing={id:string;lead_id:string;trigger_type:string;version:number;state:string;failure_count:number;next_run_at:string|null;rule_name:string|null;rule_version:number|null;result_code:string|null;follow_up_id:string|null;created_at:string};
type History={version:number;created_at:string;state?:string;operation?:string;failure_count?:number;result_code?:string;definition?:Record<string,unknown>};
const labels={
 en:{loading:'Loading…',title:'Automations',new:'New automation',reload:'Reload automations',name:'Rule name',scope:'Branch scope',system:'Entire organization',campaign:'Campaign scope',all:'All campaigns in scope',moreCampaigns:'More campaigns',
  trigger:'Trigger',conditions:'Conditions',lifecycle:'Lead lifecycle condition',any:'Any',owner:'Owner condition',action:'Action',delay:'Minutes after source event',priority:'Priority',note:'Task note or internal notification text',
  reason:'Approval reason',enabled:'Enable this rule',save:'Approve and save automation',edit:'Edit automation',history:'Rule history',version:'Version',more:'More',empty:'No records.',error:'Unable to complete the request.',
  cancel:'Cancel editing',processing:'Automation processing',kind:'Processing stage',sources:'Source matching',executions:'Action executions',refresh:'Refresh processing',retry:'Retry failed processing',processingHistory:'Processing history',
  warning:'Rules run with current scope and authority. Internal actions cannot send customer messages or change payments. Generated tasks and notices do not trigger these lead-event rules, preventing a loop.',
  timing:'Follow-ups use the event time plus this delay and the current eligible lead owner. Editing or disabling a rule prevents pending work from using the old version. Text is visible to authorized lead users; do not include secrets.',
  created:'Lead created',assigned:'Lead assigned',reassigned:'Lead ownership changed',assignedCondition:'Assigned',unassigned:'Unassigned',follow:'Create follow-up',notify:'Send In-App notification',openLead:'Open lead',
  states:{QUEUED:'Queued',DONE:'Matching complete',SUCCEEDED:'Applied',SKIPPED:'Skipped',DEAD_LETTER:'Needs recovery'},
  results:{APPLIED:'Action applied',RULE_CHANGED:'Rule edited or disabled',SCOPE_CHANGED:'Lead scope changed',APPROVAL_REVOKED:'Approver no longer authorized',SCOPE_INACTIVE:'Branch or campaign inactive',CONDITIONS_NOT_MET:'Conditions do not match',LEAD_NOT_OPEN:'Lead is not open',NO_ELIGIBLE_OWNER:'No eligible current owner',DATABASE_OPERATION_FAILED:'Database operation failed'}},
 ar:{loading:'جاري التحميل…',title:'الأتمتة',new:'قاعدة أتمتة جديدة',reload:'إعادة تحميل الأتمتة',name:'اسم القاعدة',scope:'نطاق الفرع',system:'المؤسسة كاملة',campaign:'نطاق الحملة',all:'كل الحملات ضمن النطاق',moreCampaigns:'حملات إضافية',
  trigger:'الحدث المحفز',conditions:'الشروط',lifecycle:'شرط حالة الفرصة',any:'أي حالة',owner:'شرط المالك',action:'الإجراء',delay:'الدقائق بعد وقت الحدث',priority:'الأولوية',note:'ملاحظة المهمة أو نص الإشعار الداخلي',
  reason:'سبب الاعتماد',enabled:'تفعيل هذه القاعدة',save:'اعتماد وحفظ الأتمتة',edit:'تعديل الأتمتة',history:'تاريخ القاعدة',version:'النسخة',more:'المزيد',empty:'لا توجد سجلات.',error:'تعذّر إكمال الطلب.',
  cancel:'إلغاء التعديل',processing:'تنفيذ الأتمتة',kind:'مرحلة المعالجة',sources:'مطابقة المصادر',executions:'تنفيذ الإجراءات',refresh:'تحديث المعالجة',retry:'إعادة محاولة المعالجة المتعثرة',processingHistory:'تاريخ المعالجة',
  warning:'تُفحص الصلاحية والنطاق الحاليان عند التنفيذ. الإجراءات الداخلية لا ترسل رسائل للعملاء ولا تعدّل المدفوعات. المهام والإشعارات الناتجة لا تحفز قواعد أحداث الفرص هذه، لمنع الحلقات.',
  timing:'موعد المتابعة هو وقت الحدث مضافًا إليه التأخير، والمالك هو المسؤول الحالي المؤهل. تعديل القاعدة أو تعطيلها يمنع التنفيذ المعلق من استخدام نسختها القديمة. النص ظاهر للمخولين بالفرصة؛ لا تضع أسرارًا.',
  created:'إنشاء فرصة',assigned:'إسناد فرصة',reassigned:'تغيير إسناد الفرصة',assignedCondition:'مسندة',unassigned:'غير مسندة',follow:'إنشاء متابعة',notify:'إرسال إشعار داخل المنصة',openLead:'فتح الفرصة',
  states:{QUEUED:'في الانتظار',DONE:'اكتملت المطابقة',SUCCEEDED:'نُفذ الإجراء',SKIPPED:'تم التخطي',DEAD_LETTER:'تحتاج استعادة'},
  results:{APPLIED:'تم تنفيذ الإجراء',RULE_CHANGED:'عُدلت القاعدة أو عُطلت',SCOPE_CHANGED:'تغير نطاق الفرصة',APPROVAL_REVOKED:'فقد المعتمد صلاحية التنفيذ',SCOPE_INACTIVE:'الفرع أو الحملة غير نشط',CONDITIONS_NOT_MET:'الشروط غير متحققة',LEAD_NOT_OPEN:'الفرصة غير مفتوحة',NO_ELIGIBLE_OWNER:'لا مالك حالي مؤهل',DATABASE_OPERATION_FAILED:'فشلت عملية قاعدة البيانات'}},
 fr:{loading:'Chargement…',title:'Automatisations',new:'Nouvelle automatisation',reload:'Recharger les automatisations',name:'Nom de la règle',scope:'Périmètre agence',system:'Toute l’organisation',campaign:'Périmètre campagne',all:'Toutes les campagnes du périmètre',moreCampaigns:'Autres campagnes',
  trigger:'Déclencheur',conditions:'Conditions',lifecycle:'Condition de cycle du prospect',any:'Tous',owner:'Condition du responsable',action:'Action',delay:'Minutes après l’événement source',priority:'Priorité',note:'Note de suivi ou texte de notification interne',
  reason:'Motif d’approbation',enabled:'Activer cette règle',save:'Approuver et enregistrer',edit:'Modifier l’automatisation',history:'Historique de la règle',version:'Version',more:'Plus',empty:'Aucun élément.',error:'La demande a échoué.',
  cancel:'Annuler la modification',processing:'Traitement des automatisations',kind:'Étape de traitement',sources:'Correspondance des sources',executions:'Exécution des actions',refresh:'Actualiser le traitement',retry:'Relancer le traitement en échec',processingHistory:'Historique du traitement',
  warning:'Les autorisations et le périmètre actuels sont vérifiés à l’exécution. Les actions internes n’envoient aucun message client et ne modifient aucun paiement. Les tâches et notifications produites ne déclenchent pas ces règles, évitant une boucle.',
  timing:'Le suivi utilise la date de l’événement et ce délai, avec le responsable actuel éligible. Modifier ou désactiver une règle bloque ses anciennes exécutions. Le texte est visible aux utilisateurs autorisés du prospect ; aucun secret.',
  created:'Prospect créé',assigned:'Prospect attribué',reassigned:'Attribution modifiée',assignedCondition:'Attribué',unassigned:'Non attribué',follow:'Créer un suivi',notify:'Envoyer une notification interne',openLead:'Ouvrir le prospect',
  states:{QUEUED:'En attente',DONE:'Correspondance terminée',SUCCEEDED:'Appliquée',SKIPPED:'Ignorée',DEAD_LETTER:'Récupération requise'},
  results:{APPLIED:'Action appliquée',RULE_CHANGED:'Règle modifiée ou désactivée',SCOPE_CHANGED:'Périmètre du prospect modifié',APPROVAL_REVOKED:'Approbateur non autorisé',SCOPE_INACTIVE:'Agence ou campagne inactive',CONDITIONS_NOT_MET:'Conditions non satisfaites',LEAD_NOT_OPEN:'Prospect non ouvert',NO_ELIGIBLE_OWNER:'Aucun responsable actuel éligible',DATABASE_OPERATION_FAILED:'Échec de l’opération de base de données'}},
} as const;
const initial=():Definition=>({name:'',enabled:false,triggerType:'LEAD_CREATED',lifecycle:'OPEN',ownerCondition:'ASSIGNED',actionType:'CREATE_FOLLOW_UP',delayMinutes:60,priority:'NORMAL',note:'',reason:''});
export function AutomationWorkspace({locale,api,user,branches,onOpenLead}:{locale:Locale;api:Api;user:{id:string;role:'SUPER_ADMIN'|'MANAGER';branchId:string|null};branches:{id:string;name:string}[];onOpenLead:(id:string)=>void}){
 const t=labels[locale],epoch=useRef(0),campaignEpoch=useRef(0);
 const [rules,setRules]=useState<{items:Rule[];nextCursor:string|null}>({items:[],nextCursor:null}),[selected,setSelected]=useState<Rule|null>(null),[editing,setEditing]=useState(false);
 const [form,setForm]=useState(initial),[branch,setBranch]=useState(user.branchId??''),[campaign,setCampaign]=useState(''),[campaigns,setCampaigns]=useState<{id:string;name:string}[]>([]),[nextCampaign,setNextCampaign]=useState<string|null>(null);
 const [kind,setKind]=useState<'sources'|'executions'>('executions'),[processing,setProcessing]=useState<{items:Processing[];nextCursor:string|null}>({items:[],nextCursor:null});
 const [history,setHistory]=useState<{root:string;items:History[];nextVersion:number|null;rule:boolean}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const change=(key:keyof Definition,value:string|number|boolean|null)=>setForm(f=>({...f,[key]:value}));
 function failed(){setRules({items:[],nextCursor:null});setProcessing({items:[],nextCursor:null});setHistory(null);setSelected(null);setEditing(false);setError(t.error);}
 async function readRules(cursor?:string){const n=++epoch.current;setBusy(true);setError('');setHistory(null);
  try{const r=await api<{items:Rule[];nextCursor:string|null}>('/api/automations?limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));if(n===epoch.current)setRules(r);}
  catch{if(n===epoch.current)failed();}finally{if(n===epoch.current)setBusy(false);}}
 async function readProcessing(cursor?:string){const n=++epoch.current;setBusy(true);setError('');setHistory(null);setProcessing({items:[],nextCursor:null});
  try{const r=await api<{items:Processing[];nextCursor:string|null}>('/api/automation/'+kind+'?limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));if(n===epoch.current)setProcessing(r);}
  catch{if(n===epoch.current)failed();}finally{if(n===epoch.current)setBusy(false);}}
 async function readHistory(root:string,rule:boolean,before?:number){const n=++epoch.current;setBusy(true);setError('');setHistory(null);
  try{const r=await api<{items:History[];nextVersion:number|null}>(root+'/history'+(before?'?before='+before:''));if(n===epoch.current)setHistory({...r,root,rule});}
  catch{if(n===epoch.current)failed();}finally{if(n===epoch.current)setBusy(false);}}
 async function readCampaigns(cursor?:string){const n=++campaignEpoch.current;if(!branch){setCampaigns([]);setNextCampaign(null);return;}
  try{const r=await api<{items:{id:string;name:string}[];nextCursor:string|null}>('/api/campaigns?branchId='+encodeURIComponent(branch)+'&limit=25'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
   if(n===campaignEpoch.current){setCampaigns(r.items);setNextCampaign(r.nextCursor);}}
  catch{if(n===campaignEpoch.current){setCampaigns([]);setNextCampaign(null);setCampaign('');setError(t.error);}}}
 useEffect(()=>{setSelected(null);setEditing(false);setProcessing({items:[],nextCursor:null});void readRules();return()=>{epoch.current++;};},[user.id,user.role,user.branchId,locale]);
 useEffect(()=>{void readCampaigns();return()=>{campaignEpoch.current++;};},[branch,user.id]);
 function edit(r:Rule|null){epoch.current++;setSelected(r);setBranch(r?.branch_id??user.branchId??'');setCampaign(r?.campaign_id??'');setForm(r?{name:r.name,enabled:r.enabled,triggerType:r.trigger_type,lifecycle:r.lifecycle,ownerCondition:r.owner_condition,
  actionType:r.action_type,delayMinutes:r.delay_minutes,priority:r.priority,note:r.note,reason:''}:initial());setEditing(true);setHistory(null);setError('');setBusy(false);}
 async function save(){setBusy(true);setError('');setHistory(null);try{
  const payload=selected?{...form,version:selected.version}:{...form,branchId:branch||null,campaignId:campaign||null};
  await api('/api/automations'+(selected?'/'+selected.id:''),{method:selected?'PUT':'POST',body:JSON.stringify(payload)});
  setEditing(false);setSelected(null);setForm(initial());await readRules();
 }catch{failed();}finally{setBusy(false);}}
 async function retry(item:Processing){setBusy(true);setError('');setHistory(null);try{
  await api('/api/automation/'+kind+'/'+item.id+'/retry',{method:'POST',body:JSON.stringify({version:item.version})});await readProcessing();
 }catch{failed();}finally{setBusy(false);}}
 const triggers=[['LEAD_CREATED',t.created],['LEAD_ASSIGNED',t.assigned],['LEAD_REASSIGNED',t.reassigned]];
 const status=(s:string)=>(t.states as Record<string,string>)[s]??s,result=(s:string|null)=>s?(t.results as Record<string,string>)[s]??t.error:'';
 return <section className="panel" data-automation-workspace><h2>{t.title}</h2><p>{t.warning}</p><div className="actions"><button disabled={busy} onClick={()=>edit(null)}>{t.new}</button><button disabled={busy} onClick={()=>void readRules()}>{t.reload}</button></div>
  {busy&&<p role="status">{t.loading}</p>}{error&&<p role="alert">{error}</p>}
  {editing&&<form data-automation-editor onSubmit={e=>{e.preventDefault();void save();}}><h3>{selected?t.edit:t.new}</h3>
   <label>{t.name}<input required maxLength={100} value={form.name} onChange={e=>change('name',e.target.value)}/></label>
   <label>{t.scope}<select aria-label={t.scope} disabled={Boolean(selected)||user.role==='MANAGER'||busy} value={branch} onChange={e=>{setBranch(e.target.value);setCampaign('');}}>{user.role==='SUPER_ADMIN'&&<option value="">{t.system}</option>}{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
   <label>{t.campaign}<select aria-label={t.campaign} disabled={Boolean(selected)||!branch||busy} value={campaign} onChange={e=>setCampaign(e.target.value)}><option value="">{t.all}</option>
    {campaign&&!campaigns.some(c=>c.id===campaign)&&<option value={campaign}>{selected?.campaign_name??campaign}</option>}{campaigns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   {!selected&&nextCampaign&&<button type="button" disabled={busy} onClick={()=>void readCampaigns(nextCampaign)}>{t.moreCampaigns}</button>}
   <label>{t.trigger}<select aria-label={t.trigger} value={form.triggerType} onChange={e=>change('triggerType',e.target.value)}>{triggers.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
   <fieldset><legend>{t.conditions}</legend><label>{t.lifecycle}<select aria-label={t.lifecycle} value={form.lifecycle??''} onChange={e=>change('lifecycle',e.target.value||null)}><option value="">{t.any}</option>{['OPEN','CLOSED','ARCHIVED'].map(s=><option key={s}>{s}</option>)}</select></label>
    <label>{t.owner}<select aria-label={t.owner} value={form.ownerCondition} onChange={e=>change('ownerCondition',e.target.value)}><option value="ANY">{t.any}</option><option value="ASSIGNED">{t.assignedCondition}</option><option value="UNASSIGNED">{t.unassigned}</option></select></label></fieldset>
   <label>{t.action}<select aria-label={t.action} value={form.actionType} onChange={e=>setForm(f=>({...f,actionType:e.target.value,delayMinutes:e.target.value==='SEND_IN_APP_NOTIFICATION'?0:60,priority:'NORMAL'}))}><option value="CREATE_FOLLOW_UP">{t.follow}</option><option value="SEND_IN_APP_NOTIFICATION">{t.notify}</option></select></label>
   {form.actionType==='CREATE_FOLLOW_UP'&&<><label>{t.delay}<input type="number" min={0} max={525600} required value={form.delayMinutes} onChange={e=>change('delayMinutes',Number(e.target.value))}/></label>
    <label>{t.priority}<select aria-label={t.priority} value={form.priority} onChange={e=>change('priority',e.target.value)}>{['LOW','NORMAL','HIGH'].map(s=><option key={s}>{s}</option>)}</select></label></>}
   <p>{t.timing}</p><label>{t.note}<textarea maxLength={4000} value={form.note} onChange={e=>change('note',e.target.value)}/></label>
   <label><input type="checkbox" checked={form.enabled} onChange={e=>change('enabled',e.target.checked)}/>{t.enabled}</label>
   <label>{t.reason}<input minLength={3} maxLength={500} required value={form.reason} onChange={e=>change('reason',e.target.value)}/></label>
   {selected&&<p>{t.version} {selected.version}</p>}<div className="actions"><button disabled={busy}>{t.save}</button><button type="button" disabled={busy} onClick={()=>setEditing(false)}>{t.cancel}</button></div>
  </form>}
  {rules.items.map(r=><article key={r.id} data-automation-rule={r.id}><h3>{r.name}</h3><p>{triggers.find(([v])=>v===r.trigger_type)?.[1]} → {r.action_type==='CREATE_FOLLOW_UP'?t.follow:t.notify} · {r.enabled?'✓':'—'} · {t.version} {r.version}</p>
   <button disabled={busy} onClick={()=>edit(r)}>{t.edit}</button><button disabled={busy} onClick={()=>void readHistory('/api/automations/'+r.id,true)}>{t.history}</button></article>)}
  {!busy&&!rules.items.length&&<p>{t.empty}</p>}{rules.nextCursor&&<button disabled={busy} onClick={()=>void readRules(rules.nextCursor!)}>{t.more}</button>}
  <section data-automation-processing><h3>{t.processing}</h3><label>{t.kind}<select aria-label={t.kind} value={kind} disabled={busy} onChange={e=>{epoch.current++;setKind(e.target.value as typeof kind);setProcessing({items:[],nextCursor:null});setHistory(null);}}><option value="executions">{t.executions}</option><option value="sources">{t.sources}</option></select></label><button disabled={busy} onClick={()=>void readProcessing()}>{t.refresh}</button>
   {processing.items.map(p=><article key={p.id} data-automation-processing-id={p.id}><h4>{p.rule_name??triggers.find(([v])=>v===p.trigger_type)?.[1]}</h4><p>{status(p.state)} · {result(p.result_code)} · {t.version} {p.version} · {p.failure_count}/5 · {new Date(p.created_at).toLocaleString(locale)}</p>
    {p.next_run_at&&<p>{new Date(p.next_run_at).toLocaleString(locale)}</p>}<button disabled={busy} onClick={()=>onOpenLead(p.lead_id)}>{t.openLead}</button>
    <button disabled={busy} onClick={()=>void readHistory('/api/automation/'+kind+'/'+p.id,false)}>{t.processingHistory}</button>{p.state==='DEAD_LETTER'&&<button disabled={busy} onClick={()=>void retry(p)}>{t.retry}</button>}</article>)}
   {!busy&&!processing.items.length&&<p>{t.empty}</p>}{processing.nextCursor&&<button disabled={busy} onClick={()=>void readProcessing(processing.nextCursor!)}>{t.more}</button>}
  </section>
  {history&&<section data-automation-history><h3>{history.rule?t.history:t.processingHistory}</h3>{history.items.map(h=><article key={h.version}><p>{t.version} {h.version} · {new Date(h.created_at).toLocaleString(locale)}</p>{h.definition?<p>{String(h.definition.name)} · {String(h.definition.reason)} · {String(h.definition.note)}</p>:<p>{status(h.state??'')} · {result(h.result_code??null)} · {h.failure_count}/5</p>}</article>)}
   {history.nextVersion&&<button disabled={busy} onClick={()=>void readHistory(history.root,history.rule,history.nextVersion!)}>{t.more}</button>}</section>}
 </section>;
}
