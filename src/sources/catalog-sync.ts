import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { HttpError,requireRole,type Principal } from '../security.js';
import { openSecret,openOpaque,sealOpaque } from '../credentials.js';
import { SourceProviderError,validateSourcePages,validateSourceForms,type LeadSourceCatalogAdapter,type SourceConfig,type SourceCredentials } from './meta-provider.js';

export async function managedSourceConnection(db:Database,actor:Principal,id:string) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const row=(await db`SELECT id,branch_id,config,status,version FROM integration_connection
    WHERE id=${id} AND organization_id=${actor.organizationId} AND kind='META' AND provider='META_LEAD_ADS'
      AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId})`)[0];
  if (!row) throw new HttpError(404,'SOURCE_CONNECTION_NOT_FOUND');return row;
}
export async function recheckSourceActor(db:Database,actor:Principal):Promise<void> {
  const valid=await db`SELECT id FROM user_account WHERE id=${actor.id} AND active
    AND organization_id=${actor.organizationId} AND role=${actor.role}
    AND branch_id IS NOT DISTINCT FROM ${actor.branchId}::uuid FOR SHARE`;
  if (!valid.length) throw new HttpError(403,'SOURCE_ACTOR_NO_LONGER_AUTHORIZED');
}
export async function syncSourceCatalog(db:Database,actor:Principal,connectionId:string,
  input:{ version:number;pageId?:string },adapter:LeadSourceCatalogAdapter) {
  const connection=await managedSourceConnection(db,actor,connectionId);const operationId=randomUUID();
  const kind=input.pageId ? 'FORM' : 'PAGE';
  const reservation=await db.begin(async(tx)=> {
    const current=(await tx`SELECT version,status,config FROM integration_connection WHERE id=${connectionId} FOR UPDATE`)[0]!;
    await recheckSourceActor(tx as unknown as Database,actor);
    if (current.version!==input.version) throw new HttpError(409,'SOURCE_CONNECTION_VERSION_CONFLICT');
    if (current.status==='DISABLED') throw new HttpError(409,'SOURCE_CONNECTION_DISABLED');
    await tx`UPDATE source_resource_sync SET state='FAILED',error_code='SOURCE_SYNC_LEASE_EXPIRED',finished_at=now()
      WHERE connection_id=${connectionId} AND state='RUNNING' AND lease_until<=now()`;
    if ((await tx`SELECT 1 FROM source_resource_sync WHERE connection_id=${connectionId} AND state='RUNNING'`).length)
      throw new HttpError(409,'SOURCE_SYNC_RUNNING');
    const secret=(await tx`SELECT * FROM connection_secret WHERE connection_id=${connectionId}`)[0];
    if (!secret) throw new HttpError(409,'SOURCE_CREDENTIAL_UNAVAILABLE');
    let credentials:SourceCredentials;
    try { credentials=JSON.parse(openSecret(connectionId,{ ciphertext:secret.ciphertext,nonce:secret.nonce,authTag:secret.auth_tag,keyVersion:secret.key_version })); }
    catch { throw new HttpError(409,'SOURCE_CREDENTIAL_UNAVAILABLE'); }
    const page=input.pageId ? (await tx`SELECT r.id,r.external_id,r.connection_version,r.active,s.* FROM source_resource r
      LEFT JOIN source_resource_secret s ON s.resource_id=r.id WHERE r.id=${input.pageId} AND r.connection_id=${connectionId}
        AND r.resource_kind='PAGE'`)[0] : null;
    if (input.pageId && !page) throw new HttpError(404,'SOURCE_PAGE_NOT_FOUND');
    let pageToken:string|undefined;
    if (page) {
      if (!page.active || page.connection_version!==current.version || !page.ciphertext) throw new HttpError(409,'SOURCE_PAGE_NOT_READY');
      try { pageToken=openOpaque(`source-resource:${page.id}`,{ ciphertext:page.ciphertext,nonce:page.nonce,authTag:page.auth_tag,keyVersion:page.key_version }); }
      catch { throw new HttpError(409,'SOURCE_PAGE_CREDENTIAL_UNAVAILABLE'); }
    }
    await tx`INSERT INTO source_resource_sync (id,connection_id,connection_version,resource_kind,parent_id,actor_user_id,lease_until)
      VALUES (${operationId},${connectionId},${current.version},${kind},${input.pageId ?? null},${actor.id},now()+interval '120 seconds')`;
    await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
      VALUES (${actor.organizationId},${connection.branch_id},${actor.id},'SOURCE_CATALOG_SYNC_STARTED','CONNECTION',${connectionId},
        ${tx.json({ operationId,kind,pageId:input.pageId ?? null })})`;
    return { credentials,pageToken,pageExternalId:page?.external_id as string|undefined,version:current.version as number,config:current.config as SourceConfig };
  });
  try {
    const resources=input.pageId ? validateSourceForms(await adapter.discoverForms(reservation.config,
      { externalId:reservation.pageExternalId!,accessToken:reservation.pageToken! }))
      : validateSourcePages(await adapter.discoverPages(reservation.config,reservation.credentials));
    return await db.begin(async(tx)=> {
      const current=(await tx`SELECT version,status FROM integration_connection WHERE id=${connectionId} FOR UPDATE`)[0]!;
      await recheckSourceActor(tx as unknown as Database,actor);
      const operation=(await tx`SELECT state,lease_until>now() AS live FROM source_resource_sync WHERE id=${operationId} FOR UPDATE`)[0]!;
      if (current.version!==reservation.version || current.status==='DISABLED') throw new HttpError(409,'SOURCE_CONFIGURATION_CHANGED');
      if (operation.state!=='RUNNING' || !operation.live) throw new HttpError(409,'SOURCE_SYNC_LEASE_LOST');
      await tx`UPDATE source_resource SET active=false,version=version+1 WHERE connection_id=${connectionId}
        AND resource_kind=${kind} AND parent_id IS NOT DISTINCT FROM ${input.pageId ?? null}::uuid AND active`;
      for (const item of resources) {
        const id=(await tx`INSERT INTO source_resource (connection_id,resource_kind,parent_id,external_id,name,provider_status,questions,connection_version)
          VALUES (${connectionId},${kind},${input.pageId ?? null},${item.externalId},${item.name},${'status' in item ? item.status : null},
            ${tx.json('questions' in item ? item.questions : [])},${current.version})
          ON CONFLICT (connection_id,resource_kind,external_id) DO UPDATE SET name=EXCLUDED.name,
            provider_status=EXCLUDED.provider_status,questions=EXCLUDED.questions,connection_version=EXCLUDED.connection_version,
            active=true,version=source_resource.version+1,last_synced_at=now() RETURNING id`)[0]!.id;
        if ('accessToken' in item) {
          const sealed=sealOpaque(`source-resource:${id}`,item.accessToken);
          await tx`INSERT INTO source_resource_secret (resource_id,ciphertext,nonce,auth_tag,key_version)
            VALUES (${id},${sealed.ciphertext},${sealed.nonce},${sealed.authTag},${sealed.keyVersion})
            ON CONFLICT (resource_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,
              auth_tag=EXCLUDED.auth_tag,key_version=EXCLUDED.key_version,updated_at=now()`;
        }
      }
      if (kind==='PAGE') await tx`UPDATE source_resource f SET active=false,version=f.version+1 FROM source_resource p
        WHERE f.parent_id=p.id AND p.connection_id=${connectionId} AND NOT p.active AND f.active`;
      await tx`UPDATE source_resource_sync SET state='SUCCEEDED',resource_count=${resources.length},finished_at=now() WHERE id=${operationId}`;
      await tx`UPDATE integration_connection SET status=${resources.length ? 'CONNECTED' : 'WARNING'},last_success_at=now(),updated_at=now(),
        last_error_code=${resources.length ? null : 'SOURCE_NO_RESOURCES'},
        capabilities=(capabilities-'intakeReady') || ${tx.json({ catalogDiscovered:true })} WHERE id=${connectionId}`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${connection.branch_id},${actor.id},'SOURCE_CATALOG_SYNC_SUCCEEDED','CONNECTION',${connectionId},
          ${tx.json({ operationId,kind,resourceCount:resources.length })})`;
      return { operationId,resourceCount:resources.length,status:resources.length ? 'CONNECTED' : 'WARNING',processingAvailable:true };
    });
  } catch (error) {
    const code=error instanceof SourceProviderError ? error.code : error instanceof HttpError ? error.code : 'SOURCE_CATALOG_SYNC_FAILED';
    await db.begin(async(tx)=> {
      const current=(await tx`SELECT version,status FROM integration_connection WHERE id=${connectionId} FOR UPDATE`)[0]!;
      const superseded=current.version!==reservation.version || current.status==='DISABLED' || code==='SOURCE_SYNC_LEASE_LOST';
      const changed=await tx`UPDATE source_resource_sync SET state=${superseded ? 'SUPERSEDED' : 'FAILED'},error_code=${code},finished_at=now()
        WHERE id=${operationId} AND state='RUNNING' RETURNING id`;
      if (changed.length) {
        if (!superseded) await tx`UPDATE integration_connection SET last_failure_at=now(),last_error_code=${code},
          status=${code==='SOURCE_PROVIDER_AUTH_FAILED' ? 'AUTH_EXPIRED' : 'ERROR'} WHERE id=${connectionId}`;
        await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
          VALUES (${actor.organizationId},${connection.branch_id},${actor.id},'SOURCE_CATALOG_SYNC_FAILED','CONNECTION',${connectionId},
            ${tx.json({ operationId,kind,reason:code })})`;
      }
    });
    if (error instanceof HttpError) throw error;
    throw new HttpError(error instanceof SourceProviderError && error.retryable ? 503 : 502,code);
  }
}
