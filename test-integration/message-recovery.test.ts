import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealSecret } from '../src/credentials.js';
import { sha256 } from '../src/security.js';
import { processOneMessagingJob } from '../src/messaging/send-worker.js';
import { ProviderSendError, type MessagingSendAdapter } from '../src/messaging/providers.js';
import { applyDeliveryEvent } from '../src/messaging/delivery-events.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('message delivery observability and recovery preserve acceptance, authorization, history, policy and concurrency',
  { timeout: 120000 }, async (t) => {
    process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const db = createDatabase(url); const app = await buildApp(db, { logger: false, globalRateLimitMax: 10000 });
    t.after(async () => { await app.close(); await db.end(); });
    await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`;
      await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
    const org = (await db`INSERT INTO organization (name) VALUES ('Recovery test') RETURNING id`)[0]!.id;
    const branch = (await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
    const otherBranch = (await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
    const identities: Record<string,{ id: string; cookie: string }> = {};
    for (const [name,role,branchId] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],
      ['other','MANAGER',otherBranch],['agent','AGENT',branch],['second','AGENT',branch]] as const) {
      const id = (await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
        VALUES (${org},${branchId},${name},${role},${name+'@recovery.test'},'fixture-not-a-login-hash') RETURNING id`)[0]!.id;
      const token = randomBytes(32).toString('hex');
      await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
      identities[name] = { id, cookie: `lop_session=${token}` };
    }
    const campaign = (await db`INSERT INTO campaign (organization_id,branch_id,name,status,messaging_config)
      VALUES (${org},${branch},'Recovery','ACTIVE','{"enabled":true}'::jsonb) RETURNING id`)[0]!.id;
    const connection = (await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status,config)
      VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Recovery','CONNECTED',
        '{"graphVersion":"v25.0","wabaId":"123456789"}'::jsonb) RETURNING id`)[0]!.id;
    const secret = sealSecret(connection, JSON.stringify({ accessToken: 'test-recovery-secret' }));
    await db`INSERT INTO connection_secret (connection_id,ciphertext,nonce,auth_tag)
      VALUES (${connection},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
    const sender = (await db`INSERT INTO messaging_sender
      (organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
      VALUES (${org},${connection},'15550001111','Recovery','HEALTHY',true,
        '{"text":true,"template":true,"media":["image","document"]}'::jsonb) RETURNING id`)[0]!.id;
    await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
    const contact = (await db`INSERT INTO contact (organization_id,name,phone,phone_normalized)
      VALUES (${org},'Customer','+15550002222','+15550002222') RETURNING id`)[0]!.id;
    await db`INSERT INTO messaging_consent (contact_id,channel,status,source) VALUES (${contact},'WHATSAPP','GRANTED','TEST')`;
    const lead = (await db`INSERT INTO lead (organization_id,branch_id,campaign_id,contact_id,source_kind,assigned_agent_id)
      VALUES (${org},${branch},${campaign},${contact},'MANUAL',${identities.agent!.id}) RETURNING id`)[0]!.id;
    const cv = (await db`INSERT INTO conversation (lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
      VALUES (${lead},${connection},${sender},'WHATSAPP','+15550002222','HUMAN',${identities.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
    const inbound = (await db`INSERT INTO conversation_message
      (conversation_id,connection_id,sender_id,direction,author_type,body,provider_message_id,delivery_state,received_at)
      VALUES (${cv},${connection},${sender},'INBOUND','CUSTOMER','Test window','wamid.inbound','RECEIVED',now()-interval '1 second') RETURNING id`)[0]!.id;
    let requestNumber = 0;
    const api = (method: 'GET'|'POST', path: string, name?: string, payload?: object, remoteAddress?: string) => app.inject({
      method, url: path, payload, remoteAddress: remoteAddress ?? `127.0.0.${++requestNumber % 240 + 1}`,
      headers: { origin: process.env.APP_ORIGIN!, ...(name ? { cookie: identities[name]!.cookie } : {}) } });
    const path = (id: string) => `/api/conversations/${cv}/messages/${id}`;
    const retryBody = { version: 1, reason: 'Test failure resolved safely' };
    const enqueue = async (body = 'Saved customer text', extra: object = {}, name = 'agent') => {
      const key = randomUUID(); const payload = { ...(extra && Object.keys(extra).length ? extra : { body }), idempotencyKey: key };
      const response = await api('POST', `/api/conversations/${cv}/messages`, name, payload);
      assert.equal(response.statusCode,202,response.body); return { id: response.json().id as string, key, payload };
    };
    let calls = 0;
    const success: MessagingSendAdapter = { sendText: async () => ({ providerMessageId: `wamid.success-${++calls}` }),
      sendTemplate: async () => ({ providerMessageId: `wamid.template-${++calls}` }) };
    const reject: MessagingSendAdapter = { sendText: async () => { calls++;
      throw new ProviderSendError('REJECTED','PROVIDER_SEND_REJECTED'); } };
    const first = await enqueue(); assert.equal(await processOneMessagingJob(db,reject),true);
    const info = (await api('GET',path(first.id)+'/delivery','agent')).json();
    assert.equal(info.deliveryState,'FAILED'); assert.equal(info.queue.state,'DEAD');
    assert.equal(info.canRequestRecovery,true); assert.equal(info.recoveryVersion,1); assert.equal(info.queue.attempts,1);
    await assert.rejects(db`UPDATE conversation_message SET delivery_state='QUEUED' WHERE id=${first.id}`,/CUSTOMER_MESSAGE_REQUEUE_UNSAFE/);
    assert.equal((await api('GET',path(first.id)+'/delivery')).statusCode,401);
    for (const kind of ['delivery','attempts','delivery-events','recoveries']) {
      assert.equal((await api('GET',path(first.id)+'/'+kind,'second')).statusCode,404);
      assert.equal((await api('GET',path(first.id)+'/'+kind,'other')).statusCode,404);
      assert.equal((await api('GET',path(first.id)+'/'+kind,'manager')).statusCode,200);
      assert.equal((await api('GET',`/api/conversations/${randomUUID()}/messages/${first.id}/${kind}`,'admin')).statusCode,404);
    }
    assert.equal((await api('POST',path(first.id)+'/retry','manager',retryBody)).json().error,'ORIGINAL_AUTHOR_REQUIRED');
    assert.equal((await api('POST',path(first.id)+'/retry','second',retryBody)).statusCode,404);
    assert.equal((await api('POST',path(first.id)+'/retry','agent',{ version:1 })).statusCode,400);
    assert.equal((await api('POST',path(first.id)+'/retry','agent',{ ...retryBody,reason:'          ' })).json().error,'RECOVERY_REASON_REQUIRED');
    assert.equal((await api('POST',path(first.id)+'/retry','agent',{ ...retryBody,version:2 })).json().error,'MESSAGE_RECOVERY_VERSION_CONFLICT');
    assert.equal((await api('GET',path(first.id)+'/attempts?before=9999999999999999999','agent')).statusCode,400);
    assert.equal((await api('POST',path(inbound)+'/retry','agent',retryBody)).json().error,'MESSAGE_NOT_RETRYABLE');
    await db`UPDATE conversation SET controller_user_id=${identities.manager!.id} WHERE id=${cv}`;
    assert.equal((await api('POST',path(first.id)+'/retry','agent',retryBody)).json().error,'HUMAN_CONTROLLER_REQUIRED');
    await db`UPDATE conversation SET controller_user_id=${identities.agent!.id} WHERE id=${cv}`;
    await db`UPDATE messaging_consent SET do_not_contact=true WHERE contact_id=${contact}`;
    assert.equal((await api('POST',path(first.id)+'/retry','agent',retryBody)).json().error,'DO_NOT_CONTACT');
    assert.equal((await db`SELECT count(*)::integer AS n FROM outbound_message_recovery`)[0]!.n,0);
    await db`UPDATE messaging_consent SET do_not_contact=false WHERE contact_id=${contact}`;
    const race = await Promise.all([api('POST',path(first.id)+'/retry','agent',retryBody),
      api('POST',path(first.id)+'/retry','agent',retryBody)]);
    assert.deepEqual(race.map((r)=>r.statusCode).sort(),[202,409]);
    assert.equal((await api('POST',`/api/conversations/${cv}/messages`,'agent',first.payload)).json().id,first.id);
    assert.equal((await db`SELECT count(*)::integer AS n FROM outbound_delivery_job WHERE message_id=${first.id}`)[0]!.n,1);
    assert.equal(await processOneMessagingJob(db,success),true);
    assert.equal((await api('GET',path(first.id)+'/delivery','agent')).json().deliveryState,'SENT');
    const attemptPage = (await api('GET',path(first.id)+'/attempts?limit=1','agent')).json();
    assert.equal(attemptPage.items[0].attempt_number,2); assert.equal(attemptPage.items[0].state,'ACKNOWLEDGED');
    const older = (await api('GET',path(first.id)+'/attempts?limit=1&before='+attemptPage.nextBefore,'agent')).json();
    assert.equal(older.items[0].attempt_number,1); assert.equal(older.items[0].state,'REJECTED'); assert.equal(older.nextBefore,null);
    const recoveryHistory = (await api('GET',path(first.id)+'/recoveries','agent')).json();
    assert.equal(recoveryHistory.items[0].attempts_before,1); assert.equal(recoveryHistory.items[0].reason,retryBody.reason);
    assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE action='OUTBOUND_MESSAGE_RECOVERY_REQUESTED'`)[0]!.n,1);
    await assert.rejects(db`UPDATE outbound_message_recovery SET reason='altered history' WHERE message_id=${first.id}`,
      /OUTBOUND_RECOVERY_IMMUTABLE/);
    await assert.rejects(db`UPDATE conversation_message SET body='changed content' WHERE id=${first.id}`,/CUSTOMER_MESSAGE_IMMUTABLE/);
    await assert.rejects(db`UPDATE conversation_message SET provider_message_id=NULL WHERE id=${first.id}`,/CUSTOMER_PROVIDER_ID_IMMUTABLE/);

    // A FAILED callback after ACK is never a pre-acceptance failure, even after clearing the attention flag.
    const acceptedId = (await db`SELECT provider_message_id FROM conversation_message WHERE id=${first.id}`)[0]!.provider_message_id;
    const event = (await db`INSERT INTO integration_event
      (connection_id,provider_event_id,event_kind,sender_id,participant_ref,payload)
      VALUES (${connection},'failed-after-ack','DELIVERY_STATUS',${sender},'+15550002222',
        ${db.json({ senderExternalId:'15550001111',providerMessageId:acceptedId,status:'failed',providerTimestamp:new Date().toISOString() })}) RETURNING id`)[0]!.id;
    await db.begin((tx)=>applyDeliveryEvent(tx,event));
    const deliveryEvents = (await api('GET',path(first.id)+'/delivery-events','agent')).json();
    assert.equal(deliveryEvents.items[0].status,'FAILED'); assert.equal(deliveryEvents.items[0].payload,undefined);
    await db`UPDATE conversation SET needs_attention_reason=NULL WHERE id=${cv}`;
    assert.equal((await api('POST',path(first.id)+'/retry','agent',{ ...retryBody,version:2 })).json().error,'MESSAGE_NOT_RETRYABLE');
    // Even a corrupted job state must not turn accepted delivery into eligibility.
    await db`UPDATE background_job SET status='DEAD' WHERE id=(SELECT job_id FROM outbound_delivery_job WHERE message_id=${first.id})`;
    assert.equal((await api('POST',path(first.id)+'/retry','agent',{ ...retryBody,version:2 })).json().error,'SEND_ACCEPTANCE_NOT_EXCLUDED');
    await assert.rejects(db`UPDATE conversation_message SET delivery_state='QUEUED' WHERE id=${first.id}`,/CUSTOMER_MESSAGE_REQUEUE_UNSAFE/);

    const unknown = await enqueue();
    assert.equal(await processOneMessagingJob(db,{ sendText:async()=> { calls++; throw new ProviderSendError('UNKNOWN','SEND_OUTCOME_UNKNOWN'); } }),true);
    assert.equal((await api('POST',path(unknown.id)+'/retry','agent',retryBody)).json().error,'MESSAGE_NOT_RETRYABLE');
    await assert.rejects(db`UPDATE conversation_message SET delivery_state='QUEUED' WHERE id=${unknown.id}`,/CUSTOMER_MESSAGE_REQUEUE_UNSAFE/);
    await db`UPDATE conversation_message SET delivery_state='FAILED' WHERE id=${unknown.id}`;
    assert.equal((await api('POST',path(unknown.id)+'/retry','agent',retryBody)).json().error,'SEND_ACCEPTANCE_NOT_EXCLUDED');
    await db`UPDATE conversation_message SET delivery_state='UNKNOWN' WHERE id=${unknown.id}`;
    await db`UPDATE conversation SET needs_attention_reason=NULL WHERE id=${cv}`;
    await db`UPDATE integration_connection SET status='CONNECTED' WHERE id=${connection}`;
    // PREPARED dispatch cannot be recovered while the call is in flight, or after the lease expires into UNKNOWN.
    const flight = await enqueue(); let release = () => {}; let started = () => {};
    const barrier = new Promise<void>((resolve)=> { started=resolve; });
    const held = new Promise<void>((resolve)=> { release=resolve; });
    const running = processOneMessagingJob(db,{ sendText:async()=> { started(); await held;
      throw new ProviderSendError('UNKNOWN','SEND_OUTCOME_UNKNOWN'); } });
    await barrier;
    try {
      await db.begin(async (tx)=> {
        await tx`SELECT id FROM background_job WHERE id=(SELECT job_id FROM outbound_delivery_job WHERE message_id=${flight.id}) FOR UPDATE`;
        const rejected = await Promise.race([api('POST',path(flight.id)+'/retry','agent',retryBody),
          delay(3000,null,{ ref:false }).then(()=> { throw new Error('Active job retry waited for a job lock'); })]);
        assert.equal(rejected.json().error,'MESSAGE_NOT_RETRYABLE');
      });
    } finally { release(); await running; }
    await db`UPDATE conversation SET needs_attention_reason=NULL WHERE id=${cv}`;
    await db`UPDATE integration_connection SET status='CONNECTED' WHERE id=${connection}`;

    // Pre-dispatch block has no provider attempt and may recover only after current policy allows it.
    const blocked = await enqueue(); await db`UPDATE messaging_consent SET do_not_contact=true WHERE contact_id=${contact}`;
    const beforeCalls = calls; await processOneMessagingJob(db,success); assert.equal(calls,beforeCalls);
    assert.equal((await api('GET',path(blocked.id)+'/attempts','agent')).json().items.length,0);
    assert.equal((await api('POST',path(blocked.id)+'/retry','agent',retryBody)).json().error,'DO_NOT_CONTACT');
    await db`UPDATE messaging_consent SET do_not_contact=false WHERE contact_id=${contact}`;
    assert.equal((await api('POST',path(blocked.id)+'/retry','agent',retryBody)).statusCode,202);
    await db`UPDATE messaging_consent SET do_not_contact=true WHERE contact_id=${contact}`;
    await processOneMessagingJob(db,success); assert.equal(calls,beforeCalls);
    await db`UPDATE messaging_consent SET do_not_contact=false WHERE contact_id=${contact}`;
    assert.equal((await api('POST',path(blocked.id)+'/retry','agent',{ ...retryBody,version:1 })).json().error,'MESSAGE_RECOVERY_VERSION_CONFLICT');
    assert.equal((await api('POST',path(blocked.id)+'/retry','agent',{ ...retryBody,version:2 })).statusCode,202);
    await processOneMessagingJob(db,success);
    const recoveredPage = (await api('GET',path(blocked.id)+'/recoveries?limit=1','agent')).json();
    assert.equal(recoveredPage.items[0].recovery_version,3); assert.ok(recoveredPage.nextBefore);
    assert.equal((await api('GET',path(blocked.id)+'/recoveries?limit=1&before='+recoveredPage.nextBefore,'agent')).json().items[0].recovery_version,2);

    const exhausted = await enqueue();
    for (let attempt=0;attempt<5;attempt++) {
      await processOneMessagingJob(db,{ sendText:async()=> { calls++; throw new ProviderSendError('RETRYABLE','PROVIDER_RATE_LIMITED'); } });
      await db`UPDATE background_job SET run_after=now() WHERE id=(SELECT job_id FROM outbound_delivery_job WHERE message_id=${exhausted.id})`;
      await db`UPDATE integration_connection SET cooldown_until=NULL WHERE id=${connection}`;
      await db`UPDATE messaging_sender SET cooldown_until=NULL WHERE id=${sender}`;
    }
    assert.equal((await api('GET',path(exhausted.id)+'/delivery','agent')).json().queue.attempts,5);
    assert.equal((await api('POST',path(exhausted.id)+'/retry','agent',retryBody)).statusCode,202);
    const extended = (await api('GET',path(exhausted.id)+'/delivery','agent')).json();
    assert.equal(extended.queue.attempts,5); assert.equal(extended.queue.maxAttempts,10);
    await processOneMessagingJob(db,success);
    assert.equal((await api('GET',path(exhausted.id)+'/attempts','agent')).json().items[0].attempt_number,6);

    // The immutable snapshot is revalidated, rather than silently using a newly edited template.
    const template = (await db`INSERT INTO provider_message_template
      (connection_id,external_template_id,name,language,status,category,components)
      VALUES (${connection},'123','test_template','en','APPROVED','UTILITY',
        '[{"type":"BODY","text":"Test {{1}}"}]'::jsonb) RETURNING id`)[0]!.id;
    await db`INSERT INTO campaign_message_template_binding (campaign_id,template_id,active,updated_by)
      VALUES (${campaign},${template},true,${identities.manager!.id})`;
    const templated = await enqueue('',{ templateId:template,templateParameters:['original'] });
    await processOneMessagingJob(db,{ ...reject,sendTemplate:async()=> { calls++; throw new ProviderSendError('REJECTED','PROVIDER_SEND_REJECTED'); } });
    await db`UPDATE provider_message_template SET components='[{"type":"BODY","text":"Changed {{1}}"}]'::jsonb WHERE id=${template}`;
    assert.equal((await api('POST',path(templated.id)+'/retry','agent',retryBody)).json().error,'TEMPLATE_CHANGED');
    await db`UPDATE provider_message_template SET components='[{"type":"BODY","text":"Test {{1}}"}]'::jsonb,
      status='PAUSED' WHERE id=${template}`;
    assert.equal((await api('POST',path(templated.id)+'/retry','agent',retryBody)).json().error,'TEMPLATE_NOT_APPROVED');
    await db`UPDATE provider_message_template SET status='APPROVED' WHERE id=${template}`;
    assert.equal((await api('POST',path(templated.id)+'/retry','agent',retryBody)).statusCode,202);
    await processOneMessagingJob(db,success);
    assert.equal((await db`SELECT body FROM conversation_message WHERE id=${templated.id}`)[0]!.body,'Test original');

    // A rejected asset upload is before customer dispatch. The scanned file stays pinned to this message.
    const bytes = Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const attachment = (await db`INSERT INTO message_attachment
      (media_kind,declared_mime,expected_sha256,state,mime_type,size_bytes,content_sha256,storage_key,storage_backend,
        scanner_version,scanned_at,upload_conversation_id,uploaded_by,upload_idempotency_key)
      VALUES ('document','application/pdf',${hash},'READY','application/pdf',${bytes.length},${hash},
        ${randomUUID()+'-'+hash},'LOCAL','FakeScanner/test-only',now(),${cv},${identities.agent!.id},${randomUUID()}) RETURNING id`)[0]!.id;
    const fileMessage = await enqueue('',{ attachmentId:attachment,body:'Saved caption' });
    const mediaStorage = { backend:'LOCAL',get:async()=>bytes,put:async()=>{},remove:async()=>{} };
    const mediaAdapter: MessagingSendAdapter = { ...success,
      uploadMedia:async()=> { throw new ProviderSendError('REJECTED','PROVIDER_MEDIA_UPLOAD_REJECTED'); },
      sendMedia:async()=> { calls++; return { providerMessageId:'wamid.media' }; } };
    const beforeMedia = calls;
    await processOneMessagingJob(db,mediaAdapter,{ mediaStorage }); assert.equal(calls,beforeMedia);
    assert.equal((await api('GET',path(fileMessage.id)+'/attempts','agent')).json().items.length,0);
    await db`UPDATE messaging_sender SET capabilities='{"text":true,"template":true}'::jsonb WHERE id=${sender}`;
    assert.equal((await api('POST',path(fileMessage.id)+'/retry','agent',retryBody)).json().error,'MEDIA_SEND_NOT_SUPPORTED');
    await db`UPDATE messaging_sender SET capabilities='{"text":true,"template":true,"media":["document"]}'::jsonb WHERE id=${sender}`;
    assert.equal((await api('POST',path(fileMessage.id)+'/retry','agent',retryBody)).statusCode,202);
    await processOneMessagingJob(db,{ ...mediaAdapter,uploadMedia:async()=>({ providerMediaId:'12345' }) },{ mediaStorage });
    assert.equal(calls,beforeMedia+1);
    assert.equal((await db`SELECT attachment_id FROM conversation_message WHERE id=${fileMessage.id}`)[0]!.attachment_id,attachment);

    // Manager-authored recovery follows the same controller and policy path; no role bypass is needed.
    await db`UPDATE conversation SET controller_user_id=${identities.manager!.id} WHERE id=${cv}`;
    const managerMessage = await enqueue('Manager text',{},'manager'); await processOneMessagingJob(db,reject);
    assert.equal((await api('POST',path(managerMessage.id)+'/retry','manager',retryBody)).statusCode,202);
    await processOneMessagingJob(db,success);
    await db`UPDATE conversation SET controller_user_id=${identities.agent!.id} WHERE id=${cv}`;

    // Access follows the current assignment, including on every history page.
    const reassigned = await enqueue(); await processOneMessagingJob(db,reject);
    await db`UPDATE lead SET assigned_agent_id=${identities.second!.id} WHERE id=${lead}`;
    for (const kind of ['delivery','attempts','delivery-events','recoveries'])
      assert.equal((await api('GET',path(reassigned.id)+'/'+kind,'agent')).statusCode,404);
    assert.equal((await api('POST',path(reassigned.id)+'/retry','agent',retryBody)).statusCode,404);
    assert.equal((await api('POST',path(reassigned.id)+'/retry','second',retryBody)).json().error,'ORIGINAL_AUTHOR_REQUIRED');
    await db`UPDATE lead SET assigned_agent_id=${identities.agent!.id} WHERE id=${lead}`;
    // If reassignment commits while a retry waits for the connection, it must recheck Lead access after the wait.
    let releaseLock = () => {}; let locked = () => {};
    const lockStarted = new Promise<void>((resolve)=> { locked=resolve; });
    const lockRelease = new Promise<void>((resolve)=> { releaseLock=resolve; });
    const connectionLock = db.begin(async (tx)=> {
      await tx`SELECT id FROM integration_connection WHERE id=${connection} FOR NO KEY UPDATE`; locked(); await lockRelease;
    });
    await lockStarted; const staleRetry = api('POST',path(reassigned.id)+'/retry','agent',retryBody);
    try {
      let waiting = false;
      for (let poll=0;poll<100;poll++) {
        waiting = (await db`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%FROM integration_connection WHERE id%FOR NO KEY UPDATE%') AS waiting`)[0]!.waiting;
        if (waiting) break;
        await delay(10);
      }
      assert.equal(waiting,true,'retry must wait for the held connection before reassignment');
      await db`UPDATE lead SET assigned_agent_id=${identities.second!.id} WHERE id=${lead}`;
    } finally { releaseLock(); await connectionLock; }
    assert.equal((await staleRetry).statusCode,404);
    await db`UPDATE lead SET assigned_agent_id=${identities.agent!.id} WHERE id=${lead}`;
    await db`UPDATE user_account SET active=false WHERE id=${identities.agent!.id}`;
    assert.equal((await api('POST',path(reassigned.id)+'/retry','agent',retryBody)).statusCode,401);
    await db`UPDATE user_account SET active=true WHERE id=${identities.agent!.id}`;
    // No secret, job payload, provider raw response, or storage key is exposed by observability APIs.
    for (const kind of ['delivery','attempts','delivery-events','recoveries']) {
      const output = (await api('GET',path(first.id)+'/'+kind,'admin')).body;
      for (const forbidden of ['test-recovery-secret','ciphertext','storage_key','"payload"']) assert.ok(!output.includes(forbidden));
    }
    // Request limiter also covers authenticated explicit recovery, independently of the global limiter.
    for (let i=0;i<10;i++) assert.notEqual((await api('POST',path(reassigned.id)+'/retry','agent',retryBody,'127.0.0.250')).statusCode,429);
    assert.equal((await api('POST',path(reassigned.id)+'/retry','agent',retryBody,'127.0.0.250')).statusCode,429);
  });
