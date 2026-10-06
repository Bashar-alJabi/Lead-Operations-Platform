import type { CheckoutSnapshot } from './checkout-provider.js';
import type { PaymentReceiptKind } from './receipt-provider.js';
export type PaymentState='PENDING'|'FAILED'|'EXPIRED'|'CONFIRMED';
// Only a verified receipt plus independent Session retrieval may call this transition.
export function paymentConfirmationTransition(snapshot:CheckoutSnapshot,eventKind:PaymentReceiptKind,current:PaymentState|null) {
  if(eventKind==='UNSUPPORTED')throw new Error('PAYMENT_EVENT_UNSUPPORTED');
  if(snapshot.paymentStatus==='PAID' && (snapshot.status!=='COMPLETE' || !snapshot.paymentRef))throw new Error('PAYMENT_PAID_PROOF_INVALID');
  const observed:PaymentState=snapshot.paymentStatus==='PAID' ? 'CONFIRMED' : snapshot.status==='EXPIRED' ? 'EXPIRED'
    : snapshot.status==='COMPLETE' && eventKind==='PAYMENT_FAILED' ? 'FAILED' : 'PENDING';
  const apply=current===null || (current!=='CONFIRMED' && (observed==='CONFIRMED' || (current==='PENDING' && observed!=='PENDING')));
  return { observed,apply };
}
