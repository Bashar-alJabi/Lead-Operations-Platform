import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { currentPaymentSession } from '../payments/access.js';
import { HttpError, principalFromRequest, requireRole } from '../security.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const day = { type: 'string', format: 'date', pattern: '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$' } as const;
const code = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Z][A-Z0-9_]*$' } as const;
const uuidPattern = '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$';
const lastBigInt = 9223372036854775807n;

type AuditQuery = {
  branchId?: string;
  actorId?: string;
  targetId?: string;
  action?: string;
  from?: string;
  through?: string;
  before?: string;
  limit?: number;
};

export function registerAuditRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Querystring: AuditQuery }>('/api/audit-events', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      branchId: uuid, actorId: uuid, targetId: uuid, action: code, from: day, through: day,
      before: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    reply.header('Cache-Control', 'no-store');
    const q = request.query;
    if (q.from && q.through && q.from > q.through) throw new HttpError(400, 'INVALID_DATE_RANGE');
    if (q.before && BigInt(q.before) > lastBigInt) throw new HttpError(400, 'INVALID_CURSOR');
    const limit = q.limit ?? 25;

    return db.begin(async tx => {
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'AUDIT_ACCESS_REVOKED');
      const requestedBranch = q.branchId?.toLowerCase();
      if (actor.role === 'MANAGER' && (!actor.branchId || requestedBranch && requestedBranch !== actor.branchId)) {
        throw new HttpError(404, 'AUDIT_BRANCH_NOT_FOUND');
      }
      const branchId = actor.role === 'MANAGER' ? actor.branchId : requestedBranch ?? null;
      if (branchId && !(await tx`SELECT 1 FROM branch WHERE id=${branchId} AND organization_id=${actor.organizationId}`).length) {
        throw new HttpError(404, 'AUDIT_BRANCH_NOT_FOUND');
      }

      // Project only identifiers and typed columns. Legacy event details may contain private text and are never returned.
      const rows = await tx`SELECT a.id::text AS id,a.created_at AS "createdAt",a.action,a.target_type AS "targetType",
        CASE WHEN a.target_id ~ ${uuidPattern} THEN a.target_id END AS "targetId",a.branch_id AS "branchId",b.name AS "branchName",
        u.id AS "actorId",u.name AS "actorName",(a.actor_user_id IS NULL) AS "systemActor",
        CASE WHEN a.action='LEAD_LIFECYCLE_CHANGED'
          AND a.detail->>'from' IN ('OPEN','CLOSED','ARCHIVED') AND a.detail->>'to' IN ('OPEN','CLOSED','ARCHIVED')
          THEN jsonb_build_object('from',a.detail->>'from','to',a.detail->>'to') END AS "lifecycleChange"
        FROM audit_log a
        LEFT JOIN branch b ON b.id=a.branch_id AND b.organization_id=a.organization_id
        LEFT JOIN user_account u ON u.id=a.actor_user_id AND u.organization_id=a.organization_id
         AND (${actor.role === 'SUPER_ADMIN'} OR u.branch_id=a.branch_id)
        WHERE a.organization_id=${actor.organizationId} AND (${branchId}::uuid IS NULL OR a.branch_id=${branchId})
          AND (${q.before ?? null}::bigint IS NULL OR a.id<${q.before ?? null}::bigint)
          AND (${q.action ?? null}::text IS NULL OR a.action=${q.action ?? null})
          AND (${q.actorId ?? null}::uuid IS NULL OR u.id=${q.actorId ?? null})
          AND (${q.targetId?.toLowerCase() ?? null}::text IS NULL OR a.target_id=${q.targetId?.toLowerCase() ?? null})
          AND (${q.from ?? null}::date IS NULL OR a.created_at>=(${q.from ?? null}::date::timestamp AT TIME ZONE 'UTC'))
          AND (${q.through ?? null}::date IS NULL OR a.created_at<((${q.through ?? null}::date+1)::timestamp AT TIME ZONE 'UTC'))
        ORDER BY a.id DESC LIMIT ${limit+1}`;
      const items = rows.slice(0, limit);
      return { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null };
    });
  });
}
