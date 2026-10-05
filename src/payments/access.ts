import type postgres from 'postgres';
import type { FastifyRequest } from 'fastify';
import { sessionCookie } from '../config.js';
import { sha256,type Principal } from '../security.js';

export async function currentPaymentActor(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest) {
  const token=request.cookies[sessionCookie];
  if (!token) return false;
  return (await tx`SELECT 1 FROM user_account u JOIN user_session ss ON ss.user_id=u.id
    WHERE u.id=${actor.id} AND u.active AND u.organization_id=${actor.organizationId} AND u.role=${actor.role}
      AND u.branch_id IS NOT DISTINCT FROM ${actor.branchId}::uuid AND ss.token_hash=${sha256(token)}
      AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp() FOR SHARE OF u,ss`).length>0;
}
