import { useEffect,useState } from 'react';

type Locale = 'ar'|'en'|'fr';
type Api = <T>(path:string, options?:RequestInit)=>Promise<T>;
type Item = { id:string; state:'WAITING'|'READY'|'STOPPED'|'QUEUED'|'BLOCKED'|'FAILED'|'UNKNOWN'|'SENT'|'DELIVERED'|'READ'; reason:string|null; dueAt:string; changedAt:string };
type Page = { items:Item[];nextCursor:string|null };
const labels = {
  ar:{title:'متابعات AI المجدولة',review:'مراجعة متابعات AI',more:'المزيد',due:'موعد الاستحقاق',WAITING:'مجدولة',READY:'حان موعدها',STOPPED:'متوقفة',
    QUEUED:'في طابور الإرسال',BLOCKED:'منعتها السياسة',FAILED:'تعذر الإرسال',UNKNOWN:'نتيجة الإرسال غير مؤكدة',SENT:'قبلها المزوّد',DELIVERED:'تم التسليم',READ:'تمت القراءة',
    CUSTOMER_REPLIED:'ردّ العميل',AI_CONTROL_CHANGED:'تغير التحكم بالمحادثة',LEAD_NOT_OPEN:'الفرصة غير مفتوحة',CONVERSATION_NOT_ELIGIBLE:'المحادثة غير متاحة للمتابعة'},
  en:{title:'Scheduled AI follow-ups',review:'Review AI follow-ups',more:'More',due:'Due',WAITING:'Scheduled',READY:'Due',STOPPED:'Stopped',
    QUEUED:'Queued to send',BLOCKED:'Blocked by policy',FAILED:'Send failed',UNKNOWN:'Send outcome unknown',SENT:'Accepted by provider',DELIVERED:'Delivered',READ:'Read',
    CUSTOMER_REPLIED:'Customer replied',AI_CONTROL_CHANGED:'Conversation control changed',LEAD_NOT_OPEN:'Lead is not open',CONVERSATION_NOT_ELIGIBLE:'Conversation is not eligible'},
  fr:{title:'Suivis IA planifiés',review:'Consulter les suivis IA',more:'Afficher plus',due:'Échéance',WAITING:'Planifié',READY:'À échéance',STOPPED:'Arrêté',
    QUEUED:'En file d’envoi',BLOCKED:'Bloqué par la politique',FAILED:'Échec de l’envoi',UNKNOWN:'Résultat de l’envoi inconnu',SENT:'Accepté par le fournisseur',DELIVERED:'Distribué',READ:'Lu',
    CUSTOMER_REPLIED:'Le client a répondu',AI_CONTROL_CHANGED:'Le contrôle a changé',LEAD_NOT_OPEN:'Le prospect n’est pas ouvert',CONVERSATION_NOT_ELIGIBLE:'Conversation non admissible'},
};

export function AIFollowupSchedule({leadId,locale,api}:{leadId:string;locale:Locale;api:Api}) {
  const t=labels[locale],path=`/api/leads/${leadId}/ai-followups`;
  const [page,setPage]=useState<Page|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setPage(null);setError('');},[leadId]);
  async function load(cursor?:string) {
    setBusy(true);setError('');
    try {
      const result=await api<Page>(path+(cursor?`?cursor=${encodeURIComponent(cursor)}`:''));
      setPage(result);
    } catch(failure){setPage(null);setError((failure as Error).message);}finally{setBusy(false);}
  }
  return <section className="panel" data-ai-followup-schedule><h3>{t.title}</h3>
    <button type="button" className="secondary" disabled={busy} onClick={()=>void load()}>{t.review}</button>
    {error&&<p role="alert" className="error">{error}</p>}
    {page&&<ul className="timeline">{page.items.map(item=><li key={item.id}>
      <span>{t[item.state]}{item.reason&&<small>{t[item.reason as keyof typeof t]??item.reason}</small>}</span>
      <time>{t.due} · {new Date(item.dueAt).toLocaleString(locale)}</time></li>)}</ul>}
    {page?.nextCursor&&<button type="button" className="secondary" disabled={busy} onClick={()=>void load(page.nextCursor!)}>{t.more}</button>}
  </section>;
}
