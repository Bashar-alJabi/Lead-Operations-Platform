import type postgres from 'postgres';
import {HttpError,requireBranch,type Principal} from './security.js';
import {calculatedFilterType,validateFieldValue,type CalculationKind,type FieldType,type FieldOption,type FieldValidation} from './fields.js';

export type LeadFilter={q?:string;branchId?:string;campaignId?:string;contactId?:string;assignedAgentId?:string;lifecycle?:string;sourceKind?:string;
 from?:string;to?:string;followup?:'NONE'|'OVERDUE'|'UPCOMING';fieldId?:string;fieldValue?:string;
 conversationState?:string;controller?:'AI'|'HUMAN'|'NONE';payment?:'CONFIRMED'|'NONE';enrollment?:'ENROLLED'|'NONE';attention?:'YES'|'NO';paymentMode?:'LIVE'|'TEST'|'ALL'};
export const operationalFilterProperties={
 branchId:{type:'string',format:'uuid'},campaignId:{type:'string',format:'uuid'},contactId:{type:'string',format:'uuid'},assignedAgentId:{type:'string',format:'uuid'},
 lifecycle:{enum:['OPEN','CLOSED','ARCHIVED']},q:{type:'string',maxLength:200},sourceKind:{type:'string',maxLength:40},
 from:{type:'string',format:'date-time'},to:{type:'string',format:'date-time'},followup:{enum:['NONE','OVERDUE','UPCOMING']},
 fieldId:{type:'string',format:'uuid'},fieldValue:{type:'string',maxLength:2000},conversationState:{enum:['AI_ACTIVE','AI_WAITING_FOR_LEAD','AI_HANDOFF_REQUIRED','WAITING_FOR_HUMAN','HUMAN_ACTIVE','CLOSED']},
 controller:{enum:['AI','HUMAN','NONE']},payment:{enum:['CONFIRMED','NONE']},enrollment:{enum:['ENROLLED','NONE']},attention:{enum:['YES','NO']},paymentMode:{enum:['LIVE','TEST','ALL']},
} as const;

export type PreparedLeadFilter={value:postgres.JSONValue|null;emptyScope:boolean;calculationKind?:CalculationKind};
export function leadFilterFieldAccess(tx:postgres.TransactionSql,actor:Principal){
 return tx`ca.organization_id=${actor.organizationId} AND fd.organization_id=ca.organization_id
   AND (fd.branch_id IS NULL OR fd.branch_id=ca.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=ca.id)
   AND (${actor.role==='SUPER_ADMIN'} OR ca.branch_id=${actor.branchId}) AND cf.active AND fd.active AND cf.filterable
   AND (${actor.role!=='AGENT'} OR EXISTS(SELECT 1 FROM lead visible WHERE visible.campaign_id=ca.id AND visible.organization_id=${actor.organizationId}
    AND visible.branch_id=${actor.branchId} AND visible.assigned_agent_id=${actor.id}))
   AND (${actor.role==='SUPER_ADMIN'} OR ${actor.role==='MANAGER'} AND cf.visible_to_manager OR ${actor.role==='AGENT'} AND cf.visible_to_agent)`;
}
export async function prepareLeadFilter(tx:postgres.TransactionSql,actor:Principal,q:LeadFilter):Promise<PreparedLeadFilter>{
 if(q.branchId)requireBranch(actor,q.branchId);
 if(q.from&&q.to&&Date.parse(q.from)>Date.parse(q.to))throw new HttpError(400,'INVALID_DATE_RANGE');
 if(Boolean(q.fieldId)!==Boolean(q.fieldValue))throw new HttpError(400,'FIELD_FILTER_INCOMPLETE');
 // A collection remains empty after ownership is lost. Do not inspect inaccessible Field
 // metadata, normalize a value against it, or reveal whether that Field even exists.
 if(actor.role==='AGENT'&&q.campaignId&&!(await tx`SELECT 1 FROM lead WHERE organization_id=${actor.organizationId}
  AND branch_id=${actor.branchId} AND campaign_id=${q.campaignId} AND assigned_agent_id=${actor.id} LIMIT 1`).length)return {value:null,emptyScope:true};
 if(!q.fieldId)return {value:null,emptyScope:false};
 if(!q.campaignId)throw new HttpError(400,'FIELD_FILTER_REQUIRES_CAMPAIGN');
 const f=(await tx`SELECT fd.field_type,fd.value_mode,fd.options,fd.validation,fd.calculation FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
  JOIN campaign ca ON ca.id=cf.campaign_id WHERE cf.campaign_id=${q.campaignId} AND cf.field_id=${q.fieldId} AND ${leadFilterFieldAccess(tx,actor)}`)[0];
 if(!f)throw new HttpError(404,'FIELD_NOT_FOUND');
 let parsed:unknown;try{parsed=JSON.parse(q.fieldValue!);}catch{throw new HttpError(400,'FIELD_FILTER_INVALID');}
 if(f.value_mode==='CALCULATED'){
  const calculationKind=f.calculation.kind as CalculationKind;
  const type=calculatedFilterType(calculationKind);
  const value=validateFieldValue(type,parsed,[],{min:0}) as number|string|null;
  if(value===null || (typeof value==='number'&&!Number.isSafeInteger(value)))throw new HttpError(400,'FIELD_FILTER_INVALID');
  return {value,calculationKind,emptyScope:false};
 }
 const value=validateFieldValue(f.field_type as FieldType,parsed,f.options as FieldOption[],f.validation as FieldValidation) as postgres.JSONValue;
 if(value===null)throw new HttpError(400,'FIELD_FILTER_INVALID');return {value,emptyScope:false};
}

