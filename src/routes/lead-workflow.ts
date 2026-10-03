import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireLead, requireRole, type Principal } from '../security.js';
import { decodeCursor, encodeCursor } from '../pagination.js';

const leadParam = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const followupParam = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const historyQuery = { type: 'object', additionalProperties: false, properties: {
  before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
} } as const;
const dueSchema = { type: 'string', format: 'date-time' } as const;

async function lockedLead(tx: postgres.TransactionSql, actor: Principal, id: string) {
  const rows = await tx`SELECT id, branch_id, campaign_id, assigned_agent_id, lifecycle, version FROM lead
    WHERE id = ${id} AND organization_id = ${actor.organizationId}
      AND (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND branch_id = ${actor.branchId})
        OR (${actor.role === 'AGENT'} AND assigned_agent_id = ${actor.id})) FOR UPDATE`;
  if (!rows[0]) throw new HttpError(404, 'LEAD_NOT_FOUND');
  return rows[0];
}

async function requireFollowup(tx: postgres.TransactionSql, actor: Principal, id: string) {
  const found = await tx`SELECT lead_id FROM follow_up WHERE id = ${id}`;
  if (!found[0]) throw new HttpError(404, 'FOLLOW_UP_NOT_FOUND');
  const lead = await lockedLead(tx, actor, found[0].lead_id);
  const rows = await tx`SELECT * FROM follow_up WHERE id = ${id} AND lead_id = ${lead.id} FOR UPDATE`;
  const item = rows[0];
  if (!item) throw new HttpError(404, 'FOLLOW_UP_NOT_FOUND');
  if (actor.role === 'AGENT' && item.owner_user_id !== actor.id) throw new HttpError(403, 'FOLLOW_UP_NOT_OWNED');
  return { lead, item };
}

