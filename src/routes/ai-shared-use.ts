import type { FastifyInstance,FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { principalFromRequest,requireRole,HttpError,type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
const reason={ type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$' } as const;
async function shared(tx:postgres.TransactionSql,actor:Principal,id:string,request:FastifyRequest,write=false) {
  requireRole(actor,'SUPER_ADMIN');const c=(await tx`SELECT id,version,organization_id FROM integration_connection WHERE id=${id} AND organization_id=${actor.organizationId} AND kind='AI' AND branch_id IS NULL ${write ? tx`FOR UPDATE` : tx`FOR SHARE`}`)[0];
  if(!c)throw new HttpError(404,'AI_SHARED_CONNECTION_NOT_FOUND');const sessionId=await currentPaymentSession(tx,actor,request);if(!sessionId)throw new HttpError(403,'AI_SHARED_USE_ACCESS_REVOKED');return { c,sessionId };
}
export function registerAISharedUseRoutes(app:FastifyInstance,db:Database) {
  const root='/api/ai/connections/:id/branch-use';
  app.get<{ Params:{ id:string };Querystring:{ after?:string;limit?:number } }>(root,{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ after:uuid,limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> { const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
    const { c }=await shared(tx,actor,request.params.id,request),limit=request.query.limit ?? 20;
    const rows=await tx`SELECT g.branch_id,b.name AS branch_name,g.active,g.version,g.connection_version,g.reason,g.updated_at FROM ai_connection_branch_use g JOIN branch b ON b.id=g.branch_id
      WHERE g.connection_id=${c.id} AND (${request.query.after ?? null}::uuid IS NULL OR g.branch_id>${request.query.after ?? null}) ORDER BY g.branch_id LIMIT ${limit+1}`;
    return { items:rows.slice(0,limit),nextAfter:rows.length>limit ? rows[limit-1]!.branch_id : null };
  }); });
  app.put<{ Params:{ id:string };Body:{ branchId:string;active:boolean;version:number;connectionVersion:number;reason:string } }>(root,{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['branchId','active','version','connectionVersion','reason'],properties:{ branchId:uuid,active:{ type:'boolean' },version:{ type:'integer',minimum:0 },connectionVersion:{ type:'integer',minimum:1 },reason } } },
  },async(request)=> { const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
    const { c,sessionId }=await shared(tx,actor,request.params.id,request,true),p=request.body;if(c.version!==p.connectionVersion)throw new HttpError(409,'AI_VERSION_CONFLICT');if(p.reason.trim().length<3)throw new HttpError(400,'AI_SHARED_USE_REASON_REQUIRED');
    const b=(await tx`SELECT active FROM branch WHERE id=${p.branchId} AND organization_id=${actor.organizationId} FOR SHARE`)[0];if(!b)throw new HttpError(404,'BRANCH_NOT_FOUND');if(p.active && !b.active)throw new HttpError(409,'BRANCH_DISABLED');
    const g=(await tx`SELECT version FROM ai_connection_branch_use WHERE connection_id=${c.id} AND branch_id=${p.branchId} FOR UPDATE`)[0];if((g?.version ?? 0)!==p.version)throw new HttpError(409,'AI_SHARED_USE_VERSION_CONFLICT');
    const result=g ? await tx`UPDATE ai_connection_branch_use SET active=${p.active},version=version+1,connection_version=${c.version},actor_id=${actor.id},session_id=${sessionId},reason=${p.reason.trim()},updated_at=clock_timestamp() WHERE connection_id=${c.id} AND branch_id=${p.branchId} RETURNING branch_id,version,active`
      : await tx`INSERT INTO ai_connection_branch_use(connection_id,branch_id,active,version,connection_version,actor_id,session_id,reason) VALUES (${c.id},${p.branchId},${p.active},1,${c.version},${actor.id},${sessionId},${p.reason.trim()}) RETURNING branch_id,version,active`;return result[0];
  }); });
  app.get<{ Params:{ id:string;branchId:string };Querystring:{ before?:number;limit?:number } }>(root+'/:branchId/history',{
    schema:{ params:{ ...params,required:['id','branchId'],properties:{ id:uuid,branchId:uuid } },querystring:{ type:'object',additionalProperties:false,properties:{ before:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> { const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
    const { c }=await shared(tx,actor,request.params.id,request),limit=request.query.limit ?? 20;
    if(!(await tx`SELECT 1 FROM ai_connection_branch_use WHERE connection_id=${c.id} AND branch_id=${request.params.branchId}`).length)throw new HttpError(404,'AI_SHARED_USE_NOT_FOUND');
    const rows=await tx`SELECT version,snapshot,created_at FROM ai_connection_branch_use_history WHERE connection_id=${c.id} AND branch_id=${request.params.branchId}
      AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;return { items:rows.slice(0,limit),nextVersion:rows.length>limit ? rows[limit-1]!.version : null };
  }); });
  app.get<{ Querystring:{ branchId:string;after?:string;limit?:number } }>('/api/ai/usable-profiles',{
    schema:{ querystring:{ type:'object',additionalProperties:false,required:['branchId'],properties:{ branchId:uuid,after:uuid,limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> { const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');if(actor.role==='MANAGER' && actor.branchId!==request.query.branchId)throw new HttpError(403,'AI_BRANCH_USE_FORBIDDEN');
    return db.begin(async(tx)=> {
      if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'AI_SHARED_USE_ACCESS_REVOKED');
      const b=(await tx`SELECT id,active FROM branch WHERE id=${request.query.branchId} AND organization_id=${actor.organizationId} FOR SHARE`)[0];if(!b)throw new HttpError(404,'BRANCH_NOT_FOUND');const limit=request.query.limit ?? 20;
      const rows=await tx`SELECT p.id,p.connection_id,c.name AS connection_name,p.name,p.task,p.model_id,p.max_output_tokens,p.version AS profile_version,c.version AS connection_version,
        c.branch_id IS NULL AS shared,CASE WHEN c.branch_id IS NULL THEN g.version END AS grant_version,(p.active AND ${b.active} AND c.status='CONNECTED' AND c.capabilities->>'catalogVersion'=c.version::text AND c.capabilities->'models' ? p.model_id) AS catalog_available
        FROM ai_model_profile p JOIN integration_connection c ON c.id=p.connection_id LEFT JOIN ai_connection_branch_use g ON g.connection_id=c.id AND g.branch_id=${b.id}
        WHERE p.organization_id=${actor.organizationId} AND c.organization_id=${actor.organizationId}
        AND (p.branch_id=${b.id} OR (p.branch_id IS NULL AND g.active))
        AND (${request.query.after ?? null}::uuid IS NULL OR p.id>${request.query.after ?? null}) ORDER BY p.id LIMIT ${limit+1}`;
      return { items:rows.slice(0,limit),nextAfter:rows.length>limit ? rows[limit-1]!.id : null,inferenceVerified:false };
    });
  });
}
