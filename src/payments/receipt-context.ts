import type postgres from 'postgres';
import { openOpaque } from '../credentials.js';
import { checkedPaymentReceipt,PaymentReceiptError,type PaymentReceiptAdapters,type PaymentReceiptEnvelope } from './receipt-provider.js';
import { paymentReceiptAdapters } from './receipt-adapters.js';
export async function paymentReceiptIntent(tx:postgres.TransactionSql,e:postgres.Row,adapters:PaymentReceiptAdapters=paymentReceiptAdapters) {
  let receipt:PaymentReceiptEnvelope;
  try {
    const c=(await tx`SELECT provider FROM integration_connection WHERE id=${e.connection_id} AND kind='PAYMENT'`)[0];
    const raw=Buffer.from(openOpaque('payment-event:'+e.id,{ ciphertext:e.ciphertext,nonce:e.nonce,authTag:e.auth_tag,keyVersion:e.key_version }));
    receipt=checkedPaymentReceipt(c ? adapters[c.provider] : undefined,raw,{ externalId:e.external_event_id,eventType:e.event_type,
      mode:e.mode,resourceId:e.object_id,resourceType:e.object_type });
  }catch(error) { return { intent:null,issue:error instanceof PaymentReceiptError ? error.code : 'PAYMENT_RECEIPT_CONTENT_INVALID',receipt:null,ignored:false }; }
  if(receipt.kind==='UNSUPPORTED')return { intent:null,issue:'PAYMENT_EVENT_UNSUPPORTED',receipt,ignored:true };
  // Approval is a request for a separately authorized durable capture action, never financial confirmation.
  if(receipt.kind==='APPROVAL_REQUIRED')return { intent:null,issue:'PAYMENT_CAPTURE_REQUIRED',receipt,ignored:false };
  const resourceLookup=receipt.lookupResourceId===undefined ? receipt.resourceId : receipt.lookupResourceId;
  if(resourceLookup===null)return { intent:null,issue:'PAYMENT_RECEIPT_UNMATCHED',receipt,ignored:false };
  // This lookup grants no financial authority. Provider retrieval must still prove account/session/intent/money.
  const rows=await tx`SELECT i.* FROM payment_link_intent i LEFT JOIN payment_checkout_ack a ON a.intent_id=i.id
    WHERE i.connection_id=${e.connection_id} AND i.mode=${receipt.mode} AND (a.session_id=${resourceLookup} OR i.id=${receipt.intentHint}::uuid)
    AND EXISTS(SELECT 1 FROM payment_dispatch_attempt d WHERE d.intent_id=i.id) LIMIT 2`;
  return { intent:rows.length===1 ? rows[0]! : null,issue:rows.length===1 ? null : rows.length ? 'PAYMENT_RECEIPT_AMBIGUOUS' : 'PAYMENT_RECEIPT_UNMATCHED',receipt,ignored:false };
}
