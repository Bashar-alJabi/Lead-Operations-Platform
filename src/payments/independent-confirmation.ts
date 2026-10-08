import type postgres from 'postgres';
import type { CheckoutSnapshot } from './checkout-provider.js';
import { persistPaymentState } from './payment-state.js';

// Only an active independent-read attempt may call this boundary. It is never an HTTP claim endpoint.
export async function persistIndependentPaymentConfirmation(tx:postgres.TransactionSql,i:postgres.Row,attemptId:string,snapshot:CheckoutSnapshot) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'payment-confirmation:'+i.id},0))`;
  const proof=(await tx`INSERT INTO payment_independent_read_confirmation(intent_id,attempt_id,session_id,provider,account_ref,mode,minor,currency,session_status,payment_status,payment_ref,provider_evidence)
    VALUES (${i.id},${attemptId},${snapshot.sessionId},${i.provider},${i.account_ref},${i.mode},${snapshot.minor},${snapshot.currency},${snapshot.status},${snapshot.paymentStatus},${snapshot.paymentRef},
      ${snapshot.providerEvidence ? tx.json(snapshot.providerEvidence) : null}) RETURNING id`)[0]!;
  const transition=await persistPaymentState(tx,i,snapshot,'RESOURCE_UPDATED',{ source:'INDEPENDENT_READ',id:proof.id });
  return { ...transition,proofId:proof.id };
}
