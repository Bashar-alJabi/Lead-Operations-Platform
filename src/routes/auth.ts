import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database } from '../db.js';
import { isProduction, sessionCookie } from '../config.js';
import { HttpError, newToken, passwordHash, passwordVerify, principalFromRequest, requireBranch, requireRole, safeTokenEqual, sha256 } from '../security.js';

const emailPattern = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';
const passwordSchema = { type: 'string', minLength: 12, maxLength: 256 } as const;

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(sessionCookie, token, { path: '/', httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 60 * 60 * 12 });
}

export function registerAuthRoutes(app: FastifyInstance, db: Database): void {
  app.get('/api/setup/status', async () => {
    const rows = await db`SELECT EXISTS(SELECT 1 FROM user_account) AS initialized`;
    return { initialized: rows[0]?.initialized === true };
  });

  app.post<{ Body: { token: string; organizationName: string; name: string; email: string; password: string } }>(
    '/api/setup/bootstrap', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['token','organizationName','name','email','password'], properties: {
        token: { type: 'string', minLength: 24 }, organizationName: { type: 'string', minLength: 1, maxLength: 200 },
        name: { type: 'string', minLength: 1, maxLength: 200 }, email: { type: 'string', pattern: emailPattern, maxLength: 320 }, password: passwordSchema,
      } } },
    }, async (request, reply) => {
      const expected = process.env.BOOTSTRAP_TOKEN;
      if (!expected || !safeTokenEqual(request.body.token, expected)) throw new HttpError(403, 'BOOTSTRAP_DENIED');
      const hashed = await passwordHash(request.body.password);
      const userId = await db.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(82944602)`;
        const existing = await tx`SELECT 1 FROM user_account LIMIT 1`;
        if (existing.length) throw new HttpError(409, 'ALREADY_INITIALIZED');
        const org = await tx`INSERT INTO organization (name) VALUES (${request.body.organizationName.trim()}) RETURNING id`;
        const orgId = org[0]!.id as string;
        const users = await tx`INSERT INTO user_account (organization_id, role, name, email, password_hash)
          VALUES (${orgId}, 'SUPER_ADMIN', ${request.body.name.trim()}, ${request.body.email.trim()}, ${hashed}) RETURNING id`;
        const id = users[0]!.id as string;
        await tx`INSERT INTO audit_log (organization_id, actor_user_id, action, target_type, target_id)
          VALUES (${orgId}, ${id}, 'FIRST_SUPER_ADMIN_BOOTSTRAP', 'USER', ${id})`;
        return id;
      });
      reply.code(201);
      return { userId, initialized: true };
    });

  app.post<{ Body: { email: string; password: string } }>('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['email','password'], properties: {
      email: { type: 'string', maxLength: 320 }, password: { type: 'string', maxLength: 256 },
    } } },
  }, async (request, reply) => {
    const rows = await db`SELECT id, password_hash, active FROM user_account WHERE email_normalized = ${request.body.email.trim().toLowerCase()} LIMIT 1`;
    const user = rows[0];
    const valid = user && user.active && await passwordVerify(user.password_hash, request.body.password);
    if (!valid) throw new HttpError(401, 'INVALID_CREDENTIALS');
    const token = newToken();
    await db`INSERT INTO user_session (user_id, token_hash, expires_at) VALUES (${user.id}, ${sha256(token)}, now() + interval '12 hours')`;
    setSessionCookie(reply, token);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[sessionCookie];
    if (token) await db`UPDATE user_session SET revoked_at = now() WHERE token_hash = ${sha256(token)} AND revoked_at IS NULL`;
    reply.clearCookie(sessionCookie, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => principalFromRequest(request, db));

  app.get('/api/users', async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const rows = await db`SELECT id, branch_id, role, name, email, active, capacity, working_hours, created_at
      FROM user_account WHERE organization_id = ${actor.organizationId}
      AND (${actor.role === 'SUPER_ADMIN'} OR branch_id = ${actor.branchId})
      ORDER BY created_at DESC LIMIT 100`;
    return { items: rows };
  });

  app.post<{ Body: { branchId?: string; role: 'SUPER_ADMIN'|'MANAGER'|'AGENT'; name: string; email: string; password: string; capacity?: number } }>('/api/users', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['role','name','email','password'], properties: {
      branchId: { type: 'string', format: 'uuid' }, role: { enum: ['SUPER_ADMIN','MANAGER','AGENT'] },
      name: { type: 'string', minLength: 1, maxLength: 200 }, email: { type: 'string', pattern: emailPattern, maxLength: 320 },
      password: passwordSchema, capacity: { type: 'integer', minimum: 0 },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const { branchId, role, name, email, password, capacity } = request.body;
    if (actor.role === 'MANAGER' && role !== 'AGENT') throw new HttpError(403, 'FORBIDDEN');
    if (role === 'SUPER_ADMIN' ? branchId != null : !branchId) throw new HttpError(400, 'INVALID_BRANCH');
    if (branchId) {
      requireBranch(actor, branchId);
      const branches = await db`SELECT 1 FROM branch WHERE id = ${branchId} AND organization_id = ${actor.organizationId} AND active = true`;
      if (!branches.length) throw new HttpError(404, 'BRANCH_NOT_FOUND');
    }
    const hashed = await passwordHash(password);
    const rows = await db.begin(async (tx) => {
      const users = await tx`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash, capacity)
        VALUES (${actor.organizationId}, ${branchId ?? null}, ${role}, ${name.trim()}, ${email.trim()}, ${hashed}, ${capacity ?? null}) RETURNING id`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${branchId ?? null}, ${actor.id}, 'USER_CREATED', 'USER', ${users[0]!.id})`;
      return users;
    });
    reply.code(201);
    return { id: rows[0]!.id };
  });

  app.patch<{ Params: { id: string }; Body: { active: boolean } }>('/api/users/:id/status', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['active'], properties: { active: { type: 'boolean' } } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const rows = await db`SELECT id, branch_id, role FROM user_account WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId}`;
    const target = rows[0];
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND');
    if (actor.id === target.id && !request.body.active) throw new HttpError(409, 'CANNOT_DISABLE_SELF');
    if (actor.role === 'MANAGER' && (target.role !== 'AGENT' || target.branch_id !== actor.branchId)) throw new HttpError(403, 'FORBIDDEN');
    await db.begin(async (tx) => {
      await tx`UPDATE user_account SET active = ${request.body.active}, updated_at = now() WHERE id = ${target.id}`;
      if (!request.body.active) await tx`UPDATE user_session SET revoked_at = now() WHERE user_id = ${target.id} AND revoked_at IS NULL`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${target.branch_id}, ${actor.id}, ${request.body.active ? 'USER_ACTIVATED' : 'USER_DISABLED'}, 'USER', ${target.id})`;
    });
    return { ok: true };
  });
}
