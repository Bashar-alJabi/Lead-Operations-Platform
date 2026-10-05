import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { principalFromRequest,HttpError } from '../security.js';
import { decodeCursor,encodeCursor } from '../pagination.js';
import { managedSourceConnection } from '../sources/catalog-sync.js';
import { historicalAction,startHistoricalPreview } from '../sources/historical.js';
const root='/api/sources/meta/connections/:id/historical';
const ids={ id:{ type:'string',format:'uuid' },jobId:{ type:'string',format:'uuid' } } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:ids.id } } as const;
const jobParams={ type:'object',additionalProperties:false,required:['id','jobId'],properties:ids } as const;
const actionBody={ type:'object',additionalProperties:false,required:['version','reason'],properties:{ version:{ type:'integer',minimum:1 },reason:{ type:'string',minLength:1,maxLength:500 } } } as const;
const pageQuery={ type:'object',additionalProperties:false,properties:{ limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 } } } as const;
const dto=(j:Record<string,any>)=>({ id:j.id,formId:j.form_id,state:j.state,phase:j.phase,version:j.version,from:j.range_from,until:j.range_until,
  pages:j.pages,scanned:j.scanned,attempts:j.attempts,recoveries:j.recoveries,errorCode:j.error_code,createdAt:j.created_at,updatedAt:j.updated_at,confirmedAt:j.confirmed_at });
