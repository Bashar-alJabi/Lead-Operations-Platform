import type postgres from 'postgres';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,requireRole,type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { emptyKnowledge,knowledgeContentSchema,knowledgeHasContent,normalizeKnowledge,type KnowledgeContent } from '../ai/knowledge.js';
const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
const reason={ type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$' } as const;
export async function knowledgeCampaign(tx:postgres.TransactionSql,actor:Principal,id:string,request:FastifyRequest,write=false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const initial=(await tx`SELECT c.id,c.branch_id FROM campaign c WHERE c.id=${id} AND c.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})`)[0];
  if(!initial)throw new HttpError(404,'CAMPAIGN_NOT_FOUND');
  const b=(await tx`SELECT active FROM branch WHERE id=${initial.branch_id} FOR SHARE`)[0]!;
  const c=(await tx`SELECT c.* FROM campaign c WHERE c.id=${id} AND c.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId}) ${write ? tx`FOR UPDATE` : tx`FOR SHARE`}`)[0];
  if(!c)throw new HttpError(404,'CAMPAIGN_NOT_FOUND');const sessionId=await currentPaymentSession(tx,actor,request);if(!sessionId)throw new HttpError(403,'AI_KNOWLEDGE_ACCESS_REVOKED');
  if(write && !b.active)throw new HttpError(409,'BRANCH_DISABLED');return { c,sessionId };
}
const campaign=knowledgeCampaign;
async function assetReferences(tx:postgres.TransactionSql,id:string,content:KnowledgeContent) {
  const assets=[];
  for(const assetId of [...(content.assets ?? [])].sort()) {
    const row=(await tx`SELECT ai_knowledge_asset_manifest(a,p) AS snapshot FROM ai_knowledge_asset a JOIN ai_knowledge_asset_approval p ON p.asset_id=a.id
      WHERE a.id=${assetId} AND a.campaign_id=${id} AND a.state='REVIEW' AND p.decision='APPROVED' FOR SHARE OF a,p`)[0];
    if(!row)throw new HttpError(409,'AI_KNOWLEDGE_ASSET_APPROVAL_REQUIRED');assets.push(row.snapshot);
  }return assets;
}
const publicationColumns=(tx:postgres.TransactionSql)=>tx`version,draft_version,content,reason,published_by,published_at,
  (SELECT COALESCE(jsonb_agg(m.snapshot ORDER BY m.asset_id),'[]') FROM ai_knowledge_publication_asset m WHERE m.campaign_id=ai_knowledge_publication.campaign_id AND m.version=ai_knowledge_publication.version) AS assets`;
export function registerAIKnowledgeRoutes(app:FastifyInstance,db:Database) {
  const root='/api/ai/campaigns/:id/knowledge';
  app.get<{ Params:{ id:string } }>(root,{ schema:{ params } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await campaign(tx,actor,request.params.id,request);const draft=(await tx`SELECT version,content,actor_id,reason,updated_at FROM ai_knowledge_draft WHERE campaign_id=${request.params.id}`)[0] ?? { version:0,content:emptyKnowledge(),actor_id:null,reason:null,updated_at:null };
      const published=(await tx`SELECT ${publicationColumns(tx)} FROM ai_knowledge_publication WHERE campaign_id=${request.params.id} ORDER BY version DESC LIMIT 1`)[0] ?? null;
      return { draft,published,assistantReady:false,assetsImplemented:true };
    });
  });
  app.put<{ Params:{ id:string };Body:{ version:number;content:KnowledgeContent;reason:string } }>(root+'/draft',{
    bodyLimit:131072,schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','content','reason'],properties:{ version:{ type:'integer',minimum:0 },content:knowledgeContentSchema,reason } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db),content=normalizeKnowledge(request.body.content);if(request.body.reason.trim().length<3)throw new HttpError(400,'AI_KNOWLEDGE_REASON_REQUIRED');
    return db.begin(async(tx)=> {
      const { sessionId }=await campaign(tx,actor,request.params.id,request,true);
      await assetReferences(tx,request.params.id,content);
      const current=(await tx`SELECT version FROM ai_knowledge_draft WHERE campaign_id=${request.params.id} FOR UPDATE`)[0];if((current?.version ?? 0)!==request.body.version)throw new HttpError(409,'AI_KNOWLEDGE_VERSION_CONFLICT');
      const row=current ? (await tx`UPDATE ai_knowledge_draft SET version=version+1,content=${tx.json(content)},actor_id=${actor.id},session_id=${sessionId},reason=${request.body.reason.trim()},updated_at=clock_timestamp() WHERE campaign_id=${request.params.id} RETURNING version`)[0]
        : (await tx`INSERT INTO ai_knowledge_draft(campaign_id,version,content,actor_id,session_id,reason) VALUES (${request.params.id},1,${tx.json(content)},${actor.id},${sessionId},${request.body.reason.trim()}) RETURNING version`)[0];return row;
    });
  });
  app.post<{ Params:{ id:string };Body:{ version:number;content:KnowledgeContent } }>(root+'/preview',{
    bodyLimit:131072,schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','content'],properties:{ version:{ type:'integer',minimum:0 },content:knowledgeContentSchema } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await campaign(tx,actor,request.params.id,request);const current=(await tx`SELECT version FROM ai_knowledge_draft WHERE campaign_id=${request.params.id}`)[0];if((current?.version ?? 0)!==request.body.version)throw new HttpError(409,'AI_KNOWLEDGE_VERSION_CONFLICT');
      const content=normalizeKnowledge(request.body.content),assets=await assetReferences(tx,request.params.id,content);return { content,assets,publishable:knowledgeHasContent(content),previewOnly:true,assistantReady:false };
    });
  });
  app.post<{ Params:{ id:string };Body:{ version:number;requestId:string;reason:string } }>(root+'/publish',{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','requestId','reason'],properties:{ version:{ type:'integer',minimum:1 },requestId:uuid,reason } } },
  },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);if(request.body.reason.trim().length<3)throw new HttpError(400,'AI_KNOWLEDGE_REASON_REQUIRED');
    const result=await db.begin(async(tx)=> {
      const { sessionId }=await campaign(tx,actor,request.params.id,request,true);
      const old=(await tx`SELECT ${publicationColumns(tx)} FROM ai_knowledge_publication WHERE campaign_id=${request.params.id} AND request_id=${request.body.requestId}`)[0];
      if(old) { if(old.draft_version!==request.body.version || old.reason!==request.body.reason.trim())throw new HttpError(409,'AI_KNOWLEDGE_IDEMPOTENCY_CONFLICT');return { row:old,created:false }; }
      const draft=(await tx`SELECT * FROM ai_knowledge_draft WHERE campaign_id=${request.params.id} FOR SHARE`)[0];if(!draft || draft.version!==request.body.version)throw new HttpError(409,'AI_KNOWLEDGE_VERSION_CONFLICT');
      await assetReferences(tx,request.params.id,draft.content);
      if(!knowledgeHasContent(normalizeKnowledge(draft.content)))throw new HttpError(409,'AI_KNOWLEDGE_EMPTY_PUBLICATION');
      if((await tx`SELECT 1 FROM ai_knowledge_publication WHERE campaign_id=${request.params.id} AND draft_version=${draft.version}`).length)throw new HttpError(409,'AI_KNOWLEDGE_DRAFT_ALREADY_PUBLISHED');
      const next=(await tx`SELECT COALESCE(max(version),0)+1 AS version FROM ai_knowledge_publication WHERE campaign_id=${request.params.id}`)[0]!.version;
      await tx`INSERT INTO ai_knowledge_publication(campaign_id,version,draft_version,content,request_id,published_by,session_id,reason)
        VALUES (${request.params.id},${next},${draft.version},${tx.json(draft.content)},${request.body.requestId},${actor.id},${sessionId},${request.body.reason.trim()})`;
      const row=(await tx`SELECT ${publicationColumns(tx)} FROM ai_knowledge_publication WHERE campaign_id=${request.params.id} AND version=${next}`)[0]!;return { row,created:true };
    });if(result.created)reply.code(201);return result.row;
  });
  for(const kind of ['history','revisions'] as const)app.get<{ Params:{ id:string };Querystring:{ before?:number;limit?:number } }>(root+'/'+kind,{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ before:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await campaign(tx,actor,request.params.id,request);const limit=request.query.limit ?? 20;
      // Content is fetched separately per chosen version, not repeated across a history page.
      const rows=kind==='history' ? await tx`SELECT version,draft_version,published_by AS actor_id,reason,published_at AS created_at FROM ai_knowledge_publication WHERE campaign_id=${request.params.id} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit+1}`
        : await tx`SELECT version,actor_id,reason,created_at FROM ai_knowledge_revision WHERE campaign_id=${request.params.id} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;
      return { items:rows.slice(0,limit),nextVersion:rows.length>limit ? rows[limit-1]!.version : null };
    });
  });
  app.get<{ Params:{ id:string;version:number } }>(root+'/versions/:version',{
    schema:{ params:{ type:'object',additionalProperties:false,required:['id','version'],properties:{ id:uuid,version:{ type:'integer',minimum:1 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> { await campaign(tx,actor,request.params.id,request);const p=(await tx`SELECT ${publicationColumns(tx)} FROM ai_knowledge_publication WHERE campaign_id=${request.params.id} AND version=${request.params.version}`)[0];if(!p)throw new HttpError(404,'AI_KNOWLEDGE_VERSION_NOT_FOUND');return p; });
  });
}
