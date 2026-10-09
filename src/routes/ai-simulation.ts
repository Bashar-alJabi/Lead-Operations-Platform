import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import type postgres from 'postgres';
import { HttpError,principalFromRequest } from '../security.js';
import { knowledgeCampaign } from './ai-knowledge.js';
import { aiConfigurationBranch } from '../ai/configuration-access.js';
import { effectiveCampaignContext } from '../ai/effective-context.js';
import { effectiveConfigHash } from '../ai/operational-config.js';
import { simulationQuestion } from '../ai/simulation.js';
const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
export function registerAISimulationRoutes(app:FastifyInstance,db:Database) {
  const root='/api/ai/campaigns/:id/simulations';
  app.post<{ Params:{ id:string };Body:{ requestId:string;expectedHash:string;question:string } }>(root,{ bodyLimit:32768,schema:{ params,body:{ type:'object',additionalProperties:false,required:['requestId','expectedHash','question'],properties:{ requestId:uuid,expectedHash:{ type:'string',pattern:'^[a-f0-9]{64}$' },question:{ type:'string',minLength:1,maxLength:4000 } } } } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db),question=simulationQuestion(request.body.question);
    const requestHash=effectiveConfigHash({ expectedHash:request.body.expectedHash,question });
    const result=await db.begin(async(tx)=> {
      const { c,sessionId }=await knowledgeCampaign(tx,actor,request.params.id,request,true),{ b }=await aiConfigurationBranch(tx,actor,c.branch_id,request,true);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'ai-simulation:'+c.id+':'+actor.id},0))`;
      const duplicate=(await tx`SELECT id,request_hash,state,version FROM ai_campaign_simulation WHERE campaign_id=${c.id} AND actor_id=${actor.id} AND request_id=${request.body.requestId}`)[0];
      if(duplicate){ if(duplicate.request_hash!==requestHash)throw new HttpError(409,'AI_SIMULATION_IDEMPOTENCY_CONFLICT');return { id:duplicate.id,state:duplicate.state,version:duplicate.version,duplicate:true }; }
      const context=await effectiveCampaignContext(tx,actor.organizationId,c,b);
      if(context.hash!==request.body.expectedHash)throw new HttpError(409,'AI_SIMULATION_CONTEXT_CHANGED');
      if(!context.knowledge)throw new HttpError(409,'AI_PUBLISHED_KNOWLEDGE_REQUIRED');
      if(!context.profiles.CONVERSATION || !(context.profiles.CONVERSATION as { available:boolean }).available)throw new HttpError(409,'AI_CONVERSATION_PROFILE_REQUIRED');
      if(!context.effective.language)throw new HttpError(409,'AI_LANGUAGE_REQUIRED');
      if((await tx`SELECT count(*)::integer AS n FROM ai_campaign_simulation WHERE campaign_id=${c.id} AND actor_id=${actor.id} AND state IN ('QUEUED','RUNNING')`)[0]!.n>=10)throw new HttpError(429,'AI_SIMULATION_QUEUE_FULL');
      const row=(await tx`INSERT INTO ai_campaign_simulation(organization_id,branch_id,campaign_id,actor_id,session_id,request_id,request_hash,question,context,context_hash,references_json)
        VALUES (${actor.organizationId},${b.id},${c.id},${actor.id},${sessionId},${request.body.requestId},${requestHash},${question},${tx.json(context as unknown as postgres.JSONValue)},${context.hash},'[]') RETURNING id,state,version`)[0]!;
      return { ...row,duplicate:false };
    });return reply.code(result.duplicate ? 200 : 202).send(result);
  });
  app.get<{ Params:{ id:string };Querystring:{ before?:string;limit?:number } }>(root,{ schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ before:uuid,limit:{ type:'integer',minimum:1,maximum:50 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await knowledgeCampaign(tx,actor,request.params.id,request);const limit=request.query.limit ?? 10;
      const cursor=request.query.before ? (await tx`SELECT created_at,id FROM ai_campaign_simulation WHERE campaign_id=${request.params.id} AND id=${request.query.before}`)[0] : null;
      if(request.query.before && !cursor)throw new HttpError(404,'AI_SIMULATION_NOT_FOUND');
      const rows=await tx`SELECT id,state,version,attempt_count,error_code,question,created_at,context->'knowledge'->'version' AS knowledge_version FROM ai_campaign_simulation WHERE campaign_id=${request.params.id}
        AND (${cursor?.id ?? null}::uuid IS NULL OR (created_at,id)<(${cursor?.created_at ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;
      return { items:rows.slice(0,limit),nextBefore:rows.length>limit ? rows[limit-1]!.id : null };
    });
  });
  app.get<{ Params:{ id:string;simulationId:string } }>(root+'/:simulationId',{ schema:{ params:{ ...params,required:['id','simulationId'],properties:{ id:uuid,simulationId:uuid } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await knowledgeCampaign(tx,actor,request.params.id,request);
      const s=(await tx`SELECT id,state,version,attempt_count,error_code,question,result,context_hash,context->>'hash' AS configuration_hash,
        context->'knowledge'->'version' AS knowledge_version,context->'branchDefaults'->'version' AS branch_defaults_version,context->'campaignOverrides'->'version' AS campaign_overrides_version,
        context->'behavior'->'branchVersion' AS branch_behavior_version,context->'behavior'->'campaignVersion' AS campaign_behavior_version,
        context->'qualification'->'version' AS qualification_version,context->'followup'->'version' AS followup_version,
        context->'profiles'->'CONVERSATION' AS profile,created_at,updated_at FROM ai_campaign_simulation WHERE campaign_id=${request.params.id} AND id=${request.params.simulationId}`)[0];
      if(!s)throw new HttpError(404,'AI_SIMULATION_NOT_FOUND');
      // Historical trace is retained; a revoked shared grant does not restore current catalog access.
      if(s.profile?.id && !(await tx`SELECT ai_operational_profile_usable(${actor.role==='SUPER_ADMIN' ? (await tx`SELECT branch_id FROM campaign WHERE id=${request.params.id}`)[0]!.branch_id : actor.branchId},${s.profile.id},'CONVERSATION') AS usable`)[0]!.usable)s.profile={ id:s.profile.id,available:false };
      const history=await tx`SELECT version,state,attempt_count,error_code,created_at FROM ai_simulation_history WHERE simulation_id=${s.id} ORDER BY version`;
      return { ...s,history,simulationOnly:true,sendAllowed:false,mutationsAllowed:false,liveVerification:'LIVE_VERIFICATION_PENDING_EXTERNAL_CREDENTIAL_APPROVAL' };
    });
  });
}
