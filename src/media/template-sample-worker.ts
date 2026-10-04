import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { openSecret, sealOpaque } from '../credentials.js';
import type { MessagingConnectionConfig, MessagingCredentials } from '../messaging/providers.js';
import { MediaError, mediaMaxBytes, validateMedia } from './validation.js';
import { configuredMediaStorage, type MediaStorage } from './storage.js';
import { configuredMediaScanner, type MediaScanner } from './scanner.js';
import { validateMetaOutboundMedia } from './meta-outbound.js';
import { metaTemplateSampleAdapter, validSampleHandle, type TemplateSampleAdapter, type TemplateSampleKind } from './template-sample-provider.js';

export async function processOneTemplateSample(db:Database,options:{ adapter?:TemplateSampleAdapter;
  storage?:MediaStorage;scanner?:MediaScanner }={}):Promise<boolean> {
  const token=randomUUID();
  const row=await db.begin(async(tx)=> {
    const sample=(await tx`SELECT s.*,c.config FROM messaging_template_sample s
      JOIN integration_connection c ON c.id=s.connection_id
      WHERE (s.state='QUEUED' AND s.available_at<=now() AND c.status<>'DISABLED')
        OR (s.state='RUNNING' AND s.lease_until<now())
      ORDER BY s.available_at,s.id FOR UPDATE OF s SKIP LOCKED LIMIT 1`)[0];
    if (!sample) return null;
    if (sample.state==='RUNNING') await tx`UPDATE template_sample_processing_attempt SET outcome='LEASE_EXPIRED',
      error_code='SAMPLE_LEASE_EXPIRED',finished_at=now() WHERE lease_token=${sample.lease_token} AND outcome='STARTED'`;
    if (sample.retry_count>=5) {
      await tx`UPDATE messaging_template_sample SET state='FAILED',lease_token=NULL,lease_until=NULL,
        last_error_code='SAMPLE_RETRY_EXHAUSTED',version=version+1,updated_at=now() WHERE id=${sample.id}`;
      return { exhausted:true } as const;
    }
    await tx`UPDATE messaging_template_sample SET state='RUNNING',lease_token=${token},lease_until=now()+interval '300 seconds',
      attempt_count=attempt_count+1,retry_count=retry_count+1,version=version+1,updated_at=now() WHERE id=${sample.id}`;
    await tx`INSERT INTO template_sample_processing_attempt (sample_id,lease_token,attempt_number,connection_version,outcome)
      VALUES (${sample.id},${token},${sample.attempt_count+1},${sample.connection_version},'STARTED')`;
    return sample;
  });
  if (!row) return false;if ('exhausted' in row) return true;
  let sealed:ReturnType<typeof sealOpaque>|null=null;let failure:MediaError|null=null;let stage='SAMPLE_CREDENTIAL_UNAVAILABLE';
  try {
    const connection=(await db`SELECT c.version,c.status,c.organization_id,c.branch_id,secret.ciphertext,secret.nonce,
        secret.auth_tag,secret.key_version,u.active AS user_active,u.role,u.branch_id AS user_branch,u.organization_id AS user_organization
      FROM integration_connection c JOIN connection_secret secret ON secret.connection_id=c.id
      JOIN user_account u ON u.id=${row.requested_by} WHERE c.id=${row.connection_id}`)[0];
    if (!connection || connection.status==='DISABLED' || connection.version!==row.connection_version)
      throw new MediaError('SAMPLE_CONNECTION_CHANGED');
    if (!connection.user_active || connection.user_organization!==connection.organization_id
      || (connection.role!=='SUPER_ADMIN' && (connection.role!=='MANAGER' || connection.user_branch!==connection.branch_id)))
      throw new MediaError('SAMPLE_REQUESTER_UNAUTHORIZED');
    const credentials=JSON.parse(openSecret(row.connection_id,{ ciphertext:connection.ciphertext,
      nonce:connection.nonce,authTag:connection.auth_tag,keyVersion:connection.key_version })) as MessagingCredentials;
    if (!credentials.accessToken) throw new MediaError('SAMPLE_CREDENTIAL_UNAVAILABLE');
    stage='MEDIA_STORAGE_UNAVAILABLE';const storage=options.storage ?? configuredMediaStorage();
    if (storage.backend!==row.storage_backend) throw new MediaError('MEDIA_STORAGE_UNAVAILABLE',true);
    const bytes=await storage.get(row.storage_key,mediaMaxBytes());
    if (bytes.length!==row.size_bytes || createHash('sha256').update(bytes).digest('hex')!==row.content_sha256)
      throw new MediaError('MEDIA_STORAGE_INTEGRITY_FAILED');
    await validateMedia(bytes,row.media_kind as TemplateSampleKind,row.mime_type,row.content_sha256);
    stage='MEDIA_SCANNER_UNAVAILABLE';const scan=await (options.scanner ?? configuredMediaScanner()).scan(bytes);
    if (!scan.clean) throw new MediaError('MEDIA_CONTENT_REJECTED');
    await validateMetaOutboundMedia(bytes,row.media_kind as TemplateSampleKind,row.mime_type);
    stage='SAMPLE_PROVIDER_UNAVAILABLE';const result=await (options.adapter ?? metaTemplateSampleAdapter).upload({
      config:row.config as MessagingConnectionConfig,credentials,bytes,mime:row.mime_type,kind:row.media_kind });
    if (!validSampleHandle(result.handle)) throw new MediaError('SAMPLE_PROVIDER_RESPONSE_INVALID',true);
    sealed=sealOpaque(`template-sample:${row.id}`,result.handle);
  } catch (error) { failure=error instanceof MediaError ? error : new MediaError(stage,true); }
  await db.begin(async(tx)=> {
    // Shared connection first, then sample; configuration updates cannot race the final version check.
    const connection=(await tx`SELECT version,status,organization_id,branch_id FROM integration_connection
      WHERE id=${row.connection_id} FOR SHARE`)[0]!;
    const sample=(await tx`SELECT state,lease_token FROM messaging_template_sample WHERE id=${row.id} FOR UPDATE`)[0];
    if (sample?.state!=='RUNNING' || sample.lease_token!==token) return;
    const requester=(await tx`SELECT active,role,branch_id,organization_id FROM user_account WHERE id=${row.requested_by} FOR SHARE`)[0];
    if (connection.version!==row.connection_version || connection.status==='DISABLED') {
      sealed=null;failure=new MediaError('SAMPLE_CONNECTION_CHANGED');
    } else if (!requester?.active || requester.organization_id!==connection.organization_id
      || (requester.role!=='SUPER_ADMIN' && (requester.role!=='MANAGER' || requester.branch_id!==connection.branch_id))) {
      sealed=null;failure=new MediaError('SAMPLE_REQUESTER_UNAUTHORIZED');
    }
    const next=sealed ? 'READY' : failure?.retryable && row.retry_count+1<5 ? 'QUEUED' : 'FAILED';
    await tx`UPDATE messaging_template_sample SET state=${next},handle_ciphertext=${sealed?.ciphertext ?? null},
      handle_nonce=${sealed?.nonce ?? null},handle_auth_tag=${sealed?.authTag ?? null},handle_key_version=${sealed?.keyVersion ?? null},
      lease_token=NULL,lease_until=NULL,last_error_code=${failure?.code ?? null},
      available_at=now()+${Math.min(1800,30*2**row.retry_count)}*interval '1 second',version=version+1,updated_at=now()
      WHERE id=${row.id}`;
    await tx`UPDATE template_sample_processing_attempt SET outcome=${next==='QUEUED' ? 'RETRY' : next},
      error_code=${failure?.code ?? null},finished_at=now() WHERE lease_token=${token}`;
    await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
      VALUES (${connection.organization_id},${connection.branch_id},${row.requested_by},'TEMPLATE_SAMPLE_PROCESSED','TEMPLATE_SAMPLE',${row.id},
        ${tx.json({ state:next,errorCode:failure?.code ?? null,attempt:row.attempt_count+1 })})`;
  });
  return true;
}
