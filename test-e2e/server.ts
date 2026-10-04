// Test-only HTTP entrypoint. Never imported by the production server or workers.
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealSecret } from '../src/credentials.js';
import { passwordHash, safeTokenEqual, HttpError } from '../src/security.js';
import { processOneMessagingJob } from '../src/messaging/send-worker.js';
import { ProviderSendError } from '../src/messaging/providers.js';
import { requireLocalE2ETarget } from './guard.js';

const connectionUrl = requireLocalE2ETarget(process.env.TEST_DATABASE_URL,process.env.E2E_RESET_TEST_DATABASE,process.env.NODE_ENV);

process.env.APP_ORIGIN = 'http://127.0.0.1:4100';
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const db = createDatabase(connectionUrl);
const password = randomBytes(24).toString('hex'); const testToken = randomBytes(32).toString('hex');
const hash = await passwordHash(password);
await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`;
  await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
const org = (await db`INSERT INTO organization (name) VALUES ('Browser Test Organization') RETURNING id`)[0]!.id;
const branch = (await db`INSERT INTO branch (organization_id,name) VALUES (${org},'Browser Branch') RETURNING id`)[0]!.id;
const otherBranch = (await db`INSERT INTO branch (organization_id,name) VALUES (${org},'Other Branch') RETURNING id`)[0]!.id;
const users: Record<string,string> = {};
for (const [name,role,branchId] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],
  ['other','MANAGER',otherBranch],['agent','AGENT',branch],['second','AGENT',branch]] as const)
  users[name] = (await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
    VALUES (${org},${branchId},${'Browser '+name},${role},${name+'@browser.test'},${hash}) RETURNING id`)[0]!.id;
const campaign = (await db`INSERT INTO campaign (organization_id,branch_id,name,status,messaging_config)
  VALUES (${org},${branch},'Browser Campaign','ACTIVE','{"enabled":true}'::jsonb) RETURNING id`)[0]!.id;
const connection = (await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status,config)
  VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Browser Connection','CONNECTED',
    '{"graphVersion":"v25.0","wabaId":"123456789"}'::jsonb) RETURNING id`)[0]!.id;
const secret = sealSecret(connection, JSON.stringify({ accessToken:'test-fake-token-not-a-real-account' }));
await db`INSERT INTO connection_secret (connection_id,ciphertext,nonce,auth_tag)
  VALUES (${connection},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
const sender = (await db`INSERT INTO messaging_sender
  (organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
  VALUES (${org},${connection},'15550001111','Browser Sender','HEALTHY',true,'{"text":true}'::jsonb) RETURNING id`)[0]!.id;
await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
const contact = (await db`INSERT INTO contact (organization_id,name,phone,phone_normalized)
  VALUES (${org},'Browser Customer','+15550002222','+15550002222') RETURNING id`)[0]!.id;
await db`INSERT INTO messaging_consent (contact_id,channel,status,source) VALUES (${contact},'WHATSAPP','GRANTED','TEST')`;
const lead = (await db`INSERT INTO lead (organization_id,branch_id,campaign_id,contact_id,source_kind,assigned_agent_id)
  VALUES (${org},${branch},${campaign},${contact},'MANUAL',${users.agent!}) RETURNING id`)[0]!.id;
const cv = (await db`INSERT INTO conversation (lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
  VALUES (${lead},${connection},${sender},'WHATSAPP','+15550002222','HUMAN',${users.agent!},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
const untrusted = '<img src=x onerror="window.__customerXss=true"> Customer content';
await db`INSERT INTO conversation_message
  (conversation_id,connection_id,sender_id,direction,author_type,body,provider_message_id,delivery_state,received_at)
  VALUES (${cv},${connection},${sender},'INBOUND','CUSTOMER',${untrusted},'wamid.browser-inbound','RECEIVED',now()-interval '1 second')`;
let mode: 'accept'|'reject'|'unknown' = 'reject'; let providerCalls = 0;
const app = await buildApp(db, { logger:false,globalRateLimitMax:10000 });
app.get('/',async (_request,reply)=>reply.type('text/html').send(await readFile(resolve('dist-web/index.html'))));
app.get<{ Params:{ name:string } }>('/assets/:name',async (request,reply)=> {
  if (!/^[A-Za-z0-9_.-]+\.(js|css)$/.test(request.params.name)) throw new HttpError(404,'ASSET_NOT_FOUND');
  const type = request.params.name.endsWith('.js') ? 'text/javascript' : 'text/css';
  return reply.type(type).send(await readFile(resolve('dist-web/assets',request.params.name)));
});
app.post<{ Body:{ process?:boolean; mode?:'accept'|'reject'|'unknown'; dnc?:boolean; assigned?:'agent'|'second' } }>(
  '/__test__/control', { schema: { body:{ type:'object',additionalProperties:false,properties: {
    process:{ type:'boolean' },mode:{ type:'string',enum:['accept','reject','unknown'] },
    dnc:{ type:'boolean' },assigned:{ type:'string',enum:['agent','second'] },
  } } } },async (request)=> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !safeTokenEqual(header,'Bearer '+testToken)) throw new HttpError(403,'TEST_CONTROL_DENIED');
    if (request.body.mode) mode=request.body.mode;
    if (typeof request.body.dnc === 'boolean')
      await db`UPDATE messaging_consent SET do_not_contact=${request.body.dnc} WHERE contact_id=${contact}`;
    if (request.body.assigned) await db`UPDATE lead SET assigned_agent_id=${users[request.body.assigned]!} WHERE id=${lead}`;
    if (request.body.process) await processOneMessagingJob(db,{ sendText:async()=> {
      providerCalls++;
      if (mode === 'reject') throw new ProviderSendError('REJECTED','PROVIDER_SEND_REJECTED');
      if (mode === 'unknown') throw new ProviderSendError('UNKNOWN','SEND_OUTCOME_UNKNOWN');
      return { providerMessageId:'wamid.browser-'+providerCalls };
    } });
    const messages = await db`SELECT id,body,delivery_state FROM conversation_message WHERE direction='OUTBOUND' ORDER BY created_at,id`;
    const recoveries = (await db`SELECT count(*)::integer AS n FROM outbound_message_recovery`)[0]!.n;
    return { providerCalls,messages,recoveries };
  });
await mkdir(resolve('.local/e2e'),{ recursive:true });
await writeFile(resolve('.local/e2e/fixture.json'),JSON.stringify({ password,testToken,leadId:lead,conversationId:cv,untrusted }),{ mode:0o600 });
app.post('/__test__/stop',async(request,reply)=> {
  const header=request.headers.authorization;
  if (typeof header !== 'string' || !safeTokenEqual(header,'Bearer '+testToken)) throw new HttpError(403,'TEST_CONTROL_DENIED');
  reply.send({ stopping:true });
  setImmediate(()=> { void app.close().then(()=>db.end()); });
  return reply;
});
await app.listen({ host:'127.0.0.1',port:4100 });
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,async()=> { await app.close(); await db.end(); });
