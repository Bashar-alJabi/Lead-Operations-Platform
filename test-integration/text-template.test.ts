import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
import { sealSecret } from '../src/credentials.js';
import { processOneMessagingJob } from '../src/messaging/send-worker.js';
import type { ProviderTemplate } from '../src/messaging/templates-provider.js';
import type { MessagingSendAdapter } from '../src/messaging/providers.js';
const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('composite text templates preserve approval/scope, bind dynamic bodies, pin snapshots and revalidate recovery and dispatch',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const catalog:ProviderTemplate[]=[];let creates=0;let sends=0;
  const adapter:MessagingSendAdapter={ sendText:async()=> { throw new Error('Unexpected freeform send'); },
    sendTemplate:async(input)=> { sends++;
      if (input.templateName==='composite_notice') { assert.deepEqual(input.bodyParameters,['Alice']);assert.equal(input.headerParameter,undefined); }
      else { assert.equal(input.templateName,'header_notice');assert.deepEqual(input.bodyParameters,['Order Body']);assert.equal(input.headerParameter,'Alice Header'); }
      return { providerMessageId:'wamid.composite-'+sends }; } };
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,messagingSendAdapter:{ sendText:adapter.sendText,
    sendTemplate:async()=>({ providerMessageId:'wamid.operational-test' }) },messagingTemplateAdapter:{
    list:async()=>catalog,create:async(_config,_credential,input)=> {
      creates++;const template:ProviderTemplate={ externalId:String(9000+creates),name:input.name,language:input.language,
        category:input.category,status:'PENDING',components:[...(input.header ? [{ type:'HEADER',format:'TEXT',text:input.header,
          ...(input.headerExample ? { example:{ header_text:[input.headerExample] } } : {}) }] : []),
          { type:'BODY',text:input.body,...(input.examples ? { example:{ body_text:[input.examples] } } : {}) },
          ...(input.footer ? [{ type:'FOOTER',text:input.footer }] : [])] };
      catalog.push(template);return template;
    } } });
  t.after(async()=> { await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Text templates') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,branchId] of [['agent','AGENT',branch],['second','AGENT',branch],['manager','MANAGER',branch],['other','MANAGER',otherBranch]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${org},${branchId},${name},${role},${name+'@composite.test'},'fixture') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at)
      VALUES (${id},${sha256(token)},now()+interval '1 hour')`;users[name]={ id,cookie:'lop_session='+token };
  }
  const campaign=(await db`INSERT INTO campaign (organization_id,branch_id,name,status,messaging_config)
    VALUES (${org},${branch},'Template','ACTIVE','{"enabled":true}'::jsonb) RETURNING id`)[0]!.id;
  const connection=(await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status,config)
    VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Template','CONNECTED','{"graphVersion":"v25.0","wabaId":"123456789"}'::jsonb) RETURNING id`)[0]!.id;
  const sealed=sealSecret(connection,JSON.stringify({ accessToken:'test-only-no-live' }));
  await db`INSERT INTO connection_secret (connection_id,ciphertext,nonce,auth_tag) VALUES (${connection},${sealed.ciphertext},${sealed.nonce},${sealed.authTag})`;
  const sender=(await db`INSERT INTO messaging_sender (organization_id,connection_id,external_sender_id,display_name,health,capabilities)
    VALUES (${org},${connection},'15550001111','Template','HEALTHY','{"text":true,"template":true}'::jsonb) RETURNING id`)[0]!.id;
  await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
  const contact=(await db`INSERT INTO contact (organization_id,name,phone,phone_normalized)
    VALUES (${org},'Customer','+15550002222','+15550002222') RETURNING id`)[0]!.id;
  await db`INSERT INTO messaging_consent (contact_id,channel,status,source) VALUES (${contact},'WHATSAPP','GRANTED','TEST')`;
  const lead=(await db`INSERT INTO lead (organization_id,branch_id,campaign_id,contact_id,source_kind,assigned_agent_id)
    VALUES (${org},${branch},${campaign},${contact},'MANUAL',${users.agent!.id}) RETURNING id`)[0]!.id;
  const cv=(await db`INSERT INTO conversation (lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
    VALUES (${lead},${connection},${sender},'WHATSAPP','+15550002222','HUMAN',${users.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
  const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,name='agent')=>app.inject({ method,url:path,payload:body,
    headers:{ cookie:users[name]!.cookie,origin:process.env.APP_ORIGIN! } });
  const path=`/api/messaging/connections/${connection}/templates`;
  const input={ name:'composite_notice',language:'en_US',category:'UTILITY',header:'Welcome <b>literal</b>',body:'Dear {{1}}',
    footer:'Closing line',examples:['Example not for Agent'],idempotencyKey:'composite-create-1' };
  assert.equal((await api('POST',path,input)).statusCode,403);assert.equal((await api('POST',path,input,'other')).statusCode,404);
  assert.equal((await api('POST',path,{ ...input,header:'{{1}}' },'manager')).statusCode,400);
  assert.equal((await api('POST',path,{ ...input,footer:' ' },'manager')).statusCode,400);
  const created=await api('POST',path,input,'manager');assert.equal(created.statusCode,201,created.body);const id=created.json().id;
  assert.equal((await api('POST',path,input,'manager')).statusCode,200);assert.equal(creates,1);
  assert.equal((await api('POST',path,{ ...input,header:'Changed title' },'manager')).statusCode,409);
  const binding=`/api/messaging/campaigns/${campaign}/templates/${id}`;
  assert.equal((await api('PUT',binding,{ bound:true,version:0 },'manager')).statusCode,409);
  catalog[0]!.status='APPROVED';await api('POST',path+'/sync',undefined,'manager');
  const list=(await api('GET',`/api/messaging/campaigns/${campaign}/templates`,undefined,'manager')).json();
  assert.equal(list.items[0].parameterCount,1);assert.match(list.items[0].body,/Welcome/);
  assert.equal((await api('PUT',binding,{ bound:true,version:0 },'other')).statusCode,404);
  const bound=await Promise.all([api('PUT',binding,{ bound:true,version:0 },'manager'),api('PUT',binding,{ bound:true,version:0 },'manager')]);
  assert.deepEqual(bound.map((r)=>r.statusCode).sort(),[200,409]);
  const availablePath=`/api/conversations/${cv}/available-templates`;
  const available=(await api('GET',availablePath)).json();assert.equal(available.items[0].parameterCount,1);
  assert.ok(!JSON.stringify(available).includes('Example not for Agent'));assert.equal((await api('GET',availablePath,undefined,'second')).statusCode,404);
  const messages=`/api/conversations/${cv}/messages`;const intent={ templateId:id,templateParameters:['Alice'],idempotencyKey:'composite-send-1' };
  assert.equal((await api('POST',messages,{ ...intent,templateParameters:[] })).statusCode,400);
  const queued=await Promise.all([api('POST',messages,intent),api('POST',messages,intent)]);
  assert.deepEqual(queued.map((r)=>r.statusCode).sort(),[200,202]);const messageId=queued[0]!.json().id;
  const saved=(await db`SELECT body,template_snapshot FROM conversation_message WHERE id=${messageId}`)[0]!;
  assert.equal(saved.body,'Welcome <b>literal</b>\n\nDear Alice\n\nClosing line');assert.equal(saved.template_snapshot.components.length,3);
  (catalog[0]!.components[0] as { text:string }).text='Changed title';await api('POST',path+'/sync',undefined,'manager');
  await processOneMessagingJob(db,adapter);assert.equal(sends,0);
  assert.equal((await db`SELECT last_error_code FROM conversation_message WHERE id=${messageId}`)[0]!.last_error_code,'TEMPLATE_CHANGED');
  (catalog[0]!.components[0] as { text:string }).text=input.header;await api('POST',path+'/sync',undefined,'manager');
  const conversation=(await api('GET',`/api/conversations/${cv}`)).json().conversation;
  await api('POST',`/api/conversations/${cv}/attention/acknowledge`,{ version:conversation.version,expectedReason:'TEMPLATE_CHANGED',
    reviewNote:'Verified the original template after sync',reviewConfirmed:true },'manager');
  const recovery=await api('POST',`${messages}/${messageId}/retry`,{ version:1,reason:'Restored exact approved components' });
  assert.equal(recovery.statusCode,202,recovery.body);await processOneMessagingJob(db,adapter);assert.equal(sends,1);
  await assert.rejects(db`UPDATE conversation_message SET body='History cannot change' WHERE id=${messageId}`,/CUSTOMER_MESSAGE_IMMUTABLE/);
  catalog.push({ ...catalog[0]!,externalId:'9999',name:'unsupported_buttons',components:[{ type:'BODY',text:'Hello' },{ type:'BUTTONS',buttons:[] }] });
  await api('POST',path+'/sync',undefined,'manager');const unsupported=(await db`SELECT id FROM provider_message_template WHERE name='unsupported_buttons'`)[0]!.id;
  assert.equal((await api('PUT',`/api/messaging/campaigns/${campaign}/templates/${unsupported}`,{ bound:true,version:0 },'manager')).json().error,'TEMPLATE_FORMAT_UNSUPPORTED');
  const firstUnsupported='00000000-0000-4000-8000-000000000001';
  await db`UPDATE provider_message_template SET id=${firstUnsupported} WHERE id=${unsupported}`;
  const firstPage=(await api('GET',`/api/messaging/campaigns/${campaign}/templates?limit=1`,undefined,'manager')).json();
  assert.deepEqual(firstPage.items,[]);assert.equal(firstPage.nextAfter,firstUnsupported);
  const secondPage=(await api('GET',`/api/messaging/campaigns/${campaign}/templates?limit=1&after=${firstPage.nextAfter}`,undefined,'manager')).json();
  assert.equal(secondPage.items[0].id,id);assert.equal(secondPage.nextAfter,null);
  const staticCreated=await api('POST',path,{ ...input,name:'static_composite',body:'Fixed body',examples:[],idempotencyKey:'static-composite-create' },'manager');
  assert.equal(staticCreated.statusCode,201,staticCreated.body);catalog[2]!.status='APPROVED';await api('POST',path+'/sync',undefined,'manager');
  const providerCatalog=(await api('GET',path,undefined,'manager')).json().items;
  const staticMetadata=providerCatalog.find((row:{ id:string })=>row.id===staticCreated.json().id);
  assert.equal(staticMetadata.supported,true);assert.equal(staticMetadata.parameterCount,0);
  const unsupportedMetadata=providerCatalog.find((row:{ name:string })=>row.name==='unsupported_buttons');
  assert.equal(unsupportedMetadata.supported,false);assert.equal(unsupportedMetadata.parameterCount,null);
  const headerInput={ name:'header_notice',language:'en_US',category:'UTILITY',header:'Welcome {{1}}',headerExample:'SECRET HEADER APPROVAL',
    body:'Order {{1}}',examples:['SECRET BODY APPROVAL'],footer:'Closing line',idempotencyKey:'header-create-1' };
  assert.equal((await api('POST',path,{ ...headerInput,headerExample:undefined },'manager')).statusCode,400);
  assert.equal((await api('POST',path,{ ...headerInput,header:'Static' },'manager')).statusCode,400);
  assert.equal((await api('POST',path,{ ...headerInput,header:'{{1}} and {{1}}' },'manager')).statusCode,400);
  assert.equal((await api('POST',path,{ ...headerInput,header:'x'.repeat(55)+'{{1}}',headerExample:'0123456789' },'manager')).statusCode,400);
  const headerCreated=await api('POST',path,headerInput,'manager');assert.equal(headerCreated.statusCode,201,headerCreated.body);
  const headerId=headerCreated.json().id;catalog[3]!.status='APPROVED';await api('POST',path+'/sync',undefined,'manager');
  assert.equal((await api('POST',path,{ ...headerInput,headerExample:'Different approval sample' },'manager')).statusCode,409);
  assert.equal((await api('PUT',`/api/messaging/campaigns/${campaign}/templates/${headerId}`,{ bound:true,version:0 },'manager')).statusCode,200);
  const headerAvailable=(await api('GET',availablePath)).json();
  assert.equal(headerAvailable.items.find((row:{ id:string })=>row.id===headerId).headerParameterCount,1);
  assert.ok(!JSON.stringify(headerAvailable).includes('SECRET HEADER APPROVAL'));assert.ok(!JSON.stringify(headerAvailable).includes('SECRET BODY APPROVAL'));
  const headerIntent={ templateId:headerId,templateParameters:['Order Body'],templateHeaderParameter:'Alice Header',idempotencyKey:'header-send-1' };
  for (const value of [undefined,' ','x'.repeat(60),'Alice\nHeader']) {
    const failed=await api('POST',messages,{ ...headerIntent,templateHeaderParameter:value });assert.equal(failed.statusCode,400,failed.body);
  }
  assert.equal((await api('POST',messages,{ body:'Plain text',templateHeaderParameter:'Unexpected',idempotencyKey:'header-on-text' })).statusCode,400);
  assert.equal((await api('POST',messages,{ attachmentId:'00000000-0000-4000-8000-000000000001',templateHeaderParameter:'Unexpected',idempotencyKey:'header-on-media' })).statusCode,400);
  assert.equal((await api('PUT',`/api/messaging/campaigns/${campaign}/templates/${staticCreated.json().id}`,{ bound:true,version:0 },'manager')).statusCode,200);
  assert.equal((await api('POST',messages,{ templateId:staticCreated.json().id,templateHeaderParameter:'Unexpected',idempotencyKey:'header-on-static' })).statusCode,400);
  const headerQueued=await Promise.all([api('POST',messages,headerIntent),api('POST',messages,headerIntent)]);
  assert.deepEqual(headerQueued.map((result)=>result.statusCode).sort(),[200,202]);const headerMessageId=headerQueued[0]!.json().id;
  assert.equal((await api('POST',messages,{ ...headerIntent,templateHeaderParameter:'Other Header' })).statusCode,409);
  const headerSaved=(await db`SELECT body,template_snapshot FROM conversation_message WHERE id=${headerMessageId}`)[0]!;
  assert.equal(headerSaved.body,'Welcome Alice Header\n\nOrder Order Body\n\nClosing line');
  assert.equal(headerSaved.template_snapshot.headerParameter,'Alice Header');assert.deepEqual(headerSaved.template_snapshot.bodyParameters,['Order Body']);
  (catalog[3]!.components[0] as { text:string }).text='Changed {{1}}';await api('POST',path+'/sync',undefined,'manager');
  await processOneMessagingJob(db,adapter);assert.equal(sends,1);
  const headerCv=(await api('GET',`/api/conversations/${cv}`)).json().conversation;
  assert.equal((await api('POST',`/api/conversations/${cv}/attention/acknowledge`,{ version:headerCv.version,expectedReason:'TEMPLATE_CHANGED',
    reviewNote:'Review header version before retry',reviewConfirmed:true },'manager')).statusCode,200);
  assert.equal((await api('POST',`${messages}/${headerMessageId}/retry`,{ version:1,reason:'Template is still changed' })).statusCode,409);
  (catalog[3]!.components[0] as { text:string }).text=headerInput.header;await api('POST',path+'/sync',undefined,'manager');
  const headerRecovery=await api('POST',`${messages}/${headerMessageId}/retry`,{ version:1,reason:'Restored approved original header' });
  assert.equal(headerRecovery.statusCode,202,headerRecovery.body);await processOneMessagingJob(db,adapter);assert.equal(sends,2);
  const headerDelivery=(await db`SELECT delivery_state,body,template_snapshot FROM conversation_message WHERE id=${headerMessageId}`)[0]!;
  assert.equal(headerDelivery.delivery_state,'SENT');assert.deepEqual(headerDelivery.template_snapshot,headerSaved.template_snapshot);assert.equal(headerDelivery.body,headerSaved.body);
  assert.equal((await api('POST',`/api/messaging/connections/${connection}/test-send`,{ senderId:sender,templateId:headerId,
    recipient:'+15550005555',recipientConfirmed:true,idempotencyKey:'no-dynamic-header-test-send' },'manager')).statusCode,409);
  const headerOnly=await api('POST',path,{ ...headerInput,name:'header_only_notice',body:'Fixed body',examples:[],idempotencyKey:'header-only-create' },'manager');
  assert.equal(headerOnly.statusCode,201,headerOnly.body);catalog[4]!.status='APPROVED';await api('POST',path+'/sync',undefined,'manager');
  assert.equal((await api('POST',`/api/messaging/connections/${connection}/test-send`,{ senderId:sender,templateId:headerOnly.json().id,
    recipient:'+15550005555',recipientConfirmed:true,idempotencyKey:'no-header-only-test-send' },'manager')).statusCode,409);
  const tested=await api('POST',`/api/messaging/connections/${connection}/test-send`,{ senderId:sender,templateId:staticCreated.json().id,
    recipient:'+15550005555',recipientConfirmed:true,idempotencyKey:'static-operational-test' },'manager');
  assert.equal(tested.statusCode,200,tested.body);
  const audit=await db`SELECT action,detail FROM audit_log WHERE organization_id=${org}`;
  assert.equal(audit.filter((row)=>row.action==='MESSAGING_TEMPLATE_CREATED').length,4);
  assert.equal(audit.filter((row)=>row.action==='CAMPAIGN_TEMPLATE_BOUND').length,3);
  assert.equal(audit.filter((row)=>row.action==='OUTBOUND_MESSAGE_QUEUED').length,2);
  assert.ok(!JSON.stringify(audit).includes('test-only-no-live'));
  assert.ok(!JSON.stringify(audit).includes('Example not for Agent'));
  assert.ok(!JSON.stringify(audit).includes('SECRET HEADER APPROVAL'));
});
