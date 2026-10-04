import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, type Principal, requireRole } from '../security.js';
import { type MediaStorage, configuredMediaStorage } from '../media/storage.js';
import { mediaMaxBytes } from '../media/validation.js';

const params = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
async function authorizedAttachment(db: Database, actor: Principal, id: string) {
  const row = (await db`SELECT a.*, ic.organization_id, coalesce(l.branch_id, ic.branch_id) AS branch_id
    FROM message_attachment a JOIN integration_event e ON e.id = a.integration_event_id
    JOIN integration_connection ic ON ic.id = e.connection_id
    LEFT JOIN conversation_message m ON m.attachment_id = a.id
    LEFT JOIN conversation cv ON cv.id = m.conversation_id LEFT JOIN lead l ON l.id = cv.lead_id
    WHERE a.id = ${id} AND ic.organization_id = ${actor.organizationId}
      AND ((m.id IS NOT NULL AND (${actor.role === 'SUPER_ADMIN'}
          OR (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId})
          OR (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id})))
        OR (m.id IS NULL AND (${actor.role === 'SUPER_ADMIN'}
          OR (${actor.role === 'MANAGER'} AND ic.branch_id = ${actor.branchId}))))`)[0];
  if (!row) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND');
  return row;
}
export function publicAttachment(row: Record<string, unknown>) {
  return { id: row.id, state: row.state, mediaKind: row.media_kind, mime: row.mime_type ?? row.declared_mime,
    sizeBytes: row.size_bytes, errorCode: row.last_error_code, version: row.version };
}
export function registerMessagingAttachmentRoutes(app: FastifyInstance, db: Database, storageOption?: MediaStorage) {
  app.get<{ Params: { id: string } }>('/api/messaging/attachments/:id', { schema: { params } }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return publicAttachment(await authorizedAttachment(db, actor, request.params.id));
  });
  app.get<{ Params: { id: string } }>('/api/messaging/attachments/:id/download', {
    schema: { params }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    const row = await authorizedAttachment(db, actor, request.params.id);
    if (row.state !== 'READY') throw new HttpError(409, 'ATTACHMENT_NOT_READY');
    let bytes: Buffer;
    try {
      const storage = storageOption ?? configuredMediaStorage();
      if (storage.backend !== row.storage_backend) throw new Error('Storage mismatch');
      bytes = await storage.get(row.storage_key, mediaMaxBytes());
      if (bytes.length !== row.size_bytes || createHash('sha256').update(bytes).digest('hex') !== row.content_sha256)
        throw new Error('Integrity mismatch');
    } catch { throw new HttpError(503, 'MEDIA_STORAGE_UNAVAILABLE'); }
    await db`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
      VALUES (${actor.organizationId}, ${row.branch_id}, ${actor.id}, 'ATTACHMENT_DOWNLOADED', 'ATTACHMENT', ${row.id})`;
    // Always a download, never inline HTML/SVG/PDF execution in the application's origin.
    const extension: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
      'application/pdf': 'pdf', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4' };
    return reply.type('application/octet-stream').header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="attachment-${row.id}.${extension[row.mime_type] ?? 'bin'}"`)
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Length', bytes.length).send(bytes);
  });
  app.post<{ Params: { id: string }; Body: { version: number; reason: string } }>(
    '/api/messaging/attachments/:id/retry', { schema: { params, body: { type: 'object',
      additionalProperties: false, required: ['version','reason'], properties: {
        version: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 10, maxLength: 1000 },
      } } } }, async (request) => {
      const actor = await principalFromRequest(request, db); requireRole(actor, 'SUPER_ADMIN','MANAGER');
      const row = await authorizedAttachment(db, actor, request.params.id);
      if (request.body.reason.trim().length < 10) throw new HttpError(400, 'REVIEW_REASON_REQUIRED');
      return db.begin(async (tx) => {
        const changed = await tx`UPDATE message_attachment SET state = 'QUEUED', retry_count = 0,
          available_at = now(), last_error_code = NULL, version = version + 1, updated_at = now()
          WHERE id = ${row.id} AND state = 'FAILED' AND version = ${request.body.version} RETURNING *`;
        if (!changed.length) throw new HttpError(409, 'ATTACHMENT_RETRY_CONFLICT');
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
          VALUES (${actor.organizationId}, ${row.branch_id}, ${actor.id}, 'ATTACHMENT_RETRY_REQUESTED',
            'ATTACHMENT', ${row.id}, ${tx.json({ reason: request.body.reason.trim() })})`;
        return publicAttachment(changed[0]!);
      });
    });
}
