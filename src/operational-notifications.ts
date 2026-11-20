import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from './db.js';
import { currentPaymentSession } from './payments/access.js';
import { HttpError, principalFromRequest, requireRole } from './security.js';

type Scope = { connection_id: string | null; branch_id: string | null; lead_id: string | null; campaign_id: string | null };

async function lockScope(tx: postgres.TransactionSql, scope: Scope) {
  if (scope.connection_id) await tx`SELECT id FROM integration_connection WHERE id=${scope.connection_id} FOR SHARE`;
  if (scope.branch_id) await tx`SELECT id FROM branch WHERE id=${scope.branch_id} FOR SHARE`;
  if (scope.lead_id) await tx`SELECT id FROM lead WHERE id=${scope.lead_id} FOR SHARE`;
  if (scope.campaign_id) await tx`SELECT id FROM campaign WHERE id=${scope.campaign_id} FOR SHARE`;
}

export async function processOneOperationalNotification(db: Database): Promise<boolean> {
  const candidates = await db<(Scope & { id: string })[]>`SELECT s.id,s.connection_id,s.branch_id,l.lead_id,l.campaign_id
    FROM operational_notification_queue q JOIN operational_notification_source s ON s.id=q.source_id
    LEFT JOIN lead_attention_transition l ON l.id=s.lead_attention_source_id
    WHERE q.state='WAITING' AND q.run_at<=statement_timestamp() ORDER BY q.run_at,q.source_id LIMIT 25`;
  for (const source of candidates) {
    const handled = await db.begin(async tx => {
      await tx`SET LOCAL lock_timeout='750ms'`;
      await tx`SET LOCAL statement_timeout='5s'`;
      await lockScope(tx, source);
      const [job] = await tx`SELECT source_id FROM operational_notification_queue WHERE source_id=${source.id}
        AND state='WAITING' AND run_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`;
      if (!job) return false;
      try {
        await tx.savepoint(async step => {
          await step`UPDATE operational_notification_queue SET version=version+1,operation='PUBLISH' WHERE source_id=${source.id}`;
        });
      } catch {
        await tx`UPDATE operational_notification_queue SET version=version+1,operation='FAILURE' WHERE source_id=${source.id}`;
      }
      return true;
    });
    if (handled) return true;
  }
  return false;
}

export function registerOperationalNotificationRoutes(app: FastifyInstance, db: Database) {
  const path = '/api/notifications/operational/failures';
  app.get(path, async request => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    return db.begin(async tx => {
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'NOTIFICATION_ACCESS_REVOKED');
      const items = await tx`SELECT s.id,s.event_type AS "eventType",q.version,q.changed_at AS "changedAt"
        FROM operational_notification_queue q JOIN operational_notification_source s ON s.id=q.source_id
        WHERE q.state='DEAD_LETTER' AND s.organization_id=${actor.organizationId}
          AND (${actor.role==='SUPER_ADMIN'} OR s.branch_id=${actor.branchId})
          AND operational_notification_scope(s.id) ORDER BY q.changed_at DESC,q.source_id LIMIT 25`;
      return { items };
    });
  });
  app.post<{Params:{id:string};Body:{version:number}}>(path+'/:id/retry', {
    schema: {
      params: {type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}},
      body: {type:'object',additionalProperties:false,required:['version'],properties:{version:{type:'integer',minimum:1}}},
    },
  }, async request => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    return db.begin(async tx => {
      const { id } = request.params;
      const [source] = await tx<Scope[]>`SELECT s.connection_id,s.branch_id,l.lead_id,l.campaign_id FROM operational_notification_source s
        LEFT JOIN lead_attention_transition l ON l.id=s.lead_attention_source_id
        WHERE s.id=${id} AND s.organization_id=${actor.organizationId}
          AND (${actor.role==='SUPER_ADMIN'} OR s.branch_id=${actor.branchId})`;
      if (!source) throw new HttpError(404, 'OPERATIONAL_NOTIFICATION_NOT_FOUND');
      await lockScope(tx, source);
      const [job] = await tx`SELECT state,version,operational_notification_scope(source_id) AS allowed
        FROM operational_notification_queue WHERE source_id=${id} FOR UPDATE`;
      const session = await currentPaymentSession(tx, actor, request);
      if (!session) throw new HttpError(403, 'NOTIFICATION_ACCESS_REVOKED');
      if (!job?.allowed) throw new HttpError(404, 'OPERATIONAL_NOTIFICATION_NOT_FOUND');
      if (job.state!=='DEAD_LETTER' || job.version!==request.body.version)
        throw new HttpError(409, 'OPERATIONAL_NOTIFICATION_NOT_RETRYABLE');
      await tx`UPDATE operational_notification_queue SET version=version+1,operation='RETRY',actor_id=${actor.id},session_id=${session}
        WHERE source_id=${id}`;
      return { state: 'WAITING' };
    });
  });
}
