import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { openOpaque } from '../credentials.js';
import { paymentCheckoutAdapters,PaymentCheckoutError,type CheckoutSnapshot } from './checkout-provider.js';
import { checkoutInput,historicalPaymentCredentials,type CheckoutAdapters } from './dispatch-worker.js';
import { persistPaymentState } from './payment-state.js';
import { paymentReceiptIntent } from './receipt-context.js';
import { paymentReceiptAdapters } from './receipt-adapters.js';
import type { PaymentReceiptAdapters } from './receipt-provider.js';
async function completeJob(tx:postgres.TransactionSql,id:string,state:string,code:string|null,delay=0) {
  await tx`UPDATE payment_receipt_job SET state=${state},error_code=${code},lease_token=NULL,lease_until=NULL,
    run_after=clock_timestamp()+${delay}*interval '1 millisecond',updated_at=clock_timestamp() WHERE event_id=${id}`;
}
export async function processOnePaymentReceipt(db:Database,adapters:CheckoutAdapters=paymentCheckoutAdapters,receipts:PaymentReceiptAdapters=paymentReceiptAdapters):Promise<boolean> {
  const claim=await db.begin(async(tx)=> {
    const j=(await tx`SELECT * FROM payment_receipt_job WHERE (state IN ('QUEUED','RETRY') AND run_after<=clock_timestamp())
      OR (state='RUNNING' AND lease_until<=clock_timestamp()) ORDER BY run_after,event_id LIMIT 1 FOR UPDATE SKIP LOCKED`)[0];
    if(!j)return null;
    if(j.state==='RUNNING') {
      await tx`UPDATE payment_receipt_attempt SET state='INTERRUPTED',finished_at=clock_timestamp(),error_code='PAYMENT_WORKER_INTERRUPTED' WHERE id=${j.lease_token} AND state='RUNNING'`;
      await completeJob(tx,j.event_id,j.attempts<j.attempt_limit ? 'RETRY' : 'NEEDS_ATTENTION','PAYMENT_WORKER_INTERRUPTED',2000);return { recovered:true as const };
    }
    const e=(await tx`SELECT * FROM payment_webhook_event WHERE id=${j.event_id}`)[0]!;
    const context=await paymentReceiptIntent(tx,e,receipts);
    if(!context.intent) { await completeJob(tx,e.id,context.ignored ? 'IGNORED' : 'NEEDS_ATTENTION',context.issue);return { recovered:true as const }; }
    const i=context.intent;const adapter=adapters[i.provider];
    if(!adapter || j.attempts>=j.attempt_limit) { await completeJob(tx,e.id,'NEEDS_ATTENTION','PAYMENT_RECEIPT_ATTEMPTS_EXHAUSTED');return { recovered:true as const }; }
    const token=randomUUID();
    const repair=(await tx`SELECT * FROM payment_receipt_credential WHERE event_id=${e.id} AND intent_id=${i.id}
      AND provider=${i.provider} AND account_ref=${i.account_ref} AND mode=${i.mode} ORDER BY attempt_before DESC LIMIT 1`)[0];
    await tx`UPDATE payment_receipt_job SET state='RUNNING',attempts=attempts+1,lease_token=${token},lease_until=clock_timestamp()+interval '60 seconds',error_code=NULL,updated_at=clock_timestamp() WHERE event_id=${e.id}`;
    await tx`INSERT INTO payment_receipt_attempt(id,event_id,number,credential_repair_id) VALUES (${token},${e.id},${j.attempts+1},${repair?.id ?? null})`;
    return { recovered:false as const,e,i,token,number:j.attempts+1,adapter,repair,limit:j.attempt_limit,receipt:context.receipt! };
  });
  if(!claim)return false;if(claim.recovered)return true;
  let snapshot:CheckoutSnapshot|null=null;let error:PaymentCheckoutError|null=null;
  // Historical confirmation is independent of requester expiry, reassignment, disabled Branch or rotated credentials.
  try {
    const credentials=claim.repair ? JSON.parse(openOpaque('payment-receipt-repair:'+claim.repair.id,{ ciphertext:claim.repair.ciphertext,nonce:claim.repair.nonce,
      authTag:claim.repair.auth_tag,keyVersion:claim.repair.key_version })) : historicalPaymentCredentials(claim.i);
    const orderId=claim.receipt.lookupResourceId ?? claim.receipt.resourceId;
    snapshot=await claim.adapter.retrieve(claim.i.config_snapshot,credentials,checkoutInput(claim.i),orderId,claim.receipt.resourceId);
    if(snapshot.sessionId!==orderId || snapshot.intentId!==claim.i.id || snapshot.mode!==claim.i.mode || snapshot.minor!==claim.i.minor
      || snapshot.currency!==claim.i.currency || (snapshot.paymentStatus==='PAID' && (snapshot.status!=='COMPLETE' || !snapshot.paymentRef)))
      throw new PaymentCheckoutError('PAYMENT_SESSION_MISMATCH','REJECTED');
  }catch(e) { snapshot=null;error=e instanceof PaymentCheckoutError ? e : new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE','RETRYABLE'); }
  await db.begin(async(tx)=> {
    const j=(await tx`SELECT * FROM payment_receipt_job WHERE event_id=${claim.e.id} FOR UPDATE`)[0]!;
    if(j.state!=='RUNNING' || j.lease_token!==claim.token)return;
    if(!snapshot) {
      const retry=error!.certainty!=='REJECTED' && claim.number<claim.limit;
      await tx`UPDATE payment_receipt_attempt SET state=${retry ? 'RETRYABLE' : 'REJECTED'},error_code=${error!.code},finished_at=clock_timestamp() WHERE id=${claim.token}`;
      await completeJob(tx,claim.e.id,retry ? 'RETRY' : 'NEEDS_ATTENTION',error!.code,Math.max(Math.min(60000,2000*2**Math.min(claim.number-1,30)),(error!.retryAfterSeconds ?? 0)*1000));return;
    }
    // Serialize all receipts for an intent before any Payment/Enrollment transition.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'payment-confirmation:'+claim.i.id},0))`;
    const ack=(await tx`SELECT session_id FROM payment_checkout_ack WHERE intent_id=${claim.i.id}`)[0];
    if(ack && ack.session_id!==snapshot.sessionId) {
      await tx`UPDATE payment_receipt_attempt SET state='REJECTED',error_code='PAYMENT_SESSION_MISMATCH',finished_at=clock_timestamp() WHERE id=${claim.token}`;
      await completeJob(tx,claim.e.id,'NEEDS_ATTENTION','PAYMENT_SESSION_MISMATCH');return;
    }
    await tx`INSERT INTO payment_confirmation(event_id,intent_id,attempt_id,session_id,provider,account_ref,mode,minor,currency,session_status,payment_status,payment_ref,provider_evidence)
      VALUES (${claim.e.id},${claim.i.id},${claim.token},${snapshot.sessionId},${claim.i.provider},${claim.i.account_ref},${claim.i.mode},${snapshot.minor},${snapshot.currency},${snapshot.status},${snapshot.paymentStatus},${snapshot.paymentRef},${snapshot.providerEvidence ? tx.json(snapshot.providerEvidence) : null})`;
    const { state,change }=await persistPaymentState(tx,claim.i,snapshot,claim.receipt.kind,{ source:'SIGNED_RECEIPT',id:claim.e.id });
    await tx`UPDATE payment_receipt_attempt SET state='VERIFIED',finished_at=clock_timestamp() WHERE id=${claim.token}`;
    await completeJob(tx,claim.e.id,'PROCESSED',null);
    await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
      VALUES (${claim.i.organization_id},${claim.i.branch_id},NULL,'PAYMENT_RECEIPT_VERIFIED','PAYMENT_LINK',${claim.i.id},${tx.json({ eventId:claim.e.id,state,changed:change,
        receiptProfile:claim.receipt.profileId,receiptSchemaVersion:claim.receipt.schemaVersion })})`;
  });return true;
}
