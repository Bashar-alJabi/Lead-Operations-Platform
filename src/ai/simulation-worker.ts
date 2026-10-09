import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { openSecret } from '../credentials.js';
import { effectiveCampaignContext } from './effective-context.js';
import { AIInferenceError,aiInferenceAdapters,type AIInferenceRegistry } from './inference-provider.js';
import { effectiveConfigHash } from './operational-config.js';
import { simulationProviderInput,simulationResult,type SimulationReference,type SimulationProposal } from './simulation.js';
export async function processOneAISimulation(db:Database,options:{ adapters?:AIInferenceRegistry;leaseSeconds?:number;retryDelaySeconds?:number }={}):Promise<boolean> {
  const lease=options.leaseSeconds ?? 60,delay=options.retryDelaySeconds;
  if(!Number.isFinite(lease) || lease<0.1 || lease>120 || delay!=null && (!Number.isFinite(delay) || delay<0 || delay>300))throw new Error('AI_SIMULATION_WORKER_CONFIG_INVALID');
  const token=randomUUID(),row=await db.begin(async(tx)=> {
    const s=(await tx`SELECT * FROM ai_campaign_simulation WHERE (state='QUEUED' AND available_at<=clock_timestamp()) OR (state='RUNNING' AND lease_until<=clock_timestamp()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)[0];
    if(!s)return null;
    if(s.attempt_count>=5){ await tx`UPDATE ai_campaign_simulation SET state='FAILED',error_code='AI_RETRY_EXHAUSTED',lease_token=NULL,lease_until=NULL,completed_lease_token=lease_token,version=version+1 WHERE id=${s.id}`;return { exhausted:true }; }
    return (await tx`UPDATE ai_campaign_simulation SET state='RUNNING',attempt_count=attempt_count+1,lease_token=${token},lease_until=clock_timestamp()+(${lease}*interval '1 second'),completed_lease_token=NULL,error_code=NULL,version=version+1 WHERE id=${s.id} RETURNING *`)[0]!;
  });if(!row)return false;if(row.exhausted)return true;
  const authorize=async(tx:postgres.TransactionSql)=> {
    const initial=(await tx`SELECT branch_id FROM campaign WHERE id=${row.campaign_id}`)[0];if(!initial)return null;
    const b=(await tx`SELECT * FROM branch WHERE id=${initial.branch_id} FOR SHARE`)[0]!,c=(await tx`SELECT * FROM campaign WHERE id=${row.campaign_id} FOR SHARE`)[0]!;
    if(!(await tx`SELECT ai_simulation_current(s) AS current FROM ai_campaign_simulation s WHERE id=${row.id}`)[0]?.current)return null;
    const current=await effectiveCampaignContext(tx,row.organization_id,c,b);if(current.hash!==row.context.hash || effectiveConfigHash(current)!==effectiveConfigHash(row.context))return null;
    const held=(await tx`SELECT 1 FROM ai_campaign_simulation WHERE id=${row.id} AND state='RUNNING' AND lease_token=${token} AND lease_until>clock_timestamp() FOR SHARE`)[0];return held ? current : null;
  };
  let result:ReturnType<typeof simulationResult>|null=null,failure:AIInferenceError|null=null,blocked=false;
  try {
    const input=await db.begin(async(tx)=> {
      const current=await authorize(tx);if(!current)return null;
      const profile=current.profiles.CONVERSATION as { connection_id:string;provider:string;model_id:string;max_output_tokens:number };
      const secret=(await tx`SELECT ciphertext,nonce,auth_tag,key_version FROM connection_secret WHERE connection_id=${profile.connection_id} FOR SHARE`)[0];
      if(!secret)throw new AIInferenceError('AI_AUTH_FAILED');let credential:string;
      try { credential=openSecret(profile.connection_id,{ ciphertext:secret.ciphertext,nonce:secret.nonce,authTag:secret.auth_tag,keyVersion:secret.key_version }); }catch { throw new AIInferenceError('AI_AUTH_FAILED'); }
      return { current,profile,credential };
    });
    if(!input)blocked=true;
    else {
      const adapter=(options.adapters ?? aiInferenceAdapters)[input.profile.provider];if(!adapter)throw new AIInferenceError('AI_MODEL_UNSUPPORTED');
      const proposed=await adapter.simulate({ credential:input.credential,model:input.profile.model_id,maxOutputTokens:input.profile.max_output_tokens,
        data:simulationProviderInput(input.current,row.question,row.references_json as SimulationReference[]) });
      try { result=simulationResult(proposed as SimulationProposal,row.references_json as SimulationReference[]); }catch { throw new AIInferenceError('AI_RESPONSE_INVALID'); }
    }
  }catch(e){ failure=e instanceof AIInferenceError ? e : new AIInferenceError('AI_PROVIDER_UNAVAILABLE',true); }
  await db.begin(async(tx)=> {
    // Validate dependencies before the job lock, following the Campaign/current configuration lock order.
    if(!blocked && !await authorize(tx))blocked=true;
    const held=(await tx`SELECT * FROM ai_campaign_simulation WHERE id=${row.id} FOR UPDATE`)[0];
    if(held?.state!=='RUNNING' || held.lease_token!==token || !(await tx`SELECT ${held.lease_until}::timestamptz>clock_timestamp() AS valid`)[0]!.valid)return;
    const retry=!blocked && failure?.retryable && held.attempt_count<5;
    const state=blocked ? 'BLOCKED' : failure ? retry ? 'QUEUED' : 'FAILED' : 'COMPLETED';
    await tx`UPDATE ai_campaign_simulation SET state=${state},result=${state==='COMPLETED' ? tx.json(result!) : null},error_code=${blocked ? 'AI_SIMULATION_CONTEXT_REVOKED_OR_CHANGED' : failure?.code ?? null},
      completed_lease_token=${token},lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+(${delay ?? Math.min(300,2**held.attempt_count)}*interval '1 second'),version=version+1 WHERE id=${row.id}`;
  });return true;
}
