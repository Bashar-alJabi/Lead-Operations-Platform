import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from './db.js';
import { currentPaymentSession } from './payments/access.js';
import { HttpError, principalFromRequest, requireRole } from './security.js';

async function lockLeadScope(tx: postgres.TransactionSql, source: {branch_id:string;lead_id:string;campaign_id:string}) {
  await tx`SELECT id FROM branch WHERE id=${source.branch_id} FOR SHARE`;
  await tx`SELECT id FROM lead WHERE id=${source.lead_id} FOR SHARE`;
  await tx`SELECT id FROM campaign WHERE id=${source.campaign_id} FOR SHARE`;
}

export async function processOneLeadAttentionNotification(db: Database): Promise<boolean> {
  const candidates = await db`SELECT s.id,s.branch_id,s.lead_id,s.campaign_id FROM lead_attention_queue q
    JOIN lead_attention_transition s ON s.id=q.source_id
    WHERE q.state='WAITING' AND q.run_at<=clock_timestamp() ORDER BY q.run_at,q.source_id LIMIT 25`;
  for (const source of candidates) {
    const handled = await db.begin(async tx => {
      await tx`SET LOCAL lock_timeout='750ms'`;
      await tx`SET LOCAL statement_timeout='5s'`;
      await lockLeadScope(tx, {branch_id:source.branch_id,lead_id:source.lead_id,campaign_id:source.campaign_id});
      const [job] = await tx`SELECT source_id FROM lead_attention_queue WHERE source_id=${source.id}
        AND state='WAITING' AND run_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`;
      if (!job) return false;
      try {
        await tx.savepoint(async page => {
          await page`UPDATE lead_attention_queue SET version=version+1,operation='PUBLISH' WHERE source_id=${source.id}`;
        });
      } catch {
        await tx`UPDATE lead_attention_queue SET version=version+1,operation='FAILURE' WHERE source_id=${source.id}`;
      }
      return true;
    });
    if (handled) return true;
  }
  return false;
}

export function registerLeadAttentionRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/notifications/lead-attention/failures', async request => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    return db.begin(async tx => {
      if (!await currentPaymentSession(tx,actor,request)) throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
      const items = await tx`SELECT s.id,s.lead_id AS "leadId",s.reason_code AS "reasonCode",q.version,q.changed_at AS "changedAt"
        FROM lead_attention_queue q JOIN lead_attention_transition s ON s.id=q.source_id WHERE q.state='DEAD_LETTER'
        AND s.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR s.branch_id=${actor.branchId})
        AND lead_attention_scope(s.id) ORDER BY q.changed_at DESC,s.id LIMIT 25`;
      return {items};
    });
  });
  app.post<{Params:{id:string};Body:{version:number}}>('/api/notifications/lead-attention/failures/:id/retry',{
    schema:{
      params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}},
      body:{type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1}}},
    },
  }, async request => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    return db.begin(async tx => {
      const id = request.params.id;
      const [source] = await tx`SELECT branch_id,lead_id,campaign_id FROM lead_attention_transition WHERE id=${id}
        AND organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId})`;
      if (!source) throw new HttpError(404,'LEAD_ATTENTION_NOT_FOUND');
      await lockLeadScope(tx,{branch_id:source.branch_id,lead_id:source.lead_id,campaign_id:source.campaign_id});
      const [job] = await tx`SELECT state,version,lead_attention_scope(source_id) AS allowed FROM lead_attention_queue
        WHERE source_id=${id} FOR UPDATE`;
      const session = await currentPaymentSession(tx,actor,request);
      if (!session) throw new HttpError(403,'NOTIFICATION_ACCESS_REVOKED');
      if (!job?.allowed || job.state!=='DEAD_LETTER' || job.version!==request.body.version)
        throw new HttpError(409,'LEAD_ATTENTION_NOT_RETRYABLE');
      await tx`UPDATE lead_attention_queue SET version=version+1,operation='RETRY',actor_id=${actor.id},session_id=${session}
        WHERE source_id=${id}`;
      return {state:'WAITING'};
    });
  });
}
