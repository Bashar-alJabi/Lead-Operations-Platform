import type postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { HttpError,principalFromRequest,requireBranch,requireLead,requireRole,type Principal } from '../security.js';
import { decodeCursor,encodeCursor } from '../pagination.js';
import { currentPaymentActor } from '../payments/access.js';
import { normalizePaymentMethod,paymentCurrencies,paymentMethodIssues,type PaymentMethodInput } from '../payments/methods.js';
import { paymentMethodReadinessSql } from '../payments/readiness.js';
import { paypalCurrencies } from '../payments/issuance-profile.js';

const root='/api/payments/methods';
const uuid={ type:'string',format:'uuid' } as const;
const params={ type:'object',additionalProperties:false,required:['id'],properties:{ id:uuid } } as const;
const availability={ type:'object',additionalProperties:false,required:['mode','ids'],properties:{ mode:{ enum:['ALL','SELECTED'] },
  ids:{ type:'array',maxItems:200,uniqueItems:true,items:uuid } } } as const;
const body={ type:'object',additionalProperties:false,required:['name','branchId','connectionId','currencies','active','agents','campaigns','reason'],properties:{
  name:{ type:'string',minLength:1,maxLength:100 },branchId:uuid,connectionId:uuid,active:{ type:'boolean' },
  currencies:{ type:'array',minItems:1,maxItems:32,uniqueItems:true,items:{ type:'string',pattern:'^[A-Z]{3}$' } },
  agents:availability,campaigns:availability,reason:{ type:'string',minLength:3,maxLength:500 },version:{ type:'integer',minimum:1 } } } as const;
