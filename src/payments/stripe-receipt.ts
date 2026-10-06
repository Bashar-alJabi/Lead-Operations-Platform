import { parseStripePaymentReceipt } from './webhook.js';
import type { PaymentReceiptAdapter,PaymentReceiptKind } from './receipt-provider.js';
const kinds=new Map<string,PaymentReceiptKind>([['checkout.session.completed','RESOURCE_UPDATED'],
  ['checkout.session.async_payment_succeeded','RESOURCE_UPDATED'],['checkout.session.async_payment_failed','PAYMENT_FAILED'],['checkout.session.expired','RESOURCE_UPDATED']]);
export const stripeReceiptAdapter:PaymentReceiptAdapter={ decode(raw,mode) {
  const e=parseStripePaymentReceipt(raw,mode);const kind=kinds.get(e.type) ?? 'UNSUPPORTED';
  const object=JSON.parse(e.raw).data.object;const candidate=object.metadata?.platform_intent_id;
  const intentHint=kind!=='UNSUPPORTED' && typeof candidate==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate) ? candidate : null;
  return { schemaVersion:1,profileId:'stripe-v1-checkout',externalId:e.externalId,eventType:e.type,mode:e.mode,resourceId:e.objectId,
    resourceType:e.objectType,kind,resourceKind:kind==='UNSUPPORTED' ? 'UNSUPPORTED' : 'HOSTED_CHECKOUT',intentHint };
} };
