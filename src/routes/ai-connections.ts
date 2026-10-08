import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,requireRole,type Principal } from '../security.js';
import { openSecret,sealSecret } from '../credentials.js';
import { currentPaymentSession } from '../payments/access.js';
import { AIProviderError,aiCredential,aiConnectionAdapters,normalizeAIModels,type AIAdapterRegistry } from '../ai/providers.js';
import { decodeCursor,encodeCursor } from '../pagination.js';
const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
const version={ type:'integer',minimum:1 } as const;
const text=(min:number,max:number)=>({ type:'string',minLength:min,maxLength:max,pattern:'^[^\\x00-\\x1f\\x7f]+$' });
const page={ type:'object',additionalProperties:false,properties:{ limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 } } } as const;
type Page={ limit?:number;cursor?:string };
function checkedText(value:string,min=1,max=100) { const t=value.trim();if(t.length<min || t.length>max)throw new HttpError(400,'AI_TEXT_INVALID');return t; }
async function access(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest) { const id=await currentPaymentSession(tx,actor,request);if(!id)throw new HttpError(403,'AI_ACCESS_REVOKED');return id; }
async function connection(tx:postgres.TransactionSql,actor:Principal,id:string,write=false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');const c=(await tx`SELECT * FROM integration_connection WHERE id=${id} AND kind='AI' AND organization_id=${actor.organizationId}
    AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId}) ${write ? tx`FOR UPDATE` : tx`FOR SHARE`}`)[0];if(!c)throw new HttpError(404,'AI_CONNECTION_NOT_FOUND');return c;
}
async function audit(tx:postgres.TransactionSql,c:postgres.Row,actor:Principal,action:string,detail:postgres.JSONValue={}) {
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (${c.organization_id},${c.branch_id},${actor.id},${action},'AI_CONNECTION',${c.id},${tx.json(detail)})`;
}
async function revision(tx:postgres.TransactionSql,c:postgres.Row,actor:Principal,sessionId:string,reason:string,secretChanged:boolean) {
  await tx`INSERT INTO ai_connection_revision(connection_id,version,actor_id,session_id,name,status,reason,secret_changed)
    VALUES (${c.id},${c.version},${actor.id},${sessionId},${c.name},${c.status},${checkedText(reason,3,500)},${secretChanged})`;
  await audit(tx,c,actor,'AI_CONNECTION_CONFIGURED',{ version:c.version,status:c.status,reason,secretChanged });
}
function paged(rows:postgres.Row[],limit:number) { const items=rows.slice(0,limit),last=items.at(-1);return { items:items.map(({ cursor_time,...r })=>r),nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.cursor_time,id:last.id }) : null }; }
export function registerAIConnectionRoutes(app:FastifyInstance,db:Database,adapters:AIAdapterRegistry=aiConnectionAdapters) {
  app.get<{ Querystring:Page }>('/api/ai/connections',{ schema:{ querystring:page } },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const cursor=decodeCursor(request.query.cursor),limit=request.query.limit ?? 20;
    return paged(await db`SELECT c.id,c.name,c.provider,c.branch_id,c.status,c.version,(c.capabilities-'models') || jsonb_build_object('modelCount',COALESCE(jsonb_array_length(c.capabilities->'models'),0)) AS capabilities,c.last_success_at,c.last_failure_at,c.last_error_code,c.created_at,c.created_at::text AS cursor_time,
      EXISTS(SELECT 1 FROM connection_secret s WHERE s.connection_id=c.id) AS secret_configured
      FROM integration_connection c WHERE c.kind='AI' AND c.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})
      AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (c.created_at,c.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY c.created_at DESC,c.id DESC LIMIT ${limit+1}`,limit);
  });
  app.get<{ Params:{ id:string };Querystring:{ q?:string;after?:string;limit?:number } }>('/api/ai/connections/:id/models',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ q:{ type:'string',maxLength:200 },after:{ type:'string',maxLength:200 },limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const c=await connection(tx,actor,request.params.id);await access(tx,actor,request);const activeBranch=!c.branch_id || (await tx`SELECT 1 FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length>0;if(c.status!=='CONNECTED' || c.capabilities.catalogVersion!==c.version || !activeBranch)return { items:[],nextAfter:null,current:false };
      const limit=request.query.limit ?? 50;const rows=await tx`SELECT model FROM jsonb_array_elements_text(${tx.json(c.capabilities.models)}) m(model)
        WHERE (${request.query.after ?? null}::text IS NULL OR model COLLATE "C">${request.query.after ?? null}::text COLLATE "C") AND position(lower(${request.query.q ?? ''}) IN lower(model))>0 ORDER BY model COLLATE "C" LIMIT ${limit+1}`;
      const items=rows.slice(0,limit).map((r)=>r.model);return { items,nextAfter:rows.length>limit ? items.at(-1) : null,current:true };
    });
  });
  app.post<{ Body:{ name:string;branchId:string|null;provider:string;credential:string;reason:string } }>('/api/ai/connections',{
    schema:{ body:{ type:'object',additionalProperties:false,required:['name','branchId','provider','credential','reason'],properties:{ name:text(1,100),branchId:{ anyOf:[uuid,{ type:'null' }] },provider:{ enum:['OPENAI'] },credential:{ type:'string',pattern:'^[A-Za-z0-9_-]{16,512}$' },reason:text(3,500) } } },
  },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const p=request.body;
    if(!adapters[p.provider])throw new HttpError(400,'AI_PROVIDER_UNSUPPORTED');aiCredential(p.credential);
    const result=await db.begin(async(tx)=> {
      if(actor.role!=='SUPER_ADMIN' && (!p.branchId || p.branchId!==actor.branchId))throw new HttpError(403,'AI_SCOPE_FORBIDDEN');
      if(p.branchId && !(await tx`SELECT id FROM branch WHERE id=${p.branchId} AND organization_id=${actor.organizationId} AND active FOR SHARE`).length)throw new HttpError(404,'BRANCH_NOT_FOUND');
      const sessionId=await access(tx,actor,request),id=randomUUID(),sealed=sealSecret(id,p.credential);
      const c=(await tx`INSERT INTO integration_connection(id,organization_id,branch_id,kind,provider,name,created_by) VALUES (${id},${actor.organizationId},${p.branchId},'AI',${p.provider},${checkedText(p.name)},${actor.id}) RETURNING *`)[0]!;
      await tx`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag,key_version) VALUES (${id},${sealed.ciphertext},${sealed.nonce},${sealed.authTag},${sealed.keyVersion})`;
      await revision(tx,c,actor,sessionId,p.reason,true);return { id,version:1,status:'NOT_CONFIGURED' };
    });reply.code(201);return result;
  });
  app.put<{ Params:{ id:string };Body:{ name:string;credential?:string;version:number;reason:string } }>('/api/ai/connections/:id',{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['name','version','reason'],properties:{ name:text(1,100),credential:{ type:'string',pattern:'^[A-Za-z0-9_-]{16,512}$' },version,reason:text(3,500) } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const c=await connection(tx,actor,request.params.id,true),sessionId=await access(tx,actor,request),p=request.body;
      if(c.version!==p.version)throw new HttpError(409,'AI_VERSION_CONFLICT');if(c.status==='DISABLED')throw new HttpError(409,'AI_CONNECTION_DISABLED');
      if(p.credential) { const sealed=sealSecret(c.id,aiCredential(p.credential));await tx`UPDATE connection_secret SET ciphertext=${sealed.ciphertext},nonce=${sealed.nonce},auth_tag=${sealed.authTag},key_version=${sealed.keyVersion},updated_at=clock_timestamp() WHERE connection_id=${c.id}`; }
      const row=(await tx`UPDATE integration_connection SET name=${checkedText(p.name)},version=version+1,status='NOT_CONFIGURED',capabilities='{}',last_error_code=NULL,updated_at=clock_timestamp() WHERE id=${c.id} RETURNING *`)[0]!;
      await revision(tx,row,actor,sessionId,p.reason,!!p.credential);return { id:c.id,version:row.version,status:row.status };
    });
  });
  for(const action of ['disable','reconnect'] as const)app.post<{ Params:{ id:string };Body:{ version:number;reason:string } }>(`/api/ai/connections/:id/${action}`,{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','reason'],properties:{ version,reason:text(3,500) } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const c=await connection(tx,actor,request.params.id,true),sessionId=await access(tx,actor,request);if(c.version!==request.body.version)throw new HttpError(409,'AI_VERSION_CONFLICT');
      if(action==='reconnect' && c.branch_id && !(await tx`SELECT id FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length)throw new HttpError(409,'BRANCH_DISABLED');
      const row=(await tx`UPDATE integration_connection SET status=${action==='disable' ? 'DISABLED' : 'NOT_CONFIGURED'},capabilities='{}',version=version+1,updated_at=clock_timestamp() WHERE id=${c.id} RETURNING *`)[0]!;
      await revision(tx,row,actor,sessionId,request.body.reason,false);return { id:row.id,version:row.version,status:row.status };
    });
  });
  for(const kind of ['history','probes'] as const)app.get<{ Params:{ id:string };Querystring:Page }>(`/api/ai/connections/:id/${kind}`,{ schema:{ params,querystring:page } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const c=await connection(tx,actor,request.params.id);await access(tx,actor,request);const cursor=decodeCursor(request.query.cursor),limit=request.query.limit ?? 20;
      const rows=kind==='probes' ? await tx`SELECT id,state,connection_version,models,error_code,created_at,finished_at,created_at::text AS cursor_time FROM ai_connection_probe WHERE connection_id=${c.id}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`
        : await tx`SELECT connection_id AS id,version,name,status,reason,secret_changed,created_at,created_at::text AS cursor_time FROM ai_connection_revision WHERE connection_id=${c.id}
          AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR created_at<${cursor?.timestamp ?? null}::timestamptz) ORDER BY created_at DESC,version DESC LIMIT ${limit+1}`;
      return paged(rows,limit);
    });
  });
  app.post<{ Params:{ id:string };Body:{ version:number } }>('/api/ai/connections/:id/test',{ schema:{ params,body:{ type:'object',additionalProperties:false,required:['version'],properties:{ version } } },config:{ rateLimit:{ max:10,timeWindow:'15 minutes' } } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);const claim=await db.begin(async(tx)=> {
      const c=await connection(tx,actor,request.params.id,true),sessionId=await access(tx,actor,request);if(c.version!==request.body.version)throw new HttpError(409,'AI_VERSION_CONFLICT');
      if(c.status==='DISABLED')throw new HttpError(409,'AI_CONNECTION_DISABLED');if(c.branch_id && !(await tx`SELECT 1 FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length)throw new HttpError(409,'BRANCH_DISABLED');
      await tx`UPDATE ai_connection_probe SET state='SUPERSEDED',error_code='AI_PROBE_EXPIRED',finished_at=clock_timestamp() WHERE connection_id=${c.id} AND state='RUNNING' AND expires_at<=clock_timestamp()`;
      if((await tx`SELECT 1 FROM ai_connection_probe WHERE connection_id=${c.id} AND state='RUNNING'`).length)throw new HttpError(409,'AI_TEST_IN_PROGRESS');
      const s=(await tx`SELECT * FROM connection_secret WHERE connection_id=${c.id}`)[0];if(!s)throw new HttpError(409,'AI_CREDENTIAL_REQUIRED');
      const credential=openSecret(c.id,{ ciphertext:s.ciphertext,nonce:s.nonce,authTag:s.auth_tag,keyVersion:s.key_version });
      const probe=(await tx`INSERT INTO ai_connection_probe(connection_id,connection_version,actor_id,session_id) VALUES (${c.id},${c.version},${actor.id},${sessionId}) RETURNING id`)[0]!;
      return { c,credential,probeId:probe.id as string };
    });
    let models:string[]|null=null,error:string|null=null;
    try { const adapter=adapters[claim.c.provider];if(!adapter)throw new AIProviderError('AI_RESPONSE_INVALID');models=normalizeAIModels(await adapter.listModels(claim.credential)); }
    catch(e) { error=e instanceof AIProviderError ? e.code : 'AI_PROVIDER_UNAVAILABLE'; }
    const result=await db.begin(async(tx)=> {
      const c=(await tx`SELECT * FROM integration_connection WHERE id=${claim.c.id} FOR UPDATE`)[0]!;
      const probe=(await tx`SELECT *,expires_at<=clock_timestamp() AS expired FROM ai_connection_probe WHERE id=${claim.probeId} FOR UPDATE`)[0]!;
      const allowed=await currentPaymentSession(tx,actor,request);const activeBranch=!c.branch_id || (await tx`SELECT 1 FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length>0;
      const stale=c.version!==claim.c.version || c.status==='DISABLED' || !allowed || !activeBranch || probe.expired || probe.state!=='RUNNING';
      const state=stale ? 'SUPERSEDED' : models ? 'VERIFIED' : 'FAILED';
      if(probe.state==='RUNNING')await tx`UPDATE ai_connection_probe SET state=${state},models=${state==='VERIFIED' ? tx.json(models!) : null},error_code=${stale ? 'AI_PROBE_SUPERSEDED' : error},finished_at=clock_timestamp() WHERE id=${probe.id}`;
      if(!stale) {
        await tx`UPDATE integration_connection SET status=${models ? 'CONNECTED' : error==='AI_AUTH_FAILED' ? 'AUTH_EXPIRED' : 'ERROR'},
          capabilities=${tx.json(models ? { catalogVersion:c.version,models,inferenceVerified:false } : {})},last_error_code=${error},
          last_success_at=CASE WHEN ${!!models} THEN clock_timestamp() ELSE last_success_at END,last_failure_at=CASE WHEN ${!models} THEN clock_timestamp() ELSE last_failure_at END WHERE id=${c.id}`;
      }
      await audit(tx,c,actor,'AI_CONNECTION_TESTED',{ probeId:probe.id,state,error:stale ? 'AI_PROBE_SUPERSEDED' : error });return { state,models:state==='VERIFIED' ? models : [],errorCode:stale ? 'AI_PROBE_SUPERSEDED' : error,allowed:!!allowed };
    });if(!result.allowed)reply.code(403);return { ...result,inferenceVerified:false,verification:'Live Verification Pending External Credential/Approval' };
  });
  app.get<{ Querystring:Page }>('/api/ai/profiles',{ schema:{ querystring:page } },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const cursor=decodeCursor(request.query.cursor),limit=request.query.limit ?? 20;
    return paged(await db`SELECT p.*,p.created_at::text AS cursor_time,c.name AS connection_name,c.status AS connection_status,
      (p.active AND c.status='CONNECTED' AND (c.branch_id IS NULL OR b.active) AND c.capabilities->>'catalogVersion'=c.version::text AND c.capabilities->'models' ? p.model_id) AS catalog_available
      FROM ai_model_profile p JOIN integration_connection c ON c.id=p.connection_id LEFT JOIN branch b ON b.id=c.branch_id WHERE p.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR p.branch_id=${actor.branchId})
      AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (p.created_at,p.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT ${limit+1}`,limit);
  });
  const profileBody={ type:'object',additionalProperties:false,required:['connectionId','name','task','modelId','maxOutputTokens','active','reason'],properties:{ connectionId:uuid,name:text(1,100),task:{ enum:['CONVERSATION','SUMMARIZATION','CLASSIFICATION','ANALYSIS'] },modelId:{ type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' },maxOutputTokens:{ type:'integer',minimum:128,maximum:16384 },active:{ type:'boolean' },reason:text(3,500),version } } as const;
  for(const update of [false,true])app.route<{ Params:{ id:string };Body:{ connectionId:string;name:string;task:string;modelId:string;maxOutputTokens:number;active:boolean;reason:string;version?:number } }>({ method:update ? 'PUT' : 'POST',url:'/api/ai/profiles'+(update ? '/:id' : ''),schema:{ ...(update ? { params } : {}),body:{ ...profileBody,required:[...profileBody.required,...(update ? ['version'] : [])] } },handler:async(request,reply)=> {
    const actor=await principalFromRequest(request,db);const p=request.body;const result=await db.begin(async(tx)=> {
      const c=await connection(tx,actor,p.connectionId);const sessionId=await access(tx,actor,request);
      const old=update ? (await tx`SELECT * FROM ai_model_profile WHERE id=${request.params.id} AND organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId}) FOR UPDATE`)[0] : null;
      if(update && !old)throw new HttpError(404,'AI_PROFILE_NOT_FOUND');if(old && (old.version!==p.version || old.connection_id!==c.id || old.task!==p.task))throw new HttpError(409,'AI_PROFILE_VERSION_OR_IDENTITY_CONFLICT');
      if(p.active && (c.status!=='CONNECTED' || c.capabilities.catalogVersion!==c.version || !c.capabilities.models?.includes(p.modelId)))throw new HttpError(409,'AI_CURRENT_MODEL_CATALOG_REQUIRED');
      if(p.active && c.branch_id && !(await tx`SELECT 1 FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length)throw new HttpError(409,'BRANCH_DISABLED');
      const row=old ? (await tx`UPDATE ai_model_profile SET name=${checkedText(p.name)},model_id=${p.modelId},max_output_tokens=${p.maxOutputTokens},active=${p.active},version=version+1,actor_id=${actor.id},session_id=${sessionId},reason=${checkedText(p.reason,3,500)},updated_at=clock_timestamp() WHERE id=${old.id} RETURNING id,version`)[0]!
        : (await tx`INSERT INTO ai_model_profile(connection_id,organization_id,branch_id,name,task,model_id,max_output_tokens,active,actor_id,session_id,reason)
          VALUES (${c.id},${c.organization_id},${c.branch_id},${checkedText(p.name)},${p.task},${p.modelId},${p.maxOutputTokens},${p.active},${actor.id},${sessionId},${checkedText(p.reason,3,500)}) RETURNING id,version`)[0]!;return row;
    });if(!update)reply.code(201);return result;
  } });
  app.get<{ Params:{ id:string };Querystring:{ before?:number;limit?:number } }>('/api/ai/profiles/:id/history',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ before:version,limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const limit=request.query.limit ?? 20;
    const p=(await db`SELECT id FROM ai_model_profile WHERE id=${request.params.id} AND organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId})`)[0];if(!p)throw new HttpError(404,'AI_PROFILE_NOT_FOUND');
    const rows=await db`SELECT version,snapshot,created_at FROM ai_profile_history WHERE profile_id=${p.id} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;
    return { items:rows.slice(0,limit),nextVersion:rows.length>limit ? rows[limit-1]!.version : null };
  });
}
