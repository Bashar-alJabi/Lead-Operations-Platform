import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { sealSecret } from '../credentials.js';
import { HttpError,principalFromRequest,requireRole,requireBranch } from '../security.js';
import { decodeCursor,encodeCursor } from '../pagination.js';
import { managedSourceConnection,recheckSourceActor,syncSourceCatalog } from '../sources/catalog-sync.js';
import { metaLeadSourceCatalogAdapter,type LeadSourceCatalogAdapter,type SourceConfig,type SourceCredentials } from '../sources/meta-provider.js';

const root='/api/sources/meta/connections';
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:{ type:'string',format:'uuid' } } } as const;
const config={ type:'object',additionalProperties:false,required:['graphVersion'],properties:{ graphVersion:{ type:'string',pattern:'^v\\d{1,2}\\.\\d{1,2}$' },appId:{ type:'string',pattern:'^\\d{1,30}$' } } } as const;
const credentials={ type:'object',additionalProperties:false,required:['accessToken','appSecret','verifyToken'],properties:{
  accessToken:{ type:'string',minLength:20,maxLength:4096,pattern:'^[^\\x00-\\x1f\\x7f]+$' },
  appSecret:{ type:'string',minLength:16,maxLength:512,pattern:'^[^\\x00-\\x1f\\x7f]+$' },
  verifyToken:{ type:'string',minLength:16,maxLength:512,pattern:'^[^\\x00-\\x1f\\x7f]+$' },
} } as const;
const properties={ name:{ type:'string',minLength:1,maxLength:100 },branchId:{ type:'string',format:'uuid' },config,credentials } as const;
type Input={ name:string;branchId?:string;config:SourceConfig;credentials?:SourceCredentials;version?:number };
const versionBody={ type:'object',additionalProperties:false,required:['version'],properties:{ version:{ type:'integer',minimum:1 } } } as const;

