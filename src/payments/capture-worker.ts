import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { paypalOrdersAdapter,type PayPalOrderSnapshot } from './paypal-orders.js';
import { PaymentCheckoutError } from './provider-errors.js';
import { checkoutInput,dispatchIssue,historicalPaymentCredentials,paymentDbClock } from './dispatch-worker.js';
import { paymentAttemptUncertain,paymentDispatchWindow,resolvePaymentAttempt,type PaymentAttemptEvidence,type PaymentDispatchPolicy } from './dispatch-policy.js';
import type { PaymentCredentials } from './providers.js';
export type PaymentCaptureAdapter=Pick<typeof paypalOrdersAdapter,'capture'|'idempotencyRetentionMs'>;
export type PaymentCaptureAdapters=Readonly<Record<string,PaymentCaptureAdapter>>;
export const paymentCaptureAdapters:PaymentCaptureAdapters={ PAYPAL:paypalOrdersAdapter };
export function captureActorIntent(i:postgres.Row,a:postgres.Row):postgres.Row {
  return { ...i,requester_id:a.actor_user_id,requester_session_id:a.actor_session_id,requester_role:a.actor_role,
    requester_branch_id:a.actor_branch_id,assigned_agent_id:a.assigned_agent_id };
}
async function history(tx:postgres.TransactionSql,id:string):Promise<PaymentAttemptEvidence[]> {
  // Explicit reauthorization may resume a pre-write approval denial without erasing its historical rejection.
  return (await tx`SELECT number,CASE WHEN state='REJECTED' AND error_code='PAYMENT_APPROVAL_REQUIRED' THEN 'RETRYABLE' ELSE state END AS state
    FROM payment_capture_attempt WHERE intent_id=${id} ORDER BY number`) as unknown as PaymentAttemptEvidence[];
}
async function finish(tx:postgres.TransactionSql,i:postgres.Row,state:string,code:string|null,runAfterMs:number|null=null) {
  await tx`UPDATE payment_capture_job SET state=${state},error_code=${code},lease_token=NULL,lease_until=NULL,
    run_after=CASE WHEN ${runAfterMs}::bigint IS NULL THEN run_after ELSE to_timestamp(${runAfterMs}::double precision/1000) END,
    updated_at=clock_timestamp() WHERE intent_id=${i.id}`;
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
    VALUES (${i.organization_id},${i.branch_id},NULL,'PAYMENT_CAPTURE_STATE','PAYMENT_LINK',${i.id},${tx.json({ state,errorCode:code })})`;
}
async function release(tx:postgres.TransactionSql,i:postgres.Row,token:string) {
  await tx`UPDATE payment_merchant_lease SET token=NULL,expires_at=NULL WHERE provider=${i.provider} AND account_ref=${i.account_ref} AND mode=${i.mode} AND token=${token}`;
}
export async function processOnePaymentCapture(db:Database,adapters:PaymentCaptureAdapters=paymentCaptureAdapters):Promise<boolean> {
  const claim=await db.begin(async(tx)=> {
    const j=(await tx`SELECT j.* FROM payment_capture_job j JOIN payment_link_intent i ON i.id=j.intent_id
      WHERE (j.state IN ('QUEUED','RETRY') AND j.run_after<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM payment_merchant_lease m
        WHERE m.provider=i.provider AND m.account_ref=i.account_ref AND m.mode=i.mode AND m.token IS NOT NULL AND m.expires_at>clock_timestamp()))
        OR (j.state='RUNNING' AND j.lease_until<=clock_timestamp()) ORDER BY j.run_after,j.intent_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`)[0];
    if(!j)return null;
    const i=(await tx`SELECT * FROM payment_link_intent WHERE id=${j.intent_id}`)[0]!;
    if(j.state==='RUNNING') {
      await tx`UPDATE payment_capture_attempt SET state='INTERRUPTED',error_code='PAYMENT_WORKER_INTERRUPTED',finished_at=clock_timestamp() WHERE id=${j.lease_token} AND state='RUNNING'`;
      const resolution=resolvePaymentAttempt({ nowMs:await paymentDbClock(tx),firstDispatchMs:Number(j.first_dispatch_ms),history:await history(tx,i.id),policy:j.policy });
      await release(tx,i,j.lease_token);await finish(tx,i,resolution.state,resolution.reason,resolution.state==='RETRY' ? resolution.runAfterMs : null);
      return { recovered:true as const };
    }
    const evidence=await history(tx,i.id);const adapter=adapters[i.provider];
    if(!adapter) { await finish(tx,i,'BLOCKED','PAYMENT_CAPTURE_UNSUPPORTED');return { recovered:true as const }; }
    if((await tx`SELECT id FROM payment_record WHERE intent_id=${i.id} AND state='CONFIRMED'`).length) {
      await finish(tx,i,'NEEDS_ATTENTION','PAYMENT_CAPTURE_RECONCILED_RECEIPT');return { recovered:true as const };
    }
    const a=(await tx`SELECT * FROM payment_capture_authorization WHERE id=${j.authorization_id}`)[0]!;
    const issue=await dispatchIssue(tx,captureActorIntent(i,a));
    if(issue || !(await tx`SELECT payment_capture_authorized(${i.id},${a.id}) AS allowed`)[0]!.allowed) {
      await finish(tx,i,'BLOCKED',issue ?? 'PAYMENT_ACCESS_REVOKED');return { recovered:true as const };
    }
    const policy:PaymentDispatchPolicy=j.policy ?? { maxAttempts:5,retentionMs:adapter.idempotencyRetentionMs,dispatchBudgetMs:30000,retryBaseMs:2000,retryMaxMs:60000 };
    const window=paymentDispatchWindow({ nowMs:await paymentDbClock(tx),firstDispatchMs:j.first_dispatch_ms===null ? null : Number(j.first_dispatch_ms),history:evidence,policy });
    if(!window.allowed) { await finish(tx,i,paymentAttemptUncertain(evidence) ? 'NEEDS_ATTENTION' : 'FAILED',window.reason);return { recovered:true as const }; }
    await tx`INSERT INTO payment_merchant_lease(provider,account_ref,mode) VALUES (${i.provider},${i.account_ref},${i.mode}) ON CONFLICT DO NOTHING`;
    if(!(await tx`SELECT token FROM payment_merchant_lease WHERE provider=${i.provider} AND account_ref=${i.account_ref} AND mode=${i.mode}
      AND (token IS NULL OR expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED`).length)return null;
    let credentials:PaymentCredentials;
    try { credentials=historicalPaymentCredentials(i); }
    catch { await finish(tx,i,'BLOCKED','PAYMENT_CREDENTIALS_INVALID');return { recovered:true as const }; }
    const token=randomUUID();
    await tx`UPDATE payment_merchant_lease SET token=${token},expires_at=clock_timestamp()+interval '60 seconds' WHERE provider=${i.provider} AND account_ref=${i.account_ref} AND mode=${i.mode}`;
    await tx`UPDATE payment_capture_job SET state='RUNNING',lease_token=${token},lease_until=clock_timestamp()+interval '60 seconds',
      first_dispatch_ms=COALESCE(first_dispatch_ms,${await paymentDbClock(tx)}),policy=COALESCE(policy,${tx.json(policy)}),error_code=NULL,updated_at=clock_timestamp() WHERE intent_id=${i.id}`;
    await tx`INSERT INTO payment_capture_attempt(id,intent_id,authorization_id,number) VALUES (${token},${i.id},${a.id},${evidence.length+1})`;
    return { recovered:false as const,i,j,token,credentials,adapter };
  });
  if(!claim)return false;if(claim.recovered)return true;
  let result:{ order:PayPalOrderSnapshot;writePerformed:boolean }|null=null;let error:PaymentCheckoutError|null=null;
  try { result=await claim.adapter.capture(claim.i.config_snapshot,claim.credentials,checkoutInput(claim.i),claim.j.order_id); }
  catch(e) { error=e instanceof PaymentCheckoutError ? e : new PaymentCheckoutError('PAYMENT_PROVIDER_UNAVAILABLE','UNKNOWN'); }
  await db.begin(async(tx)=> {
    const j=(await tx`SELECT * FROM payment_capture_job WHERE intent_id=${claim.i.id} FOR UPDATE`)[0]!;
    if(j.state!=='RUNNING' || j.lease_token!==claim.token)return;
    if(result?.order.capture) {
      await tx`INSERT INTO payment_capture_ack(intent_id,attempt_id,order_id,capture_id,capture_status,write_performed)
        VALUES (${claim.i.id},${claim.token},${result.order.orderId},${result.order.capture.id},${result.order.capture.status},${result.writePerformed})`;
      await tx`UPDATE payment_capture_attempt SET state='ACKNOWLEDGED',finished_at=clock_timestamp() WHERE id=${claim.token}`;
      await finish(tx,claim.i,'ACCEPTED',null);
      await tx`INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES (${claim.i.lead_id},NULL,'PAYMENT_CAPTURE_ACCEPTED',${tx.json({ intentId:claim.i.id })})`;
    }else {
      error ??=new PaymentCheckoutError('PAYMENT_CAPTURE_MISMATCH','UNKNOWN');
      await tx`UPDATE payment_capture_attempt SET state=${error.certainty},error_code=${error.code},finished_at=clock_timestamp() WHERE id=${claim.token}`;
      if(error.code==='PAYMENT_APPROVAL_REQUIRED') {
        await finish(tx,claim.i,'BLOCKED',error.code);await release(tx,claim.i,claim.token);return;
      }
      const resolution=resolvePaymentAttempt({ nowMs:await paymentDbClock(tx),firstDispatchMs:Number(j.first_dispatch_ms),history:await history(tx,claim.i.id),policy:j.policy },error.retryAfterSeconds);
      await finish(tx,claim.i,resolution.state,resolution.reason ?? error.code,resolution.state==='RETRY' ? resolution.runAfterMs : null);
    }
    await release(tx,claim.i,claim.token);
  });return true;
}
