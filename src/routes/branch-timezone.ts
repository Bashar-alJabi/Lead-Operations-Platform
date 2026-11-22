import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError, lockCurrentSession, principalFromRequest, requireRole, type Principal } from '../security.js';

const root='/api/branches/:id/timezone';
const params={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}} as const;
type Resource={ id:string };
type Settings={ timezone:string;version:number;reason:string };

async function currentBranch(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest<{Params:Resource}>,write=false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const [branch]=await tx`SELECT id,timezone,timezone_version AS version,active FROM branch
    WHERE id=${request.params.id} AND organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR id=${actor.branchId})
    ${write?tx`FOR NO KEY UPDATE`:tx`FOR SHARE`}`;
  if (!branch) throw new HttpError(404,'BRANCH_NOT_FOUND');
  const session=await lockCurrentSession(tx,actor,request);
  if (!session) throw new HttpError(403,'BRANCH_TIMEZONE_ACCESS_REVOKED');
  return {branch,session};
}

export function registerBranchTimezoneRoutes(app:FastifyInstance,db:Database) {
  app.get<{Params:Resource}>(root,{schema:{params}},async(request,reply)=>{
    const actor=await principalFromRequest(request,db);
    reply.header('Cache-Control','no-store');
    return db.begin(async tx=>(await currentBranch(tx,actor,request)).branch);
  });

  app.put<{Params:Resource;Body:Settings}>(root,{schema:{params,body:{type:'object',additionalProperties:false,
    required:['timezone','version','reason'],properties:{
      timezone:{type:'string',minLength:1,maxLength:100,pattern:'^[A-Za-z0-9_+/-]+$'},version:{type:'integer',minimum:0},
      reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$'},
    }}}},async(request,reply)=>{
    const actor=await principalFromRequest(request,db),input=request.body;
    const reason=input.reason.trim();
    if (reason.length<3) throw new HttpError(400,'BRANCH_TIMEZONE_REASON_REQUIRED');
    try { new Intl.DateTimeFormat('en',{timeZone:input.timezone}); }
    catch { throw new HttpError(400,'INVALID_TIMEZONE'); }
    reply.header('Cache-Control','no-store');
    return db.begin(async tx=>{
      const {branch,session}=await currentBranch(tx,actor,request,true);
      if (!branch.active) throw new HttpError(409,'BRANCH_DISABLED');
      if (branch.version!==input.version) throw new HttpError(409,'BRANCH_TIMEZONE_VERSION_CONFLICT');
      if (input.timezone===branch.timezone) return branch;
      if (!(await tx`SELECT 1 FROM pg_timezone_names WHERE name=${input.timezone}`).length) throw new HttpError(400,'INVALID_TIMEZONE');
      const [changed]=await tx`UPDATE branch SET timezone=${input.timezone},timezone_version=timezone_version+1,updated_at=clock_timestamp()
        WHERE id=${branch.id} RETURNING id,timezone,timezone_version AS version,active`;
      await tx`INSERT INTO branch_timezone_history(branch_id,version,previous_timezone,timezone,actor_id,session_id,reason)
        VALUES(${branch.id},${changed!.version},${branch.timezone},${input.timezone},${actor.id},${session},${reason})`;
      return changed!;
    });
  });

  app.get<{Params:Resource;Querystring:{before?:number;limit?:number}}>(root+'/history',{schema:{params,querystring:{type:'object',
    additionalProperties:false,properties:{before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:50}}}}},async(request,reply)=>{
    const actor=await principalFromRequest(request,db),limit=request.query.limit??15;
    reply.header('Cache-Control','no-store');
    return db.begin(async tx=>{
      const {branch}=await currentBranch(tx,actor,request);
      const rows=await tx`SELECT version,previous_timezone AS "previousTimezone",timezone,reason,changed_at AS "changedAt"
        FROM branch_timezone_history WHERE branch_id=${branch.id} AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null})
        ORDER BY version DESC LIMIT ${limit+1}`;
      const items=rows.slice(0,limit);
      return {items,nextBefore:rows.length>limit?items.at(-1)!.version:null};
    });
  });
}
