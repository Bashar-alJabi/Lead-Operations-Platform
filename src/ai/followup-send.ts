import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { HttpError } from '../security.js';
import { approvedBodyTemplate } from '../messaging/approved-template.js';
import { checkOutboundAuthorityPolicy, lockOutboundAuthority } from '../messaging/authority.js';

type TemplateDefinition = { templateId:string; bodyParameters:string[]; headerParameter:string|null; urlParameter:string|null };

export async function processOneAIFollowupSend(db:Database):Promise<boolean> {
  return db.begin(async tx => {
    const [candidate]=await tx`SELECT s.id,s.conversation_id,s.lead_id,s.campaign_id,s.connection_id,s.sender_id
      FROM ai_followup_schedule s JOIN branch b ON b.id=s.branch_id
      WHERE s.state='READY' AND NOT EXISTS(SELECT 1 FROM ai_followup_send_action a WHERE a.schedule_id=s.id)
      ORDER BY s.due_at,s.id LIMIT 1 FOR UPDATE OF b SKIP LOCKED`;
    if(!candidate) return false;
    await tx`SELECT id FROM lead WHERE id=${candidate.lead_id} FOR UPDATE`;
    await tx`SELECT id FROM conversation WHERE id=${candidate.conversation_id} FOR UPDATE`;
    const [current]=await tx`SELECT state,ai_followup_send_context(id) AS context FROM ai_followup_schedule WHERE id=${candidate.id} FOR UPDATE`;
    if(current?.state!=='READY') return false;
    if(!current.context){
      await tx`UPDATE ai_followup_schedule SET state='STOPPED' WHERE id=${candidate.id}`;
      return true;
    }
    const authority={kind:'AI_FOLLOWUP_SCHEDULE' as const,scheduleId:candidate.id};
    const locked=await lockOutboundAuthority(tx,authority,candidate.conversation_id);
    const definition=current.context.definition as TemplateDefinition;
    const decision=await checkOutboundAuthorityPolicy(tx,locked,undefined,definition.templateId);
    const actionId=randomUUID(),messageId=randomUUID();
    let content:Awaited<ReturnType<typeof approvedBodyTemplate>>|null=null, blocked:string|null=null;
    if(!decision.allowed) blocked=decision.reason;
    else {
      try {
        content=await approvedBodyTemplate(tx,candidate.connection_id,candidate.campaign_id,definition.templateId,
          definition.bodyParameters,definition.headerParameter??undefined,definition.urlParameter??undefined,{messageId});
      } catch(error) {
        if (!(error instanceof HttpError)) throw error;
        blocked=error.code;
      }
    }
    const [stillCurrent]=await tx`SELECT ai_followup_send_context(${candidate.id}) AS context`;
    if (!stillCurrent?.context) return true;
    await tx`INSERT INTO ai_followup_send_action(id,schedule_id,message_id,content,blocked_reason)
      VALUES(${actionId},${candidate.id},${content?messageId:null},${content?tx.json(content):null},${blocked})`;
    if (!content) return true;
    await tx`INSERT INTO conversation_message(id,conversation_id,connection_id,sender_id,direction,author_type,body,
      message_kind,template_id,template_snapshot,delivery_state,idempotency_key,ai_followup_action_id)
      VALUES(${messageId},${candidate.conversation_id},${candidate.connection_id},${candidate.sender_id},'OUTBOUND','AI',${content.body},
       'TEMPLATE',${definition.templateId},${tx.json(content.snapshot)},'QUEUED',${actionId},${actionId})`;
    const [job]=await tx`INSERT INTO background_job(queue,kind,payload,idempotency_key)
      VALUES('messaging','SEND_MESSAGE',${tx.json({messageId})},${messageId}) RETURNING id`;
    await tx`INSERT INTO outbound_delivery_job(message_id,job_id) VALUES(${messageId},${job!.id})`;
    await tx`UPDATE conversation SET last_message_at=clock_timestamp() WHERE id=${candidate.conversation_id}`;
    return true;
  });
}
