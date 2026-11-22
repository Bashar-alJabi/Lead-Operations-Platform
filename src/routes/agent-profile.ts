import type { FastifyInstance,FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError,lockCurrentSession,principalFromRequest,requireRole,type Principal } from '../security.js';

const root='/api/users/:id/agent-profile';
type Resource={id:string};
type ProfileInput={name:string;capacity:number|null;reason:string;version:number};
const params={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}} as const;

async function profileAccess(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest<{Params:Resource}>,write=false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const [scope]=await tx`SELECT branch_id FROM user_account WHERE id=${request.params.id} AND organization_id=${actor.organizationId}
    AND role='AGENT' AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId})`;
  if (!scope) throw new HttpError(404,'AGENT_PROFILE_NOT_FOUND');
  // Use the same Branch lock as automatic routing before changing Agent capacity.
  const [branch]=await tx`SELECT id,active FROM branch WHERE id=${scope.branch_id} AND organization_id=${actor.organizationId}
    ${write?tx`FOR NO KEY UPDATE`:tx`FOR SHARE`}`;
  const [agent]=await tx`SELECT id,branch_id,name,capacity,active,credential_state,agent_profile_version AS version
    FROM user_account WHERE id=${request.params.id} AND organization_id=${actor.organizationId} AND branch_id=${scope.branch_id} AND role='AGENT'
    ${write?tx`FOR NO KEY UPDATE`:tx`FOR SHARE`}`;
  if (!agent || !branch) throw new HttpError(404,'AGENT_PROFILE_NOT_FOUND');
  const session=await lockCurrentSession(tx,actor,request);
  if (!session) throw new HttpError(403,'AGENT_PROFILE_ACCESS_REVOKED');
  return {agent,branch,session};
}

async function openWorkload(tx:postgres.TransactionSql,agentId:string,branchId:string) {
  const [row]=await tx`SELECT count(*)::int AS workload FROM lead WHERE assigned_agent_id=${agentId} AND branch_id=${branchId} AND lifecycle='OPEN'`;
  return row!.workload as number;
}

export function registerAgentProfileRoutes(app:FastifyInstance,db:Database) {
  app.get<{Params:Resource}>(root,{schema:{params}},async(request,reply)=>{
    const actor=await principalFromRequest(request,db);
    reply.header('Cache-Control','no-store');
    return db.begin(async tx=>{
      const {agent,branch}=await profileAccess(tx,actor,request);
      return {...agent,branchActive:branch.active,openLeadCount:await openWorkload(tx,agent.id,branch.id)};
    });
  });
  app.put<{Params:Resource;Body:ProfileInput}>(root,{schema:{params,body:{type:'object',additionalProperties:false,
    required:['name','capacity','reason','version'],properties:{name:{type:'string',minLength:1,maxLength:200,pattern:'^[^\\x00-\\x1f\\x7f]+$'},
      capacity:{type:['integer','null'],minimum:0,maximum:2147483647},
      version:{type:'integer',minimum:0},reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$'}}}}},async(request,reply)=>{
    const actor=await principalFromRequest(request,db),input=request.body;
    const name=input.name.trim(),reason=input.reason.trim();
    if (!name || reason.length<3) throw new HttpError(400,'AGENT_PROFILE_INPUT_INVALID');
    reply.header('Cache-Control','no-store');
    return db.begin(async tx=>{
      const {agent,branch,session}=await profileAccess(tx,actor,request,true);
      if (!branch.active) throw new HttpError(409,'BRANCH_DISABLED');
      if (agent.version!==input.version) throw new HttpError(409,'AGENT_PROFILE_VERSION_CONFLICT');
      if (agent.name===name && agent.capacity===input.capacity) return {version:agent.version};
      const [saved]=await tx`UPDATE user_account SET name=${name},capacity=${input.capacity},agent_profile_version=agent_profile_version+1,
        updated_at=clock_timestamp() WHERE id=${agent.id} RETURNING agent_profile_version AS version`;
      await tx`INSERT INTO agent_profile_history(user_id,version,branch_id,previous_name,name,previous_capacity,capacity,actor_id,session_id,reason)
        VALUES(${agent.id},${saved!.version},${branch.id},${agent.name},${name},${agent.capacity},${input.capacity},${actor.id},${session},${reason})`;
      return saved!;
    });
  });
  app.get<{Params:Resource;Querystring:{limit?:number;before?:number}}>(root+'/history',{schema:{params,querystring:{type:'object',
    additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:50},before:{type:'integer',minimum:1}}}}},async(request,reply)=>{
    const actor=await principalFromRequest(request,db),limit=request.query.limit??15;
    reply.header('Cache-Control','no-store');
    return db.begin(async tx=>{
      const {agent,branch}=await profileAccess(tx,actor,request);
      const rows=await tx`SELECT version,previous_name AS "previousName",name,previous_capacity AS "previousCapacity",capacity,reason,
        changed_at AS "changedAt" FROM agent_profile_history WHERE user_id=${agent.id} AND branch_id=${branch.id}
        AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT ${limit+1}`;
      const items=rows.slice(0,limit);
      return {items,nextBefore:rows.length>limit?items.at(-1)!.version:null};
    });
  });
}
