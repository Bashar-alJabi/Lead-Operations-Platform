import { useEffect,useState } from 'react';

type Locale = 'ar'|'en'|'fr';
type Api = <T>(path: string, options?: RequestInit)=>Promise<T>;
type Campaign = { id:string;name:string };
type Question = { key:string } & Record<Locale,string>;
type Filters = { question:string;branchId?:string;campaignId?:string;from?:string;to?:string;cursor?:string };
type Lead = { id:string;campaign_name:string;branch_name:string;contact_name:string|null;created_at:string };
type Performance = { aiContacted:string;humanContacted:string;customerResponded:string;converted:string;conversionConfigured:string;
  aiAttempts:string;humanAttempts:string };
type Answer = { count:string;timezone:string;asOf:string;from:string|null;to:string|null;performance:Performance|null;items:Lead[];nextCursor:string|null };

const labels = {
  ar: { title:'مساعد العمليات', question:'السؤال التشغيلي', examples:'أسئلة مدعومة', branch:'الفرع', campaign:'الحملة', all:'النطاق المتاح',
    from:'من', to:'إلى', ask:'اعرض النتيجة', source:'المصدر · تحليلات المنصة', matching:'الفرص المطابقة', period:'فترة إنشاء الفرص',
    allDates:'كل التواريخ', at:'حسب البيانات حتى', lead:'الفرصة', more:'المزيد من الفرص', moreCampaigns:'المزيد من الحملات',
    unsupported:'اختر أحد الأسئلة التشغيلية المدعومة أو اكتبه كما هو.', chooseCampaign:'اختر الحملة المراد تلخيصها.',
    dateConflict:'يعتمد سؤال اليوم على الفترة الحالية للفرع. امسح التواريخ المحددة.', performance:'أداء الحملة',
    aiContacted:'فرص تواصل معها AI', humanContacted:'فرص تواصل معها موظف', customerResponded:'فرص ردّ أصحابها',
    converted:'تحويلات', conversionConfigured:'فرص ينطبق عليها تعريف التحويل', aiAttempts:'محاولات AI', humanAttempts:'محاولات الموظفين' },
  en: { title:'Operations Assistant', question:'Operational question', examples:'Supported questions', branch:'Branch', campaign:'Campaign',all:'Available scope',
    from:'From', to:'To', ask:'Show answer', source:'Source · Platform analytics', matching:'Matching leads', period:'Lead creation period',
    allDates:'All dates', at:'Data as of', lead:'Lead', more:'More leads', moreCampaigns:'More campaigns',
    unsupported:'Choose or type one of the supported operational questions.', chooseCampaign:'Choose the campaign to summarize.',
    dateConflict:'Today uses the current branch date. Clear the selected dates.', performance:'Campaign performance',
    aiContacted:'Leads contacted by AI', humanContacted:'Leads contacted by staff', customerResponded:'Leads that replied',
    converted:'Conversions', conversionConfigured:'Leads with a conversion definition', aiAttempts:'AI attempts', humanAttempts:'Staff attempts' },
  fr: { title:'Assistant opérationnel', question:'Question opérationnelle', examples:'Questions disponibles', branch:'Agence', campaign:'Campagne',all:'Périmètre disponible',
    from:'Du', to:'Au', ask:'Afficher la réponse', source:'Source · Analyses de la plateforme', matching:'Prospects correspondants', period:'Période de création des prospects',
    allDates:'Toutes les dates', at:'Données au', lead:'Prospect', more:'Plus de prospects', moreCampaigns:'Plus de campagnes',
    unsupported:'Choisissez ou saisissez une question opérationnelle disponible.', chooseCampaign:'Sélectionnez la campagne à résumer.',
    dateConflict:'La question du jour utilise la date de l’agence. Effacez les dates sélectionnées.', performance:'Performance de la campagne',
    aiContacted:'Prospects contactés par l’IA', humanContacted:'Prospects contactés par le personnel', customerResponded:'Prospects ayant répondu',
    converted:'Conversions', conversionConfigured:'Prospects avec une définition de conversion', aiAttempts:'Tentatives de l’IA', humanAttempts:'Tentatives du personnel' },
};

