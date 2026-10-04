// Test-only HTTP entrypoint. Never imported by the production server or workers.
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealSecret } from '../src/credentials.js';
import { passwordHash, safeTokenEqual, HttpError } from '../src/security.js';
import { processOneMessagingJob } from '../src/messaging/send-worker.js';
import { ProviderSendError } from '../src/messaging/providers.js';
import { requireLocalE2ETarget } from './guard.js';
import { metaMediaCapabilities } from '../src/media/meta-outbound.js';
import { localMediaStorage } from '../src/media/storage.js';
import type { ProviderTemplate } from '../src/messaging/templates-provider.js';
import { renderTemplateUrl } from '../src/messaging/approved-template.js';

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
  VALUES (${org},${connection},'15550001111','Browser Sender','HEALTHY',true,${db.json({ text:true,...metaMediaCapabilities() })}) RETURNING id`)[0]!.id;
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
const mediaContact=(await db`INSERT INTO contact (organization_id,name,phone,phone_normalized)
  VALUES (${org},'Browser Media Customer','+15550004444','+15550004444') RETURNING id`)[0]!.id;
await db`INSERT INTO messaging_consent (contact_id,channel,status,source) VALUES (${mediaContact},'WHATSAPP','GRANTED','TEST')`;
const mediaCampaign=(await db`INSERT INTO campaign (organization_id,branch_id,name,status,messaging_config)
  VALUES (${org},${branch},'Browser Media Campaign','ACTIVE','{"enabled":true}'::jsonb) RETURNING id`)[0]!.id;
const mediaLead=(await db`INSERT INTO lead (organization_id,branch_id,campaign_id,contact_id,source_kind,assigned_agent_id)
  VALUES (${org},${branch},${mediaCampaign},${mediaContact},'MANUAL',${users.agent!}) RETURNING id`)[0]!.id;
// Independent synthetic connection: the text journey deliberately leaves its connection WARNING after UNKNOWN.
const mediaConnection=(await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status,config)
  VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Browser Media Connection','CONNECTED',
    '{"graphVersion":"v25.0","wabaId":"987654321"}'::jsonb) RETURNING id`)[0]!.id;
const mediaSecret=sealSecret(mediaConnection,JSON.stringify({ accessToken:'test-only-media-fake' }));
await db`INSERT INTO connection_secret (connection_id,ciphertext,nonce,auth_tag)
  VALUES (${mediaConnection},${mediaSecret.ciphertext},${mediaSecret.nonce},${mediaSecret.authTag})`;
const mediaSender=(await db`INSERT INTO messaging_sender
  (organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
  VALUES (${org},${mediaConnection},'15550005555','Browser Media Sender','HEALTHY',true,
    ${db.json({ text:true,template:true,...metaMediaCapabilities() })}) RETURNING id`)[0]!.id;
