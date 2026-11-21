import type {FastifyInstance,FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest,requireRole,type Principal} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {decodeCursor,encodeCursor} from '../pagination.js';

const triggers=['LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED','FOLLOW_UP_DUE','MESSAGE_RECEIVED','CONVERSATION_STATE_CHANGED'] as const;
type Definition={name:string;enabled:boolean;triggerType:typeof triggers[number];
 lifecycle:'OPEN'|'CLOSED'|'ARCHIVED'|null;ownerCondition:'ANY'|'ASSIGNED'|'UNASSIGNED';
 actionType:'CREATE_FOLLOW_UP'|'SEND_IN_APP_NOTIFICATION';delayMinutes:number;priority:'LOW'|'NORMAL'|'HIGH';note:string;reason:string};
const properties={name:{type:'string',minLength:1,maxLength:100},enabled:{type:'boolean'},triggerType:{enum:triggers},
 lifecycle:{enum:['OPEN','CLOSED','ARCHIVED',null]},ownerCondition:{enum:['ANY','ASSIGNED','UNASSIGNED']},actionType:{enum:['CREATE_FOLLOW_UP','SEND_IN_APP_NOTIFICATION']},
 delayMinutes:{type:'integer',minimum:0,maximum:525600},priority:{enum:['LOW','NORMAL','HIGH']},note:{type:'string',maxLength:4000},reason:{type:'string',minLength:3,maxLength:500}} as const;
const uuid={type:'string',format:'uuid'} as const,nullableUuid={anyOf:[uuid,{type:'null'}]} as const;
const params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const page={type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:50},cursor:{type:'string',maxLength:256}}} as const;
type Page={limit?:number;cursor?:string};
function validate(input:Definition){if(!input.name.trim()||input.reason.trim().length<3||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.name+input.note+input.reason)
 ||input.actionType==='SEND_IN_APP_NOTIFICATION'&&(input.delayMinutes!==0||input.priority!=='NORMAL'))throw new HttpError(400,'INVALID_AUTOMATION_DEFINITION');}
