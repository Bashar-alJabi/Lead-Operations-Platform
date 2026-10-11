import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireRole, type Principal } from '../security.js';
import { currentPaymentSession } from '../payments/access.js';
import { normalizeWeeklyHours, weeklyHoursSchema, type WeeklyHours } from '../working-hours.js';

async function access(tx: postgres.TransactionSql, actor: Principal, scope: 'BRANCH'|'USER', id: string, request: FastifyRequest, write = false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const initial = scope === 'BRANCH' ? (await tx`SELECT id AS branch_id FROM branch WHERE id=${id} AND organization_id=${actor.organizationId}
    AND (${actor.role === 'SUPER_ADMIN'} OR id=${actor.branchId})`)[0] : (await tx`SELECT branch_id FROM user_account WHERE id=${id} AND organization_id=${actor.organizationId}
    AND role IN ('AGENT','MANAGER') AND (${actor.role === 'SUPER_ADMIN'} OR role='AGENT' AND branch_id=${actor.branchId})`)[0];
  if (!initial) throw new HttpError(404,'WORKING_HOURS_RESOURCE_NOT_FOUND');
  const b = write ? (await tx`SELECT id,active,timezone FROM branch WHERE id=${initial.branch_id} FOR UPDATE`)[0]!
    : (await tx`SELECT id,active,timezone FROM branch WHERE id=${initial.branch_id} FOR SHARE`)[0]!;
  if (scope === 'USER' && !(await tx`SELECT id FROM user_account WHERE id=${id} AND branch_id=${b.id} AND organization_id=${actor.organizationId}
    AND (${actor.role === 'SUPER_ADMIN'} AND role IN ('AGENT','MANAGER') OR role='AGENT' AND branch_id=${actor.branchId}) FOR SHARE`).length) throw new HttpError(404,'WORKING_HOURS_RESOURCE_NOT_FOUND');
  const session = await currentPaymentSession(tx,actor,request); if (!session) throw new HttpError(403,'WORKING_HOURS_ACCESS_REVOKED');
  if (write && !b.active) throw new HttpError(409,'BRANCH_DISABLED');
  return { branchId: b.id as string, timezone: b.timezone as string, session };
}
export function registerWorkingHoursRoutes(app: FastifyInstance, db: Database) {
  const params = { type:'object',additionalProperties:false,required:['id'],properties:{ id:{ type:'string',format:'uuid' } } } as const;
  for (const scope of ['BRANCH','USER'] as const) {
    const root = scope === 'BRANCH' ? '/api/branches/:id/working-hours' : '/api/users/:id/working-hours';
    app.get<{ Params:{ id:string } }>(root,{ schema:{ params } },async request => {
      const actor = await principalFromRequest(request,db); return db.begin(async tx => {
        const a = await access(tx,actor,scope,request.params.id,request);
        const policy = (await tx`SELECT version,hours,reason,updated_at FROM operational_hours_policy WHERE scope=${scope} AND resource_id=${request.params.id}`)[0];
        const original = policy ? policy.hours : scope === 'BRANCH' ? (await tx`SELECT business_hours AS hours FROM branch WHERE id=${request.params.id}`)[0]!.hours
          : (await tx`SELECT working_hours AS hours FROM user_account WHERE id=${request.params.id}`)[0]!.hours;
        return { scope,version:policy?.version ?? 0,hours:original,timezone:a.timezone,reason:policy?.reason ?? null,updatedAt:policy?.updated_at ?? null };
      });
    });
    app.put<{ Params:{ id:string }; Body:{ version:number;hours:WeeklyHours;reason:string } }>(root,{ bodyLimit:16384,schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','hours','reason'],properties:{
      version:{ type:'integer',minimum:0 },hours:weeklyHoursSchema,reason:{ type:'string',minLength:3,maxLength:500,pattern:'^[^\x00-\x1f\x7f]+$' } } } } },async request => {
      const actor = await principalFromRequest(request,db), hours = normalizeWeeklyHours(request.body.hours), reason = request.body.reason.trim();
      if (reason.length < 3) throw new HttpError(400,'WORKING_HOURS_REASON_REQUIRED');
      return db.begin(async tx => {
        const a = await access(tx,actor,scope,request.params.id,request,true);
        const prior = (await tx`SELECT version FROM operational_hours_policy WHERE scope=${scope} AND resource_id=${request.params.id} FOR UPDATE`)[0];
        if ((prior?.version ?? 0) !== request.body.version) throw new HttpError(409,'WORKING_HOURS_VERSION_CONFLICT');
        if (prior) await tx`UPDATE operational_hours_policy SET hours=${tx.json(hours)},version=version+1,actor_id=${actor.id},session_id=${a.session},reason=${reason} WHERE scope=${scope} AND resource_id=${request.params.id}`;
        else await tx`INSERT INTO operational_hours_policy(scope,resource_id,branch_id,version,hours,actor_id,session_id,reason)
          VALUES(${scope},${request.params.id},${a.branchId},1,${tx.json(hours)},${actor.id},${a.session},${reason})`;
        return { version:request.body.version+1 };
      });
    });
    app.get<{ Params:{ id:string }; Querystring:{ before?:number;limit?:number } }>(root+'/history',{ schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ before:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:50 } } } } },async request => {
      const actor = await principalFromRequest(request,db); return db.begin(async tx => {
        await access(tx,actor,scope,request.params.id,request); const limit = request.query.limit ?? 10;
        const rows = await tx`SELECT version,snapshot->'hours' AS hours,snapshot->>'reason' AS reason,snapshot->>'actor_id' AS actor_id,created_at FROM operational_hours_history
          WHERE scope=${scope} AND resource_id=${request.params.id} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;
        const last = rows.slice(0,limit).at(-1); return { items:rows.slice(0,limit),nextVersion:rows.length>limit ? last!.version : null };
      });
    });
  }
}
