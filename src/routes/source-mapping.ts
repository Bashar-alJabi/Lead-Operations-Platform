import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,type Principal } from '../security.js';
import { sourceCampaign,sourceFormForBranch,sourceFormAvailable,sourceBindingIssues } from '../sources/bindings.js';
import { sourceBindingRows } from '../sources/readiness.js';
import { recheckSourceActor } from '../sources/catalog-sync.js';
import { sourceTransforms,sourceCatalogHash,mappingTargetHash,mappingTargets,validateMappingEntries,previewSourceMapping,suggestMapping,
  type MappingEntry,type MappingTarget,type SourceValue } from '../sources/field-mapping.js';
import type { SourceQuestion } from '../sources/meta-provider.js';
const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id','bindingId'],properties:{ id:uuid,bindingId:uuid } } as const;
const entries={ type:'array',maxItems:100,items:{ type:'object',additionalProperties:false,required:['sourceKey','kind','transform','optionMap'],properties:{
  sourceKey:{ type:'string',minLength:1,maxLength:200 },kind:{ enum:['CONTACT_NAME','CONTACT_PHONE','CONTACT_EMAIL','LEAD_FIELD'] },fieldId:uuid,
  transform:{ enum:sourceTransforms },optionMap:{ type:'array',maxItems:100,items:{ type:'object',additionalProperties:false,required:['source','target'],
    properties:{ source:{ type:'string',minLength:1,maxLength:512 },target:{ type:'string',minLength:1,maxLength:100 } } } },
} } } as const;
type Save={ version:number;bindingVersion:number;connectionVersion:number;resourceVersion:number;entries:MappingEntry[];status:'DRAFT'|'PUBLISHED';reason:string };
const versionFields={ version:{ type:'integer',minimum:0 },bindingVersion:{ type:'integer',minimum:1 },connectionVersion:{ type:'integer',minimum:1 },resourceVersion:{ type:'integer',minimum:1 } } as const;
const root='/api/sources/campaigns/:id/bindings/:bindingId/mapping';
async function mappingScope(db:Database,actor:Principal,campaignId:string,bindingId:string) {
  const camp=await sourceCampaign(db,actor,campaignId);
  const [binding]=await db`SELECT id,connection_id,resource_id,version,active FROM source_campaign_binding WHERE id=${bindingId} AND campaign_id=${camp.id}`;
  if (!binding) throw new HttpError(404,'SOURCE_BINDING_NOT_FOUND');
  const form=await sourceFormForBranch(db,actor,binding.connection_id,binding.resource_id,camp.branch_id);
  const [resource]=await db`SELECT version,questions FROM source_resource WHERE id=${binding.resource_id}`;
  return { camp,binding,form,resource:resource!,questions:resource!.questions as SourceQuestion[] };
}
async function requiredFields(db:Database,campaignId:string):Promise<string[]> {
  const rows=await db`SELECT fd.id FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
    WHERE cf.campaign_id=${campaignId} AND cf.active AND fd.active AND cf.required_stage='LEAD_CREATION'`;
  return rows.map((r)=>r.id as string);
}
function fieldIds(entries:MappingEntry[]):string[] { return [...new Set(entries.filter((e)=>e.kind==='LEAD_FIELD' && e.fieldId).map((e)=>e.fieldId!))]; }
async function visibleRevision(db:Database,actor:Principal,campaignId:string,row:Record<string,any>|undefined) {
  if (!row) return null;const entries=row.entries as MappingEntry[];const targets=await mappingTargets(db,actor,campaignId,fieldIds(entries));
  const allowed=new Set(targets.map((t)=>t.id));const filtered=entries.filter((e)=>e.kind!=='LEAD_FIELD' || allowed.has(e.fieldId!));
  return { version:row.version,status:row.status,bindingVersion:row.binding_version,connectionVersion:row.connection_version,
    resourceVersion:row.resource_version,createdAt:row.created_at,reason:row.reason,entries:filtered,
    targets,redacted:filtered.length!==entries.length };
}
export function registerSourceMappingRoutes(app:FastifyInstance,db:Database):void {
  app.get<{ Params:{ id:string;bindingId:string } }>(root,{ schema:{ params } },async(request)=> {
    const actor=await principalFromRequest(request,db);const scope=await mappingScope(db,actor,request.params.id,request.params.bindingId);
    const [latest]=await db`SELECT * FROM source_mapping_revision WHERE binding_id=${scope.binding.id} ORDER BY version DESC LIMIT 1`;
    const [published]=await db`SELECT * FROM source_mapping_revision WHERE binding_id=${scope.binding.id} AND status='PUBLISHED' ORDER BY version DESC LIMIT 1`;
    const issues:string[]=[];
    if (!published) issues.push('SOURCE_MAPPING_NOT_PUBLISHED');
    else {
      const current=await mappingTargets(db,actor,scope.camp.id,fieldIds(published.entries));const byId=new Map(current.map((t)=>[t.id,t]));
      if (!sourceCatalogHash(scope.questions).equals(published.catalog_hash) || scope.form.version!==published.connection_version)
        issues.push('SOURCE_MAPPING_CATALOG_CHANGED');
      if ((published.target_snapshot as MappingTarget[]).some((t)=>!byId.has(t.id) || mappingTargetHash(t)!==mappingTargetHash(byId.get(t.id)!)))
        issues.push('SOURCE_MAPPING_TARGET_CHANGED');
      const required=await requiredFields(db,scope.camp.id);
      if (required.some((id)=>!(published.entries as MappingEntry[]).some((e)=>e.kind==='LEAD_FIELD' && e.fieldId===id))) issues.push('SOURCE_MAPPING_REQUIRED_FIELD_UNMAPPED');
    }
    if (!sourceFormAvailable(scope.form)) issues.push('SOURCE_MAPPING_RESOURCE_NOT_AVAILABLE');
    if (!scope.camp.branch_active) issues.push('SOURCE_BRANCH_INACTIVE');
    const draftWarnings:string[]=[];
    if (latest) {
      const targets=await mappingTargets(db,actor,scope.camp.id,fieldIds(latest.entries));
      try { draftWarnings.push(...validateMappingEntries(latest.entries,scope.questions,targets)); }
      catch (error) { if (!(error instanceof HttpError)) throw error;draftWarnings.push(error.code); }
      if ((await requiredFields(db,scope.camp.id)).some((id)=>!(latest.entries as MappingEntry[]).some((e)=>e.kind==='LEAD_FIELD' && e.fieldId===id)))
        draftWarnings.push('SOURCE_MAPPING_REQUIRED_FIELD_UNMAPPED');
    }
    const [runtime]=await sourceBindingRows(db,scope.camp.id,null,1,scope.binding.id);
    const setupIssues=sourceBindingIssues(runtime!);
    return { latest:await visibleRevision(db,actor,scope.camp.id,latest),publishedVersion:published?.version ?? null,
      bindingVersion:scope.binding.version,connectionVersion:scope.form.version,resourceVersion:scope.resource.version,questions:scope.questions,
      configured:issues.length===0,issues,draftWarnings,setupReady:setupIssues.length===0,setupIssues,
      intakeReady:setupIssues.length===0 && scope.camp.status==='ACTIVE' && !runtime!.messaging_enabled && !runtime!.ai_enabled };
  });
  app.get<{ Params:{ id:string;bindingId:string };Querystring:{ after?:string;limit?:number } }>(root+'/targets',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ after:uuid,limit:{ type:'integer',minimum:1,maximum:100 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const scope=await mappingScope(db,actor,request.params.id,request.params.bindingId);const limit=request.query.limit ?? 50;
    const rows=await db`SELECT fd.id,fd.key,fd.label,fd.field_type,fd.value_mode,fd.options,fd.validation,fd.version,cf.version AS binding_version,cf.required_stage
      FROM field_definition fd JOIN campaign_field cf ON cf.field_id=fd.id WHERE cf.campaign_id=${scope.camp.id} AND cf.active AND fd.active
      AND fd.organization_id=${actor.organizationId} AND (fd.branch_id IS NULL OR fd.branch_id=${scope.camp.branch_id})
      AND (fd.campaign_id IS NULL OR fd.campaign_id=${scope.camp.id}) AND fd.value_mode IN ('SOURCE','MANUAL') AND fd.field_type<>'CALCULATED'
      AND (${actor.role==='SUPER_ADMIN'} OR (cf.visible_to_manager AND (fd.value_mode='SOURCE' OR cf.editable_by_manager)))
      AND (${request.query.after ?? null}::uuid IS NULL OR fd.id>${request.query.after ?? null}::uuid) ORDER BY fd.id LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextAfter:rows.length>limit ? items.at(-1)!.id : null,
      suggestions:scope.questions.filter((q)=>q.key && scope.questions.filter((other)=>other.key===q.key).length===1)
        .map((q)=>({ sourceKey:q.key,...suggestMapping(q,items as unknown as MappingTarget[]) })).filter((s)=>Object.hasOwn(s,'kind')) };
  });
  app.put<{ Params:{ id:string;bindingId:string };Body:Save }>(root,{ schema:{ params,body:{ type:'object',additionalProperties:false,
    required:['version','bindingVersion','connectionVersion','resourceVersion','entries','status','reason'],properties:{ ...versionFields,entries,
      status:{ enum:['DRAFT','PUBLISHED'] },reason:{ type:'string',minLength:1,maxLength:500 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const initial=await mappingScope(db,actor,request.params.id,request.params.bindingId);const input=request.body;
    return db.begin(async(tx)=> {
      const sql=tx as unknown as Database;await tx`SELECT id FROM integration_connection WHERE id=${initial.binding.connection_id} FOR UPDATE`;
      await recheckSourceActor(sql,actor);await sourceCampaign(sql,actor,initial.camp.id,true);
      const scope=await mappingScope(sql,actor,initial.camp.id,initial.binding.id);
      const [old]=await tx`SELECT version FROM source_mapping_revision WHERE binding_id=${scope.binding.id} ORDER BY version DESC LIMIT 1`;
      if ((old?.version ?? 0)!==input.version) throw new HttpError(409,'SOURCE_MAPPING_VERSION_CONFLICT');
      if (input.bindingVersion!==scope.binding.version || input.connectionVersion!==scope.form.version || input.resourceVersion!==scope.resource.version)
        throw new HttpError(409,'SOURCE_MAPPING_CONFIGURATION_CHANGED');
      if (!input.reason.trim()) throw new HttpError(400,'SOURCE_CHANGE_REASON_REQUIRED');
      if (scope.camp.source_kind!=='META') throw new HttpError(409,'SOURCE_CAMPAIGN_KIND_MISMATCH');
      const targets=await mappingTargets(sql,actor,scope.camp.id,fieldIds(input.entries),true);
      const warnings=validateMappingEntries(input.entries,scope.questions,targets);const required=await requiredFields(sql,scope.camp.id);
      if (required.some((id)=>!input.entries.some((e)=>e.kind==='LEAD_FIELD' && e.fieldId===id))) {
        if (input.status==='PUBLISHED') throw new HttpError(409,'SOURCE_MAPPING_REQUIRED_FIELD_UNMAPPED');warnings.push('SOURCE_MAPPING_REQUIRED_FIELD_UNMAPPED');
      }
      if (input.status==='PUBLISHED' && (!scope.camp.branch_active || !sourceFormAvailable(scope.form))) throw new HttpError(409,'SOURCE_MAPPING_RESOURCE_NOT_AVAILABLE');
      await tx`INSERT INTO source_mapping_revision (binding_id,version,status,binding_version,connection_version,resource_version,catalog_hash,questions,entries,target_snapshot,actor_user_id,reason)
        VALUES (${scope.binding.id},${input.version+1},${input.status},${scope.binding.version},${scope.form.version},${scope.resource.version},${sourceCatalogHash(scope.questions)},
          ${tx.json(scope.questions)},${tx.json(input.entries)},${tx.json(targets)},${actor.id},${input.reason.trim()})`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${scope.camp.branch_id},${actor.id},${'SOURCE_MAPPING_'+input.status},'SOURCE_BINDING',${scope.binding.id},${tx.json({ version:input.version+1 })})`;
      return { version:input.version+1,status:input.status,warnings };
    });
  });
  app.post<{ Params:{ id:string;bindingId:string };Body:Save & { values:SourceValue[] } }>(root+'/preview',{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['entries','values','bindingVersion','connectionVersion','resourceVersion'],properties:{ entries,
      bindingVersion:versionFields.bindingVersion,connectionVersion:versionFields.connectionVersion,resourceVersion:versionFields.resourceVersion,
      values:{ type:'array',maxItems:100,items:{ type:'object',additionalProperties:false,required:['key','values'],properties:{ key:{ type:'string',minLength:1,maxLength:200 },
        values:{ type:'array',maxItems:50,items:{ type:'string',maxLength:20000 } } } } } } } },config:{ rateLimit:{ max:20,timeWindow:'15 minutes' } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const initial=await mappingScope(db,actor,request.params.id,request.params.bindingId);
    return db.begin(async(tx)=> {
      const sql=tx as unknown as Database;await tx`SELECT id FROM integration_connection WHERE id=${initial.binding.connection_id} FOR SHARE`;
      await recheckSourceActor(sql,actor);await sourceCampaign(sql,actor,initial.camp.id,true);
      const scope=await mappingScope(sql,actor,initial.camp.id,initial.binding.id);const input=request.body;
      if (input.bindingVersion!==scope.binding.version || input.connectionVersion!==scope.form.version || input.resourceVersion!==scope.resource.version)
        throw new HttpError(409,'SOURCE_MAPPING_CONFIGURATION_CHANGED');
      const targets=await mappingTargets(sql,actor,scope.camp.id,fieldIds(input.entries),true);
      return previewSourceMapping(input.entries,scope.questions,targets,input.values,await requiredFields(sql,scope.camp.id));
    });
  });
  app.get<{ Params:{ id:string;bindingId:string };Querystring:{ beforeVersion?:number;limit?:number } }>(root+'/history',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ beforeVersion:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const scope=await mappingScope(db,actor,request.params.id,request.params.bindingId);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT * FROM source_mapping_revision WHERE binding_id=${scope.binding.id}
      AND (${request.query.beforeVersion ?? null}::integer IS NULL OR version<${request.query.beforeVersion ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;
    const ids=[...new Set(rows.slice(0,limit).flatMap((r)=>fieldIds(r.entries)))];const current=await mappingTargets(db,actor,scope.camp.id,ids);const allowed=new Set(current.map((t)=>t.id));
    const items=rows.slice(0,limit).map((r)=>({ version:r.version,status:r.status,reason:r.reason,createdAt:r.created_at,
      entries:(r.entries as MappingEntry[]).filter((e)=>e.kind!=='LEAD_FIELD' || allowed.has(e.fieldId!)),
      redacted:(r.entries as MappingEntry[]).some((e)=>e.kind==='LEAD_FIELD' && !allowed.has(e.fieldId!)) }));
    return { items,nextBefore:rows.length>limit ? items.at(-1)!.version : null };
  });
}
