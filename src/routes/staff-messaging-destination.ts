import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { currentPaymentSession } from '../payments/access.js';
import { HttpError, principalFromRequest, requireRole, type Principal } from '../security.js';

type Transaction = postgres.TransactionSql;
type Destination = { version: number; phone: string | null; consented_since: Date | null; operation: string };
type Change = { version: number; phone: string | null; enabled?: boolean };
const root = '/api/notification-messaging/destination';
const staffRoot = '/api/users/:id/notification-messaging-destination';
const e164 = '^\\+[1-9][0-9]{7,14}$';
const params = { type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
const historyQuery = { type: 'object', additionalProperties: false, properties: {
  before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
} } as const;

async function currentAccess(tx: Transaction, actor: Principal, request: FastifyRequest, manage: boolean, userId: string) {
  if (manage) requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  const scopeFilter = manage && actor.role === 'MANAGER'
    ? tx`AND u.role='AGENT' AND u.branch_id=${actor.branchId}` : tx``;
  const findTarget = (branchId?: string) => tx<{ branch_id: string; role: 'MANAGER' | 'AGENT'; active: boolean }[]>`
    SELECT u.branch_id,u.role,u.active FROM user_account u
    WHERE u.id=${userId} AND u.organization_id=${actor.organizationId} AND u.role IN ('AGENT','MANAGER')
      ${scopeFilter} ${branchId ? tx`AND u.branch_id=${branchId} FOR SHARE OF u` : tx``}`;
  const [candidate] = await findTarget();
  if (!candidate) throw new HttpError(404, 'STAFF_DESTINATION_NOT_FOUND');
  const [branch] = await tx<{ active: boolean }[]>`SELECT active FROM branch WHERE id=${candidate.branch_id}
    AND organization_id=${actor.organizationId} FOR SHARE`;
  const [target] = await findTarget(candidate.branch_id);
  if (!target || !branch) throw new HttpError(404, 'STAFF_DESTINATION_NOT_FOUND');
  const session = await currentPaymentSession(tx, actor, request);
  if (!session) throw new HttpError(403, 'STAFF_DESTINATION_ACCESS_REVOKED');
  return { branchId: target.branch_id, branchActive: branch.active, accountActive: target.active, role: target.role, session };
}

function publicDestination(row?: Destination) {
  return { version: row?.version ?? 0, phoneLast4: row?.phone?.slice(-4) ?? null,
    consented: Boolean(row?.consented_since) };
}

export function registerStaffMessagingDestinationRoutes(app: FastifyInstance, db: Database) {
  for (const manage of [false, true]) {
    const path = manage ? staffRoot : root;
    const resourceSchema = manage ? { params } : {};
    app.get<{ Params: { id: string } }>(path, { schema: resourceSchema }, async request => {
      const actor = await principalFromRequest(request, db);
      const userId = manage ? request.params.id : actor.id;
      return db.begin(async tx => {
        const access = await currentAccess(tx, actor, request, manage, userId);
        const [row] = await tx<Destination[]>`SELECT version,phone,consented_since,operation FROM staff_messaging_destination WHERE user_id=${userId}`;
        return { ...publicDestination(row), canActivate: access.accountActive && access.branchActive };
      });
    });
    app.put<{ Params: { id: string }; Body: Change }>(path, {
      preValidation: async request => {
        const body = request.body;
        if (!body || typeof body.version !== 'number' || !(body.phone === null || typeof body.phone === 'string')
            || !manage && typeof body.enabled !== 'boolean') throw new HttpError(400, 'INVALID_STAFF_DESTINATION_REQUEST');
      },
      schema: { ...resourceSchema, body: { type: 'object', additionalProperties: false,
        required: manage ? ['version','phone'] : ['version','phone','enabled'], properties: {
          version: { type: 'integer', minimum: 0, maximum: 2147483646 },
          phone: { anyOf: [{ type: 'string', pattern: e164, maxLength: 16 }, { type: 'null' }] },
          ...!manage && { enabled: { type: 'boolean' } },
        } } },
    }, async request => {
      const actor = await principalFromRequest(request, db);
      const userId = manage ? request.params.id : actor.id;
      const { version, phone, enabled } = request.body;
      if (!manage && (enabled ? !phone : phone !== null)) throw new HttpError(400, 'STAFF_DESTINATION_CONFIRMATION_REQUIRED');
      try {
        return await db.begin(async tx => {
          const access = await currentAccess(tx, actor, request, manage, userId);
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-messaging:${userId}`},0))`;
          if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'STAFF_DESTINATION_ACCESS_REVOKED');
          const [current] = await tx<Destination[]>`SELECT version,phone,consented_since,operation
            FROM staff_messaging_destination WHERE user_id=${userId} FOR UPDATE`;
          if ((current?.version ?? 0) !== version) throw new HttpError(409, 'STAFF_DESTINATION_VERSION_CONFLICT');
          if ((manage && phone || !manage && enabled) && !(access.accountActive && access.branchActive))
            throw new HttpError(409, 'STAFF_DESTINATION_UNAVAILABLE');
          if (!manage && (!current?.phone || enabled && current.phone !== phone))
            throw new HttpError(409, 'STAFF_DESTINATION_CONFIRMATION_MISMATCH');
          const operation = manage ? 'SET' : enabled ? 'GRANT' : 'REVOKE';
          const destination = manage ? phone : current?.phone ?? null;
          const [saved] = current
            ? await tx<Destination[]>`UPDATE staff_messaging_destination SET version=version+1,phone=${destination},operation=${operation},
                actor_id=${actor.id},session_id=${access.session} WHERE user_id=${userId} RETURNING version,phone,consented_since,operation`
            : await tx<Destination[]>`INSERT INTO staff_messaging_destination(user_id,organization_id,branch_id,user_role,version,phone,operation,actor_id,session_id)
                VALUES(${userId},${actor.organizationId},${access.branchId},${access.role},1,${destination},${operation},${actor.id},${access.session})
                RETURNING version,phone,consented_since,operation`;
          return { ...publicDestination(saved), canActivate: access.accountActive && access.branchActive };
        });
      } catch (error) {
        const failure = error as { code?: string; constraint_name?: string };
        if (failure.code === '23505' && failure.constraint_name === 'staff_messaging_destination_unique_phone')
          throw new HttpError(409, 'STAFF_DESTINATION_UNAVAILABLE');
        throw error;
      }
    });
    app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>(path+'/history', {
      schema: { ...resourceSchema, querystring: historyQuery },
    }, async request => {
      const actor = await principalFromRequest(request, db);
      const userId = manage ? request.params.id : actor.id;
      const limit = request.query.limit ?? 10;
      return db.begin(async tx => {
        const access = await currentAccess(tx, actor, request, manage, userId);
        const rows = await tx`SELECT version,operation,phone_last4 AS "phoneLast4",consented,changed_at AS "changedAt"
          FROM staff_messaging_destination_history WHERE user_id=${userId} AND organization_id=${actor.organizationId}
            AND (${actor.role === 'SUPER_ADMIN'} OR branch_id=${access.branchId})
            AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null})
          ORDER BY version DESC LIMIT ${limit+1}`;
        return { items: rows.slice(0,limit), nextVersion: rows.length>limit ? rows[limit-1]!.version : null };
      });
    });
  }
}
