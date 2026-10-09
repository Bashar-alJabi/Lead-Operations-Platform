import type postgres from 'postgres';
import { HttpError,type Principal } from '../security.js';
import { effectiveCampaignContext } from './effective-context.js';
import { effectiveConfigHash } from './operational-config.js';
export async function approvedConversationReadContext(tx:postgres.TransactionSql,actor:Principal,conversationId:string,sessionId:string) {
  const initial=(await tx`SELECT l.branch_id FROM conversation cv JOIN lead l ON l.id=cv.lead_id WHERE cv.id=${conversationId} AND l.organization_id=${actor.organizationId}
    AND (${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId}) AND (${actor.role!=='AGENT'} OR l.assigned_agent_id=${actor.id})`)[0];
  if(!initial)throw new HttpError(404,'CONVERSATION_NOT_FOUND');
  const b=(await tx`SELECT * FROM branch WHERE id=${initial.branch_id} FOR SHARE`)[0]!;
  const c=(await tx`SELECT c.* FROM campaign c JOIN lead l ON l.campaign_id=c.id JOIN conversation cv ON cv.lead_id=l.id WHERE cv.id=${conversationId} FOR SHARE OF c`)[0]!;
  const lead=(await tx`SELECT l.id,l.organization_id,l.branch_id,l.campaign_id,l.assigned_agent_id FROM lead l JOIN conversation cv ON cv.lead_id=l.id WHERE cv.id=${conversationId}
    AND l.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId}) AND (${actor.role!=='AGENT'} OR l.assigned_agent_id=${actor.id}) FOR SHARE OF l`)[0];
  if(!lead)throw new HttpError(404,'CONVERSATION_NOT_FOUND');
  const cv=(await tx`SELECT id,controller_type,state FROM conversation WHERE id=${conversationId} AND lead_id=${lead.id} FOR SHARE`)[0]!;
  const user=(await tx`SELECT 1 FROM user_account u JOIN user_session s ON s.user_id=u.id WHERE u.id=${actor.id} AND s.id=${sessionId} AND u.active AND u.organization_id=${actor.organizationId}
    AND u.role=${actor.role} AND u.branch_id IS NOT DISTINCT FROM ${actor.branchId}::uuid AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF u,s`)[0];
  if(!user)throw new HttpError(403,'AI_COPILOT_ACCESS_REVOKED');
  return { b,c,lead,cv };
}
export async function trustedCopilotSnapshot(tx:postgres.TransactionSql,actor:Principal,conversationId:string,sessionId:string) {
  const { b,c,lead,cv }=await approvedConversationReadContext(tx,actor,conversationId,sessionId);
  if(!b.active)throw new HttpError(409,'BRANCH_DISABLED');
  if(cv.controller_type!=='HUMAN' || cv.state!=='HUMAN_ACTIVE')throw new HttpError(409,'AI_COPILOT_HUMAN_CONTROL_REQUIRED');
  const campaignContext=await effectiveCampaignContext(tx,actor.organizationId,c,b),profile=campaignContext.profiles.SUMMARIZATION as { available:boolean }|null;
  // Selecting a current active SUMMARIZATION profile explicitly enables this internal read-only action.
  if(!profile?.available)throw new HttpError(409,'AI_SUMMARIZATION_PROFILE_REQUIRED');
  const summaryContext=(await tx`SELECT ai_copilot_summary_context(${conversationId}) AS context`)[0]!.context;
  const context={ kind:'COPILOT_SUMMARY',invoker:{ id:actor.id,role:actor.role,branchId:actor.branchId },campaignContext,summaryContext };
  return { context,hash:effectiveConfigHash(context),lead,c,b };
}
export type CopilotContext=Awaited<ReturnType<typeof trustedCopilotSnapshot>>['context'];
