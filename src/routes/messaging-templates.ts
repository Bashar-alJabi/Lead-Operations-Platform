import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { openSecret } from '../credentials.js';
import { HttpError, principalFromRequest, requireRole, type Principal } from '../security.js';
import { metaTemplateAdapter, TemplateProviderError, type MessagingTemplateAdapter,
  type CreateTemplateInput, type ProviderTemplate } from '../messaging/templates-provider.js';
import type { MessagingConnectionConfig, MessagingCredentials } from '../messaging/providers.js';
import { bodyParameterCount, parseTextTemplate, validHeaderExample } from '../messaging/approved-template.js';

const params = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } } } as const;
const createSchema = { type: 'object', additionalProperties: false,
  required: ['idempotencyKey','name','language','category','body'], properties: {
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
    name: { type: 'string', pattern: '^[a-z0-9_]{1,512}$' },
    language: { type: 'string', pattern: '^[a-z]{2,3}(_[A-Z]{2})?$' },
    category: { type: 'string', enum: ['MARKETING','UTILITY'] },
    body: { type: 'string', minLength: 1, maxLength: 1024 },
    header:{ type:'string',minLength:1,maxLength:60 },footer:{ type:'string',minLength:1,maxLength:60 },
    headerExample:{ type:'string',minLength:1,maxLength:60 },
    examples: { type: 'array', maxItems: 10, items: {
      type: 'string', minLength: 1, maxLength: 512 } },
  } } as const;

async function connectionFor(db: Database, actor: Principal, id: string) {
  requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  const rows = await db`SELECT c.id, c.branch_id, c.status, c.version, c.config
    FROM integration_connection c WHERE c.id = ${id} AND c.organization_id = ${actor.organizationId}
      AND c.kind = 'MESSAGING' AND c.provider = 'META_WHATSAPP_CLOUD'
      AND (${actor.role === 'SUPER_ADMIN'} OR c.branch_id = ${actor.branchId})`;
  if (!rows[0]) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND');
  return rows[0]!;
}

async function credentialsFor(db: Database, id: string): Promise<MessagingCredentials> {
  const rows = await db`SELECT ciphertext, nonce, auth_tag, key_version FROM connection_secret
    WHERE connection_id = ${id}`;
  if (!rows[0]) throw new HttpError(409, 'CONNECTION_CREDENTIAL_MISSING');
  try {
    const credential = JSON.parse(openSecret(id, { ciphertext: rows[0].ciphertext,
      nonce: rows[0].nonce, authTag: rows[0].auth_tag, keyVersion: rows[0].key_version })) as MessagingCredentials;
    if (!credential.accessToken) throw new Error('missing token');
    return credential;
  } catch { throw new HttpError(409, 'CONNECTION_CREDENTIAL_UNAVAILABLE'); }
}

function validateCatalog(items: ProviderTemplate[]): void {
  if (!Array.isArray(items) || items.length > 10000) throw new HttpError(502, 'TEMPLATE_CATALOG_INVALID');
  const ids = new Set<string>();
  for (const item of items) {
    if (!/^\d{1,30}$/.test(item.externalId) || !/^[a-z0-9_]{1,512}$/.test(item.name)
      || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(item.language)
      || !item.status || item.status.length > 40 || !Array.isArray(item.components)
      || item.components.length > 30 || ids.has(item.externalId)) throw new HttpError(502, 'TEMPLATE_CATALOG_INVALID');
    try { if (JSON.stringify(item.components).length > 32768) throw new Error('too large'); }
    catch { throw new HttpError(502, 'TEMPLATE_CATALOG_INVALID'); }
    ids.add(item.externalId);
  }
}

