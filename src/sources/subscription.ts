import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { HttpError,type Principal } from '../security.js';
import { openOpaque,openSecret } from '../credentials.js';
import { managedSourceConnection,recheckSourceActor } from './catalog-sync.js';
import { SourceProviderError,type SourceConfig,type SourceCredentials } from './meta-provider.js';
import type { LeadSourceSubscriptionAdapter } from './meta-subscription.js';

export async function sourceCredentials(db:Database,id:string):Promise<SourceCredentials> {
  const secret=(await db`SELECT ciphertext,nonce,auth_tag,key_version FROM connection_secret WHERE connection_id=${id}`)[0];
  try {
    if (!secret) throw new Error('missing');
    const value=JSON.parse(openSecret(id,{ ciphertext:secret.ciphertext,nonce:secret.nonce,authTag:secret.auth_tag,keyVersion:secret.key_version }));
    if (!value.appSecret || !value.verifyToken || !value.accessToken) throw new Error('missing');return value;
  } catch { throw new HttpError(409,'SOURCE_CREDENTIAL_UNAVAILABLE'); }
}
export async function checkSourceSubscription(db:Database,actor:Principal,connectionId:string,
  input:{ version:number;pageId:string;pageVersion:number;subscribe:boolean },adapter:LeadSourceSubscriptionAdapter) {
  const connection=await managedSourceConnection(db,actor,connectionId);const id=randomUUID();
  const reservation=await db.begin(async(tx)=> {
    const current=(await tx`SELECT version,status,config FROM integration_connection WHERE id=${connectionId} FOR UPDATE`)[0]!;
    await recheckSourceActor(tx as unknown as Database,actor);
    if (current.version!==input.version) throw new HttpError(409,'SOURCE_CONNECTION_VERSION_CONFLICT');
    if (current.status==='DISABLED') throw new HttpError(409,'SOURCE_CONNECTION_DISABLED');
    if (!current.config.appId) throw new HttpError(409,'SOURCE_APP_ID_REQUIRED');
    const page=(await tx`SELECT r.id,r.external_id,r.version,r.active,r.connection_version,s.* FROM source_resource r
      LEFT JOIN source_resource_secret s ON s.resource_id=r.id WHERE r.id=${input.pageId} AND r.connection_id=${connectionId} AND r.resource_kind='PAGE'`)[0];
    if (!page) throw new HttpError(404,'SOURCE_PAGE_NOT_FOUND');
    if (page.version!==input.pageVersion) throw new HttpError(409,'SOURCE_PAGE_VERSION_CONFLICT');
    if (!page.active || page.connection_version!==current.version || !page.ciphertext) throw new HttpError(409,'SOURCE_PAGE_NOT_READY');
    await tx`UPDATE source_subscription_attempt SET state='FAILED',error_code='SOURCE_SUBSCRIPTION_LEASE_EXPIRED',finished_at=now()
      WHERE connection_id=${connectionId} AND state='RUNNING' AND lease_until<=now()`;
    if ((await tx`SELECT 1 FROM source_subscription_attempt WHERE connection_id=${connectionId} AND state='RUNNING'`).length)
      throw new HttpError(409,'SOURCE_SUBSCRIPTION_RUNNING');
    const credentials=await sourceCredentials(tx as unknown as Database,connectionId);
    let accessToken:string;
    try { accessToken=openOpaque(`source-resource:${page.id}`,{ ciphertext:page.ciphertext,nonce:page.nonce,authTag:page.auth_tag,keyVersion:page.key_version }); }
    catch { throw new HttpError(409,'SOURCE_PAGE_CREDENTIAL_UNAVAILABLE'); }
    await tx`INSERT INTO source_subscription_attempt (id,connection_id,connection_version,page_id,page_version,actor_user_id,action,lease_until)
      VALUES (${id},${connectionId},${current.version},${page.id},${page.version},${actor.id},${input.subscribe ? 'SUBSCRIBE' : 'TEST'},now()+interval '120 seconds')`;
    await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
      VALUES (${actor.organizationId},${connection.branch_id},${actor.id},'SOURCE_SUBSCRIPTION_STARTED','CONNECTION',${connectionId},${tx.json({ attemptId:id,pageId:page.id,subscribe:input.subscribe })})`;
    return { config:current.config as SourceConfig,page:{ externalId:page.external_id as string,accessToken },appSecret:credentials.appSecret,
      version:current.version as number,pageVersion:page.version as number };
  });
  try {
    const result=await adapter.check({ ...reservation,subscribe:input.subscribe });
    if (!result || typeof result.subscribed!=='boolean' || (input.subscribe && !result.subscribed)) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
    return await db.begin(async(tx)=> {
      const current=(await tx`SELECT version,status FROM integration_connection WHERE id=${connectionId} FOR UPDATE`)[0]!;
      await recheckSourceActor(tx as unknown as Database,actor);
      const attempt=(await tx`SELECT state,lease_until>now() AS live FROM source_subscription_attempt WHERE id=${id} FOR UPDATE`)[0]!;
      const page=(await tx`SELECT version,active FROM source_resource WHERE id=${input.pageId}`)[0]!;
      if (current.version!==reservation.version || current.status==='DISABLED' || page.version!==reservation.pageVersion || !page.active)
        throw new HttpError(409,'SOURCE_CONFIGURATION_CHANGED');
      if (attempt.state!=='RUNNING' || !attempt.live) throw new HttpError(409,'SOURCE_SUBSCRIPTION_LEASE_LOST');
      await tx`UPDATE source_subscription_attempt SET state='SUCCEEDED',subscribed=${result.subscribed},finished_at=now() WHERE id=${id}`;
      await tx`UPDATE integration_connection SET status='WARNING',last_success_at=now(),last_error_code='INTAKE_NOT_CONFIGURED',
        capabilities=capabilities || '{"intakeReady":false}'::jsonb,updated_at=now() WHERE id=${connectionId}`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${connection.branch_id},${actor.id},'SOURCE_SUBSCRIPTION_CHECKED','CONNECTION',${connectionId},${tx.json({ attemptId:id,pageId:input.pageId,subscribed:result.subscribed })})`;
      return { attemptId:id,subscribed:result.subscribed,intakeReady:false };
    });
  } catch (error) {
    const code=error instanceof HttpError ? error.code : error instanceof SourceProviderError ? error.code : 'SOURCE_SUBSCRIPTION_FAILED';
    await db.begin(async(tx)=> {
      const current=(await tx`SELECT version,status FROM integration_connection WHERE id=${connectionId} FOR UPDATE`)[0]!;
      const page=(await tx`SELECT version,active FROM source_resource WHERE id=${input.pageId}`)[0]!;
      const superseded=current.version!==reservation.version || current.status==='DISABLED' || page.version!==reservation.pageVersion || !page.active || code==='SOURCE_SUBSCRIPTION_LEASE_LOST';
      const updated=await tx`UPDATE source_subscription_attempt SET state=${superseded ? 'SUPERSEDED' : 'FAILED'},error_code=${code},finished_at=now()
        WHERE id=${id} AND state='RUNNING' RETURNING id`;
      if (updated.length) {
        if (!superseded) await tx`UPDATE integration_connection SET last_failure_at=now(),last_error_code=${code},
          status=${code==='SOURCE_PROVIDER_AUTH_FAILED' ? 'AUTH_EXPIRED' : 'ERROR'} WHERE id=${connectionId}`;
        await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
          VALUES (${actor.organizationId},${connection.branch_id},${actor.id},'SOURCE_SUBSCRIPTION_FAILED','CONNECTION',${connectionId},${tx.json({ attemptId:id,pageId:input.pageId,reason:code })})`;
      }
    });
    if (error instanceof HttpError) throw error;
    throw new HttpError(error instanceof SourceProviderError && error.retryable ? 503 : 502,code);
  }
}
