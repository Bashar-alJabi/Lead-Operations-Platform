import type postgres from 'postgres';
import type {Database} from '../db.js';
import {resolveConfiguredSender} from '../messaging/sender-resolution.js';
// Configuration readiness for the implemented first-contact flow; never Live Provider verification or send authorization.
export async function initialCampaignIssues(sql:Database|postgres.TransactionSql,campaign:postgres.Row){
 const issues:string[]=[];
 if(campaign.messaging_config?.enabled){const sender=await resolveConfiguredSender(sql,{organizationId:campaign.organization_id,branchId:campaign.branch_id,campaignId:campaign.id});if(!sender.sender)issues.push('MESSAGING_CONFIGURATION_NOT_READY');}
 if(!campaign.ai_config?.enabled)return issues;
 if(!campaign.messaging_config?.enabled)issues.push('MESSAGING_CONFIGURATION_NOT_READY');
 const r=(await sql`SELECT ai_initial_message_context(c.id) AS message,
  COALESCE(NULLIF(cc.definition->'language','null'),bc.definition->'language') AS language,
  COALESCE(NULLIF(cb.definition->'handoff','null'),bb.definition->'handoff') AS handoff,
  COALESCE(cb.definition->'disclosure'->>'text',bb.definition->'disclosure'->>'text') AS disclosure,ai_effective_tool_policy(c.branch_id,c.id) AS tools,
  ai_operational_profile_usable(c.branch_id,COALESCE((cc.definition->'profiles'->>'CONVERSATION')::uuid,(bc.definition->'profiles'->>'CONVERSATION')::uuid),'CONVERSATION') AS usable
  FROM campaign c LEFT JOIN ai_operational_config cc ON cc.scope='CAMPAIGN' AND cc.resource_id=c.id LEFT JOIN ai_operational_config bc ON bc.scope='BRANCH' AND bc.resource_id=c.branch_id
  LEFT JOIN ai_behavior_policy cb ON cb.scope='CAMPAIGN' AND cb.resource_id=c.id LEFT JOIN ai_behavior_policy bb ON bb.scope='BRANCH' AND bb.resource_id=c.branch_id WHERE c.id=${campaign.id}`)[0];
 if(!r?.message?.ready||!r.disclosure||!r.message.body?.includes(r.disclosure)||!r.language||!r.handoff||!r.usable||!r.tools?.allowedTools?.includes('sendConversationMessage'))issues.push('AI_CONFIGURATION_NOT_READY');
 return [...new Set(issues)];
}
