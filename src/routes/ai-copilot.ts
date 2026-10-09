import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { approvedConversationReadContext,trustedCopilotSnapshot } from '../ai/copilot-context.js';
import { effectiveConfigHash } from '../ai/operational-config.js';
import { copilotSafeReferences,copilotSummaryPurpose } from '../ai/copilot-summary.js';
import type { SimulationReference } from '../ai/simulation.js';
const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
export function registerAICopilotRoutes(app:FastifyInstance,db:Database,testTransport=false) {
  const root='/api/conversations/:id/ai-summaries';
  app.post<{ Params:{ id:string };Body:{ requestId:string } }>(root,{ bodyLimit:4096,schema:{ params,body:{ type:'object',additionalProperties:false,required:['requestId'],properties:{ requestId:uuid } } } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db),requestHash=effectiveConfigHash({ kind:'COPILOT_SUMMARY',conversationId:request.params.id });
    const result=await db.begin(async(tx)=> {
      const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'AI_COPILOT_ACCESS_REVOKED');
      const access=await approvedConversationReadContext(tx,actor,request.params.id,session);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'ai-simulation:'+access.c.id+':'+actor.id},0))`;
      const duplicate=(await tx`SELECT id,kind,request_hash,state,version FROM ai_campaign_simulation WHERE campaign_id=${access.c.id} AND actor_id=${actor.id} AND request_id=${request.body.requestId}`)[0];
      if(duplicate){ if(duplicate.kind!=='COPILOT_SUMMARY' || duplicate.request_hash!==requestHash)throw new HttpError(409,'AI_COPILOT_IDEMPOTENCY_CONFLICT');return { id:duplicate.id,state:duplicate.state,version:duplicate.version,duplicate:true }; }
      if(!testTransport)throw new HttpError(409,'AI_LIVE_DATA_TRANSFER_DISABLED');
      const s=await trustedCopilotSnapshot(tx,actor,request.params.id,session);
      if((await tx`SELECT count(*)::integer AS n FROM ai_campaign_simulation WHERE campaign_id=${s.c.id} AND actor_id=${actor.id} AND state IN ('QUEUED','RUNNING')`)[0]!.n>=10)throw new HttpError(429,'AI_COPILOT_QUEUE_FULL');
      const row=(await tx`INSERT INTO ai_campaign_simulation(kind,lead_id,conversation_id,organization_id,branch_id,campaign_id,actor_id,session_id,request_id,request_hash,question,context,context_hash,references_json)
        VALUES ('COPILOT_SUMMARY',${s.lead.id},${request.params.id},${actor.organizationId},${s.b.id},${s.c.id},${actor.id},${session},${request.body.requestId},${requestHash},${copilotSummaryPurpose},${tx.json(s.context as unknown as postgres.JSONValue)},${s.hash},'[]') RETURNING id,state,version`)[0]!;
      return { ...row,duplicate:false };
    });return reply.code(result.duplicate ? 200 : 202).send(result);
  });
  app.get<{ Params:{ id:string };Querystring:{ before?:string;limit?:number } }>(root,{ schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ before:uuid,limit:{ type:'integer',minimum:1,maximum:50 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'AI_COPILOT_ACCESS_REVOKED');const access=await approvedConversationReadContext(tx,actor,request.params.id,session);
      const limit=request.query.limit ?? 10,cursor=request.query.before ? (await tx`SELECT id,created_at FROM ai_campaign_simulation WHERE kind='COPILOT_SUMMARY' AND lead_id=${access.lead.id} AND conversation_id=${request.params.id} AND id=${request.query.before}`)[0] : null;
      if(request.query.before && !cursor)throw new HttpError(404,'AI_COPILOT_SUMMARY_NOT_FOUND');
      const rows=await tx`SELECT id,state,version,error_code,created_at,updated_at FROM ai_campaign_simulation WHERE kind='COPILOT_SUMMARY' AND lead_id=${access.lead.id} AND conversation_id=${request.params.id}
        AND (${cursor?.id ?? null}::uuid IS NULL OR (created_at,id)<(${cursor?.created_at ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;
      return { items:rows.slice(0,limit),nextBefore:rows.length>limit ? rows[limit-1]!.id : null,executionAvailable:testTransport };
    });
  });
  app.get<{ Params:{ id:string;summaryId:string } }>(root+'/:summaryId',{ schema:{ params:{ ...params,required:['id','summaryId'],properties:{ id:uuid,summaryId:uuid } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'AI_COPILOT_ACCESS_REVOKED');const access=await approvedConversationReadContext(tx,actor,request.params.id,session);
      const row=(await tx`SELECT id,state,version,attempt_count,error_code,result,context,context_hash,references_json,created_at,updated_at FROM ai_campaign_simulation WHERE kind='COPILOT_SUMMARY' AND lead_id=${access.lead.id} AND conversation_id=${request.params.id} AND id=${request.params.summaryId}`)[0];
      if(!row)throw new HttpError(404,'AI_COPILOT_SUMMARY_NOT_FOUND');
      const current=(await tx`SELECT ai_copilot_summary_context(${request.params.id}) AS context`)[0]!.context;
      const history=await tx`SELECT version,state,attempt_count,error_code,created_at FROM ai_simulation_history WHERE simulation_id=${row.id} ORDER BY version`;
      const refs=row.references_json as SimulationReference[];
      // Derived selection remains attributed. Trusted financial counts are current native facts, never model output.
      return { id:row.id,state:row.state,version:row.version,attempt_count:row.attempt_count,error_code:row.error_code,result:row.result,
        created_at:row.created_at,generatedAt:row.state==='COMPLETED' ? row.updated_at : null,contextHash:row.context_hash,
        knowledgeVersion:row.context.campaignContext.knowledge?.version ?? null,
        stale:effectiveConfigHash(current)!==effectiveConfigHash(row.context.summaryContext),
        sourceTruncated:row.context.summaryContext.truncated,sensitiveExcerptsOmitted:refs.length-copilotSafeReferences(refs).length,
        facts:{ messageCount:current.messageCount,confirmedPaymentCount:current.confirmedPaymentCount,enrollmentCount:current.enrollmentCount,lifecycle:current.lifecycle },
        history,readOnly:true,sendAllowed:false,mutationsAllowed:false,executionAvailable:testTransport };
    });
  });
}
