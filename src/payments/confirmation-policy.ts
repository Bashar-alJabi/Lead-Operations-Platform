import type { CheckoutSnapshot } from './checkout-provider.js';
import type { PaymentReceiptKind } from './receipt-provider.js';
export type PaymentState='PENDING'|'FAILED'|'EXPIRED'|'CONFIRMED';
// Only independent provider proof, reached through a verified receipt or a guarded read job, may call this transition.
export function paymentConfirmationTransition(snapshot:CheckoutSnapshot,eventKind:PaymentReceiptKind,current:PaymentState|null) {
  if(eventKind==='UNSUPPORTED')throw new Error('PAYMENT_EVENT_UNSUPPORTED');
  if(eventKind==='APPROVAL_REQUIRED')throw new Error('PAYMENT_CAPTURE_CONFIRMATION_REQUIRED');
  if(snapshot.paymentStatus==='PAID' && (snapshot.status!=='COMPLETE' || !snapshot.paymentRef))throw new Error('PAYMENT_PAID_PROOF_INVALID');
  const observed:PaymentState=snapshot.paymentStatus==='PAID' ? 'CONFIRMED' : snapshot.status==='EXPIRED' ? 'EXPIRED'
    : snapshot.status==='COMPLETE' && eventKind==='PAYMENT_FAILED' ? 'FAILED' : 'PENDING';
  const apply=current===null || (current!=='CONFIRMED' && (observed==='CONFIRMED' || (current==='PENDING' && observed!=='PENDING')));
  return { observed,apply };
}
