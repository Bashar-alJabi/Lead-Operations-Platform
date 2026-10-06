import type { CheckoutSnapshot } from './checkout-provider.js';
export type PaymentState='PENDING'|'FAILED'|'EXPIRED'|'CONFIRMED';
// Only a verified receipt plus independent Session retrieval may call this transition.
export function paymentConfirmationTransition(snapshot:CheckoutSnapshot,eventType:string,current:PaymentState|null) {
  if(snapshot.paymentStatus==='PAID' && (snapshot.status!=='COMPLETE' || !snapshot.paymentRef))throw new Error('PAYMENT_PAID_PROOF_INVALID');
  const observed:PaymentState=snapshot.paymentStatus==='PAID' ? 'CONFIRMED' : snapshot.status==='EXPIRED' ? 'EXPIRED'
    : snapshot.status==='COMPLETE' && eventType==='checkout.session.async_payment_failed' ? 'FAILED' : 'PENDING';
  const apply=current===null || (current!=='CONFIRMED' && (observed==='CONFIRMED' || (current==='PENDING' && observed!=='PENDING')));
  return { observed,apply };
}
