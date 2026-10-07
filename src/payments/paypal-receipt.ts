import { parsePayPalPaymentReceipt } from './paypal-webhook.js';
import type { PaymentReceiptAdapter,PaymentReceiptKind } from './receipt-provider.js';
const resourceId=/^[A-Z0-9]{1,36}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const kinds=new Map<string,PaymentReceiptKind>([['CHECKOUT.ORDER.APPROVED','APPROVAL_REQUIRED'],['PAYMENT.CAPTURE.COMPLETED','RESOURCE_UPDATED'],
  ['PAYMENT.CAPTURE.PENDING','RESOURCE_UPDATED'],['PAYMENT.CAPTURE.DECLINED','PAYMENT_FAILED']]);
// Standalone normalization only. Never grants authenticity, payee/money authority or capture permission.
// Financial registry remains disabled until durable capture and native independent-confirmation proofs are integrated.
export const paypalReceiptAdapter:PaymentReceiptAdapter={ decode(raw,mode) {
  const e=parsePayPalPaymentReceipt(raw,mode);const kind=kinds.get(e.type) ?? 'UNSUPPORTED';const resource=JSON.parse(e.raw).resource;
  let lookupResourceId:string|null=null;let intentHint:string|null=null;
  if(kind!=='UNSUPPORTED') {
    if(!resourceId.test(e.objectId))throw new Error('PAYMENT_RECEIPT_CONTENT_INVALID');
    if(kind==='APPROVAL_REQUIRED') {
      lookupResourceId=e.objectId;
      const units=resource.purchase_units;const unit=Array.isArray(units) && units.length===1 ? units[0] : null;
      if(unit && typeof unit.reference_id==='string' && uuid.test(unit.reference_id) && unit.custom_id===unit.reference_id)intentHint=unit.reference_id;
    }else {
      const order=resource.supplementary_data?.related_ids?.order_id;
      if(order!==undefined && (typeof order!=='string' || !resourceId.test(order)))throw new Error('PAYMENT_RECEIPT_CONTENT_INVALID');
      lookupResourceId=order ?? null;
      if(lookupResourceId!==null && typeof resource.custom_id==='string' && uuid.test(resource.custom_id))intentHint=resource.custom_id;
    }
  }
  return { schemaVersion:1,profileId:'paypal-orders-v2',externalId:e.externalId,eventType:e.type,mode:e.mode,resourceId:e.objectId,
    resourceType:e.objectType,kind,resourceKind:kind==='UNSUPPORTED' ? 'UNSUPPORTED' : 'HOSTED_CHECKOUT',lookupResourceId,intentHint };
} };
