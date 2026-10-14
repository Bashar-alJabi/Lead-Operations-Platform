import { HttpError } from './security.js';

export type NotificationLanguage = 'ar'|'en'|'fr';
export const notificationEvent = 'AI_HANDOFF_REQUESTED' as const;
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
export function validateNotificationText(text:string,max:number) {
 if (!text.trim() || Array.from(text).length>max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
  || /[{}]/.test(text.replaceAll('{{campaign}}','').replaceAll('{{owner}}',''))) throw new HttpError(400,'INVALID_NOTIFICATION_TEMPLATE');
 return text.trim();
}
export function renderNotification(text:string,values:{campaign:string;owner:string}) {
 // Values are plain, untrusted text. No recursive evaluation or replacement-string expansion.
 return text.replace(/\{\{(campaign|owner)\}\}/g,(_match,key:'campaign'|'owner')=>values[key]);
}
export type NotificationTemplate = {scope:'GLOBAL'|'BRANCH'|'CAMPAIGN';resource_id:string;branch_id:string|null;title:string;body:string;version:number;active:boolean};
export function effectiveNotificationTemplate(templates:NotificationTemplate[],organization:string,branch:string,campaign:string,language:NotificationLanguage) {
 for (const [scope,id] of [['CAMPAIGN',campaign],['BRANCH',branch],['GLOBAL',organization]] as const) {
  const found=templates.find(t=>t.scope===scope && t.resource_id===id && t.active && (scope==='GLOBAL'?t.branch_id===null:t.branch_id===branch));
  if(found)return {title:found.title,body:found.body,source:scope,version:found.version};
 }
 return {title:notificationDefaults[language].title,body:notificationDefaults[language].body,source:'DEFAULT',version:0};
}
