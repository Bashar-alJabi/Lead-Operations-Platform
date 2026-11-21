import type {FastifyInstance,FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest,requireRole,type Principal} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {decodeCursor,encodeCursor} from '../pagination.js';
import {validateFieldValue,type FieldOption,type FieldType,type FieldValidation} from '../fields.js';

const triggers=['LEAD_CREATED','LEAD_ASSIGNED','LEAD_REASSIGNED','PAYMENT_CONFIRMED','ENROLLMENT_CONFIRMED','FOLLOW_UP_DUE','MESSAGE_RECEIVED','CONVERSATION_STATE_CHANGED','FIELD_CHANGED'] as const;
const financialConditions=['ANY','TEST_CONFIRMED','TEST_UNCONFIRMED','LIVE_CONFIRMED','LIVE_UNCONFIRMED'] as const;
const conversationStates=['AI_ACTIVE','AI_WAITING_FOR_LEAD','AI_HANDOFF_REQUIRED','WAITING_FOR_HUMAN','HUMAN_ACTIVE','CLOSED'] as const;
const conversationControllers=['AI','HUMAN','NONE'] as const;
const dateBases=['LEAD_CREATED','EVENT_CAPTURED'] as const;
const actions=['CREATE_FOLLOW_UP','SEND_IN_APP_NOTIFICATION','SET_FIELD_VALUE','ASSIGN_LEAD'] as const;
type FieldCondition={fieldId:string;value:unknown};
type FieldOperation='SET'|'ADD_TAGS';
type DateCondition={basis:typeof dateBases[number];from?:string;through?:string};
type Definition={name:string;enabled:boolean;triggerType:typeof triggers[number];
 triggerFieldId?:string|null;
 fieldCondition?:FieldCondition|null;
 fieldAction?:(FieldCondition&{operation?:FieldOperation})|null;
 actionAgentId?:string|null;
 conditionAgentId?:string|null;dateCondition?:DateCondition|null;
 paymentCondition?:typeof financialConditions[number];enrollmentCondition?:typeof financialConditions[number];
 conversationStateCondition?:typeof conversationStates[number]|null;controllerCondition?:typeof conversationControllers[number]|null;
 lifecycle:'OPEN'|'CLOSED'|'ARCHIVED'|null;ownerCondition:'ANY'|'ASSIGNED'|'UNASSIGNED';
 actionType:typeof actions[number];delayMinutes:number;priority:'LOW'|'NORMAL'|'HIGH';note:string;reason:string};
const properties={name:{type:'string',minLength:1,maxLength:100},enabled:{type:'boolean'},triggerType:{enum:triggers},
 lifecycle:{enum:['OPEN','CLOSED','ARCHIVED',null]},ownerCondition:{enum:['ANY','ASSIGNED','UNASSIGNED']},actionType:{enum:actions},
 delayMinutes:{type:'integer',minimum:0,maximum:525600},priority:{enum:['LOW','NORMAL','HIGH']},note:{type:'string',maxLength:4000},reason:{type:'string',minLength:3,maxLength:500}} as const;
const uuid={type:'string',format:'uuid'} as const,nullableUuid={anyOf:[uuid,{type:'null'}]} as const;
const utcDay={type:'string',format:'date',pattern:'^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$'} as const;
const fieldValueInput={anyOf:[{type:'null'},{type:'object',required:['fieldId','value'],additionalProperties:false,properties:{fieldId:uuid,value:{}}}]} as const;
const fieldActionInput={anyOf:[fieldValueInput.anyOf[0],{...fieldValueInput.anyOf[1],properties:{
 ...fieldValueInput.anyOf[1].properties,operation:{enum:['SET','ADD_TAGS']},
}}]} as const;
type FieldUsage='ACTION'|'TAGS';
type FieldQuery={branchId?:string;campaignId?:string;usage?:FieldUsage};
const fieldScopeSchema={branchId:uuid,campaignId:uuid,usage:{enum:['ACTION','TAGS']}} as const;
const optionalProperties={triggerFieldId:nullableUuid,paymentCondition:{enum:financialConditions},enrollmentCondition:{enum:financialConditions},
 conditionAgentId:{type:['string','null'],format:'uuid'},
 actionAgentId:{type:['string','null'],format:'uuid'},
 dateCondition:{type:['object','null'],required:['basis'],minProperties:2,additionalProperties:false,
  properties:{basis:{enum:dateBases},from:utcDay,through:utcDay}},
 fieldCondition:fieldValueInput,fieldAction:fieldActionInput,
 conversationStateCondition:{enum:[...conversationStates,null]},controllerCondition:{enum:[...conversationControllers,null]}} as const;