await db`UPDATE campaign SET sender_override_id=${mediaSender} WHERE id=${mediaCampaign}`;
const mediaCv=(await db`INSERT INTO conversation (lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
  VALUES (${mediaLead},${mediaConnection},${mediaSender},'WHATSAPP','+15550004444','HUMAN',${users.agent!},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
await db`INSERT INTO conversation_message
  (conversation_id,connection_id,sender_id,direction,author_type,body,provider_message_id,delivery_state,received_at)
  VALUES (${mediaCv},${mediaConnection},${mediaSender},'INBOUND','CUSTOMER','Browser media request','wamid.browser-media-inbound','RECEIVED',now()-interval '1 second')`;
let mode: 'accept'|'reject'|'unknown' = 'reject'; let providerCalls = 0;let mediaUploads=0;
const templates:ProviderTemplate[]=[{ externalId:'7000',name:'header_only_template',language:'en_US',category:'UTILITY',status:'APPROVED',
  components:[{ type:'HEADER',format:'TEXT',text:'Welcome {{1}}',example:{ header_text:['Approval sample only'] } },
    { type:'BODY',text:'Fixed body' }] },
  { externalId:'7001',name:'malformed_provider_template',language:'en_US',category:'UTILITY',status:'APPROVED',
    components:[null,{ type:'HEADER',format:'TEXT',text:{ untrusted:'not a text value' } },{ type:'BODY',text:'Malformed metadata' }] }];
await mkdir(resolve('.local/e2e'),{ recursive:true });const mediaRoot=await mkdtemp(resolve('.local/e2e/media-'));
const storage=localMediaStorage(mediaRoot);
const app = await buildApp(db, { logger:false,globalRateLimitMax:10000,mediaStorage:storage,
  mediaScanner:{ scan:async()=>({ clean:true,version:'BrowserFakeScanner/test-only' }) },
  messagingSendAdapter:{ sendText:async()=> { throw new Error('Unexpected operational freeform send'); },
    sendTemplate:async()=>({ providerMessageId:'wamid.browser-operational' }) },
  messagingTemplateAdapter:{
    list:async(config)=>config.wabaId==='987654321' ? templates : [],
    create:async(config,_credentials,input)=> {
      if (config.wabaId!=='987654321') throw new Error('Unexpected test connection');
      const template:ProviderTemplate={ externalId:String(8000+templates.length),name:input.name,language:input.language,
        category:input.category,status:'PENDING',components:[
          ...(input.header ? [{ type:'HEADER',format:'TEXT',text:input.header,
            ...(input.headerExample ? { example:{ header_text:[input.headerExample] } } : {}) }] : []),
          { type:'BODY',text:input.body,...(input.examples?.length ? { example:{ body_text:[input.examples] } } : {}) },
          ...(input.footer ? [{ type:'FOOTER',text:input.footer }] : []),...(input.buttons ? [{ type:'BUTTONS',buttons:input.buttons.map((button)=>
            button.type==='URL' && input.urlExample ? { ...button,example:[renderTemplateUrl(button.url,input.urlExample)] } : button) }] : [])] };
      templates.push(template);return template;
    },
  } });
app.get('/',async (_request,reply)=>reply.type('text/html').send(await readFile(resolve('dist-web/index.html'))));
app.get<{ Params:{ name:string } }>('/assets/:name',async (request,reply)=> {
  if (!/^[A-Za-z0-9_.-]+\.(js|css)$/.test(request.params.name)) throw new HttpError(404,'ASSET_NOT_FOUND');
  const type = request.params.name.endsWith('.js') ? 'text/javascript' : 'text/css';
  return reply.type(type).send(await readFile(resolve('dist-web/assets',request.params.name)));
});
app.post<{ Body:{ process?:boolean; mode?:'accept'|'reject'|'unknown'; dnc?:boolean; assigned?:'agent'|'second'; approveTemplates?:boolean } }>(
  '/__test__/control', { schema: { body:{ type:'object',additionalProperties:false,properties: {
    process:{ type:'boolean' },mode:{ type:'string',enum:['accept','reject','unknown'] },
    dnc:{ type:'boolean' },assigned:{ type:'string',enum:['agent','second'] },
    approveTemplates:{ type:'boolean' },
  } } } },async (request)=> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !safeTokenEqual(header,'Bearer '+testToken)) throw new HttpError(403,'TEST_CONTROL_DENIED');
    if (request.body.mode) mode=request.body.mode;
    if (request.body.approveTemplates) for (const template of templates) template.status='APPROVED';
    if (typeof request.body.dnc === 'boolean')
      await db`UPDATE messaging_consent SET do_not_contact=${request.body.dnc} WHERE contact_id=${contact}`;
    if (request.body.assigned) await db`UPDATE lead SET assigned_agent_id=${users[request.body.assigned]!} WHERE id=${lead}`;
    const send=async()=> {
      providerCalls++;
      if (mode === 'reject') throw new ProviderSendError('REJECTED','PROVIDER_SEND_REJECTED');
      if (mode === 'unknown') throw new ProviderSendError('UNKNOWN','SEND_OUTCOME_UNKNOWN');
      return { providerMessageId:'wamid.browser-'+providerCalls };
    };
    if (request.body.process) await processOneMessagingJob(db,{ sendText:send,sendMedia:send,sendTemplate:send,
      uploadMedia:async()=> { mediaUploads++;return { providerMediaId:'12345' }; } },{ mediaStorage:storage });
    const messages = await db`SELECT id,body,delivery_state,message_kind,conversation_id FROM conversation_message WHERE direction='OUTBOUND' ORDER BY created_at,id`;
    const recoveries = (await db`SELECT count(*)::integer AS n FROM outbound_message_recovery`)[0]!.n;
    return { providerCalls,mediaUploads,messages,recoveries };
  });
await mkdir(resolve('.local/e2e'),{ recursive:true });
await writeFile(resolve('.local/e2e/fixture.json'),JSON.stringify({ password,testToken,leadId:lead,conversationId:cv,untrusted,mediaLeadId:mediaLead,mediaConversationId:mediaCv }),{ mode:0o600 });
app.post('/__test__/stop',async(request,reply)=> {
  const header=request.headers.authorization;
  if (typeof header !== 'string' || !safeTokenEqual(header,'Bearer '+testToken)) throw new HttpError(403,'TEST_CONTROL_DENIED');
  reply.send({ stopping:true });
  setImmediate(()=> { void app.close().then(()=>db.end()).then(()=>rm(mediaRoot,{ recursive:true,force:true })); });
  return reply;
});
await app.listen({ host:'127.0.0.1',port:4100 });
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,async()=> { await app.close(); await db.end(); });
