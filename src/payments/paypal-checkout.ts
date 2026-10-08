import { paypalOrdersAdapter, type PayPalOrderSnapshot } from './paypal-orders.js';
import type { CheckoutSnapshot,PaymentCheckoutAdapter } from './checkout-provider.js';
import { PaymentCheckoutError } from './provider-errors.js';
function snapshot(order:PayPalOrderSnapshot):CheckoutSnapshot {
  return { sessionId:order.orderId,url:order.approvalUrl,expiresAt:null,mode:order.mode,currency:order.currency,minor:order.minor,intentId:order.intentId,
    status:order.status==='VOIDED' ? 'EXPIRED' : order.status==='COMPLETED' ? 'COMPLETE' : 'OPEN',paymentStatus:'UNPAID',paymentRef:null };
}
export const paypalCheckoutAdapter:PaymentCheckoutAdapter={ currencyPrecision:paypalOrdersAdapter.currencyPrecision,
  idempotencyRetentionMs:paypalOrdersAdapter.idempotencyRetentionMs,dispatchBudgetMs:20000,
  async create(config,credentials,intent) { return snapshot(await paypalOrdersAdapter.create(config,credentials,intent)); },
  async retrieve(config,credentials,intent,orderId,captureId) {
    if(!captureId)throw new PaymentCheckoutError('PAYMENT_CAPTURE_MISMATCH','REJECTED');
    const evidence=await paypalOrdersAdapter.retrievePayment(config,credentials,intent,orderId,captureId);
    return { sessionId:orderId,url:null,expiresAt:null,mode:config.mode,currency:evidence.currency,minor:evidence.minor,intentId:intent.id,
      status:'COMPLETE',paymentStatus:evidence.paymentStatus,paymentRef:evidence.paymentStatus==='PAID' ? evidence.captureId : null,providerEvidence:{ ...evidence } };
  },
};