const params={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
const page={type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:50},cursor:{type:'string',maxLength:256}}} as const;
type Page={limit?:number;cursor?:string};
function validate(input:Definition){if(!input.name.trim()||input.reason.trim().length<3||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.name+input.note+input.reason)
 ||(input.triggerType==='FIELD_CHANGED')!==Boolean(input.triggerFieldId)
 ||(input.dateCondition?.from&&input.dateCondition.through&&input.dateCondition.from>input.dateCondition.through)
 ||(input.fieldAction&&input.actionType!=='SET_FIELD_VALUE')
 ||(input.actionAgentId&&input.actionType!=='ASSIGN_LEAD')
 ||input.actionType!=='CREATE_FOLLOW_UP'&&(input.delayMinutes!==0||input.priority!=='NORMAL'))throw new HttpError(400,'INVALID_AUTOMATION_DEFINITION');}
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
async function writeDefinition<T>(write:()=>Promise<T>){
 try{return await write();}
 catch(error){
  if(error instanceof Error&&['AUTOMATION_TRIGGER_FIELD_UNAVAILABLE','AUTOMATION_CONDITION_FIELD_UNAVAILABLE',
    'AUTOMATION_CONDITION_AGENT_UNAVAILABLE','AUTOMATION_ACTION_FIELD_UNAVAILABLE','AUTOMATION_ASSIGNMENT_AGENT_UNAVAILABLE'].includes(error.message))
   throw new HttpError(409,error.message);
  if(error instanceof Error&&error.message==='AUTOMATION_ACTION_FIELD_INVALID')
   throw new HttpError(400,'FIELD_VALUE_INVALID');
  throw error;
 }
}
async function automationField(tx:postgres.TransactionSql,actor:Principal,branchId:string|null,campaignId:string|null,id:string,usage?:FieldUsage){
 const [field]=await tx`SELECT f.id,f.key,f.label,f.field_type,f.value_mode,f.options,f.validation,f.version
  FROM field_definition f WHERE f.id=${id} AND f.organization_id=${actor.organizationId}
   AND (NOT ${usage==='TAGS'} OR f.field_type='TAGS')
   AND CASE WHEN ${Boolean(usage)} THEN automation_action_field_available(f.id,${actor.organizationId},${branchId},${campaignId},${actor.role==='MANAGER'})
    ELSE automation_field_trigger_available(f.id,${actor.organizationId},${branchId},${campaignId},${actor.role==='MANAGER'}) END
  FOR SHARE OF f`;
 if(!field)throw new HttpError(404,usage?'AUTOMATION_ACTION_FIELD_UNAVAILABLE':'AUTOMATION_CONDITION_FIELD_UNAVAILABLE');
 return field;
}
async function prepareFieldValue(tx:postgres.TransactionSql,actor:Principal,branchId:string|null,campaignId:string|null,condition?:FieldCondition|null,usage?:FieldUsage){
 if(!condition)return null;
 const field=await automationField(tx,actor,branchId,campaignId,condition.fieldId,usage);
 const value=validateFieldValue(field.field_type as FieldType,condition.value,field.options as FieldOption[],field.validation as FieldValidation);
 if(value===null)throw new HttpError(400,'FIELD_VALUE_INVALID');
 return {id:field.id,version:field.version,value:tx.json(value as postgres.JSONValue)};
}
export function registerAutomationRoutes(app:FastifyInstance,db:Database){
 app.get<{Querystring:{branchId?:string;search?:string;after?:string}}>('/api/automations/condition-agents',{
  schema:{querystring:{type:'object',additionalProperties:false,properties:{branchId:uuid,
   search:{type:'string',maxLength:100},after:uuid}}},
 },async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');
  const branchId=request.query.branchId??actor.branchId,search=request.query.search?.trim().toLowerCase()??'';
  return db.begin(async tx=>{
   await scope(tx,actor,branchId,null,request);
   const rows=await tx`SELECT id,name FROM user_account WHERE organization_id=${actor.organizationId} AND role='AGENT' AND active
    AND (${branchId}::uuid IS NULL OR branch_id=${branchId})
    AND (${search}='' OR position(${search} IN lower(name))>0)
    AND (${request.query.after??null}::uuid IS NULL OR id>${request.query.after??null}) ORDER BY id LIMIT 51`;
   return {items:rows.slice(0,50),nextAfter:rows.length>50?rows[49]!.id:null};
  });
 });
 app.get<{Querystring:FieldQuery&{after?:string}}>('/api/automations/trigger-fields',{
  schema:{querystring:{type:'object',additionalProperties:false,properties:{...fieldScopeSchema,after:uuid}}},
 },async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');
  const branchId=request.query.branchId??actor.branchId,campaignId=request.query.campaignId??null;
  return db.begin(async tx=>{
   await scope(tx,actor,branchId,campaignId,request);
   const rows=await tx`SELECT f.id,f.label FROM field_definition f WHERE f.organization_id=${actor.organizationId}
    AND (${request.query.after??null}::uuid IS NULL OR f.id>${request.query.after??null})
    AND (NOT ${request.query.usage==='TAGS'} OR f.field_type='TAGS')
    AND CASE WHEN ${Boolean(request.query.usage)} THEN automation_action_field_available(f.id,${actor.organizationId},${branchId},${campaignId},${actor.role==='MANAGER'})
     ELSE automation_field_trigger_available(f.id,${actor.organizationId},${branchId},${campaignId},${actor.role==='MANAGER'}) END
    ORDER BY f.id LIMIT 51`;
   return {items:rows.slice(0,50),nextAfter:rows.length>50?rows[49]!.id:null};
  });
 });
 app.get<{Params:{id:string};Querystring:FieldQuery}>('/api/automations/trigger-fields/:id',{
  schema:{params,querystring:{type:'object',additionalProperties:false,properties:fieldScopeSchema}},
 },async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');
  const branchId=request.query.branchId??actor.branchId,campaignId=request.query.campaignId??null;
  return db.begin(async tx=>{
   await scope(tx,actor,branchId,campaignId,request);
   return automationField(tx,actor,branchId,campaignId,request.params.id,request.query.usage);
  });
 });
 app.get<{Querystring:Page}>('/api/automations',{schema:{querystring:page}},async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const cursor=decodeCursor(request.query.cursor),limit=request.query.limit??20;
  return db.begin(async tx=>{if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'AUTOMATION_ACCESS_REVOKED');
   const rows=await tx`SELECT r.id,r.name,r.branch_id,r.campaign_id,b.name AS branch_name,c.name AS campaign_name,r.version,r.enabled,r.trigger_type,r.trigger_field_id,r.lifecycle,r.owner_condition,
    r.condition_agent_id,a.name AS condition_agent_name,r.condition_date_basis,
    r.action_agent_id,assignee.name AS action_agent_name,
    r.condition_date_from::text AS condition_date_from,r.condition_date_through::text AS condition_date_through,
    r.payment_condition,r.enrollment_condition,r.conversation_state_condition,r.controller_condition,
    r.condition_field_id,CASE WHEN automation_field_trigger_available(r.condition_field_id,r.organization_id,r.branch_id,r.campaign_id,${actor.role==='MANAGER'})
      THEN r.condition_field_value END AS condition_field_value,
    r.action_field_id,r.action_field_operation,CASE WHEN automation_action_field_available(r.action_field_id,r.organization_id,r.branch_id,r.campaign_id,${actor.role==='MANAGER'})
      THEN r.action_field_value END AS action_field_value,
    r.action_type,r.delay_minutes,r.priority,r.note,r.reason,r.created_at,r.created_at::text AS cursor_at,r.updated_at FROM automation_rule r
    LEFT JOIN branch b ON b.id=r.branch_id LEFT JOIN campaign c ON c.id=r.campaign_id
    LEFT JOIN user_account a ON a.id=r.condition_agent_id AND a.organization_id=r.organization_id AND a.active
     AND a.role='AGENT' AND (r.branch_id IS NULL OR a.branch_id=r.branch_id)
    LEFT JOIN user_account assignee ON assignee.id=r.action_agent_id AND assignee.organization_id=r.organization_id AND assignee.active
     AND assignee.role='AGENT' AND (r.branch_id IS NULL OR assignee.branch_id=r.branch_id)
    WHERE r.organization_id=${actor.organizationId}
     AND (${actor.role==='SUPER_ADMIN'} OR r.branch_id=${actor.branchId}) AND (${cursor?.timestamp??null}::text::timestamptz IS NULL
      OR (r.created_at,r.id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT ${limit+1}`;
   return paged(rows,limit);
  });
 });
 app.post<{Body:Definition&{branchId:string|null;campaignId:string|null}}>('/api/automations',{schema:{body:{type:'object',additionalProperties:false,
  required:[...Object.keys(properties),'branchId','campaignId'],properties:{...properties,...optionalProperties,branchId:nullableUuid,campaignId:nullableUuid}}}},async(request,reply)=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const input=request.body;validate(input);
  if(input.conditionAgentId&&input.ownerCondition==='UNASSIGNED')throw new HttpError(400,'INVALID_AUTOMATION_DEFINITION');
  if(input.actionType==='SET_FIELD_VALUE'&&!input.fieldAction)throw new HttpError(400,'INVALID_AUTOMATION_DEFINITION');
  if(input.actionType==='ASSIGN_LEAD'&&!input.actionAgentId)throw new HttpError(400,'INVALID_AUTOMATION_DEFINITION');
  const id=await writeDefinition(()=>db.begin(async tx=>{const session=await scope(tx,actor,input.branchId,input.campaignId,request);
   const field=await prepareFieldValue(tx,actor,input.branchId,input.campaignId,input.fieldCondition);
   const operation=input.fieldAction?.operation??'SET';
   const target=await prepareFieldValue(tx,actor,input.branchId,input.campaignId,input.fieldAction,operation==='ADD_TAGS'?'TAGS':'ACTION');
   return (await tx`INSERT INTO automation_rule(organization_id,branch_id,campaign_id,name,version,enabled,trigger_type,trigger_field_id,lifecycle,owner_condition,
    condition_field_id,condition_field_value,condition_field_definition_version,
    condition_agent_id,condition_date_basis,condition_date_from,condition_date_through,
    action_field_id,action_field_value,action_field_definition_version,action_field_operation,action_agent_id,
    payment_condition,enrollment_condition,conversation_state_condition,controller_condition,action_type,delay_minutes,priority,note,actor_id,session_id,reason)
    VALUES(${actor.organizationId},${input.branchId},${input.campaignId},${input.name},1,${input.enabled},${input.triggerType},${input.triggerFieldId??null},${input.lifecycle},${input.ownerCondition},
     ${field?.id??null},${field?.value??null},${field?.version??null},
     ${input.conditionAgentId??null},${input.dateCondition?.basis??null},${input.dateCondition?.from??null},${input.dateCondition?.through??null},
     ${target?.id??null},${target?.value??null},${target?.version??null},${operation},${input.actionAgentId??null},
     ${input.paymentCondition??'ANY'},${input.enrollmentCondition??'ANY'},${input.conversationStateCondition??null},
     ${input.controllerCondition??null},${input.actionType},
     ${input.delayMinutes},${input.priority},${input.note},${actor.id},${session},${input.reason}) RETURNING id`)[0]!.id;
  }));reply.code(201);return {id,version:1};
 });
 app.put<{Params:{id:string};Body:Definition&{version:number}}>('/api/automations/:id',{schema:{params,body:{type:'object',additionalProperties:false,
  required:[...Object.keys(properties),'version'],properties:{...properties,...optionalProperties,version:{type:'integer',minimum:1}}}}},async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const input=request.body;validate(input);
  return writeDefinition(()=>db.begin(async tx=>{const scope=await ruleAccess(tx,actor,request.params.id,request);const session=await currentPaymentSession(tx,actor,request);
   const r=(await tx`SELECT version,condition_agent_id,action_field_id,action_agent_id FROM automation_rule WHERE id=${request.params.id} FOR UPDATE`)[0]!;if(r.version!==input.version)throw new HttpError(409,'AUTOMATION_VERSION_CONFLICT');
   const agent=input.conditionAgentId===undefined?r.condition_agent_id:input.conditionAgentId;
   if(agent&&input.ownerCondition==='UNASSIGNED')throw new HttpError(400,'INVALID_AUTOMATION_DEFINITION');
   const keepsTarget=input.actionType==='SET_FIELD_VALUE'&&input.fieldAction===undefined&&r.action_field_id!==null;
   if(input.actionType==='SET_FIELD_VALUE'&&!keepsTarget&&!input.fieldAction)throw new HttpError(400,'INVALID_AUTOMATION_DEFINITION');
   const assignee=input.actionType==='ASSIGN_LEAD'?(input.actionAgentId===undefined?r.action_agent_id:input.actionAgentId):null;
   if(input.actionType==='ASSIGN_LEAD'&&!assignee)throw new HttpError(400,'INVALID_AUTOMATION_DEFINITION');
   const field=await prepareFieldValue(tx,actor,scope.branch_id,scope.campaign_id,input.fieldCondition);
   const operation=input.fieldAction?.operation??'SET';
   const target=await prepareFieldValue(tx,actor,scope.branch_id,scope.campaign_id,input.fieldAction,operation==='ADD_TAGS'?'TAGS':'ACTION');
   const replacesField=input.fieldCondition!==undefined,replacesDate=input.dateCondition!==undefined;
   await tx`UPDATE automation_rule SET name=${input.name},enabled=${input.enabled},trigger_type=${input.triggerType},trigger_field_id=${input.triggerFieldId??null},lifecycle=${input.lifecycle},owner_condition=${input.ownerCondition},action_type=${input.actionType},
    condition_field_id=CASE WHEN ${replacesField} THEN ${field?.id??null} ELSE condition_field_id END,
    condition_field_value=CASE WHEN ${replacesField} THEN ${field?.value??null} ELSE condition_field_value END,
    condition_field_definition_version=CASE WHEN ${replacesField} THEN ${field?.version??null} ELSE condition_field_definition_version END,
    condition_agent_id=${agent},
    condition_date_basis=CASE WHEN ${replacesDate} THEN ${input.dateCondition?.basis??null} ELSE condition_date_basis END,
    condition_date_from=CASE WHEN ${replacesDate} THEN ${input.dateCondition?.from??null}::date ELSE condition_date_from END,
    condition_date_through=CASE WHEN ${replacesDate} THEN ${input.dateCondition?.through??null}::date ELSE condition_date_through END,
    action_field_id=CASE WHEN ${keepsTarget} THEN action_field_id ELSE ${target?.id??null} END,
    action_field_value=CASE WHEN ${keepsTarget} THEN action_field_value ELSE ${target?.value??null} END,
    action_field_definition_version=CASE WHEN ${keepsTarget} THEN action_field_definition_version ELSE ${target?.version??null} END,
    action_field_operation=CASE WHEN ${keepsTarget} THEN action_field_operation ELSE ${operation} END,
    action_agent_id=${assignee},
    payment_condition=COALESCE(${input.paymentCondition??null},payment_condition),
    enrollment_condition=COALESCE(${input.enrollmentCondition??null},enrollment_condition),
    conversation_state_condition=CASE WHEN ${input.conversationStateCondition!==undefined} THEN ${input.conversationStateCondition??null} ELSE conversation_state_condition END,
    controller_condition=CASE WHEN ${input.controllerCondition!==undefined} THEN ${input.controllerCondition??null} ELSE controller_condition END,
    delay_minutes=${input.delayMinutes},priority=${input.priority},note=${input.note},actor_id=${actor.id},session_id=${session},reason=${input.reason},version=version+1 WHERE id=${request.params.id}`;
   return {version:input.version+1};
  }));
 });
 app.get<{Params:{id:string};Querystring:{before?:number}}>('/api/automations/:id/history',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}}},async request=>{
  const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');return db.begin(async tx=>{
   await ruleAccess(tx,actor,request.params.id,request);const rows=await tx`SELECT version,created_at,snapshot-'session_id'-'approval_xid'-'condition_field_value'-'action_field_value' AS definition FROM automation_rule_version
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
