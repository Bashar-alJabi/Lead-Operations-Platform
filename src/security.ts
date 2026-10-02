import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import type { FastifyRequest } from 'fastify';
import type { Database } from './db.js';
import { sessionCookie } from './config.js';

export type Role = 'SUPER_ADMIN' | 'MANAGER' | 'AGENT';
export type Principal = { id: string; organizationId: string; branchId: string | null; role: Role; name: string; email: string };

export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message = code) { super(message); }
}

export function sha256(value: string): Buffer { return createHash('sha256').update(value).digest(); }
export function newToken(): string { return randomBytes(32).toString('base64url'); }
export function safeTokenEqual(left: string, right: string): boolean {
  const a = sha256(left);
  const b = sha256(right);
  return timingSafeEqual(a, b);
}
export async function passwordHash(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) throw new HttpError(400, 'PASSWORD_LENGTH');
  return hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, outputLen: 32, parallelism: 1 });
}
export async function passwordVerify(encoded: string, password: string): Promise<boolean> {
  return verify(encoded, password);
}

export async function principalFromRequest(request: FastifyRequest, db: Database): Promise<Principal> {
  const token = request.cookies[sessionCookie];
  if (!token || token.length > 128) throw new HttpError(401, 'AUTH_REQUIRED');
  const rows = await db`
    SELECT u.id, u.organization_id, u.branch_id, u.role, u.name, u.email
    FROM user_session s JOIN user_account u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256(token)} AND s.revoked_at IS NULL
      AND s.expires_at > now() AND u.active = true LIMIT 1`;
  const user = rows[0];
  if (!user) throw new HttpError(401, 'AUTH_REQUIRED');
  return { id: user.id, organizationId: user.organization_id, branchId: user.branch_id,
    role: user.role, name: user.name, email: user.email };
}

export function requireRole(principal: Principal, ...roles: Role[]): void {
  if (!roles.includes(principal.role)) throw new HttpError(403, 'FORBIDDEN');
}
export function requireBranch(principal: Principal, branchId: string): void {
  if (principal.role !== 'SUPER_ADMIN' && principal.branchId !== branchId) throw new HttpError(403, 'FORBIDDEN');
}

export async function requireLead(db: Database, principal: Principal, leadId: string) {
  const rows = await db`
    SELECT l.id, l.branch_id, l.campaign_id, l.contact_id, l.assigned_agent_id, l.lifecycle,
      l.source_kind, l.needs_attention_reason, l.created_at, l.updated_at,
      c.name AS contact_name, c.phone, c.email
    FROM lead l JOIN contact c ON c.id = l.contact_id
    WHERE l.id = ${leadId} AND l.organization_id = ${principal.organizationId}
      AND (${principal.role === 'SUPER_ADMIN'} OR
        (${principal.role === 'MANAGER'} AND l.branch_id = ${principal.branchId}) OR
        (${principal.role === 'AGENT'} AND l.assigned_agent_id = ${principal.id})) LIMIT 1`;
  if (!rows[0]) throw new HttpError(404, 'LEAD_NOT_FOUND');
  return rows[0];
}
