import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { findOperationsQuestion, operationsQuestions } from '../ai/operations-questions.js';
import { analyticsCtes, analyticsMetricPredicate } from '../analytics.js';
import { operationalFilterProperties, prepareLeadFilter, type LeadFilter } from '../lead-query.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { HttpError, lockCurrentSession, principalFromRequest, requireBranch } from '../security.js';

type Input = Pick<LeadFilter,'branchId'|'campaignId'|'from'|'to'> & { question: string; cursor?: string };

export function registerAIOperationsFactsRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/ai/operations/questions', async (request,reply) => {
    await principalFromRequest(request,db);
    reply.header('Cache-Control','no-store');
    return { items: operationsQuestions.map(({key,ar,en,fr})=>({key,ar,en,fr})) };
  });

  app.post<{ Body: Input }>('/api/ai/operations/facts',{ schema: { body: { type: 'object', additionalProperties: false,
    required: ['question'], properties: {
      question: { type: 'string', minLength: 3, maxLength: 240, pattern: '^[^\\x00-\\x1f\\x7f]+$' },
      branchId: operationalFilterProperties.branchId, campaignId: operationalFilterProperties.campaignId,
      from: operationalFilterProperties.from, to: operationalFilterProperties.to,
      cursor: { type: 'string', maxLength: 256 },
    } } } }, async (request,reply) => {
    const actor = await principalFromRequest(request,db), input = request.body;
    const question = findOperationsQuestion(input.question);
    if (!question) throw new HttpError(422,'OPERATIONS_QUESTION_UNSUPPORTED');
    if (question.key==='CAMPAIGN_PERFORMANCE' && !input.campaignId) throw new HttpError(400,'OPERATIONS_CAMPAIGN_REQUIRED');
    if (question.today && (input.from || input.to)) throw new HttpError(400,'OPERATIONS_DATE_CONFLICT');
    const cursor = decodeCursor(input.cursor), limit = 20;
    if (input.branchId) requireBranch(actor,input.branchId);
    reply.header('Cache-Control','no-store');

    return db.begin(async tx => {
      await tx`SET LOCAL statement_timeout='8s'`;
      await tx`SET LOCAL lock_timeout='750ms'`;
      if (!await lockCurrentSession(tx,actor,request)) throw new HttpError(403,'OPERATIONS_ACCESS_REVOKED');
      const branchId = input.branchId ?? actor.branchId;
      const [branch] = branchId ? await tx`SELECT timezone FROM branch WHERE id=${branchId} AND organization_id=${actor.organizationId}` : [];
      if (branchId && !branch) throw new HttpError(404,'BRANCH_NOT_FOUND');
      const timezone = branch?.timezone ?? 'UTC';
      const [period] = await tx`SELECT statement_timestamp() AS now,
        date_trunc('day',statement_timestamp() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone} AS day_start`;
      const q: LeadFilter = { branchId: branchId ?? undefined, campaignId: input.campaignId, paymentMode: 'LIVE',
        from: question.today ? period!.day_start.toISOString() : input.from, to: question.today ? period!.now.toISOString() : input.to };
      const field = await prepareLeadFilter(tx,actor,q);
      const [result] = await tx`${analyticsCtes(tx,actor,q,field)}, matches AS MATERIALIZED (
        SELECT f.id,f.campaign_name,f.branch_name,f.contact_id,f.created_at FROM facts f WHERE ${analyticsMetricPredicate(tx,question.metric)}
      ), page AS (
        SELECT m.id,m.campaign_name,m.branch_name,c.name AS contact_name,m.created_at,m.created_at::text AS cursor_at
        FROM matches m LEFT JOIN contact c ON c.id=m.contact_id
        WHERE (${cursor?.timestamp??null}::text::timestamptz IS NULL OR (m.created_at,m.id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
        ORDER BY m.created_at DESC,m.id DESC LIMIT ${limit+1}
      ) SELECT (SELECT count(*)::text FROM matches) AS count,
        COALESCE((SELECT jsonb_agg(page ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb) AS items,
        CASE WHEN ${question.key==='CAMPAIGN_PERFORMANCE'} THEN (
          SELECT jsonb_build_object('aiContacted',count(*) FILTER(WHERE f.first_ai IS NOT NULL)::text,
            'humanContacted',count(*) FILTER(WHERE f.first_human IS NOT NULL)::text,
            'customerResponded',count(*) FILTER(WHERE f.first_customer_response IS NOT NULL)::text,
            'converted',count(*) FILTER(WHERE f.converted)::text,'conversionConfigured',count(*) FILTER(WHERE f.conversion_defined)::text,
            'aiAttempts',coalesce(sum(f.ai_attempts),0)::text,'humanAttempts',coalesce(sum(f.human_attempts),0)::text)
          FROM facts f) END AS performance`;
      const items = result!.items.slice(0,limit), last = items.at(-1);
      await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES(${actor.organizationId},${branchId},${actor.id},'AI_OPERATIONS_FACTS_READ','USER',${actor.id},
          ${tx.json({question:question.key,metric:question.metric,basis:'CURRENT_LEAD_CREATED_COHORT'})})`;
      return { key:question.key,metric:question.metric,source:'PLATFORM_ANALYTICS',count:result!.count,performance:result!.performance,
        from:q.from??null,to:q.to??null,timezone,asOf:period!.now,items,
        nextCursor:result!.items.length>limit && last ? encodeCursor({timestamp:last.cursor_at,id:last.id}) : null };
    });
  });
}
