import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { openOpaque } from '../credentials.js';
import { SourceProviderError,type SourceConfig } from './meta-provider.js';
import { metaLeadSourceRetrievalAdapter,validateRetrievedLead,type LeadSourceRetrievalAdapter } from './meta-lead.js';

export function sourceWorkerOptions(env:NodeJS.ProcessEnv=process.env) {
  const bounded=(name:string,fallback:number,min:number,max:number)=> { const n=Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n<min || n>max) throw new Error('Invalid '+name);return n; };
  return { batchSize:bounded('SOURCE_RETRIEVAL_BATCH_SIZE',20,1,200),pollMs:bounded('SOURCE_RETRIEVAL_POLL_MS',2000,100,60000),
    maxFailures:bounded('SOURCE_RETRIEVAL_MAX_FAILURES',5,1,20),leaseSeconds:bounded('SOURCE_RETRIEVAL_LEASE_SECONDS',30,15,300) };
}
export function sourceRetryDelay(failures:number):number { return Math.min(1800,30*2**Math.max(0,Math.min(failures-1,6))); }
export async function processOneSourceRetrieval(db:Database,adapter:LeadSourceRetrievalAdapter=metaLeadSourceRetrievalAdapter):Promise<boolean> {
  const options=sourceWorkerOptions();const attemptId=randomUUID();
  const reserved=await db.begin(async(tx)=> {
    // Always lock Connection before its job. One in-flight GET per Connection provides bounded provider backpressure.
    const connection=(await tx`SELECT c.id,c.organization_id,c.branch_id,c.status,c.config,c.version FROM integration_connection c
      WHERE c.kind='META' AND c.provider='META_LEAD_ADS' AND EXISTS (SELECT 1 FROM source_retrieval_job j WHERE j.connection_id=c.id
        AND ((j.state='PENDING' AND j.available_at<=now()) OR (j.state='RUNNING' AND j.lease_until<=now())))
      AND NOT EXISTS (SELECT 1 FROM source_retrieval_job j WHERE j.connection_id=c.id AND j.state='RUNNING' AND j.lease_until>now())
      ORDER BY CASE WHEN c.status IN ('DISABLED','AUTH_EXPIRED') THEN 1 ELSE 0 END,
        (SELECT min(j.available_at) FROM source_retrieval_job j WHERE j.connection_id=c.id AND j.state IN ('PENDING','RUNNING')),c.id
      FOR UPDATE OF c SKIP LOCKED LIMIT 1`)[0];
    if (!connection) return null;
    const expired=(await tx`SELECT event_id,lease_id,failures FROM source_retrieval_job WHERE connection_id=${connection.id} AND state='RUNNING' AND lease_until<=now() FOR UPDATE`)[0];
    if (expired) {
      const failures=expired.failures+1;
      await tx`UPDATE source_retrieval_attempt SET state='SUPERSEDED',error_code='SOURCE_RETRIEVAL_LEASE_EXPIRED',finished_at=now() WHERE id=${expired.lease_id} AND state='RUNNING'`;
      await tx`UPDATE source_retrieval_job SET state=${failures>=options.maxFailures ? 'FAILED' : 'PENDING'},failures=${failures},version=version+1,
        lease_id=NULL,lease_until=NULL,error_code='SOURCE_RETRIEVAL_LEASE_EXPIRED',available_at=now(),updated_at=now() WHERE event_id=${expired.event_id}`;
    }
    const job=(await tx`SELECT j.event_id,j.attempts,e.page_id,e.external_page_id,e.external_form_id,e.external_lead_id,e.raw_notification
      FROM source_retrieval_job j JOIN source_webhook_event e ON e.id=j.event_id WHERE j.connection_id=${connection.id} AND j.state='PENDING' AND j.available_at<=now()
      ORDER BY j.available_at,e.received_at,j.event_id FOR UPDATE OF j LIMIT 1`)[0];
    if (!job) return { done:true } as const;
    const page=(await tx`SELECT r.id,r.external_id,r.version,r.active,r.connection_version,s.* FROM source_resource r
      LEFT JOIN source_resource_secret s ON s.resource_id=r.id WHERE r.id=${job.page_id}`)[0]!;
    const number=job.attempts+1;
    await tx`INSERT INTO source_retrieval_attempt (id,event_id,attempt_number,connection_version,page_version)
      VALUES (${attemptId},${job.event_id},${number},${connection.version},${page.version})`;
    let code:string|null=connection.status==='DISABLED' ? 'SOURCE_CONNECTION_DISABLED' : connection.status==='AUTH_EXPIRED' ? 'SOURCE_PROVIDER_AUTH_FAILED'
      : !page.active || page.connection_version!==connection.version ? 'SOURCE_PAGE_NOT_READY' : !page.ciphertext ? 'SOURCE_PAGE_CREDENTIAL_UNAVAILABLE' : null;
    let token='';
    if (!code) try { token=openOpaque(`source-resource:${page.id}`,{ ciphertext:page.ciphertext,nonce:page.nonce,authTag:page.auth_tag,keyVersion:page.key_version }); }
    catch { code='SOURCE_PAGE_CREDENTIAL_UNAVAILABLE'; }
    if (code) {
      await tx`UPDATE source_retrieval_attempt SET state='FAILED',error_code=${code},finished_at=now() WHERE id=${attemptId}`;
      await tx`UPDATE source_retrieval_job SET state='BLOCKED',version=version+1,attempts=${number},error_code=${code},updated_at=now() WHERE event_id=${job.event_id}`;
      return { done:true } as const;
    }
    await tx`UPDATE source_retrieval_job SET state='RUNNING',version=version+1,attempts=${number},error_code=NULL,
      lease_id=${attemptId},lease_until=now()+${options.leaseSeconds}*interval '1 second',updated_at=now() WHERE event_id=${job.event_id}`;
    return { done:false,eventId:job.event_id as string,connectionId:connection.id as string,organizationId:connection.organization_id as string,
      branchId:connection.branch_id as string|null,connectionVersion:connection.version as number,pageVersion:page.version as number,pageId:page.id as string,
      rawNotification:job.raw_notification,config:connection.config as SourceConfig,page:{ externalId:page.external_id as string,accessToken:token },
      leadId:job.external_lead_id as string,formId:job.external_form_id as string } as const;
  });
  if (!reserved) return false;if (reserved.done) return true;
  try {
    const input={ config:reserved.config,page:reserved.page,leadId:reserved.leadId,formId:reserved.formId };
    const result=validateRetrievedLead(await adapter.retrieve(input),input);
    await db.begin(async(tx)=> {
      const connection=(await tx`SELECT version,status FROM integration_connection WHERE id=${reserved.connectionId} FOR UPDATE`)[0]!;
      const job=(await tx`SELECT state,lease_id,lease_until>now() AS live FROM source_retrieval_job WHERE event_id=${reserved.eventId} FOR UPDATE`)[0]!;
      if (job.state!=='RUNNING' || job.lease_id!==attemptId) return; // A newer worker owns the job; this result has no authority.
      const page=(await tx`SELECT version,active,connection_version FROM source_resource WHERE id=${reserved.pageId}`)[0]!;
      if (!job.live || connection.version!==reserved.connectionVersion || connection.status==='DISABLED'
        || !page.active || page.version!==reserved.pageVersion || page.connection_version!==connection.version) throw new SourceProviderError('SOURCE_PROVIDER_INPUT_INVALID');
      const raw={ notification:reserved.rawNotification,lead:result.raw,context:{ pageId:reserved.page.externalId,formId:reserved.formId,leadId:reserved.leadId } };
      const created=await tx`INSERT INTO source_submission (organization_id,branch_id,source_kind,connection_id,external_event_id,raw_payload,source_timestamp,state,failure_code)
        VALUES (${reserved.organizationId},${reserved.branchId},'META',${reserved.connectionId},${reserved.leadId},${tx.json(raw as Parameters<typeof tx.json>[0])},
          ${result.createdAt},'NEEDS_ATTENTION','SOURCE_EVALUATION_PENDING') ON CONFLICT (connection_id,external_event_id) WHERE connection_id IS NOT NULL AND external_event_id IS NOT NULL DO NOTHING RETURNING id`;
      const submission=created[0] ?? (await tx`SELECT id,raw_payload,source_kind FROM source_submission WHERE connection_id=${reserved.connectionId} AND external_event_id=${reserved.leadId}`)[0]!;
      if (!created.length && (submission.source_kind!=='META' || submission.raw_payload.context?.formId!==reserved.formId || submission.raw_payload.context?.pageId!==reserved.page.externalId))
        throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
      await tx`UPDATE source_retrieval_attempt SET state='SUCCEEDED',finished_at=now() WHERE id=${attemptId}`;
      await tx`UPDATE source_retrieval_job SET state='SUCCEEDED',version=version+1,submission_id=${submission.id},lease_id=NULL,lease_until=NULL,
        error_code=NULL,updated_at=now() WHERE event_id=${reserved.eventId}`;
      await tx`UPDATE integration_connection SET last_success_at=now(),capabilities=capabilities || '{"sourceRetrievalVerified":true,"intakeReady":false}'::jsonb WHERE id=${reserved.connectionId}`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,action,target_type,target_id,detail)
        VALUES (${reserved.organizationId},${reserved.branchId},'SOURCE_LEAD_RETRIEVED','SOURCE_SUBMISSION',${submission.id},${tx.json({ eventId:reserved.eventId,attemptId })})`;
    });
  } catch (error) {
    await db.begin(async(tx)=> {
      const connection=(await tx`SELECT version,status FROM integration_connection WHERE id=${reserved.connectionId} FOR UPDATE`)[0]!;
      const job=(await tx`SELECT state,lease_id,lease_until>now() AS live,failures FROM source_retrieval_job WHERE event_id=${reserved.eventId} FOR UPDATE`)[0]!;
      if (job.state!=='RUNNING' || job.lease_id!==attemptId) return;
      const page=(await tx`SELECT version,active FROM source_resource WHERE id=${reserved.pageId}`)[0]!;
      const superseded=!job.live || connection.version!==reserved.connectionVersion || connection.status==='DISABLED' || !page.active || page.version!==reserved.pageVersion;
      const databaseRetry=!!error && typeof error==='object' && 'code' in error && ['40P01','40001','57014'].includes(String(error.code));
      const code=superseded ? 'SOURCE_RETRIEVAL_CONTEXT_CHANGED' : error instanceof SourceProviderError ? error.code : databaseRetry ? 'SOURCE_RETRIEVAL_DATABASE_RETRY' : 'SOURCE_RETRIEVAL_FAILED';
      const failures=job.failures+1;const retry=!superseded && ((error instanceof SourceProviderError && error.retryable) || databaseRetry) && failures<options.maxFailures;
      const state=superseded || code==='SOURCE_PROVIDER_AUTH_FAILED' ? 'BLOCKED' : retry ? 'PENDING' : 'FAILED';
      await tx`UPDATE source_retrieval_attempt SET state=${superseded ? 'SUPERSEDED' : 'FAILED'},error_code=${code},finished_at=now() WHERE id=${attemptId}`;
      await tx`UPDATE source_retrieval_job SET state=${state},version=version+1,failures=${failures},lease_id=NULL,lease_until=NULL,error_code=${code},
        available_at=now()+${retry ? sourceRetryDelay(failures) : 0}*interval '1 second',updated_at=now() WHERE event_id=${reserved.eventId}`;
      if (!superseded) await tx`UPDATE integration_connection SET last_failure_at=now(),last_error_code=${code},
        status=${code==='SOURCE_PROVIDER_AUTH_FAILED' ? 'AUTH_EXPIRED' : connection.status} WHERE id=${reserved.connectionId}`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,action,target_type,target_id,detail)
        VALUES (${reserved.organizationId},${reserved.branchId},${retry ? 'SOURCE_RETRIEVAL_RETRY_SCHEDULED' : 'SOURCE_RETRIEVAL_FAILED'},'SOURCE_EVENT',${reserved.eventId},${tx.json({ attemptId,reason:code })})`;
    });
  }
  return true;
}
