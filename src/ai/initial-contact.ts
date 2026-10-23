import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError } from '../security.js';
import { approvedBodyTemplate } from '../messaging/approved-template.js';
import { checkOutboundAuthorityPolicy,lockOutboundAuthority } from '../messaging/authority.js';

export async function applyInitialContact(tx:postgres.TransactionSql,id:string){
  const a=(await tx`SELECT * FROM ai_initial_admission WHERE id=${id}`)[0]!;
  let ctx=(await tx`SELECT ai_initial_execution_context(${id}) AS ctx`)[0]?.ctx;
  let error:string|null=null,cv:string|null=null,content:postgres.JSONValue|null=null;
  const actionId=randomUUID(),messageId=randomUUID();
  if(!ctx)error='AI_INITIAL_CONTEXT_CHANGED';
  else{
    const l=(await tx`SELECT ct.phone_normalized FROM lead l JOIN contact ct ON ct.id=l.contact_id WHERE l.id=${ctx.scope.leadId}`)[0]!;
    cv=(await tx`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state,ai_initial_admission_id)
      VALUES(${ctx.scope.leadId},${ctx.sender.connectionId},${ctx.sender.senderId},'WHATSAPP',${l.phone_normalized},'AI','AI_ACTIVE',${id}) RETURNING id`)[0]!.id;
    try{
      const locked=await lockOutboundAuthority(tx,{kind:'AI_INITIAL_ADMISSION',admissionId:id},cv!);
      const d=ctx.initialMessage.definition,decision=await checkOutboundAuthorityPolicy(tx,locked,undefined,d.templateId);
      if(!decision.allowed)error=decision.reason;
      else content=await approvedBodyTemplate(tx,ctx.sender.connectionId,ctx.scope.campaignId,d.templateId,d.bodyParameters,d.headerParameter??undefined,d.urlParameter??undefined,{messageId});
    }catch(e){if(e instanceof HttpError)error=e.code;else throw e;}
  }
  await tx`INSERT INTO ai_initial_send_action(id,admission_id,conversation_id,state,error_code,message_id,content)
    VALUES(${actionId},${id},${cv},${error?'BLOCKED':'APPLIED'},${error},${error?null:messageId},${content?tx.json(content):null})`;
  if(!error){
    await tx`INSERT INTO conversation_message(id,conversation_id,connection_id,sender_id,direction,author_type,body,message_kind,template_id,template_snapshot,delivery_state,idempotency_key,ai_initial_action_id)
      VALUES(${messageId},${cv},${ctx.sender.connectionId},${ctx.sender.senderId},'OUTBOUND','AI',${(content as {body:string}).body},'TEMPLATE',${ctx.initialMessage.definition.templateId},${tx.json((content as {snapshot:postgres.JSONValue}).snapshot)},'QUEUED',${actionId},${actionId})`;
    const j=(await tx`INSERT INTO background_job(queue,kind,payload,idempotency_key) VALUES('messaging','SEND_MESSAGE',${tx.json({messageId})},${messageId}) RETURNING id`)[0]!;
    await tx`INSERT INTO outbound_delivery_job(message_id,job_id) VALUES(${messageId},${j.id})`;
    await tx`UPDATE conversation SET last_message_at=clock_timestamp() WHERE id=${cv}`;
  }
}
export async function processOneAIInitialContact(db:Database){
  return db.begin(async tx=>{
    // Parent first. SKIP LOCKED partitions work across workers without holding a Job lock while waiting on Branch.
    const candidate=(await tx`SELECT j.admission_id FROM ai_initial_job j JOIN ai_initial_admission a ON a.id=j.admission_id JOIN branch b ON b.id=(a.context->'scope'->>'branchId')::uuid WHERE j.state='WAITING' AND j.available_at<=clock_timestamp() ORDER BY j.available_at,j.admission_id LIMIT 1 FOR UPDATE OF b SKIP LOCKED`)[0];
    if(!candidate)return false;
    const job=(await tx`SELECT * FROM ai_initial_job WHERE admission_id=${candidate.admission_id} AND state='WAITING' AND available_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`)[0];
    if(!job)return false;
    try{await tx.savepoint(async sp=>{await applyInitialContact(sp,job.admission_id);await sp`SET CONSTRAINTS ALL IMMEDIATE`;});}
    catch{
      await tx`UPDATE ai_initial_job SET failure_count=failure_count+1,state=CASE WHEN failure_count+1=5 THEN 'DEAD_LETTER' ELSE 'WAITING' END,error_code='AI_INITIAL_LOCAL_ACTION_FAILED',version=version+1 WHERE admission_id=${job.admission_id}`;
      await tx`INSERT INTO audit_log(organization_id,branch_id,action,target_type,target_id,detail) SELECT (a.context->'scope'->>'organizationId')::uuid,(a.context->'scope'->>'branchId')::uuid,'AI_INITIAL_JOB_FAILED','LEAD',(a.context->'scope'->>'leadId')::uuid,jsonb_build_object('admissionId',a.id,'errorCode','AI_INITIAL_LOCAL_ACTION_FAILED') FROM ai_initial_admission a WHERE a.id=${job.admission_id}`;
    }
    return true;
  });
}
