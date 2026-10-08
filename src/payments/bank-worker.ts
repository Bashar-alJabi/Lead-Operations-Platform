import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import { persistBankPaymentState } from './payment-state.js';

export async function processOneBankSettlement(db:Database):Promise<boolean> {
  const claim=await db.begin(async(tx)=> {
    const expired=(await tx`SELECT * FROM bank_settlement_job WHERE state='RUNNING' AND lease_until<=clock_timestamp() ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT 1`)[0];
    if(expired) {
      await tx`INSERT INTO bank_settlement_attempt(id,event_id,number,outcome,error_code) VALUES (${expired.lease_token},${expired.event_id},${expired.attempts},'INTERRUPTED','BANK_LEASE_EXPIRED')`;
      await tx`UPDATE bank_settlement_job SET state=${expired.attempts>=5 ? 'NEEDS_ATTENTION' : 'RETRY'},lease_token=NULL,lease_until=NULL,error_code='BANK_LEASE_EXPIRED',version=version+1,run_after=clock_timestamp() WHERE event_id=${expired.event_id}`;
    }
    const job=(await tx`SELECT * FROM bank_settlement_job WHERE state IN ('QUEUED','RETRY') AND attempts<5 AND run_after<=clock_timestamp()
      ORDER BY run_after,event_id FOR UPDATE SKIP LOCKED LIMIT 1`)[0];if(!job)return null;
    const token=randomUUID();await tx`UPDATE bank_settlement_job SET state='RUNNING',attempts=attempts+1,lease_token=${token},lease_until=clock_timestamp()+interval '30 seconds',version=version+1,error_code=NULL WHERE event_id=${job.event_id}`;
    return { eventId:job.event_id as string,token,number:job.attempts+1 };
  });
  if(!claim)return false;
  try {
    await db.begin(async(tx)=> {
      const job=(await tx`SELECT * FROM bank_settlement_job WHERE event_id=${claim.eventId} AND state='RUNNING' AND lease_token=${claim.token} AND lease_until>clock_timestamp() FOR UPDATE`)[0];if(!job)return;
      const e=(await tx`SELECT *,settled_at::text AS exact_settled_at FROM bank_settlement_event WHERE id=${claim.eventId}`)[0]!;
      const r=(await tx`SELECT * FROM bank_transfer_request WHERE account_id=${e.account_id} AND reference=${e.reference}`)[0];
      let error:string|null=!r ? 'BANK_REQUEST_NOT_FOUND' : null;
      if(r) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'bank-confirmation:'+r.id},0))`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'bank-transaction:'+r.account_id+':'+e.transaction_id},0))`;
        if(r.mode!==e.mode || r.account_identifier!==e.account_identifier || r.amount!==e.amount || r.currency!==e.currency)error='BANK_CONFIRMATION_MISMATCH';
        const old=(await tx`SELECT * FROM bank_transfer_confirmation WHERE account_id=${e.account_id} AND mode=${e.mode} AND transaction_id=${e.transaction_id}`)[0];
        if(old && old.request_id!==r.id)error='BANK_TRANSACTION_ALREADY_USED';
        const current=(await tx`SELECT * FROM bank_transfer_confirmation WHERE request_id=${r.id}`)[0];
        if(current && current.transaction_id!==e.transaction_id)error='BANK_REQUEST_ALREADY_CONFIRMED';
        if(!error) {
          const f=old ?? (await tx`INSERT INTO bank_transfer_confirmation(request_id,source,transaction_id,account_id,mode,account_identifier,reference,amount,minor,currency,settled_at,event_id,lease_token)
            VALUES (${r.id},'TRUSTED_FEED',${e.transaction_id},${e.account_id},${e.mode},${e.account_identifier},${e.reference},${r.amount},${r.minor},${r.currency},${e.exact_settled_at},${e.id},${claim.token}) RETURNING id`)[0]!;
          await persistBankPaymentState(tx,r,f.id);
        }
      }
      await tx`INSERT INTO bank_settlement_attempt(id,event_id,number,outcome,error_code) VALUES (${claim.token},${claim.eventId},${claim.number},${error ? 'NEEDS_ATTENTION' : 'PROCESSED'},${error})`;
      await tx`UPDATE bank_settlement_job SET state=${error ? 'NEEDS_ATTENTION' : 'PROCESSED'},error_code=${error},lease_token=NULL,lease_until=NULL,version=version+1 WHERE event_id=${claim.eventId}`;
    });
  }catch {
    await db.begin(async(tx)=> {
      const job=(await tx`SELECT * FROM bank_settlement_job WHERE event_id=${claim.eventId} AND state='RUNNING' AND lease_token=${claim.token} FOR UPDATE`)[0];if(!job)return;
      const outcome=claim.number>=5 ? 'NEEDS_ATTENTION' : 'RETRY';
      await tx`INSERT INTO bank_settlement_attempt(id,event_id,number,outcome,error_code) VALUES (${claim.token},${claim.eventId},${claim.number},${outcome},'BANK_RECONCILIATION_FAILED')`;
      await tx`UPDATE bank_settlement_job SET state=${outcome},lease_token=NULL,lease_until=NULL,error_code='BANK_RECONCILIATION_FAILED',version=version+1,run_after=clock_timestamp()+interval '10 seconds' WHERE event_id=${claim.eventId}`;
    });
  }
  return true;
}
