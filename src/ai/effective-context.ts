import type postgres from 'postgres';
import { aiTasks,emptyAIOperationalConfig,inheritAIOperationalConfig,effectiveConfigHash,globalAIGuardrails } from './operational-config.js';
import { emptyQualification } from './qualification.js';
import { emptyAIFollowupPolicy,aiFollowupMandatoryStops } from './followup-policy.js';
import { currentAIBehaviorPolicy } from '../routes/ai-behavior-policy.js';
import { inheritAIBehaviorPolicy,aiMandatoryHandoffTriggers } from './behavior-policy.js';
import { validateFieldValue,type FieldType,type FieldOption,type FieldValidation } from '../fields.js';
import { resolveConfiguredSender } from '../messaging/sender-resolution.js';
import { effectiveAIToolPolicy } from './tool-policy.js';
export async function currentAIOperationalConfig(tx:postgres.TransactionSql,scope:string,id:string) {
  return (await tx`SELECT version,definition,actor_id,reason,updated_at FROM ai_operational_config WHERE scope=${scope} AND resource_id=${id} FOR SHARE`)[0] ?? { version:0,definition:emptyAIOperationalConfig(),actor_id:null,reason:null,updated_at:null };
}
export async function effectiveCampaignContext(tx:postgres.TransactionSql,organizationId:string,c:postgres.Row,b:postgres.Row) {
  const id=c.id,current=currentAIOperationalConfig;
      const toolPolicy=await effectiveAIToolPolicy(tx,b.id,id);
      const branch=await current(tx,'BRANCH',b.id),campaign=await current(tx,'CAMPAIGN',id),{ effective,sources }=inheritAIOperationalConfig(branch.definition,campaign.definition);
      const followup=((await tx`SELECT version,definition FROM ai_followup_policy WHERE campaign_id=${id} FOR SHARE`)[0] ?? { version:0,definition:emptyAIFollowupPolicy() }) as { version:number;definition:ReturnType<typeof emptyAIFollowupPolicy> };
      const blockers=['AI_RUNTIME_NOT_IMPLEMENTED','AI_APPROVED_TOOLS_NOT_IMPLEMENTED','AI_FOLLOWUP_RUNTIME_NOT_IMPLEMENTED','AI_ACTION_SIMULATION_NOT_IMPLEMENTED'];
      if(!followup.version)blockers.push('AI_FOLLOWUP_POLICY_REQUIRED');
      const behaviorBranch=await currentAIBehaviorPolicy(tx,'BRANCH',b.id),behaviorCampaign=await currentAIBehaviorPolicy(tx,'CAMPAIGN',id),behavior=inheritAIBehaviorPolicy(behaviorBranch.definition,behaviorCampaign.definition);
      if(!behavior.effective.disclosure)blockers.push('AI_DISCLOSURE_POLICY_REQUIRED');
      if(!behavior.effective.handoff)blockers.push('AI_HANDOFF_POLICY_REQUIRED');
      if(!behavior.effective.returningContact)blockers.push('AI_RETURNING_CONTACT_POLICY_REQUIRED');
      if(!b.active)blockers.push('BRANCH_DISABLED');if(!c.ai_config.enabled)blockers.push('AI_DISABLED');if(!effective.language)blockers.push('AI_LANGUAGE_REQUIRED');
      const profiles:Record<string,unknown>={};
      for(const task of aiTasks) {
        const pid=effective.profiles[task];if(!pid) { profiles[task]=null;if(task==='CONVERSATION')blockers.push('AI_CONVERSATION_PROFILE_REQUIRED');continue; }
        if(!(await tx`SELECT ai_operational_profile_usable(${b.id},${pid},${task}) AS usable`)[0]!.usable) { profiles[task]={ id:pid,available:false };blockers.push('AI_PROFILE_UNAVAILABLE:'+task);continue; }
        const row=(await tx`SELECT p.id,p.task,p.model_id,p.max_output_tokens,p.version AS profile_version,c.id AS connection_id,c.version AS connection_version,c.provider,c.capabilities->>'catalogVersion' AS catalog_version,p.branch_id IS NULL AS shared
          FROM ai_model_profile p JOIN integration_connection c ON c.id=p.connection_id WHERE p.id=${pid}`)[0]!;
        const grant=row.shared ? (await tx`SELECT version FROM ai_connection_branch_use WHERE connection_id=${row.connection_id} AND branch_id=${b.id} AND active FOR SHARE`)[0]?.version : null;
        profiles[task]={ ...row,grant_version:grant,available:true,inferenceVerified:false };
      }
      const knowledge=(await tx`SELECT version,content,(SELECT COALESCE(jsonb_agg(m.snapshot ORDER BY m.asset_id),'[]') FROM ai_knowledge_publication_asset m WHERE m.campaign_id=p.campaign_id AND m.version=p.version) AS assets FROM ai_knowledge_publication p WHERE p.campaign_id=${id} ORDER BY version DESC LIMIT 1`)[0] ?? null;
      if(!knowledge)blockers.push('AI_PUBLISHED_KNOWLEDGE_REQUIRED');
      const qualification=((await tx`SELECT version,definition FROM ai_qualification_config WHERE campaign_id=${id} FOR SHARE`)[0] ?? { version:0,definition:emptyQualification() }) as { version:number;definition:ReturnType<typeof emptyQualification> };
      const fieldIds=[...new Set((qualification.definition.questions as { fieldId:string|null }[]).flatMap((q)=>q.fieldId ? [q.fieldId] : []))];
      const fieldVersions=[];
      if(qualification.definition.enabled) {
        const fields=await tx`SELECT f.id,f.field_type,f.options,f.validation,f.version AS definition_version,cf.version AS binding_version FROM campaign_field cf JOIN field_definition f ON f.id=cf.field_id
          WHERE cf.campaign_id=${id} AND f.id IN ${tx(fieldIds.length ? fieldIds : ['00000000-0000-0000-0000-000000000000'])} AND cf.active AND cf.usable_by_ai AND f.active AND f.value_mode='MANUAL' AND f.organization_id=${organizationId}
          AND (f.branch_id IS NULL OR f.branch_id=${b.id}) AND (f.campaign_id IS NULL OR f.campaign_id=${id}) ORDER BY f.id FOR SHARE OF f,cf`;
        if(fields.length!==fieldIds.length)blockers.push('AI_QUALIFICATION_FIELD_UNAVAILABLE');
        for(const f of fields)fieldVersions.push({ id:f.id,definition_version:f.definition_version,binding_version:f.binding_version });
        for(const rule of [...qualification.definition.completion.conditions,...qualification.definition.handoff.conditions])if(rule.operator==='EQUALS') {
          const fid=qualification.definition.questions.find((q:{ id:string })=>q.id===rule.questionId)?.fieldId,f=fields.find((f)=>f.id===fid);
          if(f)try { validateFieldValue(f.field_type as FieldType,rule.value,f.options as FieldOption[],f.validation as FieldValidation); }catch { if(!blockers.includes('AI_QUALIFICATION_CONDITION_INVALID'))blockers.push('AI_QUALIFICATION_CONDITION_INVALID'); }
        }
      }
      const target=effective.handoffTargetId ? (await tx`SELECT id,name,role FROM user_account WHERE id=${effective.handoffTargetId} AND branch_id=${b.id} AND organization_id=${organizationId} AND active AND role IN ('AGENT','MANAGER') FOR SHARE`)[0] ?? null : null;
      if(!target)blockers.push(effective.handoffTargetId ? 'AI_HANDOFF_TARGET_UNAVAILABLE' : 'AI_HANDOFF_TARGET_REQUIRED');
      if(target?.role==='AGENT' && !(await tx`SELECT 1 FROM campaign_agent WHERE campaign_id=${id} AND agent_id=${target.id} AND active FOR SHARE`).length)blockers.push('AI_HANDOFF_AGENT_NOT_ELIGIBLE');
      const sender=await resolveConfiguredSender(tx,{ organizationId:organizationId,branchId:b.id,campaignId:id });if(!sender.sender)blockers.push('AI_MESSAGING_SENDER_UNAVAILABLE');
      const snapshot={ schema:1,organizationId:organizationId,branchId:b.id,campaignId:id,globalGuardrails:globalAIGuardrails,
        branchDefaults:{ version:branch.version,definition:branch.definition },campaignOverrides:{ version:campaign.version,definition:campaign.definition },effective,sources,profiles,
        campaignVersion:c.version,campaignAIEnabled:c.ai_config.enabled===true,branchActive:b.active,knowledge,qualification:{ ...qualification,fieldVersions },handoffTarget:target,
        followup:{ ...followup,maxAttempts:followup.definition.delaysSeconds.length,mandatoryStops:aiFollowupMandatoryStops },
        behavior:{ ...behavior,branchVersion:behaviorBranch.version,campaignVersion:behaviorCampaign.version,mandatoryHandoffTriggers:aiMandatoryHandoffTriggers },
        messaging:{ timezone:b.timezone,branchPolicyVersion:b.messaging_policy_version,campaignPolicyVersion:c.version,window:c.messaging_policy?.sendingWindow ?? (b.messaging_window?.start ? b.messaging_window : null),maxAttempts:c.messaging_policy?.maxAttempts ?? null,minIntervalSeconds:c.messaging_policy?.minIntervalSeconds ?? null,
          newConversationSender:sender.sender ?? null,resolutionReason:sender.reason,consentRequired:true },toolPolicy,allowedTools:toolPolicy.allowedTools,blockers };
  return { ...snapshot,hash:effectiveConfigHash(snapshot),previewOnly:true,assistantReady:false,inferenceVerified:false };
}
export type EffectiveCampaignContext=Awaited<ReturnType<typeof effectiveCampaignContext>>;
