import type {NotificationLocale} from './NotificationCenter.js';
const reasons={
 ar:{SEND_OUTCOME_UNKNOWN:'نتيجة الإرسال غير مؤكدة',DELIVERY_FAILED:'تعذر التسليم',PARTICIPANT_CHANGED:'تغيرت جهة الاتصال',CONNECTION_SENDER_MISMATCH:'يلزم فحص اتصال المرسل',AMBIGUOUS_ACTIVE_CONVERSATIONS:'محادثات نشطة ملتبسة',NO_HUMAN_CONTROLLER:'يلزم تحديد مسؤول بشري',PINNED_SENDER_REVIEW_REQUIRED:'المرسل المثبت يحتاج مراجعة',TEMPLATE_REVIEW_REQUIRED:'القالب يحتاج مراجعة',REVIEW_REQUIRED:'تحتاج مراجعة من الفريق'},
 en:{SEND_OUTCOME_UNKNOWN:'Send outcome is unknown',DELIVERY_FAILED:'Delivery failed',PARTICIPANT_CHANGED:'Participant changed',CONNECTION_SENDER_MISMATCH:'Sender connection needs review',AMBIGUOUS_ACTIVE_CONVERSATIONS:'Ambiguous active conversations',NO_HUMAN_CONTROLLER:'Human controller required',PINNED_SENDER_REVIEW_REQUIRED:'Pinned sender needs review',TEMPLATE_REVIEW_REQUIRED:'Template needs review',REVIEW_REQUIRED:'Team review required'},
 fr:{SEND_OUTCOME_UNKNOWN:'Résultat d’envoi incertain',DELIVERY_FAILED:'Échec de livraison',PARTICIPANT_CHANGED:'Participant modifié',CONNECTION_SENDER_MISMATCH:'Connexion de l’expéditeur à vérifier',AMBIGUOUS_ACTIVE_CONVERSATIONS:'Conversations actives ambiguës',NO_HUMAN_CONTROLLER:'Responsable humain requis',PINNED_SENDER_REVIEW_REQUIRED:'Expéditeur fixé à vérifier',TEMPLATE_REVIEW_REQUIRED:'Modèle à vérifier',REVIEW_REQUIRED:'Vérification par l’équipe requise'},
};
const leadReasons={
 ar:{NO_ELIGIBLE_AGENT:'لا يوجد وكيل مؤهل',UNASSIGNED_BY_MANAGER:'ألغى المدير الإسناد',LEAD_UNASSIGNED:'تحتاج الفرصة إلى إسناد'},
 en:{NO_ELIGIBLE_AGENT:'No eligible agent',UNASSIGNED_BY_MANAGER:'Unassigned by manager',LEAD_UNASSIGNED:'Lead requires assignment'},
 fr:{NO_ELIGIBLE_AGENT:'Aucun agent éligible',UNASSIGNED_BY_MANAGER:'Attribution retirée par le responsable',LEAD_UNASSIGNED:'Prospect à attribuer'},
};
export function attentionReasonLabel(code:string,locale:NotificationLocale){
 return leadReasons[locale][code as keyof typeof leadReasons.en]??reasons[locale][code as keyof typeof reasons.en]??reasons[locale].REVIEW_REQUIRED;
}
