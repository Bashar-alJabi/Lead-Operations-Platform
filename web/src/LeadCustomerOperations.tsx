import { useState } from 'react';
import { LeadPaymentRequests } from './LeadPaymentRequests';
import { LeadConversations } from './LeadConversations';

// Mounted per Lead: a selected link cannot become another Lead's message context.
export function LeadCustomerOperations({ leadId,lifecycle,role,actorId,locale,api }: {
  leadId:string;lifecycle:string;role:'SUPER_ADMIN'|'MANAGER'|'AGENT';actorId:string;locale:'ar'|'en'|'fr';
  api:<T>(path:string,options?:RequestInit)=>Promise<T>;
}) {
  const [paymentIntentId,setPaymentIntentId]=useState<string|null>(null);
  return <>
    <LeadPaymentRequests leadId={leadId} locale={locale} api={api} onPrepareMessage={setPaymentIntentId} />
    <LeadConversations leadId={leadId} lifecycle={lifecycle} role={role} actorId={actorId} locale={locale} api={api}
      paymentIntentId={paymentIntentId} onClearPayment={()=>setPaymentIntentId(null)} />
  </>;
}
