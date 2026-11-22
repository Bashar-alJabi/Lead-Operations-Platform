import {createHumanFollowUp,requireHumanFollowUpOwner,type FollowUpLead} from '../human-follow-ups.js';
import {currentPaymentSession} from '../payments/access.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { HttpError, principalFromRequest, requireLead, requireRole, type Principal } from '../security.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { leadActivityBoundary } from '../lead-activity.js';

const leadParam = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const followupParam = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const historyQuery = { type: 'object', additionalProperties: false, properties: {
  before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
} } as const;
const dueSchema = { type: 'string', format: 'date-time' } as const;

async function lockedLead(tx: postgres.TransactionSql, actor: Principal, id: string, write = true) {
  const rows = await tx`SELECT id, branch_id, campaign_id, assigned_agent_id, lifecycle, version FROM lead
    WHERE id = ${id} AND organization_id = ${actor.organizationId}
      AND (${actor.role === 'SUPER_ADMIN'} OR (${actor.role === 'MANAGER'} AND branch_id = ${actor.branchId})
        OR (${actor.role === 'AGENT'} AND branch_id = ${actor.branchId} AND assigned_agent_id = ${actor.id}))
    ${write ? tx`FOR UPDATE` : tx`FOR SHARE`}`;
  if (!rows[0]) throw new HttpError(404, 'LEAD_NOT_FOUND');
  return rows[0];
}

