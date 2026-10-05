import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError,type Principal } from '../security.js';
import { identityLockKeys,normalizeSourceContact,type NormalizedContact } from '../contacts.js';
import { routeLead } from '../routing.js';
import { evaluateSource,type Evaluation } from './evaluation.js';

function identityPredicate(db:Database,organizationId:string,contact:NormalizedContact) {
  return db`c.organization_id=${organizationId} AND ((${contact.phoneNormalized}::text IS NOT NULL AND c.phone_normalized=${contact.phoneNormalized})
    OR (${contact.emailNormalized}::text IS NOT NULL AND c.email_normalized=${contact.emailNormalized}))`;
}
export async function lockSourceIdentities(db:Database,organizationId:string,contact:NormalizedContact|null) {
  if (contact) for (const key of identityLockKeys(organizationId,contact)) await db`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
}
export async function sourceCandidatePage(db:Database,organizationId:string,contact:NormalizedContact|null,actor:Principal,after:string|null,limit:number) {
  if (!contact) return { items:[],nextAfter:null,adminRequired:false };
  const matches=identityPredicate(db,organizationId,contact);
  const restricted=db`NOT EXISTS (SELECT 1 FROM lead l WHERE l.contact_id=c.id AND l.branch_id=${actor.branchId})
    OR EXISTS (SELECT 1 FROM lead l WHERE l.contact_id=c.id AND l.branch_id<>${actor.branchId})`;
  const [restriction]=await db`SELECT EXISTS (SELECT 1 FROM contact c WHERE ${matches} AND (${restricted})) AS required`;
  const rows=await db`SELECT c.id,c.name,c.phone,c.email FROM contact c WHERE ${matches}
    AND (${actor.role==='SUPER_ADMIN'} OR EXISTS (SELECT 1 FROM lead l WHERE l.contact_id=c.id AND l.branch_id=${actor.branchId}))
    AND (${after}::uuid IS NULL OR c.id>${after}::uuid) ORDER BY c.id LIMIT ${limit+1}`;
  const items=rows.slice(0,limit);return { items,nextAfter:rows.length>limit ? items.at(-1)!.id : null,
    adminRequired:actor.role!=='SUPER_ADMIN' && restriction!.required===true };
}
// Every call has the Connection and processing row locked. Identity locks are shared with manual intake/edit.
export async function intakeSource(tx:postgres.TransactionSql,connection:Record<string,any>,processing:Record<string,any>,submission:Record<string,any>,
  actor?:Principal,choice?:{ contactId:string;reason:string }) {
  const db=tx as unknown as Database;const outcome=await evaluateSource(db,connection,submission,true);
  if (actor?.role==='MANAGER' && outcome.branchId!==actor.branchId) throw new HttpError(404,'SOURCE_SUBMISSION_NOT_FOUND');
  let failure=outcome.errorCode;let contactId:string|null=null;
  const prepared=outcome.prepared;
  if (!failure && prepared!.campaign.status!=='ACTIVE') failure='SOURCE_CAMPAIGN_INACTIVE';
  // Dispatch dependencies are enabled only when their required campaign flows are implemented and ready.
  if (!failure && (prepared!.campaign.messaging_config?.enabled || prepared!.campaign.ai_config?.enabled)) failure='SOURCE_CAMPAIGN_FLOW_NOT_READY';
  if (!failure) {
    const normalized=normalizeSourceContact(prepared!.contact);await lockSourceIdentities(db,submission.organization_id,normalized);
    const matches=normalized ? await tx`SELECT c.id FROM contact c WHERE ${identityPredicate(db,submission.organization_id,normalized)} ORDER BY c.id LIMIT 2 FOR UPDATE` : [];
    if (choice) {
      if (!normalized) throw new HttpError(409,'SOURCE_CONTACT_MATCH_CHANGED');
      const [selected]=await tx`SELECT c.id FROM contact c WHERE c.id=${choice.contactId} AND ${identityPredicate(db,submission.organization_id,normalized)} FOR UPDATE`;
      if (!selected) throw new HttpError(409,'SOURCE_CONTACT_MATCH_CHANGED');
      const candidates=await sourceCandidatePage(db,submission.organization_id,normalized,actor!,null,1);
      if (candidates.adminRequired) throw new HttpError(403,'CONTACT_REVIEW_REQUIRES_ADMIN');
      contactId=selected.id;
    } else if (matches.length>1) failure='CONTACT_AMBIGUOUS';
    else if (matches.length===1) contactId=matches[0]!.id;
    else if (normalized) {
      const [created]=await tx`INSERT INTO contact (organization_id,name,phone,phone_normalized,email,email_normalized)
        VALUES (${submission.organization_id},${normalized.name},${normalized.phone},${normalized.phoneNormalized},${normalized.email},${normalized.emailNormalized}) RETURNING id`;
      contactId=created!.id;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id)
        VALUES (${submission.organization_id},${outcome.branchId},${actor?.id ?? null},'CONTACT_CREATED','CONTACT',${contactId})`;
    }
  }
  // An explicit resolution never silently becomes a different operation on a stale mapping/campaign.
  if (choice && failure) throw new HttpError(409,failure);
  let leadId:string|null=null;
  if (!failure) {
    const [lead]=await tx`INSERT INTO lead (organization_id,branch_id,campaign_id,contact_id,source_kind)
      VALUES (${submission.organization_id},${outcome.branchId},${outcome.campaignId},${contactId},'META') RETURNING id`;
    leadId=lead!.id;
    for (const field of prepared!.fields) {
      const value=field.value as postgres.JSONValue;
      await tx`INSERT INTO lead_field_value (lead_id,field_id,value,source,updated_by,source_submission_id,source_binding_id,source_mapping_version)
        VALUES (${leadId},${field.fieldId},${tx.json(value)},'SOURCE',${actor?.id ?? null},${submission.id},${outcome.bindingId},${outcome.mappingVersion})`;
      await tx`INSERT INTO field_value_history (lead_id,field_id,new_value,source,actor_user_id,source_submission_id,source_binding_id,source_mapping_version)
        VALUES (${leadId},${field.fieldId},${tx.json(value)},'SOURCE',${actor?.id ?? null},${submission.id},${outcome.bindingId},${outcome.mappingVersion})`;
    }
    await tx`UPDATE source_submission SET state='PROCESSED',failure_code=NULL,branch_id=${outcome.branchId},campaign_id=${outcome.campaignId},
      lead_id=${leadId},resolution_contact_id=${contactId} WHERE id=${submission.id}`;
    await tx`INSERT INTO lead_activity (lead_id,actor_user_id,event_type,detail) VALUES (${leadId},${actor?.id ?? null},'SOURCE_LEAD_CREATED',
      ${tx.json({ submissionId:submission.id,bindingId:outcome.bindingId,mappingVersion:outcome.mappingVersion,contactResolution:choice ? 'REVIEW' : contactId ? 'MATCH_OR_CREATE' : 'UNAVAILABLE' })})`;
    await routeLead(tx,outcome.campaignId!,outcome.branchId!,prepared!.campaign.routing_method,prepared!.campaign.timezone,leadId!);
  } else await tx`UPDATE source_submission SET state='NEEDS_ATTENTION',failure_code=${failure} WHERE id=${submission.id}`;
  await saveIntakeResult(tx,submission.id,outcome,failure,actor?.id ?? null,choice?.reason ?? 'SOURCE_INTAKE_EXECUTED');
  await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (${submission.organization_id},${outcome.branchId ?? connection.branch_id},${actor?.id ?? null},'SOURCE_INTAKE_EXECUTED','SOURCE_SUBMISSION',${submission.id},
      ${tx.json({ state:failure ? 'NEEDS_ATTENTION' : 'PROCESSED',errorCode:failure,leadId,contactId,bindingId:outcome.bindingId,mappingVersion:outcome.mappingVersion,
        previousVersion:processing.version,reason:choice?.reason ?? null })})`;
  return { state:failure ? 'NEEDS_ATTENTION' : 'PROCESSED',version:processing.version+1,id:leadId };
}
async function saveIntakeResult(tx:postgres.TransactionSql,id:string,outcome:Evaluation,failure:string|null,actorId:string|null,reason:string) {
  await tx`UPDATE source_processing SET state=${failure ? 'NEEDS_ATTENTION' : 'PROCESSED'},error_code=${failure},version=version+1,
    intake_attempts=intake_attempts+1,evaluations=evaluations+1,campaign_id=${outcome.campaignId},branch_id=${outcome.branchId},resource_id=${outcome.resourceId},binding_id=${outcome.bindingId},
    binding_version=${outcome.bindingVersion},mapping_version=${outcome.mappingVersion},connection_version=${outcome.connectionVersion},resource_version=${outcome.resourceVersion},
    codes=${tx.json(failure ? [...new Set([failure,...outcome.codes])] : outcome.codes)},mapped_fields=${outcome.mappedFields},mapped_contact_fields=${outcome.mappedContactFields},
    actor_user_id=${actorId},reason=${reason},updated_at=now() WHERE submission_id=${id}`;
}
export async function processOneSourceIntake(db:Database):Promise<boolean> {
  return db.begin(async(tx)=> {
    const [connection]=await tx`SELECT c.* FROM integration_connection c WHERE c.kind='META' AND c.provider='META_LEAD_ADS'
      AND EXISTS (SELECT 1 FROM source_processing p WHERE p.connection_id=c.id AND p.state='VALIDATED')
      ORDER BY (SELECT min(p.updated_at) FROM source_processing p WHERE p.connection_id=c.id AND p.state='VALIDATED'),c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1`;
    if (!connection) return false;
    const [processing]=await tx`SELECT * FROM source_processing WHERE connection_id=${connection.id} AND state='VALIDATED'
      ORDER BY updated_at,submission_id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!processing) return false;
    const [submission]=await tx`SELECT * FROM source_submission WHERE id=${processing.submission_id} FOR UPDATE`;
    if (!submission || submission.lead_id) throw new HttpError(409,'SOURCE_SUBMISSION_ALREADY_PROCESSED');
    await intakeSource(tx,connection,processing,submission);return true;
  });
}
