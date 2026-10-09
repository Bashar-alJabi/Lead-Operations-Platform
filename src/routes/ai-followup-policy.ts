import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest } from '../security.js';
import { knowledgeCampaign } from './ai-knowledge.js';
import { emptyAIFollowupPolicy, normalizeAIFollowupPolicy, aiFollowupPolicySchema, evaluateAIFollowupTiming, aiFollowupMandatoryStops, type AIFollowupPolicy } from '../ai/followup-policy.js';
const uuid = { type: 'string', format: 'uuid' } as const;
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } } as const;
export function registerAIFollowupPolicyRoutes(app: FastifyInstance, db: Database) {
  const root = '/api/ai/campaigns/:id/followup-policy';
  app.get<{ Params: { id: string } }>(root, { schema: { params } }, async request => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => { const { c } = await knowledgeCampaign(tx, actor, request.params.id, request);
      const current = (await tx`SELECT version,definition,actor_id,reason,updated_at FROM ai_followup_policy WHERE campaign_id=${c.id} FOR SHARE`)[0] ?? { version: 0, definition: emptyAIFollowupPolicy() };
      return { ...current, mandatoryStops: aiFollowupMandatoryStops, messagingPolicy: c.messaging_policy, runtimeImplemented: false }; });
  });
  app.put<{ Params: { id: string }; Body: { version: number; definition: AIFollowupPolicy; reason: string } }>(root, {
    bodyLimit: 16384, schema: { params, body: { type: 'object', additionalProperties: false, required: ['version', 'definition', 'reason'], properties: {
      version: { type: 'integer', minimum: 0 }, definition: aiFollowupPolicySchema, reason: { type: 'string', minLength: 3, maxLength: 500, pattern: '^[^\\x00-\\x1f\\x7f]+$' },
    } } },
  }, async request => {
    const actor = await principalFromRequest(request, db), definition = normalizeAIFollowupPolicy(request.body.definition), reason = request.body.reason.trim();
    if (reason.length < 3 || Buffer.from(reason).toString() !== reason) throw new HttpError(400, 'AI_FOLLOWUP_REASON_REQUIRED');
    return db.begin(async tx => {
      const { c, sessionId } = await knowledgeCampaign(tx, actor, request.params.id, request, true);
      const old = (await tx`SELECT version FROM ai_followup_policy WHERE campaign_id=${c.id} FOR UPDATE`)[0];
      if ((old?.version ?? 0) !== request.body.version) throw new HttpError(409, 'AI_FOLLOWUP_VERSION_CONFLICT');
      if (old) await tx`UPDATE ai_followup_policy SET version=version+1,definition=${tx.json(definition)},actor_id=${actor.id},session_id=${sessionId},reason=${reason} WHERE campaign_id=${c.id}`;
      else await tx`INSERT INTO ai_followup_policy(campaign_id,version,definition,actor_id,session_id,reason) VALUES (${c.id},1,${tx.json(definition)},${actor.id},${sessionId},${reason})`;
      return { version: request.body.version + 1, runtimeImplemented: false };
    });
  });
  app.post<{ Params: { id: string }; Body: { version: number; definition: AIFollowupPolicy; anchorAt: string; attemptsSent: number; hasInboundReply: boolean; leadLifecycle: 'OPEN' | 'CLOSED' | 'ARCHIVED'; controllerType: 'AI' | 'HUMAN' | 'NONE'; conversationState: string } }>(root + '/preview', {
    bodyLimit: 16384, schema: { params, body: { type: 'object', additionalProperties: false, required: ['version', 'definition', 'anchorAt', 'attemptsSent', 'hasInboundReply', 'leadLifecycle', 'controllerType', 'conversationState'], properties: {
      version: { type: 'integer', minimum: 0 }, definition: aiFollowupPolicySchema, anchorAt: { type: 'string', format: 'date-time' }, attemptsSent: { type: 'integer', minimum: 0, maximum: 2147483647 }, hasInboundReply: { type: 'boolean' },
      leadLifecycle: { enum: ['OPEN', 'CLOSED', 'ARCHIVED'] }, controllerType: { enum: ['AI', 'HUMAN', 'NONE'] }, conversationState: { enum: ['AI_ACTIVE', 'AI_WAITING_FOR_LEAD', 'AI_HANDOFF_REQUIRED', 'WAITING_FOR_HUMAN', 'HUMAN_ACTIVE', 'CLOSED'] },
    } } },
  }, async request => {
    const actor = await principalFromRequest(request, db), p = normalizeAIFollowupPolicy(request.body.definition);
    return db.begin(async tx => {
      await knowledgeCampaign(tx, actor, request.params.id, request);
      const version = (await tx`SELECT version FROM ai_followup_policy WHERE campaign_id=${request.params.id} FOR SHARE`)[0]?.version ?? 0;
      if (version !== request.body.version) throw new HttpError(409, 'AI_FOLLOWUP_VERSION_CONFLICT');
      const now = (await tx`SELECT clock_timestamp() AS now`)[0]!.now as Date;
      return { ...evaluateAIFollowupTiming(p, { ...request.body, anchorAt: new Date(request.body.anchorAt), now }),
        initialEligibleAt: new Date(new Date(request.body.anchorAt).getTime() + p.initialDelaySeconds * 1000).toISOString(), evaluatedAt: now.toISOString(), mandatoryStops: aiFollowupMandatoryStops, previewOnly: true };
    });
  });
  app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>(root + '/history', { schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }, async request => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => { await knowledgeCampaign(tx, actor, request.params.id, request); const limit = request.query.limit ?? 20;
      const rows = await tx`SELECT version,reason,actor_id,created_at FROM ai_followup_policy_history WHERE campaign_id=${request.params.id} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit + 1}`;
      return { items: rows.slice(0, limit), nextVersion: rows.length > limit ? rows[limit - 1]!.version : null }; });
  });
  app.get<{ Params: { id: string; version: number } }>(root + '/versions/:version', { schema: { params: { ...params, required: ['id', 'version'], properties: { id: uuid, version: { type: 'integer', minimum: 1 } } } } }, async request => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async tx => { await knowledgeCampaign(tx, actor, request.params.id, request);
      const row = (await tx`SELECT version,definition,reason,actor_id,created_at FROM ai_followup_policy_history WHERE campaign_id=${request.params.id} AND version=${request.params.version}`)[0];
      if (!row) throw new HttpError(404, 'AI_FOLLOWUP_VERSION_NOT_FOUND'); return row; });
  });
}
