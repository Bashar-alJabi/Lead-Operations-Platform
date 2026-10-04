import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sealSecret } from '../src/credentials.js';
import { sha256 } from '../src/security.js';
import { localMediaStorage } from '../src/media/storage.js';
import { metaMediaCapabilities } from '../src/media/meta-outbound.js';
import type { MediaKind } from '../src/media/validation.js';
import { processOneMessagingJob } from '../src/messaging/send-worker.js';
import { ProviderSendError, type MessagingSendAdapter } from '../src/messaging/providers.js';

const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('extended outbound media enforces scanned content, captions, current access/policy, concurrency and safe recovery',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const root=await mkdtemp(resolve('.local/extended-media-'));const storage=localMediaStorage(root);
  let clean=true;let scans=0;let scanStarted:(()=>void)|undefined;let scanHold:Promise<void>|undefined;
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,mediaStorage:storage,mediaScanner:{ scan:async()=> {
    scans++;scanStarted?.();if (scanHold) await scanHold;return { clean,version:'SyntheticScanner/test-only' };
  } } });
  t.after(async()=> { await app.close();await db.end();await rm(root,{ recursive:true,force:true }); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Extended media test') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const identities:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,branchId] of [['agent','AGENT',branch],['second','AGENT',branch],['manager','MANAGER',branch],['other','MANAGER',otherBranch]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${org},${branchId},${name},${role},${name+'@extended.test'},'synthetic-non-login-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at)
      VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
    identities[name]={ id,cookie:'lop_session='+token };
  }
  const campaign=(await db`INSERT INTO campaign (organization_id,branch_id,name,status,messaging_config)
    VALUES (${org},${branch},'Media','ACTIVE','{"enabled":true}'::jsonb) RETURNING id`)[0]!.id;
  const connection=(await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status,config)
    VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Media','CONNECTED',
      '{"graphVersion":"v25.0","wabaId":"123456789"}'::jsonb) RETURNING id`)[0]!.id;
  const sealed=sealSecret(connection,JSON.stringify({ accessToken:'test-only-fake-not-live' }));
  await db`INSERT INTO connection_secret (connection_id,ciphertext,nonce,auth_tag)
    VALUES (${connection},${sealed.ciphertext},${sealed.nonce},${sealed.authTag})`;
  const caps={ text:true,template:true,...metaMediaCapabilities() };
  const sender=(await db`INSERT INTO messaging_sender (organization_id,connection_id,external_sender_id,display_name,health,capabilities)
    VALUES (${org},${connection},'15550001111','Media','HEALTHY',${db.json(caps)}) RETURNING id`)[0]!.id;
  await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
  const contact=(await db`INSERT INTO contact (organization_id,name,phone,phone_normalized)
    VALUES (${org},'Customer','+15550002222','+15550002222') RETURNING id`)[0]!.id;
  await db`INSERT INTO messaging_consent (contact_id,channel,status,source) VALUES (${contact},'WHATSAPP','GRANTED','TEST')`;
  const lead=(await db`INSERT INTO lead (organization_id,branch_id,campaign_id,contact_id,source_kind,assigned_agent_id)
    VALUES (${org},${branch},${campaign},${contact},'MANUAL',${identities.agent!.id}) RETURNING id`)[0]!.id;
  const cv=(await db`INSERT INTO conversation (lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
    VALUES (${lead},${connection},${sender},'WHATSAPP','+15550002222','HUMAN',${identities.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
  await db`INSERT INTO conversation_message (conversation_id,connection_id,sender_id,direction,author_type,body,provider_message_id,delivery_state,received_at)
    VALUES (${cv},${connection},${sender},'INBOUND','CUSTOMER','Ready for media','wamid.media-inbound','RECEIVED',now()-interval '1 second')`;
  let requestNumber=1;
  const headers=(name='agent')=>({ origin:process.env.APP_ORIGIN!,...(name ? { cookie:identities[name]!.cookie } : {}) });
  const api=(method:'GET'|'POST',path:string,body?:object,name='agent')=>app.inject({ method,url:path,payload:body,headers:headers(name) });
  const upload=(key:string,kind:MediaKind,mime:string,bytes:Buffer,name='agent')=>app.inject({ method:'POST',
    url:`/api/conversations/${cv}/attachments?${new URLSearchParams({ key,kind,mime })}`,payload:bytes,
    remoteAddress:`127.0.0.${requestNumber++}`,headers:{ ...headers(name),'content-type':'application/octet-stream' } });
  const fixture=(name:string)=>readFile(`test-fixtures/media/${name}`);
  const ogg=await fixture('tone.ogg');const clip=await fixture('clip.mp4');const sticker=await fixture('sticker.webp');
  assert.equal((await upload('missing-auth','audio','audio/ogg',ogg,'')).statusCode,401);
  for (const actor of ['second','other']) assert.equal((await upload('scope-denied-'+actor,'video','video/mp4',clip,actor)).statusCode,404);
  const details=(await api('GET',`/api/conversations/${cv}`)).json();
  assert.equal(details.conversation.sender_capabilities.mediaRules.audio.caption,false);
  assert.equal(details.conversation.sender_capabilities.mediaRules.sticker.width,512);
  assert.ok(!JSON.stringify(details).includes('test-only-fake'));
  const before=scans;
  assert.equal((await upload('size-invalid','audio','audio/ogg',Buffer.alloc(16*1024*1024+1))).json().error,'MEDIA_PROVIDER_SIZE_INVALID');
  assert.equal((await upload('spoof-invalid','audio','audio/ogg',clip)).json().error,'MEDIA_TYPE_MISMATCH');
  assert.equal(scans,before);
  assert.equal((await upload('codec-invalid','audio','audio/ogg',await fixture('vorbis.ogg'))).json().error,'MEDIA_CODEC_NOT_SUPPORTED');
  assert.equal((await upload('video-invalid','video','video/mp4',await fixture('mpeg4.mp4'))).json().error,'MEDIA_CODEC_NOT_SUPPORTED');
  const smallSticker=Buffer.from(sticker);smallSticker[21]=0;
  assert.equal((await upload('sticker-invalid','sticker','image/webp',smallSticker)).json().error,'MEDIA_STICKER_DIMENSIONS_INVALID');
  clean=false;assert.equal((await upload('scan-invalid','audio','audio/ogg',ogg)).statusCode,422);clean=true;
  const oldProbe=process.env.MEDIA_PROBE_BINARY;process.env.MEDIA_PROBE_BINARY='missing-extended-media-probe';
  try { assert.equal((await upload('probe-unavailable','video','video/mp4',clip)).json().error,'MEDIA_PROBE_UNAVAILABLE'); }
  finally { if (oldProbe===undefined) delete process.env.MEDIA_PROBE_BINARY;else process.env.MEDIA_PROBE_BINARY=oldProbe; }
  // Two replicas retry the same upload: one READY record and audit, content stays immutable.
  const concurrent=await Promise.all([upload('concurrent-audio','audio','audio/ogg',ogg),upload('concurrent-audio','audio','audio/ogg',ogg)]);
  assert.deepEqual(concurrent.map((r)=>r.statusCode).sort(),[200,201]);
  const audioId=concurrent[0]!.json().id;assert.equal(concurrent[1]!.json().id,audioId);
  assert.equal((await db`SELECT count(*)::integer AS n FROM audit_log WHERE target_id=${audioId} AND action='OUTBOUND_ATTACHMENT_UPLOADED'`)[0]!.n,1);
  assert.equal((await upload('concurrent-audio','audio','audio/ogg',await fixture('vorbis.ogg'))).statusCode,409);
  const messagePath=`/api/conversations/${cv}/messages`;
  assert.equal((await api('POST',messagePath,{ attachmentId:audioId,body:'Cannot silently drop this',idempotencyKey:'audio-caption' })).json().error,'MEDIA_CAPTION_NOT_SUPPORTED');
  await assert.rejects(db`INSERT INTO conversation_message (conversation_id,connection_id,sender_id,direction,author_type,author_user_id,body,
      delivery_state,idempotency_key,message_kind,attachment_id) VALUES (${cv},${connection},${sender},'OUTBOUND','HUMAN',${identities.agent!.id},
      'No caption','QUEUED','direct-caption-invalid','ATTACHMENT',${audioId})`,/MEDIA_CAPTION_NOT_SUPPORTED/);
  let uploadCalls=0;let sendCalls=0;let uploadedKind:MediaKind='audio';let behavior:'accept'|'reject-upload'|'unknown'='accept';
  const adapter:MessagingSendAdapter={ sendText:async()=> { throw new Error('Unexpected text send'); },
    uploadMedia:async(input)=> { uploadCalls++;uploadedKind=input.mediaKind;
      assert.equal(createHash('sha256').update(input.bytes).digest('hex'),(await db`SELECT content_sha256 FROM message_attachment
        WHERE upload_conversation_id=${cv} AND content_sha256=${createHash('sha256').update(input.bytes).digest('hex')} LIMIT 1`)[0]!.content_sha256);
      if (behavior==='reject-upload') throw new ProviderSendError('REJECTED','PROVIDER_MEDIA_UPLOAD_REJECTED');
      return { providerMediaId:'12345' };
    },sendMedia:async(input)=> { sendCalls++;assert.equal(input.mediaKind,uploadedKind);
      assert.equal(input.caption,['audio','sticker'].includes(input.mediaKind) ? '' : '<b>Literal caption</b>');
      if (behavior==='unknown') throw new ProviderSendError('UNKNOWN','SEND_OUTCOME_UNKNOWN');
      return { providerMessageId:'wamid.extended-'+sendCalls };
    } };
  const worker=()=>processOneMessagingJob(db,adapter,{ mediaStorage:storage });
  for (const [index,[name,kind,mime]] of ([['tone.ogg','audio','audio/ogg'],['tone.mp3','audio','audio/mpeg'],['tone.m4a','audio','audio/mp4'],
    ['clip.mp4','video','video/mp4'],['sticker.webp','sticker','image/webp'],['animated.webp','sticker','image/webp']] as const).entries()) {
    const bytes=await fixture(name);const attachment=index===0 ? { id:audioId } : (await upload('valid-'+name,kind,mime,bytes)).json();
    assert.ok(attachment.id,JSON.stringify(attachment));
    const download=await api('GET',`/api/messaging/attachments/${attachment.id}/download`);
    assert.equal(download.statusCode,200);assert.deepEqual(download.rawPayload,bytes);
    assert.match(download.headers['content-disposition'] as string,/attachment;/);
    assert.equal((await api('GET',`/api/messaging/attachments/${attachment.id}/download`,undefined,'second')).statusCode,404);
    const intent={ attachmentId:attachment.id,body:kind==='video' ? '<b>Literal caption</b>' : '',idempotencyKey:'valid-send-'+index };
    const queued=await Promise.all([api('POST',messagePath,intent),api('POST',messagePath,intent)]);
    assert.deepEqual(queued.map((r)=>r.statusCode).sort(),[200,202]);assert.equal(queued[0]!.json().id,queued[1]!.json().id);
    await worker();assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${queued[0]!.json().id}`)[0]!.delivery_state,'SENT');
  }
  assert.equal(uploadCalls,6);assert.equal(sendCalls,6);
  // Ownership changes during scanning: no READY metadata or downloadable content leaks to the old owner.
  let release!:()=>void;scanHold=new Promise<void>((r)=> { release=r; });let started!:()=>void;
  const ready=new Promise<void>((r)=> { started=r; });scanStarted=started;
  const ownerRace=upload('scan-owner-race','video','video/mp4',clip);await ready;
  await db`UPDATE lead SET assigned_agent_id=${identities.second!.id} WHERE id=${lead}`;release();
  assert.equal((await ownerRace).statusCode,404);scanHold=undefined;scanStarted=undefined;
  assert.equal((await db`SELECT count(*)::integer AS n FROM message_attachment WHERE upload_idempotency_key='scan-owner-race'`)[0]!.n,0);
  assert.equal((await api('GET',`/api/messaging/attachments/${audioId}/download`)).statusCode,404);
  await db`UPDATE lead SET assigned_agent_id=${identities.agent!.id} WHERE id=${lead}`;
  const blockedFile=(await upload('dnc-video','video','video/mp4',clip)).json().id;
  const blocked=(await api('POST',messagePath,{ attachmentId:blockedFile,body:'<b>Literal caption</b>',idempotencyKey:'dnc-video-send' })).json().id;
  await db`UPDATE messaging_consent SET do_not_contact=true WHERE contact_id=${contact}`;await worker();
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${blocked}`)[0]!.delivery_state,'FAILED');assert.equal(sendCalls,6);
  await db`UPDATE messaging_consent SET do_not_contact=false WHERE contact_id=${contact}`;
  const capFile=(await upload('cap-audio','audio','audio/ogg',ogg)).json().id;
  const capMessage=(await api('POST',messagePath,{ attachmentId:capFile,idempotencyKey:'cap-audio-send' })).json().id;
  await db`UPDATE messaging_sender SET capabilities='{"text":true,"media":["image","document"]}'::jsonb WHERE id=${sender}`;
  await worker();assert.equal(uploadCalls,6);assert.equal(sendCalls,6);
  assert.equal((await db`SELECT last_error_code FROM conversation_message WHERE id=${capMessage}`)[0]!.last_error_code,'MEDIA_SEND_NOT_SUPPORTED');
  assert.equal((await upload('cap-denied','audio','audio/ogg',ogg)).json().error,'MEDIA_SEND_NOT_SUPPORTED');
  await db`UPDATE messaging_sender SET capabilities=${db.json(caps)} WHERE id=${sender}`;
  const retryFile=(await upload('recovery-audio','audio','audio/ogg',ogg)).json().id;
  const retry=(await api('POST',messagePath,{ attachmentId:retryFile,idempotencyKey:'retry-audio-send' })).json().id;
  behavior='reject-upload';await worker();behavior='accept';
  const recovered=await api('POST',`${messagePath}/${retry}/retry`,{ version:1,reason:'Provider upload rejection corrected' });
  assert.equal(recovered.statusCode,202,recovered.body);await worker();
  assert.equal((await db`SELECT body,delivery_state FROM conversation_message WHERE id=${retry}`)[0]!.delivery_state,'SENT');
  assert.equal((await db`SELECT count(*)::integer AS n FROM outbound_message_recovery WHERE message_id=${retry}`)[0]!.n,1);
  const probeFile=(await upload('worker-probe-audio','audio','audio/ogg',ogg)).json().id;
  const probeMessage=(await api('POST',messagePath,{ attachmentId:probeFile,idempotencyKey:'worker-probe-send' })).json().id;
  const uploadsBeforeProbeFailure=uploadCalls;process.env.MEDIA_PROBE_BINARY='missing-worker-media-probe';
  try { await worker(); }
  finally { if (oldProbe===undefined) delete process.env.MEDIA_PROBE_BINARY;else process.env.MEDIA_PROBE_BINARY=oldProbe; }
  assert.equal(uploadCalls,uploadsBeforeProbeFailure);
  const probeJob=(await db`SELECT j.* FROM background_job j JOIN outbound_delivery_job link ON link.job_id=j.id
    WHERE link.message_id=${probeMessage}`)[0]!;
  assert.equal(probeJob.status,'QUEUED');assert.equal(probeJob.last_error_code,'MEDIA_PROBE_UNAVAILABLE');
  assert.equal((await db`SELECT count(*)::integer AS n FROM outbound_send_attempt WHERE message_id=${probeMessage}`)[0]!.n,0);
  await db`UPDATE background_job SET run_after=now() WHERE id=${probeJob.id}`;await worker();
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${probeMessage}`)[0]!.delivery_state,'SENT');
  const unknownFile=(await upload('unknown-sticker','sticker','image/webp',sticker)).json().id;
  assert.equal((await api('POST',messagePath,{ attachmentId:unknownFile,body:'Caption invalid',idempotencyKey:'sticker-caption' })).statusCode,400);
  const uncertain=(await api('POST',messagePath,{ attachmentId:unknownFile,idempotencyKey:'unknown-sticker-send' })).json().id;
  behavior='unknown';await worker();const countAfterUnknown=sendCalls;await worker();assert.equal(sendCalls,countAfterUnknown);
  assert.equal((await api('POST',`${messagePath}/${uncertain}/retry`,{ version:1,reason:'Do not replay accepted or uncertain sends' })).statusCode,409);
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${uncertain}`)[0]!.delivery_state,'UNKNOWN');
});