export function AIOperationsFacts({ locale,api,branches,onOpenLead }: {
  locale:Locale;api:Api;branches:Array<{id:string;name:string}>;onOpenLead:(id:string)=>void;
}) {
  const t=labels[locale];
  const [questions,setQuestions]=useState<Question[]>([]);
  const [campaigns,setCampaigns]=useState<Campaign[]>([]);
  const [campaignCursor,setCampaignCursor]=useState<string|null>(null);
  const [question,setQuestion]=useState('');
  const [branchId,setBranchId]=useState('');
  const [campaignId,setCampaignId]=useState('');
  const [from,setFrom]=useState('');
  const [to,setTo]=useState('');
  const [answer,setAnswer]=useState<Answer|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);

  const campaignList=(cursor?:string)=>`/api/campaigns?${new URLSearchParams({...(branchId?{branchId}:{}),...(cursor?{cursor}:{})})}`;
  useEffect(()=>{
    const controller=new AbortController();
    void api<{items:Question[]}>('/api/ai/operations/questions',{signal:controller.signal}).then(page=>setQuestions(page.items))
      .catch(failure=>{if(!controller.signal.aborted)setError(failure.message);});
    return ()=>controller.abort();
  },[api]);
  useEffect(()=>{
    const controller=new AbortController();
    void api<{items:Campaign[];nextCursor:string|null}>(campaignList(),{signal:controller.signal}).then(page=>{
      if(!controller.signal.aborted){setCampaigns(page.items);setCampaignCursor(page.nextCursor);}
    }).catch(failure=>{if(!controller.signal.aborted)setError(failure.message);});
    return ()=>controller.abort();
  },[api,branchId]);

  function clearAnswer(){setAnswer(null);setError('');}
  async function ask(cursor?:string) {
    setBusy(true);setError('');
    const filters:Filters={question,branchId:branchId||undefined,campaignId:campaignId||undefined,cursor};
    try {
      if (from) filters.from=new Date(from).toISOString();
      if (to) filters.to=new Date(to).toISOString();
      const result=await api<Answer>('/api/ai/operations/facts',{method:'POST',body:JSON.stringify(filters)});
      setAnswer(result);
    } catch (failure) {setAnswer(null);setError((failure as Error).message);}
    finally {setBusy(false);}
  }
  async function moreCampaigns(cursor:string){
    setBusy(true);
    try {
      const page=await api<{items:Campaign[];nextCursor:string|null}>(campaignList(cursor));
      setCampaigns(current=>[...current,...page.items]);setCampaignCursor(page.nextCursor);
    } catch(failure){setError((failure as Error).message);} finally {setBusy(false);}
  }

  const fmt=(instant:string)=>answer?new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:answer.timezone})
    .format(new Date(instant)):instant;
  const number=(value:string)=>new Intl.NumberFormat(locale).format(BigInt(value));
  const localizedError:Record<string,string>={ OPERATIONS_QUESTION_UNSUPPORTED:t.unsupported,
    OPERATIONS_CAMPAIGN_REQUIRED:t.chooseCampaign,OPERATIONS_DATE_CONFLICT:t.dateConflict };
  return <section className="panel" data-operations-facts><h2>{t.title}</h2>
    {error&&<p className="error" role="alert">{localizedError[error]??error}</p>}
    <form className="workflow-form" onSubmit={event=>{event.preventDefault();void ask();}}>
      <label>{t.question}<input value={question} maxLength={240} required disabled={busy}
        onChange={event=>{setQuestion(event.target.value);clearAnswer();}} /></label>
      <label>{t.examples}<select value="" disabled={busy} onChange={event=>{
        const example=questions.find(item=>item.key===event.target.value);
        if(example){setQuestion(example[locale]);if(example.key==='LEADS_TODAY'){setFrom('');setTo('');}clearAnswer();}
      }}><option value="">{t.examples}</option>{questions.map(item=><option key={item.key} value={item.key}>{item[locale]}</option>)}</select></label>
      <label>{t.branch}<select value={branchId} disabled={busy} onChange={event=>{
        setBranchId(event.target.value);setCampaignId('');setCampaigns([]);setCampaignCursor(null);clearAnswer();
      }}><option value="">{t.all}</option>{branches.map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
      <label>{t.campaign}<select value={campaignId} disabled={busy} onChange={event=>{setCampaignId(event.target.value);clearAnswer();}}>
        <option value="">{t.all}</option>{campaigns.map(campaign=><option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></label>
      <label>{t.from}<input type="datetime-local" value={from} disabled={busy} onChange={event=>{setFrom(event.target.value);clearAnswer();}} /></label>
      <label>{t.to}<input type="datetime-local" value={to} disabled={busy} onChange={event=>{setTo(event.target.value);clearAnswer();}} /></label>
      <button disabled={busy||question.trim().length<3}>{t.ask}</button>
    </form>
    {campaignCursor&&<button className="secondary" disabled={busy} onClick={()=>void moreCampaigns(campaignCursor)}>{t.moreCampaigns}</button>}
    {answer&&<div aria-live="polite">
      <h3>{t.matching} · {number(answer.count)}</h3>
      <p>{t.source}</p>
      <p>{t.period} · {answer.from||answer.to?`${answer.from?fmt(answer.from):'—'} → ${answer.to?fmt(answer.to):'—'}`:t.allDates} ({answer.timezone})</p>
      <small>{t.at} · {fmt(answer.asOf)}</small>
      {answer.performance&&<><h4>{t.performance}</h4><div className="facts">
        {Object.entries(answer.performance).map(([key,value])=><div key={key}><small>{t[key as keyof Performance]}</small><strong>{number(value)}</strong></div>)}
      </div></>}
      <ul className="timeline">{answer.items.map(lead=><li key={lead.id}>
        <span><button className="link" onClick={()=>onOpenLead(lead.id)}>{lead.contact_name||t.lead}</button>
          <small>{lead.branch_name} · {lead.campaign_name}</small></span><time>{fmt(lead.created_at)}</time></li>)}</ul>
      {answer.nextCursor&&<button className="secondary" disabled={busy} onClick={()=>void ask(answer.nextCursor!)}>{t.more}</button>}
    </div>}
  </section>;
}