export function registerLeadWorkflowRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>('/api/leads/:id/activity', {
    schema: { params: leadParam, querystring: historyQuery },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const lead = await requireLead(db, actor, request.params.id);
    const limit = request.query.limit ?? 30;
    const rows = await db`SELECT id, actor_user_id, event_type, detail, created_at FROM lead_activity
      WHERE lead_id = ${lead.id} AND (${request.query.before ?? null}::bigint IS NULL OR id < ${request.query.before ?? null})
      ORDER BY id DESC LIMIT ${limit + 1}`;
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
  });

  app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>('/api/leads/:id/assignments', {
    schema: { params: leadParam, querystring: historyQuery },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const lead = await requireLead(db, actor, request.params.id);
    const limit = request.query.limit ?? 30;
    const rows = await db`SELECT h.id, h.old_branch_id, h.old_agent_id, old_agent.name AS old_agent_name,
        h.new_branch_id, h.new_agent_id, new_agent.name AS new_agent_name,
        h.actor_user_id, h.method, h.reason, h.created_at FROM assignment_history h
      LEFT JOIN user_account old_agent ON old_agent.id = h.old_agent_id
      LEFT JOIN user_account new_agent ON new_agent.id = h.new_agent_id
      WHERE h.lead_id = ${lead.id} AND (${request.query.before ?? null}::bigint IS NULL OR h.id < ${request.query.before ?? null})
      ORDER BY h.id DESC LIMIT ${limit + 1}`;
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
  });

  app.post<{ Params: { id: string }; Body: { version: number; agentId: string | null; reason?: string } }>('/api/leads/:id/assignment', {
    schema: { params: leadParam, body: { type: 'object', additionalProperties: false,
      required: ['version','agentId'], properties: {
        version: { type: 'integer', minimum: 1 }, agentId: { anyOf: [{ type: 'null' }, { type: 'string', format: 'uuid' }] },
        reason: { type: 'string', maxLength: 500 },
      } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    return db.begin(async (tx) => {
      const lead = await lockedLead(tx, actor, request.params.id);
      if (lead.version !== request.body.version) throw new HttpError(409, 'LEAD_VERSION_CONFLICT');
      const target = request.body.agentId;
      if (target === lead.assigned_agent_id) return { version: lead.version, assignedAgentId: target };
      if (target) {
        const eligible = await tx`SELECT 1 FROM user_account WHERE id = ${target} AND organization_id = ${actor.organizationId}
          AND branch_id = ${lead.branch_id} AND role = 'AGENT' AND active`;
        if (!eligible.length) throw new HttpError(400, 'AGENT_NOT_ELIGIBLE');
      }
      const changed = await tx`UPDATE lead SET assigned_agent_id = ${target}, version = version + 1,
        needs_attention_reason = CASE WHEN ${target}::uuid IS NULL THEN 'UNASSIGNED_BY_MANAGER'
          WHEN needs_attention_reason IN ('NO_ELIGIBLE_AGENT','UNASSIGNED_BY_MANAGER') THEN NULL ELSE needs_attention_reason END,
        updated_at = now() WHERE id = ${lead.id} RETURNING version`;
      await tx`INSERT INTO assignment_history (lead_id, old_branch_id, old_agent_id, new_branch_id, new_agent_id,
        actor_user_id, method, reason) VALUES (${lead.id}, ${lead.branch_id}, ${lead.assigned_agent_id},
          ${lead.branch_id}, ${target}, ${actor.id}, 'MANUAL', ${request.body.reason?.trim() ?? null})`;
      const moved = await tx`UPDATE follow_up SET owner_user_id = ${target}, version = version + 1, updated_at = now()
        WHERE lead_id = ${lead.id} AND status = 'OPEN' AND owner_user_id = ${lead.assigned_agent_id} RETURNING id`;
      for (const task of moved) await tx`INSERT INTO follow_up_history (follow_up_id, actor_user_id, event_type, detail)
        VALUES (${task.id}, ${actor.id}, 'OWNER_CHANGED_BY_REASSIGNMENT',
          ${tx.json({ from: lead.assigned_agent_id, to: target })})`;
      const conversations = await tx`UPDATE conversation SET controller_user_id = ${target},
        controller_type = ${target ? 'HUMAN' : 'NONE'}, state = ${target ? 'HUMAN_ACTIVE' : 'WAITING_FOR_HUMAN'},
        version = version + 1, needs_attention_reason = ${target ? null : 'LEAD_UNASSIGNED'}
        WHERE lead_id = ${lead.id} AND controller_type = 'HUMAN' AND controller_user_id = ${lead.assigned_agent_id}
          AND state = 'HUMAN_ACTIVE' RETURNING id`;
      for (const conversation of conversations) await tx`INSERT INTO conversation_handoff
        (conversation_id, from_controller, from_user_id, to_controller, to_user_id, reason, requested_by)
        VALUES (${conversation.id}, 'HUMAN', ${lead.assigned_agent_id}, ${target ? 'HUMAN' : 'NONE'}, ${target},
          'LEAD_REASSIGNED', ${actor.id})`;
      await tx`INSERT INTO lead_activity (lead_id, actor_user_id, event_type, detail)
        VALUES (${lead.id}, ${actor.id}, 'LEAD_REASSIGNED',
          ${tx.json({ from: lead.assigned_agent_id, to: target, reason: request.body.reason?.trim() ?? null })})`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id, detail)
        VALUES (${actor.organizationId}, ${lead.branch_id}, ${actor.id}, 'LEAD_REASSIGNED', 'LEAD', ${lead.id},
          ${tx.json({ from: lead.assigned_agent_id, to: target })})`;
      return { version: changed[0]!.version, assignedAgentId: target };
    });
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>('/api/leads/:id/notes', {
    schema: { params: leadParam, body: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      text: { type: 'string', minLength: 1, maxLength: 4000 },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    const text = request.body.text.trim();
    if (!text) throw new HttpError(400, 'EMPTY_NOTE');
    const id = await db.begin(async (tx) => {
      const lead = await lockedLead(tx, actor, request.params.id);
      const rows = await tx`INSERT INTO lead_activity (lead_id, actor_user_id, event_type, detail)
        VALUES (${lead.id}, ${actor.id}, 'NOTE_ADDED', ${tx.json({ text })}) RETURNING id`;
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: number } }>('/api/leads/:id/followups', {
    schema: { params: leadParam, querystring: { type: 'object', additionalProperties: false, properties: {
      cursor: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const lead = await requireLead(db, actor, request.params.id);
    const limit = request.query.limit ?? 30;
    const cursor = decodeCursor(request.query.cursor);
    const rows = await db`SELECT id, lead_id, owner_user_id, due_at, status, kind, note, priority, version,
        created_by, completed_by, completed_at, cancelled_by, cancelled_at, created_at FROM follow_up
      WHERE lead_id = ${lead.id} AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR
        (created_at, id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.created_at.toISOString(), id: last.id }) : null };
  });

  app.post<{ Params: { id: string }; Body: { dueAt: string; note?: string; ownerUserId?: string; priority?: 'LOW'|'NORMAL'|'HIGH' } }>('/api/leads/:id/followups', {
    schema: { params: leadParam, body: { type: 'object', additionalProperties: false, required: ['dueAt'], properties: {
      dueAt: dueSchema, note: { type: 'string', maxLength: 4000 }, ownerUserId: { type: 'string', format: 'uuid' },
      priority: { enum: ['LOW','NORMAL','HIGH'] },
    } } },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    const id = await db.begin(async (tx) => {
      const lead = await lockedLead(tx, actor, request.params.id);
      const owner = request.body.ownerUserId ?? (actor.role === 'AGENT' ? actor.id : lead.assigned_agent_id ?? actor.id);
      if (actor.role === 'AGENT' && owner !== actor.id) throw new HttpError(403, 'FOLLOW_UP_OWNER_DENIED');
      const user = await tx`SELECT 1 FROM user_account WHERE id = ${owner} AND organization_id = ${actor.organizationId}
        AND branch_id = ${lead.branch_id} AND active AND role IN ('MANAGER','AGENT')`;
      if (!user.length) throw new HttpError(400, 'FOLLOW_UP_OWNER_NOT_ELIGIBLE');
      const created = await tx`INSERT INTO follow_up (lead_id, owner_user_id, due_at, note, priority, created_by, kind)
        VALUES (${lead.id}, ${owner}, ${request.body.dueAt}, ${request.body.note?.trim() ?? null},
          ${request.body.priority ?? 'NORMAL'}, ${actor.id}, 'HUMAN') RETURNING id`;
      await tx`INSERT INTO follow_up_history (follow_up_id, actor_user_id, event_type, detail)
        VALUES (${created[0]!.id}, ${actor.id}, 'CREATED', ${tx.json({ owner, dueAt: request.body.dueAt })})`;
      await tx`INSERT INTO lead_activity (lead_id, actor_user_id, event_type, detail)
        VALUES (${lead.id}, ${actor.id}, 'FOLLOW_UP_CREATED', ${tx.json({ followUpId: created[0]!.id })})`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${lead.branch_id}, ${actor.id}, 'FOLLOW_UP_CREATED', 'FOLLOW_UP', ${created[0]!.id})`;
      return created[0]!.id as string;
    });
    reply.code(201);
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: { version: number; dueAt?: string; note?: string;
    priority?: 'LOW'|'NORMAL'|'HIGH'; ownerUserId?: string; status?: 'COMPLETED'|'CANCELLED' } }>('/api/followups/:id', {
    schema: { params: followupParam, body: { type: 'object', additionalProperties: false, required: ['version'], properties: {
      version: { type: 'integer', minimum: 1 }, dueAt: dueSchema, note: { type: 'string', maxLength: 4000 },
      priority: { enum: ['LOW','NORMAL','HIGH'] }, ownerUserId: { type: 'string', format: 'uuid' },
      status: { enum: ['COMPLETED','CANCELLED'] },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return db.begin(async (tx) => {
      const { lead, item } = await requireFollowup(tx, actor, request.params.id);
      if (item.version !== request.body.version) throw new HttpError(409, 'FOLLOW_UP_VERSION_CONFLICT');
      if (item.status !== 'OPEN') throw new HttpError(409, 'FOLLOW_UP_NOT_OPEN');
      if (request.body.status === 'CANCELLED' && actor.role === 'AGENT') throw new HttpError(403, 'FOLLOW_UP_CANCEL_DENIED');
      const owner = request.body.ownerUserId ?? item.owner_user_id;
      if (request.body.ownerUserId && actor.role === 'AGENT' && owner !== actor.id) throw new HttpError(403, 'FOLLOW_UP_OWNER_DENIED');
      if (owner !== item.owner_user_id) {
        const user = await tx`SELECT 1 FROM user_account WHERE id = ${owner} AND organization_id = ${actor.organizationId}
          AND branch_id = ${lead.branch_id} AND active AND role IN ('MANAGER','AGENT')`;
        if (!user.length) throw new HttpError(400, 'FOLLOW_UP_OWNER_NOT_ELIGIBLE');
      }
      if (Object.keys(request.body).length === 1) throw new HttpError(400, 'FOLLOW_UP_NO_CHANGES');
      const status = request.body.status ?? item.status;
      const before = { dueAt: item.due_at.toISOString(), note: item.note, priority: item.priority, owner: item.owner_user_id, status: item.status };
      const changed = await tx`UPDATE follow_up SET due_at = ${request.body.dueAt ?? item.due_at},
        note = ${request.body.note === undefined ? item.note : request.body.note.trim()},
        priority = ${request.body.priority ?? item.priority}, owner_user_id = ${owner}, status = ${status},
        completed_by = ${status === 'COMPLETED' ? actor.id : null}, completed_at = ${status === 'COMPLETED' ? new Date() : null},
        cancelled_by = ${status === 'CANCELLED' ? actor.id : null}, cancelled_at = ${status === 'CANCELLED' ? new Date() : null},
        version = version + 1, updated_at = now() WHERE id = ${item.id} RETURNING version, due_at`;
      const event = status === 'COMPLETED' ? 'COMPLETED' : status === 'CANCELLED' ? 'CANCELLED' : 'UPDATED';
      await tx`INSERT INTO follow_up_history (follow_up_id, actor_user_id, event_type, detail)
        VALUES (${item.id}, ${actor.id}, ${event},
          ${tx.json({ before, after: { dueAt: changed[0]!.due_at.toISOString(),
            note: request.body.note === undefined ? item.note : request.body.note.trim(), priority: request.body.priority ?? item.priority,
            owner, status } })})`;
      await tx`INSERT INTO lead_activity (lead_id, actor_user_id, event_type, detail)
        VALUES (${lead.id}, ${actor.id}, ${'FOLLOW_UP_' + event}, ${tx.json({ followUpId: item.id })})`;
      await tx`INSERT INTO audit_log (organization_id, branch_id, actor_user_id, action, target_type, target_id)
        VALUES (${actor.organizationId}, ${lead.branch_id}, ${actor.id}, ${'FOLLOW_UP_' + event}, 'FOLLOW_UP', ${item.id})`;
      return { version: changed[0]!.version, status };
    });
  });

  app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>('/api/followups/:id/history', {
    schema: { params: followupParam, querystring: historyQuery },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const found = await db`SELECT lead_id FROM follow_up WHERE id = ${request.params.id}`;
    if (!found[0]) throw new HttpError(404, 'FOLLOW_UP_NOT_FOUND');
    await requireLead(db, actor, found[0].lead_id);
    const limit = request.query.limit ?? 30;
    const rows = await db`SELECT id, actor_user_id, event_type, detail, created_at FROM follow_up_history
      WHERE follow_up_id = ${request.params.id}
        AND (${request.query.before ?? null}::bigint IS NULL OR id < ${request.query.before ?? null})
      ORDER BY id DESC LIMIT ${limit + 1}`;
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
  });

  app.get<{ Querystring: { cursor?: string; limit?: number; branchId?: string; dueBefore?: string; status?: string } }>('/api/followups', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      cursor: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      branchId: { type: 'string', format: 'uuid' }, dueBefore: dueSchema,
      status: { enum: ['OPEN','COMPLETED','CANCELLED'] },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    if (request.query.branchId && actor.role !== 'SUPER_ADMIN' && request.query.branchId !== actor.branchId)
      throw new HttpError(403, 'FORBIDDEN');
    const cursor = decodeCursor(request.query.cursor);
    const limit = request.query.limit ?? 30;
    const status = request.query.status ?? 'OPEN';
    const rows = await db`SELECT f.id, f.lead_id, f.owner_user_id, f.due_at, f.status, f.priority, f.note,
        f.version, f.created_at, l.branch_id, l.campaign_id, c.name AS contact_name
      FROM follow_up f JOIN lead l ON l.id = f.lead_id JOIN contact c ON c.id = l.contact_id
      WHERE l.organization_id = ${actor.organizationId}
        AND (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND l.branch_id = ${actor.branchId})
          OR (${actor.role === 'AGENT'} AND l.assigned_agent_id = ${actor.id} AND f.owner_user_id = ${actor.id}))
        AND (${request.query.branchId ?? null}::uuid IS NULL OR l.branch_id = ${request.query.branchId ?? null})
        AND f.status = ${status} AND (${request.query.dueBefore ?? null}::timestamptz IS NULL OR f.due_at <= ${request.query.dueBefore ?? null})
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR
          (f.due_at, f.id) > (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      ORDER BY f.due_at, f.id LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ timestamp: last.due_at.toISOString(), id: last.id }) : null };
  });
}
