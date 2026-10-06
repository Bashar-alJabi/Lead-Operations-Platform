import type { PaymentConfig } from './providers.js';
export type PaymentReceiptKind='RESOURCE_UPDATED'|'PAYMENT_FAILED'|'UNSUPPORTED';
export type PaymentReceiptEnvelope={ schemaVersion:1;profileId:string;externalId:string;eventType:string;mode:PaymentConfig['mode'];
  resourceId:string;resourceType:string;kind:PaymentReceiptKind;resourceKind:'HOSTED_CHECKOUT'|'UNSUPPORTED';intentHint:string|null };
// Decoding grants no authenticity or financial authority. Only a stored verified receipt enters the caller.
export interface PaymentReceiptAdapter { decode(raw:Buffer,mode:PaymentConfig['mode']):PaymentReceiptEnvelope }
export type PaymentReceiptAdapters=Readonly<Record<string,PaymentReceiptAdapter>>;
export class PaymentReceiptError extends Error {
  constructor(readonly code:'PAYMENT_RECEIPT_PROFILE_UNSUPPORTED'|'PAYMENT_RECEIPT_CONTENT_INVALID') { super(code); }
}
export function checkedPaymentReceipt(adapter:PaymentReceiptAdapter|undefined,raw:Buffer,expected:{ externalId:string;eventType:string;mode:PaymentConfig['mode'];resourceId:string;resourceType:string }):PaymentReceiptEnvelope {
  if(!adapter)throw new PaymentReceiptError('PAYMENT_RECEIPT_PROFILE_UNSUPPORTED');
  try {
    if(raw.length>65536)throw new Error('invalid');const r=adapter.decode(raw,expected.mode);
    if(!r || r.schemaVersion!==1 || typeof r.profileId!=='string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(r.profileId)
      || r.externalId!==expected.externalId || r.eventType!==expected.eventType || r.mode!==expected.mode
      || r.resourceId!==expected.resourceId || r.resourceType!==expected.resourceType
      || !['RESOURCE_UPDATED','PAYMENT_FAILED','UNSUPPORTED'].includes(r.kind)
      || (r.kind==='UNSUPPORTED' ? r.resourceKind!=='UNSUPPORTED' || r.intentHint!==null : r.resourceKind!=='HOSTED_CHECKOUT')
      || (r.intentHint!==null && (typeof r.intentHint!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.intentHint))))throw new Error('invalid');
    // Drop undeclared adapter metadata/claims rather than returning provider data to application services.
    return { schemaVersion:1,profileId:r.profileId,externalId:r.externalId,eventType:r.eventType,mode:r.mode,resourceId:r.resourceId,
      resourceType:r.resourceType,kind:r.kind,resourceKind:r.resourceKind,intentHint:r.intentHint };
  }catch { throw new PaymentReceiptError('PAYMENT_RECEIPT_CONTENT_INVALID'); }
}
