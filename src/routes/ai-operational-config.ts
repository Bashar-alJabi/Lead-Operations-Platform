import type postgres from 'postgres';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,requireRole,type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { knowledgeCampaign } from './ai-knowledge.js';
import { aiTasks,aiOperationalSchema,emptyAIOperationalConfig,normalizeAIOperationalConfig,inheritAIOperationalConfig,effectiveConfigHash,globalAIGuardrails,type AIOperationalConfig } from '../ai/operational-config.js';
import { emptyQualification } from '../ai/qualification.js';
import { validateFieldValue,type FieldType,type FieldOption,type FieldValidation } from '../fields.js';
import { resolveConfiguredSender } from '../messaging/sender-resolution.js';
const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
const page={ type:'object',additionalProperties:false,properties:{ before:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } as const;
async function branchAccess(tx:postgres.TransactionSql,actor:Principal,id:string,request:FastifyRequest,write=false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const b=(await tx`SELECT id,organization_id,active,timezone,messaging_window,messaging_policy_version,default_sender_id FROM branch WHERE id=${id} AND organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR id=${actor.branchId}) FOR SHARE`)[0];
  if(!b)throw new HttpError(404,'BRANCH_NOT_FOUND');const sessionId=await currentPaymentSession(tx,actor,request);if(!sessionId)throw new HttpError(403,'AI_OPERATIONAL_ACCESS_REVOKED');
  if(write && !b.active)throw new HttpError(409,'BRANCH_DISABLED');return { b,sessionId };
}
async function current(tx:postgres.TransactionSql,scope:string,id:string) {
  return (await tx`SELECT version,definition,actor_id,reason,updated_at FROM ai_operational_config WHERE scope=${scope} AND resource_id=${id} FOR SHARE`)[0] ?? { version:0,definition:emptyAIOperationalConfig(),actor_id:null,reason:null,updated_at:null };
}
async function checkReferences(tx:postgres.TransactionSql,branchId:string,definition:AIOperationalConfig) {
  for(const task of aiTasks)if(definition.profiles[task] && !(await tx`SELECT ai_operational_profile_usable(${branchId},${definition.profiles[task]},${task}) AS usable`)[0]!.usable)throw new HttpError(409,'AI_OPERATIONAL_PROFILE_UNAVAILABLE');
  if(definition.handoffTargetId && !(await tx`SELECT 1 FROM user_account WHERE id=${definition.handoffTargetId} AND branch_id=${branchId} AND active AND role IN ('AGENT','MANAGER') FOR SHARE`).length)throw new HttpError(409,'AI_OPERATIONAL_TARGET_UNAVAILABLE');
}
export function registerAIOperationalConfigRoutes(app:FastifyInstance,db:Database) {
  for(const scope of ['BRANCH','CAMPAIGN'] as const) {
    const root=scope==='BRANCH' ? '/api/ai/branches/:id/defaults' : '/api/ai/campaigns/:id/configuration';
    async function access(tx:postgres.TransactionSql,actor:Principal,id:string,request:FastifyRequest,write=false) {
      if(scope==='BRANCH') { const { b,sessionId }=await branchAccess(tx,actor,id,request,write);return { branchId:b.id as string,sessionId }; }
      const { c,sessionId }=await knowledgeCampaign(tx,actor,id,request,write);return { branchId:c.branch_id as string,sessionId };
    }
    app.get<{ Params:{ id:string } }>(root,{ schema:{ params } },async(request)=> {
      const actor=await principalFromRequest(request,db);return db.begin(async(tx)=>{ await access(tx,actor,request.params.id,request);return { ...await current(tx,scope,request.params.id),scope,assistantReady:false }; });
    });
    app.put<{ Params:{ id:string };Body:{ version:number;definition:AIOperationalConfig;reason:string } }>(root,{ bodyLimit:32768,schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','definition','reason'],properties:{ version:{ type:'integer',minimum:0 },definition:aiOperationalSchema,reason:{ type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$' } } } } },async(request)=> {
      const actor=await principalFromRequest(request,db),definition=normalizeAIOperationalConfig(request.body.definition),reason=request.body.reason.trim();if(reason.length<3)throw new HttpError(400,'AI_OPERATIONAL_REASON_REQUIRED');
      return db.begin(async(tx)=> {
        const id=request.params.id,{ branchId,sessionId }=await access(tx,actor,id,request,true);
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'ai-operational:'+scope+':'+id},0))`;
        const old=(await tx`SELECT version FROM ai_operational_config WHERE scope=${scope} AND resource_id=${id} FOR UPDATE`)[0];if((old?.version ?? 0)!==request.body.version)throw new HttpError(409,'AI_OPERATIONAL_VERSION_CONFLICT');
        await checkReferences(tx,branchId,definition);
        if(old)await tx`UPDATE ai_operational_config SET definition=${tx.json(definition)},version=version+1,actor_id=${actor.id},session_id=${sessionId},reason=${reason} WHERE scope=${scope} AND resource_id=${id}`;
        else await tx`INSERT INTO ai_operational_config(scope,resource_id,branch_id,campaign_id,version,definition,actor_id,session_id,reason) VALUES (${scope},${id},${branchId},${scope==='CAMPAIGN' ? id : null},1,${tx.json(definition)},${actor.id},${sessionId},${reason})`;
        return { version:request.body.version+1,assistantReady:false };
      });
    });
    app.get<{ Params:{ id:string };Querystring:{ before?:number;limit?:number } }>(root+'/history',{ schema:{ params,querystring:page } },async(request)=> {
      const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
        await access(tx,actor,request.params.id,request);const limit=request.query.limit ?? 20,rows=await tx`SELECT version,snapshot->>'reason' AS reason,snapshot->>'actor_id' AS actor_id,created_at FROM ai_operational_history WHERE scope=${scope} AND resource_id=${request.params.id}
          AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;
        return { items:rows.slice(0,limit),nextVersion:rows.length>limit ? rows[limit-1]!.version : null };
      });
    });
    app.get<{ Params:{ id:string;version:number } }>(root+'/versions/:version',{ schema:{ params:{ ...params,required:['id','version'],properties:{ id:uuid,version:{ type:'integer',minimum:1 } } } } },async(request)=> {
      const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
        await access(tx,actor,request.params.id,request);const row=(await tx`SELECT version,snapshot->'definition' AS definition,snapshot->>'reason' AS reason,snapshot->>'actor_id' AS actor_id,created_at FROM ai_operational_history WHERE scope=${scope} AND resource_id=${request.params.id} AND version=${request.params.version}`)[0];
        if(!row)throw new HttpError(404,'AI_OPERATIONAL_VERSION_NOT_FOUND');return row;
      });
    });
  }
  app.get<{ Params:{ id:string };Querystring:{ after?:string;q?:string;limit?:number } }>('/api/ai/branches/:id/handoff-targets',{ schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ after:uuid,q:{ type:'string',maxLength:100 },limit:{ type:'integer',minimum:1,maximum:100 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await branchAccess(tx,actor,request.params.id,request);const limit=request.query.limit ?? 20,q='%'+(request.query.q ?? '').replace(/[\\%_]/g,'\\$&')+'%';
      const rows=await tx`SELECT id,name,role FROM user_account WHERE branch_id=${request.params.id} AND organization_id=${actor.organizationId} AND active AND role IN ('MANAGER','AGENT') AND name ILIKE ${q}
        AND (${request.query.after ?? null}::uuid IS NULL OR id>${request.query.after ?? null}::uuid) ORDER BY id LIMIT ${limit+1}`;
      return { items:rows.slice(0,limit),nextAfter:rows.length>limit ? rows[limit-1]!.id : null };
    });
  });
  app.get<{ Params:{ id:string } }>('/api/ai/campaigns/:id/effective-configuration',{ schema:{ params } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const id=request.params.id,{ c }=await knowledgeCampaign(tx,actor,id,request),{ b }=await branchAccess(tx,actor,c.branch_id,request);
      const branch=await current(tx,'BRANCH',b.id),campaign=await current(tx,'CAMPAIGN',id),{ effective,sources }=inheritAIOperationalConfig(branch.definition,campaign.definition);
      const blockers=['AI_RUNTIME_NOT_IMPLEMENTED','AI_APPROVED_TOOLS_NOT_IMPLEMENTED','AI_FOLLOWUP_POLICY_NOT_IMPLEMENTED','AI_SIMULATION_NOT_IMPLEMENTED'];
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
      const qualification=(await tx`SELECT version,definition FROM ai_qualification_config WHERE campaign_id=${id} FOR SHARE`)[0] ?? { version:0,definition:emptyQualification() };
      const fieldIds=[...new Set((qualification.definition.questions as { fieldId:string|null }[]).flatMap((q)=>q.fieldId ? [q.fieldId] : []))];
      const fieldVersions=[];
      if(qualification.definition.enabled) {
        const fields=await tx`SELECT f.id,f.field_type,f.options,f.validation,f.version AS definition_version,cf.version AS binding_version FROM campaign_field cf JOIN field_definition f ON f.id=cf.field_id
          WHERE cf.campaign_id=${id} AND f.id IN ${tx(fieldIds.length ? fieldIds : ['00000000-0000-0000-0000-000000000000'])} AND cf.active AND cf.usable_by_ai AND f.active AND f.value_mode='MANUAL' AND f.organization_id=${actor.organizationId}
          AND (f.branch_id IS NULL OR f.branch_id=${b.id}) AND (f.campaign_id IS NULL OR f.campaign_id=${id}) ORDER BY f.id FOR SHARE OF f,cf`;
        if(fields.length!==fieldIds.length)blockers.push('AI_QUALIFICATION_FIELD_UNAVAILABLE');
        for(const f of fields)fieldVersions.push({ id:f.id,definition_version:f.definition_version,binding_version:f.binding_version });
        for(const rule of [...qualification.definition.completion.conditions,...qualification.definition.handoff.conditions])if(rule.operator==='EQUALS') {
          const fid=qualification.definition.questions.find((q:{ id:string })=>q.id===rule.questionId)?.fieldId,f=fields.find((f)=>f.id===fid);
          if(f)try { validateFieldValue(f.field_type as FieldType,rule.value,f.options as FieldOption[],f.validation as FieldValidation); }catch { if(!blockers.includes('AI_QUALIFICATION_CONDITION_INVALID'))blockers.push('AI_QUALIFICATION_CONDITION_INVALID'); }
        }
      }
      const target=effective.handoffTargetId ? (await tx`SELECT id,name,role FROM user_account WHERE id=${effective.handoffTargetId} AND branch_id=${b.id} AND organization_id=${actor.organizationId} AND active AND role IN ('AGENT','MANAGER') FOR SHARE`)[0] ?? null : null;
      if(!target)blockers.push(effective.handoffTargetId ? 'AI_HANDOFF_TARGET_UNAVAILABLE' : 'AI_HANDOFF_TARGET_REQUIRED');
      if(target?.role==='AGENT' && !(await tx`SELECT 1 FROM campaign_agent WHERE campaign_id=${id} AND agent_id=${target.id} AND active FOR SHARE`).length)blockers.push('AI_HANDOFF_AGENT_NOT_ELIGIBLE');
      const sender=await resolveConfiguredSender(tx,{ organizationId:actor.organizationId,branchId:b.id,campaignId:id });if(!sender.sender)blockers.push('AI_MESSAGING_SENDER_UNAVAILABLE');
      const snapshot={ schema:1,organizationId:actor.organizationId,branchId:b.id,campaignId:id,globalGuardrails:globalAIGuardrails,
        branchDefaults:{ version:branch.version,definition:branch.definition },campaignOverrides:{ version:campaign.version,definition:campaign.definition },effective,sources,profiles,
        campaignVersion:c.version,campaignAIEnabled:c.ai_config.enabled===true,branchActive:b.active,knowledge,qualification:{ ...qualification,fieldVersions },handoffTarget:target,
        messaging:{ timezone:b.timezone,branchPolicyVersion:b.messaging_policy_version,campaignPolicyVersion:c.version,window:c.messaging_policy?.sendingWindow ?? (b.messaging_window?.start ? b.messaging_window : null),maxAttempts:c.messaging_policy?.maxAttempts ?? null,minIntervalSeconds:c.messaging_policy?.minIntervalSeconds ?? null,
          newConversationSender:sender.sender ?? null,resolutionReason:sender.reason,consentRequired:true },allowedTools:[],blockers };
      return { ...snapshot,hash:effectiveConfigHash(snapshot),previewOnly:true,assistantReady:false,inferenceVerified:false };
    });
  });
}
