import type postgres from 'postgres';
import type {Principal} from './security.js';
import {leadPredicate,type LeadFilter,type PreparedLeadFilter} from './lead-query.js';

export const analyticsMetrics=['ALL','OPEN','CLOSED','ARCHIVED','ATTENTION','UNASSIGNED','NO_FOLLOW_UP','OVERDUE_FOLLOW_UP','PLATFORM_CONTACTED','AI_CONTACTED','HUMAN_CONTACTED','CUSTOMER_RESPONDED','PAID','ENROLLED','CONVERTED','AI_ANSWERED','HUMAN_ANSWERED'] as const;
export type AnalyticsMetric=typeof analyticsMetrics[number];
export function analyticsMetricPredicate(tx:postgres.TransactionSql,metric:AnalyticsMetric){
 const sql:Record<AnalyticsMetric,string>={ALL:'true',OPEN:"f.lifecycle='OPEN'",CLOSED:"f.lifecycle='CLOSED'",ARCHIVED:"f.lifecycle='ARCHIVED'",ATTENTION:'f.attention',UNASSIGNED:'f.assigned_agent_id IS NULL',
  NO_FOLLOW_UP:'f.open_tasks=0',OVERDUE_FOLLOW_UP:'f.overdue_tasks>0',PLATFORM_CONTACTED:'f.first_platform IS NOT NULL',AI_CONTACTED:'f.first_ai IS NOT NULL',HUMAN_CONTACTED:'f.first_human IS NOT NULL',
  CUSTOMER_RESPONDED:'f.first_customer_response IS NOT NULL',PAID:'f.paid',ENROLLED:'f.enrolled',CONVERTED:'f.converted',AI_ANSWERED:'f.ai_answered',HUMAN_ANSWERED:'f.human_answered'};
 return tx.unsafe(sql[metric]);
}

