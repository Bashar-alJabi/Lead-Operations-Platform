import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,requireRole,sha256,type Principal } from '../security.js';
import { decodeCursor,encodeCursor } from '../pagination.js';
import { recheckSourceActor } from '../sources/catalog-sync.js';
import { evaluateSource } from '../sources/evaluation.js';
import { intakeSource,lockSourceIdentities,sourceCandidatePage } from '../sources/intake.js';
import { normalizeSourceContact } from '../contacts.js';
const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
// A Form grant alone never grants all submissions of an Organization connection.
function scope(db:Database,actor:Principal) {
  return db`c.organization_id=${actor.organizationId} AND s.organization_id=c.organization_id AND c.kind='META' AND c.provider='META_LEAD_ADS'
    AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId} OR (c.branch_id IS NULL AND p.branch_id=${actor.branchId}
      AND EXISTS (SELECT 1 FROM source_resource_access a WHERE a.resource_id=p.resource_id AND a.branch_id=${actor.branchId} AND a.active)))`;
}
async function accessible(db:Database,actor:Principal,id:string) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const [row]=await db`SELECT p.*,s.external_event_id,s.source_timestamp,s.created_at,s.lead_id FROM source_processing p
    JOIN source_submission s ON s.id=p.submission_id JOIN integration_connection c ON c.id=p.connection_id
    WHERE p.submission_id=${id} AND ${scope(db,actor)}`;
  if (!row) throw new HttpError(404,'SOURCE_SUBMISSION_NOT_FOUND');return row;
}
export function registerSourceReviewRoutes(app:FastifyInstance,db:Database):void {
  const root='/api/sources/submissions';
  app.get<{ Querystring:{ connectionId?:string;campaignId?:string;state?:string;cursor?:string;limit?:number } }>(root,{
    schema:{ querystring:{ type:'object',additionalProperties:false,properties:{ connectionId:uuid,campaignId:uuid,
      state:{ enum:['PENDING','VALIDATED','NEEDS_ATTENTION','PROCESSED'] },cursor:{ type:'string',maxLength:256 },limit:{ type:'integer',minimum:1,maximum:100 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const q=request.query;
    const cursor=decodeCursor(q.cursor);const limit=q.limit ?? 30;
    const rows=await db`SELECT p.submission_id,p.connection_id,p.state,p.version,p.evaluations,p.campaign_id,p.branch_id,p.binding_id,
      p.binding_version,p.mapping_version,p.connection_version,p.resource_version,p.error_code,p.codes,p.mapped_fields,p.mapped_contact_fields,p.intake_attempts,p.updated_at,
      s.external_event_id,s.source_timestamp,s.created_at,s.lead_id
      FROM source_processing p JOIN source_submission s ON s.id=p.submission_id JOIN integration_connection c ON c.id=p.connection_id
      WHERE ${scope(db,actor)} AND (${q.connectionId ?? null}::uuid IS NULL OR p.connection_id=${q.connectionId ?? null}::uuid)
        AND (${q.campaignId ?? null}::uuid IS NULL OR p.campaign_id=${q.campaignId ?? null}::uuid)
        AND (${q.state ?? null}::text IS NULL OR p.state=${q.state ?? null})
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (s.created_at,s.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY s.created_at DESC,s.id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);
    return { items,nextCursor:rows.length>limit ? encodeCursor({ timestamp:last!.created_at.toISOString(),id:last!.submission_id }) : null,processingAvailable:true };
  });
  async function matchingContext(sql:Database,actor:Principal,id:string) {
    const row=await accessible(sql,actor,id);
    if (row.lead_id) throw new HttpError(409,'SOURCE_SUBMISSION_ALREADY_PROCESSED');
    if (row.state!=='NEEDS_ATTENTION' || row.error_code!=='CONTACT_AMBIGUOUS') throw new HttpError(409,'SOURCE_CONTACT_REVIEW_NOT_OPEN');
    const [connection]=await sql`SELECT * FROM integration_connection WHERE id=${row.connection_id}`;
    const [submission]=await sql`SELECT * FROM source_submission WHERE id=${id} FOR UPDATE`;
    const outcome=await evaluateSource(sql,connection!,submission!,true);
    if (actor.role==='MANAGER' && outcome.branchId!==actor.branchId) throw new HttpError(404,'SOURCE_SUBMISSION_NOT_FOUND');
    if (!outcome.prepared || outcome.errorCode) throw new HttpError(409,outcome.errorCode ?? 'SOURCE_EVALUATION_REQUIRED');
    if (outcome.prepared.campaign.status!=='ACTIVE') throw new HttpError(409,'SOURCE_CAMPAIGN_INACTIVE');
    const contact=normalizeSourceContact(outcome.prepared.contact);await lockSourceIdentities(sql,actor.organizationId,contact);
    const fingerprint=sha256(JSON.stringify([outcome.connectionVersion,outcome.resourceVersion,outcome.bindingId,outcome.bindingVersion,outcome.mappingVersion,contact])).toString('hex');
    return { row,connection:connection!,submission:submission!,contact,fingerprint };
  }
  app.get<{ Params:{ id:string };Querystring:{ after?:string;limit?:number } }>(root+'/:id/contact-review',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ after:uuid,limit:{ type:'integer',minimum:1,maximum:100 } } } },
    config:{ rateLimit:{ max:30,timeWindow:'15 minutes' } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const initial=await accessible(db,actor,request.params.id);
    return db.begin(async(tx)=> {
      const sql=tx as unknown as Database;await tx`SELECT id FROM integration_connection WHERE id=${initial.connection_id} FOR UPDATE`;
      await recheckSourceActor(sql,actor);await tx`SELECT submission_id FROM source_processing WHERE submission_id=${initial.submission_id} FOR UPDATE`;
      const context=await matchingContext(sql,actor,initial.submission_id);
      return { version:context.row.version,fingerprint:context.fingerprint,contact:context.contact && { name:context.contact.name,phone:context.contact.phone,email:context.contact.email },
        ...await sourceCandidatePage(sql,actor.organizationId,context.contact,actor,request.query.after ?? null,request.query.limit ?? 30) };
    });
  });
  app.post<{ Params:{ id:string };Body:{ version:number;fingerprint:string;contactId:string;reason:string } }>(root+'/:id/resolve-contact',{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','fingerprint','contactId','reason'],properties:{ version:{ type:'integer',minimum:1 },
      fingerprint:{ type:'string',pattern:'^[a-f0-9]{64}$' },contactId:uuid,reason:{ type:'string',minLength:1,maxLength:500 } } } },
    config:{ rateLimit:{ max:20,timeWindow:'15 minutes' } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const initial=await accessible(db,actor,request.params.id);
    if (!request.body.reason.trim()) throw new HttpError(400,'SOURCE_CHANGE_REASON_REQUIRED');
    return db.begin(async(tx)=> {
      const sql=tx as unknown as Database;await tx`SELECT id FROM integration_connection WHERE id=${initial.connection_id} FOR UPDATE`;
      await recheckSourceActor(sql,actor);await tx`SELECT submission_id FROM source_processing WHERE submission_id=${initial.submission_id} FOR UPDATE`;
      const context=await matchingContext(sql,actor,initial.submission_id);
      if (context.row.version!==request.body.version) throw new HttpError(409,'SOURCE_PROCESSING_VERSION_CONFLICT');
      if (context.fingerprint!==request.body.fingerprint) throw new HttpError(409,'SOURCE_CONTACT_MATCH_CHANGED');
      return intakeSource(tx,context.connection,context.row,context.submission,actor,{ contactId:request.body.contactId,reason:request.body.reason.trim() });
    });
  });
  app.get<{ Params:{ id:string };Querystring:{ beforeVersion?:number;limit?:number } }>(root+'/:id/history',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ beforeVersion:{ type:'integer',minimum:1 },limit:{ type:'integer',minimum:1,maximum:100 } } } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const current=await accessible(db,actor,request.params.id);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT h.version,h.state,h.snapshot,h.actor_user_id,h.reason,h.created_at FROM source_processing_history h
      JOIN source_processing p ON p.submission_id=h.submission_id JOIN source_submission s ON s.id=p.submission_id
      JOIN integration_connection c ON c.id=p.connection_id
      WHERE h.submission_id=${current.submission_id} AND ${scope(db,actor)}
        AND (${request.query.beforeVersion ?? null}::integer IS NULL OR h.version<${request.query.beforeVersion ?? null})
        AND (${actor.role==='SUPER_ADMIN'} OR h.branch_id=${actor.branchId} OR (c.branch_id=${actor.branchId} AND h.branch_id IS NULL))
      ORDER BY h.version DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextBefore:rows.length>limit ? items.at(-1)!.version : null };
  });
  app.post<{ Params:{ id:string };Body:{ version:number;reason:string } }>(root+'/:id/reprocess',{
    schema:{ params,body:{ type:'object',additionalProperties:false,required:['version','reason'],properties:{ version:{ type:'integer',minimum:1 },reason:{ type:'string',minLength:1,maxLength:500 } } } },
    config:{ rateLimit:{ max:20,timeWindow:'15 minutes' } } },async(request)=> {
    const actor=await principalFromRequest(request,db);const initial=await accessible(db,actor,request.params.id);
    if (!request.body.reason.trim()) throw new HttpError(400,'SOURCE_CHANGE_REASON_REQUIRED');
    return db.begin(async(tx)=> {
      const sql=tx as unknown as Database;await tx`SELECT id FROM integration_connection WHERE id=${initial.connection_id} FOR UPDATE`;
      await recheckSourceActor(sql,actor);await tx`SELECT submission_id FROM source_processing WHERE submission_id=${initial.submission_id} FOR UPDATE`;
      const row=await accessible(sql,actor,initial.submission_id);
      if (row.version!==request.body.version) throw new HttpError(409,'SOURCE_PROCESSING_VERSION_CONFLICT');
      if (row.lead_id) throw new HttpError(409,'SOURCE_SUBMISSION_ALREADY_PROCESSED');
      if (row.state==='PENDING') throw new HttpError(409,'SOURCE_PROCESSING_PENDING');
      await tx`UPDATE source_processing SET state='PENDING',error_code=NULL,codes='[]'::jsonb,version=version+1,
        actor_user_id=${actor.id},reason=${request.body.reason.trim()},updated_at=now() WHERE submission_id=${row.submission_id}`;
      await tx`INSERT INTO audit_log (organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
        VALUES (${actor.organizationId},${row.branch_id ?? actor.branchId},${actor.id},'SOURCE_REPROCESS_REQUESTED','SOURCE_SUBMISSION',${row.submission_id},
          ${tx.json({ previousVersion:row.version,reason:request.body.reason.trim() })})`;
      return { version:row.version+1,state:'PENDING' };
    });
  });
}
