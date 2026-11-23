import type {FastifyInstance,FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest,type Principal} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {operationalFilterProperties,prepareLeadFilter,type LeadFilter} from '../lead-query.js';
import {analyticsCtes,analyticsMetrics,analyticsMetricPredicate,type AnalyticsMetric} from '../analytics.js';
import {decodeCursor,encodeCursor} from '../pagination.js';
const querySchema={type:'object',additionalProperties:false,properties:operationalFilterProperties} as const;
async function access(tx:postgres.TransactionSql,actor:Principal,q:LeadFilter,request:FastifyRequest){
 await tx`SET LOCAL statement_timeout='8s'`;await tx`SET LOCAL lock_timeout='750ms'`;
 if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'ANALYTICS_ACCESS_REVOKED');
 const normalized={...q,paymentMode:q.paymentMode??'LIVE' as const},field=await prepareLeadFilter(tx,actor,normalized);return {q:normalized,field};
}
async function audited(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest,kind:string){
 if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'ANALYTICS_ACCESS_REVOKED');
 await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(${actor.organizationId},${actor.branchId},${actor.id},'ANALYTICS_READ','USER',${actor.id},${tx.json({kind})})`;
}
export function registerAnalyticsRoutes(app:FastifyInstance,db:Database){
 app.get<{Querystring:LeadFilter}>('/api/analytics/overview',{schema:{querystring:querySchema}},async request=>{
  const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
   const {q,field}=await access(tx,actor,request.query,request);
   const row=(await tx`${analyticsCtes(tx,actor,q,field,true)} SELECT statement_timestamp() AS as_of,
    jsonb_build_object('total',count(*)::text,'open',(count(*) FILTER(WHERE lifecycle='OPEN'))::text,'closed',(count(*) FILTER(WHERE lifecycle='CLOSED'))::text,
     'archived',(count(*) FILTER(WHERE lifecycle='ARCHIVED'))::text,'unassigned',(count(*) FILTER(WHERE assigned_agent_id IS NULL))::text,
     'attention',(count(*) FILTER(WHERE attention))::text,'noFollowUp',(count(*) FILTER(WHERE open_tasks=0))::text,'overdueFollowUp',(count(*) FILTER(WHERE overdue_tasks>0))::text,
     'paid',(count(*) FILTER(WHERE paid))::text,'enrolled',(count(*) FILTER(WHERE enrolled))::text,'aiAnswered',(count(*) FILTER(WHERE ai_answered))::text,'humanAnswered',(count(*) FILTER(WHERE human_answered))::text,
     'qualificationComplete',(count(*) FILTER(WHERE qualification_complete IS TRUE))::text,
     'qualificationIncomplete',(count(*) FILTER(WHERE qualification_complete IS FALSE))::text) AS leads,
    jsonb_build_object('platformContacted',(count(*) FILTER(WHERE first_platform IS NOT NULL))::text,'aiContacted',(count(*) FILTER(WHERE first_ai IS NOT NULL))::text,
     'humanContacted',(count(*) FILTER(WHERE first_human IS NOT NULL))::text,'customerResponded',(count(*) FILTER(WHERE first_customer_response IS NOT NULL))::text,
     'aiAttempts',coalesce(sum(ai_attempts),0)::text,'humanAttempts',coalesce(sum(human_attempts),0)::text,
     'aiResponseSamples',count(ai_response_seconds)::text,'humanResponseSamples',count(human_response_seconds)::text,
     'aiResponseSeconds',round(avg(ai_response_seconds),3)::text,'humanResponseSeconds',round(avg(human_response_seconds),3)::text) AS communication,
    jsonb_build_object('open',coalesce(sum(open_tasks),0)::text,'overdue',coalesce(sum(overdue_tasks),0)::text,'upcoming',coalesce(sum(upcoming_tasks),0)::text,
     'completed',coalesce(sum(completed_tasks),0)::text,'cancelled',coalesce(sum(cancelled_tasks),0)::text,'human',coalesce(sum(human_tasks),0)::text,'automation',coalesce(sum(automation_tasks),0)::text) AS follow_ups,
    jsonb_build_object('configuredLeads',(count(*) FILTER(WHERE conversion_defined))::text,'converted',(count(*) FILTER(WHERE converted))::text,
     'unconfiguredLeads',(count(*) FILTER(WHERE NOT conversion_defined))::text,'rate',round(100.0*count(*) FILTER(WHERE converted)/nullif(count(*) FILTER(WHERE conversion_defined),0),2)::text) AS conversion,
    coalesce((SELECT jsonb_agg(jsonb_build_object('currency',currency,'mode',mode,'amount',amount,'payments',n) ORDER BY currency,mode)
     FROM(SELECT currency,mode,sum(amount)::text AS amount,count(*)::text AS n FROM payments WHERE state='CONFIRMED' GROUP BY currency,mode) r),'[]'::jsonb) AS revenue,
    coalesce((SELECT jsonb_agg(jsonb_build_object('state',state,'count',n) ORDER BY state) FROM(SELECT state,count(*)::text AS n FROM payments GROUP BY state) p),'[]'::jsonb) AS payments,
    (SELECT count(*)::text FROM enrollments) AS enrollment_records,
    coalesce((SELECT jsonb_agg(jsonb_build_object('state',state,'controller',controller_type,'count',n) ORDER BY state,controller_type)
     FROM(SELECT state,controller_type,count(*)::text AS n FROM cvs GROUP BY state,controller_type) c),'[]'::jsonb) AS conversations FROM facts`)[0]!;
   await audited(tx,actor,request,'OVERVIEW');return {...row,basis:'CURRENT_LEAD_CREATED_COHORT',paymentMode:q.paymentMode,
    humanAuthorId:actor.role==='AGENT'?actor.id:q.assignedAgentId??null,from:q.from??null,to:q.to??null};
  });
 });
 app.get<{Querystring:LeadFilter&{metric?:AnalyticsMetric;limit?:number;cursor?:string}}>('/api/analytics/leads',{schema:{querystring:{...querySchema,properties:{...operationalFilterProperties,
  metric:{enum:analyticsMetrics},limit:{type:'integer',minimum:1,maximum:50},cursor:{type:'string',maxLength:256}}}}},async request=>{
  const actor=await principalFromRequest(request,db),metric=request.query.metric??'ALL',cursor=decodeCursor(request.query.cursor),limit=request.query.limit??20;
  return db.begin(async tx=>{
   const {q,field}=await access(tx,actor,request.query,request);
   const includeQualification=metric==='QUALIFICATION_COMPLETE'||metric==='QUALIFICATION_INCOMPLETE';
   const rows=await tx`${analyticsCtes(tx,actor,q,field,includeQualification)}
    SELECT f.id,f.campaign_id,f.campaign_name,f.branch_name,f.lifecycle,f.created_at,f.created_at::text AS cursor_at,c.name AS contact_name,
     f.first_platform,f.first_ai,f.first_human,f.first_inbound,f.first_customer_response,f.ai_attempts::text,f.human_attempts::text,f.ai_response_seconds::text,f.human_response_seconds::text
    FROM facts f LEFT JOIN contact c ON c.id=f.contact_id WHERE ${analyticsMetricPredicate(tx,metric)} AND
     (${cursor?.timestamp??null}::text::timestamptz IS NULL OR (f.created_at,f.id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
    ORDER BY f.created_at DESC,f.id DESC LIMIT ${limit+1}`;
   await audited(tx,actor,request,'LEADS');const items=rows.slice(0,limit),last=items.at(-1);
   return {items,metric,nextCursor:rows.length>limit&&last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};
  });
 });
 app.get<{Querystring:LeadFilter&{by?:'BRANCH'|'CAMPAIGN'|'SOURCE';after?:string;limit?:number}}>('/api/analytics/groups',{schema:{querystring:{...querySchema,properties:{...operationalFilterProperties,
  by:{enum:['BRANCH','CAMPAIGN','SOURCE']},after:{type:'string',maxLength:100},limit:{type:'integer',minimum:1,maximum:50}}}}},async request=>{
  const actor=await principalFromRequest(request,db),by=request.query.by??'CAMPAIGN',limit=request.query.limit??20;
  return db.begin(async tx=>{
   const {q,field}=await access(tx,actor,request.query,request),id=tx.unsafe(by==='BRANCH'?'f.branch_id::text':by==='CAMPAIGN'?'f.campaign_id::text':'f.source_kind'),
    name=tx.unsafe(by==='BRANCH'?'f.branch_name':by==='CAMPAIGN'?'f.campaign_name':'f.source_kind');
   const rows=await tx`${analyticsCtes(tx,actor,q,field,by==='SOURCE')} SELECT ${id} AS id,max(${name}) AS name,count(*)::text AS leads,
    (count(*) FILTER(WHERE converted))::text AS converted,(count(*) FILTER(WHERE conversion_defined))::text AS configured_leads,
    round(100.0*count(*) FILTER(WHERE converted)/nullif(count(*) FILTER(WHERE conversion_defined),0),2)::text AS rate,
    CASE WHEN count(qualification_complete)>0 THEN (count(*) FILTER(WHERE qualification_complete IS TRUE))::text END AS qualification_complete,
    CASE WHEN count(qualification_complete)>0 THEN (count(*) FILTER(WHERE qualification_complete IS FALSE))::text END AS qualification_incomplete,
    ${by==='CAMPAIGN'?tx.unsafe('max(f.conversion_type)'):tx.unsafe('NULL::text')} AS definition,
    ${by==='CAMPAIGN'?tx.unsafe('max(f.campaign_version)'):tx.unsafe('NULL::integer')} AS definition_version
    FROM facts f WHERE (${request.query.after??null}::text IS NULL OR ${id}>${request.query.after??null}) GROUP BY ${id}
    ORDER BY ${id} LIMIT ${limit+1}`;
   await audited(tx,actor,request,'GROUPS');return {items:rows.slice(0,limit),by,nextAfter:rows.length>limit?rows[limit-1]!.id:null};
  });
 });
 app.get<{Querystring:LeadFilter&{after?:string;limit?:number}}>('/api/analytics/agents',{schema:{querystring:{...querySchema,properties:{...operationalFilterProperties,
  after:{type:'string',format:'uuid'},limit:{type:'integer',minimum:1,maximum:50}}}}},async request=>{
  const actor=await principalFromRequest(request,db),limit=request.query.limit??20,humanActor=actor.role==='AGENT'?actor.id:request.query.assignedAgentId??null;
  return db.begin(async tx=>{
   const {q,field}=await access(tx,actor,request.query,request);const rows=await tx`${analyticsCtes(tx,actor,q,field)}, authors AS (
    SELECT m.author_user_id,m.lead_id,count(*) AS attempts,min(m.sent_at) FILTER(WHERE m.sent_at>=f.first_inbound) AS first_response,f.first_inbound
    FROM messages m JOIN facts f ON f.id=m.lead_id WHERE m.direction='OUTBOUND' AND m.author_type='HUMAN' AND m.sent_at IS NOT NULL AND m.author_user_id IS NOT NULL
     AND (${humanActor}::uuid IS NULL OR m.author_user_id=${humanActor}) GROUP BY m.author_user_id,m.lead_id,f.first_inbound)
    SELECT a.author_user_id AS id,u.name,count(*)::text AS contacted_leads,sum(a.attempts)::text AS human_attempts,
     count(a.first_response)::text AS response_samples,round(avg(extract(epoch FROM a.first_response-a.first_inbound)),3)::text AS response_seconds
    FROM authors a JOIN user_account u ON u.id=a.author_user_id AND u.organization_id=${actor.organizationId}
    WHERE (${request.query.after??null}::uuid IS NULL OR a.author_user_id>${request.query.after??null}::uuid)
    GROUP BY a.author_user_id,u.name ORDER BY a.author_user_id LIMIT ${limit+1}`;
   await audited(tx,actor,request,'HUMAN_AUTHORS');return {items:rows.slice(0,limit),nextAfter:rows.length>limit?rows[limit-1]!.id:null};
  });
 });
}
