import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { HttpError,sha256,type Principal } from '../security.js';
import { openOpaque } from '../credentials.js';
import { managedSourceConnection,recheckSourceActor } from './catalog-sync.js';
import { SourceProviderError,type SourceConfig } from './meta-provider.js';
import { metaLeadSourceHistoryAdapter,validateHistoricalPage,type LeadSourceHistoryAdapter } from './meta-history.js';
import { sourceRetryDelay,sourceWorkerOptions } from './retrieval-worker.js';

export function historicalOptions(env:NodeJS.ProcessEnv=process.env) {
  const maxPages=Number(env.SOURCE_HISTORICAL_MAX_PAGES ?? 10000);
  if (!Number.isInteger(maxPages) || maxPages<1 || maxPages>100000) throw new Error('Invalid SOURCE_HISTORICAL_MAX_PAGES');
  return { maxPages,importBatch:20 };
}
export function historicalRange(from:string,until:string):{ from:string;until:string } {
  const valid=(s:string)=> /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s) && Number.isFinite(Date.parse(s))
    && Date.parse(s)>=946684800000 && Date.parse(s)<=4102444800000 && new Date(s).toISOString().slice(0,19)===s.slice(0,19);
  if (!valid(from) || !valid(until) || Date.parse(until)<=Date.parse(from)) throw new HttpError(400,'SOURCE_HISTORICAL_RANGE_INVALID');
  return { from:new Date(from).toISOString(),until:new Date(until).toISOString() };
}
async function audit(db:Database,c:Record<string,any>,jobId:string,action:string,actorId:string|null,detail:Record<string,any>={}) {
  await db`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (${c.organization_id},${c.branch_id},${actorId},${action},'SOURCE_HISTORICAL_JOB',${jobId},${db.json(detail)})`;
}
export async function historicalContext(db:Database,c:Record<string,any>,j:Record<string,any>) {
  const actor=(await db`SELECT id,role,branch_id FROM user_account WHERE id=${j.actor_user_id} AND active
    AND organization_id=${c.organization_id} AND role=${j.actor_role} AND branch_id IS NOT DISTINCT FROM ${j.actor_branch_id}::uuid FOR SHARE`)[0];
  if (!actor || (actor.role==='MANAGER' && actor.branch_id!==c.branch_id)) throw new HttpError(403,'SOURCE_ACTOR_NO_LONGER_AUTHORIZED');
  if (c.status==='DISABLED') throw new HttpError(409,'SOURCE_CONNECTION_DISABLED');
  if (c.status==='AUTH_EXPIRED') throw new HttpError(409,'SOURCE_PROVIDER_AUTH_FAILED');
  if (!['CONNECTED','WARNING'].includes(c.status)) throw new HttpError(409,'SOURCE_CONNECTION_NOT_READY');
  if (c.version!==j.connection_version) throw new HttpError(409,'SOURCE_HISTORICAL_CONTEXT_CHANGED');
  if (c.branch_id && !(await db`SELECT id FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length)
    throw new HttpError(409,'SOURCE_BRANCH_INACTIVE');
  const form=(await db`SELECT * FROM source_resource WHERE id=${j.form_id} AND connection_id=${c.id} AND resource_kind='FORM'`)[0];
  const page=(await db`SELECT r.*,s.ciphertext,s.nonce,s.auth_tag,s.key_version FROM source_resource r
    LEFT JOIN source_resource_secret s ON s.resource_id=r.id WHERE r.id=${j.page_id} AND r.connection_id=${c.id} AND r.resource_kind='PAGE'`)[0];
  if (!form?.active || !page?.active || form.parent_id!==page.id || form.version!==j.form_version || page.version!==j.page_version
    || form.connection_version!==c.version || page.connection_version!==c.version) throw new HttpError(409,'SOURCE_HISTORICAL_CONTEXT_CHANGED');
  if (!page.ciphertext) throw new HttpError(409,'SOURCE_PAGE_CREDENTIAL_UNAVAILABLE');
  let token:string;
  try { token=openOpaque(`source-resource:${page.id}`,{ ciphertext:page.ciphertext,nonce:page.nonce,authTag:page.auth_tag,keyVersion:page.key_version }); }
  catch { throw new HttpError(409,'SOURCE_PAGE_CREDENTIAL_UNAVAILABLE'); }
  return { formId:form.external_id as string,page:{ externalId:page.external_id as string,accessToken:token },config:c.config as SourceConfig };
}
export async function startHistoricalPreview(db:Database,actor:Principal,connectionId:string,input:{ version:number;formId:string;requestId:string;from:string;until:string }) {
  await managedSourceConnection(db,actor,connectionId);const range=historicalRange(input.from,input.until);
  return db.begin(async(tx)=> {
    const d=tx as unknown as Database;
    const c=(await tx`SELECT * FROM integration_connection WHERE id=${connectionId} FOR UPDATE`)[0]!;
    await recheckSourceActor(d,actor);
    const existing=(await tx`SELECT id,form_id,range_from,range_until FROM source_historical_job WHERE connection_id=${connectionId} AND request_id=${input.requestId}`)[0];
    if (existing) {
      if (existing.form_id!==input.formId || existing.range_from.toISOString()!==range.from || existing.range_until.toISOString()!==range.until)
        throw new HttpError(409,'SOURCE_HISTORICAL_IDEMPOTENCY_CONFLICT');
      return { id:existing.id };
    }
    if (c.version!==input.version) throw new HttpError(409,'SOURCE_CONNECTION_VERSION_CONFLICT');
    const form=(await tx`SELECT * FROM source_resource WHERE id=${input.formId} AND connection_id=${connectionId} AND resource_kind='FORM'`)[0];
    if (!form) throw new HttpError(404,'SOURCE_FORM_NOT_FOUND');
    const page=(await tx`SELECT version FROM source_resource WHERE id=${form.parent_id}`)[0]!;
    const j={ actor_user_id:actor.id,actor_role:actor.role,actor_branch_id:actor.branchId,connection_version:c.version,
      form_id:form.id,form_version:form.version,page_id:form.parent_id,page_version:page.version };
    await historicalContext(d,c,j);
    const id=randomUUID();
    await tx`INSERT INTO source_historical_job (id,connection_id,form_id,page_id,connection_version,form_version,page_version,actor_user_id,actor_role,actor_branch_id,request_id,range_from,range_until)
      VALUES (${id},${connectionId},${form.id},${form.parent_id},${c.version},${form.version},${page.version},${actor.id},${actor.role},${actor.branchId},${input.requestId},${range.from},${range.until})`;
    await audit(d,c,id,'SOURCE_HISTORICAL_PREVIEW_REQUESTED',actor.id,{ formId:form.id });return { id };
  });
}
export async function historicalAction(db:Database,actor:Principal,connectionId:string,jobId:string,input:{ version:number;reason:string },action:'confirm'|'cancel'|'retry') {
  await managedSourceConnection(db,actor,connectionId);
  if (!input.reason.trim()) throw new HttpError(400,'SOURCE_REASON_REQUIRED');
  return db.begin(async(tx)=> {
    const d=tx as unknown as Database;const c=(await tx`SELECT * FROM integration_connection WHERE id=${connectionId} FOR UPDATE`)[0]!;
    await recheckSourceActor(d,actor);
    const j=(await tx`SELECT * FROM source_historical_job WHERE id=${jobId} AND connection_id=${connectionId} FOR UPDATE`)[0];
    if (!j) throw new HttpError(404,'SOURCE_HISTORICAL_JOB_NOT_FOUND');
    if (j.version!==input.version) throw new HttpError(409,'SOURCE_HISTORICAL_VERSION_CONFLICT');
    if (action==='cancel') {
      if (['SUCCEEDED','CANCELLED'].includes(j.state)) throw new HttpError(409,'SOURCE_HISTORICAL_TERMINAL');
      if (j.lease_id) await tx`UPDATE source_historical_attempt SET state='CANCELLED',finished_at=now(),error_code='SOURCE_HISTORICAL_CANCELLED' WHERE id=${j.lease_id} AND state='RUNNING'`;
      await tx`UPDATE source_historical_job SET state='CANCELLED',version=version+1,lease_id=NULL,lease_until=NULL,error_code=NULL,updated_at=now() WHERE id=${jobId}`;
    } else {
      await historicalContext(d,c,j);
      if (action==='confirm') {
        if (j.state!=='PREVIEW_READY') throw new HttpError(409,'SOURCE_HISTORICAL_PREVIEW_REQUIRED');
        await tx`UPDATE source_historical_job SET state='IMPORTING',phase='IMPORT',confirmed_at=now(),confirmed_by=${actor.id},version=version+1,updated_at=now() WHERE id=${jobId}`;
      } else {
        if (!['FAILED','BLOCKED'].includes(j.state) || j.recoveries>=10) throw new HttpError(409,'SOURCE_HISTORICAL_NOT_RECOVERABLE');
        await tx`UPDATE source_historical_job SET state=${j.phase==='PREVIEW' ? 'PENDING' : 'IMPORTING'},version=version+1,failures=0,recoveries=recoveries+1,
          available_at=now(),error_code=NULL,updated_at=now() WHERE id=${jobId}`;
      }
    }
    await audit(d,c,jobId,'SOURCE_HISTORICAL_'+action.toUpperCase(),actor.id,{ reason:input.reason.trim(),previousVersion:input.version });
    return { version:j.version+1 };
  });
}
async function fail(db:Database,c:Record<string,any>,j:Record<string,any>,code:string,state='BLOCKED',attemptId?:string,retry=false) {
  if (attemptId) await db`UPDATE source_historical_attempt SET state=${code==='SOURCE_HISTORICAL_CONTEXT_CHANGED' ? 'SUPERSEDED' : 'FAILED'},
    error_code=${code},finished_at=now() WHERE id=${attemptId} AND state='RUNNING'`;
  await db`UPDATE source_historical_job SET state=${state},version=version+1,failures=failures+1,error_code=${code},lease_id=NULL,lease_until=NULL,
    available_at=now()+${retry ? sourceRetryDelay(j.failures+1) : 0}*interval '1 second',updated_at=now() WHERE id=${j.id}`;
  await audit(db,c,j.id,retry ? 'SOURCE_HISTORICAL_RETRY_SCHEDULED' : 'SOURCE_HISTORICAL_FAILED',null,{ code,attemptId:attemptId ?? null });
}
export async function processOneHistoricalPreview(db:Database,adapter:LeadSourceHistoryAdapter=metaLeadSourceHistoryAdapter):Promise<boolean> {
  const options=sourceWorkerOptions();const limits=historicalOptions();const attemptId=randomUUID();
  const reserved=await db.begin(async(tx)=> {
    const d=tx as unknown as Database;
    const c=(await tx`SELECT c.* FROM integration_connection c WHERE c.kind='META' AND c.provider='META_LEAD_ADS'
      AND EXISTS (SELECT 1 FROM source_historical_job j WHERE j.connection_id=c.id AND ((j.state='PENDING' AND j.available_at<=now()) OR (j.state='RUNNING' AND j.lease_until<=now())))
      AND NOT EXISTS (SELECT 1 FROM source_historical_job j WHERE j.connection_id=c.id AND j.state='RUNNING' AND j.lease_until>now())
      AND NOT EXISTS (SELECT 1 FROM source_retrieval_job j WHERE j.connection_id=c.id AND j.state='RUNNING' AND j.lease_until>now())
      ORDER BY (SELECT min(j.available_at) FROM source_historical_job j WHERE j.connection_id=c.id AND j.state IN ('PENDING','RUNNING')),c.id
      FOR UPDATE OF c SKIP LOCKED LIMIT 1`)[0];
    if (!c) return null;
    const expired=(await tx`SELECT * FROM source_historical_job WHERE connection_id=${c.id} AND state='RUNNING' AND lease_until<=now() FOR UPDATE`)[0];
    if (expired) {
      await tx`UPDATE source_historical_attempt SET state='SUPERSEDED',error_code='SOURCE_HISTORICAL_LEASE_EXPIRED',finished_at=now() WHERE id=${expired.lease_id} AND state='RUNNING'`;
      await fail(d,c,expired,'SOURCE_HISTORICAL_LEASE_EXPIRED',expired.failures+1>=options.maxFailures ? 'FAILED' : 'PENDING');
    }
    const j=(await tx`SELECT * FROM source_historical_job WHERE connection_id=${c.id} AND state='PENDING' AND available_at<=now() ORDER BY available_at,id FOR UPDATE LIMIT 1`)[0];
    if (!j) return { done:true } as const;
    let context:Awaited<ReturnType<typeof historicalContext>>;
    try { context=await historicalContext(d,c,j); }
    catch (e) { await fail(d,c,j,e instanceof HttpError ? e.code : 'SOURCE_HISTORICAL_CONTEXT_CHANGED');return { done:true } as const; }
    if (j.pages>=limits.maxPages) { await fail(d,c,j,'SOURCE_HISTORICAL_PAGE_LIMIT','FAILED');return { done:true } as const; }
    await tx`INSERT INTO source_historical_attempt (id,job_id,number) VALUES (${attemptId},${j.id},${j.attempts+1})`;
    await tx`UPDATE source_historical_job SET state='RUNNING',version=version+1,attempts=attempts+1,lease_id=${attemptId},lease_until=now()+${options.leaseSeconds}*interval '1 second',error_code=NULL,updated_at=now() WHERE id=${j.id}`;
    return { done:false,connectionId:c.id as string,jobId:j.id as string,context,after:j.cursor_token as string|null } as const;
  });
  if (!reserved) return false;if (reserved.done) return true;
  try {
    const result=validateHistoricalPage(await adapter.page({ ...reserved.context,after:reserved.after }),reserved.context.formId);
    await db.begin(async(tx)=> {
      const d=tx as unknown as Database;const c=(await tx`SELECT * FROM integration_connection WHERE id=${reserved.connectionId} FOR UPDATE`)[0]!;
      const j=(await tx`SELECT *,lease_until>now() AS live FROM source_historical_job WHERE id=${reserved.jobId} FOR UPDATE`)[0]!;
      if (j.state!=='RUNNING' || j.lease_id!==attemptId) return;
      if (!j.live) throw new SourceProviderError('SOURCE_HISTORICAL_LEASE_EXPIRED',true);
      await historicalContext(d,c,j);
      if (result.after) {
        const inserted=await tx`INSERT INTO source_historical_cursor (job_id,cursor_hash) VALUES (${j.id},${sha256(result.after)}) ON CONFLICT DO NOTHING RETURNING job_id`;
        if (!inserted.length) throw new SourceProviderError('SOURCE_HISTORICAL_CURSOR_REPEATED');
      }
      for (const lead of result.leads) {
        if (Date.parse(lead.createdAt)<j.range_from.getTime() || Date.parse(lead.createdAt)>=j.range_until.getTime()) continue;
        await tx`INSERT INTO source_historical_item (job_id,connection_id,external_lead_id,raw_payload,source_timestamp)
          VALUES (${j.id},${c.id},${String(lead.raw.id)},${tx.json(lead.raw as Parameters<typeof tx.json>[0])},${lead.createdAt}) ON CONFLICT DO NOTHING`;
      }
      await tx`UPDATE source_historical_attempt SET state='SUCCEEDED',finished_at=now() WHERE id=${attemptId}`;
      await tx`UPDATE source_historical_job SET state=${result.after ? 'PENDING' : 'PREVIEW_READY'},version=version+1,cursor_token=${result.after},pages=pages+1,
        scanned=scanned+${result.leads.length},failures=0,lease_id=NULL,lease_until=NULL,available_at=now(),error_code=NULL,updated_at=now() WHERE id=${j.id}`;
      await tx`UPDATE integration_connection SET last_success_at=now() WHERE id=${c.id}`;
      if (!result.after) await audit(d,c,j.id,'SOURCE_HISTORICAL_PREVIEW_READY',null,{ pages:j.pages+1 });
    });
  } catch (e) {
    await db.begin(async(tx)=> {
      const d=tx as unknown as Database;const c=(await tx`SELECT * FROM integration_connection WHERE id=${reserved.connectionId} FOR UPDATE`)[0]!;
      const j=(await tx`SELECT * FROM source_historical_job WHERE id=${reserved.jobId} FOR UPDATE`)[0]!;
      if (j.state!=='RUNNING' || j.lease_id!==attemptId) return;
      let code=e instanceof HttpError || e instanceof SourceProviderError ? e.code : 'SOURCE_HISTORICAL_FAILED';let blocked=false;
      try { await historicalContext(d,c,j); } catch (contextError) { blocked=true;code=contextError instanceof HttpError ? contextError.code : 'SOURCE_HISTORICAL_CONTEXT_CHANGED'; }
      const dbRetry=!!e && typeof e==='object' && 'code' in e && ['40001','40P01','57014'].includes(String(e.code));
      const retry=!blocked && ((e instanceof SourceProviderError && e.retryable) || dbRetry) && j.failures+1<options.maxFailures;
      await fail(d,c,j,code,blocked || code==='SOURCE_PROVIDER_AUTH_FAILED' ? 'BLOCKED' : retry ? 'PENDING' : 'FAILED',attemptId,retry);
      if (!blocked) await tx`UPDATE integration_connection SET last_failure_at=now(),last_error_code=${code},status=${code==='SOURCE_PROVIDER_AUTH_FAILED' ? 'AUTH_EXPIRED' : c.status} WHERE id=${c.id}`;
    });
  }
  return true;
}
export async function processOneHistoricalImport(db:Database):Promise<boolean> {
  let reserved:{ connectionId:string;jobId:string;version:number }|null=null;
  try { return await db.begin(async(tx)=> {
    const d=tx as unknown as Database;const c=(await tx`SELECT c.* FROM integration_connection c WHERE EXISTS
      (SELECT 1 FROM source_historical_job j WHERE j.connection_id=c.id AND j.state='IMPORTING' AND j.available_at<=now())
      ORDER BY (SELECT min(j.updated_at) FROM source_historical_job j WHERE j.connection_id=c.id AND j.state='IMPORTING'),c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1`)[0];
    if (!c) return false;
    const j=(await tx`SELECT * FROM source_historical_job WHERE connection_id=${c.id} AND state='IMPORTING' AND available_at<=now() ORDER BY updated_at,id FOR UPDATE LIMIT 1`)[0]!;
    reserved={ connectionId:c.id as string,jobId:j.id as string,version:j.version as number };
    let context:Awaited<ReturnType<typeof historicalContext>>;
    try {
      context=await historicalContext(d,c,j);
      const confirmer=(await tx`SELECT id,role,branch_id,active FROM user_account WHERE id=${j.confirmed_by} AND organization_id=${c.organization_id} FOR SHARE`)[0];
      if (!confirmer?.active || (confirmer.role!=='SUPER_ADMIN' && !(confirmer.role==='MANAGER' && confirmer.branch_id===c.branch_id)))
        throw new HttpError(403,'SOURCE_ACTOR_NO_LONGER_AUTHORIZED');
    } catch (e) { await fail(d,c,j,e instanceof HttpError ? e.code : 'SOURCE_HISTORICAL_CONTEXT_CHANGED');return true; }
    const items=await tx`SELECT * FROM source_historical_item WHERE job_id=${j.id} AND result='STAGED' ORDER BY external_lead_id LIMIT ${historicalOptions().importBatch} FOR UPDATE`;
    for (const item of items) {
      // Connection lock serializes this decision with signed receipt/retrieval and other historical jobs.
      const existing=(await tx`SELECT id,raw_payload,source_kind FROM source_submission WHERE connection_id=${c.id} AND external_event_id=${item.external_lead_id}`)[0];
      const receipt=(await tx`SELECT external_page_id,external_form_id FROM source_webhook_event WHERE connection_id=${c.id} AND external_lead_id=${item.external_lead_id}`)[0];
      let result:string;let submissionId:string|null=null;
      if ((existing && (existing.source_kind!=='META' || existing.raw_payload.context?.pageId!==context.page.externalId || existing.raw_payload.context?.formId!==context.formId))
        || (receipt && (receipt.external_page_id!==context.page.externalId || receipt.external_form_id!==context.formId))) result='CONTEXT_CONFLICT';
      else if (existing) { result='DUPLICATE_SUBMISSION';submissionId=existing.id; }
      else if (receipt) result='DUPLICATE_RECEIPT';
      else {
        const raw={ lead:item.raw_payload,context:{ pageId:context.page.externalId,formId:context.formId,leadId:item.external_lead_id } };
        submissionId=(await tx`INSERT INTO source_submission (organization_id,branch_id,source_kind,connection_id,external_event_id,raw_payload,source_timestamp,state,failure_code)
          VALUES (${c.organization_id},${c.branch_id},'META',${c.id},${item.external_lead_id},${tx.json(raw)},${item.source_timestamp},'NEEDS_ATTENTION','SOURCE_EVALUATION_PENDING') RETURNING id`)[0]!.id;
        result='IMPORTED';
      }
      await tx`UPDATE source_historical_item SET result=${result},submission_id=${submissionId} WHERE job_id=${j.id} AND external_lead_id=${item.external_lead_id}`;
    }
    const remains=(await tx`SELECT 1 FROM source_historical_item WHERE job_id=${j.id} AND result='STAGED' LIMIT 1`).length>0;
    await tx`UPDATE source_historical_job SET state=${remains ? 'IMPORTING' : 'SUCCEEDED'},version=version+1,failures=0,error_code=NULL,updated_at=now() WHERE id=${j.id}`;
    await audit(d,c,j.id,remains ? 'SOURCE_HISTORICAL_BATCH_IMPORTED' : 'SOURCE_HISTORICAL_IMPORT_COMPLETED',null,{ items:items.length });return true;
  }); } catch (e) {
    // The failed batch rolled back all Submissions/results. Persist a safe, bounded retry independently.
    const r=reserved as { connectionId:string;jobId:string;version:number }|null;if (!r) throw e;
    await db.begin(async(tx)=> {
      const d=tx as unknown as Database;const c=(await tx`SELECT * FROM integration_connection WHERE id=${r.connectionId} FOR UPDATE`)[0]!;
      const j=(await tx`SELECT * FROM source_historical_job WHERE id=${r.jobId} FOR UPDATE`)[0]!;
      if (j.state!=='IMPORTING' || j.version!==r.version) return;
      const retryable=!!e && typeof e==='object' && 'code' in e && ['40001','40P01','57014'].includes(String(e.code));
      const retry=retryable && j.failures+1<sourceWorkerOptions().maxFailures;
      await fail(d,c,j,retryable ? 'SOURCE_HISTORICAL_DATABASE_RETRY' : 'SOURCE_HISTORICAL_IMPORT_FAILED',retry ? 'IMPORTING' : 'FAILED',undefined,retry);
    });return true;
  }
}
