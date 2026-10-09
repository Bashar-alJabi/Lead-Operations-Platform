import type postgres from 'postgres';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,type Principal } from '../security.js';
import { aiConfigurationBranch as branchAccess } from '../ai/configuration-access.js';
import { knowledgeCampaign } from './ai-knowledge.js';
import { aiTasks,aiOperationalSchema,normalizeAIOperationalConfig,type AIOperationalConfig } from '../ai/operational-config.js';
import { currentAIOperationalConfig as current,effectiveCampaignContext } from '../ai/effective-context.js';
const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
const page={ type:'object',additionalProperties:false,properties:{ before:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } as const;
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
      return effectiveCampaignContext(tx,actor.organizationId,c,b);
    });
  });
}
