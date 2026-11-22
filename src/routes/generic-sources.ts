import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import type { Database } from '../db.js';
import { openSecret, sealSecret } from '../credentials.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import { HttpError, lockCurrentSession, principalFromRequest, requireRole, type Principal } from '../security.js';
import { verifyGenericSourceTestSignature } from '../sources/generic-signing.js';

const root = '/api/sources/generic/connections';
const uuid = { type: 'string', format: 'uuid' } as const;
const uuidPattern = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const reason = { type: 'string', minLength: 3, maxLength: 500, pattern: '^[^\\x00-\\x1f\\x7f]+$' } as const;
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } } as const;
const page = { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', maxLength: 256 },
  limit: { type: 'integer', minimum: 1, maximum: 50 } } } as const;
type Page = { cursor?: string; limit?: number };
type Change = { version: number; reason: string };
type SchemaChange = Change & { connectionVersion: number; keys: string[] };
const callbackPath = (id: string) => '/api/webhooks/sources/generic/' + id + '/test';

async function currentSession(tx: postgres.TransactionSql, actor: Principal, request: FastifyRequest) {
  const session = await lockCurrentSession(tx, actor, request);
  if (!session) throw new HttpError(403, 'GENERIC_SOURCE_ACCESS_REVOKED');
  return session;
}

async function connectionForActor(tx: postgres.TransactionSql, actor: Principal, id: string, write = false) {
  const [c] = await tx`SELECT c.id,c.branch_id,c.version,c.status,b.active AS branch_active
    FROM integration_connection c JOIN branch b ON (b.id,b.organization_id)=(c.branch_id,c.organization_id)
    WHERE c.id=${id} AND c.organization_id=${actor.organizationId} AND c.kind='GENERIC_SOURCE' AND c.provider='SIGNED_WEBHOOK'
    AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})
    ${write ? tx`FOR UPDATE OF c FOR SHARE OF b` : tx`FOR SHARE OF c,b`}`;
  if (!c) throw new HttpError(404, 'GENERIC_SOURCE_NOT_FOUND');
  return c;
}

function checkedReason(input: string) {
  const value = input.trim();
  if (value.length < 3) throw new HttpError(400, 'REASON_REQUIRED');
  return value;
}

async function issueSecret(tx: postgres.TransactionSql, id: string) {
  const secret = randomBytes(32).toString('hex');
  const sealed = sealSecret(id, secret);
  await tx`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag,key_version)
    VALUES(${id},${sealed.ciphertext},${sealed.nonce},${sealed.authTag},${sealed.keyVersion})
    ON CONFLICT(connection_id) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,
      key_version=excluded.key_version,updated_at=clock_timestamp()`;
  return secret;
}

function paged(rows: postgres.Row[], limit: number, idColumn: string) {
  const items = rows.slice(0,limit);
  const last = items.at(-1);
  return { items, nextCursor: last && rows.length>limit ? encodeCursor({ timestamp:last.cursor_at,id:last[idColumn] }) : null };
}

