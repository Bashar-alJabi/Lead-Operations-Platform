import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest } from '../security.js';
import { knowledgeCampaign } from './ai-knowledge.js';
import { approvedBodyTemplate } from '../messaging/approved-template.js';
import { resolveConfiguredSender } from '../messaging/sender-resolution.js';

const params={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',format:'uuid'}}} as const;
type Definition={templateId:string|null;bodyParameters:string[];headerParameter:string|null;urlParameter:string|null};
const empty:Definition={templateId:null,bodyParameters:[],headerParameter:null,urlParameter:null};
export function registerAIInitialMessageRoutes(app:FastifyInstance,db:Database){
  const root='/api/ai/campaigns/:id/initial-message';
  app.get<{Params:{id:string}}>(root,{schema:{params}},async request=>{
    const actor=await principalFromRequest(request,db);return db.begin(async tx=>{
      await knowledgeCampaign(tx,actor,request.params.id,request);
      const row=(await tx`SELECT version,definition,reason,updated_at FROM ai_initial_message_policy WHERE campaign_id=${request.params.id}`)[0];
      const context=(await tx`SELECT ai_initial_message_context(${request.params.id}) AS context`)[0]!.context;
      return {version:row?.version??0,definition:row?.definition??empty,ready:context?.ready===true,preview:context?.body??null,knowledgeVersion:context?.approval?.knowledgeVersion??null,reason:row?.reason??null,liveVerified:false};
    });
  });
  app.put<{Params:{id:string};Body:{version:number;definition:Definition;reason:string}}>(root,{bodyLimit:32768,schema:{params,body:{type:'object',additionalProperties:false,required:['version','definition','reason'],properties:{version:{type:'integer',minimum:0},reason:{type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$'},definition:{type:'object',additionalProperties:false,required:['templateId','bodyParameters','headerParameter','urlParameter'],properties:{templateId:{anyOf:[{type:'null'},{type:'string',format:'uuid'}]},bodyParameters:{type:'array',maxItems:40,items:{type:'string',minLength:1,maxLength:512}},headerParameter:{type:['string','null'],minLength:1,maxLength:512},urlParameter:{type:['string','null'],minLength:1,maxLength:2000}}}}}}},async request=>{
    const actor=await principalFromRequest(request,db),d=request.body.definition;
    return db.begin(async tx=>{
      const parent=(await tx`SELECT branch_id FROM campaign WHERE id=${request.params.id} AND organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR ${actor.role==='MANAGER'} AND branch_id=${actor.branchId})`)[0];
      if(!parent)throw new HttpError(404,'CAMPAIGN_NOT_FOUND');
      await tx`SELECT id FROM branch WHERE id=${parent.branch_id} FOR UPDATE`;
      const {c,sessionId}=await knowledgeCampaign(tx,actor,request.params.id,request,true);
      const old=(await tx`SELECT version FROM ai_initial_message_policy WHERE campaign_id=${c.id} FOR UPDATE`)[0];
      if((old?.version??0)!==request.body.version)throw new HttpError(409,'AI_INITIAL_MESSAGE_VERSION_CONFLICT');
      if(d.templateId){
        const sender=await resolveConfiguredSender(tx,{organizationId:actor.organizationId,branchId:c.branch_id,campaignId:c.id});
        if(!sender.sender)throw new HttpError(409,sender.reason);
        if(!sender.sender.supportsTemplate)throw new HttpError(409,'TEMPLATE_NOT_SUPPORTED');
        const rendered=await approvedBodyTemplate(tx,sender.sender.connectionId,c.id,d.templateId,d.bodyParameters,d.headerParameter??undefined,d.urlParameter??undefined,{messageId:randomUUID()});
        const language=(await tx`SELECT COALESCE(NULLIF(cp.definition->'language','null'),bp.definition->'language') AS language FROM campaign ca LEFT JOIN ai_operational_config cp ON cp.scope='CAMPAIGN' AND cp.resource_id=ca.id LEFT JOIN ai_operational_config bp ON bp.scope='BRANCH' AND bp.resource_id=ca.branch_id WHERE ca.id=${c.id}`)[0]!.language;
        if(!language?.supported?.some((tag:string)=>tag.split('-')[0]!.toLowerCase()===rendered.snapshot.language.replace('_','-').split('-')[0]!.toLowerCase()))throw new HttpError(409,'AI_INITIAL_TEMPLATE_LANGUAGE_UNAVAILABLE');
        const behavior=(await tx`SELECT COALESCE(cp.definition->'disclosure'->>'text',bp.definition->'disclosure'->>'text') AS disclosure FROM campaign ca LEFT JOIN ai_behavior_policy cp ON cp.scope='CAMPAIGN' AND cp.resource_id=ca.id LEFT JOIN ai_behavior_policy bp ON bp.scope='BRANCH' AND bp.resource_id=ca.branch_id WHERE ca.id=${c.id}`)[0]!.disclosure;
        if(!behavior||!rendered.body.includes(behavior))throw new HttpError(409,'AI_INITIAL_TEMPLATE_DISCLOSURE_REQUIRED');
        if(!(await tx`SELECT ai_initial_template_approval(${c.id},${d.templateId}) AS approval`)[0]!.approval)throw new HttpError(409,'AI_INITIAL_PUBLISHED_TEMPLATE_REQUIRED');
      }else if(d.bodyParameters.length||d.headerParameter!==null||d.urlParameter!==null)throw new HttpError(400,'AI_INITIAL_MESSAGE_INVALID');
      const reason=request.body.reason.trim();if(reason.length<3)throw new HttpError(400,'REASON_REQUIRED');
      if(old)await tx`UPDATE ai_initial_message_policy SET version=version+1,definition=${tx.json(d)},actor_id=${actor.id},session_id=${sessionId},reason=${reason} WHERE campaign_id=${c.id}`;
      else await tx`INSERT INTO ai_initial_message_policy(campaign_id,version,definition,actor_id,session_id,reason) VALUES(${c.id},1,${tx.json(d)},${actor.id},${sessionId},${reason})`;
      return {version:request.body.version+1};
    });
  });
  app.get<{Params:{id:string};Querystring:{before?:number}}>(root+'/history',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{before:{type:'integer',minimum:1}}}}},async request=>{
    const actor=await principalFromRequest(request,db);return db.begin(async tx=>{await knowledgeCampaign(tx,actor,request.params.id,request);
      const rows=await tx`SELECT version,snapshot->>'reason' AS reason,created_at FROM ai_initial_message_history WHERE campaign_id=${request.params.id} AND (${request.query.before??null}::integer IS NULL OR version<${request.query.before??null}) ORDER BY version DESC LIMIT 21`;
      return {items:rows.slice(0,20),nextVersion:rows.length>20?rows[19]!.version:null};});
  });
}