export function registerMetaSourceRoutes(app:FastifyInstance,db:Database,adapter:LeadSourceCatalogAdapter=metaLeadSourceCatalogAdapter):void {
  app.get<{ Querystring:{ limit?:number;cursor?:string } }>(root,{ schema:{ querystring:{ type:'object',additionalProperties:false,properties:{
    limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 },
  } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');
    const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT c.id,c.name,c.branch_id,c.status,c.config,c.capabilities,c.version,c.last_success_at,c.last_failure_at,c.last_error_code,
      c.created_at,secret.connection_id IS NOT NULL AS has_credential FROM integration_connection c
      LEFT JOIN connection_secret secret ON secret.connection_id=c.id WHERE c.organization_id=${actor.organizationId}
      AND c.kind='META' AND c.provider='META_LEAD_ADS' AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})
      AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (c.created_at,c.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY c.created_at DESC,c.id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);
    return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null };
  });
  app.post<{ Body:Input }>(root,{ schema:{ body:{ type:'object',additionalProperties:false,required:['name','config','credentials'],properties } } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');
    const branch=actor.role==='SUPER_ADMIN' ? request.body.branchId ?? null : actor.branchId;
    if (request.body.branchId) requireBranch(actor,request.body.branchId);
    if (!request.body.name.trim()) throw new HttpError(400,'SOURCE_NAME_REQUIRED');
    const id=randomUUID();const sealed=sealSecret(id,JSON.stringify(request.body.credentials));
    await db.begin(async(tx)=> {
      await recheckSourceActor(tx as unknown as Database,actor);
      if (branch && !(await tx`SELECT 1 FROM branch WHERE id=${branch} AND organization_id=${actor.organizationId} AND active FOR SHARE`).length)
        throw new HttpError(404,'SOURCE_BRANCH_NOT_FOUND');
      await tx`INSERT INTO integration_connection (id,organization_id,branch_id,kind,provider,name,config,created_by)
        VALUES (${id},${actor.organizationId},${branch},'META','META_LEAD_ADS',${request.body.name.trim()},${tx.json(request.body.config)},${actor.id})`;
      await tx`INSERT INTO connection_secret (connection_id,ciphertext,nonce,auth_tag,key_version)
        VALUES (${id},${sealed.ciphertext},${sealed.nonce},${sealed.authTag},${sealed.keyVersion})`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id)
        VALUES (${actor.organizationId},${branch},${actor.id},'SOURCE_CONNECTION_CREATED','CONNECTION',${id})`;
    });reply.code(201);return { id,status:'NOT_CONFIGURED',version:1 };
  });
  app.put<{ Params:{ id:string };Body:Input & { version:number } }>(root+'/:id',{ schema:{ params,body:{
    type:'object',additionalProperties:false,required:['name','config','version'],properties:{ ...properties,version:{ type:'integer',minimum:1 } },
  } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const old=await managedSourceConnection(db,actor,request.params.id);
    if (request.body.branchId && request.body.branchId!==old.branch_id) throw new HttpError(400,'SOURCE_SCOPE_IMMUTABLE');
    if (!request.body.name.trim()) throw new HttpError(400,'SOURCE_NAME_REQUIRED');
    const sealed=request.body.credentials ? sealSecret(old.id,JSON.stringify(request.body.credentials)) : null;
    return db.begin(async(tx)=> {
      const current=(await tx`SELECT version,status FROM integration_connection WHERE id=${old.id} FOR UPDATE`)[0]!;
      await recheckSourceActor(tx as unknown as Database,actor);
      if (current.version!==request.body.version) throw new HttpError(409,'SOURCE_CONNECTION_VERSION_CONFLICT');
      if (current.status==='DISABLED') throw new HttpError(409,'SOURCE_CONNECTION_DISABLED');
      await tx`UPDATE integration_connection SET name=${request.body.name.trim()},config=${tx.json(request.body.config)},version=version+1,
        status='NOT_CONFIGURED',capabilities='{}'::jsonb,last_error_code=NULL,updated_at=now() WHERE id=${old.id}`;
      if (sealed) await tx`UPDATE connection_secret SET ciphertext=${sealed.ciphertext},nonce=${sealed.nonce},auth_tag=${sealed.authTag},
        key_version=${sealed.keyVersion},updated_at=now() WHERE connection_id=${old.id}`;
      await tx`UPDATE source_resource SET active=false,version=version+1 WHERE connection_id=${old.id} AND active`;
      await tx`UPDATE source_resource_sync SET state='SUPERSEDED',finished_at=now(),error_code='SOURCE_CONFIGURATION_CHANGED'
        WHERE connection_id=${old.id} AND state='RUNNING'`;
      await tx`UPDATE source_subscription_attempt SET state='SUPERSEDED',finished_at=now(),error_code='SOURCE_CONFIGURATION_CHANGED'
        WHERE connection_id=${old.id} AND state='RUNNING'`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id)
        VALUES (${actor.organizationId},${old.branch_id},${actor.id},'SOURCE_CONNECTION_UPDATED','CONNECTION',${old.id})`;
      return { version:current.version+1,status:'NOT_CONFIGURED' };
    });
  });
  for (const action of ['disable','enable'] as const) app.post<{ Params:{ id:string };Body:{ version:number } }>(root+'/:id/'+action,
    { schema:{ params,body:versionBody } },async(request)=> {
      const actor=await principalFromRequest(request,db);const connection=await managedSourceConnection(db,actor,request.params.id);
      return db.begin(async(tx)=> {
        const current=(await tx`SELECT version,status FROM integration_connection WHERE id=${connection.id} FOR UPDATE`)[0]!;
        await recheckSourceActor(tx as unknown as Database,actor);
        if (current.version!==request.body.version) throw new HttpError(409,'SOURCE_CONNECTION_VERSION_CONFLICT');
        if ((action==='disable' && current.status==='DISABLED') || (action==='enable' && current.status!=='DISABLED')) throw new HttpError(409,'SOURCE_CONNECTION_STATE_CONFLICT');
        const status=action==='disable' ? 'DISABLED' : 'NOT_CONFIGURED';
        await tx`UPDATE integration_connection SET status=${status},version=version+1,capabilities='{}'::jsonb,last_error_code=NULL,
          updated_at=now() WHERE id=${connection.id}`;
        await tx`UPDATE source_resource SET active=false,version=version+1 WHERE connection_id=${connection.id} AND active`;
        await tx`UPDATE source_resource_sync SET state='SUPERSEDED',finished_at=now(),error_code='SOURCE_CONFIGURATION_CHANGED'
          WHERE connection_id=${connection.id} AND state='RUNNING'`;
        await tx`UPDATE source_subscription_attempt SET state='SUPERSEDED',finished_at=now(),error_code='SOURCE_CONFIGURATION_CHANGED'
          WHERE connection_id=${connection.id} AND state='RUNNING'`;
        await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id)
          VALUES (${actor.organizationId},${connection.branch_id},${actor.id},${'SOURCE_CONNECTION_'+action.toUpperCase()+'D'},'CONNECTION',${connection.id})`;
        return { status,version:current.version+1 };
      });
    });
  app.post<{ Params:{ id:string };Body:{ version:number;pageId?:string } }>(root+'/:id/discover',{ schema:{ params,body:{ ...versionBody,
    properties:{ ...versionBody.properties,pageId:{ type:'string',format:'uuid' } } } },config:{ rateLimit:{ max:10,timeWindow:'15 minutes' } } },
    async(request)=>syncSourceCatalog(db,await principalFromRequest(request,db),request.params.id,request.body,adapter));
  app.get<{ Params:{ id:string };Querystring:{ kind:'PAGE'|'FORM';pageId?:string;after?:string;limit?:number } }>(root+'/:id/resources',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,required:['kind'],properties:{ kind:{ type:'string',enum:['PAGE','FORM'] },
      pageId:{ type:'string',format:'uuid' },after:{ type:'string',format:'uuid' },limit:{ type:'integer',minimum:1,maximum:100 } } } } },async(request)=> {
      const actor=await principalFromRequest(request,db);await managedSourceConnection(db,actor,request.params.id);
      if (request.query.kind==='PAGE' && request.query.pageId) throw new HttpError(400,'SOURCE_PARENT_NOT_ALLOWED');
      if (request.query.pageId && !(await db`SELECT 1 FROM source_resource WHERE id=${request.query.pageId}
        AND connection_id=${request.params.id} AND resource_kind='PAGE'`).length) throw new HttpError(404,'SOURCE_PAGE_NOT_FOUND');
      const limit=request.query.limit ?? 50;
      const rows=await db`SELECT id,resource_kind,parent_id,external_id,name,provider_status,questions,connection_version,version,active,last_synced_at
        FROM source_resource WHERE connection_id=${request.params.id} AND resource_kind=${request.query.kind}
          AND (${request.query.pageId ?? null}::uuid IS NULL OR parent_id=${request.query.pageId ?? null}::uuid)
          AND (${request.query.after ?? null}::uuid IS NULL OR id>${request.query.after ?? null}::uuid) ORDER BY id LIMIT ${limit+1}`;
      const items=rows.slice(0,limit);return { items,nextAfter:rows.length>limit ? items.at(-1)!.id : null };
    });
  app.get<{ Params:{ id:string };Querystring:{ cursor?:string;limit?:number } }>(root+'/:id/sync-history',{ schema:{ params,querystring:{
    type:'object',additionalProperties:false,properties:{ cursor:{ type:'string',maxLength:256 },limit:{ type:'integer',minimum:1,maximum:100 } },
  } } },async(request)=> {
    const actor=await principalFromRequest(request,db);await managedSourceConnection(db,actor,request.params.id);
    const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT id,resource_kind,parent_id,state,resource_count,error_code,started_at,finished_at,lease_until
      FROM source_resource_sync WHERE connection_id=${request.params.id}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (started_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY started_at DESC,id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);
    return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.started_at.toISOString(),id:last.id }) : null };
  });
}