function assignLead(db: Database, actor: Principal, request: FastifyRequest, id: string,
  input: { version: number; agentId: string | null; reason?: string }) {
  requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
  return db.begin(async (tx) => {
    const lead = await lockedLead(tx, actor, id);
    const session = await currentPaymentSession(tx, actor, request);
    if (!session) throw new HttpError(403, 'LEAD_ASSIGNMENT_ACCESS_REVOKED');
    try {
      const [assignment] = await tx<{ version: number }[]>`
        SELECT apply_human_lead_assignment(${lead.id}, ${input.version}, ${input.agentId},
          ${actor.id}, ${session}, ${input.reason?.trim() ?? null}) AS version`;
      return { version: assignment!.version, assignedAgentId: input.agentId };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'P0001') {
        if (error.message === 'AGENT_NOT_ELIGIBLE') throw new HttpError(400, error.message);
        if (error.message === 'LEAD_ASSIGNMENT_ACCESS_REVOKED') throw new HttpError(403, error.message);
        if (error.message === 'LEAD_VERSION_CONFLICT') throw new HttpError(409, error.message);
      }
      throw error;
    }
  });
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
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>('/api/leads/:id/ai-followups',{
    schema:{params:leadParam,querystring:{type:'object',additionalProperties:false,properties:{cursor:{type:'string',maxLength:256}}}},
  }, async (request,reply) => {
    const actor=await principalFromRequest(request,db),cursor=decodeCursor(request.query.cursor),limit=20;
    reply.header('Cache-Control','no-store');
    return db.begin(async tx => {
      const lead=await lockedLead(tx,actor,request.params.id,false);
      if (!await currentPaymentSession(tx,actor,request)) throw new HttpError(403,'LEAD_ACCESS_REVOKED');
      const rows=await tx`SELECT s.id,s.ordinal,f.state AS "finalState",f.reason AS "finalReason",
          CASE WHEN m.delivery_state IN ('SENT','DELIVERED','READ','UNKNOWN') THEN m.delivery_state
          WHEN s.state='STOPPED' THEN s.state WHEN a.blocked_reason IS NOT NULL THEN 'BLOCKED' ELSE COALESCE(m.delivery_state,s.state) END AS state,
        CASE WHEN m.delivery_state IN ('SENT','DELIVERED','READ') THEN NULL ELSE COALESCE(s.stop_reason,a.blocked_reason,m.last_error_code) END AS reason,
        s.anchored_at AS "anchoredAt",s.due_at AS "dueAt",s.changed_at AS "changedAt",s.anchored_at::text AS cursor_at
        FROM ai_followup_schedule s LEFT JOIN ai_followup_send_action a ON a.schedule_id=s.id
          LEFT JOIN conversation_message m ON m.id=a.message_id
          LEFT JOIN ai_followup_final_action f ON f.schedule_id=s.id
        WHERE s.lead_id=${lead.id} AND s.organization_id=${actor.organizationId}
          AND s.branch_id=${lead.branch_id} AND s.campaign_id=${lead.campaign_id}
          AND (${cursor?.timestamp??null}::text::timestamptz IS NULL OR
            (s.anchored_at,s.id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
        ORDER BY s.anchored_at DESC,s.id DESC LIMIT ${limit+1}`;
      const items=rows.slice(0,limit), last=items.at(-1);
      return { items,nextCursor:rows.length>limit && last ? encodeCursor({timestamp:last.cursor_at,id:last.id}) : null };
    });
  });

  const transferPath = '/api/leads/:id/branch-transfers';
  app.post<{ Params: { id: string }; Body: { version: number; branchId: string; campaignId: string; agentId: string | null; reason: string } }>(transferPath, {
    schema: { params: leadParam, body: { type: 'object', additionalProperties: false,
      required: ['version', 'branchId', 'campaignId', 'agentId', 'reason'], properties: {
        version: { type: 'integer', minimum: 1, maximum: 2147483646 }, branchId: leadParam.properties.id,
        campaignId: leadParam.properties.id, agentId: { type: ['string','null'], format: 'uuid' },
        reason: { type: 'string', minLength: 3, maxLength: 500 },
      } } },
  }, async request => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN');
    const input = request.body, reason = input.reason.trim();
    if (reason.length < 3 || /[\x00-\x1f\x7f]/.test(reason)) throw new HttpError(400, 'LEAD_TRANSFER_REASON_INVALID');
    try {
      return await db.begin(async tx => {
        const sessionId = await currentPaymentSession(tx, actor, request);
        if (!sessionId) throw new HttpError(403, 'LEAD_TRANSFER_ACCESS_REVOKED');
        const [change] = await tx`INSERT INTO lead_branch_transfer(lead_id,source_version,organization_id,
          destination_branch_id,destination_campaign_id,destination_agent_id,actor_id,session_id,reason)
        VALUES(${request.params.id},${input.version},${actor.organizationId},${input.branchId},${input.campaignId},
          ${input.agentId},${actor.id},${sessionId},${reason}) RETURNING source_version+1 AS version`;
        return { version: change!.version, branchId: input.branchId, campaignId: input.campaignId, agentId: input.agentId };
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'P0001') {
        switch (error.message) {
          case 'LEAD_NOT_FOUND': throw new HttpError(404, error.message);
          case 'LEAD_TRANSFER_ACCESS_REVOKED': throw new HttpError(403, error.message);
          case 'LEAD_TRANSFER_DESTINATION_INVALID':
          case 'AGENT_NOT_ELIGIBLE': throw new HttpError(400, error.message);
          case 'LEAD_VERSION_CONFLICT':
          case 'LEAD_TRANSFER_CONVERSATION_REVIEW':
          case 'LEAD_TRANSFER_PAYMENT_REVIEW':
          case 'LEAD_TRANSFER_HUMAN_REVIEW_PENDING': throw new HttpError(409, error.message);
        }
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>(transferPath, {
    schema: { params: leadParam, querystring: historyQuery },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db), limit = request.query.limit ?? 20;
    requireRole(actor, 'SUPER_ADMIN');
    reply.header('Cache-Control', 'no-store');
    return db.begin(async tx => {
      const lead = await lockedLead(tx, actor, request.params.id, false);
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'LEAD_TRANSFER_ACCESS_REVOKED');
      const rows = await tx`SELECT t.source_version AS version,t.created_at AS "createdAt",t.reason,
        source_branch.name AS "sourceBranch",source_campaign.name AS "sourceCampaign",
        destination_branch.name AS "destinationBranch",destination_campaign.name AS "destinationCampaign"
        FROM lead_branch_transfer t JOIN branch source_branch ON source_branch.id=t.source_branch_id
        JOIN branch destination_branch ON destination_branch.id=t.destination_branch_id
        JOIN campaign source_campaign ON source_campaign.id=t.source_campaign_id
        JOIN campaign destination_campaign ON destination_campaign.id=t.destination_campaign_id
        WHERE t.lead_id=${lead.id} AND t.organization_id=${actor.organizationId}
          AND (${request.query.before ?? null}::integer IS NULL OR t.source_version<${request.query.before ?? null})
        ORDER BY t.source_version DESC LIMIT ${limit+1}`;
      return { items: rows.slice(0,limit), nextCursor: rows.length>limit ? rows[limit-1]!.version : null };
    });
  });

  app.post<{ Params: { id: string }; Body: { lifecycle: 'OPEN'|'CLOSED'|'ARCHIVED' } }>('/api/leads/:id/lifecycle', {
    schema: { params: leadParam, body: { type: 'object', additionalProperties: false, required: ['lifecycle'],
      properties: { lifecycle: { enum: ['OPEN','CLOSED','ARCHIVED'] } },
    } },
  }, async request => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    return db.begin(async tx => {
      const lead = await lockedLead(tx, actor, request.params.id);
      await tx`SELECT id FROM campaign WHERE id=${lead.campaign_id} FOR SHARE`;
      const session = await currentPaymentSession(tx, actor, request);
      if (!session) throw new HttpError(403, 'LEAD_LIFECYCLE_ACCESS_REVOKED');
      try {
        const [result] = await tx`SELECT apply_lead_lifecycle(${lead.id},${request.body.lifecycle},${actor.id},${session},NULL) AS lifecycle`;
        return { lifecycle: result!.lifecycle };
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'P0001') {
          if (error.message === 'LEAD_NOT_FOUND') throw new HttpError(404, error.message);
          if (error.message === 'FIELD_REQUIRED') throw new HttpError(409, error.message);
          if (error.message === 'LEAD_LIFECYCLE_ACCESS_REVOKED') throw new HttpError(403, error.message);
        }
        throw error;
      }
    });
  });

  app.get<{ Params: { id: string } }>('/api/leads/:id/automation-review', {
    schema: { params: leadParam },
  }, async (request, reply) => {
    const actor = await principalFromRequest(request, db);
    reply.header('Cache-Control', 'no-store');
    return db.begin(async tx => {
      const lead = await lockedLead(tx, actor, request.params.id, false);
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'AUTOMATION_REVIEW_ACCESS_REVOKED');
      const [review] = await tx`SELECT execution_id AS id,note,created_at AS "createdAt" FROM automation_human_review
        WHERE lead_id=${lead.id} AND organization_id=${actor.organizationId} AND branch_id=${lead.branch_id}
          AND campaign_id=${lead.campaign_id} AND resolved_at IS NULL`;
      return { review: review ?? null };
    });
  });

  app.post<{ Params: { id: string }; Body: { reviewId: string; note: string } }>('/api/leads/:id/automation-review/resolve', {
    schema: { params: leadParam, body: { type: 'object', additionalProperties: false, required: ['reviewId', 'note'],
      properties: { reviewId: leadParam.properties.id, note: { type: 'string', minLength: 3, maxLength: 500 } },
    } },
  }, async request => {
    const actor = await principalFromRequest(request, db);
    const note = request.body.note.trim();
    if (note.length < 3 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(note)) {
      throw new HttpError(400, 'AUTOMATION_REVIEW_NOTE_INVALID');
    }
    return db.begin(async tx => {
      const lead = await lockedLead(tx, actor, request.params.id);
      await tx`SELECT id FROM campaign WHERE id=${lead.campaign_id} AND organization_id=${actor.organizationId}
        AND branch_id=${lead.branch_id} FOR SHARE`;
      const session = await currentPaymentSession(tx, actor, request);
      if (!session) throw new HttpError(403, 'AUTOMATION_REVIEW_ACCESS_REVOKED');
      const [review] = await tx`UPDATE automation_human_review SET resolved_by=${actor.id},
        resolution_session_id=${session},resolution_note=${note}
        WHERE execution_id=${request.body.reviewId} AND lead_id=${lead.id} AND organization_id=${actor.organizationId}
          AND branch_id=${lead.branch_id} AND campaign_id=${lead.campaign_id} AND resolved_at IS NULL
        RETURNING resolved_at AS "resolvedAt"`;
      if (!review) throw new HttpError(409, 'AUTOMATION_REVIEW_NOT_PENDING');
      return { resolvedAt: review.resolvedAt };
    });
  });

  app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>('/api/leads/:id/activity', {
    schema: { params: leadParam, querystring: historyQuery },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const limit = request.query.limit ?? 30;
    return db.begin(async tx => {
      const lead = await lockedLead(tx, actor, request.params.id, false);
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'LEAD_ACTIVITY_ACCESS_REVOKED');
      const boundary = await leadActivityBoundary(tx, lead.id, actor.role==='SUPER_ADMIN');
      const rows = await tx`SELECT a.id,CASE WHEN a.id>=COALESCE(${boundary}::bigint,0) THEN a.actor_user_id END AS actor_user_id,
          a.event_type,CASE WHEN a.id>=COALESCE(${boundary}::bigint,0) OR a.event_type='NOTE_ADDED' THEN a.detail ELSE '{}'::jsonb END
          || CASE WHEN r.execution_id IS NOT NULL AND a.id>=COALESCE(${boundary}::bigint,0)
            THEN jsonb_build_object('text',r.resolution_note) ELSE '{}'::jsonb END AS detail,
          a.created_at
        FROM lead_activity a LEFT JOIN automation_human_review r ON r.execution_id=(
          CASE WHEN a.event_type='AUTOMATION_HUMAN_REVIEW_RESOLVED' THEN a.detail->>'executionId' END
        )::uuid AND r.lead_id=a.lead_id AND r.organization_id=${actor.organizationId}
          AND r.branch_id=${lead.branch_id} AND r.campaign_id=${lead.campaign_id} AND r.resolved_at IS NOT NULL
        WHERE a.lead_id=${lead.id} AND (${request.query.before ?? null}::bigint IS NULL OR a.id<${request.query.before ?? null})
        ORDER BY a.id DESC LIMIT ${limit + 1}`;
      return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
    });
  });

  app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>('/api/leads/:id/assignments', {
    schema: { params: leadParam, querystring: historyQuery },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    const limit = request.query.limit ?? 30;
    return db.begin(async tx => {
      const lead = await lockedLead(tx, actor, request.params.id, false);
      if (!await currentPaymentSession(tx, actor, request)) throw new HttpError(403, 'LEAD_ASSIGNMENT_ACCESS_REVOKED');
      const all = actor.role==='SUPER_ADMIN';
      const rows = await tx`SELECT h.id,
        CASE WHEN ${all} OR h.old_branch_id=${lead.branch_id} THEN h.old_branch_id END AS old_branch_id,
        CASE WHEN ${all} OR h.old_branch_id=${lead.branch_id} THEN h.old_agent_id END AS old_agent_id,
        old_agent.name AS old_agent_name,h.new_branch_id,h.new_agent_id,new_agent.name AS new_agent_name,
        CASE WHEN ${all} OR h.old_branch_id IS NULL OR h.old_branch_id=h.new_branch_id THEN h.actor_user_id END AS actor_user_id,
        h.method,CASE WHEN ${all} OR h.old_branch_id IS NULL OR h.old_branch_id=h.new_branch_id THEN h.reason END AS reason,h.created_at
        FROM assignment_history h
        LEFT JOIN user_account old_agent ON old_agent.id=h.old_agent_id AND (${all} OR h.old_branch_id=${lead.branch_id})
        LEFT JOIN user_account new_agent ON new_agent.id=h.new_agent_id
        WHERE h.lead_id=${lead.id} AND (${all} OR h.new_branch_id=${lead.branch_id})
          AND (${request.query.before ?? null}::bigint IS NULL OR h.id<${request.query.before ?? null})
        ORDER BY h.id DESC LIMIT ${limit + 1}`;
      return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
    });
  });

  app.post<{ Body: { confirmed: true; items: { id: string; version: number }[];
    agentId: string | null; reason?: string } }>('/api/leads/bulk/assignment', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['confirmed','items','agentId'], properties: {
      confirmed: { const: true }, items: { type: 'array', minItems: 1, maxItems: 50,
        items: { type: 'object', additionalProperties: false, required: ['id','version'], properties: {
          id: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 1 },
        } } }, agentId: { anyOf: [{ type: 'null' }, { type: 'string', format: 'uuid' }] },
      reason: { type: 'string', maxLength: 500 },
    } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    requireRole(actor, 'SUPER_ADMIN', 'MANAGER');
    const items = request.body.items;
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new HttpError(400, 'DUPLICATE_BULK_LEAD');
    const results: { id: string; status: 'UPDATED'|'UNCHANGED'|'FAILED'; version?: number; error?: string }[] = [];
    for (const item of items) {
      try {
        const result = await assignLead(db, actor, request, item.id, { version: item.version,
          agentId: request.body.agentId, reason: request.body.reason });
        results.push({ id: item.id, status: result.version === item.version ? 'UNCHANGED' : 'UPDATED', version: result.version });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        results.push({ id: item.id, status: 'FAILED', error: error.code });
      }
    }
    return { results };
  });

  app.post<{ Params: { id: string }; Body: { version: number; agentId: string | null; reason?: string } }>('/api/leads/:id/assignment', {
    schema: { params: leadParam, body: { type: 'object', additionalProperties: false,
      required: ['version','agentId'], properties: {
        version: { type: 'integer', minimum: 1 }, agentId: { anyOf: [{ type: 'null' }, { type: 'string', format: 'uuid' }] },
        reason: { type: 'string', maxLength: 500 },
      } } },
  }, async (request) => {
    const actor = await principalFromRequest(request, db);
    return assignLead(db, actor, request, request.params.id, request.body);
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
      if (!await currentPaymentSession(tx,actor,request)) throw new HttpError(403,'LEAD_ACCESS_REVOKED');
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
      if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'FOLLOW_UP_ACCESS_REVOKED');
      const created=await createHumanFollowUp(tx,actor,lead as FollowUpLead,request.body);
      if(!await currentPaymentSession(tx,actor,request))throw new HttpError(403,'FOLLOW_UP_ACCESS_REVOKED');
      return created.id;
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
      if (!await currentPaymentSession(tx,actor,request)) throw new HttpError(403,'FOLLOW_UP_ACCESS_REVOKED');
      if (item.version !== request.body.version) throw new HttpError(409, 'FOLLOW_UP_VERSION_CONFLICT');
      if (item.status !== 'OPEN') throw new HttpError(409, 'FOLLOW_UP_NOT_OPEN');
      if (request.body.status === 'CANCELLED' && actor.role === 'AGENT') throw new HttpError(403, 'FOLLOW_UP_CANCEL_DENIED');
      const owner = request.body.ownerUserId ?? item.owner_user_id;
      if (request.body.ownerUserId && actor.role === 'AGENT' && owner !== actor.id) throw new HttpError(403, 'FOLLOW_UP_OWNER_DENIED');
      if (owner!==item.owner_user_id) await requireHumanFollowUpOwner(tx,actor,lead as FollowUpLead,owner);
      if (Object.keys(request.body).length === 1) throw new HttpError(400, 'FOLLOW_UP_NO_CHANGES');
      const status = request.body.status ?? item.status;
      const before = { dueAt: item.due_at.toISOString(), note: item.note, priority: item.priority, owner: item.owner_user_id, status: item.status };
      // Preserve native timestamp precision when only note/owner/priority/status changes.
      const changed = await tx`UPDATE follow_up SET due_at = CASE WHEN ${request.body.dueAt === undefined} THEN due_at ELSE ${request.body.dueAt ?? null}::timestamptz END,
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
    const rows = await db`SELECT h.id,h.actor_user_id,u.name AS actor_name,h.event_type,h.detail,h.created_at FROM follow_up_history h
      LEFT JOIN user_account u ON u.id=h.actor_user_id AND u.organization_id=${actor.organizationId}
      WHERE h.follow_up_id=${request.params.id} AND (${request.query.before??null}::bigint IS NULL OR h.id<${request.query.before??null})
      ORDER BY h.id DESC LIMIT ${limit+1}`;
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
      FROM follow_up f JOIN lead l ON l.id = f.lead_id LEFT JOIN contact c ON c.id = l.contact_id
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
