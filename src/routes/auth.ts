import type { FastifyInstance, FastifyReply } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { isProduction, sessionCookie } from '../config.js';
import { HttpError, lockCurrentSession, newToken, passwordHash, passwordVerify, principalFromRequest, requireBranch, requireRole, safeTokenEqual, sha256 } from '../security.js';
import { enqueueIdentityEmail, identityEmailConnection } from '../identity-email.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { registerAgentProfileRoutes } from './agent-profile.js';
import { registerStaffOperationalScopeRoutes } from './staff-operational-scope.js';

const emailPattern = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';
const passwordSchema = { type: 'string', minLength: 12, maxLength: 256 } as const;

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(sessionCookie, token, { path: '/', httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 60 * 60 * 12 });
}

type ResetAccount={id:string;organizationId:string;branchId:string|null;email:string};

// Call while holding the target account lock, shared by both ways of requesting a reset.
async function queuePasswordReset(tx:postgres.TransactionSql,target:ResetAccount,connectionId:string,operator?:{id:string;reason:string}) {
  const [recent]=await tx`SELECT 1 FROM credential_token WHERE user_id=${target.id} AND purpose='RESET' AND used_at IS NULL
    AND expires_at>statement_timestamp() AND created_at>statement_timestamp()-interval '2 minutes' LIMIT 1`;
  if (recent) return false;
  await tx`UPDATE credential_token SET used_at=clock_timestamp() WHERE user_id=${target.id} AND purpose='RESET' AND used_at IS NULL`;
  await enqueueIdentityEmail(tx,{userId:target.id,recipient:target.email,purpose:'RESET',connectionId});
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES(${target.organizationId},${target.branchId},${operator?.id??null},${operator?'ADMIN_PASSWORD_RESET_REQUESTED':'PASSWORD_RESET_REQUESTED'},
      'USER',${target.id},${tx.json(operator?{reason:operator.reason}:{})})`;
  return true;
}

export function registerAuthRoutes(app: FastifyInstance, db: Database): void {
  registerAgentProfileRoutes(app,db);
  registerStaffOperationalScopeRoutes(app,db);
  app.get('/api/setup/status', async () => {
    const rows = await db`SELECT EXISTS(SELECT 1 FROM user_account) AS initialized`;
    return { initialized: rows[0]?.initialized === true };
  });

  app.post<{ Body: { token: string; organizationName: string; name: string; email: string; password: string } }>(
    '/api/setup/bootstrap', {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
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
    const rows = await db`SELECT id,password_hash,active,credential_state,operational_scope_version
      FROM user_account WHERE email_normalized=${request.body.email.trim().toLowerCase()} LIMIT 1`;
    const user = rows[0];
    const valid = user && user.active && user.credential_state === 'READY' && user.password_hash &&
      await passwordVerify(user.password_hash, request.body.password);
    if (!valid) throw new HttpError(401, 'INVALID_CREDENTIALS');
    const token = newToken();
    await db.begin(async tx => {
      const [current] = await tx`SELECT id FROM user_account WHERE id=${user.id} AND active AND credential_state='READY'
        AND password_hash=${user.password_hash} AND operational_scope_version=${user.operational_scope_version} FOR SHARE`;
      if (!current) throw new HttpError(401,'INVALID_CREDENTIALS');
      await tx`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${current.id},${sha256(token)},now()+interval '12 hours')`;
    });
    setSessionCookie(reply, token);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[sessionCookie];
    if (token) await db`UPDATE user_session SET revoked_at = now() WHERE token_hash = ${sha256(token)} AND revoked_at IS NULL`;
    reply.clearCookie(sessionCookie, { path: '/' });
    return { ok: true };
  });

  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/api/auth/password', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['currentPassword','newPassword'], properties: {
      currentPassword: { type: 'string', minLength: 1, maxLength: 256 }, newPassword: passwordSchema,
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    const newHash = await passwordHash(request.body.newPassword);
    await db.begin(async (tx) => {
      const rows = await tx`SELECT password_hash FROM user_account WHERE id = ${actor.id} AND active = true FOR UPDATE`;
      if (!rows[0] || !await passwordVerify(rows[0].password_hash, request.body.currentPassword)) {
        throw new HttpError(401, 'INVALID_CREDENTIALS');
      }
      await tx`UPDATE user_account SET password_hash = ${newHash}, updated_at = now() WHERE id = ${actor.id}`;
      await tx`UPDATE user_session SET revoked_at = now() WHERE user_id = ${actor.id} AND revoked_at IS NULL`;
      await tx`UPDATE credential_token SET used_at = now() WHERE user_id = ${actor.id} AND used_at IS NULL`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${actor.branchId}, ${actor.id}, 'PASSWORD_CHANGED', 'USER', ${actor.id})`;
    });
    reply.clearCookie(sessionCookie, { path: '/' });
    return { ok: true };
  });

  app.post<{ Body: { email: string } }>('/api/auth/forgot', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['email'], properties: {
      email: { type: 'string', pattern: emailPattern, maxLength: 320 },
    } } },
  }, async (request, reply) => {
    const generic = { accepted: true };
    const users = await db`SELECT id, organization_id, branch_id, email FROM user_account
      WHERE email_normalized = ${request.body.email.trim().toLowerCase()} AND active = true
        AND credential_state = 'READY' LIMIT 1`;
    const user = users[0];
    if (!user) { reply.code(202); return generic; }
    const connection = await identityEmailConnection(db, String(user.organization_id));
    if (!connection || connection.status !== 'CONNECTED' || !connection.ciphertext) {
      reply.code(202); return generic;
    }
    await db.begin(async (tx) => {
      const [locked] = await tx`SELECT id,organization_id,branch_id,email FROM user_account WHERE id = ${user.id}
        AND organization_id=${user.organization_id} AND active = true AND credential_state = 'READY' FOR UPDATE`;
      if (!locked) return;
      await queuePasswordReset(tx,{id:locked.id,organizationId:locked.organization_id,branchId:locked.branch_id,email:locked.email},connection.id);
    });
    reply.code(202); return generic;
  });

  app.post<{Params:{id:string};Body:{reason:string}}>('/api/users/:id/password-reset',{
    config:{rateLimit:{max:10,timeWindow:'15 minutes'}},schema:{params:{type:'object',additionalProperties:false,required:['id'],
      properties:{id:{type:'string',format:'uuid'}}},body:{type:'object',additionalProperties:false,required:['reason'],properties:{
        reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$'},
      }}},
  },async(request,reply)=>{
    const actor=await principalFromRequest(request,db);
    requireRole(actor,'SUPER_ADMIN');
    const reason=request.body.reason.trim();
    if (reason.length<3) throw new HttpError(400,'PASSWORD_RESET_REASON_REQUIRED');
    const delivery=await db.begin(async tx=>{
      const [target]=await tx`SELECT id,branch_id,organization_id,email,active,credential_state FROM user_account
        WHERE id=${request.params.id} AND organization_id=${actor.organizationId} AND role IN ('MANAGER','AGENT') FOR UPDATE`;
      if (!target) throw new HttpError(404,'USER_NOT_FOUND');
      if (!await lockCurrentSession(tx,actor,request)) throw new HttpError(403,'PASSWORD_RESET_ACCESS_REVOKED');
      if (!target.active || target.credential_state!=='READY') throw new HttpError(409,'PASSWORD_RESET_NOT_AVAILABLE');
      const connection=await identityEmailConnection(tx as unknown as Database,actor.organizationId);
      if (!connection || connection.status!=='CONNECTED' || !connection.ciphertext) throw new HttpError(409,'IDENTITY_EMAIL_UNAVAILABLE');
      const queued=await queuePasswordReset(tx,{id:target.id,organizationId:target.organization_id,branchId:target.branch_id,email:target.email},
        connection.id,{id:actor.id,reason});
      return queued?'QUEUED':'RECENT_REQUEST';
    });
    reply.header('Cache-Control','no-store').code(202);
    return {delivery};
  });

  app.post<{ Body: { token: string; password: string } }>('/api/auth/reset', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['token','password'], properties: {
      token: { type: 'string', minLength: 32, maxLength: 128 }, password: passwordSchema,
    } } },
  }, async (request) => {
    const hashed = await passwordHash(request.body.password);
    await db.begin(async (tx) => {
      const tokenHash=sha256(request.body.token);
      const [row]=await tx`SELECT u.id,u.organization_id,u.branch_id FROM user_account u JOIN credential_token t ON t.user_id=u.id
        WHERE t.token_hash=${tokenHash} AND t.purpose='RESET' AND u.active AND u.credential_state='READY' FOR UPDATE OF u`;
      if (!row || !(await tx`SELECT 1 FROM credential_token WHERE user_id=${row.id} AND token_hash=${tokenHash} AND purpose='RESET'
        AND used_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`).length) throw new HttpError(400,'INVALID_RESET_TOKEN');
      await tx`UPDATE user_account SET password_hash = ${hashed}, updated_at = now() WHERE id = ${row.id}`;
      await tx`UPDATE credential_token SET used_at = now() WHERE user_id = ${row.id} AND used_at IS NULL`;
      await tx`UPDATE user_session SET revoked_at = now() WHERE user_id = ${row.id} AND revoked_at IS NULL`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, action, target_type, target_id)
        VALUES (${row.organization_id}, ${row.branch_id}, 'PASSWORD_RESET_COMPLETED', 'USER', ${row.id})`;
    });
    return { ok: true };
  });

  app.post<{ Body: { token: string; password: string } }>('/api/auth/invitations/accept', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['token','password'], properties: {
      token: { type: 'string', minLength: 32, maxLength: 128 }, password: passwordSchema,
    } } },
  }, async (request) => {
    const hashed = await passwordHash(request.body.password);
    await db.begin(async (tx) => {
      const rows = await tx`SELECT t.id AS token_id, u.id AS user_id, u.organization_id, u.branch_id
        FROM credential_token t JOIN user_account u ON u.id = t.user_id
        WHERE t.token_hash = ${sha256(request.body.token)} AND t.purpose = 'INVITATION'
          AND t.used_at IS NULL AND t.expires_at > now() AND u.active = true AND u.credential_state = 'INVITED'
        FOR UPDATE OF t, u`;
      const row = rows[0];
      if (!row) throw new HttpError(400, 'INVALID_INVITATION_TOKEN');
      await tx`UPDATE user_account SET password_hash = ${hashed}, credential_state = 'READY', updated_at = now()
        WHERE id = ${row.user_id}`;
      await tx`UPDATE credential_token SET used_at = now() WHERE user_id = ${row.user_id} AND used_at IS NULL`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${row.organization_id}, ${row.branch_id}, ${row.user_id}, 'INVITATION_ACCEPTED', 'USER', ${row.user_id})`;
    });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => principalFromRequest(request, db));

  app.get<{ Querystring: { limit?: number; cursor?: string } }>('/api/users', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 256 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const cursor = decodeCursor(request.query.cursor);
    const limit = request.query.limit ?? 50;
    return db.begin(async tx => {
      if (!await lockCurrentSession(tx,actor,request)) throw new HttpError(403,'STAFF_SCOPE_ACCESS_REVOKED');
      const rows = await tx`SELECT id,branch_id,role,name,email,active,credential_state,capacity,working_hours,created_at
        FROM user_account WHERE organization_id=${actor.organizationId}
        AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId})
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;
      const items = rows.slice(0,limit), last = items.at(-1);
      return { items, nextCursor: rows.length>limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
    });
  });

  app.post<{ Body: { branchId?: string; role: 'SUPER_ADMIN'|'MANAGER'|'AGENT'; name: string; email: string; capacity?: number } }>('/api/users', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['role','name','email'], properties: {
      branchId: { type: 'string', format: 'uuid' }, role: { enum: ['SUPER_ADMIN','MANAGER','AGENT'] },
      name: { type: 'string', minLength: 1, maxLength: 200 }, email: { type: 'string', pattern: emailPattern, maxLength: 320 },
      capacity: { type: 'integer', minimum: 0 },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const { branchId, role, name, email, capacity } = request.body;
    if (actor.role === 'MANAGER' && role !== 'AGENT') throw new HttpError(403, 'FORBIDDEN');
    if (role === 'SUPER_ADMIN' ? branchId != null : !branchId) throw new HttpError(400, 'INVALID_BRANCH');
    if (branchId) requireBranch(actor,branchId);
    const connection = await identityEmailConnection(db, actor.organizationId);
    if (!connection || connection.status !== 'CONNECTED' || !connection.ciphertext) throw new HttpError(409, 'IDENTITY_EMAIL_UNAVAILABLE');
    const id = await db.begin(async (tx) => {
      if (branchId && !(await tx`SELECT id FROM branch WHERE id=${branchId} AND organization_id=${actor.organizationId} AND active FOR SHARE`).length)
        throw new HttpError(404,'BRANCH_NOT_FOUND');
      if (!await lockCurrentSession(tx,actor,request)) throw new HttpError(403,'STAFF_SCOPE_ACCESS_REVOKED');
      const users = await tx`INSERT INTO user_account
        (organization_id, branch_id, role, name, email, password_hash, credential_state, capacity)
        VALUES (${actor.organizationId}, ${branchId ?? null}, ${role}, ${name.trim()}, ${email.trim()}, NULL, 'INVITED', ${capacity ?? null})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (!users[0]) throw new HttpError(409, 'USER_ALREADY_EXISTS');
      const userId = String(users[0].id);
      await enqueueIdentityEmail(tx, { userId, recipient: email.trim(), purpose: 'INVITATION', connectionId: String(connection.id) });
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${branchId ?? null}, ${actor.id}, 'USER_INVITED', 'USER', ${userId})`;
      return userId;
    });
    reply.code(201); return { id, delivery: 'QUEUED' };
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/invitation', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const connection = await identityEmailConnection(db, actor.organizationId);
    if (!connection || connection.status !== 'CONNECTED' || !connection.ciphertext) throw new HttpError(409, 'IDENTITY_EMAIL_UNAVAILABLE');
    await db.begin(async (tx) => {
      const rows = await tx`SELECT id, branch_id, role, email, active, credential_state FROM user_account
        WHERE id = ${request.params.id} AND organization_id = ${actor.organizationId} FOR UPDATE`;
      const target = rows[0];
      if (!target) throw new HttpError(404, 'USER_NOT_FOUND');
      if (!await lockCurrentSession(tx,actor,request)) throw new HttpError(403,'STAFF_SCOPE_ACCESS_REVOKED');
      if (actor.role === 'MANAGER' && (target.role !== 'AGENT' || target.branch_id !== actor.branchId)) throw new HttpError(403, 'FORBIDDEN');
      if (!target.active || target.credential_state !== 'INVITED') throw new HttpError(409, 'INVITATION_NOT_AVAILABLE');
      await tx`UPDATE credential_token SET used_at = now() WHERE user_id = ${target.id} AND purpose = 'INVITATION' AND used_at IS NULL`;
      await enqueueIdentityEmail(tx, { userId: String(target.id), recipient: String(target.email), purpose: 'INVITATION', connectionId: String(connection.id) });
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${target.branch_id}, ${actor.id}, 'INVITATION_RESENT', 'USER', ${target.id})`;
    });
    return { delivery: 'QUEUED' };
  });

  app.patch<{ Params: { id: string }; Body: { active: boolean } }>('/api/users/:id/status', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['active'], properties: { active: { type: 'boolean' } } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    await db.begin(async (tx) => {
      const accounts = await tx`SELECT id,branch_id,role FROM user_account WHERE id IN (${actor.id},${request.params.id})
        AND organization_id=${actor.organizationId} ORDER BY id FOR UPDATE`;
      const target = accounts.find(account => account.id===request.params.id);
      if (!target) throw new HttpError(404,'USER_NOT_FOUND');
      if (!await lockCurrentSession(tx,actor,request)) throw new HttpError(403,'STAFF_SCOPE_ACCESS_REVOKED');
      if (actor.id===target.id && !request.body.active) throw new HttpError(409,'CANNOT_DISABLE_SELF');
      if (actor.role==='MANAGER' && (target.role!=='AGENT' || target.branch_id!==actor.branchId)) throw new HttpError(403,'FORBIDDEN');
      await tx`UPDATE user_account SET active = ${request.body.active}, updated_at = now() WHERE id = ${target.id}`;
      if (!request.body.active) await tx`UPDATE user_session SET revoked_at = now() WHERE user_id = ${target.id} AND revoked_at IS NULL`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${target.branch_id}, ${actor.id}, ${request.body.active ? 'USER_ACTIVATED' : 'USER_DISABLED'}, 'USER', ${target.id})`;
    });
    return { ok: true };
  });
}
