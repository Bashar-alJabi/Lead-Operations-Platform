import type { Database } from '../db.js';
import { HttpError } from '../security.js';
import { resolveSourceContext,type BindingContext } from './bindings.js';
import { sourceCatalogHash,mappingTargetHash,sourceRuntimeTargets,previewSourceMapping,type MappingEntry,type MappingTarget } from './field-mapping.js';
import { validateRetrievedLead } from './meta-lead.js';
import { SourceProviderError,type SourceQuestion } from './meta-provider.js';

// Only declared provider identifiers participate; legacy adgroup_id is never inferred to mean Ad Set.
export function sourceSubmissionData(connectionId:string,externalEventId:string,raw:Record<string,any>) {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  const context=raw.context;
  if (!context || typeof context.pageId!=='string' || !/^\d{1,30}$/.test(context.pageId)
    || typeof context.formId!=='string' || !/^\d{1,30}$/.test(context.formId) || context.leadId!==externalEventId)
    throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
  const lead=validateRetrievedLead(raw.lead,{ leadId:externalEventId,formId:context.formId });
  const notification=raw.notification?.change?.value ?? {};
  for (const [key,expected] of [['page_id',context.pageId],['form_id',context.formId],['leadgen_id',externalEventId]])
    if (notification[key]!=null && notification[key]!==expected) throw new HttpError(409,'SOURCE_CONTEXT_CONFLICT');
  if (raw.notification?.pageId!=null && raw.notification.pageId!==context.pageId) throw new HttpError(409,'SOURCE_CONTEXT_CONFLICT');
  const refs:Record<string,string|null>={};
  for (const key of ['campaign_id','adset_id','ad_id']) {
    const first=lead.raw[key];const second=notification[key];
    if (second!=null && (typeof second!=='string' || !/^\d{1,30}$/.test(second))) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
    if (first!=null && second!=null && first!==second) throw new HttpError(409,'SOURCE_CONTEXT_CONFLICT');
    refs[key]=(first ?? second ?? null) as string|null;
  }
  return { pageId:context.pageId as string,values:lead.values,context:{ connectionId,formId:context.formId,
    externalCampaignId:refs.campaign_id!,externalAdSetId:refs.adset_id!,externalAdId:refs.ad_id! } satisfies BindingContext };
}
type Evaluation={ state:'VALIDATED'|'NEEDS_ATTENTION';errorCode:string|null;codes:string[];resourceId:string|null;campaignId:string|null;
  branchId:string|null;bindingId:string|null;bindingVersion:number|null;mappingVersion:number|null;connectionVersion:number;resourceVersion:number|null;
  mappedFields:number;mappedContactFields:number };
