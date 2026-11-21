import {useEffect,useState} from 'react';

type Locale='ar'|'en'|'fr';
type Api=<T>(path:string,options?:RequestInit)=>Promise<T>;
type Policy={
 version:number;lookbackDays:number;minimumSamples:number;responseWeight:number;followUpWeight:number;
 fallbackMethod:string;reason:string;changedAt?:string;
};
type History={items:Policy[];nextVersion:number|null};

const words={
 ar:{title:'سياسة التوزيع حسب الأداء',days:'فترة القياس بالأيام',samples:'الحد الأدنى للعينة لكل مقياس',response:'وزن سرعة الاستجابة البشرية',
  followUp:'وزن المتابعات المنجزة في وقتها',fallback:'التوزيع عند نقص العينة',manual:'يدوي',roundRobin:'بالتناوب',weighted:'حسب الأوزان',
  reason:'سبب تعديل سياسة التوزيع',save:'حفظ سياسة التوزيع',history:'سجل السياسة',more:'إصدارات أقدم',version:'الإصدار',
  total:'يجب أن يكون مجموع الأوزان 100.',error:'تعذر تحميل سياسة التوزيع أو حفظها.',reload:'تحديث السياسة'},
 en:{title:'Performance routing policy',days:'Lookback days',samples:'Minimum samples per metric',response:'Human response speed weight',
  followUp:'On-time follow-up weight',fallback:'Fallback when samples are insufficient',manual:'Manual',roundRobin:'Round robin',weighted:'Weighted',
  reason:'Routing policy change reason',save:'Save routing policy',history:'Policy history',more:'Older versions',version:'Version',
  total:'The weights must total 100.',error:'Unable to load or save the routing policy.',reload:'Reload policy'},
 fr:{title:'Politique de routage par performance',days:'Fenêtre en jours',samples:'Échantillons minimum par mesure',response:'Poids de la rapidité de réponse humaine',
  followUp:'Poids des suivis terminés à temps',fallback:'Routage de repli en cas d’échantillon insuffisant',manual:'Manuel',roundRobin:'Tour de rôle',weighted:'Pondéré',
  reason:'Motif de modification du routage',save:'Enregistrer la politique',history:'Historique de la politique',more:'Versions précédentes',version:'Version',
  total:'Le total des poids doit être de 100.',error:'Impossible de charger ou d’enregistrer la politique.',reload:'Recharger la politique'},
} as const;

const initial:Policy={version:0,lookbackDays:30,minimumSamples:10,responseWeight:50,followUpWeight:50,fallbackMethod:'ROUND_ROBIN',reason:''};

export function CampaignPerformanceRouting({campaignId,locale,api,editable,onSaved}:{
 campaignId:string;locale:Locale;api:Api;editable:boolean;onSaved:()=>Promise<void>;
}){
 const t=words[locale],path='/api/campaigns/'+campaignId+'/performance-routing';
 const [policy,setPolicy]=useState<Policy|null>(null),[history,setHistory]=useState<History|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(false);
 const fallbacks={MANUAL:t.manual,ROUND_ROBIN:t.roundRobin,WEIGHTED:t.weighted};
 async function load(){
  const response=await api<{policy:Policy|null}>(path);
  setPolicy(response.policy?{...response.policy,reason:''}:initial);
 }
 async function run(operation:()=>Promise<void>){
  setBusy(true);setError(false);
  try{await operation();}
  catch{setPolicy(null);setHistory(null);setError(true);}
  finally{setBusy(false);}
 }
 useEffect(()=>{void run(load);},[path]);
 const change=(key:keyof Policy,value:string|number)=>setPolicy(current=>current?{...current,[key]:value}:null);
 const totalCorrect=policy!==null&&policy.responseWeight+policy.followUpWeight===100;
 function save(){
  if(!policy)return;
  const {changedAt:_time,...body}=policy;
  void run(async()=>{
   await api(path,{method:'PUT',body:JSON.stringify(body)});
   setHistory(null);
   await Promise.all([load(),onSaved()]);
  });
 }
 function readHistory(before?:number){
  void run(async()=>setHistory(await api<History>(path+'/history'+(before?'?before='+before:''))));
 }
 return <section className="panel" data-performance-routing-policy>
  <h3>{t.title}</h3>
  {error&&<p role="alert">{t.error}</p>}
  <button type="button" disabled={busy} onClick={()=>void run(load)}>{t.reload}</button>
  {policy&&<>
   {policy.version>0&&<p>{t.version} {policy.version}</p>}
   <form className="campaign-form" onSubmit={event=>{event.preventDefault();save();}}>
    {([
      ['lookbackDays',t.days,1,90],['minimumSamples',t.samples,1,100],
      ['responseWeight',t.response,0,100],['followUpWeight',t.followUp,0,100],
     ] as const).map(([key,label,min,max])=><label key={key}>{label}
      <input type="number" min={min} max={max} required disabled={!editable||busy} value={Number.isNaN(policy[key])?'':policy[key]}
       onChange={event=>change(key,event.target.value===''?NaN:Number(event.target.value))}/>
     </label>)}
    <label>{t.fallback}<select disabled={!editable||busy} value={policy.fallbackMethod}
     onChange={event=>change('fallbackMethod',event.target.value)}>
     {Object.entries(fallbacks).map(([value,label])=><option key={value} value={value}>{label}</option>)}
    </select></label>
    <label>{t.reason}<input required minLength={3} maxLength={500} disabled={!editable||busy} value={policy.reason}
     onChange={event=>change('reason',event.target.value)}/></label>
    {!totalCorrect&&<p role="status">{t.total}</p>}
    <button disabled={!editable||busy||!totalCorrect}>{t.save}</button>
   </form>
   {policy.version>0&&<button type="button" disabled={busy} onClick={()=>readHistory()}>{t.history}</button>}
  </>}
  {history&&<ul>{history.items.map(item=><li key={item.version}>
   {t.version} {item.version} · {t.days} {item.lookbackDays} · {t.samples} {item.minimumSamples}
   {' · '}{t.response} {item.responseWeight} · {t.followUp} {item.followUpWeight}
   {' · '}{fallbacks[item.fallbackMethod as keyof typeof fallbacks]} · <bdi>{item.reason}</bdi>
  </li>)}</ul>}
  {history?.nextVersion&&<button type="button" disabled={busy} onClick={()=>readHistory(history.nextVersion!)}>{t.more}</button>}
 </section>;
}
