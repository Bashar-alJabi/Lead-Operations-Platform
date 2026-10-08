import { createHash,randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest } from '../security.js';
import { knowledgeCampaign } from './ai-knowledge.js';
import { configuredMediaStorage,type MediaStorage } from '../media/storage.js';
import { MediaError } from '../media/validation.js';
import { knowledgeAssetTypes,knowledgeAssetMaxBytes,validateKnowledgeAsset } from '../ai/knowledge-assets.js';

const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
const assetParams={ type:'object',additionalProperties:false,required:['id','assetId'],properties:{ id:uuid,assetId:uuid } } as const;
const columns='a.id,a.label,a.mime_type,a.size_bytes,a.content_sha256,a.state,a.version,a.attempt_count,a.error_code,a.scanner_version,a.scanned_at,a.created_at,p.decision,p.reason AS approval_reason,p.actor_id AS approved_by,p.created_at AS approved_at';
export function registerAIKnowledgeAssetRoutes(app:FastifyInstance,db:Database,storageOption?:MediaStorage) {
  const root='/api/ai/campaigns/:id/knowledge/assets',uploading=new Set<string>();
  app.register(async(scope)=> {
    scope.addContentTypeParser('application/octet-stream',{ parseAs:'buffer' },(_r,body,done)=>done(null,body));
    scope.addHook('onRequest',async(request)=> {
      const actor=await principalFromRequest(request,db),{ id }=request.params as { id:string };
      if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new HttpError(400,'INVALID_REQUEST');
      await db.begin((tx)=>knowledgeCampaign(tx,actor,id,request,true));
      if(uploading.size>=2)throw new HttpError(429,'KNOWLEDGE_UPLOAD_BUSY');uploading.add(request.id);
    });scope.addHook('onResponse',async(request)=>{ uploading.delete(request.id); });
    scope.post<{ Params:{ id:string };Querystring:{ label:string;mime:string;key:string } }>(root,{
      bodyLimit:knowledgeAssetMaxBytes(),config:{ rateLimit:{ max:10,timeWindow:'1 minute' } },schema:{ params,querystring:{ type:'object',additionalProperties:false,required:['label','mime','key'],properties:{
        label:{ type:'string',minLength:1,maxLength:200,pattern:'^[^\\x00-\\x1f\\x7f]+$' },mime:{ type:'string',enum:knowledgeAssetTypes },key:uuid,
      } } },
    },async(request,reply)=> {
      const actor=await principalFromRequest(request,db),bytes=request.body,{ label,mime,key }=request.query;
      if(!Buffer.isBuffer(bytes) || !label.trim())throw new HttpError(400,'KNOWLEDGE_UPLOAD_INVALID');
      const hash=createHash('sha256').update(bytes).digest('hex');
      const compare=(a:Record<string,unknown>)=> { if(a.content_sha256!==hash || a.mime_type!==mime || a.label!==label.trim())throw new HttpError(409,'KNOWLEDGE_UPLOAD_KEY_REUSED');return { id:a.id,state:a.state,version:a.version }; };
      const old=(await db`SELECT * FROM ai_knowledge_asset WHERE campaign_id=${request.params.id} AND uploaded_by=${actor.id} AND upload_key=${key}`)[0];if(old)return compare(old);
      await validateKnowledgeAsset(bytes,mime).catch((e:unknown)=>{ throw new HttpError(400,e instanceof MediaError ? e.code : 'KNOWLEDGE_ASSET_INVALID'); });
      const id=randomUUID(),objectKey=id+'-'+hash;let storage:MediaStorage;
      try { storage=storageOption ?? configuredMediaStorage();await storage.put(objectKey,bytes); }catch { throw new HttpError(503,'KNOWLEDGE_STORAGE_UNAVAILABLE'); }
      // A DB error can have an uncertain commit outcome. Never delete a referenced object; leave unknown orphans for documented housekeeping.
      const result=await db.begin(async(tx)=> {
        const { sessionId }=await knowledgeCampaign(tx,actor,request.params.id,request,true);
        const existing=(await tx`SELECT * FROM ai_knowledge_asset WHERE campaign_id=${request.params.id} AND uploaded_by=${actor.id} AND upload_key=${key}`)[0];if(existing)return { value:compare(existing),created:false };
        const a=(await tx`INSERT INTO ai_knowledge_asset(id,campaign_id,uploaded_by,session_id,upload_key,label,mime_type,content_sha256,size_bytes,storage_key,storage_backend)
          VALUES (${id},${request.params.id},${actor.id},${sessionId},${key},${label.trim()},${mime},${hash},${bytes.length},${objectKey},${storage.backend}) RETURNING *`)[0]!;
        return { value:compare(a),created:true };
      }).catch(async(e:unknown)=> { if(e instanceof HttpError && !(await db`SELECT 1 FROM ai_knowledge_asset WHERE storage_key=${objectKey}`).length)await storage.remove(objectKey).catch(()=>{});throw e; });
      if(!result.created)await storage.remove(objectKey).catch(()=>{});reply.code(result.created ? 201 : 200);return result.value;
    });
  });
  app.get<{ Params:{ id:string };Querystring:{ after?:string;limit?:number } }>(root,{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ after:uuid,limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await knowledgeCampaign(tx,actor,request.params.id,request);const limit=request.query.limit ?? 20;
      const rows=await tx`SELECT ${tx.unsafe(columns)} FROM ai_knowledge_asset a LEFT JOIN ai_knowledge_asset_approval p ON p.asset_id=a.id
        WHERE a.campaign_id=${request.params.id} AND (${request.query.after ?? null}::uuid IS NULL OR a.id>${request.query.after ?? null}::uuid) ORDER BY a.id LIMIT ${limit+1}`;
      return { items:rows.slice(0,limit),nextId:rows.length>limit ? rows[limit-1]!.id : null,acceptedTypes:knowledgeAssetTypes,maxBytes:knowledgeAssetMaxBytes(),textMaxBytes:32768 };
    });
  });
  app.post<{ Params:{ id:string;assetId:string };Body:{ decision:'APPROVED'|'REJECTED';version:number;reason:string } }>(root+'/:assetId/review',{
    schema:{ params:assetParams,body:{ type:'object',additionalProperties:false,required:['decision','version','reason'],properties:{ decision:{ type:'string',enum:['APPROVED','REJECTED'] },version:{ type:'integer',minimum:1 },reason:{ type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$' } } } },
  },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const { sessionId }=await knowledgeCampaign(tx,actor,request.params.id,request,true);
      const a=(await tx`SELECT * FROM ai_knowledge_asset WHERE id=${request.params.assetId} AND campaign_id=${request.params.id} FOR UPDATE`)[0];if(!a)throw new HttpError(404,'KNOWLEDGE_ASSET_NOT_FOUND');
      if(a.version!==request.body.version || a.state!=='REVIEW')throw new HttpError(409,'KNOWLEDGE_ASSET_NOT_REVIEWABLE');
      const reason=request.body.reason.trim();if(reason.length<3)throw new HttpError(400,'KNOWLEDGE_REVIEW_REASON_REQUIRED');
      const prior=(await tx`SELECT * FROM ai_knowledge_asset_approval WHERE asset_id=${a.id}`)[0];
      if(prior){ if(prior.actor_id!==actor.id || prior.reason!==reason || prior.decision!==request.body.decision)throw new HttpError(409,'KNOWLEDGE_REVIEW_ALREADY_DECIDED');return { decision:prior.decision }; }
      await tx`INSERT INTO ai_knowledge_asset_approval(asset_id,decision,actor_id,session_id,reason) VALUES (${a.id},${request.body.decision},${actor.id},${sessionId},${reason})`;reply.code(201);return { decision:request.body.decision };
    });
  });
  app.get<{ Params:{ id:string;assetId:string } }>(root+'/:assetId',{ schema:{ params:assetParams } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await knowledgeCampaign(tx,actor,request.params.id,request);
      const a=(await tx`SELECT ${tx.unsafe(columns)},a.extracted_text FROM ai_knowledge_asset a LEFT JOIN ai_knowledge_asset_approval p ON p.asset_id=a.id WHERE a.id=${request.params.assetId} AND a.campaign_id=${request.params.id}`)[0];
      if(!a)throw new HttpError(404,'KNOWLEDGE_ASSET_NOT_FOUND');return a;
    });
  });
  app.get<{ Params:{ id:string;assetId:string };Querystring:{ before?:number;limit?:number } }>(root+'/:assetId/history',{
    schema:{ params:assetParams,querystring:{ type:'object',additionalProperties:false,properties:{ before:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await knowledgeCampaign(tx,actor,request.params.id,request);
      if(!(await tx`SELECT 1 FROM ai_knowledge_asset WHERE id=${request.params.assetId} AND campaign_id=${request.params.id}`).length)throw new HttpError(404,'KNOWLEDGE_ASSET_NOT_FOUND');
      const limit=request.query.limit ?? 20,rows=await tx`SELECT version,created_at,snapshot->>'state' AS state,snapshot->>'attempt_count' AS attempt,snapshot->>'error_code' AS error_code FROM ai_knowledge_asset_history WHERE asset_id=${request.params.assetId} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;
      return { items:rows.slice(0,limit),nextVersion:rows.length>limit ? rows[limit-1]!.version : null };
    });
  });
  app.get<{ Params:{ id:string;assetId:string } }>(root+'/:assetId/download',{ schema:{ params:assetParams } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);
    const read=()=>db.begin(async(tx)=> {
      await knowledgeCampaign(tx,actor,request.params.id,request);
      const a=(await tx`SELECT a.*,p.decision FROM ai_knowledge_asset a LEFT JOIN ai_knowledge_asset_approval p ON p.asset_id=a.id WHERE a.id=${request.params.assetId} AND a.campaign_id=${request.params.id} FOR SHARE OF a`)[0];
      if(!a)throw new HttpError(404,'KNOWLEDGE_ASSET_NOT_FOUND');if(a.state!=='REVIEW' || a.decision==='REJECTED')throw new HttpError(409,'KNOWLEDGE_ASSET_NOT_SAFE');return a;
    });
    const a=await read();let bytes:Buffer;
    try { const storage=storageOption ?? configuredMediaStorage();if(storage.backend!==a.storage_backend)throw new Error();bytes=await storage.get(a.storage_key,knowledgeAssetMaxBytes());
      if(bytes.length!==a.size_bytes || createHash('sha256').update(bytes).digest('hex')!==a.content_sha256)throw new Error();
    }catch { throw new HttpError(503,'KNOWLEDGE_STORAGE_INTEGRITY_FAILED'); }
    await read(); // Current authorization and review state again after storage I/O.
    const ext=({ 'text/plain':'txt','application/pdf':'pdf','image/png':'png','image/jpeg':'jpg' } as Record<string,string>)[a.mime_type];
    return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"sandbox; default-src 'none'")
      .header('Content-Disposition',`attachment; filename="knowledge-${a.id}.${ext}"`).type(a.mime_type).send(bytes);
  });
}