export function registerMessagingTemplateRoutes(app: FastifyInstance, db: Database,
  adapter: MessagingTemplateAdapter = metaTemplateAdapter): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: number; after?: string } }>(
    '/api/messaging/connections/:id/templates', { schema: { params, querystring: {
      type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 }, after: { type: 'string', format: 'uuid' },
      },
    } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      await connectionFor(db, actor, request.params.id);
      const limit = request.query.limit ?? 50;
      const rows = await db`SELECT id, name, language, category, status, components, active, last_synced_at
        FROM provider_message_template WHERE connection_id = ${request.params.id}
          AND (${request.query.after ?? null}::uuid IS NULL OR id > ${request.query.after ?? null}::uuid)
        ORDER BY id LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      const items = page.map((row) => {
        const parsed = parseTextTemplate(row.components);
        return { ...row, supported: Boolean(parsed), parameterCount: parsed?.parameterCount ?? null,
          headerParameterCount: parsed?.headerParameterCount ?? null };
      });
      return { items, nextAfter: rows.length > limit ? page.at(-1)!.id : null };
    });

  app.post<{ Params: { id: string } }>('/api/messaging/connections/:id/templates/sync', {
    schema: { params }, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const connection = await connectionFor(db, actor, request.params.id);
    if (connection.status === 'DISABLED') throw new HttpError(409, 'CONNECTION_DISABLED');
    const credentials = await credentialsFor(db, connection.id);
    let templates: ProviderTemplate[];
    try { templates = await adapter.list(connection.config as MessagingConnectionConfig, credentials); validateCatalog(templates); }
    catch (error) {
      await db`UPDATE integration_connection SET last_failure_at = now(),
        last_error_code = 'TEMPLATE_SYNC_FAILED' WHERE id = ${connection.id} AND version = ${connection.version}`;
      throw error instanceof HttpError ? error : new HttpError(502, 'TEMPLATE_SYNC_FAILED');
    }
    return db.begin(async (tx) => {
      const current = (await tx`SELECT version, status FROM integration_connection
        WHERE id = ${connection.id} FOR UPDATE`)[0]!;
      if (current.version !== connection.version || current.status === 'DISABLED')
        throw new HttpError(409, 'CONNECTION_VERSION_CONFLICT');
      await tx`UPDATE provider_message_template SET active = false WHERE connection_id = ${connection.id}`;
      for (const item of templates) await tx`INSERT INTO provider_message_template
        (connection_id, external_template_id, name, language, status, category, components, active, last_synced_at)
        VALUES (${connection.id}, ${item.externalId}, ${item.name}, ${item.language}, ${item.status},
          ${item.category}, ${tx.json(JSON.parse(JSON.stringify(item.components)))}, true, now())
        ON CONFLICT (connection_id, external_template_id) DO UPDATE SET
          name = EXCLUDED.name, language = EXCLUDED.language, status = EXCLUDED.status,
          category = EXCLUDED.category, components = EXCLUDED.components, active = true,
          last_synced_at = now()`;
      await tx`UPDATE messaging_template_create_request r SET state = 'SUCCEEDED',
        template_id = t.id, error_code = NULL, updated_at = now()
        FROM provider_message_template t WHERE r.connection_id = ${connection.id}
          AND t.connection_id = r.connection_id AND t.name = r.name AND t.language = r.language
          AND t.active AND (r.state = 'UNKNOWN' OR
            (r.state = 'IN_PROGRESS' AND r.created_at < now() - interval '2 minutes'))`;
      await tx`INSERT INTO messaging_template_catalog_sync (connection_id, connection_version, synced_at)
        VALUES (${connection.id}, ${connection.version}, now())
        ON CONFLICT (connection_id) DO UPDATE SET connection_version = EXCLUDED.connection_version,
          synced_at = EXCLUDED.synced_at`;
      await tx`UPDATE integration_connection SET last_success_at = now(),
        last_error_code = NULL WHERE id = ${connection.id}`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
        target_type, target_id, detail) VALUES (${actor.organizationId}, ${connection.branch_id}, ${actor.id},
        'MESSAGING_TEMPLATES_SYNCED', 'CONNECTION', ${connection.id}, ${tx.json({ count: templates.length })})`;
      return { count: templates.length };
    });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number; after?: string } }>(
    '/api/messaging/connections/:id/templates/requests', { schema: { params, querystring: {
      type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 }, after: { type: 'string', format: 'uuid' },
      },
    } } }, async (request) => {
      const actor = await principalFromRequest(request, db);
      await connectionFor(db, actor, request.params.id);
      const limit = request.query.limit ?? 50;
      const rows = await db`SELECT id, name, language, state, error_code, created_at
        FROM messaging_template_create_request WHERE connection_id = ${request.params.id}
          AND state IN ('IN_PROGRESS','UNKNOWN')
          AND (${request.query.after ?? null}::uuid IS NULL OR id > ${request.query.after ?? null}::uuid)
        ORDER BY id LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      return { items, nextAfter: rows.length > limit ? items.at(-1)!.id : null };
    });

  app.post<{ Params: { id: string; requestId: string }; Body: { confirmAbsent: boolean } }>(
    '/api/messaging/connections/:id/templates/requests/:requestId/resolve', {
      schema: { params: { type: 'object', additionalProperties: false,
        required: ['id','requestId'], properties: { id: { type: 'string', format: 'uuid' },
          requestId: { type: 'string', format: 'uuid' } } }, body: {
        type: 'object', additionalProperties: false, required: ['confirmAbsent'], properties: {
          confirmAbsent: { type: 'boolean', const: true },
        },
      } },
    }, async (request) => {
      const actor = await principalFromRequest(request, db);
      const connection = await connectionFor(db, actor, request.params.id);
      return db.begin(async (tx) => {
        const current = (await tx`SELECT version, status FROM integration_connection
          WHERE id = ${connection.id} FOR UPDATE`)[0]!;
        if (current.version !== connection.version || current.status === 'DISABLED')
          throw new HttpError(409, 'CONNECTION_VERSION_CONFLICT');
        const operation = (await tx`SELECT id, name, language, state, created_at
          FROM messaging_template_create_request WHERE id = ${request.params.requestId}
            AND connection_id = ${connection.id} FOR UPDATE`)[0];
        if (!operation) throw new HttpError(404, 'TEMPLATE_CREATE_REQUEST_NOT_FOUND');
        if (operation.state !== 'UNKNOWN' && operation.state !== 'IN_PROGRESS')
          throw new HttpError(409, 'TEMPLATE_CREATE_ALREADY_RESOLVED');
        if (operation.state === 'IN_PROGRESS' && Date.now() - operation.created_at.getTime() < 120000)
          throw new HttpError(409, 'TEMPLATE_CREATE_STILL_RUNNING');
        const sync = (await tx`SELECT connection_version, synced_at
          FROM messaging_template_catalog_sync WHERE connection_id = ${connection.id}`)[0];
        if (!sync || sync.connection_version !== current.version || sync.synced_at <= operation.created_at)
          throw new HttpError(409, 'TEMPLATE_REVIEW_REQUIRES_SYNC');
        const found = await tx`SELECT 1 FROM provider_message_template
          WHERE connection_id = ${connection.id} AND name = ${operation.name}
            AND language = ${operation.language} AND active LIMIT 1`;
        if (found.length) throw new HttpError(409, 'TEMPLATE_PRESENT_IN_CATALOG');
        await tx`UPDATE messaging_template_create_request SET state = 'REJECTED',
          error_code = 'OPERATOR_CONFIRMED_ABSENT', updated_at = now() WHERE id = ${operation.id}`;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
          target_type, target_id, detail) VALUES (${actor.organizationId}, ${connection.branch_id},
          ${actor.id}, 'MESSAGING_TEMPLATE_CREATE_REVIEWED_ABSENT', 'CONNECTION', ${connection.id},
          ${tx.json({ requestId: operation.id, name: operation.name, language: operation.language })})`;
        return { state: 'REJECTED', canCreateNewRequest: true };
      });
    });

  app.post<{ Params: { id: string }; Body: CreateTemplateInput & { idempotencyKey: string } }>(
    '/api/messaging/connections/:id/templates', { schema: { params, body: createSchema },
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request, reply) => {
      const actor = await principalFromRequest(request, db);
      const connection = await connectionFor(db, actor, request.params.id);
      if (connection.status === 'DISABLED') throw new HttpError(409, 'CONNECTION_DISABLED');
      const { idempotencyKey, ...input } = request.body;
      const count = bodyParameterCount(input.body);
      if (count === null) throw new HttpError(400, 'TEMPLATE_BODY_INVALID');
      if (!parseTextTemplate([...(input.header!==undefined ? [{ type:'HEADER',format:'TEXT',text:input.header }] : []),
        { type:'BODY',text:input.body },...(input.footer!==undefined ? [{ type:'FOOTER',text:input.footer }] : [])]))
        throw new HttpError(400,'TEMPLATE_FORMAT_UNSUPPORTED');
      if ((input.examples?.length ?? 0) !== count || input.examples?.some((value) =>
        !value.trim() || /[\x00-\x1f\x7f]/.test(value)))
        throw new HttpError(400, 'TEMPLATE_EXAMPLES_INVALID');
      if (!validHeaderExample(input.header,input.headerExample)) throw new HttpError(400,'TEMPLATE_HEADER_EXAMPLE_INVALID');
      const credentials = await credentialsFor(db, connection.id);
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const reservation = await db.begin(async (tx) => {
        const current = (await tx`SELECT version, status FROM integration_connection
          WHERE id = ${connection.id} FOR UPDATE`)[0]!;
        if (current.version !== connection.version || current.status === 'DISABLED')
          throw new HttpError(409, 'CONNECTION_VERSION_CONFLICT');
        const existing = (await tx`SELECT state, request_hash, template_id
          FROM messaging_template_create_request WHERE connection_id = ${connection.id}
            AND idempotency_key = ${idempotencyKey}`)[0];
        if (existing) {
          if (existing.request_hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
          if (existing.state === 'SUCCEEDED') return { existing: true, templateId: existing.template_id as string };
          throw new HttpError(409, existing.state === 'UNKNOWN' ? 'TEMPLATE_CREATE_OUTCOME_UNKNOWN' :
            existing.state === 'IN_PROGRESS' ? 'TEMPLATE_CREATE_IN_PROGRESS' : 'TEMPLATE_CREATE_REJECTED');
        }
        const pending = await tx`SELECT 1 FROM messaging_template_create_request
          WHERE connection_id = ${connection.id} AND name = ${input.name} AND language = ${input.language}
            AND state IN ('IN_PROGRESS','UNKNOWN') LIMIT 1`;
        if (pending.length) throw new HttpError(409, 'TEMPLATE_CREATE_NEEDS_SYNC');
        const catalog = await tx`SELECT 1 FROM provider_message_template
          WHERE connection_id = ${connection.id} AND name = ${input.name} AND language = ${input.language}
            AND active LIMIT 1`;
        if (catalog.length) throw new HttpError(409, 'TEMPLATE_ALREADY_EXISTS');
        await tx`INSERT INTO messaging_template_create_request
          (connection_id, idempotency_key, request_hash, name, language, state, created_by)
          VALUES (${connection.id}, ${idempotencyKey}, ${hash}, ${input.name}, ${input.language},
            'IN_PROGRESS', ${actor.id})`;
        return { existing: false };
      });
      if (reservation.existing) return { id: reservation.templateId, existing: true };
      let created: ProviderTemplate;
      try { created = await adapter.create(connection.config as MessagingConnectionConfig, credentials, input);
        validateCatalog([created]); }
      catch (error) {
        const unknown = !(error instanceof TemplateProviderError) || error.kind === 'UNKNOWN';
        await db.begin(async (tx) => {
          await tx`UPDATE messaging_template_create_request SET state = ${unknown ? 'UNKNOWN' : 'REJECTED'},
            error_code = ${unknown ? 'TEMPLATE_CREATE_OUTCOME_UNKNOWN' : 'TEMPLATE_CREATE_REJECTED'},
            updated_at = now() WHERE connection_id = ${connection.id} AND idempotency_key = ${idempotencyKey}`;
          await tx`UPDATE integration_connection SET last_failure_at = now(),
            last_error_code = ${unknown ? 'TEMPLATE_CREATE_OUTCOME_UNKNOWN' : 'TEMPLATE_CREATE_REJECTED'}
            WHERE id = ${connection.id} AND version = ${connection.version}`;
          await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
            target_type, target_id, detail) VALUES (${actor.organizationId}, ${connection.branch_id}, ${actor.id},
            ${unknown ? 'MESSAGING_TEMPLATE_CREATE_UNKNOWN' : 'MESSAGING_TEMPLATE_CREATE_REJECTED'},
            'CONNECTION', ${connection.id}, ${tx.json({ name: input.name, language: input.language })})`;
        });
        throw new HttpError(unknown ? 409 : 502,
          unknown ? 'TEMPLATE_CREATE_OUTCOME_UNKNOWN' : 'TEMPLATE_CREATE_REJECTED');
      }
      const result = await db.begin(async (tx) => {
        const current = (await tx`SELECT version, status FROM integration_connection
          WHERE id = ${connection.id} FOR UPDATE`)[0]!;
        const active = current.version === connection.version && current.status !== 'DISABLED';
        const template = (await tx`INSERT INTO provider_message_template
          (connection_id, external_template_id, name, language, status, category, components, active)
          VALUES (${connection.id}, ${created.externalId}, ${created.name}, ${created.language},
            ${created.status}, ${created.category}, ${tx.json(JSON.parse(JSON.stringify(created.components)))}, ${active})
          ON CONFLICT (connection_id, external_template_id) DO UPDATE SET
            status = EXCLUDED.status, category = EXCLUDED.category, components = EXCLUDED.components,
            active = EXCLUDED.active RETURNING id`)[0]!;
        await tx`UPDATE messaging_template_create_request SET state = 'SUCCEEDED',
          template_id = ${template.id}, updated_at = now()
          WHERE connection_id = ${connection.id} AND idempotency_key = ${idempotencyKey}`;
        await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action,
          target_type, target_id, detail) VALUES (${actor.organizationId}, ${connection.branch_id}, ${actor.id},
          'MESSAGING_TEMPLATE_CREATED', 'TEMPLATE', ${template.id},
          ${tx.json({ status: created.status, active })})`;
        return { id: template.id as string, status: created.status, active };
      });
      reply.code(201);
      return { ...result, existing: false };
    });
}
