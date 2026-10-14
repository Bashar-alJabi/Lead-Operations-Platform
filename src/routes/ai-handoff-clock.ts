import type {FastifyInstance,FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import type {Database} from '../db.js';
import {HttpError,principalFromRequest,requireRole,type Principal} from '../security.js';
import {currentPaymentSession} from '../payments/access.js';
import {emptyHandoffClock,normalizeHandoffClock,handoffClockSchema,type HandoffClock} from '../ai/handoff-clock.js';
async function access(tx:postgres.TransactionSql,a:Principal,scope:'BRANCH'|'CAMPAIGN',id:string,request:FastifyRequest,write=false){
 requireRole(a,'SUPER_ADMIN','MANAGER');
 const initial=scope==='BRANCH'?(await tx`SELECT id AS branch_id FROM branch WHERE id=${id} AND organization_id=${a.organizationId} AND (${a.role==='SUPER_ADMIN'} OR id=${a.branchId})`)[0]
  :(await tx`SELECT branch_id FROM campaign WHERE id=${id} AND organization_id=${a.organizationId} AND (${a.role==='SUPER_ADMIN'} OR branch_id=${a.branchId})`)[0];
 if(!initial)throw new HttpError(404,'HANDOFF_CLOCK_RESOURCE_NOT_FOUND');
 const b=write?(await tx`SELECT id,active FROM branch WHERE id=${initial.branch_id} AND organization_id=${a.organizationId} FOR UPDATE`)[0]:(await tx`SELECT id,active FROM branch WHERE id=${initial.branch_id} AND organization_id=${a.organizationId} FOR SHARE`)[0];
 if(!b)throw new HttpError(404,'HANDOFF_CLOCK_RESOURCE_NOT_FOUND');
 if(scope==='CAMPAIGN'&&!(await tx`SELECT id FROM campaign WHERE id=${id} AND branch_id=${b.id} AND organization_id=${a.organizationId} FOR SHARE`).length)throw new HttpError(404,'HANDOFF_CLOCK_RESOURCE_NOT_FOUND');
 const prior=(await tx`SELECT organization_id,branch_id FROM ai_handoff_clock_policy WHERE scope=${scope} AND resource_id=${id}`)[0];
 if(prior&&(prior.organization_id!==a.organizationId||prior.branch_id!==b.id))throw new HttpError(404,'HANDOFF_CLOCK_RESOURCE_NOT_FOUND');
 const session=await currentPaymentSession(tx,a,request);if(!session)throw new HttpError(403,'HANDOFF_CLOCK_ACCESS_REVOKED');
 if(write&&!b.active)throw new HttpError(409,'BRANCH_DISABLED');return {branchId:b.id as string,session};
}
export function registerAIHandoffClockRoutes(app:FastifyInstance,db:Database){
 const params={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}} as const;
 for(const scope of ['BRANCH','CAMPAIGN'] as const){
  const root='/api/ai/'+(scope==='BRANCH'?'branches':'campaigns')+'/:id/handoff-clock';
  app.get<{Params:{id:string}}>(root,{schema:{params}},async request=>{
   const a=await principalFromRequest(request,db);return db.begin(async tx=>{
    const p=await access(tx,a,scope,request.params.id,request);
    const row=(await tx`SELECT version,definition,reason,updated_at FROM ai_handoff_clock_policy WHERE scope=${scope} AND resource_id=${request.params.id}`)[0];
    const effective=(await tx`SELECT ai_effective_handoff_clock(${p.branchId},${scope==='CAMPAIGN'?request.params.id:null}::uuid,clock_timestamp()) AS effective`)[0]!.effective;
    return {version:row?.version??0,definition:row?.definition??emptyHandoffClock(),reason:row?.reason??null,updatedAt:row?.updated_at??null,effective};
   });
  });
  app.put<{Params:{id:string};Body:{version:number;definition:HandoffClock;reason:string}}>(root,{bodyLimit:32768,preValidation:async r=>{
   const b=r.body;if(!b||typeof b!=='object'||Array.isArray(b))throw new HttpError(400,'INVALID_HANDOFF_CLOCK');const body=b as Record<string,unknown>;
   if(typeof body.version!=='number'||!Number.isInteger(body.version)||body.version<0||body.version>2147483646||typeof body.reason!=='string')throw new HttpError(400,'INVALID_HANDOFF_CLOCK');
   normalizeHandoffClock(body.definition);
  },schema:{params,body:{type:'object',additionalProperties:false,required:['version','definition','reason'],properties:{version:{type:'integer',minimum:0,maximum:2147483646},definition:handoffClockSchema,reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\x00-\x1f\x7f]+$'}}}}},async request=>{
   const a=await principalFromRequest(request,db),definition=normalizeHandoffClock(request.body.definition),reason=request.body.reason.trim();if(reason.length<3)throw new HttpError(400,'HANDOFF_CLOCK_REASON_REQUIRED');
   return db.begin(async tx=>{
    const p=await access(tx,a,scope,request.params.id,request,true),old=(await tx`SELECT version FROM ai_handoff_clock_policy WHERE scope=${scope} AND resource_id=${request.params.id} FOR UPDATE`)[0];
    if((old?.version??0)!==request.body.version)throw new HttpError(409,'HANDOFF_CLOCK_VERSION_CONFLICT');
    if(old)await tx`UPDATE ai_handoff_clock_policy SET version=version+1,definition=${tx.json(definition)},actor_id=${a.id},session_id=${p.session},reason=${reason} WHERE scope=${scope} AND resource_id=${request.params.id}`;
    else await tx`INSERT INTO ai_handoff_clock_policy(scope,resource_id,organization_id,branch_id,campaign_id,version,definition,actor_id,session_id,reason)
     VALUES(${scope},${request.params.id},${a.organizationId},${p.branchId},${scope==='CAMPAIGN'?request.params.id:null},1,${tx.json(definition)},${a.id},${p.session},${reason})`;
    return {version:request.body.version+1,runtimeReady:false};
   });
  });
  app.get<{Params:{id:string};Querystring:{before?:number;limit?:number}}>(root+'/history',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:50}}}}},async request=>{
   const a=await principalFromRequest(request,db);return db.begin(async tx=>{
    await access(tx,a,scope,request.params.id,request);const limit=request.query.limit??10;
    const rows=await tx`SELECT version,snapshot->'definition' AS definition,snapshot->>'reason' AS reason,snapshot->>'actor_id' AS actor_id,created_at FROM ai_handoff_clock_history WHERE scope=${scope} AND resource_id=${request.params.id}
     AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT ${limit+1}`;
    return {items:rows.slice(0,limit),nextVersion:rows.length>limit?rows[limit-1]!.version:null};
   });
  });
 }
}
