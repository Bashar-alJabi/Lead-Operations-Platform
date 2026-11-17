import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type postgres from 'postgres';
import type {Database} from '../db.js';
import {HttpError,type Principal} from '../security.js';
import {normalizeSourceContact,type NormalizedContact} from '../contacts.js';
import {validateFieldValue} from '../fields.js';
import {routeLead} from '../routing.js';
import {recordLeadIntakeOrigin} from '../lead-intake-origin.js';
import {lockSourceIdentities,sourceCandidatePage} from '../sources/intake.js';
import {importLimits,type ImportFile} from './service.js';
import {importMappingTargets,importMappingHash} from './mapping.js';
import {lockReviewFields,missingImportFields} from './review.js';

export type ImportResult={submission_id:string;execution_id:string;state:string;version:number;failure_count:number;lead_id:string|null;error_code:string|null};
type ApprovedRow={dataset_id:string;sheet_index:number;row_number:number;mapping_version:number;contact:NormalizedContact|null;fields:{fieldId:string;value:postgres.JSONValue}[]};
export async function importResultAudit(tx:postgres.TransactionSql,j:ImportFile,subid:string,action:string,actor:string|null,detail:Record<string,postgres.JSONValue>){
 await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
  VALUES(${j.organization_id},${j.branch_id},${actor},${action},'SOURCE_SUBMISSION',${subid},${tx.json(detail)})`;
}
// Same parent order as Routing/intake; no private-file TTL or fabricated HTTP session in background.
export async function lockImportResult(tx:postgres.TransactionSql,subid:string,skip=false){
 await importLimits(tx);
 const initial=(await tx`SELECT f.id,f.branch_id,f.campaign_id,f.actor_id FROM lead_import_dataset_row dr JOIN lead_import_file f ON f.id=dr.file_id WHERE dr.submission_id=${subid}`)[0];
 if(!initial)return null;
 await tx`SELECT id FROM branch WHERE id=${initial.branch_id} FOR NO KEY UPDATE`;
 await tx`SELECT id FROM campaign WHERE id=${initial.campaign_id} FOR NO KEY UPDATE`;
 await tx`SELECT id FROM user_account WHERE id=${initial.actor_id} FOR SHARE`;
 const j=(await tx`SELECT * FROM lead_import_file WHERE id=${initial.id} FOR SHARE`)[0] as ImportFile;
 await lockReviewFields(tx,j);
 const r=(await tx`SELECT * FROM lead_import_result WHERE submission_id=${subid} ${skip?tx`FOR UPDATE SKIP LOCKED`:tx`FOR UPDATE`}`)[0] as ImportResult|undefined;
 if(!r)return null;
 const row=(await tx`SELECT * FROM lead_import_dataset_row WHERE submission_id=${subid}`)[0] as ApprovedRow;
 return {j,r,row};
}
export async function changeImportResult(tx:postgres.TransactionSql,j:ImportFile,r:ImportResult,state:string,error:string|null,leadId:string|null=null,failures=r.failure_count,delay=0){
 await importResultAudit(tx,j,r.submission_id,'IMPORT_ROW_STATE',null,{version:r.version+1,state,errorCode:error,leadId});
 await tx`UPDATE lead_import_result SET state=${state},version=version+1,failure_count=${failures},error_code=${error},lead_id=${leadId},
  next_run_at=clock_timestamp()+${delay}*interval '1 second' WHERE submission_id=${r.submission_id}`;
}
export async function currentImportRow(tx:postgres.TransactionSql,j:ImportFile,row:ApprovedRow){
 if(!(await tx`SELECT lead_import_execution_allowed(${row.dataset_id}) allowed`)[0]!.allowed)throw new HttpError(409,'IMPORT_INTAKE_AUTHORITY_UNAVAILABLE');
 const c=(await tx`SELECT c.*,b.timezone FROM campaign c JOIN branch b ON b.id=c.branch_id WHERE c.id=${j.campaign_id}`)[0]!;
 // Retain the existing Source flow readiness boundary; this adapter cannot bypass it.
 if((c.messaging_config?.enabled||c.ai_config?.enabled)&&!(c.ai_config?.enabled&&(await tx`SELECT 1 FROM ai_initial_message_policy WHERE campaign_id=${c.id}`).length))throw new HttpError(409,'IMPORT_CAMPAIGN_FLOW_NOT_READY');
 const ids=row.fields.map(f=>f.fieldId),targets=await importMappingTargets(tx,j,ids);
 if(targets.length!==ids.length)throw new HttpError(409,'IMPORT_FIELD_NOT_AVAILABLE');
 if(await missingImportFields(tx,j,ids))throw new HttpError(409,'IMPORT_REQUIRED_VALUE_MISSING');
 for(const f of row.fields){const target=targets.find(t=>t.id===f.fieldId)!;
  const current=validateFieldValue(target.field_type,f.value,target.options,target.validation);
  if(!isDeepStrictEqual(current,f.value))throw new HttpError(409,'IMPORT_APPROVED_VALUE_CHANGED');}
 const contact=row.contact?normalizeSourceContact({name:row.contact.name,phone:row.contact.phone??undefined,email:row.contact.email??undefined}):null;
 if(!isDeepStrictEqual(contact,row.contact))throw new HttpError(409,'IMPORT_APPROVED_CONTACT_CHANGED');
 return {campaign:c,contact,configurationHash:await importMappingHash(tx,j.id)};
}
export type ImportChoice={actor:Principal;sessionId:string;requestId:string;contactId:string;reason:string};
export async function intakeApprovedImport(tx:postgres.TransactionSql,locked:NonNullable<Awaited<ReturnType<typeof lockImportResult>>>,choice?:ImportChoice){
 const {j,r,row}=locked,db=tx as unknown as Database,prepared=await currentImportRow(tx,j,row),contact=prepared.contact;
 await lockSourceIdentities(db,j.organization_id,contact);
 const matches=contact?await tx`SELECT c.id FROM contact c WHERE c.organization_id=${j.organization_id}
  AND (c.phone_normalized=${contact.phoneNormalized} OR c.email_normalized=${contact.emailNormalized}) ORDER BY c.id LIMIT 2 FOR UPDATE`:[];
 const actor=choice?.actor??{id:j.actor_id,organizationId:j.organization_id,branchId:j.branch_scope,role:j.actor_role,name:'',email:''};
 const candidates=await sourceCandidatePage(db,j.organization_id,contact,actor,null,1);
 if(candidates.adminRequired)throw new HttpError(409,'CONTACT_REVIEW_REQUIRES_ADMIN');
 let contactId:string|null=null;
 if(choice){
  if(!contact)throw new HttpError(409,'IMPORT_CONTACT_MATCH_CHANGED');
  const selected=(await tx`SELECT id FROM contact WHERE id=${choice.contactId} AND organization_id=${j.organization_id}
   AND (phone_normalized=${contact.phoneNormalized} OR email_normalized=${contact.emailNormalized}) FOR UPDATE`)[0];
  if(!selected)throw new HttpError(409,'IMPORT_CONTACT_MATCH_CHANGED');contactId=selected.id;
 }else if(matches.length>1)throw new HttpError(409,'CONTACT_AMBIGUOUS');
 else if(matches.length===1)contactId=matches[0]!.id;
 else if(contact){
  contactId=(await tx`INSERT INTO contact(organization_id,name,phone,phone_normalized,email,email_normalized)
   VALUES(${j.organization_id},${contact.name},${contact.phone},${contact.phoneNormalized},${contact.email},${contact.emailNormalized}) RETURNING id`)[0]!.id;
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
   VALUES(${j.organization_id},${j.branch_id},NULL,'CONTACT_CREATED','CONTACT',${contactId},${tx.json({sourceSubmissionId:r.submission_id})})`;
 }
 const leadId=randomUUID(),version=r.version+1;
 await importResultAudit(tx,j,r.submission_id,'IMPORT_ATTEMPT_STARTED',choice?.actor.id??null,{version,configurationHash:prepared.configurationHash,sessionId:choice?.sessionId??null,requestId:choice?.requestId??null});
 await tx`INSERT INTO lead_import_attempt(submission_id,result_version,lead_id,contact_id,configuration_hash,resolver_id,session_id,request_key,reason)
  VALUES(${r.submission_id},${version},${leadId},${contactId},${prepared.configurationHash},${choice?.actor.id??null},${choice?.sessionId??null},${choice?.requestId??null},${choice?.reason??null})`;
 await tx`INSERT INTO lead(id,organization_id,branch_id,campaign_id,contact_id,source_kind)
  VALUES(${leadId},${j.organization_id},${j.branch_id},${j.campaign_id},${contactId},${j.format==='CSV'?'IMPORT_CSV':'IMPORT_EXCEL'})`;
 await tx`UPDATE source_submission SET state='PROCESSED',lead_id=${leadId},resolution_contact_id=${contactId},failure_code=NULL WHERE id=${r.submission_id}`;
 for(const f of row.fields){
  await tx`INSERT INTO lead_field_value(lead_id,field_id,value,source,updated_by,source_submission_id,source_mapping_version,source_import_dataset_id,source_import_sheet_index)
   VALUES(${leadId},${f.fieldId},${tx.json(f.value)},'SOURCE',${choice?.actor.id??null},${r.submission_id},${row.mapping_version},${row.dataset_id},${row.sheet_index})`;
  await tx`INSERT INTO field_value_history(lead_id,field_id,new_value,source,actor_user_id,source_submission_id,source_mapping_version,source_import_dataset_id,source_import_sheet_index)
   VALUES(${leadId},${f.fieldId},${tx.json(f.value)},'SOURCE',${choice?.actor.id??null},${r.submission_id},${row.mapping_version},${row.dataset_id},${row.sheet_index})`;
 }
 await tx`INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES(${leadId},${choice?.actor.id??null},'IMPORT_LEAD_CREATED',
  ${tx.json({submissionId:r.submission_id,datasetId:row.dataset_id,sheet:row.sheet_index,row:row.row_number,mappingVersion:row.mapping_version})})`;
 await routeLead(tx,j.campaign_id,j.branch_id,prepared.campaign.routing_method,prepared.campaign.timezone,leadId);
 await changeImportResult(tx,j,r,'IMPORTED',null,leadId,0);
 await recordLeadIntakeOrigin(tx,leadId,r.submission_id,{kind:'APPROVED_IMPORT'});
 return {id:leadId,state:'IMPORTED',version};
}
// One atomic row at a time. Interrupted transactions leave no Lead, Contact, Fields, routing or receipt behind.
export async function processOneImportIntake(db:Database,options:{retryDelaySeconds?:number}={}):Promise<boolean>{
 const delay=options.retryDelaySeconds;if(delay!==undefined&&(!Number.isFinite(delay)||delay<0||delay>300))throw Error('Invalid Import intake retry delay');
 const candidate=(await db`SELECT submission_id,version FROM lead_import_result WHERE state='WAITING' AND next_run_at<=clock_timestamp() ORDER BY next_run_at,submission_id LIMIT 1`)[0];
 if(!candidate)return false;let claimed=false;
 try{return await db.begin(async tx=>{
  const locked=await lockImportResult(tx,candidate.submission_id,true);if(!locked||locked.r.state!=='WAITING'||locked.r.version!==candidate.version)return false;claimed=true;
  // A subtransaction rolls back any partial effects before persisting a business attention result.
  try{await tx.savepoint(async child=>intakeApprovedImport(child,locked));}
  catch(e){if(!(e instanceof HttpError))throw e;await changeImportResult(tx,locked.j,locked.r,'NEEDS_ATTENTION',e.code);}
  return true;
 });}catch{
  if(!claimed)return false;
  return db.begin(async tx=>{const locked=await lockImportResult(tx,candidate.submission_id,true);
   if(!locked||locked.r.state!=='WAITING'||locked.r.version!==candidate.version)return false;
   const count=locked.r.failure_count+1;await changeImportResult(tx,locked.j,locked.r,count===5?'FAILED':'WAITING','IMPORT_INTAKE_UNAVAILABLE',null,count,delay??2**count);return true;
  });
 }
}
