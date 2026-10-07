import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { openOpaque,sealOpaque } from '../credentials.js';
import { PaymentCheckoutError,paymentCheckoutAdapters,type CheckoutIntent,type CheckoutSnapshot,type PaymentCheckoutAdapter } from './checkout-provider.js';
import { paymentAttemptUncertain,paymentDispatchWindow,resolvePaymentAttempt,type PaymentAttemptEvidence,type PaymentDispatchPolicy } from './dispatch-policy.js';
import { validatePaymentCredentials,type PaymentConfig,type PaymentCredentials } from './providers.js';

export type CheckoutAdapters=Readonly<Record<string,PaymentCheckoutAdapter>>;
export function checkoutInput(i:postgres.Row):CheckoutIntent {
  return { id:i.id,accountRef:i.account_ref,name:i.method_name,successUrl:i.success_url,cancelUrl:i.cancel_url,
    money:{ amount:i.amount,currency:i.currency,minor:i.minor,scale:i.scale,quantum:i.quantum } };
}
export function historicalPaymentCredentials(i:postgres.Row):PaymentCredentials {
  const credentials=JSON.parse(openOpaque('payment-link:'+i.id,{ ciphertext:i.ciphertext,nonce:i.nonce,authTag:i.auth_tag,keyVersion:i.key_version })) as PaymentCredentials;
  validatePaymentCredentials(i.config_snapshot as PaymentConfig,credentials,i.provider);return credentials;
}
export async function paymentDbClock(tx:postgres.TransactionSql) {
  return Number((await tx`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`)[0]!.ms);
}
async function history(tx:postgres.TransactionSql,id:string):Promise<PaymentAttemptEvidence[]> {
  return (await tx`SELECT number,state FROM payment_dispatch_attempt WHERE intent_id=${id} ORDER BY number`) as unknown as PaymentAttemptEvidence[];
}
// Same resource order as request creation. Original authorization is required for every new provider write.
async function dispatchIssue(tx:postgres.TransactionSql,i:postgres.Row):Promise<string|null> {
  const c=(await tx`SELECT * FROM integration_connection WHERE id=${i.connection_id} FOR SHARE`)[0];
  const b=(await tx`SELECT active FROM branch WHERE id=${i.branch_id} FOR SHARE`)[0];
  const m=(await tx`SELECT * FROM payment_method WHERE id=${i.method_id} FOR SHARE`)[0];
  const w=(await tx`SELECT * FROM payment_webhook WHERE id=${i.webhook_id} FOR SHARE`)[0];
  const l=(await tx`SELECT * FROM lead WHERE id=${i.lead_id} FOR SHARE`)[0];
  const u=(await tx`SELECT * FROM user_account WHERE id=${i.requester_id} FOR SHARE`)[0];
  const s=(await tx`SELECT id FROM user_session WHERE id=${i.requester_session_id} AND user_id=${i.requester_id}
    AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`)[0];
  if(!u?.active || !s || u.organization_id!==i.organization_id || u.role!==i.requester_role || u.branch_id!==i.requester_branch_id)
    return 'PAYMENT_ACCESS_REVOKED';
  if(!l || l.organization_id!==i.organization_id || l.branch_id!==i.branch_id || l.campaign_id!==i.campaign_id || l.assigned_agent_id!==i.assigned_agent_id
    || (u.role!=='SUPER_ADMIN' && u.branch_id!==l.branch_id) || (u.role==='AGENT' && l.assigned_agent_id!==u.id))return 'PAYMENT_LEAD_CONTEXT_CHANGED';
  if(!b?.active)return 'PAYMENT_BRANCH_DISABLED';
  if(!m?.active || m.version!==i.method_version || m.connection_id!==i.connection_id || m.branch_id!==i.branch_id
    || !m.currencies.includes(i.currency) || (m.campaign_mode==='SELECTED' && !m.campaign_ids.includes(l.campaign_id))
    || (u.role==='AGENT' && m.agent_mode==='SELECTED' && !m.agent_ids.includes(u.id)))return 'PAYMENT_METHOD_CHANGED';
  if(!c || c.kind!=='PAYMENT' || c.organization_id!==i.organization_id || (c.branch_id && c.branch_id!==i.branch_id)
    || c.version!==i.connection_version || c.provider!==i.provider || c.config.mode!==i.mode || !['CONNECTED','WARNING'].includes(c.status)
    || c.capabilities.authenticationVerified!==true || c.capabilities.paymentOptionsVersion!==i.connection_version
    || c.capabilities.paymentOptions?.accountRef!==i.account_ref || c.capabilities.paymentOptions?.chargesEnabled!==true
    || !c.capabilities.paymentOptions?.currencies.includes(i.currency))return 'PAYMENT_CONNECTION_CHANGED';
  const probe=w ? (await tx`SELECT state FROM payment_webhook_probe WHERE webhook_id=${w.id} ORDER BY probe_number DESC LIMIT 1`)[0] : null;
  if(!w || w.state!=='CONFIGURED' || w.version!==i.webhook_version || w.connection_version!==i.connection_version
    || !w.last_signed_at || probe?.state!=='VERIFIED')return 'PAYMENT_WEBHOOK_CHANGED';
  // Session expiration can occur while the later probe query executes.
  if(!(await tx`SELECT id FROM user_session WHERE id=${i.requester_session_id} AND revoked_at IS NULL AND expires_at>clock_timestamp()`).length)
    return 'PAYMENT_ACCESS_REVOKED';
  return null;
}
async function audit(tx:postgres.TransactionSql,i:postgres.Row,state:string,code:string|null) {
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (${i.organization_id},${i.branch_id},NULL,'PAYMENT_DISPATCH_STATE','PAYMENT_LINK',${i.id},${tx.json({ state,errorCode:code })})`;
}
async function releaseMerchant(tx:postgres.TransactionSql,i:postgres.Row,token:string) {
  await tx`UPDATE payment_merchant_lease SET token=NULL,expires_at=NULL WHERE provider=${i.provider} AND account_ref=${i.account_ref} AND mode=${i.mode} AND token=${token}`;
}
async function finishState(tx:postgres.TransactionSql,i:postgres.Row,state:string,code:string|null,runAfterMs:number|null=null) {
  await tx`UPDATE payment_dispatch SET state=${state},error_code=${code},lease_token=NULL,lease_until=NULL,
    run_after=CASE WHEN ${runAfterMs}::bigint IS NULL THEN run_after ELSE to_timestamp(${runAfterMs}::double precision/1000) END,
    updated_at=clock_timestamp() WHERE intent_id=${i.id}`;
  await audit(tx,i,state,code);
}
export async function processOnePaymentDispatch(db:Database,adapters:CheckoutAdapters=paymentCheckoutAdapters):Promise<boolean> {
  const claim=await db.begin(async(tx)=> {
    const d=(await tx`SELECT d.* FROM payment_dispatch d JOIN payment_link_intent i ON i.id=d.intent_id
      WHERE (d.state IN ('QUEUED','RETRY') AND d.run_after<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM payment_merchant_lease m
        WHERE m.provider=i.provider AND m.account_ref=i.account_ref AND m.mode=i.mode AND m.token IS NOT NULL AND m.expires_at>clock_timestamp()))
      OR (d.state='RUNNING' AND d.lease_until<=clock_timestamp()) ORDER BY d.run_after,d.intent_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`)[0];
    if(!d)return null;
    const i=(await tx`SELECT * FROM payment_link_intent WHERE id=${d.intent_id}`)[0]!;
    if(d.state==='RUNNING') {
      await tx`UPDATE payment_dispatch_attempt SET state='INTERRUPTED',error_code='PAYMENT_WORKER_INTERRUPTED',finished_at=clock_timestamp()
        WHERE id=${d.lease_token} AND state='RUNNING'`;
      const resolution=resolvePaymentAttempt({ nowMs:await paymentDbClock(tx),firstDispatchMs:Number(d.first_dispatch_ms),history:await history(tx,i.id),policy:d.policy });
      await releaseMerchant(tx,i,d.lease_token);
      if((await tx`SELECT id FROM payment_record WHERE intent_id=${i.id}`).length) {
        await finishState(tx,i,'NEEDS_ATTENTION','PAYMENT_DISPATCH_RECONCILED_RECEIPT');return { recovered:true as const };
      }
      await finishState(tx,i,resolution.state==='RETRY' ? 'RETRY' : resolution.state,resolution.reason,
        resolution.state==='RETRY' ? resolution.runAfterMs : null);return { recovered:true as const };
    }
    const evidence=await history(tx,i.id);const issue=await dispatchIssue(tx,i);
    if((await tx`SELECT id FROM payment_record WHERE intent_id=${i.id}`).length) {
      await finishState(tx,i,'NEEDS_ATTENTION','PAYMENT_DISPATCH_RECONCILED_RECEIPT');return { recovered:true as const };
    }
    if(issue) { await finishState(tx,i,paymentAttemptUncertain(evidence) ? 'NEEDS_ATTENTION' : 'BLOCKED',issue);return { recovered:true as const }; }
    const adapter=adapters[i.provider];if(!adapter) { await finishState(tx,i,'BLOCKED','PAYMENT_CHECKOUT_UNSUPPORTED');return { recovered:true as const }; }
    const policy:PaymentDispatchPolicy=d.policy ?? { maxAttempts:5,retentionMs:adapter.idempotencyRetentionMs,dispatchBudgetMs:20000,retryBaseMs:2000,retryMaxMs:60000 };
    const now=await paymentDbClock(tx);const window=paymentDispatchWindow({ nowMs:now,firstDispatchMs:d.first_dispatch_ms===null ? null : Number(d.first_dispatch_ms),history:evidence,policy });
    if(!window.allowed) { await finishState(tx,i,paymentAttemptUncertain(evidence) ? 'NEEDS_ATTENTION' : 'FAILED',window.reason);return { recovered:true as const }; }
    // A blocked merchant is skipped without consuming an attempt or an idempotency window.
    await tx`INSERT INTO payment_merchant_lease(provider,account_ref,mode) VALUES (${i.provider},${i.account_ref},${i.mode}) ON CONFLICT DO NOTHING`;
    const merchant=(await tx`SELECT * FROM payment_merchant_lease WHERE provider=${i.provider} AND account_ref=${i.account_ref} AND mode=${i.mode}
      AND (token IS NULL OR expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED`)[0];
    if(!merchant)return null;
    let credentials:PaymentCredentials;try { credentials=historicalPaymentCredentials(i); }
    catch { await finishState(tx,i,'BLOCKED','PAYMENT_CREDENTIALS_INVALID');return { recovered:true as const }; }
    const token=randomUUID();
    await tx`UPDATE payment_merchant_lease SET token=${token},expires_at=clock_timestamp()+interval '60 seconds'
      WHERE provider=${i.provider} AND account_ref=${i.account_ref} AND mode=${i.mode}`;
    // Recheck after acquiring merchant locks; an expired session must not get a provider write.
    if(!(await tx`SELECT payment_dispatch_authorized(${i.id}) AS allowed`)[0]!.allowed) {
      await releaseMerchant(tx,i,token);await finishState(tx,i,paymentAttemptUncertain(evidence) ? 'NEEDS_ATTENTION' : 'BLOCKED','PAYMENT_ACCESS_REVOKED');return { recovered:true as const };
    }
    await tx`UPDATE payment_dispatch SET state='RUNNING',lease_token=${token},lease_until=clock_timestamp()+interval '60 seconds',
      first_dispatch_ms=COALESCE(first_dispatch_ms,${await paymentDbClock(tx)}),policy=COALESCE(policy,${tx.json(policy)}),error_code=NULL,updated_at=clock_timestamp() WHERE intent_id=${i.id}`;
    await tx`INSERT INTO payment_dispatch_attempt(id,intent_id,number) VALUES (${token},${i.id},${evidence.length+1})`;
    await audit(tx,i,'RUNNING',null);return { recovered:false as const,i,token,credentials,adapter };
  });
  if(!claim)return false;if(claim.recovered)return true;
  let result:CheckoutSnapshot|null=null;let error:PaymentCheckoutError|null=null;
  // No database transaction or locks survive across network I/O.
  try { result=await claim.adapter.create(claim.i.config_snapshot,claim.credentials,checkoutInput(claim.i)); }
  catch(e) { error=e instanceof PaymentCheckoutError ? e : new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE','UNKNOWN'); }
  await db.begin(async(tx)=> {
    const d=(await tx`SELECT * FROM payment_dispatch WHERE intent_id=${claim.i.id} FOR UPDATE`)[0]!;
    // Late results after lease recovery never overwrite a newer attempt. The identical key can be reconciled by a receipt.
    if(d.state!=='RUNNING' || d.lease_token!==claim.token)return;
    if(result) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'payment-confirmation:'+claim.i.id},0))`;
      const confirmedSession=(await tx`SELECT session_id FROM payment_record WHERE intent_id=${claim.i.id}`)[0];
      if(confirmedSession && confirmedSession.session_id!==result.sessionId) {
        await tx`UPDATE payment_dispatch_attempt SET state='UNKNOWN',error_code='PAYMENT_SESSION_MISMATCH',finished_at=clock_timestamp() WHERE id=${claim.token}`;
        await finishState(tx,claim.i,'NEEDS_ATTENTION','PAYMENT_SESSION_MISMATCH');await releaseMerchant(tx,claim.i,claim.token);return;
      }
      const sealed=sealOpaque('payment-checkout:'+claim.i.id,JSON.stringify(result));
      await tx`INSERT INTO payment_checkout_ack(intent_id,attempt_id,provider,account_ref,mode,session_id,expires_at,ciphertext,nonce,auth_tag,key_version)
        VALUES (${claim.i.id},${claim.token},${claim.i.provider},${claim.i.account_ref},${claim.i.mode},${result.sessionId},${result.expiresAt},
          ${sealed.ciphertext},${sealed.nonce},${sealed.authTag},${sealed.keyVersion})`;
      await tx`UPDATE payment_dispatch_attempt SET state='ACKNOWLEDGED',finished_at=clock_timestamp() WHERE id=${claim.token}`;
      await finishState(tx,claim.i,'ACCEPTED',null);
      await tx`INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES (${claim.i.lead_id},NULL,'PAYMENT_LINK_CREATED',
        ${tx.json({ intentId:claim.i.id,methodName:claim.i.method_name,amount:claim.i.amount,currency:claim.i.currency })})`;
    } else {
      await tx`UPDATE payment_dispatch_attempt SET state=${error!.certainty},error_code=${error!.code},finished_at=clock_timestamp() WHERE id=${claim.token}`;
      const resolution=resolvePaymentAttempt({ nowMs:await paymentDbClock(tx),firstDispatchMs:Number(d.first_dispatch_ms),history:await history(tx,claim.i.id),policy:d.policy },error!.retryAfterSeconds);
      await finishState(tx,claim.i,resolution.state==='RETRY' ? 'RETRY' : resolution.state,resolution.reason ?? error!.code,
        resolution.state==='RETRY' ? resolution.runAfterMs : null);
    }
    await releaseMerchant(tx,claim.i,claim.token);
  });return true;
}