async function scope(tx:postgres.TransactionSql,actor:Principal,branchId:string|null,campaignId:string|null,request:FastifyRequest){
 if(actor.role==='MANAGER'&&branchId!==actor.branchId)throw new HttpError(404,'AUTOMATION_SCOPE_NOT_FOUND');
 if(campaignId&&!branchId)throw new HttpError(400,'AUTOMATION_CAMPAIGN_BRANCH_REQUIRED');
 if(branchId&&!(await tx`SELECT id FROM branch WHERE id=${branchId} AND organization_id=${actor.organizationId} FOR SHARE`).length)throw new HttpError(404,'AUTOMATION_SCOPE_NOT_FOUND');
 if(campaignId&&!(await tx`SELECT id FROM campaign WHERE id=${campaignId} AND branch_id=${branchId} AND organization_id=${actor.organizationId} FOR SHARE`).length)throw new HttpError(404,'AUTOMATION_SCOPE_NOT_FOUND');
 const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'AUTOMATION_ACCESS_REVOKED');return session;
}
async function ruleAccess(tx:postgres.TransactionSql,actor:Principal,id:string,request:FastifyRequest){
 const r=(await tx`SELECT id,branch_id,campaign_id FROM automation_rule WHERE id=${id} AND organization_id=${actor.organizationId}
  AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId})`)[0];if(!r)throw new HttpError(404,'AUTOMATION_NOT_FOUND');
 await scope(tx,actor,r.branch_id,r.campaign_id,request);return r;
}
async function processingAccess(tx:postgres.TransactionSql,actor:Principal,kind:'sources'|'executions',id:string,request:FastifyRequest){
 const s=kind==='sources'?(await tx`SELECT * FROM automation_source WHERE id=${id} AND organization_id=${actor.organizationId}
  AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId})`)[0]:
  (await tx`SELECT s.* FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE e.id=${id} AND s.organization_id=${actor.organizationId}
   AND (${actor.role==='SUPER_ADMIN'} OR s.branch_id=${actor.branchId})`)[0];
 if(!s)throw new HttpError(404,'AUTOMATION_PROCESSING_NOT_FOUND');
 await tx`SELECT id FROM branch WHERE id=${s.branch_id} FOR SHARE`;
 await tx`SELECT id FROM lead WHERE id=${s.lead_id} FOR SHARE`;
 await tx`SELECT id FROM campaign WHERE id=${s.campaign_id} FOR SHARE`;
 const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'AUTOMATION_ACCESS_REVOKED');
 if(!(await tx`SELECT automation_source_access(${s.id},${actor.id},${session}) AS ok`)[0]!.ok)throw new HttpError(404,'AUTOMATION_PROCESSING_NOT_FOUND');
 return {s,session};
}
function paged(rows:postgres.RowList<postgres.Row[]>,limit:number){const items=rows.slice(0,limit),last=items.at(-1);return {items,nextCursor:rows.length>limit&&last?encodeCursor({timestamp:last.cursor_at,id:last.id}):null};}
export function registerAutomationRoutes(app:FastifyInstance,db:Database){
 app.get<{Querystring:Page}>('/api/automations',{schema:{querystring:page}},async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const cursor=decodeCursor(request.query.cursor),limit=request.query.limit??20;
  return db.begin(async tx=>{if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'AUTOMATION_ACCESS_REVOKED');
   const rows=await tx`SELECT r.id,r.name,r.branch_id,r.campaign_id,b.name AS branch_name,c.name AS campaign_name,r.version,r.enabled,r.trigger_type,r.lifecycle,r.owner_condition,
    r.action_type,r.delay_minutes,r.priority,r.note,r.reason,r.created_at,r.created_at::text AS cursor_at,r.updated_at FROM automation_rule r
    LEFT JOIN branch b ON b.id=r.branch_id LEFT JOIN campaign c ON c.id=r.campaign_id WHERE r.organization_id=${actor.organizationId}
     AND (${actor.role==='SUPER_ADMIN'} OR r.branch_id=${actor.branchId}) AND (${cursor?.timestamp??null}::text::timestamptz IS NULL
      OR (r.created_at,r.id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT ${limit+1}`;
   return paged(rows,limit);
  });
 });
 app.post<{Body:Definition&{branchId:string|null;campaignId:string|null}}>('/api/automations',{schema:{body:{type:'object',additionalProperties:false,
  required:[...Object.keys(properties),'branchId','campaignId'],properties:{...properties,branchId:nullableUuid,campaignId:nullableUuid}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const input=request.body;validate(input);
  const id=await db.begin(async tx=>{const session=await scope(tx,actor,input.branchId,input.campaignId,request);
   return (await tx`INSERT INTO automation_rule(organization_id,branch_id,campaign_id,name,version,enabled,trigger_type,lifecycle,owner_condition,action_type,delay_minutes,priority,note,actor_id,session_id,reason)
    VALUES(${actor.organizationId},${input.branchId},${input.campaignId},${input.name},1,${input.enabled},${input.triggerType},${input.lifecycle},${input.ownerCondition},${input.actionType},
     ${input.delayMinutes},${input.priority},${input.note},${actor.id},${session},${input.reason}) RETURNING id`)[0]!.id;
  });reply.code(201);return {id,version:1};
 });
 app.put<{Params:{id:string};Body:Definition&{version:number}}>('/api/automations/:id',{schema:{params,body:{type:'object',additionalProperties:false,
  required:[...Object.keys(properties),'version'],properties:{...properties,version:{type:'integer',minimum:1}}}}},async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const input=request.body;validate(input);
  return db.begin(async tx=>{await ruleAccess(tx,actor,request.params.id,request);const session=await currentPaymentSession(tx,actor,request);
   const r=(await tx`SELECT version FROM automation_rule WHERE id=${request.params.id} FOR UPDATE`)[0]!;if(r.version!==input.version)throw new HttpError(409,'AUTOMATION_VERSION_CONFLICT');
   await tx`UPDATE automation_rule SET name=${input.name},enabled=${input.enabled},trigger_type=${input.triggerType},lifecycle=${input.lifecycle},owner_condition=${input.ownerCondition},action_type=${input.actionType},
    delay_minutes=${input.delayMinutes},priority=${input.priority},note=${input.note},actor_id=${actor.id},session_id=${session},reason=${input.reason},version=version+1 WHERE id=${request.params.id}`;
   return {version:input.version+1};
  });
 });
 app.get<{Params:{id:string};Querystring:{before?:number}}>('/api/automations/:id/history',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}}},async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');return db.begin(async tx=>{
   await ruleAccess(tx,actor,request.params.id,request);const rows=await tx`SELECT version,created_at,snapshot-'session_id'-'approval_xid' AS definition FROM automation_rule_version
    WHERE rule_id=${request.params.id} AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT 11`;
   return {items:rows.slice(0,10),nextVersion:rows.length>10?rows[9]!.version:null};
  });
 });
 for(const kind of ['sources','executions'] as const){
  const root='/api/automation/'+kind;
  app.get<{Querystring:Page}>(root,{schema:{querystring:page}},async request=>{
   const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const cursor=decodeCursor(request.query.cursor),limit=request.query.limit??20;
   return db.begin(async tx=>{
    if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'AUTOMATION_ACCESS_REVOKED');
    const table=kind==='sources'?'automation_match_queue':'automation_execution',pk=kind==='sources'?'q.source_id':'q.id',date=kind==='sources'?'s.captured_at':'q.created_at';
    const rows=await tx`SELECT ${tx.unsafe(pk)} AS id,s.lead_id,s.trigger_type,${tx.unsafe(date)} AS created_at,${tx.unsafe(date)}::text AS cursor_at,
     q.version,q.state,q.failure_count,CASE WHEN q.state='QUEUED' THEN q.next_run_at ELSE NULL END AS next_run_at,
     ${kind==='executions'?tx.unsafe("q.rule_id,q.rule_version,q.result_code,v.snapshot->>'name' AS rule_name,(SELECT id FROM follow_up WHERE automation_execution_id=q.id) AS follow_up_id"):
      tx.unsafe('NULL::uuid AS rule_id,NULL::integer AS rule_version,NULL::text AS result_code,NULL::text AS rule_name,NULL::uuid AS follow_up_id')}
     FROM ${tx(table)} q JOIN automation_source s ON s.id=q.source_id JOIN lead l ON l.id=s.lead_id AND l.organization_id=s.organization_id AND l.branch_id=s.branch_id AND l.campaign_id=s.campaign_id
     JOIN campaign c ON c.id=l.campaign_id AND c.organization_id=l.organization_id AND c.branch_id=l.branch_id
     ${kind==='executions'?tx.unsafe('JOIN automation_rule_version v ON v.rule_id=q.rule_id AND v.version=q.rule_version'):tx.unsafe('')}
     WHERE s.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR s.branch_id=${actor.branchId})
      AND (${cursor?.timestamp??null}::text::timestamptz IS NULL OR (${tx.unsafe(date)},${tx.unsafe(pk)})<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
     ORDER BY ${tx.unsafe(date)} DESC,${tx.unsafe(pk)} DESC LIMIT ${limit+1}`;
    return paged(rows,limit);
   });
  });
  app.get<{Params:{id:string};Querystring:{before?:number}}>(root+'/:id/history',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}}},async request=>{
   const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');return db.begin(async tx=>{
    await processingAccess(tx,actor,kind,request.params.id,request);const rows=await tx`SELECT version,created_at,snapshot->>'state' AS state,snapshot->>'operation' AS operation,
     (snapshot->>'failure_count')::integer AS failure_count,snapshot->>'result_code' AS result_code FROM automation_processing_history
     WHERE kind=${kind==='sources'?'MATCH':'EXECUTION'} AND resource_id=${request.params.id} AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null})
     ORDER BY version DESC LIMIT 11`;return {items:rows.slice(0,10),nextVersion:rows.length>10?rows[9]!.version:null};
   });
  });
  app.post<{Params:{id:string};Body:{version:number}}>(root+'/:id/retry',{schema:{params,body:{type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1}}}}},async request=>{
   const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');return db.begin(async tx=>{
    const {session}=await processingAccess(tx,actor,kind,request.params.id,request),table=kind==='sources'?'automation_match_queue':'automation_execution',key=kind==='sources'?'source_id':'id';
    const q=(await tx`SELECT version,state FROM ${tx(table)} WHERE ${tx(key)}=${request.params.id} FOR UPDATE`)[0];
    if(!q)throw new HttpError(404,'AUTOMATION_PROCESSING_NOT_FOUND');if(q.version!==request.body.version||q.state!=='DEAD_LETTER')throw new HttpError(409,'AUTOMATION_RECOVERY_CONFLICT');
    await tx`UPDATE ${tx(table)} SET version=version+1,operation='RETRY',actor_id=${actor.id},session_id=${session} WHERE ${tx(key)}=${request.params.id}`;
    return {version:q.version+1};
   });
  });
 }
}