function fieldPredicate(tx:postgres.TransactionSql,actor:Principal,q:LeadFilter,field:PreparedLeadFilter,asOf?:string){
 if(!q.fieldId)return tx`true`;
 if(field.value===null)return tx`false`;
 const value=tx.json(field.value);
 const calculation=field.calculationKind;
 const definition=tx`FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
   WHERE cf.campaign_id=l.campaign_id AND cf.field_id=${q.fieldId} AND cf.active AND cf.filterable AND fd.active
    AND fd.organization_id=l.organization_id AND (fd.branch_id IS NULL OR fd.branch_id=l.branch_id) AND (fd.campaign_id IS NULL OR fd.campaign_id=l.campaign_id)
    AND (${actor.role==='SUPER_ADMIN'} OR ${actor.role==='MANAGER'} AND cf.visible_to_manager OR ${actor.role==='AGENT'} AND cf.visible_to_agent)`;
 if(calculation)return tx`EXISTS(SELECT 1 ${definition}
   AND l.organization_id=${actor.organizationId} AND l.campaign_id=${q.campaignId!}
   AND (${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId}
    AND (${actor.role==='MANAGER'} OR l.assigned_agent_id=${actor.id}))
   AND fd.value_mode='CALCULATED' AND fd.calculation->>'kind'=${calculation}
   AND (lead_calculated_field_values(l.id,l.created_at,ARRAY[${calculation}::text],
     coalesce(${asOf??null}::text::timestamptz,statement_timestamp())) -> ${calculation}::text)=${value}::jsonb)`;
 return tx`EXISTS(SELECT 1 ${definition} AND fd.value_mode<>'CALCULATED'
   AND EXISTS(SELECT 1 FROM lead_field_value fv WHERE fv.lead_id=l.id AND fv.field_id=fd.id
    AND md5(fv.value::text)=md5((${value}::jsonb)::text) AND fv.value=${value}::jsonb))`;
}

