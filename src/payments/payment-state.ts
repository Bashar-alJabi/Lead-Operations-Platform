import type postgres from 'postgres';
import type { CheckoutSnapshot } from './checkout-provider.js';
import { paymentConfirmationTransition,type PaymentState } from './confirmation-policy.js';
import type { PaymentReceiptKind } from './receipt-provider.js';
export type PaymentProofReference={ source:'SIGNED_RECEIPT'|'INDEPENDENT_READ';id:string };

// The proof must already exist in the same transaction; native guards enforce its identity and money.
// Providers share the Payment/Enrollment domain transition without sharing authenticity semantics.
export async function persistPaymentState(tx:postgres.TransactionSql,i:postgres.Row,snapshot:CheckoutSnapshot,eventKind:PaymentReceiptKind,proof:PaymentProofReference) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'payment-confirmation:'+i.id},0))`;
  const old=(await tx`SELECT * FROM payment_record WHERE intent_id=${i.id} FOR UPDATE`)[0];
  const { observed:state,apply:change }=paymentConfirmationTransition(snapshot,eventKind,(old?.state ?? null) as PaymentState|null);
  if(change) {
    const signedId=proof.source==='SIGNED_RECEIPT' ? proof.id : null;const readId=proof.source==='INDEPENDENT_READ' ? proof.id : null;
    const row=old ? (await tx`UPDATE payment_record SET state=${state},payment_ref=${state==='CONFIRMED' ? snapshot.paymentRef : null},
      confirmation_event_id=${signedId},independent_confirmation_id=${readId},confirmed_at=CASE WHEN ${state==='CONFIRMED'} THEN
        COALESCE((SELECT verified_at FROM payment_confirmation WHERE event_id=${signedId}),(SELECT verified_at FROM payment_independent_read_confirmation WHERE id=${readId})) ELSE NULL END,
      updated_at=clock_timestamp() WHERE id=${old.id} RETURNING *`)[0]!
      : (await tx`INSERT INTO payment_record(intent_id,provider,account_ref,mode,session_id,state,payment_ref,confirmation_event_id,independent_confirmation_id,confirmed_at)
        VALUES (${i.id},${i.provider},${i.account_ref},${i.mode},${snapshot.sessionId},${state},${state==='CONFIRMED' ? snapshot.paymentRef : null},${signedId},${readId},
          CASE WHEN ${state==='CONFIRMED'} THEN COALESCE((SELECT verified_at FROM payment_confirmation WHERE event_id=${signedId}),
            (SELECT verified_at FROM payment_independent_read_confirmation WHERE id=${readId})) ELSE NULL END) RETURNING *`)[0]!;
    await recordFinancialTransition(tx,i,row);
  }
  return { state,change };
}

async function recordFinancialTransition(tx:postgres.TransactionSql,request:postgres.Row,payment:postgres.Row) {
  await tx`INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES (${request.lead_id},NULL,'PAYMENT_STATE_CHANGED',
    ${tx.json({ ...(request.provider ? { intentId:request.id } : { bankRequestId:request.id }),paymentId:payment.id,state:payment.state,amount:request.amount,currency:request.currency })})`;
  if(payment.state==='CONFIRMED') {
    const enrollment=(await tx`INSERT INTO enrollment(lead_id,payment_id) VALUES (${request.lead_id},${payment.id}) RETURNING id`)[0]!;
    await tx`INSERT INTO lead_activity(lead_id,actor_user_id,event_type,detail) VALUES (${request.lead_id},NULL,'ENROLLMENT_CONFIRMED',
      ${tx.json({ enrollmentId:enrollment.id,paymentId:payment.id })})`;
  }
}

export async function persistBankPaymentState(tx:postgres.TransactionSql,request:postgres.Row,proofId:string) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'bank-confirmation:'+request.id},0))`;
  const old=(await tx`SELECT id FROM payment_record WHERE bank_request_id=${request.id} FOR UPDATE`)[0];
  if(old)return old.id as string;
  const row=(await tx`INSERT INTO payment_record(bank_request_id,bank_confirmation_id,provider,account_ref,mode,session_id,state,payment_ref,confirmed_at)
    SELECT ${request.id},f.id,'BANK_TRANSFER',${request.account_id},${request.mode},${request.id},'CONFIRMED',f.transaction_id,f.verified_at
    FROM bank_transfer_confirmation f WHERE f.id=${proofId} AND f.request_id=${request.id} RETURNING *`)[0];
  if(!row)throw new Error('BANK_PAYMENT_PROOF_REQUIRED');
  await recordFinancialTransition(tx,request,row);return row.id as string;
}