export function registerSourceHistoryRoutes(app:FastifyInstance,db:Database) {
  app.post<{ Params:{ id:string };Body:{ version:number;formId:string;requestId:string;from:string;until:string } }>(root,{ schema:{ params,body:{ type:'object',additionalProperties:false,
    required:['version','formId','requestId','from','until'],properties:{ version:{ type:'integer',minimum:1 },formId:{ type:'string',format:'uuid' },requestId:{ type:'string',format:'uuid' },
      from:{ type:'string',maxLength:30 },until:{ type:'string',maxLength:30 } } } },config:{ rateLimit:{ max:10,timeWindow:'15 minutes' } } },async(req,reply)=> {
    const actor=await principalFromRequest(req,db);const result=await startHistoricalPreview(db,actor,req.params.id,req.body);reply.code(202);return result;
  });
  app.get<{ Params:{ id:string };Querystring:{ cursor?:string;limit?:number } }>(root,{ schema:{ params,querystring:pageQuery } },async(req)=> {
    const actor=await principalFromRequest(req,db);await managedSourceConnection(db,actor,req.params.id);const cursor=decodeCursor(req.query.cursor);const limit=req.query.limit ?? 20;
    const rows=await db`SELECT * FROM source_historical_job WHERE connection_id=${req.params.id}
      AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);
    return { items:items.map(dto),nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null };
  });
  app.get<{ Params:{ id:string;jobId:string } }>(root+'/:jobId',{ schema:{ params:jobParams } },async(req)=> {
    const actor=await principalFromRequest(req,db);await managedSourceConnection(db,actor,req.params.id);
    const j=(await db`SELECT * FROM source_historical_job WHERE id=${req.params.jobId} AND connection_id=${req.params.id}`)[0];
    if (!j) throw new HttpError(404,'SOURCE_HISTORICAL_JOB_NOT_FOUND');
    const counts=(await db`SELECT count(*)::int AS matched,
      count(*) FILTER (WHERE i.result='STAGED')::int AS staged,
      count(*) FILTER (WHERE i.result='STAGED' AND (s.id IS NOT NULL OR e.id IS NOT NULL))::int AS known,
      count(*) FILTER (WHERE i.result='IMPORTED')::int AS imported,
      count(*) FILTER (WHERE i.result IN ('DUPLICATE_SUBMISSION','DUPLICATE_RECEIPT'))::int AS duplicates,
      count(*) FILTER (WHERE i.result='CONTEXT_CONFLICT')::int AS conflicts,
      count(*) FILTER (WHERE i.result='IMPORTED' AND p.state='PROCESSED' AND (${actor.role==='SUPER_ADMIN'} OR (p.branch_id=${actor.branchId} AND l.branch_id=${actor.branchId})))::int AS processed,
      count(*) FILTER (WHERE i.result='IMPORTED' AND p.state='NEEDS_ATTENTION' AND (${actor.role==='SUPER_ADMIN'} OR p.branch_id=${actor.branchId}))::int AS attention
      FROM source_historical_item i LEFT JOIN source_submission s ON s.connection_id=i.connection_id AND s.external_event_id=i.external_lead_id
      LEFT JOIN source_webhook_event e ON e.connection_id=i.connection_id AND e.external_lead_id=i.external_lead_id
      LEFT JOIN source_processing p ON p.submission_id=i.submission_id LEFT JOIN lead l ON l.id=s.lead_id WHERE i.job_id=${j.id}`)[0]!;
    return { ...dto(j),counts };
  });
  app.get<{ Params:{ id:string;jobId:string };Querystring:{ after?:string;limit?:number } }>(root+'/:jobId/results',{ schema:{ params:jobParams,querystring:{ type:'object',additionalProperties:false,
    properties:{ after:{ type:'string',pattern:'^\\d{1,30}$' },limit:{ type:'integer',minimum:1,maximum:100 } } } } },async(req)=> {
    const actor=await principalFromRequest(req,db);await managedSourceConnection(db,actor,req.params.id);
    if (!(await db`SELECT 1 FROM source_historical_job WHERE id=${req.params.jobId} AND connection_id=${req.params.id}`).length) throw new HttpError(404,'SOURCE_HISTORICAL_JOB_NOT_FOUND');
    const limit=req.query.limit ?? 30;
    const rows=await db`SELECT i.external_lead_id AS "externalLeadId",i.source_timestamp AS "sourceTimestamp",i.result,i.submission_id AS "submissionId",
      CASE WHEN ${actor.role==='SUPER_ADMIN'} OR (p.branch_id=${actor.branchId} AND (s.lead_id IS NULL OR l.branch_id=${actor.branchId})) THEN p.state ELSE NULL END AS "processingState"
      FROM source_historical_item i LEFT JOIN source_processing p ON p.submission_id=i.submission_id LEFT JOIN source_submission s ON s.id=i.submission_id
      LEFT JOIN lead l ON l.id=s.lead_id WHERE i.job_id=${req.params.jobId} AND (${req.query.after ?? null}::text IS NULL OR i.external_lead_id>${req.query.after ?? null})
      ORDER BY i.external_lead_id LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextAfter:rows.length>limit ? items.at(-1)!.externalLeadId : null };
  });
  app.get<{ Params:{ id:string;jobId:string };Querystring:{ before?:number;limit?:number } }>(root+'/:jobId/attempts',{ schema:{ params:jobParams,querystring:{ type:'object',additionalProperties:false,
    properties:{ before:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } } },async(req)=> {
    const actor=await principalFromRequest(req,db);await managedSourceConnection(db,actor,req.params.id);
    if (!(await db`SELECT 1 FROM source_historical_job WHERE id=${req.params.jobId} AND connection_id=${req.params.id}`).length) throw new HttpError(404,'SOURCE_HISTORICAL_JOB_NOT_FOUND');
    const limit=req.query.limit ?? 20;const rows=await db`SELECT number,state,error_code AS "errorCode",started_at AS "startedAt",finished_at AS "finishedAt"
      FROM source_historical_attempt WHERE job_id=${req.params.jobId} AND (${req.query.before ?? null}::int IS NULL OR number<${req.query.before ?? null}) ORDER BY number DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextBefore:rows.length>limit ? items.at(-1)!.number : null };
  });
  for (const action of ['confirm','cancel','retry'] as const) app.post<{ Params:{ id:string;jobId:string };Body:{ version:number;reason:string } }>(root+'/:jobId/'+action,
    { schema:{ params:jobParams,body:actionBody },config:{ rateLimit:{ max:20,timeWindow:'15 minutes' } } },async(req)=> {
      const actor=await principalFromRequest(req,db);return historicalAction(db,actor,req.params.id,req.params.jobId,req.body,action);
    });
}