export function registerGenericSourceRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Querystring: Page }>(root, { schema: { querystring: page } }, async(request,reply) => {
    const actor = await principalFromRequest(request,db);
    requireRole(actor,'SUPER_ADMIN','MANAGER');
    reply.header('Cache-Control','no-store');
    const cursor = decodeCursor(request.query.cursor), limit = request.query.limit ?? 25;
    return db.begin(async tx => {
      await currentSession(tx,actor,request);
      const rows = await tx`SELECT c.id,c.name,c.branch_id AS "branchId",c.status,c.version,
        c.last_success_at AS "lastTestAt",c.created_at::text AS cursor_at,b.active AS "branchActive"
        FROM integration_connection c JOIN branch b ON (b.id,b.organization_id)=(c.branch_id,c.organization_id)
        WHERE c.kind='GENERIC_SOURCE' AND c.provider='SIGNED_WEBHOOK' AND c.organization_id=${actor.organizationId}
          AND (${actor.role==='SUPER_ADMIN'} OR c.branch_id=${actor.branchId})
          AND (${cursor?.timestamp??null}::text::timestamptz IS NULL OR
            (c.created_at,c.id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
        ORDER BY c.created_at DESC,c.id DESC LIMIT ${limit+1}`;
      const result = paged(rows,limit,'id');
      return { ...result, items: result.items.map(({cursor_at,...item}) => ({...item,callbackPath:callbackPath(item.id)})) };
    });
  });

  app.post<{ Body: { branchId: string; name: string; reason: string } }>(root,{
    schema:{body:{type:'object',additionalProperties:false,required:['branchId','name','reason'],
      properties:{branchId:uuid,name:{type:'string',minLength:1,maxLength:120,pattern:'^[^\\x00-\\x1f\\x7f]+$'},reason}}},
    config:{rateLimit:{max:20,timeWindow:'15 minutes'}},
  },async(request,reply) => {
    const actor = await principalFromRequest(request,db);
    requireRole(actor,'SUPER_ADMIN','MANAGER');
    const id = randomUUID(), branchId = request.body.branchId.toLowerCase(), name = request.body.name.trim();
    const note = checkedReason(request.body.reason);
    if (!name) throw new HttpError(400,'GENERIC_SOURCE_NAME_REQUIRED');
    if (actor.role==='MANAGER' && actor.branchId!==branchId) throw new HttpError(404,'GENERIC_SOURCE_BRANCH_NOT_FOUND');
    const signingSecret = await db.begin(async tx => {
      const [branch] = await tx`SELECT active FROM branch WHERE id=${branchId} AND organization_id=${actor.organizationId} FOR SHARE`;
      if (!branch) throw new HttpError(404,'GENERIC_SOURCE_BRANCH_NOT_FOUND');
      if (!branch.active) throw new HttpError(409,'BRANCH_DISABLED');
      const session = await currentSession(tx,actor,request);
      await tx`INSERT INTO integration_connection(id,organization_id,branch_id,kind,provider,name,created_by)
        VALUES(${id},${actor.organizationId},${branchId},'GENERIC_SOURCE','SIGNED_WEBHOOK',${name},${actor.id})`;
      const secret = await issueSecret(tx,id);
      await tx`INSERT INTO generic_source_setup_revision(connection_id,version,operation,actor_id,session_id,reason)
        VALUES(${id},1,'CREATE',${actor.id},${session},${note})`;
      return secret;
    });
    reply.header('Cache-Control','no-store').code(201);
    return { id, version:1, signingSecret, callbackPath:callbackPath(id) };
  });

  for (const action of ['rotate','disable'] as const) {
    app.post<{ Params: {id:string}; Body: Change }>(root+'/:id/'+action,{
      schema:{params,body:{type:'object',additionalProperties:false,required:['version','reason'],properties:{
        version:{type:'integer',minimum:1},reason}}},
      config:{rateLimit:{max:20,timeWindow:'15 minutes'}},
    },async(request,reply) => {
      const actor = await principalFromRequest(request,db);
      requireRole(actor,'SUPER_ADMIN','MANAGER');
      const note = checkedReason(request.body.reason);
      reply.header('Cache-Control','no-store');
      return db.begin(async tx => {
        const c = await connectionForActor(tx,actor,request.params.id,true);
        const session = await currentSession(tx,actor,request);
        if (c.version!==request.body.version) throw new HttpError(409,'CONNECTION_VERSION_CONFLICT');
        const rotate = action==='rotate';
        if (rotate && !c.branch_active) throw new HttpError(409,'BRANCH_DISABLED');
        if (!rotate && c.status==='DISABLED') throw new HttpError(409,'GENERIC_SOURCE_DISABLED');
        const [changed] = await tx`UPDATE integration_connection SET version=version+1,
          status=${rotate?'NOT_CONFIGURED':'DISABLED'},last_success_at=NULL,updated_at=clock_timestamp()
          WHERE id=${c.id} RETURNING version,status`;
        const signingSecret = rotate ? await issueSecret(tx,c.id) : undefined;
        await tx`INSERT INTO generic_source_setup_revision(connection_id,version,operation,actor_id,session_id,reason)
          VALUES(${c.id},${changed!.version},${rotate?'ROTATE':'DISABLE'},${actor.id},${session},${note})`;
        return { id:c.id, version:changed!.version, status:changed!.status, signingSecret, callbackPath:callbackPath(c.id) };
      });
    });
  }

  app.get<{ Params:{id:string}; Querystring:Page }>(root+'/:id/tests',{schema:{params,querystring:page}},async(request,reply) => {
    const actor = await principalFromRequest(request,db);
    requireRole(actor,'SUPER_ADMIN','MANAGER');
    reply.header('Cache-Control','no-store');
    const cursor = decodeCursor(request.query.cursor),limit=request.query.limit??25;
    return db.begin(async tx => {
      const c=await connectionForActor(tx,actor,request.params.id);
      await currentSession(tx,actor,request);
      const rows=await tx`SELECT test_id AS "testId",connection_version AS "connectionVersion",received_at AS "receivedAt",
        received_at::text AS cursor_at,connection_version=${c.version} AND ${c.status!=='DISABLED' && c.branch_active} AS current
        FROM generic_source_test_receipt WHERE connection_id=${c.id}
        AND (${cursor?.timestamp??null}::text::timestamptz IS NULL OR
          (received_at,test_id)<(${cursor?.timestamp??null}::text::timestamptz,${cursor?.id??null}::uuid))
        ORDER BY received_at DESC,test_id DESC LIMIT ${limit+1}`;
      const result=paged(rows,limit,'testId');
      return {...result,items:result.items.map(({cursor_at,...item})=>item)};
    });
  });

  app.get<{ Params: { id: string } }>(root+'/:id/schema',{schema:{params}},async(request,reply) => {
    const actor=await principalFromRequest(request,db);
    requireRole(actor,'SUPER_ADMIN','MANAGER');
    reply.header('Cache-Control','no-store');
    return db.begin(async tx => {
      const c=await connectionForActor(tx,actor,request.params.id);
      await currentSession(tx,actor,request);
      const [resource]=await tx`SELECT id,version,connection_version AS "connectionVersion",questions FROM source_resource
        WHERE connection_id=${c.id} AND resource_kind='WEBHOOK_SCHEMA'`;
      return {
        schema: resource ? { ...resource, current:c.branch_active && c.status==='CONNECTED' && c.version===resource.connectionVersion } : null,
        version:c.version, canSave:c.branch_active && c.status==='CONNECTED',
      };
    });
  });

  app.put<{ Params: { id: string }; Body: SchemaChange }>(root+'/:id/schema',{
    schema:{params,body:{type:'object',additionalProperties:false,required:['version','connectionVersion','keys','reason'],properties:{
      version:{type:'integer',minimum:0},connectionVersion:{type:'integer',minimum:1},reason,
      keys:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'string',pattern:'^[a-z][a-z0-9_]{0,63}$'}},
    }}},config:{rateLimit:{max:20,timeWindow:'15 minutes'}},
  },async(request,reply) => {
    const actor=await principalFromRequest(request,db);
    requireRole(actor,'SUPER_ADMIN','MANAGER');
    reply.header('Cache-Control','no-store');
    const input=request.body, note=checkedReason(input.reason);
    const questions=input.keys.map(key=>({ key, externalId:null, label:key, type:'CUSTOM', options:[] }));
    return db.begin(async tx => {
      const c=await connectionForActor(tx,actor,request.params.id,true);
      const session=await currentSession(tx,actor,request);
      if (c.version!==input.connectionVersion) throw new HttpError(409,'CONNECTION_VERSION_CONFLICT');
      if (!c.branch_active || c.status!=='CONNECTED') throw new HttpError(409,'GENERIC_SOURCE_TEST_REQUIRED');
      const [old]=await tx`SELECT id,version FROM source_resource WHERE connection_id=${c.id} AND resource_kind='WEBHOOK_SCHEMA'`;
      if ((old?.version??0)!==input.version) throw new HttpError(409,'GENERIC_SOURCE_SCHEMA_VERSION_CONFLICT');
      const [resource]=old ? await tx`UPDATE source_resource SET questions=${tx.json(questions)},version=version+1,
        connection_version=${c.version},last_synced_at=clock_timestamp() WHERE id=${old.id} RETURNING id,version`
        : await tx`INSERT INTO source_resource(connection_id,resource_kind,external_id,name,connection_version,questions)
          VALUES(${c.id},'WEBHOOK_SCHEMA','webhook','Webhook fields',${c.version},${tx.json(questions)}) RETURNING id,version`;
      await tx`INSERT INTO generic_source_schema_revision(resource_id,version,connection_version,actor_id,session_id,reason,questions)
        VALUES(${resource!.id},${resource!.version},${c.version},${actor.id},${session},${note},${tx.json(questions)})`;
      return { id:resource!.id,version:resource!.version };
    });
  });

  app.register(async webhook => {
    webhook.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
    webhook.post<{Params:{id:string};Body:Buffer}>('/api/webhooks/sources/generic/:id/test',{
      schema:{params},bodyLimit:1024,config:{rateLimit:{max:30,timeWindow:'1 minute'}},
    },async(request,reply)=>{
      if (!Buffer.isBuffer(request.body)) throw new HttpError(400,'GENERIC_SOURCE_TEST_PAYLOAD_INVALID');
      const result=await db.begin(async tx=>{
        const [c]=await tx`SELECT c.id,c.version,s.ciphertext,s.nonce,s.auth_tag,s.key_version,
          extract(epoch FROM clock_timestamp())::text AS now_seconds
          FROM integration_connection c JOIN branch b ON (b.id,b.organization_id)=(c.branch_id,c.organization_id)
          JOIN connection_secret s ON s.connection_id=c.id WHERE c.id=${request.params.id}
          AND c.kind='GENERIC_SOURCE' AND c.provider='SIGNED_WEBHOOK' AND c.status IN ('NOT_CONFIGURED','CONNECTED')
          AND b.active FOR UPDATE OF c FOR SHARE OF b,s`;
        if (!c) throw new HttpError(401,'GENERIC_SOURCE_SIGNATURE_INVALID');
        let secret: string;
        try { secret=openSecret(c.id,{ciphertext:c.ciphertext,nonce:c.nonce,authTag:c.auth_tag,keyVersion:c.key_version}); }
        catch { throw new HttpError(401,'GENERIC_SOURCE_SIGNATURE_INVALID'); }
        const signedAt=verifyGenericSourceTestSignature(request.body,c.id,secret,request.headers['x-source-timestamp'],
          request.headers['x-source-signature'],Number(c.now_seconds));
        if (signedAt===null) throw new HttpError(401,'GENERIC_SOURCE_SIGNATURE_INVALID');
        let raw:unknown;
        try { raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(request.body)); }
        catch { throw new HttpError(400,'GENERIC_SOURCE_TEST_PAYLOAD_INVALID'); }
        if (!raw || typeof raw!=='object' || Object.keys(raw).length!==1 || !('testId' in raw)
          || typeof raw.testId!=='string' || !uuidPattern.test(raw.testId)) throw new HttpError(400,'GENERIC_SOURCE_TEST_PAYLOAD_INVALID');
        const testId=raw.testId.toLowerCase(), digest=createHash('sha256').update(request.body).digest();
        const [previous]=await tx`SELECT connection_version,body_hash FROM generic_source_test_receipt
          WHERE connection_id=${c.id} AND test_id=${testId}`;
        if (previous) {
          if (previous.connection_version!==c.version || !digest.equals(previous.body_hash))
            throw new HttpError(409,'GENERIC_SOURCE_TEST_CONFLICT');
          return {testId,duplicate:true};
        }
        await tx`INSERT INTO generic_source_test_receipt(connection_id,test_id,connection_version,signed_at,body_hash)
          VALUES(${c.id},${testId},${c.version},to_timestamp(${signedAt}),${digest})`;
        return {testId,duplicate:false};
      });
      reply.header('Cache-Control','no-store').code(result.duplicate?200:202);
      return result;
    });
  });
}
