import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { PaymentCheckoutError,type CheckoutIntent,type CheckoutSnapshot } from './checkout-provider.js';
import { checkoutInput,historicalPaymentCredentials } from './dispatch-worker.js';
import { almaHostedAdapter } from './alma-hosted.js';
import { almaIndependentCheckoutSnapshot } from './alma-checkout.js';
import { persistIndependentPaymentConfirmation } from './independent-confirmation.js';
import type { PaymentConfig,PaymentCredentials } from './providers.js';

export type PaymentIndependentReadAdapter={
  retrieve(config:PaymentConfig,credentials:PaymentCredentials,account:string,resource:string):Promise<CheckoutSnapshot>;
  matchesIntent(intent:CheckoutIntent,snapshot:CheckoutSnapshot):boolean;
};
export const independentPaymentReadAdapters:Readonly<Record<string,PaymentIndependentReadAdapter>>={ ALMA:{
  async retrieve(config,credentials,account,resource) { return almaIndependentCheckoutSnapshot(await almaHostedAdapter.retrieveReferenced(config,credentials,account,resource)); },
  matchesIntent(intent,snapshot) {
    const evidence=snapshot.providerEvidence;return !!intent.plan && !!evidence && evidence.source==='INDEPENDENT_ALMA_PAYMENT_READ'
      && evidence.captureMode==='AUTOMATIC' && evidence.installments===intent.plan.installments
      && evidence.deferredMonths===intent.plan.deferredMonths && evidence.deferredDays===intent.plan.deferredDays;
  },
} };
type ReadContext=postgres.Row&{ account_ref:string;mode:string;provider:string };
async function releaseMerchant(tx:postgres.TransactionSql,n:ReadContext,token:string) {
  await tx`UPDATE payment_merchant_lease SET token=NULL,expires_at=NULL WHERE provider=${n.provider} AND account_ref=${n.account_ref} AND mode=${n.mode} AND token=${token}`;
}
async function finish(tx:postgres.TransactionSql,n:ReadContext,state:string,code:string|null,delay=0) {
  await tx`UPDATE payment_independent_read_job SET state=${state},error_code=${code},lease_token=NULL,lease_until=NULL,
    run_after=clock_timestamp()+${delay}*interval '1 millisecond' WHERE notification_id=${n.id}`;
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (${n.organization_id},${n.branch_id},NULL,'PAYMENT_INDEPENDENT_READ_STATE','PAYMENT_NOTIFICATION',${n.id},${tx.json({ state,errorCode:code })})`;
}
export async function processOneIndependentPaymentRead(db:Database,adapters=independentPaymentReadAdapters):Promise<boolean> {
  const claim=await db.begin(async(tx)=> {
    const j=(await tx`SELECT j.* FROM payment_independent_read_job j JOIN payment_untrusted_notification n ON n.id=j.notification_id
      JOIN payment_notification_endpoint endpoint ON endpoint.id=n.endpoint_id JOIN integration_connection c ON c.id=n.connection_id
      WHERE (j.state IN ('QUEUED','RETRY') AND j.run_after<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM payment_merchant_lease m
        WHERE m.provider=c.provider AND m.account_ref=endpoint.account_ref AND m.mode=n.mode AND m.token IS NOT NULL AND m.expires_at>clock_timestamp()))
        OR (j.state='RUNNING' AND j.lease_until<=clock_timestamp()) ORDER BY j.run_after,j.notification_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`)[0];
    if(!j)return null;
    const n=(await tx`SELECT n.*,endpoint.account_ref,c.provider,c.organization_id,c.branch_id FROM payment_untrusted_notification n
      JOIN payment_notification_endpoint endpoint ON endpoint.id=n.endpoint_id JOIN integration_connection c ON c.id=n.connection_id
      WHERE n.id=${j.notification_id}`)[0]! as ReadContext;
    if(j.state==='RUNNING') {
      await tx`UPDATE payment_independent_read_attempt SET state='INTERRUPTED',finished_at=clock_timestamp(),error_code='PAYMENT_WORKER_INTERRUPTED' WHERE id=${j.lease_token} AND state='RUNNING'`;
      await finish(tx,n,j.attempts<5 ? 'RETRY' : 'NEEDS_ATTENTION','PAYMENT_WORKER_INTERRUPTED',2000);await releaseMerchant(tx,n,j.lease_token);return { recovered:true as const };
    }
    const anchor=(await tx`SELECT i.* FROM payment_notification_credential_anchor a JOIN payment_link_intent i ON i.id=a.intent_id WHERE a.endpoint_id=${n.endpoint_id}`)[0];
    const adapter=adapters[n.provider];
    if(!anchor || !adapter || j.attempts>=5) {
      await finish(tx,n,'NEEDS_ATTENTION',!anchor ? 'PAYMENT_READ_ORIGINAL_CREDENTIAL_REQUIRED' : !adapter ? 'PAYMENT_READ_UNSUPPORTED' : 'PAYMENT_READ_ATTEMPTS_EXHAUSTED');return { recovered:true as const };
    }
    let credentials:PaymentCredentials;try { credentials=historicalPaymentCredentials(anchor); }
    catch { await finish(tx,n,'NEEDS_ATTENTION','PAYMENT_CREDENTIALS_INVALID');return { recovered:true as const }; }
    await tx`INSERT INTO payment_merchant_lease(provider,account_ref,mode) VALUES (${n.provider},${n.account_ref},${n.mode}) ON CONFLICT DO NOTHING`;
    const merchant=(await tx`SELECT token FROM payment_merchant_lease WHERE provider=${n.provider} AND account_ref=${n.account_ref} AND mode=${n.mode}
      AND (token IS NULL OR expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED`)[0];if(!merchant)return null;
    const token=randomUUID();await tx`UPDATE payment_merchant_lease SET token=${token},expires_at=clock_timestamp()+interval '60 seconds'
      WHERE provider=${n.provider} AND account_ref=${n.account_ref} AND mode=${n.mode}`;
    await tx`UPDATE payment_independent_read_job SET state='RUNNING',attempts=attempts+1,lease_token=${token},lease_until=clock_timestamp()+interval '60 seconds',error_code=NULL WHERE notification_id=${n.id}`;
    await tx`INSERT INTO payment_independent_read_attempt(id,notification_id,number) VALUES (${token},${n.id},${j.attempts+1})`;
    return { recovered:false as const,n,token,number:j.attempts+1,credentials,config:anchor.config_snapshot as PaymentConfig,adapter };
  });
  if(!claim)return false;if(claim.recovered)return true;
  let snapshot:CheckoutSnapshot|null=null;let error:PaymentCheckoutError|null=null;
  // No current Connection credential fallback and no financial write. Historical reads survive disable/rotation.
  try { snapshot=await claim.adapter.retrieve(claim.config,claim.credentials,claim.n.account_ref,claim.n.resource_id); }
  catch(e) { error=e instanceof PaymentCheckoutError ? e : new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE','RETRYABLE'); }
  await db.begin(async(tx)=> {
    const j=(await tx`SELECT * FROM payment_independent_read_job WHERE notification_id=${claim.n.id} FOR UPDATE`)[0]!;
    if(j.state!=='RUNNING' || j.lease_token!==claim.token)return;
    if(!snapshot) {
      const retry=error!.certainty!=='REJECTED' && claim.number<5;
      await tx`UPDATE payment_independent_read_attempt SET state=${retry ? 'RETRYABLE' : 'REJECTED'},error_code=${error!.code},finished_at=clock_timestamp() WHERE id=${claim.token}`;
      await finish(tx,claim.n,retry ? 'RETRY' : 'NEEDS_ATTENTION',error!.code,Math.min(60000,2000*2**(claim.number-1)));await releaseMerchant(tx,claim.n,claim.token);return;
    }
    const i=(await tx`SELECT i.* FROM payment_link_intent i JOIN payment_write_admission admission ON admission.intent_id=i.id
      WHERE i.id=${snapshot.intentId} AND i.connection_id=${claim.n.connection_id} AND i.account_ref=${claim.n.account_ref} AND i.mode=${claim.n.mode} AND i.provider=${claim.n.provider}`)[0];
    const sessions=i ? await tx`SELECT session_id FROM payment_checkout_ack WHERE intent_id=${i.id} UNION SELECT session_id FROM payment_record WHERE intent_id=${i.id}` : [];
    if(!i || snapshot.sessionId!==claim.n.resource_id || snapshot.mode!==i.mode || snapshot.minor!==i.minor || snapshot.currency!==i.currency
      || sessions.some((r)=>r.session_id!==snapshot!.sessionId) || !claim.adapter.matchesIntent(checkoutInput(i),snapshot)) {
      await tx`UPDATE payment_independent_read_attempt SET state='REJECTED',finished_at=clock_timestamp(),error_code='PAYMENT_READ_ORIGINAL_CONTEXT_MISMATCH' WHERE id=${claim.token}`;
      await finish(tx,claim.n,'NEEDS_ATTENTION','PAYMENT_READ_ORIGINAL_CONTEXT_MISMATCH');await releaseMerchant(tx,claim.n,claim.token);return;
    }
    // Both accepted and UNKNOWN/no-ACK intents require the same native original-context financial proof.
    await persistIndependentPaymentConfirmation(tx,i,claim.token,snapshot);
    await tx`UPDATE payment_independent_read_attempt SET state='VERIFIED',finished_at=clock_timestamp() WHERE id=${claim.token}`;
    const pending=snapshot.status==='OPEN';const review=snapshot.status==='COMPLETE' && snapshot.paymentStatus!=='PAID';
    await finish(tx,claim.n,pending ? claim.number<5 ? 'RETRY' : 'NEEDS_ATTENTION' : review ? 'NEEDS_ATTENTION' : 'PROCESSED',
      pending ? 'PAYMENT_READ_WAITING_FINALIZATION' : review ? 'PAYMENT_CAPTURE_MISMATCH' : null,pending ? Math.min(60000,2000*2**(claim.number-1)) : 0);
    await releaseMerchant(tx,claim.n,claim.token);
  });return true;
}
