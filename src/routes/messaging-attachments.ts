import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, type Principal, requireRole } from '../security.js';
import { type MediaStorage, configuredMediaStorage } from '../media/storage.js';
import { mediaMaxBytes } from '../media/validation.js';
import { MediaError, validateMedia, mediaMimeTypes, type MediaKind } from '../media/validation.js';
import { validateMetaOutboundMedia, metaMediaProfile } from '../media/meta-outbound.js';
import { type MediaScanner, configuredMediaScanner } from '../media/scanner.js';
import { lockOutboundScope } from '../messaging/outbound-policy.js';

const params = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
async function authorizedAttachment(db: Database, actor: Principal, id: string) {
  const row = (await db`SELECT a.*, ic.organization_id, coalesce(l.branch_id, ic.branch_id) AS branch_id
    FROM message_attachment a LEFT JOIN integration_event e ON e.id = a.integration_event_id
    LEFT JOIN conversation_message m ON m.attachment_id = a.id
    LEFT JOIN conversation cv ON cv.id = coalesce(m.conversation_id, a.upload_conversation_id)
    LEFT JOIN lead l ON l.id = cv.lead_id
    JOIN integration_connection ic ON ic.id = coalesce(e.connection_id, cv.connection_id)
    WHERE a.id = ${id} AND ic.organization_id = ${actor.organizationId}
      AND ((cv.id IS NOT NULL AND (${actor.role === 'SUPER_ADMIN'}
          OR (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId})
          OR (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id})))
        OR (cv.id IS NULL AND (${actor.role === 'SUPER_ADMIN'}
          OR (${actor.role === 'MANAGER'} AND ic.branch_id = ${actor.branchId}))))`)[0];
  if (!row) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND');
  return row;
}
export function publicAttachment(row: Record<string, unknown>) {
  return { id: row.id, state: row.state, mediaKind: row.media_kind, mime: row.mime_type ?? row.declared_mime,
    sizeBytes: row.size_bytes, errorCode: row.last_error_code, version: row.version };
}
export function registerMessagingAttachmentRoutes(app: FastifyInstance, db: Database, storageOption?: MediaStorage,
  scannerOption?: MediaScanner) {
  // Uploads are bounded before body parsing; each stateless replica admits at most two scans.
  const uploading = new Set<string>();
  app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    scope.addHook('onRequest', async (request) => {
      const actor = await principalFromRequest(request, db);
      const { conversationId } = request.params as { conversationId: string };
      if (typeof conversationId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(conversationId))
        throw new HttpError(400, 'INVALID_REQUEST');
      const found = await db`SELECT cv.state, l.lifecycle FROM conversation cv JOIN lead l ON l.id = cv.lead_id
        WHERE cv.id = ${conversationId} AND l.organization_id = ${actor.organizationId}
          AND (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId})
            OR (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id}))`;
      if (!found.length) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
      if (found[0]!.state === 'CLOSED' || found[0]!.lifecycle !== 'OPEN') throw new HttpError(409, 'CONVERSATION_NOT_OPEN');
      if (uploading.size >= 2) throw new HttpError(429, 'MEDIA_UPLOAD_BUSY');
      uploading.add(request.id);
    });
    scope.addHook('onResponse', async (request) => { uploading.delete(request.id); });
    scope.post<{ Params: { conversationId: string }; Querystring: { kind: MediaKind; mime: string; key: string } }>(
      '/api/conversations/:conversationId/attachments', { bodyLimit: mediaMaxBytes(), schema: {
        params: { type: 'object', required: ['conversationId'], properties: { conversationId: { type: 'string', format: 'uuid' } } },
        querystring: { type: 'object', additionalProperties: false, required: ['kind','mime','key'], properties: {
          kind: { type: 'string', enum: Object.keys(mediaMimeTypes) }, mime: { type: 'string', maxLength: 100 },
          key: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,128}$' },
        } },
      }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
        const actor = await principalFromRequest(request, db);
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes)) throw new HttpError(400, 'MEDIA_BODY_INVALID');
        const { kind, mime, key } = request.query;
        if (!(mediaMimeTypes[kind] as readonly string[]).includes(mime)) throw new HttpError(400, 'MEDIA_TYPE_UNSUPPORTED');
        const hash = createHash('sha256').update(bytes).digest('hex');
        const existing = (await db`SELECT * FROM message_attachment WHERE upload_conversation_id = ${request.params.conversationId}
          AND uploaded_by = ${actor.id} AND upload_idempotency_key = ${key}`)[0];
        if (existing) {
          if (existing.expected_sha256 !== hash || existing.declared_mime !== mime || existing.media_kind !== kind)
            throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
          return publicAttachment(existing);
        }
        const sender = (await db`SELECT s.capabilities, ic.provider FROM conversation cv
          JOIN messaging_sender s ON s.id = cv.sender_id JOIN integration_connection ic ON ic.id = cv.connection_id
          WHERE cv.id = ${request.params.conversationId}`)[0]!;
        if (!sender.capabilities?.media?.includes(kind)) throw new HttpError(409, 'MEDIA_SEND_NOT_SUPPORTED');
        if (sender.provider !== 'META_WHATSAPP_CLOUD') throw new HttpError(409, 'MEDIA_PROVIDER_NOT_SUPPORTED');
        if (bytes.length > metaMediaProfile.limits[kind]) throw new HttpError(400, 'MEDIA_PROVIDER_SIZE_INVALID');
        const valid = await validateMedia(bytes, kind, mime, hash).catch((error) => {
          throw new HttpError(400, error instanceof MediaError ? error.code : 'MEDIA_TYPE_MISMATCH');
        });
        let scan: { clean: boolean; version: string };
        try { scan = await (scannerOption ?? configuredMediaScanner()).scan(bytes); }
        catch { throw new HttpError(503, 'MEDIA_SCANNER_UNAVAILABLE'); }
        if (!scan.clean) throw new HttpError(422, 'MEDIA_CONTENT_REJECTED');
        await validateMetaOutboundMedia(bytes,kind,mime).catch((error:unknown)=> {
          throw new HttpError(error instanceof MediaError && error.retryable ? 503 : 400,
            error instanceof MediaError ? error.code : 'MEDIA_FORMAT_INVALID');
        });
        const id = randomUUID(); const objectKey = `${id}-${valid.hash}`;
        let storage: MediaStorage;
        try { storage = storageOption ?? configuredMediaStorage(); await storage.put(objectKey, bytes); }
        catch { throw new HttpError(503, 'MEDIA_STORAGE_UNAVAILABLE'); }
        const removeUnused = async () => {
          const referenced = await db`SELECT 1 FROM message_attachment WHERE storage_key = ${objectKey} LIMIT 1`;
          if (!referenced.length) await storage.remove(objectKey);
        };
        const row = await db.begin(async (tx) => {
          const locked = await lockOutboundScope(tx, actor, request.params.conversationId);
          if (locked.conversation.state === 'CLOSED' || locked.scope.lifecycle !== 'OPEN')
            throw new HttpError(409, 'CONVERSATION_NOT_OPEN');
          const currentSender = (await tx`SELECT capabilities FROM messaging_sender
            WHERE id = ${locked.conversation.sender_id} FOR SHARE`)[0]!;
          if (!currentSender.capabilities?.media?.includes(kind)) throw new HttpError(409, 'MEDIA_SEND_NOT_SUPPORTED');
          const created = (await tx`INSERT INTO message_attachment (id, upload_conversation_id, uploaded_by, upload_idempotency_key,
            media_kind, declared_mime, expected_sha256, state, mime_type, size_bytes, content_sha256,
            storage_key, storage_backend, scanner_version, scanned_at)
            VALUES (${id}, ${request.params.conversationId}, ${actor.id}, ${key}, ${kind}, ${mime}, ${hash}, 'READY',
              ${mime}, ${bytes.length}, ${hash}, ${objectKey}, ${storage.backend}, ${scan.version.slice(0,255)}, now())
            ON CONFLICT DO NOTHING RETURNING *`)[0];
          if (!created) {
            const prior = (await tx`SELECT * FROM message_attachment WHERE upload_conversation_id = ${request.params.conversationId}
              AND uploaded_by = ${actor.id} AND upload_idempotency_key = ${key}`)[0]!;
            if (prior.expected_sha256 !== hash || prior.declared_mime !== mime || prior.media_kind !== kind)
              throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
            return prior;
          }
          await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
            VALUES (${actor.organizationId}, ${locked.scope.branch_id}, ${actor.id}, 'OUTBOUND_ATTACHMENT_UPLOADED', 'ATTACHMENT', ${id})`;
          return created;
        }).catch(async (error: unknown) => {
          // Known business rejection rolls back the insert. Unknown commit outcomes keep private bytes for reconciliation.
          if (error instanceof HttpError) await removeUnused().catch(() => {});
          throw error;
        });
        if (row.id !== id) await removeUnused().catch(() => {});
        reply.code(row.id === id ? 201 : 200);
        return publicAttachment(row);
      });
  });
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
