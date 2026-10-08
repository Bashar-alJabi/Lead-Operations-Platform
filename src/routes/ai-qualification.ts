import type postgres from 'postgres';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,type Principal } from '../security.js';
import { knowledgeCampaign } from './ai-knowledge.js';
import { emptyQualification,normalizeQualification,qualificationSchema,evaluateQualification,type QualificationDefinition } from '../ai/qualification.js';
import { validateFieldValue,type FieldType,type FieldOption,type FieldValidation } from '../fields.js';
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:{ type:'string',format:'uuid' } } } as const;
async function mappedFields(tx:postgres.TransactionSql,actor:Principal,campaignId:string,definition:QualificationDefinition) {
  const ids=[...new Set(definition.questions.flatMap((q)=>q.fieldId ? [q.fieldId] : []))];
  const fields=await tx`SELECT fd.id,fd.key,fd.label,fd.value_mode,fd.field_type,fd.options,fd.validation,fd.version AS definition_version,cf.version AS binding_version
    FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id JOIN campaign c ON c.id=cf.campaign_id
    WHERE cf.campaign_id=${campaignId} AND fd.organization_id=c.organization_id AND fd.id IN ${tx(ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])}
      AND fd.active AND cf.active AND cf.usable_by_ai AND fd.value_mode='MANUAL' AND (fd.branch_id IS NULL OR fd.branch_id=c.branch_id)
      AND (fd.campaign_id IS NULL OR fd.campaign_id=c.id) AND (${actor.role==='SUPER_ADMIN'} OR cf.visible_to_manager) FOR SHARE OF fd,cf`;
  if(fields.length!==ids.length)throw new HttpError(409,'QUALIFICATION_FIELD_UNAVAILABLE');return new Map(fields.map((f)=>[f.id as string,f]));
}
function answer(value:unknown,field:postgres.Row|undefined):postgres.JSONValue {
  if(field)return validateFieldValue(field.field_type as FieldType,value,field.options as FieldOption[],field.validation as FieldValidation) as postgres.JSONValue;
  if(typeof value!=='string' || value.length>4000 || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || Buffer.from(value).toString()!==value)throw new HttpError(400,'QUALIFICATION_ANSWER_INVALID');return value.trim();
}
async function validated(tx:postgres.TransactionSql,actor:Principal,id:string,raw:unknown) {
  const definition=normalizeQualification(raw),fields=await mappedFields(tx,actor,id,definition);
  for(const rule of [...definition.completion.conditions,...definition.handoff.conditions])if(rule.operator==='EQUALS') {
    const q=definition.questions.find((q)=>q.id===rule.questionId)!;rule.value=answer(rule.value,q.fieldId ? fields.get(q.fieldId) : undefined);
  }return { definition,fields };
}
export function registerAIQualificationRoutes(app:FastifyInstance,db:Database) {
  const root='/api/ai/campaigns/:id/qualification';
  app.get<{ Params:{ id:string };Querystring:{ afterFieldId?:string } }>(root,{ schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ afterFieldId:{ type:'string',format:'uuid' } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const { c }=await knowledgeCampaign(tx,actor,request.params.id,request);const row=(await tx`SELECT version,definition,actor_id,reason,updated_at FROM ai_qualification_config WHERE campaign_id=${request.params.id}`)[0] ?? { version:0,definition:emptyQualification() };
      const fields=await tx`SELECT fd.id,fd.key,fd.label,fd.value_mode,fd.field_type,fd.options,fd.validation,fd.version AS definition_version,cf.version AS binding_version
        FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id WHERE cf.campaign_id=${request.params.id} AND cf.active AND fd.active AND cf.usable_by_ai AND fd.value_mode='MANUAL'
        AND fd.organization_id=${actor.organizationId} AND (fd.branch_id IS NULL OR fd.branch_id=${c.branch_id}) AND (fd.campaign_id IS NULL OR fd.campaign_id=${c.id})
        AND (${actor.role==='SUPER_ADMIN'} OR cf.visible_to_manager) AND (${request.query.afterFieldId ?? null}::uuid IS NULL OR fd.id>${request.query.afterFieldId ?? null}::uuid) ORDER BY fd.id LIMIT 101`;
      return { ...row,fields:fields.slice(0,100),nextFieldId:fields.length>100 ? fields[99]!.id : null,assistantReady:false };
    });
  });
  app.put<{ Params:{ id:string };Body:{ version:number;definition:QualificationDefinition;reason:string } }>(root,{
    bodyLimit:131072,schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','definition','reason'],properties:{ version:{ type:'integer',minimum:0 },definition:qualificationSchema,reason:{ type:'string',minLength:3,maxLength:500,pattern:'^[^\\x00-\\x1f\\x7f]+$' } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      const { sessionId }=await knowledgeCampaign(tx,actor,request.params.id,request,true);
      const old=(await tx`SELECT version,definition FROM ai_qualification_config WHERE campaign_id=${request.params.id} FOR UPDATE`)[0];if((old?.version ?? 0)!==request.body.version)throw new HttpError(409,'QUALIFICATION_VERSION_CONFLICT');
      const raw=normalizeQualification(request.body.definition),disableOnly=old && !raw.enabled && isDeepStrictEqual(raw,{ ...old.definition,enabled:false });
      const definition=disableOnly ? raw : (await validated(tx,actor,request.params.id,raw)).definition;
      const reason=request.body.reason.trim();if(reason.length<3)throw new HttpError(400,'QUALIFICATION_REASON_REQUIRED');
      if(old)await tx`UPDATE ai_qualification_config SET version=version+1,definition=${tx.json(definition)},actor_id=${actor.id},session_id=${sessionId},reason=${reason},updated_at=clock_timestamp() WHERE campaign_id=${request.params.id}`;
      else await tx`INSERT INTO ai_qualification_config(campaign_id,version,definition,actor_id,session_id,reason) VALUES (${request.params.id},1,${tx.json(definition)},${actor.id},${sessionId},${reason})`;
      return { version:request.body.version+1 };
    });
  });
  app.post<{ Params:{ id:string };Body:{ version:number;definition:QualificationDefinition;answers:{ questionId:string;value:unknown }[] } }>(root+'/preview',{
    bodyLimit:131072,schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','definition','answers'],properties:{ version:{ type:'integer',minimum:0 },definition:qualificationSchema,answers:{ type:'array',maxItems:40,items:{ type:'object',additionalProperties:false,required:['questionId','value'],properties:{ questionId:{ type:'string',format:'uuid' },value:{} } } } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
      await knowledgeCampaign(tx,actor,request.params.id,request);const current=(await tx`SELECT version FROM ai_qualification_config WHERE campaign_id=${request.params.id}`)[0];if((current?.version ?? 0)!==request.body.version)throw new HttpError(409,'QUALIFICATION_VERSION_CONFLICT');
      const { definition,fields }=await validated(tx,actor,request.params.id,request.body.definition),answers:Record<string,unknown>={};
      for(const item of request.body.answers) {
        const q=definition.questions.find((q)=>q.id===item.questionId);if(!q || Object.hasOwn(answers,q.id))throw new HttpError(400,'QUALIFICATION_ANSWER_INVALID');answers[q.id]=answer(item.value,q.fieldId ? fields.get(q.fieldId) : undefined);
      }
      return { ...evaluateQualification(definition,answers),definition,answers,assistantReady:false,fieldVersions:[...fields.values()].map((f)=>({ id:f.id,definitionVersion:f.definition_version,bindingVersion:f.binding_version })) };
    });
  });
  app.get<{ Params:{ id:string };Querystring:{ before?:number;limit?:number } }>(root+'/history',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ before:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } },
  },async(request)=> { const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> {
    await knowledgeCampaign(tx,actor,request.params.id,request);const limit=request.query.limit ?? 20,rows=await tx`SELECT version,actor_id,reason,created_at FROM ai_qualification_history WHERE campaign_id=${request.params.id} AND (${request.query.before ?? null}::integer IS NULL OR version<${request.query.before ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;return { items:rows.slice(0,limit),nextVersion:rows.length>limit ? rows[limit-1]!.version : null };
  }); });
  app.get<{ Params:{ id:string;version:number } }>(root+'/versions/:version',{ schema:{ params:{ type:'object',additionalProperties:false,required:['id','version'],properties:{ id:{ type:'string',format:'uuid' },version:{ type:'integer',minimum:1 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);return db.begin(async(tx)=> { await knowledgeCampaign(tx,actor,request.params.id,request);const h=(await tx`SELECT version,definition,actor_id,reason,created_at FROM ai_qualification_history WHERE campaign_id=${request.params.id} AND version=${request.params.version}`)[0];if(!h)throw new HttpError(404,'QUALIFICATION_VERSION_NOT_FOUND');return h; });
  });
}
