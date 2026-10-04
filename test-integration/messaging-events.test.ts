import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealSecret } from '../src/credentials.js';
import { sha256 } from '../src/security.js';
import { applyDeliveryEvent, processOnePendingDeliveryEvent } from '../src/messaging/delivery-events.js';
import { processInboundEvent, processOneInboundEvent } from '../src/messaging/inbound-events.js';
import { processOneIntegrationEvent } from '../src/messaging/event-processing.js';
import { processOneMessagingJob } from '../src/messaging/send-worker.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('durable messaging events roll back partial changes, bound failures, enforce recovery scope and run independently of sends',
  { timeout: 120000 }, async (t) => {
    process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const db = createDatabase(url); const app = await buildApp(db, { logger: false, globalRateLimitMax: 10000 });
    let child: ChildProcess | undefined; let releaseOutbound = () => {}; let outbound: Promise<boolean> | undefined;
    t.after(async () => { releaseOutbound(); if (outbound) await outbound;
      if (child && child.exitCode === null) { child.kill(); await delay(100); }
      await app.close(); await db.end(); });
    await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`;
      await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
    const org = (await db`INSERT INTO organization (name) VALUES ('Event test') RETURNING id`)[0]!.id;
    const branch = (await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
    const otherBranch = (await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
    const identities: Record<string,{ id: string; cookie: string }> = {};
    for (const [name,role,branchId] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],
      ['other','MANAGER',otherBranch],['agent','AGENT',branch]] as const) {
      const id = (await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
        VALUES (${org},${branchId},${name},${role},${name+'@events.test'},'fixture-not-a-login-hash') RETURNING id`)[0]!.id;
      const token = randomBytes(32).toString('hex');
      await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
      identities[name] = { id, cookie: `lop_session=${token}` };
    }
    const campaign = (await db`INSERT INTO campaign (organization_id,branch_id,name,status,messaging_config)
      VALUES (${org},${branch},'Events','ACTIVE','{"enabled":true}'::jsonb) RETURNING id`)[0]!.id;
    const connection = (await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status,config)
      VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Events','CONNECTED',
        '{"graphVersion":"v25.0","wabaId":"123456789"}'::jsonb) RETURNING id`)[0]!.id;
    const secondConnection = (await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name)
      VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Second') RETURNING id`)[0]!.id;
    const credentials = { accessToken: 'test-access-token', appSecret: 'test-app-secret', verifyToken: 'test-verify-token' };
    const secret = sealSecret(connection, JSON.stringify(credentials));
    await db`INSERT INTO connection_secret (connection_id,ciphertext,nonce,auth_tag)
      VALUES (${connection},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
    const sender = (await db`INSERT INTO messaging_sender
      (organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
      VALUES (${org},${connection},'15550001111','Events','HEALTHY',true,'{"text":true}'::jsonb) RETURNING id`)[0]!.id;
    await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
    const contact = (await db`INSERT INTO contact (organization_id,name,phone,phone_normalized)
      VALUES (${org},'Customer','+15550002222','+15550002222') RETURNING id`)[0]!.id;
    await db`INSERT INTO messaging_consent (contact_id,channel,status,source) VALUES (${contact},'WHATSAPP','GRANTED','TEST')`;
    const lead = (await db`INSERT INTO lead (organization_id,branch_id,campaign_id,contact_id,source_kind,assigned_agent_id)
      VALUES (${org},${branch},${campaign},${contact},'MANUAL',${identities.agent!.id}) RETURNING id`)[0]!.id;
    const cv = (await db`INSERT INTO conversation (lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
      VALUES (${lead},${connection},${sender},'WHATSAPP','+15550002222','HUMAN',${identities.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
    const message = (await db`INSERT INTO conversation_message
      (conversation_id,connection_id,sender_id,direction,author_type,author_user_id,body,provider_message_id,delivery_state,delivery_rank)
      VALUES (${cv},${connection},${sender},'OUTBOUND','HUMAN',${identities.agent!.id},'Hello','wamid.reference','SENT',1) RETURNING id`)[0]!.id;
    const api = (method: 'GET'|'POST', path: string, name?: string, payload?: object) => app.inject({ method, url: path, payload,
      headers: { origin: process.env.APP_ORIGIN!, ...(name ? { cookie: identities[name]!.cookie } : {}) } });
    const envelope = (value: object) => ({ object: 'whatsapp_business_account', entry: [{ id: '123456789', changes: [{
      field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '15550001111' }, ...value },
    }] }] });
    const webhook = async (payload: object) => {
      const raw = JSON.stringify(payload);
      return app.inject({ method: 'POST', url: `/api/webhooks/messaging/meta/${connection}`, payload: raw,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256':
          `sha256=${createHmac('sha256',credentials.appSecret).update(raw).digest('hex')}` } });
    };
    let epoch = Math.floor(Date.now()/1000);
    const delivery = () => envelope({ statuses: [{ id: 'wamid.reference', status: 'delivered', timestamp: String(epoch++), recipient_id: '15550002222' }] });
    const firstPayload = delivery();
    assert.equal((await webhook(envelope({ statuses: [] }))).statusCode,400);
    assert.equal((await webhook(firstPayload)).json().created,1);
    assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${message}`)[0]!.delivery_state,'SENT');
    const event = (await db`SELECT * FROM integration_event WHERE connection_id=${connection}`)[0]!;
    const path = `/api/messaging/connections/${connection}/events/${event.id}`;
    // Partial domain mutations, history and audit must all roll back before the retry is recorded.
    for (let attempt=1; attempt<=5; attempt++) {
      assert.equal(await processOneIntegrationEvent(db,'DELIVERY_STATUS',async (tx,id) => {
        await applyDeliveryEvent(tx,id); throw new Error('provider-secret-must-never-be-recorded');
      }),true);
      assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${message}`)[0]!.delivery_state,'SENT');
      assert.equal((await db`SELECT count(*)::integer AS n FROM message_delivery_event`)[0]!.n,0);
      assert.equal(await processOnePendingDeliveryEvent(db),false);
      if (attempt<5) await db`UPDATE integration_event SET processing_available_at=now() WHERE id=${event.id}`;
    }
    const failed = (await db`SELECT * FROM integration_event WHERE id=${event.id}`)[0]!;
    assert.equal(failed.state,'FAILED'); assert.equal(failed.processing_failures,5); assert.equal(failed.processing_version,6);
    assert.equal((await webhook(firstPayload)).json().created,0);
    const healthPath = `/api/messaging/connections/${connection}/webhook`;
    assert.equal((await api('GET',healthPath,'manager')).json().failed,1);
    const failedList = await api('GET',`/api/messaging/connections/${connection}/events?state=FAILED`,'manager');
    assert.deepEqual(failedList.json().items.map((row: {id: string})=>row.id),[event.id]);
    assert.equal((await api('GET',`/api/messaging/connections/${connection}/events?state=PENDING`,'manager')).json().items.length,0);
    assert.equal((await api('GET',`/api/messaging/connections/${connection}/events?state=BAD`,'manager')).statusCode,400);
    await assert.rejects(db`UPDATE integration_event SET state='RECEIVED',failure_code=NULL WHERE id=${event.id}`,
      /event_processing_terminal_failure/);
    assert.equal((await api('GET',path+'/attempts')).statusCode,401);
    assert.equal((await api('GET',path+'/attempts','agent')).statusCode,403);
    assert.equal((await api('GET',path+'/attempts','other')).statusCode,404);
    assert.equal((await api('GET',`/api/messaging/connections/${secondConnection}/events/${event.id}/attempts`,'manager')).statusCode,404);
    const history = await api('GET',path+'/attempts?limit=2','manager');
    assert.equal(history.json().items.length,2); assert.ok(history.json().nextBefore);
    assert.equal(history.json().items[0].outcome,'FAILED'); assert.equal(history.body.includes('provider-secret'),false);
    const next = (await api('GET',path+'/attempts?before='+history.json().nextBefore,'manager')).json();
    assert.equal(next.items.length,3);
    const retry = { version:6,reason:'Database issue investigated and fixed' };
    assert.equal((await api('POST',path+'/retry','agent',retry)).statusCode,403);
    assert.equal((await api('POST',path+'/retry','other',retry)).statusCode,404);
    assert.equal((await api('POST',path+'/retry','manager',{ version:6 })).statusCode,400);
    assert.equal((await api('POST',path+'/retry','manager',{ ...retry,reason:'          ' })).statusCode,400);
    assert.equal((await api('POST',path+'/retry','manager',{ ...retry,version:5 })).statusCode,409);
    assert.equal((await api('POST',`/api/messaging/connections/${connection}/events/${randomUUID()}/retry`,'manager',retry)).statusCode,404);
    const raced = await Promise.all([api('POST',path+'/retry','manager',retry),api('POST',path+'/retry','admin',retry)]);
    assert.deepEqual(raced.map((r)=>r.statusCode).sort(),[200,409]);
    assert.equal(await processOnePendingDeliveryEvent(db),true);
    assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${message}`)[0]!.delivery_state,'DELIVERED');
    assert.equal((await api('POST',path+'/retry','manager',{ ...retry,version:8 })).json().error,'EVENT_NOT_RETRYABLE');
    assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE action='MESSAGING_EVENT_RETRY_REQUESTED'`)[0]!.n,1);
    assert.equal((await db`SELECT count(*)::integer AS n FROM integration_event_processing_attempt WHERE event_id=${event.id}`)[0]!.n,6);
    const inboundPayload = envelope({ messages: [{ id:'wamid.recovered-inbound',from:'15550002222',timestamp:String(Math.floor(Date.now()/1000)-1),
      type:'text',text:{ body:'<script>untrusted customer text</script>' } }] });
    await webhook(inboundPayload);
    const inboundEvent = (await db`SELECT id FROM integration_event WHERE event_kind='INBOUND_MESSAGE'`)[0]!.id;
    for (let attempt=0; attempt<5; attempt++) {
      await processOneIntegrationEvent(db,'INBOUND_MESSAGE',async (tx,id) => {
        await processInboundEvent(tx,id); throw new Error('provider-secret-must-never-be-recorded');
      });
      if (attempt<4) await db`UPDATE integration_event SET processing_available_at=now() WHERE id=${inboundEvent}`;
    }
    assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message WHERE provider_message_id='wamid.recovered-inbound'`)[0]!.n,0);
    assert.equal((await api('POST',`/api/messaging/connections/${connection}/inbound-review/${inboundEvent}/resolve`,
      'manager',{ conversationId:cv })).json().error,'EVENT_RETRY_REQUIRED');
    assert.equal((await api('POST',`/api/messaging/connections/${connection}/events/${inboundEvent}/retry`,'manager',retry)).statusCode,200);
    assert.equal(await processOneInboundEvent(db),true);
    assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message WHERE provider_message_id='wamid.recovered-inbound'`)[0]!.n,1);
    assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE action='INBOUND_MESSAGE_ATTACHED'`)[0]!.n,1);
    // A locked event cannot be claimed twice, while another event and duplicate ingestion can progress.
    const concurrentPayload = delivery(); await webhook(concurrentPayload); await webhook(delivery());
    const first = (await db`SELECT id FROM integration_event WHERE state='RECEIVED' ORDER BY processing_available_at,received_at,id LIMIT 1`)[0]!.id;
    let release = () => {}; let began = () => {};
    const hold = new Promise<void>((resolve)=>{release=resolve;}); const started = new Promise<void>((resolve)=>{began=resolve;});
    const held = processOneIntegrationEvent(db,'DELIVERY_STATUS',async(tx,id)=>{
      assert.equal(id,first); began(); await hold; await applyDeliveryEvent(tx,id);
    });
    await started;
    try {
      assert.equal(await processOnePendingDeliveryEvent(db),true);
      assert.equal(await processOnePendingDeliveryEvent(db),false);
      const duplicate = webhook(concurrentPayload);
      const response = await Promise.race([duplicate,delay(2000).then(()=>null)]);
      assert.ok(response,'Duplicate ingestion must progress while an event row is locked');
      assert.equal(response.json().created,0);
    } finally { release(); await held; }
    assert.equal((await db`SELECT count(*)::integer AS n FROM integration_event_processing_attempt WHERE event_id=${first}`)[0]!.n,1);
    // Start the actual compiled events worker while an outbound provider call is still blocked.
    const queuedResponse = await api('POST',`/api/conversations/${cv}/messages`,'agent',{
      body:'Outbound test held by fake provider',idempotencyKey:'event-independent-outbound' });
    assert.equal(queuedResponse.statusCode,202,queuedResponse.body); const queued = queuedResponse.json().id;
    let sendingStarted = () => {};
    const sendStarted = new Promise<void>((resolve)=>{sendingStarted=resolve;});
    const sendHold = new Promise<void>((resolve)=>{releaseOutbound=resolve;});
    outbound = processOneMessagingJob(db,{async sendText(){ sendingStarted(); await sendHold; return {providerMessageId:'wamid.held-send'}; }});
    await sendStarted;
    await webhook(envelope({ statuses:[{id:'wamid.reference',status:'read',timestamp:String(epoch++),recipient_id:'15550002222'}],
      messages:[{id:'wamid.independent-inbound',from:'15550002222',timestamp:String(Math.floor(Date.now()/1000)-1),type:'text',text:{body:'Received during provider timeout'}}] }));
    let childFailure: unknown; let childLogs = '';
    child = spawn(process.execPath,[fileURLToPath(new URL('../src/messaging-events-worker.js',import.meta.url))],{
      env:{...process.env,DATABASE_URL:url!,NODE_ENV:'test'},windowsHide:true,stdio:['ignore','pipe','pipe'] });
    child.on('error',(error)=>{childFailure=error;}); child.stderr?.on('data',(chunk)=>{childLogs+=String(chunk);});
    const deadline = Date.now()+15000;
    while (true) {
      if (childFailure) throw childFailure;
      assert.ok(Date.now()<deadline,`Events worker did not process durable events: ${childLogs}`);
      const resolved = (await db`SELECT count(*)::integer AS n FROM integration_event WHERE state='RECEIVED'
        OR (state='NEEDS_ATTENTION' AND failure_code='INBOUND_PROCESSING_NOT_READY')`)[0]!.n;
      if (!resolved) break; await delay(20);
    }
    assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${message}`)[0]!.delivery_state,'READ');
    assert.equal((await db`SELECT count(*)::integer AS n FROM conversation_message WHERE provider_message_id='wamid.independent-inbound'`)[0]!.n,1);
    assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${queued}`)[0]!.delivery_state,'QUEUED');
    child.kill(); await delay(100); releaseOutbound(); assert.equal(await outbound,true);
    assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${queued}`)[0]!.delivery_state,'SENT');
    const currentHealth = (await api('GET',healthPath,'manager')).json();
    assert.equal(currentHealth.pending,0); assert.equal(currentHealth.failed,0); assert.ok(currentHealth.lastProcessedAt);
    const listed = await api('GET',`/api/messaging/connections/${connection}/events`,'manager');
    assert.equal(listed.body.includes('provider-secret'),false); assert.equal(listed.body.includes('Received during provider'),false);
    assert.equal(listed.body.includes(credentials.accessToken),false);
  });
