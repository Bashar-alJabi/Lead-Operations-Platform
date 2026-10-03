import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireBranch, requireRole } from '../security.js';

type Window = { start: string; end: string } | null;
type CampaignPolicy = { version: number; sendingWindow: Window; maxAttempts: number | null;
  minIntervalSeconds: number | null };
const idParam = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
const windowSchema = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
  required: ['start','end'], properties: { start: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
    end: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } } }] } as const;

function checkedWindow(window: Window): Window {
  if (window && window.start === window.end) throw new HttpError(400, 'INVALID_SENDING_WINDOW');
  return window;
}

export function registerMessagingPolicyRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>('/api/messaging/branches/:id/policy', {
    schema: { params: idParam },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    requireBranch(actor, request.params.id);
    const branch = (await db`SELECT timezone, messaging_window, messaging_policy_version FROM branch
      WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId}`)[0];
    if (!branch) throw new HttpError(404, 'BRANCH_NOT_FOUND');
    return { timezone: branch.timezone, sendingWindow: branch.messaging_window?.start ? branch.messaging_window : null,
      version: branch.messaging_policy_version };
  });

  app.put<{ Params: { id: string }; Body: { version: number; sendingWindow: Window } }>(
    '/api/messaging/branches/:id/policy', { schema: { params: idParam, body: {
      type: 'object', additionalProperties: false, required: ['version','sendingWindow'], properties: {
        version: { type: 'integer', minimum: 1 }, sendingWindow: windowSchema,
      } } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
      requireBranch(actor, request.params.id);
      const window = checkedWindow(request.body.sendingWindow);
      return db.begin(async (tx) => {
        const branch = (await tx`SELECT messaging_policy_version FROM branch WHERE id = ${request.params.id}
          AND organization_id = ${actor.organizationId} FOR UPDATE`)[0];
        if (!branch) throw new HttpError(404, 'BRANCH_NOT_FOUND');
        if (branch.messaging_policy_version !== request.body.version)
          throw new HttpError(409, 'MESSAGING_POLICY_VERSION_CONFLICT');
        const changed = (await tx`UPDATE branch SET messaging_window = ${tx.json(window ?? {})},
          messaging_policy_version = messaging_policy_version + 1, updated_at = now()
          WHERE id = ${request.params.id} RETURNING messaging_policy_version`)[0]!;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id,
          detail) VALUES (${actor.organizationId}, ${request.params.id}, ${actor.id},
            'BRANCH_MESSAGING_POLICY_UPDATED', 'BRANCH', ${request.params.id},
            ${tx.json({ sendingWindow: window, version: changed.messaging_policy_version })})`;
        return { version: changed.messaging_policy_version };
      });
    });

  app.get<{ Params: { id: string } }>('/api/messaging/campaigns/:id/policy', {
    schema: { params: idParam },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const row = (await db`SELECT c.version, c.messaging_policy, b.messaging_window, b.timezone
      FROM campaign c JOIN branch b ON b.id = c.branch_id
      WHERE c.id = ${request.params.id} AND c.organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR c.branch_id = ${actor.branchId})`)[0];
    if (!row) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
    const policy = row.messaging_policy || {};
    const branchWindow = row.messaging_window?.start ? row.messaging_window : null;
    return { version: row.version, sendingWindow: policy.sendingWindow ?? null,
      effectiveSendingWindow: policy.sendingWindow ?? branchWindow,
      maxAttempts: policy.maxAttempts ?? null, minIntervalSeconds: policy.minIntervalSeconds ?? null,
      timezone: row.timezone, consentRequired: true };
  });

  app.put<{ Params: { id: string }; Body: CampaignPolicy }>('/api/messaging/campaigns/:id/policy', {
    schema: { params: idParam, body: { type: 'object', additionalProperties: false,
      required: ['version','sendingWindow','maxAttempts','minIntervalSeconds'], properties: {
        version: { type: 'integer', minimum: 1 }, sendingWindow: windowSchema,
        maxAttempts: { type: ['integer', 'null'], minimum: 1, maximum: 2147483647 },
        minIntervalSeconds: { type: ['integer', 'null'], minimum: 1, maximum: 2147483647 },
      } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const window = checkedWindow(request.body.sendingWindow);
    return db.begin(async (tx) => {
      const campaign = (await tx`SELECT id, branch_id, version FROM campaign
        WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId}
          AND (${actor.role === 'SUPER_ADMIN'} OR branch_id = ${actor.branchId}) FOR UPDATE`)[0];
      if (!campaign) throw new HttpError(404, 'CAMPAIGN_NOT_FOUND');
      if (campaign.version !== request.body.version) throw new HttpError(409, 'CAMPAIGN_VERSION_CONFLICT');
      const policy = { sendingWindow: window, maxAttempts: request.body.maxAttempts,
        minIntervalSeconds: request.body.minIntervalSeconds };
      const changed = (await tx`UPDATE campaign SET messaging_policy = ${tx.json(policy)},
        version = version + 1, updated_at = now() WHERE id = ${campaign.id} RETURNING version`)[0]!;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id,
        detail) VALUES (${actor.organizationId}, ${campaign.branch_id}, ${actor.id},
          'CAMPAIGN_MESSAGING_POLICY_UPDATED', 'CAMPAIGN', ${campaign.id},
          ${tx.json({ ...policy, version: changed.version })})`;
      return { version: changed.version };
    });
  });
}
