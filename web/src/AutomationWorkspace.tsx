import {useEffect,useRef,useState} from 'react';
import {FieldInput,type FieldRow} from './LeadFields.js';
type Locale='ar'|'en'|'fr';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Rule={id:string;name:string;branch_id:string|null;campaign_id:string|null;campaign_name:string|null;version:number;enabled:boolean;trigger_type:string;trigger_field_id:string|null;lifecycle:string|null;
 owner_condition:string;payment_condition:string;enrollment_condition:string;conversation_state_condition:string|null;controller_condition:string|null;
 condition_field_id:string|null;condition_field_value:unknown;
 action_field_id:string|null;action_field_value:unknown;
 action_field_operation:'SET'|'ADD_TAGS';
 action_agent_id:string|null;action_agent_name:string|null;
 condition_agent_id:string|null;condition_agent_name:string|null;
 condition_date_basis:DateDraft['basis']|null;condition_date_from:string|null;condition_date_through:string|null;
 action_type:string;delay_minutes:number;priority:string;note:string;reason:string};
type Definition={name:string;enabled:boolean;triggerType:string;triggerFieldId:string|null;lifecycle:string|null;ownerCondition:string;
 paymentCondition:string;enrollmentCondition:string;conversationStateCondition:string|null;controllerCondition:string|null;
 actionType:string;delayMinutes:number;priority:string;note:string;reason:string};
type TriggerFieldPage={items:{id:string;label:string}[];nextAfter:string|null};
type AgentOption={id:string;name:string|null};
type DateDraft={basis:''|'LEAD_CREATED'|'EVENT_CAPTURED';from:string;through:string};
const emptyDate:DateDraft={basis:'',from:'',through:''};
type Processing={id:string;lead_id:string;trigger_type:string;version:number;state:string;failure_count:number;next_run_at:string|null;rule_name:string|null;rule_version:number|null;result_code:string|null;follow_up_id:string|null;created_at:string};
type History={version:number;created_at:string;state?:string;operation?:string;failure_count?:number;result_code?:string;definition?:Record<string,unknown>};
const labels={
 en:{loading:'Loading…',title:'Automations',new:'New automation',reload:'Reload automations',name:'Rule name',scope:'Branch scope',system:'Entire organization',campaign:'Campaign scope',all:'All campaigns in scope',moreCampaigns:'More campaigns',
  trigger:'Trigger',conditions:'Conditions',lifecycle:'Lead lifecycle condition',any:'Any',owner:'Owner condition',action:'Action',delay:'Minutes after source event',priority:'Priority',note:'Task note or internal notification text',
  reason:'Approval reason',enabled:'Enable this rule',save:'Approve and save automation',edit:'Edit automation',history:'Rule history',version:'Version',more:'More',empty:'No records.',error:'Unable to complete the request.',
  cancel:'Cancel editing',processing:'Automation processing',kind:'Processing stage',sources:'Source matching',executions:'Action executions',refresh:'Refresh processing',retry:'Retry failed processing',processingHistory:'Processing history',
  warning:'Rules run with current scope and authority. A rule can run once in the same chain of events.',
  timing:'Follow-ups use the event time plus this delay and the current eligible lead owner. Editing or disabling a rule prevents pending work from using the old version. Text is visible to authorized lead users; do not include secrets.',
  created:'Lead created',assigned:'Lead assigned',reassigned:'Lead ownership changed',assignedCondition:'Assigned',unassigned:'Unassigned',follow:'Create follow-up',notify:'Send In-App notification',openLead:'Open lead',
  states:{QUEUED:'Queued',DONE:'Matching complete',SUCCEEDED:'Applied',SKIPPED:'Skipped',DEAD_LETTER:'Needs recovery'},
  results:{APPLIED:'Action applied',RULE_CHANGED:'Rule edited or disabled',SCOPE_CHANGED:'Lead scope changed',APPROVAL_REVOKED:'Approver no longer authorized',SCOPE_INACTIVE:'Branch or campaign inactive',CONDITIONS_NOT_MET:'Conditions do not match',LEAD_NOT_OPEN:'Lead is not open',NO_ELIGIBLE_OWNER:'No eligible current owner',DATABASE_OPERATION_FAILED:'Database operation failed'}},
 ar:{loading:'جاري التحميل…',title:'الأتمتة',new:'قاعدة أتمتة جديدة',reload:'إعادة تحميل الأتمتة',name:'اسم القاعدة',scope:'نطاق الفرع',system:'المؤسسة كاملة',campaign:'نطاق الحملة',all:'كل الحملات ضمن النطاق',moreCampaigns:'حملات إضافية',
  trigger:'الحدث المحفز',conditions:'الشروط',lifecycle:'شرط حالة الفرصة',any:'أي حالة',owner:'شرط المالك',action:'الإجراء',delay:'الدقائق بعد وقت الحدث',priority:'الأولوية',note:'ملاحظة المهمة أو نص الإشعار الداخلي',
  reason:'سبب الاعتماد',enabled:'تفعيل هذه القاعدة',save:'اعتماد وحفظ الأتمتة',edit:'تعديل الأتمتة',history:'تاريخ القاعدة',version:'النسخة',more:'المزيد',empty:'لا توجد سجلات.',error:'تعذّر إكمال الطلب.',
  cancel:'إلغاء التعديل',processing:'تنفيذ الأتمتة',kind:'مرحلة المعالجة',sources:'مطابقة المصادر',executions:'تنفيذ الإجراءات',refresh:'تحديث المعالجة',retry:'إعادة محاولة المعالجة المتعثرة',processingHistory:'تاريخ المعالجة',
  warning:'تُفحص الصلاحية والنطاق الحاليان عند التنفيذ. تعمل كل قاعدة مرة واحدة في سلسلة الأحداث نفسها.',
  timing:'موعد المتابعة هو وقت الحدث مضافًا إليه التأخير، والمالك هو المسؤول الحالي المؤهل. تعديل القاعدة أو تعطيلها يمنع التنفيذ المعلق من استخدام نسختها القديمة. النص ظاهر للمخولين بالفرصة؛ لا تضع أسرارًا.',
  created:'إنشاء فرصة',assigned:'إسناد فرصة',reassigned:'تغيير إسناد الفرصة',assignedCondition:'مسندة',unassigned:'غير مسندة',follow:'إنشاء متابعة',notify:'إرسال إشعار داخل المنصة',openLead:'فتح الفرصة',
  states:{QUEUED:'في الانتظار',DONE:'اكتملت المطابقة',SUCCEEDED:'نُفذ الإجراء',SKIPPED:'تم التخطي',DEAD_LETTER:'تحتاج استعادة'},
  results:{APPLIED:'تم تنفيذ الإجراء',RULE_CHANGED:'عُدلت القاعدة أو عُطلت',SCOPE_CHANGED:'تغير نطاق الفرصة',APPROVAL_REVOKED:'فقد المعتمد صلاحية التنفيذ',SCOPE_INACTIVE:'الفرع أو الحملة غير نشط',CONDITIONS_NOT_MET:'الشروط غير متحققة',LEAD_NOT_OPEN:'الفرصة غير مفتوحة',NO_ELIGIBLE_OWNER:'لا مالك حالي مؤهل',DATABASE_OPERATION_FAILED:'فشلت عملية قاعدة البيانات'}},
 fr:{loading:'Chargement…',title:'Automatisations',new:'Nouvelle automatisation',reload:'Recharger les automatisations',name:'Nom de la règle',scope:'Périmètre agence',system:'Toute l’organisation',campaign:'Périmètre campagne',all:'Toutes les campagnes du périmètre',moreCampaigns:'Autres campagnes',
  trigger:'Déclencheur',conditions:'Conditions',lifecycle:'Condition de cycle du prospect',any:'Tous',owner:'Condition du responsable',action:'Action',delay:'Minutes après l’événement source',priority:'Priorité',note:'Note de suivi ou texte de notification interne',
  reason:'Motif d’approbation',enabled:'Activer cette règle',save:'Approuver et enregistrer',edit:'Modifier l’automatisation',history:'Historique de la règle',version:'Version',more:'Plus',empty:'Aucun élément.',error:'La demande a échoué.',
  cancel:'Annuler la modification',processing:'Traitement des automatisations',kind:'Étape de traitement',sources:'Correspondance des sources',executions:'Exécution des actions',refresh:'Actualiser le traitement',retry:'Relancer le traitement en échec',processingHistory:'Historique du traitement',
  warning:'Les autorisations et le périmètre sont vérifiés à l’exécution. Chaque règle s’exécute une fois par chaîne d’événements.',
  timing:'Le suivi utilise la date de l’événement et ce délai, avec le responsable actuel éligible. Modifier ou désactiver une règle bloque ses anciennes exécutions. Le texte est visible aux utilisateurs autorisés du prospect ; aucun secret.',
  created:'Prospect créé',assigned:'Prospect attribué',reassigned:'Attribution modifiée',assignedCondition:'Attribué',unassigned:'Non attribué',follow:'Créer un suivi',notify:'Envoyer une notification interne',openLead:'Ouvrir le prospect',
  states:{QUEUED:'En attente',DONE:'Correspondance terminée',SUCCEEDED:'Appliquée',SKIPPED:'Ignorée',DEAD_LETTER:'Récupération requise'},
  results:{APPLIED:'Action appliquée',RULE_CHANGED:'Règle modifiée ou désactivée',SCOPE_CHANGED:'Périmètre du prospect modifié',APPROVAL_REVOKED:'Approbateur non autorisé',SCOPE_INACTIVE:'Agence ou campagne inactive',CONDITIONS_NOT_MET:'Conditions non satisfaites',LEAD_NOT_OPEN:'Prospect non ouvert',NO_ELIGIBLE_OWNER:'Aucun responsable actuel éligible',DATABASE_OPERATION_FAILED:'Échec de l’opération de base de données'}},
} as const;
const initial=():Definition=>({name:'',enabled:false,triggerType:'LEAD_CREATED',triggerFieldId:null,lifecycle:'OPEN',ownerCondition:'ASSIGNED',
 paymentCondition:'ANY',enrollmentCondition:'ANY',conversationStateCondition:null,controllerCondition:null,
 actionType:'CREATE_FOLLOW_UP',delayMinutes:60,priority:'NORMAL',note:'',reason:''});
