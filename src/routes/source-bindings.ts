import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,requireRole } from '../security.js';
import { managedSourceConnection,recheckSourceActor } from '../sources/catalog-sync.js';
import { sourceCampaign,sourceFormForBranch,sourceFormAvailable,sourceBindingIssues,sourceBindingConflict,type SourceSelectors } from '../sources/bindings.js';

const uuid={ type:'string',format:'uuid' } as const;
const campaignParams={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
const bindingParams={ ...campaignParams,required:['id','bindingId'],properties:{ id:uuid,bindingId:uuid } } as const;
const paging={ type:'object',additionalProperties:false,properties:{ after:uuid,limit:{ type:'integer',minimum:1,maximum:100 } } } as const;
const external={ anyOf:[{ type:'null' },{ type:'string',pattern:'^[0-9]{1,30}$' }] } as const;
const selectors={ externalCampaignId:external,externalAdSetId:external,externalAdId:external } as const;
const editProperties={ ...selectors,active:{ type:'boolean' },reason:{ type:'string',minLength:1,maxLength:500 },connectionVersion:{ type:'integer',minimum:1 } } as const;
type BindingInput=SourceSelectors & { active:boolean;reason:string;connectionVersion:number;connectionId:string;formId:string;requestId:string;version:number };
const requiredEdit=['externalCampaignId','externalAdSetId','externalAdId','active','reason','connectionVersion'];
const root='/api/sources/campaigns/:id';

export function registerSourceBindingRoutes(app:FastifyInstance,db:Database):void {
  app.get<{ Params:{ id:string };Querystring:{ after?:string;limit?:number } }>(root+'/connections',{ schema:{ params:campaignParams,querystring:paging } },async(request)=> {
    const actor=await principalFromRequest(request,db);const camp=await sourceCampaign(db,actor,request.params.id);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT c.id,c.name,c.branch_id,c.status,c.version FROM integration_connection c
      WHERE c.organization_id=${actor.organizationId} AND c.kind='META' AND c.provider='META_LEAD_ADS'
      AND (c.branch_id=${camp.branch_id} OR (c.branch_id IS NULL AND (${actor.role==='SUPER_ADMIN'} OR EXISTS
        (SELECT 1 FROM source_resource_access a JOIN source_resource f ON f.id=a.resource_id WHERE f.connection_id=c.id AND a.branch_id=${camp.branch_id} AND a.active))))
      AND (${request.query.after ?? null}::uuid IS NULL OR c.id>${request.query.after ?? null}::uuid) ORDER BY c.id LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextAfter:rows.length>limit ? items.at(-1)!.id : null };
  });
  app.get<{ Params:{ id:string;connectionId:string };Querystring:{ kind:'PAGE'|'FORM';pageId?:string;after?:string;limit?:number } }>(root+'/connections/:connectionId/resources',{
    schema:{ params:{ ...campaignParams,required:['id','connectionId'],properties:{ id:uuid,connectionId:uuid } },querystring:{ ...paging,required:['kind'],
      properties:{ ...paging.properties,kind:{ enum:['PAGE','FORM'] },pageId:uuid } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const camp=await sourceCampaign(db,actor,request.params.id);
    const [conn]=await db`SELECT id,branch_id,version,status FROM integration_connection c WHERE c.id=${request.params.connectionId}
      AND c.organization_id=${actor.organizationId} AND c.kind='META' AND c.provider='META_LEAD_ADS'
      AND (c.branch_id=${camp.branch_id} OR (c.branch_id IS NULL AND (${actor.role==='SUPER_ADMIN'} OR EXISTS
        (SELECT 1 FROM source_resource_access a JOIN source_resource f ON f.id=a.resource_id WHERE f.connection_id=c.id AND a.branch_id=${camp.branch_id} AND a.active))))`;
    if (!conn) throw new HttpError(404,'SOURCE_CONNECTION_NOT_FOUND');
    if (request.query.kind==='PAGE' && request.query.pageId) throw new HttpError(400,'SOURCE_PARENT_NOT_ALLOWED');
    const limit=request.query.limit ?? 50;
    const rows=await db`SELECT r.id,r.parent_id,r.external_id,r.name,r.provider_status,r.questions,r.active,r.connection_version,r.version
      FROM source_resource r WHERE r.connection_id=${conn.id} AND r.resource_kind=${request.query.kind}
      AND (${request.query.pageId ?? null}::uuid IS NULL OR r.parent_id=${request.query.pageId ?? null}::uuid)
      AND (${actor.role==='SUPER_ADMIN'} OR ${conn.branch_id!==null} OR EXISTS
        (SELECT 1 FROM source_resource_access a JOIN source_resource f ON f.id=a.resource_id WHERE a.branch_id=${camp.branch_id} AND a.active
          AND (a.resource_id=r.id OR (r.resource_kind='PAGE' AND f.parent_id=r.id))))
      AND (${request.query.after ?? null}::uuid IS NULL OR r.id>${request.query.after ?? null}::uuid) ORDER BY r.id LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextAfter:rows.length>limit ? items.at(-1)!.id : null };
  });
  app.get<{ Params:{ id:string };Querystring:{ after?:string;limit?:number } }>(root+'/bindings',{ schema:{ params:campaignParams,querystring:paging } },async(request)=> {
    const actor=await principalFromRequest(request,db);const camp=await sourceCampaign(db,actor,request.params.id);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT b.id,b.connection_id,b.resource_id,b.campaign_id,b.external_campaign_id,b.external_adset_id,b.external_ad_id,
      b.active,b.connection_version,b.version,b.created_at,b.updated_at,f.external_id AS form_external_id,f.name AS form_name,
      p.external_id AS page_external_id,p.name AS page_name,c.name AS connection_name,c.status AS connection_status,c.version AS current_connection_version,
      f.active AS form_active,f.connection_version AS form_connection_version,p.active AS page_active,p.connection_version AS page_connection_version,
      c.branch_id IS NOT NULL OR EXISTS (SELECT 1 FROM source_resource_access a WHERE a.resource_id=f.id AND a.branch_id=${camp.branch_id} AND a.active) AS has_access,
      m.version IS NOT NULL AND m.connection_version=c.version AND m.questions=f.questions
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.target_snapshot) target
          LEFT JOIN field_definition fd ON fd.id=(target->>'id')::uuid
          LEFT JOIN campaign_field cf ON cf.field_id=fd.id AND cf.campaign_id=b.campaign_id
          WHERE fd.id IS NULL OR cf.field_id IS NULL OR NOT fd.active OR NOT cf.active OR fd.version<>(target->>'version')::integer
            OR cf.version<>(target->>'binding_version')::integer)
        AND NOT EXISTS (SELECT 1 FROM campaign_field required JOIN field_definition fd ON fd.id=required.field_id
          WHERE required.campaign_id=b.campaign_id AND required.active AND fd.active AND required.required_stage='LEAD_CREATION'
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.entries) entry WHERE entry->>'kind'='LEAD_FIELD' AND entry->>'fieldId'=fd.id::text)) AS mapping_configured
      FROM source_campaign_binding b JOIN source_resource f ON f.id=b.resource_id JOIN source_resource p ON p.id=f.parent_id
      JOIN integration_connection c ON c.id=b.connection_id
      LEFT JOIN LATERAL (SELECT version,connection_version,questions,entries,target_snapshot FROM source_mapping_revision
        WHERE binding_id=b.id AND status='PUBLISHED' ORDER BY version DESC LIMIT 1) m ON true WHERE b.campaign_id=${camp.id}
      AND (${request.query.after ?? null}::uuid IS NULL OR b.id>${request.query.after ?? null}::uuid) ORDER BY b.id LIMIT ${limit+1}`;
    const items=rows.slice(0,limit).map((row)=>({ ...row,ready:false,issues:sourceBindingIssues({ ...row,source_kind:camp.source_kind,branch_active:camp.branch_active }) }));
    return { items,nextAfter:rows.length>limit ? rows[limit-1]!.id : null };
  });
  app.post<{ Params:{ id:string };Body:BindingInput }>(root+'/bindings',{ schema:{ params:campaignParams,body:{ type:'object',additionalProperties:false,
    required:[...requiredEdit,'connectionId','formId','requestId'],properties:{ ...editProperties,connectionId:uuid,formId:uuid,requestId:uuid } } } },async(request,reply)=> {
    const actor=await principalFromRequest(request,db);const camp=await sourceCampaign(db,actor,request.params.id);const input=request.body;
    const result=await db.begin(async(tx)=> {
      const sql=tx as unknown as Database;
      // Always acquire the Connection before campaign/grant/binding locks, like catalog sync and revocation.
      await tx`SELECT id FROM integration_connection WHERE id=${input.connectionId} FOR UPDATE`;
      await recheckSourceActor(sql,actor);const current=await sourceCampaign(sql,actor,camp.id,true);
      const form=await sourceFormForBranch(sql,actor,input.connectionId,input.formId,current.branch_id);
      const [existing]=await tx`SELECT b.id,h.snapshot,h.reason FROM source_campaign_binding b JOIN source_binding_history h ON h.binding_id=b.id AND h.version=1
        WHERE b.campaign_id=${current.id} AND b.request_key=${input.requestId}`;
      const snapshot={ connectionId:input.connectionId,resourceId:input.formId,campaignId:current.id,externalCampaignId:input.externalCampaignId,
        externalAdSetId:input.externalAdSetId,externalAdId:input.externalAdId,active:input.active,connectionVersion:input.connectionVersion };
      if (existing) {
        if (existing.reason!==input.reason.trim() || Object.entries(snapshot).some(([key,value])=>existing.snapshot[key]!==value)) throw new HttpError(409,'SOURCE_BINDING_IDEMPOTENCY_CONFLICT');
        return { id:existing.id,replayed:true };
      }
      if (!input.reason.trim()) throw new HttpError(400,'SOURCE_CHANGE_REASON_REQUIRED');
      if (form.version!==input.connectionVersion) throw new HttpError(409,'SOURCE_CONNECTION_VERSION_CONFLICT');
      if (current.source_kind!=='META') throw new HttpError(409,'SOURCE_CAMPAIGN_KIND_MISMATCH');
      if (input.active && (!current.branch_active || !sourceFormAvailable(form))) throw new HttpError(409,'SOURCE_BINDING_NOT_AVAILABLE');
      const id=randomUUID();await tx`INSERT INTO source_campaign_binding (id,connection_id,resource_id,campaign_id,request_key,
        external_campaign_id,external_adset_id,external_ad_id,active,connection_version,updated_by,change_reason)
        VALUES (${id},${input.connectionId},${input.formId},${current.id},${input.requestId},${input.externalCampaignId},${input.externalAdSetId},${input.externalAdId},
          ${input.active},${form.version},${actor.id},${input.reason.trim()})`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id)
        VALUES (${actor.organizationId},${current.branch_id},${actor.id},'SOURCE_BINDING_CREATED','SOURCE_BINDING',${id})`;
      return { id,replayed:false };
    }).catch(sourceBindingConflict);
    reply.code(result.replayed ? 200 : 201);return result;
  });
  app.put<{ Params:{ id:string;bindingId:string };Body:BindingInput }>(root+'/bindings/:bindingId',{ schema:{ params:bindingParams,body:{ type:'object',additionalProperties:false,
    required:[...requiredEdit,'version'],properties:{ ...editProperties,version:{ type:'integer',minimum:1 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const camp=await sourceCampaign(db,actor,request.params.id);
    const [old]=await db`SELECT connection_id FROM source_campaign_binding WHERE id=${request.params.bindingId} AND campaign_id=${camp.id}`;
    if (!old) throw new HttpError(404,'SOURCE_BINDING_NOT_FOUND');const input=request.body;
    return db.begin(async(tx)=> {
      const sql=tx as unknown as Database;await tx`SELECT id FROM integration_connection WHERE id=${old.connection_id} FOR UPDATE`;
      await recheckSourceActor(sql,actor);const current=await sourceCampaign(sql,actor,camp.id,true);
      const [binding]=await tx`SELECT * FROM source_campaign_binding WHERE id=${request.params.bindingId} FOR UPDATE`;
      if (binding!.version!==input.version) throw new HttpError(409,'SOURCE_BINDING_VERSION_CONFLICT');
      if (!input.reason.trim()) throw new HttpError(400,'SOURCE_CHANGE_REASON_REQUIRED');
      // Disabling remains possible after a resource grant/connection is revoked. Enabling or editing requires current access.
      const onlyDisable=!input.active && binding!.external_campaign_id===input.externalCampaignId && binding!.external_adset_id===input.externalAdSetId
        && binding!.external_ad_id===input.externalAdId;
      let connectionVersion=binding!.connection_version;
      if (!onlyDisable) {
        const form=await sourceFormForBranch(sql,actor,old.connection_id,binding!.resource_id,current.branch_id);
        if (form.version!==input.connectionVersion) throw new HttpError(409,'SOURCE_CONNECTION_VERSION_CONFLICT');
        if (current.source_kind!=='META') throw new HttpError(409,'SOURCE_CAMPAIGN_KIND_MISMATCH');
        if (input.active && (!current.branch_active || !sourceFormAvailable(form))) throw new HttpError(409,'SOURCE_BINDING_NOT_AVAILABLE');
        connectionVersion=form.version;
      }
      const [changed]=await tx`UPDATE source_campaign_binding SET external_campaign_id=${input.externalCampaignId},external_adset_id=${input.externalAdSetId},
        external_ad_id=${input.externalAdId},active=${input.active},connection_version=${connectionVersion},version=version+1,updated_by=${actor.id},
        change_reason=${input.reason.trim()} WHERE id=${binding!.id} RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${current.branch_id},${actor.id},'SOURCE_BINDING_UPDATED','SOURCE_BINDING',${binding!.id},${tx.json({ version:changed!.version })})`;
      return { version:changed!.version };
    }).catch(sourceBindingConflict);
  });
  app.get<{ Params:{ id:string;bindingId:string };Querystring:{ beforeVersion?:number;limit?:number } }>(root+'/bindings/:bindingId/history',{
    schema:{ params:bindingParams,querystring:{ type:'object',additionalProperties:false,properties:{ beforeVersion:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const camp=await sourceCampaign(db,actor,request.params.id);
    if (!(await db`SELECT 1 FROM source_campaign_binding WHERE id=${request.params.bindingId} AND campaign_id=${camp.id}`).length) throw new HttpError(404,'SOURCE_BINDING_NOT_FOUND');
    const limit=request.query.limit ?? 30;const rows=await db`SELECT version,actor_user_id,snapshot,reason,created_at FROM source_binding_history
      WHERE binding_id=${request.params.bindingId} AND (${request.query.beforeVersion ?? null}::integer IS NULL OR version<${request.query.beforeVersion ?? null})
      ORDER BY version DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextBefore:rows.length>limit ? items.at(-1)!.version : null };
  });
  const accessRoot='/api/sources/meta/connections/:id/resources/:resourceId/access';
  const accessParams={ ...campaignParams,required:['id','resourceId'],properties:{ id:uuid,resourceId:uuid } } as const;
  app.get<{ Params:{ id:string;resourceId:string };Querystring:{ after?:string;limit?:number } }>(accessRoot,{ schema:{ params:accessParams,querystring:paging } },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN');const conn=await managedSourceConnection(db,actor,request.params.id);
    if (conn.branch_id!==null || !(await db`SELECT 1 FROM source_resource WHERE id=${request.params.resourceId} AND connection_id=${conn.id} AND resource_kind='FORM'`).length)
      throw new HttpError(404,'SOURCE_SHARED_FORM_NOT_FOUND');
    const limit=request.query.limit ?? 30;const rows=await db`SELECT a.branch_id,b.name,a.active,a.version,a.updated_at,a.change_reason FROM source_resource_access a
      JOIN branch b ON b.id=a.branch_id WHERE a.resource_id=${request.params.resourceId}
      AND (${request.query.after ?? null}::uuid IS NULL OR a.branch_id>${request.query.after ?? null}::uuid) ORDER BY a.branch_id LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextAfter:rows.length>limit ? items.at(-1)!.branch_id : null };
  });
  app.put<{ Params:{ id:string;resourceId:string;branchId:string };Body:{ version:number;active:boolean;reason:string } }>(accessRoot+'/:branchId',{
    schema:{ params:{ ...accessParams,required:['id','resourceId','branchId'],properties:{ ...accessParams.properties,branchId:uuid } },body:{ type:'object',additionalProperties:false,
      required:['version','active','reason'],properties:{ version:{ type:'integer',minimum:0 },active:{ type:'boolean' },reason:{ type:'string',minLength:1,maxLength:500 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN');const conn=await managedSourceConnection(db,actor,request.params.id);
    const input=request.body;if (!input.reason.trim()) throw new HttpError(400,'SOURCE_CHANGE_REASON_REQUIRED');
    return db.begin(async(tx)=> {
      await tx`SELECT id FROM integration_connection WHERE id=${conn.id} FOR UPDATE`;await recheckSourceActor(tx as unknown as Database,actor);
      if (conn.branch_id!==null || !(await tx`SELECT 1 FROM source_resource WHERE id=${request.params.resourceId} AND connection_id=${conn.id} AND resource_kind='FORM'`).length)
        throw new HttpError(404,'SOURCE_SHARED_FORM_NOT_FOUND');
      if (!(await tx`SELECT 1 FROM branch WHERE id=${request.params.branchId} AND organization_id=${actor.organizationId} AND (${!input.active} OR active) FOR SHARE`).length)
        throw new HttpError(404,'SOURCE_BRANCH_NOT_FOUND');
      const [old]=await tx`SELECT version FROM source_resource_access WHERE resource_id=${request.params.resourceId} AND branch_id=${request.params.branchId} FOR UPDATE`;
      if ((old?.version ?? 0)!==input.version) throw new HttpError(409,'SOURCE_RESOURCE_ACCESS_VERSION_CONFLICT');
      const [updated]=old ? await tx`UPDATE source_resource_access SET active=${input.active},version=version+1,updated_by=${actor.id},change_reason=${input.reason.trim()}
        WHERE resource_id=${request.params.resourceId} AND branch_id=${request.params.branchId} RETURNING version`
        : await tx`INSERT INTO source_resource_access (resource_id,branch_id,active,updated_by,change_reason)
          VALUES (${request.params.resourceId},${request.params.branchId},${input.active},${actor.id},${input.reason.trim()}) RETURNING version`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${request.params.branchId},${actor.id},'SOURCE_RESOURCE_ACCESS_UPDATED','SOURCE_RESOURCE',${request.params.resourceId},
          ${tx.json({ active:input.active,version:updated!.version })})`;
      return { version:updated!.version };
    });
  });
  app.get<{ Params:{ id:string;resourceId:string;branchId:string };Querystring:{ beforeVersion?:number;limit?:number } }>(accessRoot+'/:branchId/history',{
    schema:{ params:{ ...accessParams,required:['id','resourceId','branchId'],properties:{ ...accessParams.properties,branchId:uuid } },querystring:{ type:'object',additionalProperties:false,
      properties:{ beforeVersion:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN');await managedSourceConnection(db,actor,request.params.id);
    if (!(await db`SELECT 1 FROM source_resource WHERE id=${request.params.resourceId} AND connection_id=${request.params.id}`).length) throw new HttpError(404,'SOURCE_RESOURCE_NOT_FOUND');
    const limit=request.query.limit ?? 30;const rows=await db`SELECT version,actor_user_id,active,reason,created_at FROM source_resource_access_history
      WHERE resource_id=${request.params.resourceId} AND branch_id=${request.params.branchId}
      AND (${request.query.beforeVersion ?? null}::integer IS NULL OR version<${request.query.beforeVersion ?? null}) ORDER BY version DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextBefore:rows.length>limit ? items.at(-1)!.version : null };
  });
}
