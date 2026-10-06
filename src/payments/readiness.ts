import type postgres from 'postgres';
import type { Database } from '../db.js';
// Used inside bounded Method queries; readiness is derived from current endpoint proof, never stale auth-probe flags.
export function paymentMethodReadinessSql(sql:Database|postgres.TransactionSql) {
  return sql`c.version AS connection_version,EXISTS(SELECT 1 FROM payment_webhook w WHERE w.connection_id=c.id
    AND w.connection_version=c.version AND w.mode=c.config->>'mode' AND w.state='CONFIGURED' AND w.last_signed_at IS NOT NULL
    AND (SELECT p.state FROM payment_webhook_probe p WHERE p.webhook_id=w.id ORDER BY p.probe_number DESC LIMIT 1)='VERIFIED') AS webhook_ready`;
}