const pageSchema={ type:'object',additionalProperties:false,properties:{ limit:{ type:'integer',minimum:1,maximum:100 },cursor:{ type:'string',maxLength:256 },branchId:uuid } } as const;
type Page={ limit?:number;cursor?:string;branchId?:string };
function dto(row:postgres.Row) {
  const issues=paymentMethodIssues(row as Parameters<typeof paymentMethodIssues>[0]);
  return { id:row.id,name:row.name,branch_id:row.branch_id,connection_id:row.connection_id,connection_name:row.connection_name,
    connection_status:row.connection_status,provider:row.provider,version:row.version,active:row.active,currencies:row.currencies,
    agents:{ mode:row.agent_mode,ids:row.agent_ids },campaigns:{ mode:row.campaign_mode,ids:row.campaign_ids },created_at:row.created_at,
    available:issues.length===0,issues,agentSelections:row.agent_selections ?? [],campaignSelections:row.campaign_selections ?? [] };
}
async function managedMethod(sql:Database|postgres.TransactionSql,actor:Principal,id:string) {
  requireRole(actor,'SUPER_ADMIN','MANAGER');
  const row=(await sql`SELECT m.*,c.name AS connection_name,c.provider,c.status AS connection_status,c.capabilities,c.config,b.active AS branch_active,${paymentMethodReadinessSql(sql)},
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'active',u.active) ORDER BY u.name)
      FROM user_account u WHERE m.agent_ids ? u.id::text AND u.branch_id=m.branch_id AND u.organization_id=m.organization_id AND u.role='AGENT'),'[]'::jsonb) AS agent_selections,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ca.id,'name',ca.name,'status',ca.status) ORDER BY ca.name)
      FROM campaign ca WHERE m.campaign_ids ? ca.id::text AND ca.branch_id=m.branch_id AND ca.organization_id=m.organization_id),'[]'::jsonb) AS campaign_selections
    FROM payment_method m JOIN integration_connection c ON c.id=m.connection_id JOIN branch b ON b.id=m.branch_id
    WHERE m.id=${id} AND m.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR m.branch_id=${actor.branchId})`)[0];
  if (!row) throw new HttpError(404,'PAYMENT_METHOD_NOT_FOUND');return row;
}
export function registerPaymentMethodRoutes(app:FastifyInstance,db:Database) {
  app.get('/api/payments/currencies',async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');return { items:paymentCurrencies,providerSupportVerified:false };
  });
  app.get<{ Querystring:Page&{ kind:'CONNECTION'|'AGENT'|'CAMPAIGN';branchId:string;q?:string } }>('/api/payments/method-options',{
    schema:{ querystring:{ ...pageSchema,required:['branchId','kind'],properties:{ ...pageSchema.properties,kind:{ enum:['CONNECTION','AGENT','CAMPAIGN'] },q:{ type:'string',maxLength:100 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');requireBranch(actor,request.query.branchId);
    const branch=(await db`SELECT id FROM branch WHERE id=${request.query.branchId} AND organization_id=${actor.organizationId}`)[0];
    if (!branch) throw new HttpError(404,'BRANCH_NOT_FOUND');
    const { kind,branchId }=request.query;const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 30;
    const pattern='%'+(request.query.q ?? '').replace(/[\\%_]/g,'\\$&')+'%';
    const rows=kind==='CONNECTION' ? await db`SELECT id,name,provider,status,branch_id,created_at FROM integration_connection
      WHERE organization_id=${actor.organizationId} AND kind='PAYMENT' AND (branch_id=${branchId} OR (${actor.role==='SUPER_ADMIN'} AND branch_id IS NULL))
        AND name ILIKE ${pattern} AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY created_at DESC,id DESC LIMIT ${limit+1}` : kind==='AGENT' ? await db`SELECT id,name,active,created_at FROM user_account
      WHERE organization_id=${actor.organizationId} AND branch_id=${branchId} AND role='AGENT' AND name ILIKE ${pattern}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY created_at DESC,id DESC LIMIT ${limit+1}` : await db`SELECT id,name,status,created_at FROM campaign
      WHERE organization_id=${actor.organizationId} AND branch_id=${branchId} AND name ILIKE ${pattern}
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (created_at,id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);return { items,nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null };
  });
  app.get<{ Querystring:Page }>(root,{ schema:{ querystring:pageSchema } },async(request)=> {
    const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');if(request.query.branchId)requireBranch(actor,request.query.branchId);
    const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT m.*,c.name AS connection_name,c.provider,c.status AS connection_status,c.capabilities,c.config,b.active AS branch_active,${paymentMethodReadinessSql(db)}
      FROM payment_method m JOIN integration_connection c ON c.id=m.connection_id JOIN branch b ON b.id=m.branch_id
      WHERE m.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR m.branch_id=${actor.branchId})
        AND (${request.query.branchId ?? null}::uuid IS NULL OR m.branch_id=${request.query.branchId ?? null})
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (m.created_at,m.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY m.created_at DESC,m.id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);return { items:items.map(dto),nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null };
  });
  app.get<{ Params:{ id:string } }>(root+'/:id',{ schema:{ params } },async(request)=>dto(await managedMethod(db,await principalFromRequest(request,db),request.params.id)));
  app.get<{ Params:{ id:string };Querystring:{ limit?:number;before?:number } }>(root+'/:id/history',{
    schema:{ params,querystring:{ type:'object',additionalProperties:false,properties:{ limit:{ type:'integer',minimum:1,maximum:100 },before:{ type:'integer',minimum:1 } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);await managedMethod(db,actor,request.params.id);const limit=request.query.limit ?? 20;
    const rows=await db`SELECT h.version,h.reason,h.snapshot,h.created_at,h.actor_user_id FROM payment_method_history h JOIN payment_method m ON m.id=h.method_id
      WHERE m.id=${request.params.id} AND m.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR m.branch_id=${actor.branchId})
        AND (${request.query.before ?? null}::integer IS NULL OR h.version<${request.query.before ?? null}) ORDER BY h.version DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);return { items,nextVersion:rows.length>limit ? items.at(-1)!.version : null };
  });
  for (const update of [false,true]) app.route<{ Params:{ id:string };Body:PaymentMethodInput }>({ method:update ? 'PUT' : 'POST',url:root+(update ? '/:id' : ''),
    schema:{ ...(update ? { params } : {}),body:{ ...body,required:[...body.required,...(update ? ['version'] : [])] } },handler:async(request,reply)=> {
      const actor=await principalFromRequest(request,db);requireRole(actor,'SUPER_ADMIN','MANAGER');const input=normalizePaymentMethod(request.body);requireBranch(actor,input.branchId);
      const initial=update ? await managedMethod(db,actor,request.params.id) : null;
      if(initial && initial.branch_id!==input.branchId)throw new HttpError(400,'PAYMENT_METHOD_SCOPE_IMMUTABLE');
      const result=await db.begin(async(tx)=> {
        const connection=(await tx`SELECT * FROM integration_connection WHERE id=${input.connectionId} AND organization_id=${actor.organizationId} AND kind='PAYMENT'
          AND (branch_id=${input.branchId} OR (branch_id IS NULL AND (${actor.role==='SUPER_ADMIN'} OR id=${initial?.connection_id ?? null}::uuid))) FOR SHARE`)[0];
        if (!connection) throw new HttpError(404,'PAYMENT_CONNECTION_NOT_AVAILABLE');
        const branch=(await tx`SELECT * FROM branch WHERE id=${input.branchId} AND organization_id=${actor.organizationId} FOR SHARE`)[0];
        if (!branch) throw new HttpError(404,'BRANCH_NOT_FOUND');
        const current=initial ? (await tx`SELECT * FROM payment_method WHERE id=${initial.id} FOR UPDATE`)[0]! : null;
        if (!(await currentPaymentActor(tx,actor,request)))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
        if(current && current.version!==input.version)throw new HttpError(409,'PAYMENT_METHOD_VERSION_CONFLICT');
        // A Manager retaining a shared binding may not substitute another Connection after a concurrent rebind.
        if(actor.role!=='SUPER_ADMIN' && connection.branch_id===null && current?.connection_id!==connection.id)throw new HttpError(403,'PAYMENT_SHARED_METHOD_BINDING_FORBIDDEN');
        if(!branch.active && (input.active || !current))throw new HttpError(409,'BRANCH_DISABLED');
        if(connection.status==='DISABLED' && (input.active || current?.connection_id!==connection.id))throw new HttpError(409,'CONNECTION_DISABLED');
        const offered=connection.provider==='PAYPAL' ? paypalCurrencies : connection.capabilities.paymentOptionsVersion===connection.version ? connection.capabilities.paymentOptions?.currencies : null;
        if(input.active && Array.isArray(offered) && input.currencies.some((code)=>!offered.includes(code)))throw new HttpError(400,'PAYMENT_CURRENCY_NOT_OFFERED');
        const agents=await tx`SELECT id FROM user_account WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${tx.json(input.agents.ids)}) x(value))
          AND organization_id=${actor.organizationId} AND branch_id=${input.branchId} AND role='AGENT' ORDER BY id FOR SHARE`;
        const campaigns=await tx`SELECT id FROM campaign WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${tx.json(input.campaigns.ids)}) x(value))
          AND organization_id=${actor.organizationId} AND branch_id=${input.branchId} ORDER BY id FOR SHARE`;
        if(agents.length!==input.agents.ids.length || campaigns.length!==input.campaigns.ids.length)throw new HttpError(400,'PAYMENT_AVAILABILITY_SCOPE_INVALID');
        if (!(await currentPaymentActor(tx,actor,request)))throw new HttpError(403,'PAYMENT_ACCESS_REVOKED');
        const saved=current ? (await tx`UPDATE payment_method SET name=${input.name},connection_id=${connection.id},currencies=${tx.json(input.currencies)},active=${input.active},
          agent_mode=${input.agents.mode},agent_ids=${tx.json(input.agents.ids)},campaign_mode=${input.campaigns.mode},campaign_ids=${tx.json(input.campaigns.ids)},version=version+1,
          updated_by=${actor.id},change_reason=${input.reason},updated_at=clock_timestamp() WHERE id=${current.id} RETURNING id,version`)[0]!
          : (await tx`INSERT INTO payment_method(organization_id,branch_id,connection_id,name,currencies,active,agent_mode,agent_ids,campaign_mode,campaign_ids,updated_by,change_reason)
            VALUES (${actor.organizationId},${input.branchId},${connection.id},${input.name},${tx.json(input.currencies)},${input.active},${input.agents.mode},${tx.json(input.agents.ids)},
              ${input.campaigns.mode},${tx.json(input.campaigns.ids)},${actor.id},${input.reason}) RETURNING id,version`)[0]!;
        await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
          VALUES (${actor.organizationId},${input.branchId},${actor.id},${current ? 'PAYMENT_METHOD_UPDATED' : 'PAYMENT_METHOD_CREATED'},'PAYMENT_METHOD',${saved.id},
            ${tx.json({ version:saved.version,reason:input.reason,connectionId:connection.id })})`;return saved;
      });if(!update)reply.code(201);return result;
    },
  });
  app.get<{ Params:{ id:string };Querystring:Page&{ currency?:string } }>('/api/leads/:id/payment-methods',{
    schema:{ params,querystring:{ ...pageSchema,properties:{ limit:pageSchema.properties.limit,cursor:pageSchema.properties.cursor,currency:{ type:'string',enum:paymentCurrencies } } } },
  },async(request)=> {
    const actor=await principalFromRequest(request,db);await requireLead(db,actor,request.params.id);const cursor=decodeCursor(request.query.cursor);const limit=request.query.limit ?? 30;
    const rows=await db`SELECT m.id,m.name,m.currencies,m.version,m.active,m.created_at,c.provider,c.status AS connection_status,c.capabilities,c.config,b.active AS branch_active,${paymentMethodReadinessSql(db)}
      FROM lead l JOIN payment_method m ON m.branch_id=l.branch_id AND m.organization_id=l.organization_id
      JOIN integration_connection c ON c.id=m.connection_id AND c.organization_id=m.organization_id AND c.kind='PAYMENT' AND (c.branch_id IS NULL OR c.branch_id=m.branch_id)
      JOIN branch b ON b.id=m.branch_id JOIN user_account u ON u.id=${actor.id} AND u.active AND u.role=${actor.role} AND u.organization_id=${actor.organizationId}
        AND u.branch_id IS NOT DISTINCT FROM ${actor.branchId}::uuid
      WHERE l.id=${request.params.id} AND l.organization_id=${actor.organizationId} AND m.active
        AND (${actor.role==='SUPER_ADMIN'} OR (${actor.role==='MANAGER'} AND l.branch_id=${actor.branchId}) OR (${actor.role==='AGENT'} AND l.assigned_agent_id=${actor.id} AND u.branch_id=l.branch_id))
        AND (m.campaign_mode='ALL' OR m.campaign_ids ? l.campaign_id::text)
        AND (${actor.role!=='AGENT'} OR m.agent_mode='ALL' OR m.agent_ids ? ${actor.id}::text)
        AND (${request.query.currency ?? null}::text IS NULL OR m.currencies ? ${request.query.currency ?? null}::text)
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR (m.created_at,m.id)<(${cursor?.timestamp ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      ORDER BY m.created_at DESC,m.id DESC LIMIT ${limit+1}`;
    const items=rows.slice(0,limit);const last=items.at(-1);return { items:items.map((row)=> {
      const issues=paymentMethodIssues(row as Parameters<typeof paymentMethodIssues>[0]);return { id:row.id,name:row.name,currencies:row.currencies,version:row.version,available:issues.length===0,issues };
    }),nextCursor:rows.length>limit && last ? encodeCursor({ timestamp:last.created_at.toISOString(),id:last.id }) : null };
  });
}