// Aliases l/c refer to Lead/Contact. Both the ordinary list and Analytics use exactly this predicate.
export function leadPredicate(tx:postgres.TransactionSql,actor:Principal,q:LeadFilter,field:PreparedLeadFilter,asOf?:string){
 if(field.emptyScope)return tx`false`;
 const search=q.q?.trim().normalize('NFKC').toLowerCase()??'',phone=search.replace(/[\s().-]/g,''),id=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search)?search:null;
 return tx`l.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId}
  AND (${actor.role==='MANAGER'} OR ${actor.role==='AGENT'} AND l.assigned_agent_id=${actor.id}))
  AND EXISTS(SELECT 1 FROM campaign ca WHERE ca.id=l.campaign_id AND ca.organization_id=l.organization_id AND ca.branch_id=l.branch_id)
  AND (${q.branchId??null}::uuid IS NULL OR l.branch_id=${q.branchId??null}) AND (${q.campaignId??null}::uuid IS NULL OR l.campaign_id=${q.campaignId??null})
  AND (${q.contactId??null}::uuid IS NULL OR l.contact_id=${q.contactId??null}) AND (${q.assignedAgentId??null}::uuid IS NULL OR l.assigned_agent_id=${q.assignedAgentId??null})
  AND (${q.lifecycle??null}::text IS NULL OR l.lifecycle=${q.lifecycle??null}) AND (${q.sourceKind??null}::text IS NULL OR l.source_kind=${q.sourceKind??null})
  AND (${search}='' OR starts_with(lower(c.name),${search}) OR starts_with(c.email_normalized,${search})
    OR (${phone!==''} AND starts_with(c.phone_normalized,${phone})) OR l.id=${id}::uuid
    OR EXISTS(SELECT 1 FROM campaign matching_campaign
      WHERE (matching_campaign.id,matching_campaign.organization_id,matching_campaign.branch_id)=(l.campaign_id,l.organization_id,l.branch_id)
       AND starts_with(lower(normalize(matching_campaign.name,NFKC)),${search}))
    OR EXISTS(SELECT 1 FROM branch matching_branch WHERE matching_branch.id=l.branch_id AND matching_branch.organization_id=l.organization_id
       AND starts_with(lower(normalize(matching_branch.name,NFKC)),${search}))
    OR EXISTS(SELECT 1 FROM user_account matching_owner
      WHERE (matching_owner.id,matching_owner.organization_id,matching_owner.branch_id)=(l.assigned_agent_id,l.organization_id,l.branch_id)
       AND starts_with(lower(normalize(matching_owner.name,NFKC)),${search})))
  AND (${q.from??null}::text::timestamptz IS NULL OR l.created_at>=${q.from??null}::text::timestamptz) AND (${q.to??null}::text::timestamptz IS NULL OR l.created_at<=${q.to??null}::text::timestamptz)
  AND (${q.followup??null}::text IS NULL OR ${q.followup==='NONE'} AND NOT EXISTS(SELECT 1 FROM follow_up f WHERE f.lead_id=l.id AND f.status='OPEN')
   OR ${q.followup==='OVERDUE'} AND EXISTS(SELECT 1 FROM follow_up f WHERE f.lead_id=l.id AND f.status='OPEN' AND f.due_at<statement_timestamp())
   OR ${q.followup==='UPCOMING'} AND EXISTS(SELECT 1 FROM follow_up f WHERE f.lead_id=l.id AND f.status='OPEN' AND f.due_at>=statement_timestamp()))
  AND ${fieldPredicate(tx,actor,q,field,asOf)}
  AND (${!q.conversationState&&!q.controller} OR EXISTS(SELECT 1 FROM conversation cv WHERE cv.lead_id=l.id
   AND (${q.conversationState??null}::text IS NULL OR cv.state=${q.conversationState??null}) AND (${q.controller??null}::text IS NULL OR cv.controller_type=${q.controller??null})))
  AND (${!q.payment} OR (${q.payment==='CONFIRMED'})=EXISTS(SELECT 1 FROM analytics_payment_fact pf WHERE pf.lead_id=l.id AND pf.organization_id=l.organization_id AND pf.state='CONFIRMED' AND (${q.paymentMode??'ALL'}='ALL' OR pf.mode=${q.paymentMode??'ALL'})))
  AND (${!q.enrollment} OR (${q.enrollment==='ENROLLED'})=EXISTS(SELECT 1 FROM enrollment e JOIN analytics_payment_fact pf ON pf.id=e.payment_id
   WHERE e.lead_id=l.id AND pf.lead_id=l.id AND pf.organization_id=l.organization_id AND pf.state='CONFIRMED' AND (${q.paymentMode??'ALL'}='ALL' OR pf.mode=${q.paymentMode??'ALL'})))
  AND (${!q.attention} OR (${q.attention==='YES'})=(l.needs_attention_reason IS NOT NULL
   OR automation_review_pending(l.id,l.branch_id,l.campaign_id)
   OR EXISTS(SELECT 1 FROM conversation cv WHERE cv.lead_id=l.id AND cv.needs_attention_reason IS NOT NULL)))`;
}
