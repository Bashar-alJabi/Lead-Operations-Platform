import type postgres from 'postgres';
import type { FastifyRequest } from 'fastify';
import { HttpError, requireRole, type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
export async function aiConfigurationBranch(tx: postgres.TransactionSql, actor: Principal, id: string, request: FastifyRequest, write = false) {
  requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  const b = (await tx`SELECT id,organization_id,active,timezone,messaging_window,messaging_policy_version,default_sender_id FROM branch WHERE id=${id} AND organization_id=${actor.organizationId} AND (${actor.role === 'SUPER_ADMIN'} OR id=${actor.branchId}) FOR SHARE`)[0];
  if (!b) throw new HttpError(404, 'BRANCH_NOT_FOUND');
  const sessionId = await currentPaymentSession(tx, actor, request);
  if (!sessionId) throw new HttpError(403, 'AI_OPERATIONAL_ACCESS_REVOKED');
  if (write && !b.active) throw new HttpError(409, 'BRANCH_DISABLED');
  return { b, sessionId };
}
