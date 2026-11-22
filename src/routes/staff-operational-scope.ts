import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, lockCurrentSession, principalFromRequest, requireRole } from '../security.js';

const root = '/api/users/:id/operational-scope';
const uuid = { type: 'string', format: 'uuid' } as const;
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } } as const;
type Resource = { id: string };
type Input = { branchId: string; role: 'AGENT'|'MANAGER'; version: number; reason: string };

export function registerStaffOperationalScopeRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Params: Resource; Querystring: { before?: number; limit?: number } }>(root, { schema: { params,
    querystring: { type: 'object', additionalProperties: false, properties: {
      before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    } } } }, async (request, reply) => {
    const actor = await principalFromRequest(request,db), limit = request.query.limit ?? 15;
    requireRole(actor,'SUPER_ADMIN');
    reply.header('Cache-Control','no-store');
    return db.begin(async tx => {
      if (!await lockCurrentSession(tx,actor,request)) throw new HttpError(403,'STAFF_SCOPE_ACCESS_REVOKED');
      const [target] = await tx`SELECT id,role,branch_id AS "branchId",operational_scope_version AS version
        FROM user_account WHERE id=${request.params.id} AND organization_id=${actor.organizationId}
          AND role IN ('MANAGER','AGENT') FOR SHARE`;
      if (!target) throw new HttpError(404,'USER_NOT_FOUND');
      const rows = await tx`SELECT h.version,h.previous_role AS "previousRole",h.role,h.reason,h.created_at AS "createdAt",
        previous.name AS "previousBranch",current_branch.name AS branch
        FROM staff_operational_scope_history h JOIN branch previous ON previous.id=h.previous_branch_id
        JOIN branch current_branch ON current_branch.id=h.branch_id
        WHERE h.user_id=${target.id} AND (${request.query.before ?? null}::int IS NULL OR h.version<${request.query.before ?? null})
        ORDER BY h.version DESC LIMIT ${limit+1}`;
      return { ...target, items: rows.slice(0,limit), nextBefore: rows.length>limit ? rows[limit-1]!.version : null };
    });
  });

  app.put<{ Params: Resource; Body: Input }>(root,{ schema: { params,
    body: { type: 'object', additionalProperties: false, required: ['branchId','role','version','reason'], properties: {
      branchId: uuid, role: { enum: ['AGENT','MANAGER'] }, version: { type: 'integer', minimum: 0, maximum: 2147483646 },
      reason: { type: 'string', minLength: 3, maxLength: 500 },
    } } } }, async request => {
    const actor = await principalFromRequest(request,db), input = request.body;
    requireRole(actor,'SUPER_ADMIN');
    try {
      return await db.begin(async tx => {
        const session = await lockCurrentSession(tx,actor,request);
        if (!session) throw new HttpError(403,'STAFF_SCOPE_ACCESS_REVOKED');
        const [result] = await tx`SELECT change_staff_operational_scope(${request.params.id},${input.version},${input.branchId},
          ${input.role},${actor.id},${session},${input.reason}) AS version`;
        return result!;
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code==='P0001') {
        switch (error.message) {
          case 'STAFF_SCOPE_ACCESS_REVOKED': throw new HttpError(403,error.message);
          case 'USER_NOT_FOUND': throw new HttpError(404,error.message);
          case 'STAFF_SCOPE_REASON_INVALID':
          case 'STAFF_SCOPE_DESTINATION_INVALID': throw new HttpError(400,error.message);
          case 'STAFF_SCOPE_VERSION_CONFLICT':
          case 'STAFF_SCOPE_REASSIGN_WORK': throw new HttpError(409,error.message);
        }
      }
      throw error;
    }
  });
}
