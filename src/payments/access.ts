import type postgres from 'postgres';
import type { FastifyRequest } from 'fastify';
import { sessionCookie } from '../config.js';
import { sha256,type Principal } from '../security.js';

export async function currentPaymentSession(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest):Promise<string|null> {
  const token=request.cookies[sessionCookie];
  if (!token) return null;
  return (await tx`SELECT ss.id FROM user_account u JOIN user_session ss ON ss.user_id=u.id
    WHERE u.id=${actor.id} AND u.active AND u.organization_id=${actor.organizationId} AND u.role=${actor.role}
      AND u.branch_id IS NOT DISTINCT FROM ${actor.branchId}::uuid AND ss.token_hash=${sha256(token)}
      AND ss.revoked_at IS NULL AND ss.expires_at>clock_timestamp() FOR SHARE OF u,ss`)[0]?.id ?? null;
}
export async function currentPaymentActor(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest) {
  return (await currentPaymentSession(tx,actor,request))!==null;
}
