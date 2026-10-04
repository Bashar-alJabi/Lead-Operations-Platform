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
import { renderTemplateUrl } from '../src/messaging/approved-template.js';
const url=process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('composite text templates preserve approval/scope, bind dynamic bodies, pin snapshots and revalidate recovery and dispatch',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  const db=createDatabase(url);const catalog:ProviderTemplate[]=[];let creates=0;let sends=0;
  const adapter:MessagingSendAdapter={ sendText:async()=> { throw new Error('Unexpected freeform send'); },
    sendTemplate:async(input)=> { sends++;
      if (input.templateName==='composite_notice') { assert.deepEqual(input.bodyParameters,['Alice']);assert.equal(input.headerParameter,undefined); }
      else if (input.templateName==='header_notice') { assert.deepEqual(input.bodyParameters,['Order Body']);assert.equal(input.headerParameter,'Alice Header'); }
      else if (input.templateName==='cta_notice') { assert.deepEqual(input.bodyParameters,['Order CTA']);assert.equal(input.headerParameter,undefined); }
      else { assert.equal(input.templateName,'dynamic_url_notice');assert.deepEqual(input.bodyParameters,['Body Order']);assert.equal(input.headerParameter,'Header Alice');
        assert.deepEqual(input.urlButton,{ index:1,suffix:'order-123?source=crm' }); }
      if (input.templateName!=='dynamic_url_notice') assert.equal(input.urlButton,undefined);
      return { providerMessageId:'wamid.composite-'+sends }; } };
  const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000,messagingSendAdapter:{ sendText:adapter.sendText,
    sendTemplate:async()=>({ providerMessageId:'wamid.operational-test' }) },messagingTemplateAdapter:{
    list:async()=>catalog,create:async(_config,_credential,input)=> {
      creates++;const template:ProviderTemplate={ externalId:String(9000+creates),name:input.name,language:input.language,
        category:input.category,status:'PENDING',components:[...(input.header ? [{ type:'HEADER',format:'TEXT',text:input.header,
          ...(input.headerExample ? { example:{ header_text:[input.headerExample] } } : {}) }] : []),
          { type:'BODY',text:input.body,...(input.examples ? { example:{ body_text:[input.examples] } } : {}) },
          ...(input.footer ? [{ type:'FOOTER',text:input.footer }] : []),...(input.buttons ? [{ type:'BUTTONS',buttons:input.buttons.map((button)=>
            button.type==='URL' && input.urlExample ? { ...button,example:[renderTemplateUrl(button.url,input.urlExample)] } : button) }] : [])] };
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
  let clientAddress='127.0.0.1';
  const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,name='agent')=>app.inject({ method,url:path,payload:body,remoteAddress:clientAddress,
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
  const buttons=[{ type:'URL',text:'Visit site',url:'https://example.test/offer' },{ type:'PHONE_NUMBER',text:'Call us',phone_number:'+15550007777' }];
  // A second synthetic client for this group; previous negative cases correctly consumed the creation abuse quota.
  clientAddress='127.0.0.2';
  const ctaInput={ ...headerInput,name:'cta_notice',header:'CTA greeting',headerExample:undefined,buttons,idempotencyKey:'cta-create-1' };
  for (const value of [[{ ...buttons[0],url:'javascript:alert(1)' }],[buttons[0],buttons[0]],[{ ...buttons[1],phone_number:'1234' }],
    [{ ...buttons[1],phone_number:'+15550007777\n' }],[{ type:'QUICK_REPLY',text:'Reply' }],[{ ...buttons[0],text:' ' }]])
    assert.equal((await api('POST',path,{ ...ctaInput,buttons:value },'manager')).statusCode,400);
  assert.equal(creates,4);
  const ctaCreated=await api('POST',path,ctaInput,'manager');assert.equal(ctaCreated.statusCode,201,ctaCreated.body);const ctaId=ctaCreated.json().id;
  const ctaBinding=`/api/messaging/campaigns/${campaign}/templates/${ctaId}`;
  assert.equal((await api('PUT',ctaBinding,{ bound:true,version:0 },'manager')).statusCode,409);
  catalog[5]!.status='APPROVED';await api('POST',path+'/sync',undefined,'manager');
  assert.equal((await api('PUT',ctaBinding,{ bound:true,version:0 },'manager')).statusCode,200);
  const ctaAvailable=(await api('GET',availablePath)).json().items.find((row:{ id:string })=>row.id===ctaId);
  assert.deepEqual(ctaAvailable.buttons,buttons);assert.equal(ctaAvailable.components.length,3);
  const ctaIntent={ templateId:ctaId,templateParameters:['Order CTA'],idempotencyKey:'cta-send-1' };
  const ctaQueued=await Promise.all([api('POST',messages,ctaIntent),api('POST',messages,ctaIntent)]);
  assert.deepEqual(ctaQueued.map((result)=>result.statusCode).sort(),[200,202]);const ctaMessageId=ctaQueued[0]!.json().id;
  const originalCta=(await db`SELECT body,template_snapshot FROM conversation_message WHERE id=${ctaMessageId}`)[0]!;
  assert.equal(originalCta.body,'CTA greeting\n\nOrder Order CTA\n\nClosing line');
  assert.deepEqual(originalCta.template_snapshot.components[3].buttons,buttons);
  (catalog[5]!.components[3] as { buttons:{ url:string }[] }).buttons[0]!.url='https://example.test/changed';
  await api('POST',path+'/sync',undefined,'manager');await processOneMessagingJob(db,adapter);assert.equal(sends,2);
  const ctaCv=(await api('GET',`/api/conversations/${cv}`)).json().conversation;
  assert.equal((await api('POST',`/api/conversations/${cv}/attention/acknowledge`,{ version:ctaCv.version,expectedReason:'TEMPLATE_CHANGED',
    reviewNote:'Review original CTA target',reviewConfirmed:true },'manager')).statusCode,200);
  assert.equal((await api('POST',`${messages}/${ctaMessageId}/retry`,{ version:1,reason:'Target still differs' })).statusCode,409);
  (catalog[5]!.components[3] as { buttons:{ url:string }[] }).buttons[0]!.url='https://example.test/offer';
  await api('POST',path+'/sync',undefined,'manager');
  const ctaRetry=await api('POST',`${messages}/${ctaMessageId}/retry`,{ version:1,reason:'Restored exact original CTA target' });
  assert.equal(ctaRetry.statusCode,202,ctaRetry.body);await processOneMessagingJob(db,adapter);assert.equal(sends,3);
  const tampered=JSON.parse(JSON.stringify(originalCta.template_snapshot));tampered.components[3].buttons[0].url='https://example.test/tampered';
  await assert.rejects(db`UPDATE conversation_message SET template_snapshot=${db.json(tampered)} WHERE id=${ctaMessageId}`,/CUSTOMER_MESSAGE_IMMUTABLE/);
  // A later approved catalog change must not rewrite the target visible in the accepted message's history.
  (catalog[5]!.components[3] as { buttons:{ url:string }[] }).buttons[0]!.url='https://example.test/new-offer';
  await api('POST',path+'/sync',undefined,'manager');
  const history=(await api('GET',messages+'?limit=100')).json().items.find((row:{ id:string })=>row.id===ctaMessageId);
  assert.equal(history.delivery_state,'SENT');assert.deepEqual(history.templateButtons,buttons);assert.equal(history.body,originalCta.body);
  assert.equal(history.template_snapshot,undefined);
  clientAddress='127.0.0.3';
  const dynamicButtons=[buttons[1],{ type:'URL',text:'Track order',url:'https://example.test/orders/{{1}}' }];
  const dynamicInput={ ...headerInput,name:'dynamic_url_notice',buttons:dynamicButtons,urlExample:'SECRET-URL-APPROVAL',idempotencyKey:'dynamic-url-create' };
  assert.equal((await api('POST',path,dynamicInput)).statusCode,403);assert.equal((await api('POST',path,dynamicInput,'other')).statusCode,404);
  for (const value of [undefined,'',' ','https://evil.test','//evil.test','a\\b','a%00','x'.repeat(2000)]) {
    const invalid=await api('POST',path,{ ...dynamicInput,urlExample:value },'manager');assert.equal(invalid.statusCode,400,invalid.body);
  }
  const orphan=await api('POST',path,{ ...dynamicInput,buttons },'manager');assert.equal(orphan.statusCode,400,orphan.body);assert.equal(creates,5);
  const dynamicCreated=await api('POST',path,dynamicInput,'manager');assert.equal(dynamicCreated.statusCode,201,dynamicCreated.body);const dynamicId=dynamicCreated.json().id;
  assert.equal((await api('POST',path,dynamicInput,'manager')).statusCode,200);assert.equal(creates,6);
  assert.equal((await api('POST',path,{ ...dynamicInput,urlExample:'Different approval' },'manager')).statusCode,400);
  assert.equal((await api('POST',path,{ ...dynamicInput,urlExample:'changed-approval' },'manager')).statusCode,409);
  const dynamicBinding=`/api/messaging/campaigns/${campaign}/templates/${dynamicId}`;
  assert.equal((await api('PUT',dynamicBinding,{ bound:true,version:0 },'manager')).statusCode,409);
  catalog[6]!.status='APPROVED';await api('POST',path+'/sync',undefined,'manager');
  assert.equal((await api('PUT',dynamicBinding,{ bound:true,version:0 },'other')).statusCode,404);
  assert.equal((await api('PUT',dynamicBinding,{ bound:true,version:0 },'manager')).statusCode,200);
  const urlAvailable=(await api('GET',availablePath)).json();const dynamicAvailable=urlAvailable.items.find((row:{ id:string })=>row.id===dynamicId);
  assert.equal(dynamicAvailable.urlParameterIndex,1);assert.deepEqual(dynamicAvailable.buttons,dynamicButtons);
  assert.ok(!JSON.stringify(urlAvailable).includes('SECRET-URL-APPROVAL'));
  const dynamicIntent={ templateId:dynamicId,templateParameters:['Body Order'],templateHeaderParameter:'Header Alice',
    templateUrlParameter:'order-123?source=crm',idempotencyKey:'dynamic-url-send' };
  for (const value of [undefined,'',' ','https://evil.test','//evil.test','a\\b','a%00','x'.repeat(2000)]) {
    const invalid=await api('POST',messages,{ ...dynamicIntent,templateUrlParameter:value });assert.equal(invalid.statusCode,400,invalid.body);
  }
  assert.equal((await api('POST',messages,{ ...ctaIntent,idempotencyKey:'orphan-url-static',templateUrlParameter:'orphan' })).statusCode,400);
  assert.equal((await api('POST',messages,{ body:'Plain text',templateUrlParameter:'orphan',idempotencyKey:'orphan-url-text' })).statusCode,400);
  assert.equal((await api('POST',messages,{ attachmentId:'00000000-0000-4000-8000-000000000001',templateUrlParameter:'orphan',idempotencyKey:'orphan-url-media' })).statusCode,400);
  assert.equal((await api('POST',messages,dynamicIntent,'second')).statusCode,404);assert.equal((await api('POST',messages,dynamicIntent,'other')).statusCode,404);
  await db`UPDATE messaging_consent SET do_not_contact=true WHERE contact_id=${contact}`;
  assert.equal((await api('POST',messages,dynamicIntent)).statusCode,409);await db`UPDATE messaging_consent SET do_not_contact=false WHERE contact_id=${contact}`;
  const dynamicQueued=await Promise.all([api('POST',messages,dynamicIntent),api('POST',messages,dynamicIntent)]);
  assert.deepEqual(dynamicQueued.map((result)=>result.statusCode).sort(),[200,202]);const dynamicMessageId=dynamicQueued[0]!.json().id;
  assert.equal((await api('POST',messages,{ ...dynamicIntent,templateUrlParameter:'other-order' })).statusCode,409);
  const dynamicSaved=(await db`SELECT body,template_snapshot FROM conversation_message WHERE id=${dynamicMessageId}`)[0]!;
  assert.equal(dynamicSaved.body,'Welcome Header Alice\n\nOrder Body Order\n\nClosing line');
  assert.equal(dynamicSaved.template_snapshot.urlParameter,'order-123?source=crm');assert.equal(dynamicSaved.template_snapshot.headerParameter,'Header Alice');
  assert.deepEqual(dynamicSaved.template_snapshot.bodyParameters,['Body Order']);assert.deepEqual(dynamicSaved.template_snapshot.components[3].buttons,dynamicButtons);
  assert.ok(!JSON.stringify(dynamicSaved).includes('SECRET-URL-APPROVAL'));
  const dynamicPart=catalog[6]!.components[3] as { buttons:{ type:string;url?:string;example?:string[] }[] };
  dynamicPart.buttons.reverse();await api('POST',path+'/sync',undefined,'manager');await processOneMessagingJob(db,adapter);assert.equal(sends,3);
  const dynamicCv=(await api('GET',`/api/conversations/${cv}`)).json().conversation;
  assert.equal((await api('POST',`/api/conversations/${cv}/attention/acknowledge`,{ version:dynamicCv.version,expectedReason:'TEMPLATE_CHANGED',
    reviewNote:'Review original URL index before recovery',reviewConfirmed:true },'manager')).statusCode,200);
  const dynamicRetryPath=`${messages}/${dynamicMessageId}/retry`;
  assert.equal((await api('POST',dynamicRetryPath,{ version:1,reason:'Index still differs' })).statusCode,409);
  dynamicPart.buttons.reverse();dynamicPart.buttons[1]!.example=['Changed approval sample only'];await api('POST',path+'/sync',undefined,'manager');
  assert.equal((await api('POST',dynamicRetryPath,{ version:1,reason:'Unauthorized recovery' },'second')).statusCode,404);
  const dynamicRecovered=await api('POST',dynamicRetryPath,{ version:1,reason:'Restored exact URL index and approved prefix' });
  assert.equal(dynamicRecovered.statusCode,202,dynamicRecovered.body);await processOneMessagingJob(db,adapter);assert.equal(sends,4);
  const dynamicHistory=(await api('GET',messages+'?limit=100')).json().items.find((row:{ id:string })=>row.id===dynamicMessageId);
  assert.equal(dynamicHistory.delivery_state,'SENT');assert.deepEqual(dynamicHistory.templateButtons,[dynamicButtons[0],
    { ...dynamicButtons[1],url:'https://example.test/orders/order-123?source=crm' }]);assert.equal(dynamicHistory.template_snapshot,undefined);
  const urlTampered={ ...dynamicSaved.template_snapshot,urlParameter:'edited-after-send' };
  await assert.rejects(db`UPDATE conversation_message SET template_snapshot=${db.json(urlTampered)} WHERE id=${dynamicMessageId}`,/CUSTOMER_MESSAGE_IMMUTABLE/);
  dynamicPart.buttons[1]!.url='https://example.test/new/{{1}}';await api('POST',path+'/sync',undefined,'manager');
  assert.deepEqual((await api('GET',messages+'?limit=100')).json().items.find((row:{ id:string })=>row.id===dynamicMessageId).templateButtons,dynamicHistory.templateButtons);
  const urlOnly=await api('POST',path,{ ...dynamicInput,name:'url_only_notice',header:'Static',headerExample:undefined,body:'Fixed body',examples:[],idempotencyKey:'url-only-create' },'manager');
  assert.equal(urlOnly.statusCode,201,urlOnly.body);catalog[7]!.status='APPROVED';await api('POST',path+'/sync',undefined,'manager');
  assert.equal((await api('POST',`/api/messaging/connections/${connection}/test-send`,{ senderId:sender,templateId:urlOnly.json().id,
    recipient:'+15550005555',recipientConfirmed:true,idempotencyKey:'no-url-only-test-send' },'manager')).statusCode,409);
  const tested=await api('POST',`/api/messaging/connections/${connection}/test-send`,{ senderId:sender,templateId:staticCreated.json().id,
    recipient:'+15550005555',recipientConfirmed:true,idempotencyKey:'static-operational-test' },'manager');
  assert.equal(tested.statusCode,200,tested.body);
  const audit=await db`SELECT action,detail FROM audit_log WHERE organization_id=${org}`;
  assert.equal(audit.filter((row)=>row.action==='MESSAGING_TEMPLATE_CREATED').length,7);
  assert.equal(audit.filter((row)=>row.action==='CAMPAIGN_TEMPLATE_BOUND').length,5);
  assert.equal(audit.filter((row)=>row.action==='OUTBOUND_MESSAGE_QUEUED').length,4);
  assert.ok(!JSON.stringify(audit).includes('test-only-no-live'));
  assert.ok(!JSON.stringify(audit).includes('Example not for Agent'));
  assert.ok(!JSON.stringify(audit).includes('SECRET HEADER APPROVAL'));
  assert.ok(!JSON.stringify(audit).includes('SECRET-URL-APPROVAL'));assert.ok(!JSON.stringify(audit).includes('order-123?source=crm'));
});
