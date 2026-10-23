import assert from 'node:assert/strict';
import type {Database} from '../src/db.js';
// Called by the real financial adapter workflows after their duplicate/failure/out-of-order scenarios.
export async function assertFinancialNotifications(db:Database){
 const payments=await db`SELECT p.id,count(e.id)::int AS notices FROM payment_record p LEFT JOIN notification_event e ON e.payment_id=p.id AND e.event_type='PAYMENT_CONFIRMED'
  WHERE p.state='CONFIRMED' GROUP BY p.id`;
 assert.ok(payments.length>0);assert.ok(payments.every(p=>p.notices===1));
 const enrollments=await db`SELECT en.id,count(e.id)::int AS notices FROM enrollment en LEFT JOIN notification_event e ON e.enrollment_id=en.id AND e.event_type='ENROLLMENT_CONFIRMED' GROUP BY en.id`;
 assert.ok(enrollments.length>0);assert.ok(enrollments.every(e=>e.notices===1));
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_event e JOIN payment_record p ON p.id=e.payment_id WHERE e.event_type='PAYMENT_CONFIRMED' AND p.state<>'CONFIRMED'`)[0]!.n,0);
}