// All aggregates and drilldowns start with the same authorized Lead cohort. No message bodies,
// credentials, arbitrary formulas or LLM-generated facts are read here.
export function analyticsCtes(tx:postgres.TransactionSql,actor:Principal,q:LeadFilter,field:PreparedLeadFilter){
 const humanActor=actor.role==='AGENT'?actor.id:q.assignedAgentId??null,mode=q.paymentMode??'LIVE';
 return tx`WITH selected AS MATERIALIZED (
  SELECT l.id,l.organization_id,l.branch_id,l.campaign_id,l.contact_id,l.assigned_agent_id,l.lifecycle,l.source_kind,l.created_at,l.needs_attention_reason,
   ca.name AS campaign_name,ca.version AS campaign_version,ca.conversion_config->>'type' AS configured_conversion,b.name AS branch_name
  FROM lead l LEFT JOIN contact c ON c.id=l.contact_id JOIN campaign ca ON ca.id=l.campaign_id JOIN branch b ON b.id=l.branch_id
  WHERE ${leadPredicate(tx,actor,q,field)}
 ), cvs AS MATERIALIZED (SELECT cv.id,cv.lead_id,cv.state,cv.controller_type,cv.needs_attention_reason FROM conversation cv JOIN selected s ON s.id=cv.lead_id),
 messages AS MATERIALIZED (SELECT cv.lead_id,m.id,m.direction,m.author_type,m.author_user_id,m.sent_at,m.received_at,m.delivery_state FROM cvs cv JOIN conversation_message m ON m.conversation_id=cv.id),
 first_contact AS (
  SELECT lead_id,min(sent_at) FILTER(WHERE direction='OUTBOUND') AS first_platform,min(sent_at) FILTER(WHERE direction='OUTBOUND' AND author_type='AI') AS first_ai,
   min(sent_at) FILTER(WHERE direction='OUTBOUND' AND author_type='HUMAN') AS first_human,min(received_at) FILTER(WHERE direction='INBOUND') AS first_inbound
  FROM messages GROUP BY lead_id
 ), communication AS (
  SELECT a.lead_id,a.first_platform,a.first_ai,a.first_human,a.first_inbound,
   min(m.received_at) FILTER(WHERE m.direction='INBOUND' AND m.received_at>=a.first_platform) AS first_customer_response,
   count(m.id) FILTER(WHERE m.direction='OUTBOUND' AND m.author_type='AI' AND m.sent_at IS NOT NULL) AS ai_attempts,
   count(m.id) FILTER(WHERE m.direction='OUTBOUND' AND m.author_type='HUMAN' AND m.sent_at IS NOT NULL AND (${humanActor}::uuid IS NULL OR m.author_user_id=${humanActor})) AS human_attempts,
   extract(epoch FROM min(m.sent_at) FILTER(WHERE m.direction='OUTBOUND' AND m.author_type='AI' AND m.sent_at>=a.first_inbound)-a.first_inbound) AS ai_response_seconds,
   extract(epoch FROM min(m.sent_at) FILTER(WHERE m.direction='OUTBOUND' AND m.author_type='HUMAN' AND m.sent_at>=a.first_inbound
    AND (${humanActor}::uuid IS NULL OR m.author_user_id=${humanActor}))-a.first_inbound) AS human_response_seconds
  FROM first_contact a JOIN messages m ON m.lead_id=a.lead_id GROUP BY a.lead_id,a.first_platform,a.first_ai,a.first_human,a.first_inbound
 ), tasks AS (
  SELECT f.lead_id,count(*) FILTER(WHERE status='OPEN') AS open_tasks,count(*) FILTER(WHERE status='OPEN' AND due_at<statement_timestamp()) AS overdue_tasks,
   count(*) FILTER(WHERE status='OPEN' AND due_at>=statement_timestamp()) AS upcoming_tasks,count(*) FILTER(WHERE status='COMPLETED') AS completed_tasks,
   count(*) FILTER(WHERE status='CANCELLED') AS cancelled_tasks,count(*) FILTER(WHERE kind='HUMAN') AS human_tasks,count(*) FILTER(WHERE kind='AUTOMATION') AS automation_tasks
  FROM follow_up f JOIN selected s ON s.id=f.lead_id GROUP BY f.lead_id
 ), payments AS MATERIALIZED (
  SELECT pf.* FROM analytics_payment_fact pf JOIN selected s ON s.id=pf.lead_id AND s.organization_id=pf.organization_id WHERE (${mode}='ALL' OR pf.mode=${mode})
 ), payment_leads AS (SELECT lead_id,bool_or(state='CONFIRMED') AS paid FROM payments GROUP BY lead_id),
 enrollments AS MATERIALIZED (SELECT e.id,e.lead_id,e.enrolled_at FROM enrollment e JOIN payments p ON p.id=e.payment_id AND p.lead_id=e.lead_id AND p.state='CONFIRMED'),
 conversion_fields AS MATERIALIZED (
  SELECT c.id AS campaign_id,f.id AS field_id,c.conversion_config->'value' AS expected
  FROM (SELECT DISTINCT campaign_id FROM selected WHERE configured_conversion='FIELD_VALUE') scope
   JOIN campaign c ON c.id=scope.campaign_id
   CROSS JOIN LATERAL campaign_conversion_field(c,c.conversion_config,${actor.role}) f
 ),
 qualification AS (
  SELECT a.lead_id,bool_or(a.source='AI') AS ai_answered,bool_or(a.source='HUMAN') AS human_answered FROM lead_qualification_answer a JOIN selected s ON s.id=a.lead_id AND s.campaign_id=a.campaign_id
   LEFT JOIN campaign_field cf ON cf.campaign_id=s.campaign_id AND cf.field_id=a.field_id LEFT JOIN field_definition fd ON fd.id=a.field_id
  WHERE a.field_id IS NULL OR cf.active AND fd.active AND fd.organization_id=s.organization_id AND (fd.branch_id IS NULL OR fd.branch_id=s.branch_id)
   AND (fd.campaign_id IS NULL OR fd.campaign_id=s.campaign_id) AND (${actor.role==='SUPER_ADMIN'} OR ${actor.role==='MANAGER'} AND cf.visible_to_manager
    OR ${actor.role==='AGENT'} AND cf.visible_to_agent) GROUP BY a.lead_id
 ), facts AS MATERIALIZED (
  SELECT s.*,c.first_platform,c.first_ai,c.first_human,c.first_inbound,c.first_customer_response,coalesce(c.ai_attempts,0) AS ai_attempts,coalesce(c.human_attempts,0) AS human_attempts,
   c.ai_response_seconds,c.human_response_seconds,coalesce(t.open_tasks,0) AS open_tasks,coalesce(t.overdue_tasks,0) AS overdue_tasks,
   coalesce(t.upcoming_tasks,0) AS upcoming_tasks,coalesce(t.completed_tasks,0) AS completed_tasks,coalesce(t.cancelled_tasks,0) AS cancelled_tasks,
   coalesce(t.human_tasks,0) AS human_tasks,coalesce(t.automation_tasks,0) AS automation_tasks,
   coalesce(p.paid,false) AS paid,EXISTS(SELECT 1 FROM enrollments e WHERE e.lead_id=s.id) AS enrolled,
   coalesce(q.ai_answered,false) AS ai_answered,coalesce(q.human_answered,false) AS human_answered,
   s.needs_attention_reason IS NOT NULL OR automation_review_pending(s.id,s.branch_id,s.campaign_id)
    OR EXISTS(SELECT 1 FROM cvs cv WHERE cv.lead_id=s.id AND cv.needs_attention_reason IS NOT NULL) AS attention,
   CASE WHEN d.field_id IS NOT NULL OR s.configured_conversion IN ('PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED')
    THEN s.configured_conversion END AS conversion_type,
   coalesce(CASE s.configured_conversion WHEN 'PAYMENT_CONFIRMED' THEN p.paid
    WHEN 'ENROLLMENT_CONFIRMED' THEN EXISTS(SELECT 1 FROM enrollments e WHERE e.lead_id=s.id)
    WHEN 'FIELD_VALUE' THEN fv.value=d.expected ELSE false END,false) AS converted,
   d.field_id IS NOT NULL OR coalesce(s.configured_conversion IN ('PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED'),false) AS conversion_defined
  FROM selected s LEFT JOIN communication c ON c.lead_id=s.id LEFT JOIN tasks t ON t.lead_id=s.id
   LEFT JOIN payment_leads p ON p.lead_id=s.id LEFT JOIN qualification q ON q.lead_id=s.id
   LEFT JOIN conversion_fields d ON d.campaign_id=s.campaign_id
   LEFT JOIN lead_field_value fv ON fv.lead_id=s.id AND fv.field_id=d.field_id
 )`;
}
