import { HttpError } from './security.js';

export type NotificationLanguage = 'ar'|'en'|'fr';
export const notificationEvent = 'AI_HANDOFF_REQUESTED' as const;
export type NotificationEventType=typeof notificationEvent|'AI_HANDOFF_SLA_EXCEEDED'|'LEAD_CREATED'|'LEAD_ASSIGNED'|'LEAD_REASSIGNED'|'FOLLOW_UP_DUE'|'PAYMENT_CONFIRMED'|'ENROLLMENT_CONFIRMED';
export const notificationEvents:readonly NotificationEventType[]=[notificationEvent,'AI_HANDOFF_SLA_EXCEEDED','LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','FOLLOW_UP_DUE','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED'];
export function requireNotificationBodyTypes(value:unknown,flag:string,strings:readonly string[]=[]):void {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'INVALID_NOTIFICATION_REQUEST');
 const body=value as Record<string,unknown>;
 if(typeof body[flag]!=='boolean'||typeof body.version!=='number'||!Number.isInteger(body.version)||body.version<0||body.version>2147483646
  ||strings.some(k=>typeof body[k]!=='string'))throw new HttpError(400,'INVALID_NOTIFICATION_REQUEST');
}
export const notificationDefaults = {
 ar:{title:'متابعة بشرية مطلوبة — {{campaign}}',body:'طلبت المحادثة متابعة من الفريق البشري. افتح الفرصة لمراجعة التفاصيل.',owner:'غير مسندة'},
 en:{title:'Human follow-up requested — {{campaign}}',body:'The conversation needs human follow-up. Open the lead to review the details.',owner:'Unassigned'},
 fr:{title:'Suivi humain demandé — {{campaign}}',body:'La conversation nécessite un suivi humain. Ouvrez le prospect pour consulter les détails.',owner:'Non attribué'},
} as const;
export const notificationDefaultsByEvent:Record<NotificationEventType,Record<NotificationLanguage,{title:string;body:string;owner:string}>>={
 PAYMENT_CONFIRMED:{
  ar:{...notificationDefaults.ar,title:'تأكيد دفع — {{campaign}}',body:'حُفظ دفع مؤكد من مصدر معتمد. راجع سجل الدفع في الفرصة للمبلغ ومصدر التأكيد؛ التسجيل سجل منفصل.'},
  en:{...notificationDefaults.en,title:'Payment confirmed — {{campaign}}',body:'A confirmed payment was recorded from an authorized source. Review the lead payment history for its amount and confirmation source; enrollment is a separate record.'},
  fr:{...notificationDefaults.fr,title:'Paiement confirmé — {{campaign}}',body:'Un paiement confirmé a été enregistré depuis une source autorisée. Consultez son montant et sa source dans le prospect ; l’inscription est un enregistrement distinct.'},
 },
 ENROLLMENT_CONFIRMED:{
  ar:{...notificationDefaults.ar,title:'تأكيد تسجيل — {{campaign}}',body:'حُفظ تسجيل مستقل مرتبط بدفع مؤكد. افتح الفرصة لمراجعة سجل التسجيل والدفع المرتبط به.'},
  en:{...notificationDefaults.en,title:'Enrollment confirmed — {{campaign}}',body:'A separate enrollment record was saved against a confirmed payment. Open the lead to review the enrollment and its linked payment.'},
  fr:{...notificationDefaults.fr,title:'Inscription confirmée — {{campaign}}',body:'Une inscription distincte a été enregistrée pour un paiement confirmé. Consultez l’inscription et le paiement lié dans le prospect.'},
 },
 FOLLOW_UP_DUE:{
  ar:{...notificationDefaults.ar,title:'موعد متابعة مستحق — {{campaign}}',body:'رُصد استحقاق مهمة متابعة. راجع حالتها وموعدها الحاليين قبل العمل؛ يُحفظ هذا التنبيه حتى بعد الإكمال أو إعادة الجدولة.'},
  en:{...notificationDefaults.en,title:'Follow-up due — {{campaign}}',body:'A follow-up task was observed due. Check its current status and schedule before acting; this notice is retained after completion or rescheduling.'},
  fr:{...notificationDefaults.fr,title:'Suivi arrivé à échéance — {{campaign}}',body:'Une tâche de suivi a atteint son échéance. Vérifiez son état et son échéance actuels ; cette notification reste conservée après la clôture ou la reprogrammation.'},
 },
 LEAD_CREATED:{
  ar:{...notificationDefaults.ar,title:'فرصة جديدة — {{campaign}}',body:'وصلت فرصة جديدة إلى الحملة. افتح الفرصة لمراجعة بياناتها ومالكها الحالي.'},
  en:{...notificationDefaults.en,title:'New lead — {{campaign}}',body:'A new lead arrived in this campaign. Open the lead to review its details and current owner.'},
  fr:{...notificationDefaults.fr,title:'Nouveau prospect — {{campaign}}',body:'Un nouveau prospect a été reçu pour cette campagne. Consultez ses détails et son propriétaire actuel.'},
 },
 LEAD_ASSIGNED:{
  ar:{...notificationDefaults.ar,title:'إسناد فرصة — {{campaign}}',body:'أُسندت الفرصة إلى موظف. افتحها لمراجعة المالك الحالي والمتابعة المطلوبة.'},
  en:{...notificationDefaults.en,title:'Lead assigned — {{campaign}}',body:'This lead was assigned to an agent. Open it to review the current owner and required follow-up.'},
  fr:{...notificationDefaults.fr,title:'Prospect attribué — {{campaign}}',body:'Ce prospect a été attribué à un agent. Consultez son propriétaire actuel et le suivi nécessaire.'},
 },
 LEAD_REASSIGNED:{
  ar:{...notificationDefaults.ar,title:'تغيير إسناد الفرصة — {{campaign}}',body:'تغير إسناد الفرصة. افتحها لمراجعة المالك الحالي؛ قد تكون الآن دون موظف.'},
  en:{...notificationDefaults.en,title:'Lead ownership changed — {{campaign}}',body:'The lead assignment changed. Open it to review the current owner; it may now be unassigned.'},
  fr:{...notificationDefaults.fr,title:'Attribution du prospect modifiée — {{campaign}}',body:'L’attribution du prospect a changé. Consultez son propriétaire actuel ; il peut maintenant être non attribué.'},
 },
 AI_HANDOFF_REQUESTED:notificationDefaults,
 AI_HANDOFF_SLA_EXCEEDED:{
  ar:{...notificationDefaults.ar,title:'تجاوز مدة الاستجابة البشرية — {{campaign}}',body:'تجاوزت المحادثة مدة الاستجابة البشرية المهيأة. افتح الفرصة لمراجعة حالتها الحالية؛ التنبيه متاح للمالك الحالي ومديري الفرع.'},
  en:{...notificationDefaults.en,title:'Human response target exceeded — {{campaign}}',body:'The conversation exceeded its configured human response target. Open the lead to review its current state. This alert is available to the current owner and branch managers.'},
  fr:{...notificationDefaults.fr,title:'Objectif de réponse humaine dépassé — {{campaign}}',body:'La conversation a dépassé son objectif de réponse humaine. Consultez l’état actuel du prospect. Cette alerte est accessible au propriétaire actuel et aux responsables autorisés de l’agence.'},
 },
} as const;
export function validateNotificationText(text:string,max:number) {
 if (!text.trim() || Array.from(text).length>max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
  || /[{}]/.test(text.replaceAll('{{campaign}}','').replaceAll('{{owner}}',''))) throw new HttpError(400,'INVALID_NOTIFICATION_TEMPLATE');
 return text.trim();
}
export function renderNotification(text:string,values:{campaign:string;owner:string}) {
 // Values are plain, untrusted text. No recursive evaluation or replacement-string expansion.
 return text.replace(/\{\{(campaign|owner)\}\}/g,(_match,key:'campaign'|'owner')=>values[key]);
}
export type NotificationTemplate = {scope:'GLOBAL'|'BRANCH'|'CAMPAIGN';resource_id:string;branch_id:string|null;title:string;body:string;version:number;active:boolean;event_type?:NotificationEventType};
export function effectiveNotificationTemplate(templates:NotificationTemplate[],organization:string,branch:string,campaign:string,language:NotificationLanguage,event:NotificationEventType=notificationEvent) {
 for (const [scope,id] of [['CAMPAIGN',campaign],['BRANCH',branch],['GLOBAL',organization]] as const) {
  const found=templates.find(t=>t.scope===scope && t.resource_id===id && t.active && (t.event_type??notificationEvent)===event && (scope==='GLOBAL'?t.branch_id===null:t.branch_id===branch));
  if(found)return {title:found.title,body:found.body,source:scope,version:found.version};
 }
 const defaults=notificationDefaultsByEvent[event][language];return {title:defaults.title,body:defaults.body,source:'DEFAULT',version:0};
}
