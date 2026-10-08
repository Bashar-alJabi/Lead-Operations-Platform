import { createHash,randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { MediaError } from '../media/validation.js';
import { configuredMediaStorage,type MediaStorage } from '../media/storage.js';
import { configuredMediaScanner,type MediaScanner } from '../media/scanner.js';
import { knowledgeAssetMaxBytes,validateKnowledgeAsset } from './knowledge-assets.js';

export async function processOneKnowledgeAsset(db:Database,options:{ storage?:MediaStorage;scanner?:MediaScanner;leaseSeconds?:number;retryDelaySeconds?:number }={}):Promise<boolean> {
  const lease=options.leaseSeconds ?? 120,delay=options.retryDelaySeconds;
  if(!Number.isFinite(lease) || lease<0.1 || lease>120 || delay!=null && (!Number.isFinite(delay) || delay<0 || delay>300))throw new MediaError('KNOWLEDGE_WORKER_CONFIG_INVALID');
  const token=randomUUID();
  const row=await db.begin(async(tx)=> {
    const a=(await tx`SELECT * FROM ai_knowledge_asset WHERE (state='QUEUED' AND available_at<=now()) OR (state='RUNNING' AND lease_until<now()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)[0];
    if(!a)return null;
    if(a.attempt_count>=5){ await tx`UPDATE ai_knowledge_asset SET state='FAILED',error_code='KNOWLEDGE_RETRY_EXHAUSTED',completed_lease_token=lease_token,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=${a.id}`;return { exhausted:true } as const; }
    return (await tx`UPDATE ai_knowledge_asset SET state='RUNNING',lease_token=${token},completed_lease_token=NULL,lease_until=clock_timestamp()+(${lease}*interval '1 second'),attempt_count=attempt_count+1,error_code=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=${a.id} RETURNING *`)[0]!;
  });
  if(!row)return false;if('exhausted' in row)return true;
  let text:string|null=null,scanner:string|null=null,failure:MediaError|null=null;
  try {
    const storage=options.storage ?? configuredMediaStorage();if(storage.backend!==row.storage_backend)throw new MediaError('KNOWLEDGE_STORAGE_UNAVAILABLE',true);
    const bytes=await storage.get(row.storage_key,knowledgeAssetMaxBytes());
    if(bytes.length!==row.size_bytes || createHash('sha256').update(bytes).digest('hex')!==row.content_sha256)throw new MediaError('KNOWLEDGE_STORAGE_INTEGRITY_FAILED');
    text=await validateKnowledgeAsset(bytes,row.mime_type);
    const scan=await (options.scanner ?? configuredMediaScanner()).scan(bytes);
    if(!scan.clean)throw new MediaError('KNOWLEDGE_CONTENT_REJECTED');
    if(!scan.version || scan.version.length>255)throw new MediaError('KNOWLEDGE_SCANNER_RESPONSE_INVALID',true);scanner=scan.version;
  }catch(error){ failure=error instanceof MediaError ? error : new MediaError('KNOWLEDGE_PROCESSING_UNAVAILABLE',true); }
  await db.begin(async(tx)=> {
    // Same lock order as upload/review/publication; background work never inherits obsolete uploader access.
    const initial=(await tx`SELECT branch_id FROM campaign WHERE id=${row.campaign_id}`)[0]!;
    const b=(await tx`SELECT active FROM branch WHERE id=${initial.branch_id} FOR SHARE`)[0]!;
    const c=(await tx`SELECT branch_id,organization_id FROM campaign WHERE id=${row.campaign_id} FOR SHARE`)[0]!;
    const u=(await tx`SELECT active,role,branch_id,organization_id FROM user_account WHERE id=${row.uploaded_by} FOR SHARE`)[0];
    const a=(await tx`SELECT * FROM ai_knowledge_asset WHERE id=${row.id} FOR UPDATE`)[0];
    if(a?.state!=='RUNNING' || a.lease_token!==token || new Date(a.lease_until).getTime()<=Date.now())return;
    if(!b.active || !u?.active || u.organization_id!==c.organization_id || (u.role!=='SUPER_ADMIN' && (u.role!=='MANAGER' || u.branch_id!==c.branch_id)))failure=new MediaError('KNOWLEDGE_REQUESTER_ACCESS_REVOKED');
    const state=failure ? (failure.retryable && row.attempt_count<5 ? 'QUEUED' : failure.retryable ? 'FAILED' : 'REJECTED') : 'REVIEW';
    await tx`UPDATE ai_knowledge_asset SET state=${state},completed_lease_token=${token},lease_token=NULL,lease_until=NULL,error_code=${failure?.code ?? null},
      scanner_version=${failure ? null : scanner},scanned_at=${failure ? null : new Date()},extracted_text=${failure ? null : text},
      available_at=clock_timestamp()+(${delay ?? Math.min(300,2**row.attempt_count)}*interval '1 second'),version=version+1,updated_at=clock_timestamp() WHERE id=${row.id}`;
  });return true;
}
