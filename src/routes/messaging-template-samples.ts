import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireRole, type Principal } from '../security.js';
import { configuredMediaStorage, type MediaStorage } from '../media/storage.js';
import { configuredMediaScanner, type MediaScanner } from '../media/scanner.js';
import { MediaError, mediaMaxBytes, mediaMimeTypes, validateMedia } from '../media/validation.js';
import { metaMediaCapabilities, metaMediaProfile, validateMetaOutboundMedia } from '../media/meta-outbound.js';
import type { TemplateSampleKind } from '../media/template-sample-provider.js';

const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:{ type:'string',format:'uuid' } } } as const;
async function managedConnection(db:Database,actor:Principal,id:string) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const row=(await db`SELECT id,organization_id,branch_id,status,version FROM integration_connection
    WHERE id=${id} AND organization_id=${actor.organizationId} AND kind='MESSAGING' AND provider='META_WHATSAPP_CLOUD'
      AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId})`)[0];
  if (!row) throw new HttpError(404,'MESSAGING_CONNECTION_NOT_FOUND');return row;
}
function publicSample(row:Record<string,unknown>,connectionVersion:unknown,enabled=true) {
  return { id:row.id,kind:row.media_kind,mime:row.mime_type,sizeBytes:row.size_bytes,state:row.state,
    version:row.version,attemptCount:row.attempt_count,errorCode:row.last_error_code,createdAt:row.created_at,
    usable:enabled && row.state==='READY' && row.connection_version===connectionVersion };
}
async function authorizedSample(db:Database,actor:Principal,id:string) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const row=(await db`SELECT s.*,c.organization_id,c.branch_id,c.version AS current_connection_version,c.status AS connection_status
    FROM messaging_template_sample s JOIN integration_connection c ON c.id=s.connection_id
    WHERE s.id=${id} AND c.organization_id=${actor.organizationId}
      AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})`)[0];
  if (!row) throw new HttpError(404,'TEMPLATE_SAMPLE_NOT_FOUND');return row;
}
export function registerMessagingTemplateSampleRoutes(app:FastifyInstance,db:Database,storageOption?:MediaStorage,scannerOption?:MediaScanner) {
  const uploading=new Set<string>();
  app.register(async(scope)=> {
    scope.addContentTypeParser('application/octet-stream',{ parseAs:'buffer' },(_request,body,done)=>done(null,body));
    scope.addHook('onRequest',async(request)=> {
      const actor=await principalFromRequest(request,db);const { id }=request.params as { id:string };
      if (typeof id!=='string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400,'INVALID_REQUEST');
      const connection=await managedConnection(db,actor,id);
      if (connection.status==='DISABLED') throw new HttpError(409,'CONNECTION_DISABLED');
      if (uploading.size>=2) throw new HttpError(429,'MEDIA_UPLOAD_BUSY');uploading.add(request.id);
    });
    scope.addHook('onResponse',async(request)=> { uploading.delete(request.id); });
    scope.post<{ Params:{ id:string };Querystring:{ kind:TemplateSampleKind;mime:string;key:string } }>(
      '/api/messaging/connections/:id/template-samples',{ bodyLimit:mediaMaxBytes(),schema:{ params,querystring:{
        type:'object',additionalProperties:false,required:['kind','mime','key'],properties:{
          kind:{ type:'string',enum:['image','video','document'] },mime:{ type:'string',maxLength:100 },
          key:{ type:'string',pattern:'^[A-Za-z0-9._:-]{8,128}$' },
        } } },config:{ rateLimit:{ max:10,timeWindow:'1 minute' } } },async(request,reply)=> {
        const actor=await principalFromRequest(request,db);const connection=await managedConnection(db,actor,request.params.id);
        const bytes=request.body;if (!Buffer.isBuffer(bytes)) throw new HttpError(400,'MEDIA_BODY_INVALID');
        const { kind,mime,key }=request.query;
        if (!(mediaMimeTypes[kind] as readonly string[]).includes(mime)) throw new HttpError(400,'MEDIA_TYPE_UNSUPPORTED');
        const hash=createHash('sha256').update(bytes).digest('hex');
        const existing=(await db`SELECT * FROM messaging_template_sample WHERE connection_id=${connection.id}
          AND uploaded_by=${actor.id} AND upload_key=${key}`)[0];
        const compare=(row:Record<string,unknown>)=> {
          if (row.content_sha256!==hash || row.mime_type!==mime || row.media_kind!==kind) throw new HttpError(409,'IDEMPOTENCY_KEY_REUSED');
          return publicSample(row,connection.version);
        };
        if (existing) return compare(existing);
        if (bytes.length>metaMediaProfile.limits[kind]) throw new HttpError(400,'MEDIA_PROVIDER_SIZE_INVALID');
        await validateMedia(bytes,kind,mime,hash).catch((error:unknown)=> {
          throw new HttpError(400,error instanceof MediaError ? error.code : 'MEDIA_TYPE_MISMATCH');
        });
        let scan:{ clean:boolean;version:string };
        try { scan=await (scannerOption ?? configuredMediaScanner()).scan(bytes); }
        catch { throw new HttpError(503,'MEDIA_SCANNER_UNAVAILABLE'); }
        if (!scan.clean) throw new HttpError(422,'MEDIA_CONTENT_REJECTED');
        await validateMetaOutboundMedia(bytes,kind,mime).catch((error:unknown)=> {
          throw new HttpError(error instanceof MediaError && error.retryable ? 503 : 400,error instanceof MediaError ? error.code : 'MEDIA_FORMAT_INVALID');
        });
        const id=randomUUID();const objectKey=`${id}-${hash}`;let storage:MediaStorage;
        try { storage=storageOption ?? configuredMediaStorage();await storage.put(objectKey,bytes); }
        catch { throw new HttpError(503,'MEDIA_STORAGE_UNAVAILABLE'); }
        const removeUnused=async()=> {
          if (!(await db`SELECT 1 FROM messaging_template_sample WHERE storage_key=${objectKey} LIMIT 1`).length) await storage.remove(objectKey);
        };
        const row=await db.begin(async(tx)=> {
          const current=(await tx`SELECT version,status FROM integration_connection WHERE id=${connection.id} FOR UPDATE`)[0]!;
          if (current.version!==connection.version || current.status==='DISABLED') throw new HttpError(409,'CONNECTION_VERSION_CONFLICT');
          // Recheck requester role/scope after scan; the initial session check is insufficient for a long upload.
          const user=(await tx`SELECT active,role,branch_id,organization_id FROM user_account WHERE id=${actor.id} FOR SHARE`)[0];
          if (!user?.active || user.organization_id!==actor.organizationId || (user.role!=='SUPER_ADMIN' && (user.role!=='MANAGER' || user.branch_id!==connection.branch_id)))
            throw new HttpError(403,'FORBIDDEN');
          const created=(await tx`INSERT INTO messaging_template_sample (id,connection_id,connection_version,uploaded_by,requested_by,upload_key,
            media_kind,mime_type,content_sha256,size_bytes,storage_key,storage_backend,scanner_version,scanned_at)
            VALUES (${id},${connection.id},${current.version},${actor.id},${actor.id},${key},${kind},${mime},${hash},${bytes.length},
              ${objectKey},${storage.backend},${scan.version.slice(0,255)},now()) ON CONFLICT DO NOTHING RETURNING *`)[0];
          if (!created) {
            const prior=(await tx`SELECT * FROM messaging_template_sample WHERE connection_id=${connection.id}
              AND uploaded_by=${actor.id} AND upload_key=${key}`)[0]!;compare(prior);return prior;
          }
          await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id)
            VALUES (${actor.organizationId},${connection.branch_id},${actor.id},'TEMPLATE_SAMPLE_UPLOADED','TEMPLATE_SAMPLE',${id})`;
          return created;
        }).catch(async(error:unknown)=> { if (error instanceof HttpError) await removeUnused().catch(()=>{});throw error; });
        if (row.id!==id) await removeUnused().catch(()=>{});reply.code(row.id===id ? 201 : 200);return publicSample(row,connection.version);
      });
  });
  app.get<{ Params:{ id:string };Querystring:{ after?:string;limit?:number } }>('/api/messaging/connections/:id/template-samples',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ after:{ type:'string',format:'uuid' },limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);const connection=await managedConnection(db,actor,request.params.id);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT id,media_kind,mime_type,size_bytes,state,version,attempt_count,last_error_code,created_at,connection_version
      FROM messaging_template_sample WHERE connection_id=${connection.id}
        AND (${request.query.after ?? null}::uuid IS NULL OR id>${request.query.after ?? null}::uuid) ORDER BY id LIMIT ${limit+1}`;
    const page=rows.slice(0,limit);const { mediaRules }=metaMediaCapabilities();
    return { items:page.map((row)=>publicSample(row,connection.version,connection.status!=='DISABLED')),nextAfter:rows.length>limit ? page.at(-1)!.id : null,
      rules:{ image:mediaRules.image,video:mediaRules.video,document:mediaRules.document } };
  });
  app.get<{ Params:{ id:string };Querystring:{ after?:string;limit?:number } }>('/api/messaging/template-samples/:id/attempts',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ after:{ type:'string',pattern:'^[1-9][0-9]{0,18}$' },limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);await authorizedSample(db,actor,request.params.id);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT id::text,attempt_number,outcome,error_code,connection_version,started_at,finished_at
      FROM template_sample_processing_attempt WHERE sample_id=${request.params.id}
        AND (${request.query.after ?? null}::bigint IS NULL OR id<${request.query.after ?? null}::bigint) ORDER BY id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextAfter:rows.length>limit ? items.at(-1)!.id : null };
  });
  app.get<{ Params:{ id:string } }>('/api/messaging/template-samples/:id/download',{ schema:{ params } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);const row=await authorizedSample(db,actor,request.params.id);let bytes:Buffer;
    if (row.last_error_code==='MEDIA_CONTENT_REJECTED') throw new HttpError(422,'MEDIA_CONTENT_REJECTED');
    try { const storage=storageOption ?? configuredMediaStorage();if (storage.backend!==row.storage_backend) throw new Error('Storage mismatch');
      bytes=await storage.get(row.storage_key,mediaMaxBytes());
      if (bytes.length!==row.size_bytes || createHash('sha256').update(bytes).digest('hex')!==row.content_sha256) throw new Error('Integrity mismatch');
    } catch { throw new HttpError(503,'MEDIA_STORAGE_UNAVAILABLE'); }
    await db`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id)
      VALUES (${actor.organizationId},${row.branch_id},${actor.id},'TEMPLATE_SAMPLE_DOWNLOADED','TEMPLATE_SAMPLE',${row.id})`;
    const extension:Record<string,string>={ 'image/jpeg':'jpg','image/png':'png','application/pdf':'pdf','video/mp4':'mp4' };
    return reply.type('application/octet-stream').header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff')
      .header('Content-Security-Policy',"default-src 'none'; sandbox")
      .header('Content-Disposition',`attachment; filename="sample-${row.id}.${extension[row.mime_type]}"`).header('Content-Length',bytes.length).send(bytes);
  });
  app.post<{ Params:{ id:string };Body:{ version:number;reason:string } }>('/api/messaging/template-samples/:id/retry',{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','reason'],properties:{ version:{ type:'integer',minimum:1 },reason:{ type:'string',minLength:10,maxLength:500 } } } },
    config:{ rateLimit:{ max:10,timeWindow:'1 minute' } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);const row=await authorizedSample(db,actor,request.params.id);
    if (request.body.reason.trim().length<10) throw new HttpError(400,'REVIEW_REASON_REQUIRED');
    return db.begin(async(tx)=> {
      const connection=(await tx`SELECT version,status FROM integration_connection WHERE id=${row.connection_id} FOR UPDATE`)[0]!;
      if (connection.status==='DISABLED') throw new HttpError(409,'CONNECTION_DISABLED');
      const updated=(await tx`UPDATE messaging_template_sample SET state='QUEUED',retry_count=0,available_at=now(),last_error_code=NULL,
        connection_version=${connection.version},requested_by=${actor.id},version=version+1,updated_at=now()
        WHERE id=${row.id} AND state='FAILED' AND version=${request.body.version} RETURNING *`)[0];
      if (!updated) throw new HttpError(409,'TEMPLATE_SAMPLE_RETRY_CONFLICT');
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${row.branch_id},${actor.id},'TEMPLATE_SAMPLE_RETRY_REQUESTED','TEMPLATE_SAMPLE',${row.id},
          ${tx.json({ reason:request.body.reason.trim(),version:updated.version })})`;
      return publicSample(updated,connection.version);
    });
  });
}
