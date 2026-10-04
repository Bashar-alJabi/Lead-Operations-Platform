import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealSecret } from '../src/credentials.js';
import { sha256 } from '../src/security.js';
import { localMediaStorage } from '../src/media/storage.js';
import { metaMediaCapabilities } from '../src/media/meta-outbound.js';
import { processOneTemplateSample } from '../src/media/template-sample-worker.js';
import { processOneMessagingJob } from '../src/messaging/send-worker.js';
import { ProviderSendError,type MessagingSendAdapter } from '../src/messaging/providers.js';
import type { ProviderTemplate } from '../src/messaging/templates-provider.js';
const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('media template setup separates approval samples from customer files and enforces immutable dispatch, policy, access and recovery',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const root=await mkdtemp(resolve('.local/media-template-'));const storage=localMediaStorage(root);
  const scanner={ scan:async()=>({ clean:true,version:'SyntheticScanner/test-only' }) };const catalog:ProviderTemplate[]=[];let creates=0;
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,mediaStorage:storage,mediaScanner:scanner,messagingTemplateAdapter:{
    list:async()=>catalog,create:async(_config,_credentials,input)=> {
      creates++;assert.ok(input.mediaHeader);assert.equal(input.mediaHeader.handle,'2:private:approval-'+input.mediaHeader.format.toLowerCase());
      const item:ProviderTemplate={ externalId:String(7000+creates),name:input.name,language:input.language,category:input.category,status:'PENDING',
        components:[{ type:'HEADER',format:input.mediaHeader.format,example:{ header_handle:[input.mediaHeader.handle] } },
          { type:'BODY',text:input.body,example:{ body_text:[input.examples] } },{ type:'FOOTER',text:'Media footer' }] };
      catalog.push(item);return item;
    } } });
  t.after(async()=> { await app.close();await db.end();await rm(root,{ recursive:true,force:true }); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Media template test') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const other=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope] of [['agent','AGENT',branch],['second','AGENT',branch],['manager','MANAGER',branch],['other','MANAGER',other]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${org},${scope},${name},${role},${name+'@media-template.test'},'synthetic-non-login-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
    users[name]={ id,cookie:'lop_session='+token };
  }
  const campaign=(await db`INSERT INTO campaign (organization_id,branch_id,name,status,messaging_config)
    VALUES (${org},${branch},'Media templates','ACTIVE','{"enabled":true}'::jsonb) RETURNING id`)[0]!.id;
  const connection=(await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status,config)
    VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Templates','CONNECTED','{"graphVersion":"v25.0","wabaId":"123"}'::jsonb) RETURNING id`)[0]!.id;
  const secret=sealSecret(connection,JSON.stringify({ accessToken:'synthetic-only-no-live',appSecret:'test-only',verifyToken:'test-only' }));
  await db`INSERT INTO connection_secret (connection_id,ciphertext,nonce,auth_tag) VALUES (${connection},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
  const sender=(await db`INSERT INTO messaging_sender (organization_id,connection_id,external_sender_id,display_name,health,capabilities)
    VALUES (${org},${connection},'15550001111','Template sender','HEALTHY',${db.json({ text:true,template:true,...metaMediaCapabilities() })}) RETURNING id`)[0]!.id;
  await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
  const contact=(await db`INSERT INTO contact (organization_id,name,phone,phone_normalized) VALUES (${org},'Customer','+15550002222','+15550002222') RETURNING id`)[0]!.id;
  await db`INSERT INTO messaging_consent (contact_id,channel,status,source) VALUES (${contact},'WHATSAPP','GRANTED','TEST')`;
  const lead=(await db`INSERT INTO lead (organization_id,branch_id,campaign_id,contact_id,source_kind,assigned_agent_id)
    VALUES (${org},${branch},${campaign},${contact},'MANUAL',${users.agent!.id}) RETURNING id`)[0]!.id;
  const cv=(await db`INSERT INTO conversation (lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
    VALUES (${lead},${connection},${sender},'WHATSAPP','+15550002222','HUMAN',${users.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
  const headers=(actor='agent')=>({ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie });
  let address=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='agent')=>app.inject({ method,url:path,payload:body,headers:headers(actor),remoteAddress:`127.0.0.${address++}` });
  const upload=(path:string,key:string,kind:string,mime:string,bytes:Buffer,actor='agent')=>app.inject({ method:'POST',url:path+'?'+new URLSearchParams({ key,kind,mime }),
    payload:bytes,headers:{ ...headers(actor),'content-type':'application/octet-stream' },remoteAddress:`127.0.0.${address++}` });
  const base=`/api/messaging/connections/${connection}`;const messages=`/api/conversations/${cv}/messages`;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5C6WQAAAAASUVORK5CYII=','base64');
  const files={ image:{ mime:'image/png',bytes:png },document:{ mime:'application/pdf',bytes:Buffer.from('%PDF-1.7\nCustomer file\n%%EOF\n') },
    video:{ mime:'video/mp4',bytes:await readFile('test-fixtures/media/clip.mp4') } };
  let uploads=0;let sends=0;let mode:'accept'|'reject'|'retry-upload'|'unknown'='accept';let afterUpload:(()=>Promise<void>)|undefined;
  const sent:unknown[]=[];const adapter:MessagingSendAdapter={ sendText:async()=> { throw new Error('Unexpected freeform send'); },
    uploadMedia:async(input)=> { uploads++;assert.equal(input.caption,'');assert.equal(input.mime,files[input.mediaKind as keyof typeof files].mime);
      if (mode==='retry-upload') throw new ProviderSendError('RETRYABLE','PROVIDER_MEDIA_UPLOAD_UNAVAILABLE');await afterUpload?.();return { providerMediaId:String(9000+uploads) }; },
    sendTemplate:async(input)=> { sends++;assert.ok(input.mediaHeader);assert.equal(input.headerParameter,undefined);assert.deepEqual(input.bodyParameters,['Alice']);
      assert.ok(!JSON.stringify(input).includes('approval-'));sent.push(input.mediaHeader);
      if (mode==='reject') throw new ProviderSendError('REJECTED','PROVIDER_SEND_REJECTED');if (mode==='unknown') throw new ProviderSendError('UNKNOWN','PROVIDER_SEND_OUTCOME_UNKNOWN');
      return { providerMessageId:'wamid.media-template-'+sends }; } };
  const work=()=>processOneMessagingJob(db,adapter,{ mediaStorage:storage });
  const retry=async(id:string)=>api('POST',`${messages}/${id}/retry`,{ version:(await db`SELECT recovery_version FROM outbound_delivery_job WHERE message_id=${id}`)[0]!.recovery_version,reason:'Restored verified template and media configuration' });
  let imageTemplate='';let imageMessage='';let imageAttachment='';
  for (const kind of ['image','document','video'] as const) {
    const file=files[kind];const sampleResponse=await upload(base+'/template-samples','approval-'+kind,kind,file.mime,file.bytes,'manager');
    assert.equal(sampleResponse.statusCode,201,sampleResponse.body);const sampleId=sampleResponse.json().id;
    const input={ name:'media_'+kind,language:'en_US',category:'UTILITY',body:'Hello {{1}}',examples:['Approval example only'],footer:'Media footer',mediaSampleId:sampleId,idempotencyKey:'create-'+kind };
    assert.equal((await api('POST',base+'/templates',input,'manager')).json().error,'TEMPLATE_SAMPLE_NOT_READY');
    await processOneTemplateSample(db,{ storage,scanner,adapter:{ upload:async()=>({ handle:'2:private:approval-'+kind }) } });
    if (kind==='image') {
      assert.equal((await api('POST',base+'/templates',input)).statusCode,403);assert.equal((await api('POST',base+'/templates',input,'other')).statusCode,404);
      assert.equal((await api('POST',base+'/templates',{ ...input,header:'Conflicting text' },'manager')).statusCode,400);
      assert.equal((await api('POST',base+'/templates',{ ...input,mediaHeader:{ format:'IMAGE',handle:'client-secret' } },'manager')).statusCode,400);
    }
    const created=await api('POST',base+'/templates',input,'manager');assert.equal(created.statusCode,201,created.body);const id=created.json().id;
    assert.equal((await api('POST',base+'/templates',input,'manager')).json().existing,true);
    const binding=`/api/messaging/campaigns/${campaign}/templates/${id}`;
    assert.equal((await api('PUT',binding,{ version:0,bound:true },'manager')).statusCode,409);catalog.at(-1)!.status='APPROVED';await api('POST',base+'/templates/sync',undefined,'manager');
    assert.equal((await api('PUT',binding,{ version:0,bound:true },'manager')).statusCode,200);
    const available=(await api('GET',`/api/conversations/${cv}/available-templates`)).json();assert.equal(available.items.find((item:{ id:string })=>item.id===id).headerMediaKind,kind);
    assert.ok(!JSON.stringify(available).includes('approval-'));assert.ok(!JSON.stringify((await api('GET',base+'/templates',undefined,'manager')).json()).includes('approval-'));
    assert.ok(!JSON.stringify((await db`SELECT components FROM provider_message_template WHERE id=${id}`)[0]).includes('approval-'));
    assert.equal((await api('POST',messages,{ templateId:id,templateParameters:['Alice'],idempotencyKey:'missing-'+kind })).json().error,'TEMPLATE_MEDIA_INVALID');
    assert.equal((await api('POST',messages,{ templateId:id,templateParameters:['Alice'],attachmentId:sampleId,idempotencyKey:'sample-not-file-'+kind })).statusCode,404);
    const attachment=(await upload(`/api/conversations/${cv}/attachments`,'customer-'+kind,kind,file.mime,file.bytes)).json().id;
    const sendInput={ templateId:id,templateParameters:['Alice'],attachmentId:attachment,idempotencyKey:'send-'+kind };
    assert.equal((await api('POST',messages,{ ...sendInput,body:'Cannot replace approved body' })).statusCode,400);
    assert.equal((await api('POST',messages,sendInput,'second')).statusCode,404);assert.equal((await api('POST',messages,sendInput,'other')).statusCode,404);
    const concurrent=await Promise.all([api('POST',messages,sendInput),api('POST',messages,sendInput)]);assert.deepEqual(concurrent.map((r)=>r.statusCode).sort(),[200,202]);
    const messageId=concurrent[0]!.json().id;assert.equal(concurrent[1]!.json().id,messageId);
    assert.equal((await api('POST',messages,{ ...sendInput,idempotencyKey:'another-send-'+kind })).json().error,'ATTACHMENT_ALREADY_USED');
    if (kind==='image') {
      imageTemplate=id;imageMessage=messageId;imageAttachment=attachment;mode='retry-upload';await work();assert.equal(sends,0);
      assert.equal((await db`SELECT count(*)::integer AS n FROM outbound_send_attempt WHERE message_id=${messageId}`)[0]!.n,0);
      await db`UPDATE background_job SET run_after=now() WHERE id=(SELECT job_id FROM outbound_delivery_job WHERE message_id=${messageId})`;
      mode='reject';await work();assert.equal(sends,1);const recovered=await retry(messageId);assert.equal(recovered.statusCode,202,recovered.body);mode='accept';
    }
    const workerResults=await Promise.all([work(),work()]);assert.deepEqual(workerResults.sort(),[false,true]);
    const saved=(await db`SELECT * FROM conversation_message WHERE id=${messageId}`)[0]!;assert.equal(saved.message_kind,'TEMPLATE');assert.equal(saved.delivery_state,'SENT');
    assert.equal(saved.body,'Hello Alice\n\nMedia footer');assert.equal(saved.template_snapshot.mediaHeader.attachmentId,attachment);
    assert.ok(!JSON.stringify(saved.template_snapshot).includes('approval-'));assert.equal((sent.at(-1) as { kind:string }).kind,kind);
    const history=(await api('GET',messages)).json().items.find((item:{ id:string })=>item.id===messageId);assert.equal(history.attachment.id,attachment);
    assert.equal((await api('GET',`/api/messaging/attachments/${attachment}/download`)).rawPayload.equals(file.bytes),true);
    assert.equal((await retry(messageId)).statusCode,409);
  }
  const wrong=(await upload(`/api/conversations/${cv}/attachments`,'wrong-header-file','document',files.document.mime,files.document.bytes)).json().id;
  assert.equal((await api('POST',messages,{ templateId:imageTemplate,attachmentId:wrong,templateParameters:['Alice'],idempotencyKey:'wrong-kind-send' })).json().error,'TEMPLATE_MEDIA_INVALID');
  const changedAttachment=(await upload(`/api/conversations/${cv}/attachments`,'changed-header-file','image',files.image.mime,files.image.bytes)).json().id;
  const changed=await api('POST',messages,{ templateId:imageTemplate,attachmentId:changedAttachment,templateParameters:['Alice'],idempotencyKey:'changed-header-send' });assert.equal(changed.statusCode,202);
  (catalog[0]!.components[0] as { format:string }).format='VIDEO';await api('POST',base+'/templates/sync',undefined,'manager');const sendsBefore=sends;const uploadsBefore=uploads;await work();
  assert.equal(sends,sendsBefore);assert.equal(uploads,uploadsBefore);assert.equal((await db`SELECT last_error_code FROM conversation_message WHERE id=${changed.json().id}`)[0]!.last_error_code,'TEMPLATE_CHANGED');
  (catalog[0]!.components[0] as { format:string }).format='IMAGE';await api('POST',base+'/templates/sync',undefined,'manager');
  const version=(await api('GET',`/api/conversations/${cv}`)).json().conversation.version;
  await api('POST',`/api/conversations/${cv}/attention/acknowledge`,{ version,expectedReason:'TEMPLATE_CHANGED',reviewConfirmed:true,reviewNote:'Verified approved media header restored' },'manager');
  assert.equal((await retry(changed.json().id)).statusCode,202);await work();
  const dncFile=(await upload(`/api/conversations/${cv}/attachments`,'policy-header-file','image',files.image.mime,files.image.bytes)).json().id;
  const dnc=await api('POST',messages,{ templateId:imageTemplate,attachmentId:dncFile,templateParameters:['Alice'],idempotencyKey:'dnc-after-upload' });
  afterUpload=async()=> { await db`UPDATE messaging_consent SET do_not_contact=true WHERE contact_id=${contact}`; };const beforeDnc=sends;await work();afterUpload=undefined;assert.equal(sends,beforeDnc);
  assert.equal((await db`SELECT last_error_code FROM conversation_message WHERE id=${dnc.json().id}`)[0]!.last_error_code,'DO_NOT_CONTACT');
  await db`UPDATE messaging_consent SET do_not_contact=false WHERE contact_id=${contact}`;assert.equal((await retry(dnc.json().id)).statusCode,202);await work();
  await assert.rejects(db`UPDATE conversation_message SET attachment_id=${wrong} WHERE id=${imageMessage}`,/CUSTOMER_MESSAGE_IMMUTABLE/);
  const original=(await db`SELECT template_snapshot FROM conversation_message WHERE id=${imageMessage}`)[0]!.template_snapshot;
  await assert.rejects(db`INSERT INTO conversation_message (conversation_id,connection_id,sender_id,direction,author_type,author_user_id,body,
    delivery_state,message_kind,template_id,template_snapshot,attachment_id,idempotency_key) VALUES (${cv},${connection},${sender},'OUTBOUND','HUMAN',${users.agent!.id},
    'Invalid reference','QUEUED','TEMPLATE',${imageTemplate},${db.json(original)},${wrong},'direct-mismatched-media')`,/TEMPLATE_MEDIA_REFERENCE_INVALID/);
  const unknownFile=(await upload(`/api/conversations/${cv}/attachments`,'unknown-header-file','image',files.image.mime,files.image.bytes)).json().id;
  const unknown=await api('POST',messages,{ templateId:imageTemplate,attachmentId:unknownFile,templateParameters:['Alice'],idempotencyKey:'unknown-media-send' });mode='unknown';await work();
  assert.equal((await db`SELECT delivery_state FROM conversation_message WHERE id=${unknown.json().id}`)[0]!.delivery_state,'UNKNOWN');assert.equal((await retry(unknown.json().id)).statusCode,409);
  assert.equal(await work(),false);const audit=JSON.stringify(await db`SELECT detail FROM audit_log`);assert.ok(!audit.includes('approval-'));assert.ok(!audit.includes('synthetic-only-no-live'));
  await db`UPDATE lead SET assigned_agent_id=${users.second!.id} WHERE id=${lead}`;
  assert.equal((await api('GET',messages)).statusCode,404);assert.equal((await api('GET',`/api/messaging/attachments/${imageAttachment}/download`)).statusCode,404);
  assert.equal((await api('GET',messages,undefined,'second')).statusCode,200);assert.equal((await api('GET',`/api/messaging/attachments/${imageAttachment}/download`,undefined,'second')).statusCode,200);
});
