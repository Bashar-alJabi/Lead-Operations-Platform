export type Reception = { ownerId:string|null;ownerName:string|null;targetId:string|null;targetName:string|null;targetRole:string|null;targetSource:string;receiverId:string|null;reason:string;managerAttentionRequired:boolean;timezone:string };
const labels = {
  en:{ title:'Current handoff recipient',owner:'Lead owner',target:'Preferred recipient',manager:'Manager attention required. Review availability or use the authorized Lead assignment action. Human control still requires explicit acceptance.',ready:'Recipient available for review; Human control requires explicit acceptance.',note:'Recipient selection does not change Lead ownership or grant access. Capacity limits apply to new assignments.',history:'Recipient decision at request' },
  ar:{ title:'مستلم التسليم الحالي',owner:'مالك Lead',target:'المستلم المفضّل',manager:'تحتاج مراجعة Manager. راجع التوفّر أو استخدم إجراء إسناد Lead المصرّح به. قبول التحكم البشري يبقى صريحًا.',ready:'المستلم متاح للمراجعة؛ التحكم البشري يحتاج قبولًا صريحًا.',note:'اختيار المستلم لا يغيّر ملكية Lead ولا يمنح صلاحية وصول. حدود السعة تُطبّق على الإسنادات الجديدة.',history:'قرار المستلم عند الطلب' },
  fr:{ title:'Destinataire actuel du transfert',owner:'Propriétaire du Lead',target:'Destinataire préféré',manager:'Examen par un Manager requis. Vérifiez la disponibilité ou utilisez l’attribution autorisée du Lead. Le contrôle humain nécessite une acceptation explicite.',ready:'Destinataire disponible pour examen ; acceptation humaine explicite requise.',note:'La sélection ne modifie ni la propriété du Lead ni les droits d’accès. La capacité concerne les nouvelles attributions.',history:'Décision de destinataire au moment de la demande' },
};
const reasons:Record<string,[string,string,string]>={
  CURRENT_OWNER_READY:['المالك الحالي متاح','Current owner available','Propriétaire actuel disponible'],CONFIGURED_TARGET_READY:['المستلم المهيّأ متاح','Configured recipient available','Destinataire configuré disponible'],
  UNASSIGNED_MANAGER_ATTENTION:['Lead غير معيّنة: مراجعة Manager','Unassigned Lead: Manager attention','Lead non attribué : examen Manager'],TARGET_UNAVAILABLE:['المستلم غير متاح أو غير نشط','Recipient unavailable or inactive','Destinataire indisponible ou inactif'],
  AGENT_NOT_CAMPAIGN_ELIGIBLE:['الوكيل غير مؤهل للحملة','Agent is not eligible for this campaign','Agent non éligible pour cette campagne'],TARGET_REQUIRES_AUTHORIZED_ASSIGNMENT:['المستلم يحتاج إسنادًا مصرحًا للـLead','Recipient requires authorized Lead assignment','Attribution autorisée du Lead requise'],
  OUTSIDE_WORKING_HOURS:['خارج ساعات العمل','Outside working hours','En dehors des horaires'],BRANCH_DISABLED:['الفرع معطّل','Branch disabled','Agence désactivée'],LEAD_NOT_OPEN:['Lead ليست مفتوحة','Lead is not open','Lead non ouvert'],
};
export function HandoffReception({value,locale,historical=false}:{value:Reception;locale:'ar'|'en'|'fr';historical?:boolean}) {
  const t=labels[locale],reason=reasons[value.reason]?.[locale==='ar'?0:locale==='en'?1:2]??value.reason;
  return <div data-handoff-reception={historical?'historical':'current'}><h5>{historical?t.history:t.title}</h5><p>{reason}</p>
    <p style={{overflowWrap:'anywhere'}}>{t.owner}: {value.ownerName??'—'}</p><p style={{overflowWrap:'anywhere'}}>{t.target}: {value.targetName??'—'} {value.targetRole??''}</p>
    <p dir="ltr" style={{overflowWrap:'anywhere'}}>{value.timezone}</p>{!historical&&<><p>{value.managerAttentionRequired?t.manager:t.ready}</p><p>{t.note}</p></>}
  </div>;
}
