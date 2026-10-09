import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { approvedHumanCampaignKnowledge } from '../ai/approved-knowledge.js';
import { configuredMediaStorage,type MediaStorage } from '../media/storage.js';
import { knowledgeAssetMaxBytes } from '../ai/knowledge-assets.js';
const uuid={ type:'string',format:'uuid' } as const,params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
export function registerAICopilotKnowledgeRoutes(app:FastifyInstance,db:Database,storageOption?:MediaStorage) {
  const root='/api/conversations/:id/ai-campaign-knowledge';
  app.get<{ Params:{ id:string } }>(root,{ schema:{ params } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'AI_COPILOT_ACCESS_REVOKED');
      const s=await approvedHumanCampaignKnowledge(tx,actor,request.params.id,session);
      await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES (${actor.organizationId},${s.access.b.id},${actor.id},'AI_COPILOT_PUBLISHED_KNOWLEDGE_READ','CONVERSATION',${request.params.id},${tx.json({ leadId:s.access.lead.id,campaignId:s.access.c.id,knowledgeVersion:s.publication.version,knowledgeHash:s.hash })})`;
      return { tool:'getCampaignKnowledge',version:s.publication.version,publishedAt:s.publication.published_at,hash:s.hash,content:s.publication.content,
        assets:s.assets.map(a=>({ id:a.id,label:a.snapshot.label,mimeType:a.snapshot.mime,sizeBytes:a.snapshot.sizeBytes,extractedText:a.snapshot.extractedText })),readOnly:true,providerInvoked:false,sendAllowed:false,mutationsAllowed:false };
    });
  });
  app.get<{ Params:{ id:string;assetId:string };Querystring:{ version:number } }>(root+'/assets/:assetId/download',{ schema:{ params:{ ...params,required:['id','assetId'],properties:{ id:uuid,assetId:uuid } },querystring:{ type:'object',additionalProperties:false,required:['version'],properties:{ version:{ type:'integer',minimum:1 } } } } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);
    const read=(audit=false)=>db.begin(async(tx)=> {
      const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'AI_COPILOT_ACCESS_REVOKED');const s=await approvedHumanCampaignKnowledge(tx,actor,request.params.id,session);
      if(s.publication.version!==request.query.version)throw new HttpError(409,'AI_PUBLISHED_KNOWLEDGE_CHANGED');
      const manifest=s.assets.find(a=>a.id===request.params.assetId);if(!manifest)throw new HttpError(404,'KNOWLEDGE_ASSET_NOT_FOUND');
      const a=(await tx`SELECT a.*,p.decision FROM ai_knowledge_asset a JOIN ai_knowledge_asset_approval p ON p.asset_id=a.id WHERE a.id=${manifest.id} AND a.campaign_id=${s.access.c.id} FOR SHARE OF a,p`)[0];
      if(!a || a.state!=='REVIEW' || a.decision!=='APPROVED' || a.content_sha256!==manifest.snapshot.sha256 || a.size_bytes!==manifest.snapshot.sizeBytes || a.mime_type!==manifest.snapshot.mime)throw new HttpError(409,'KNOWLEDGE_ASSET_NOT_SAFE');
      if(audit)await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES (${actor.organizationId},${s.access.b.id},${actor.id},'AI_COPILOT_PUBLISHED_ASSET_DOWNLOAD','CONVERSATION',${request.params.id},${tx.json({ leadId:s.access.lead.id,campaignId:s.access.c.id,assetId:a.id,knowledgeVersion:s.publication.version,knowledgeHash:s.hash })})`;
      return a;
    });
    const a=await read();let bytes:Buffer;
    try { const storage=storageOption ?? configuredMediaStorage();if(storage.backend!==a.storage_backend)throw new Error();bytes=await storage.get(a.storage_key,knowledgeAssetMaxBytes());
      if(bytes.length!==a.size_bytes || createHash('sha256').update(bytes).digest('hex')!==a.content_sha256)throw new Error();
    }catch { throw new HttpError(503,'KNOWLEDGE_STORAGE_INTEGRITY_FAILED'); }
    await read(true); // Recheck current owner/session/controller/publication/approval after storage I/O, before returning bytes.
    const ext=({ 'text/plain':'txt','application/pdf':'pdf','image/png':'png','image/jpeg':'jpg' } as Record<string,string>)[a.mime_type];
    return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"sandbox; default-src 'none'")
      .header('Content-Disposition',`attachment; filename="knowledge-${a.id}.${ext}"`).type(a.mime_type).send(bytes);
  });
}