async function evaluate(db:Database,connection:Record<string,any>,submission:Record<string,any>):Promise<Evaluation> {
  const result:Evaluation={ state:'NEEDS_ATTENTION',errorCode:null,codes:[],resourceId:null,campaignId:null,branchId:null,bindingId:null,
    bindingVersion:null,mappingVersion:null,connectionVersion:connection.version,resourceVersion:null,mappedFields:0,mappedContactFields:0 };
  const fail=(code:string,codes=[code]):Evaluation=>({ ...result,errorCode:code,codes:[...new Set(codes)] });
  let source:ReturnType<typeof sourceSubmissionData>;
  try { source=sourceSubmissionData(connection.id,submission.external_event_id,submission.raw_payload); }
  catch (error) { if (error instanceof SourceProviderError || error instanceof HttpError) return fail(error.code);throw error; }
  const [form]=await db`SELECT f.*,p.external_id AS page_external_id,p.active AS page_active,p.connection_version AS page_connection_version
    FROM source_resource f JOIN source_resource p ON p.id=f.parent_id
    WHERE f.connection_id=${connection.id} AND f.resource_kind='FORM' AND f.external_id=${source.context.formId}`;
  if (!form || form.page_external_id!==source.pageId) return fail('SOURCE_FORM_NOT_FOUND');
  result.resourceId=form.id;result.resourceVersion=form.version;
  const bindings=await db`SELECT * FROM source_campaign_binding WHERE connection_id=${connection.id} AND resource_id=${form.id} AND active ORDER BY id`;
  const resolution=resolveSourceContext(bindings.map((b)=>({ id:b.id as string,version:b.version as number,campaign_id:b.campaign_id as string,
    connection_version:b.connection_version as number,connectionId:b.connection_id as string,formId:form.external_id as string,
    externalCampaignId:b.external_campaign_id as string|null,externalAdSetId:b.external_adset_id as string|null,externalAdId:b.external_ad_id as string|null })),source.context);
  if (resolution.state!=='RESOLVED') return fail(resolution.state==='UNMATCHED' ? 'SOURCE_BINDING_UNMATCHED' : 'SOURCE_BINDING_AMBIGUOUS');
  const binding=resolution.binding;result.bindingId=binding.id;result.bindingVersion=binding.version;result.campaignId=binding.campaign_id;
  const [campaign]=await db`SELECT c.*,b.active AS branch_active FROM campaign c JOIN branch b ON b.id=c.branch_id
    WHERE c.id=${binding.campaign_id} AND c.organization_id=${submission.organization_id} FOR SHARE OF b FOR UPDATE OF c`;
  if (!campaign) return fail('SOURCE_CAMPAIGN_NOT_FOUND');result.branchId=campaign.branch_id;
  if (campaign.source_kind!=='META') return fail('SOURCE_CAMPAIGN_KIND_MISMATCH');
  if (!campaign.branch_active) return fail('SOURCE_BRANCH_INACTIVE');
  if (connection.branch_id ? connection.branch_id!==campaign.branch_id : !(await db`SELECT 1 FROM source_resource_access
    WHERE resource_id=${form.id} AND branch_id=${campaign.branch_id} AND active`).length) return fail('SOURCE_RESOURCE_ACCESS_REQUIRED');
  if (!['CONNECTED','WARNING'].includes(connection.status)) return fail('SOURCE_CONNECTION_NOT_AVAILABLE');
  if (!form.active || !form.page_active) return fail('SOURCE_RESOURCE_NOT_AVAILABLE');
  if (form.connection_version!==connection.version || form.page_connection_version!==connection.version || binding.connection_version!==connection.version)
    return fail('SOURCE_CONFIGURATION_CHANGED');
  const [mapping]=await db`SELECT * FROM source_mapping_revision WHERE binding_id=${binding.id} AND status='PUBLISHED' ORDER BY version DESC LIMIT 1`;
  if (!mapping) return fail('SOURCE_MAPPING_NOT_PUBLISHED');result.mappingVersion=mapping.version;
  if (mapping.connection_version!==connection.version || !sourceCatalogHash(form.questions).equals(mapping.catalog_hash)) return fail('SOURCE_MAPPING_CATALOG_CHANGED');
  const entries=mapping.entries as MappingEntry[];const ids=entries.filter((e)=>e.kind==='LEAD_FIELD').map((e)=>e.fieldId!);
  const targets=await sourceRuntimeTargets(db,submission.organization_id,campaign.id,ids,true);const byId=new Map(targets.map((t)=>[t.id,t]));
  if ((mapping.target_snapshot as MappingTarget[]).some((t)=>!byId.has(t.id) || mappingTargetHash(t)!==mappingTargetHash(byId.get(t.id)!)))
    return fail('SOURCE_MAPPING_TARGET_CHANGED');
  const required=await db`SELECT cf.field_id FROM campaign_field cf JOIN field_definition fd ON fd.id=cf.field_id
    WHERE cf.campaign_id=${campaign.id} AND cf.active AND fd.active AND cf.required_stage='LEAD_CREATION' FOR SHARE OF cf,fd`;
  if (required.some((r)=>!ids.includes(r.field_id))) return fail('SOURCE_MAPPING_REQUIRED_FIELD_UNMAPPED');
  try {
    const preview=previewSourceMapping(entries,form.questions as SourceQuestion[],targets,source.values,required.map((r)=>r.field_id as string));
    if (!preview.valid) return fail('SOURCE_MAPPING_VALUE_INVALID',preview.errors.map((e)=>e.code));
    result.mappedFields=preview.fields.length;result.mappedContactFields=Object.keys(preview.contact).length;
    return { ...result,state:'VALIDATED',errorCode:null,codes:preview.warnings };
  } catch (error) { if (error instanceof HttpError) return fail(error.code);throw error; }
}
// Connection first, then submission/processing/campaign/definitions. All effects commit together or remain PENDING on DB failure.
export async function processOneSourceEvaluation(db:Database):Promise<boolean> {
  return db.begin(async(tx)=> {
    const sql=tx as unknown as Database;
    const [connection]=await tx`SELECT c.* FROM integration_connection c WHERE c.kind='META' AND c.provider='META_LEAD_ADS'
      AND EXISTS (SELECT 1 FROM source_processing p WHERE p.connection_id=c.id AND p.state='PENDING')
      ORDER BY (SELECT min(p.updated_at) FROM source_processing p WHERE p.connection_id=c.id AND p.state='PENDING'),c.id
      FOR UPDATE OF c SKIP LOCKED LIMIT 1`;
    if (!connection) return false;
    const [pending]=await tx`SELECT p.* FROM source_processing p WHERE p.connection_id=${connection.id} AND p.state='PENDING'
      ORDER BY p.updated_at,p.submission_id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!pending) return false;
    const [submission]=await tx`SELECT * FROM source_submission WHERE id=${pending.submission_id} FOR UPDATE`;
    if (!submission || submission.lead_id) throw new HttpError(409,'SOURCE_SUBMISSION_ALREADY_PROCESSED');
    const outcome=await evaluate(sql,connection,submission);
    await tx`UPDATE source_processing SET state=${outcome.state},version=version+1,evaluations=evaluations+1,
      campaign_id=${outcome.campaignId},branch_id=${outcome.branchId},resource_id=${outcome.resourceId},binding_id=${outcome.bindingId},
      binding_version=${outcome.bindingVersion},mapping_version=${outcome.mappingVersion},connection_version=${outcome.connectionVersion},resource_version=${outcome.resourceVersion},
      error_code=${outcome.errorCode},codes=${tx.json(outcome.codes)},mapped_fields=${outcome.mappedFields},mapped_contact_fields=${outcome.mappedContactFields},
      actor_user_id=NULL,reason='SOURCE_EVALUATED',updated_at=now() WHERE submission_id=${submission!.id}`;
    await tx`UPDATE source_submission SET state='NEEDS_ATTENTION',failure_code=${outcome.errorCode ?? 'SOURCE_LEAD_CREATION_PENDING'} WHERE id=${submission!.id}`;
    await tx`INSERT INTO audit_log (organization_id,branch_id,action,target_type,target_id,detail)
      VALUES (${submission!.organization_id},${outcome.branchId ?? connection.branch_id},'SOURCE_EVALUATED','SOURCE_SUBMISSION',${submission!.id},
        ${tx.json({ state:outcome.state,errorCode:outcome.errorCode,bindingId:outcome.bindingId,mappingVersion:outcome.mappingVersion })})`;
    return true;
  });
}
