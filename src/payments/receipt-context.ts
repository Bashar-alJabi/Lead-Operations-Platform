import type postgres from 'postgres';
import { openOpaque } from '../credentials.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function paymentReceiptIntent(tx:postgres.TransactionSql,e:postgres.Row) {
  let hint:string|null=null;
  try { const raw=JSON.parse(openOpaque('payment-event:'+e.id,{ ciphertext:e.ciphertext,nonce:e.nonce,authTag:e.auth_tag,keyVersion:e.key_version }));
    const candidate=raw?.data?.object?.metadata?.platform_intent_id;if(typeof candidate==='string' && uuid.test(candidate))hint=candidate;
  }catch { return { intent:null,issue:'PAYMENT_RECEIPT_CONTENT_INVALID' }; }
  // This lookup grants no financial authority. Provider retrieval must still prove account/session/intent/money.
  const rows=await tx`SELECT i.* FROM payment_link_intent i LEFT JOIN payment_checkout_ack a ON a.intent_id=i.id
    WHERE i.connection_id=${e.connection_id} AND i.mode=${e.mode} AND (a.session_id=${e.object_id} OR i.id=${hint}::uuid)
    AND EXISTS(SELECT 1 FROM payment_dispatch_attempt d WHERE d.intent_id=i.id) LIMIT 2`;
  return rows.length===1 ? { intent:rows[0]!,issue:null } : { intent:null,issue:rows.length ? 'PAYMENT_RECEIPT_AMBIGUOUS' : 'PAYMENT_RECEIPT_UNMATCHED' };
}
