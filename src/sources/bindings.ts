import type { Database } from '../db.js';
import { HttpError,requireRole,type Principal } from '../security.js';

export type SourceSelectors={ externalCampaignId:string|null;externalAdSetId:string|null;externalAdId:string|null };
export type BindingContext=SourceSelectors & { connectionId:string;formId:string };
export function sourceContextsOverlap(a:BindingContext,b:BindingContext):boolean {
  return a.connectionId===b.connectionId && a.formId===b.formId
    && (['externalCampaignId','externalAdSetId','externalAdId'] as const).every((key)=>a[key]===null || b[key]===null || a[key]===b[key]);
}
// A selector requiring a reference never matches a submission missing that reference.
// No specificity ranking or arbitrary winner is used, even if inconsistent data is encountered.
export function resolveSourceContext<T extends BindingContext>(bindings:T[],event:BindingContext):
  { state:'RESOLVED';binding:T }|{ state:'UNMATCHED'|'AMBIGUOUS' } {
  const candidates=bindings.filter((b)=>b.connectionId===event.connectionId && b.formId===event.formId
    && (['externalCampaignId','externalAdSetId','externalAdId'] as const).every((key)=>b[key]===null || b[key]===event[key]));
  return candidates.length===1 ? { state:'RESOLVED',binding:candidates[0]! } : { state:candidates.length ? 'AMBIGUOUS' : 'UNMATCHED' };
}
export async function sourceCampaign(db:Database,actor:Principal,id:string,lock=false) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const [campaign]=lock ? await db`SELECT c.*,b.active AS branch_active FROM campaign c JOIN branch b ON b.id=c.branch_id
    WHERE c.id=${id} AND c.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId}) FOR UPDATE OF c`
    : await db`SELECT c.*,b.active AS branch_active FROM campaign c JOIN branch b ON b.id=c.branch_id
    WHERE c.id=${id} AND c.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})`;
  if (!campaign) throw new HttpError(404,'SOURCE_CAMPAIGN_NOT_FOUND');return campaign;
}
export async function sourceFormForBranch(db:Database,actor:Principal,connectionId:string,formId:string,branchId:string) {
  const [form]=await db`SELECT f.id,f.external_id,f.name,f.questions,f.active,f.connection_version,p.active AS page_active,
    p.connection_version AS page_connection_version,c.version,c.status,c.branch_id,
    c.branch_id IS NOT NULL OR EXISTS (SELECT 1 FROM source_resource_access a WHERE a.resource_id=f.id AND a.branch_id=${branchId} AND a.active) AS has_access
    FROM integration_connection c JOIN source_resource f ON f.connection_id=c.id AND f.resource_kind='FORM'
    JOIN source_resource p ON p.id=f.parent_id WHERE c.id=${connectionId} AND f.id=${formId}
      AND c.organization_id=${actor.organizationId} AND c.kind='META' AND c.provider='META_LEAD_ADS'
      AND (c.branch_id=${branchId} OR (c.branch_id IS NULL AND ((${actor.role==='SUPER_ADMIN'}) OR EXISTS
        (SELECT 1 FROM source_resource_access a WHERE a.resource_id=f.id AND a.branch_id=${branchId} AND a.active))))`;
  if (!form) throw new HttpError(404,'SOURCE_FORM_NOT_FOUND');return form;
}
export function sourceFormAvailable(form:Record<string,unknown>):boolean {
  return ['CONNECTED','WARNING'].includes(String(form.status)) && form.active===true && form.page_active===true
    && form.connection_version===form.version && form.page_connection_version===form.version && form.has_access===true;
}
export function sourceBindingIssues(row:Record<string,unknown>):string[] {
  const issues:string[]=[];
  if (!row.active) issues.push('SOURCE_BINDING_INACTIVE');
  if (row.source_kind!=='META') issues.push('SOURCE_CAMPAIGN_KIND_MISMATCH');
  if (!row.branch_active) issues.push('SOURCE_BRANCH_INACTIVE');
  if (!row.has_access) issues.push('SOURCE_RESOURCE_ACCESS_REQUIRED');
  if (!['CONNECTED','WARNING'].includes(String(row.connection_status))) issues.push('SOURCE_CONNECTION_NOT_AVAILABLE');
  if (!row.form_active || !row.page_active) issues.push('SOURCE_RESOURCE_NOT_AVAILABLE');
  if (row.connection_version!==row.current_connection_version || row.form_connection_version!==row.current_connection_version
    || row.page_connection_version!==row.current_connection_version) issues.push('SOURCE_CONFIGURATION_CHANGED');
  if (!row.mapping_configured) issues.push('SOURCE_MAPPING_NOT_CONFIGURED');
  issues.push('SOURCE_INTAKE_NOT_CONFIGURED');return issues;
}
export function sourceBindingConflict(error:unknown):never {
  if (error instanceof Error && error.message==='SOURCE_BINDING_CONTEXT_CONFLICT') throw new HttpError(409,'SOURCE_BINDING_CONTEXT_CONFLICT');
  throw error;
}