export function AutomationWorkspace({locale,api,user,branches,onOpenLead}:{locale:Locale;api:Api;user:{id:string;role:'SUPER_ADMIN'|'MANAGER';branchId:string|null};branches:{id:string;name:string}[];onOpenLead:(id:string)=>void}){
 const t=labels[locale],epoch=useRef(0),campaignEpoch=useRef(0),fieldEpoch=useRef(0),agentEpoch=useRef(0);
 const [rules,setRules]=useState<{items:Rule[];nextCursor:string|null}>({items:[],nextCursor:null}),[selected,setSelected]=useState<Rule|null>(null),[editing,setEditing]=useState(false);
 const [form,setForm]=useState(initial),[branch,setBranch]=useState(user.branchId??''),[campaign,setCampaign]=useState(''),[campaigns,setCampaigns]=useState<{id:string;name:string}[]>([]),[nextCampaign,setNextCampaign]=useState<string|null>(null);
 const addsTags=form.actionType==='ADD_TAGS';
 const writesField=addsTags||form.actionType==='SET_FIELD_VALUE';
 const assignsLead=form.actionType==='ASSIGN_LEAD';
 const [kind,setKind]=useState<'sources'|'executions'>('executions'),[processing,setProcessing]=useState<{items:Processing[];nextCursor:string|null}>({items:[],nextCursor:null});
 const [fields,setFields]=useState<TriggerFieldPage>({items:[],nextAfter:null});
 const [agents,setAgents]=useState<{items:AgentOption[];nextAfter:string|null}>({items:[],nextAfter:null});
 const [conditionAgent,setConditionAgent]=useState<AgentOption|null>(null),[agentSearch,setAgentSearch]=useState('');
 const [assignmentTarget,setAssignmentTarget]=useState<AgentOption|null>(null);
 const [dateCondition,setDateCondition]=useState<DateDraft>(emptyDate);
 const [conditionField,setConditionField]=useState(''),[conditionValue,setConditionValue]=useState<unknown>(null);
 const [conditionDetails,setConditionDetails]=useState<FieldRow|null>(null),[conditionDenied,setConditionDenied]=useState(false);
 const [targets,setTargets]=useState<TriggerFieldPage>({items:[],nextAfter:null}),targetEpoch=useRef(0);
 const [targetField,setTargetField]=useState(''),[targetValue,setTargetValue]=useState<unknown>(null);
 const [targetDetails,setTargetDetails]=useState<FieldRow|null>(null),[targetDenied,setTargetDenied]=useState(false);
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
 async function readAgents(after?:string){
  const request=++agentEpoch.current,query=new URLSearchParams({search:agentSearch});
  if(branch)query.set('branchId',branch);
  if(after)query.set('after',after);
  try{
   const page=await api<typeof agents>('/api/automations/condition-agents?'+query.toString());
   if(request===agentEpoch.current)setAgents(previous=>({items:after?[...previous.items,...page.items]:page.items,nextAfter:page.nextAfter}));
  }catch{
   if(request===agentEpoch.current){setAgents({items:[],nextAfter:null});setError(t.error);}
  }
 }
 useEffect(()=>{
  setAgents({items:[],nextAfter:null});
  const timer=window.setTimeout(()=>{if(editing&&(form.ownerCondition!=='UNASSIGNED'||assignsLead))void readAgents();},200);
  return()=>{agentEpoch.current++;window.clearTimeout(timer);};
 },[editing,form.ownerCondition,assignsLead,branch,user.id,agentSearch]);
 function fieldScopeQuery(usage?:'ACTION'|'TAGS'){
  const query=new URLSearchParams();
  if(branch)query.set('branchId',branch);
  if(campaign)query.set('campaignId',campaign);
  if(usage)query.set('usage',usage);
  return query;
 }
 async function readTargetFields(after?:string){
  const request=++targetEpoch.current,query=fieldScopeQuery(addsTags?'TAGS':'ACTION');
  if(after)query.set('after',after);
  try{
   const page=await api<TriggerFieldPage>('/api/automations/trigger-fields?'+query.toString());
   if(request===targetEpoch.current)setTargets(previous=>({items:after?[...previous.items,...page.items]:page.items,nextAfter:page.nextAfter}));
  }catch{
   if(request===targetEpoch.current){setTargets({items:[],nextAfter:null});setError(t.error);}
  }
 }
 useEffect(()=>{
  setTargets({items:[],nextAfter:null});
  if(editing&&writesField)void readTargetFields();
  return()=>{targetEpoch.current++;};
 },[editing,branch,campaign,user.id,form.actionType]);
 useEffect(()=>{
  let current=true;
  setTargetDetails(null);setTargetDenied(false);
  if(editing&&writesField&&targetField)
   void api<FieldRow>('/api/automations/trigger-fields/'+targetField+'?'+fieldScopeQuery(addsTags?'TAGS':'ACTION').toString())
    .then(details=>{if(current)setTargetDetails(details);})
    .catch(()=>{if(current){setTargetValue(null);setTargetDenied(true);}});
  return()=>{current=false;};
 },[editing,branch,campaign,user.id,form.actionType,targetField,selected?.id]);
 function selectTargetField(id:string){setTargetField(id);setTargetValue(null);setTargetDetails(null);setTargetDenied(false);}
 async function readTriggerFields(after?:string){
  const request=++fieldEpoch.current;
  const query=fieldScopeQuery();
  if(after)query.set('after',after);
  try{
   const next=await api<TriggerFieldPage>('/api/automations/trigger-fields?'+query.toString());
   if(request===fieldEpoch.current)setFields(current=>({items:after?[...current.items,...next.items]:next.items,nextAfter:next.nextAfter}));
  }catch{
   if(request===fieldEpoch.current){setFields({items:[],nextAfter:null});setError(t.error);}
  }
 }
 useEffect(()=>{
  setFields({items:[],nextAfter:null});
  if(editing)void readTriggerFields();
  return()=>{fieldEpoch.current++;};
 },[branch,campaign,editing,user.id]);
 useEffect(()=>{
  let current=true;
  setConditionDetails(null);setConditionDenied(false);
  if(editing&&conditionField)void api<FieldRow>('/api/automations/trigger-fields/'+conditionField+'?'+fieldScopeQuery().toString())
   .then(details=>{if(current)setConditionDetails(details);})
   .catch(()=>{if(current){setConditionValue(null);setConditionDenied(true);}});
  return()=>{current=false;};
 },[conditionField,branch,campaign,editing,user.id,selected?.id]);
 function selectConditionField(id:string){setConditionField(id);setConditionValue(null);setConditionDetails(null);setConditionDenied(false);}
 function edit(r:Rule|null){epoch.current++;setSelected(r);setBranch(r?.branch_id??user.branchId??'');setCampaign(r?.campaign_id??'');
  setConditionField(r?.condition_field_id??'');setConditionValue(r?.condition_field_value??null);
  setTargetField(r?.action_field_id??'');setTargetValue(r?.action_field_value??null);
  setConditionAgent(r?.condition_agent_id?{id:r.condition_agent_id,name:r.condition_agent_name}:null);setAgentSearch('');
  setAssignmentTarget(r?.action_agent_id?{id:r.action_agent_id,name:r.action_agent_name}:null);
  setDateCondition(r?.condition_date_basis?{basis:r.condition_date_basis,from:r.condition_date_from??'',through:r.condition_date_through??''}:emptyDate);
  setForm(r?{name:r.name,enabled:r.enabled,triggerType:r.trigger_type,triggerFieldId:r.trigger_field_id,lifecycle:r.lifecycle,ownerCondition:r.owner_condition,
  paymentCondition:r.payment_condition,enrollmentCondition:r.enrollment_condition,
  conversationStateCondition:r.conversation_state_condition,controllerCondition:r.controller_condition,
  actionType:r.action_field_operation==='ADD_TAGS'?'ADD_TAGS':r.action_type,
  delayMinutes:r.delay_minutes,priority:r.priority,note:r.note,reason:''}:initial());setEditing(true);setHistory(null);setError('');setBusy(false);}
 const currentConditionField=conditionDetails?.id===conditionField?conditionDetails:null;
 const keepHiddenCondition=conditionDenied&&selected?.condition_field_id===conditionField;
 const missingConditionValue=Boolean(conditionField&&!keepHiddenCondition&&(!currentConditionField||conditionValue===null));
 const currentTarget=targetDetails?.id===targetField?targetDetails:null;
 const keepHiddenTarget=Boolean(targetDenied&&selected?.action_field_id===targetField&&!form.enabled);
 const missingTarget=writesField&&!keepHiddenTarget&&(!currentTarget||targetValue===null||
  addsTags&&(!Array.isArray(targetValue)||targetValue.length===0));
 const invalidDate=Boolean(dateCondition.basis&&(!dateCondition.from&&!dateCondition.through||
  dateCondition.from&&dateCondition.through&&dateCondition.from>dateCondition.through));
 const missingAssignee=assignsLead&&!assignmentTarget;
 async function save(){if(missingConditionValue||invalidDate||missingTarget||missingAssignee)return;setBusy(true);setError('');setHistory(null);try{
  const value=currentConditionField?.field_type==='DATETIME'&&typeof conditionValue==='string'?new Date(conditionValue).toISOString():conditionValue;
  const fieldCondition=keepHiddenCondition?undefined:conditionField?{fieldId:conditionField,value}:null;
  const target=currentTarget?.field_type==='DATETIME'&&typeof targetValue==='string'?new Date(targetValue).toISOString():targetValue;
  const fieldAction=keepHiddenTarget?undefined:writesField?{fieldId:targetField,value:target,operation:addsTags?'ADD_TAGS':'SET'}:null;
  const definition={...form,actionType:writesField?'SET_FIELD_VALUE':form.actionType,fieldCondition,fieldAction,conditionAgentId:conditionAgent?.id??null,
   actionAgentId:assignsLead?assignmentTarget?.id??null:null,
   dateCondition:dateCondition.basis?{basis:dateCondition.basis,from:dateCondition.from||undefined,
    through:dateCondition.through||undefined}:null};
  const payload=selected?{...definition,version:selected.version}:{...definition,branchId:branch||null,campaignId:campaign||null};
  await api('/api/automations'+(selected?'/'+selected.id:''),{method:selected?'PUT':'POST',body:JSON.stringify(payload)});
  setEditing(false);setSelected(null);setForm(initial());await readRules();
 }catch{failed();}finally{setBusy(false);}}
 async function retry(item:Processing){setBusy(true);setError('');setHistory(null);try{
  await api('/api/automation/'+kind+'/'+item.id+'/retry',{method:'POST',body:JSON.stringify({version:item.version})});await readProcessing();
 }catch{failed();}finally{setBusy(false);}}
 const financial={ar:['تأكيد الدفع','تأكيد التسجيل'],en:['Payment confirmed','Enrollment confirmed'],fr:['Paiement confirmé','Inscription confirmée']}[locale];
 const financialFields={
  ar:{payment:'شرط الدفع',enrollment:'شرط التسجيل',confirmedTest:'تأكيد في وضع الاختبار',unconfirmedTest:'لا تأكيد في وضع الاختبار',confirmedLive:'تأكيد في الوضع الحي',unconfirmedLive:'لا تأكيد في الوضع الحي'},
  en:{payment:'Payment condition',enrollment:'Enrollment condition',confirmedTest:'Confirmed in test mode',unconfirmedTest:'No confirmation in test mode',confirmedLive:'Confirmed in live mode',unconfirmedLive:'No confirmation in live mode'},
  fr:{payment:'Condition de paiement',enrollment:'Condition d’inscription',confirmedTest:'Confirmé en mode test',unconfirmedTest:'Aucune confirmation en mode test',confirmedLive:'Confirmé en mode réel',unconfirmedLive:'Aucune confirmation en mode réel'},
 }[locale];
 const financialOptions=[['ANY',t.any],['TEST_CONFIRMED',financialFields.confirmedTest],['TEST_UNCONFIRMED',financialFields.unconfirmedTest],
  ['LIVE_CONFIRMED',financialFields.confirmedLive],['LIVE_UNCONFIRMED',financialFields.unconfirmedLive]];
 const conversationFields={
  ar:{state:'شرط حالة المحادثة',controller:'شرط متحكم المحادثة',states:['الذكاء الاصطناعي نشط','الذكاء الاصطناعي ينتظر العميل','تسليم بشري مطلوب','بانتظار موظف','محادثة بشرية نشطة','مغلقة'],
   controllers:['الذكاء الاصطناعي','موظف','بلا متحكم']},
  en:{state:'Conversation state condition',controller:'Conversation controller condition',states:['AI active','AI waiting for lead','AI handoff required','Waiting for a person','Human active','Closed'],
   controllers:['AI','Human','No controller']},
  fr:{state:'Condition d’état de la conversation',controller:'Condition de contrôle de la conversation',states:['IA active','IA en attente du prospect','Transfert humain requis','En attente d’une personne','Suivi humain actif','Fermée'],
   controllers:['IA','Personne','Sans contrôleur']},
 }[locale];
 const due={ar:'استحقاق متابعة',en:'Follow-up due',fr:'Suivi arrivé à échéance'}[locale];
 const received={ar:'استلام رسالة',en:'Message received',fr:'Message reçu'}[locale];
 const conversationChanged={ar:'تغيّر حالة المحادثة',en:'Conversation state changed',fr:'État de la conversation modifié'}[locale];
 const field={ar:{changed:'تغيّر قيمة حقل',select:'الحقل المراقب',choose:'اختر حقلًا',unavailable:'الحقل غير متاح للأتمتة',more:'المزيد من الحقول',
   condition:'حقل شرط المساواة',value:'القيمة المطابقة',yes:'نعم',no:'لا'},
  en:{changed:'Field changed',select:'Watched field',choose:'Choose a field',unavailable:'Field unavailable for automation',more:'More fields',
   condition:'Field equality condition',value:'Matching value',yes:'Yes',no:'No'},
  fr:{changed:'Champ modifié',select:'Champ surveillé',choose:'Choisir un champ',unavailable:'Champ indisponible pour l’automatisation',more:'Plus de champs',
   condition:'Condition d’égalité du champ',value:'Valeur à comparer',yes:'Oui',no:'Non'}}[locale];
 const ownerDate={
  en:{agent:'Assigned agent condition',search:'Search agents',more:'More agents',unavailable:'Agent unavailable for this rule',
   basis:'Date condition',from:'From date (UTC)',through:'Through date (UTC)',lead:'Lead creation date',event:'Source event capture date',
   invalid:'Enter at least one date and keep the start on or before the end.'},
  ar:{agent:'شرط الموظف المعيّن',search:'البحث عن موظف',more:'المزيد من الموظفين',unavailable:'الموظف غير متاح لهذه القاعدة',
   basis:'شرط التاريخ',from:'من تاريخ (UTC)',through:'حتى تاريخ شامل (UTC)',lead:'تاريخ إنشاء الفرصة',event:'تاريخ التقاط الحدث',
   invalid:'أدخل تاريخًا واحدًا على الأقل، واجعل البداية تسبق النهاية أو تساويها.'},
  fr:{agent:'Condition d’agent attribué',search:'Rechercher un agent',more:'Autres agents',unavailable:'Agent indisponible pour cette règle',
   basis:'Condition de date',from:'À partir du (UTC)',through:'Jusqu’au inclus (UTC)',lead:'Date de création du prospect',event:'Date de capture de l’événement',
   invalid:'Saisissez au moins une date et choisissez un début antérieur ou égal à la fin.'},
 }[locale];
 const fieldAction={
  en:{action:'Set field value',field:'Field to update',value:'Value to set',already:'Field already has the approved value',
   addTags:'Add tags',tags:'Tags to add',limit:'Adding these tags would exceed the field limit'},
  ar:{action:'تعيين قيمة حقل',field:'الحقل المراد تحديثه',value:'القيمة المراد حفظها',already:'القيمة المعتمدة محفوظة بالفعل',
   addTags:'إضافة وسوم',tags:'الوسوم المراد إضافتها',limit:'إضافة هذه الوسوم تتجاوز الحد الأقصى للحقل'},
  fr:{action:'Définir la valeur du champ',field:'Champ à mettre à jour',value:'Valeur à définir',already:'Le champ contient déjà la valeur approuvée',
   addTags:'Ajouter des étiquettes',tags:'Étiquettes à ajouter',limit:'Cet ajout dépasserait la limite du champ'},
 }[locale];
 const assignment={
  en:{action:'Assign lead',recipient:'Assignment agent',choose:'Choose an agent',unavailable:'Assignment agent is unavailable or ineligible',already:'Lead already has this owner'},
  ar:{action:'إسناد الفرصة',recipient:'الموظف الذي ستُسند إليه الفرصة',choose:'اختر موظفًا',unavailable:'الموظف غير متاح أو غير مؤهل للإسناد',already:'الفرصة مسندة إلى الموظف نفسه'},
  fr:{action:'Attribuer le prospect',recipient:'Agent destinataire',choose:'Choisir un agent',unavailable:'Agent indisponible ou non admissible',already:'Le prospect est déjà attribué à cet agent'},
 }[locale];
 const handoff={
  ar:{action:'تحويل المحادثة إلى موظف',help:'تُنقل المحادثة التي يتحكم بها AI إلى انتظار موظف إذا كانت أداة التحويل معتمدة للحملة. يبقى مالك الفرصة كما هو.',
   unavailable:'تعذّر تحديد محادثة واحدة للتحويل',changed:'لم تعد المحادثة تحت تحكم AI',denied:'أداة تحويل المحادثة غير معتمدة للحملة'},
  en:{action:'Hand conversation to staff',help:'An AI-controlled conversation moves to waiting for staff when the campaign has approved handoff. The lead keeps its current owner.',
   unavailable:'No single conversation is available for handoff',changed:'The conversation is no longer controlled by AI',denied:'The campaign has not approved the handoff tool'},
  fr:{action:'Transférer la conversation à un agent',help:'Une conversation contrôlée par l’IA passe en attente d’un agent si la campagne a approuvé le transfert. Le responsable du prospect reste le même.',
   unavailable:'Aucune conversation unique n’est disponible pour le transfert',changed:'La conversation n’est plus contrôlée par l’IA',denied:'La campagne n’a pas approuvé l’outil de transfert'},
 }[locale];
 const automationSummary={
  ar:{action:'تلخيص المحادثة للموظفين',help:'يلخّص سجل محادثة واحدة باستخدام Profile التلخيص المعتمدة للحملة.'},
  en:{action:'Summarize conversation for staff',help:'Summarizes one conversation using the campaign’s approved summary profile.'},
  fr:{action:'Résumer la conversation pour les agents',help:'Résume une conversation avec le profil de synthèse approuvé pour la campagne.'},
 }[locale];
 const aiFollowup={
  ar:{action:'بدء متابعة AI',help:'يبدأ تسلسل المتابعة المعتمد للحملة بعد رسالة AI مؤكدة في المحادثة الحالية.',unavailable:'المحادثة غير مؤهلة لبدء متابعة AI',duplicate:'جُدولت متابعة لهذه الرسالة سابقًا'},
  en:{action:'Start AI follow-up',help:'Starts the campaign’s approved follow-up sequence after an acknowledged AI message in the current conversation.',unavailable:'Conversation is not eligible for AI follow-up',duplicate:'Follow-up for this message was already scheduled'},
  fr:{action:'Démarrer un suivi IA',help:'Démarre la séquence approuvée pour la campagne après un message IA confirmé dans la conversation actuelle.',unavailable:'Conversation non admissible au suivi IA',duplicate:'Un suivi a déjà été planifié pour ce message'},
 }[locale];
 const actionLabels={CREATE_FOLLOW_UP:t.follow,SEND_IN_APP_NOTIFICATION:t.notify,SET_FIELD_VALUE:fieldAction.action,ADD_TAGS:fieldAction.addTags,
  ASSIGN_LEAD:assignment.action,REQUEST_HUMAN_ATTENTION:{
   ar:'طلب مراجعة بشرية',en:'Request human review',fr:'Demander une vérification humaine',
  }[locale],CLOSE_LEAD:{ar:'إغلاق الفرصة',en:'Close lead',fr:'Clôturer le prospect'}[locale],REQUEST_CONVERSATION_HANDOFF:handoff.action,
  REQUEST_CONVERSATION_SUMMARY:automationSummary.action,START_AI_FOLLOWUP:aiFollowup.action};
 const causal={
  ar:{AUTOMATION_CAUSAL_REPEAT:'نُفذت القاعدة سابقًا في هذه السلسلة',AUTOMATION_CAUSAL_LIMIT:'بلغت السلسلة حد إجراءات الأتمتة'},
  en:{AUTOMATION_CAUSAL_REPEAT:'Rule already ran in this chain',AUTOMATION_CAUSAL_LIMIT:'Automation chain limit reached'},
  fr:{AUTOMATION_CAUSAL_REPEAT:'Règle déjà exécutée dans cette chaîne',AUTOMATION_CAUSAL_LIMIT:'Limite de la chaîne d’automatisation atteinte'},
 }[locale];
 const triggers=[['LEAD_CREATED',t.created],['LEAD_ASSIGNED',t.assigned],['LEAD_REASSIGNED',t.reassigned],
  ['PAYMENT_CONFIRMED',financial[0]],['ENROLLMENT_CONFIRMED',financial[1]],['FOLLOW_UP_DUE',due],['MESSAGE_RECEIVED',received],
  ['CONVERSATION_STATE_CHANGED',conversationChanged],['FIELD_CHANGED',field.changed]];
 const status=(s:string)=>(t.states as Record<string,string>)[s]??s;
 const result=(s:string|null)=>s==='FIELD_ALREADY_MATCHES'?fieldAction.already:s==='AUTOMATION_TAG_LIMIT_REACHED'?fieldAction.limit:
  s==='AUTOMATION_HANDOFF_CONVERSATION_UNAVAILABLE'?handoff.unavailable:s==='AUTOMATION_HANDOFF_CONTROLLER_CHANGED'?handoff.changed:
  s==='AUTOMATION_HANDOFF_TOOL_NOT_APPROVED'?handoff.denied:
  s==='AUTOMATION_FOLLOWUP_CONTEXT_UNAVAILABLE'?aiFollowup.unavailable:s==='AUTOMATION_FOLLOWUP_ALREADY_SCHEDULED'?aiFollowup.duplicate:
  s==='FIELD_REQUIRED'?{ar:'حقول مطلوبة للإغلاق لم تُستكمل',en:'Required closure fields are missing',fr:'Des champs requis pour la clôture sont manquants'}[locale]:
  s==='ASSIGNMENT_ALREADY_MATCHES'?assignment.already:s==='AUTOMATION_ASSIGNMENT_AGENT_UNAVAILABLE'?assignment.unavailable:
  s==='AUTOMATION_TRIGGER_FIELD_UNAVAILABLE'||s==='AUTOMATION_CONDITION_FIELD_UNAVAILABLE'||s==='AUTOMATION_ACTION_FIELD_UNAVAILABLE'
   ?field.unavailable:s?(causal as Record<string,string>)[s]??(t.results as Record<string,string>)[s]??t.error:'';
 return <section className="panel" data-automation-workspace><h2>{t.title}</h2><p>{t.warning}</p><div className="actions"><button disabled={busy} onClick={()=>edit(null)}>{t.new}</button><button disabled={busy} onClick={()=>void readRules()}>{t.reload}</button></div>
  {busy&&<p role="status">{t.loading}</p>}{error&&<p role="alert">{error}</p>}
  {editing&&<form data-automation-editor onSubmit={e=>{e.preventDefault();void save();}}><h3>{selected?t.edit:t.new}</h3>
   <label>{t.name}<input required maxLength={100} value={form.name} onChange={e=>change('name',e.target.value)}/></label>
   <label>{t.scope}<select aria-label={t.scope} disabled={Boolean(selected)||user.role==='MANAGER'||busy} value={branch} onChange={e=>{setBranch(e.target.value);setCampaign('');change('triggerFieldId',null);selectConditionField('');selectTargetField('');setConditionAgent(null);setAssignmentTarget(null);setAgentSearch('');}}>{user.role==='SUPER_ADMIN'&&<option value="">{t.system}</option>}{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
   <label>{t.campaign}<select aria-label={t.campaign} disabled={Boolean(selected)||!branch||busy} value={campaign} onChange={e=>{setCampaign(e.target.value);change('triggerFieldId',null);selectConditionField('');selectTargetField('');}}><option value="">{t.all}</option>
    {campaign&&!campaigns.some(c=>c.id===campaign)&&<option value={campaign}>{selected?.campaign_name??campaign}</option>}{campaigns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   {!selected&&nextCampaign&&<button type="button" disabled={busy} onClick={()=>void readCampaigns(nextCampaign)}>{t.moreCampaigns}</button>}
   <label>{t.trigger}<select aria-label={t.trigger} value={form.triggerType} onChange={e=>setForm(f=>({...f,triggerType:e.target.value,triggerFieldId:null}))}>{triggers.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
   {form.triggerType==='FIELD_CHANGED'&&<>
    <label>{field.select}<select aria-label={field.select} required value={form.triggerFieldId??''} onChange={e=>change('triggerFieldId',e.target.value||null)}>
     <option value="">{field.choose}</option>
     {form.triggerFieldId&&!fields.items.some(item=>item.id===form.triggerFieldId)&&<option value={form.triggerFieldId}>{field.unavailable}</option>}
     {fields.items.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
   </>}
   <fieldset><legend>{t.conditions}</legend><label>{t.lifecycle}<select aria-label={t.lifecycle} value={form.lifecycle??''} onChange={e=>change('lifecycle',e.target.value||null)}><option value="">{t.any}</option>{['OPEN','CLOSED','ARCHIVED'].map(s=><option key={s}>{s}</option>)}</select></label>
    <label>{t.owner}<select aria-label={t.owner} value={form.ownerCondition} onChange={e=>{change('ownerCondition',e.target.value);if(e.target.value==='UNASSIGNED')setConditionAgent(null);}}><option value="ANY">{t.any}</option><option value="ASSIGNED">{t.assignedCondition}</option><option value="UNASSIGNED">{t.unassigned}</option></select></label>
    {form.ownerCondition!=='UNASSIGNED'&&<>
     <label>{ownerDate.search}<input maxLength={100} value={agentSearch} onChange={e=>setAgentSearch(e.target.value)}/></label>
     <label>{ownerDate.agent}<select aria-label={ownerDate.agent} value={conditionAgent?.id??''}
      onChange={e=>setConditionAgent(agents.items.find(agent=>agent.id===e.target.value)??null)}>
      <option value="">{t.any}</option>
      {conditionAgent&&!agents.items.some(agent=>agent.id===conditionAgent.id)&&
       <option value={conditionAgent.id}>{conditionAgent.name??ownerDate.unavailable}</option>}
      {agents.items.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}
     </select></label>
     {agents.nextAfter&&<button type="button" disabled={busy} onClick={()=>void readAgents(agents.nextAfter!)}>{ownerDate.more}</button>}
    </>}
    <label>{ownerDate.basis}<select aria-label={ownerDate.basis} value={dateCondition.basis}
     onChange={e=>{const basis=e.target.value as DateDraft['basis'];setDateCondition(current=>basis?{...current,basis}:emptyDate);}}>
     <option value="">{t.any}</option><option value="LEAD_CREATED">{ownerDate.lead}</option><option value="EVENT_CAPTURED">{ownerDate.event}</option>
    </select></label>
    {dateCondition.basis&&<>
     <label>{ownerDate.from}<input type="date" value={dateCondition.from} max={dateCondition.through||undefined}
      onChange={e=>setDateCondition(current=>({...current,from:e.target.value}))}/></label>
     <label>{ownerDate.through}<input type="date" value={dateCondition.through} min={dateCondition.from||undefined}
      onChange={e=>setDateCondition(current=>({...current,through:e.target.value}))}/></label>
     {invalidDate&&<p role="status">{ownerDate.invalid}</p>}
    </>}
    {([['paymentCondition',financialFields.payment],['enrollmentCondition',financialFields.enrollment]] as const).map(([key,label])=>
     <label key={key}>{label}<select aria-label={label} value={form[key]} onChange={e=>change(key,e.target.value)}>
      {financialOptions.map(([value,text])=><option key={value} value={value}>{text}</option>)}
     </select></label>)}
    <label>{conversationFields.state}<select aria-label={conversationFields.state} value={form.conversationStateCondition??''} onChange={e=>change('conversationStateCondition',e.target.value||null)}>
     <option value="">{t.any}</option>
     {['AI_ACTIVE','AI_WAITING_FOR_LEAD','AI_HANDOFF_REQUIRED','WAITING_FOR_HUMAN','HUMAN_ACTIVE','CLOSED'].map((value,i)=>
      <option key={value} value={value}>{conversationFields.states[i]}</option>)}
    </select></label>
    <label>{conversationFields.controller}<select aria-label={conversationFields.controller} value={form.controllerCondition??''} onChange={e=>change('controllerCondition',e.target.value||null)}>
     <option value="">{t.any}</option>
     {['AI','HUMAN','NONE'].map((value,i)=><option key={value} value={value}>{conversationFields.controllers[i]}</option>)}
    </select></label>
    <label>{field.condition}<select aria-label={field.condition} value={conditionField} onChange={e=>selectConditionField(e.target.value)}>
     <option value="">{t.any}</option>
     {conditionField&&!fields.items.some(item=>item.id===conditionField)&&<option value={conditionField}>{currentConditionField?.label??field.unavailable}</option>}
     {fields.items.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    {conditionDenied&&<p role="status">{field.unavailable}</p>}
    {currentConditionField&&<label>{field.value}<FieldInput field={currentConditionField} value={conditionValue} onChange={setConditionValue}
     ariaLabel={field.value} booleanLabels={{yes:field.yes,no:field.no}}/></label>}
    {fields.nextAfter&&<button type="button" disabled={busy} onClick={()=>void readTriggerFields(fields.nextAfter!)}>{field.more}</button>}
   </fieldset>
   <label>{t.action}<select aria-label={t.action} value={form.actionType} onChange={e=>{
    selectTargetField('');setAssignmentTarget(null);setForm(f=>({...f,actionType:e.target.value,delayMinutes:e.target.value==='CREATE_FOLLOW_UP'?60:0,priority:'NORMAL'}));
   }}>
    {Object.entries(actionLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
   </select></label>
   {assignsLead&&<>
    {form.ownerCondition==='UNASSIGNED'&&<label>{ownerDate.search}<input maxLength={100} value={agentSearch} onChange={e=>setAgentSearch(e.target.value)}/></label>}
    <label>{assignment.recipient}<select aria-label={assignment.recipient} required value={assignmentTarget?.id??''}
     onChange={e=>setAssignmentTarget(agents.items.find(agent=>agent.id===e.target.value)??null)}>
     <option value="">{assignment.choose}</option>
     {assignmentTarget&&!agents.items.some(agent=>agent.id===assignmentTarget.id)&&
      <option value={assignmentTarget.id}>{assignmentTarget.name??assignment.unavailable}</option>}
     {agents.items.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}
    </select></label>
    {form.ownerCondition==='UNASSIGNED'&&agents.nextAfter&&<button type="button" disabled={busy}
     onClick={()=>void readAgents(agents.nextAfter!)}>{ownerDate.more}</button>}
   </>}
   {writesField&&<>
    <label>{fieldAction.field}<select aria-label={fieldAction.field} required value={targetField} onChange={e=>selectTargetField(e.target.value)}>
     <option value="">{field.choose}</option>
     {targetField&&!targets.items.some(item=>item.id===targetField)&&<option value={targetField}>{currentTarget?.label??field.unavailable}</option>}
     {targets.items.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    {targetDenied&&<p role="status">{field.unavailable}</p>}
    {currentTarget&&<label>{addsTags?fieldAction.tags:fieldAction.value}<FieldInput field={currentTarget} value={targetValue} onChange={setTargetValue}
     ariaLabel={addsTags?fieldAction.tags:fieldAction.value} booleanLabels={{yes:field.yes,no:field.no}}/></label>}
    {targets.nextAfter&&<button type="button" disabled={busy} onClick={()=>void readTargetFields(targets.nextAfter!)}>{field.more}</button>}
   </>}
   {form.actionType==='CREATE_FOLLOW_UP'&&<><label>{t.delay}<input type="number" min={0} max={525600} required value={form.delayMinutes} onChange={e=>change('delayMinutes',Number(e.target.value))}/></label>
    <label>{t.priority}<select aria-label={t.priority} value={form.priority} onChange={e=>change('priority',e.target.value)}>{['LOW','NORMAL','HIGH'].map(s=><option key={s}>{s}</option>)}</select></label></>}
   {form.actionType==='REQUEST_CONVERSATION_HANDOFF'&&<p>{handoff.help}</p>}
   {form.actionType==='REQUEST_CONVERSATION_SUMMARY'&&<p>{automationSummary.help}</p>}
   {form.actionType==='START_AI_FOLLOWUP'&&<p>{aiFollowup.help}</p>}
   {!writesField&&!assignsLead&&!['CLOSE_LEAD','REQUEST_CONVERSATION_HANDOFF','REQUEST_CONVERSATION_SUMMARY','START_AI_FOLLOWUP'].includes(form.actionType)&&<><p>{t.timing}</p><label>{t.note}<textarea maxLength={4000} value={form.note} onChange={e=>change('note',e.target.value)}/></label></>}
   <label><input type="checkbox" checked={form.enabled} onChange={e=>change('enabled',e.target.checked)}/>{t.enabled}</label>
   <label>{t.reason}<input minLength={3} maxLength={500} required value={form.reason} onChange={e=>change('reason',e.target.value)}/></label>
   {selected&&<p>{t.version} {selected.version}</p>}<div className="actions"><button disabled={busy||missingConditionValue||invalidDate||missingTarget||missingAssignee}>{t.save}</button><button type="button" disabled={busy} onClick={()=>setEditing(false)}>{t.cancel}</button></div>
  </form>}
  {rules.items.map(r=><article key={r.id} data-automation-rule={r.id}><h3>{r.name}</h3><p>{triggers.find(([v])=>v===r.trigger_type)?.[1]} → {r.action_field_operation==='ADD_TAGS'?fieldAction.addTags:actionLabels[r.action_type as keyof typeof actionLabels]} · {r.enabled?'✓':'—'} · {t.version} {r.version}</p>
   <button disabled={busy} onClick={()=>edit(r)}>{t.edit}</button><button disabled={busy} onClick={()=>void readHistory('/api/automations/'+r.id,true)}>{t.history}</button></article>)}
  {!busy&&!rules.items.length&&<p>{t.empty}</p>}{rules.nextCursor&&<button disabled={busy} onClick={()=>void readRules(rules.nextCursor!)}>{t.more}</button>}
  <section data-automation-processing><h3>{t.processing}</h3><label>{t.kind}<select aria-label={t.kind} value={kind} disabled={busy} onChange={e=>{epoch.current++;setKind(e.target.value as typeof kind);setProcessing({items:[],nextCursor:null});setHistory(null);}}><option value="executions">{t.executions}</option><option value="sources">{t.sources}</option></select></label><button disabled={busy} onClick={()=>void readProcessing()}>{t.refresh}</button>
   {processing.items.map(p=><article key={p.id} data-automation-processing-id={p.id}><h4>{p.rule_name??triggers.find(([v])=>v===p.trigger_type)?.[1]}</h4><p>{status(p.state)} · {result(p.result_code)} · {t.version} {p.version} · {p.failure_count}/5 · {new Date(p.created_at).toLocaleString(locale)}</p>
    {p.next_run_at&&<p>{new Date(p.next_run_at).toLocaleString(locale)}</p>}<button disabled={busy} onClick={()=>onOpenLead(p.lead_id)}>{t.openLead}</button>
    <button disabled={busy} onClick={()=>void readHistory('/api/automation/'+kind+'/'+p.id,false)}>{t.processingHistory}</button>{p.state==='DEAD_LETTER'&&<button disabled={busy} onClick={()=>void retry(p)}>{t.retry}</button>}</article>)}
   {!busy&&!processing.items.length&&<p>{t.empty}</p>}{processing.nextCursor&&<button disabled={busy} onClick={()=>void readProcessing(processing.nextCursor!)}>{t.more}</button>}
  </section>
  {history&&<section data-automation-history><h3>{history.rule?t.history:t.processingHistory}</h3>{history.items.map(h=><article key={h.version}>
    <p>{t.version} {h.version} · {new Date(h.created_at).toLocaleString(locale)}</p>
    {h.definition?<><p>{String(h.definition.name)} · {String(h.definition.reason)} · {String(h.definition.note)}</p>
     {typeof h.definition.condition_agent_id==='string'&&<p>{ownerDate.agent} · <bdi>{h.definition.condition_agent_id}</bdi></p>}
     {typeof h.definition.action_agent_id==='string'&&<p>{assignment.recipient} · <bdi>{h.definition.action_agent_id}</bdi></p>}
     {typeof h.definition.condition_date_basis==='string'&&<p>
      {h.definition.condition_date_basis==='LEAD_CREATED'?ownerDate.lead:ownerDate.event}
      {typeof h.definition.condition_date_from==='string'&&<> · {ownerDate.from} <bdi>{h.definition.condition_date_from}</bdi></>}
      {typeof h.definition.condition_date_through==='string'&&<> · {ownerDate.through} <bdi>{h.definition.condition_date_through}</bdi></>}
     </p>}
    </>:<p>{status(h.state??'')} · {result(h.result_code??null)} · {h.failure_count}/5</p>}
   </article>)}
   {history.nextVersion&&<button disabled={busy} onClick={()=>void readHistory(history.root,history.rule,history.nextVersion!)}>{t.more}</button>}</section>}
 </section>;
}
