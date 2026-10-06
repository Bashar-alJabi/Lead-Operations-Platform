// Test-only HTTP entrypoint. Never imported by the production server or workers.
import { randomBytes,createHmac } from 'node:crypto';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sealSecret,openOpaque } from '../src/credentials.js';
import { passwordHash, safeTokenEqual, HttpError } from '../src/security.js';
import { processOneMessagingJob } from '../src/messaging/send-worker.js';
import { ProviderSendError } from '../src/messaging/providers.js';
import { requireLocalE2ETarget } from './guard.js';
import { metaMediaCapabilities } from '../src/media/meta-outbound.js';
import { localMediaStorage } from '../src/media/storage.js';
import type { ProviderTemplate } from '../src/messaging/templates-provider.js';
import { renderTemplateUrl } from '../src/messaging/approved-template.js';
import { processOneInboundEvent } from '../src/messaging/inbound-events.js';
import { processOneTemplateSample } from '../src/media/template-sample-worker.js';
import { processOneSourceEvaluation } from '../src/sources/evaluation.js';
import { processOneSourceIntake } from '../src/sources/intake.js';
import { MediaError } from '../src/media/validation.js';
import { SourceProviderError } from '../src/sources/meta-provider.js';
import { processOneSourceRetrieval } from '../src/sources/retrieval-worker.js';
import { processOneHistoricalPreview,processOneHistoricalImport } from '../src/sources/historical.js';
import { PaymentProviderError } from '../src/payments/providers.js';
import { processOnePaymentDispatch } from '../src/payments/dispatch-worker.js';
import { processOnePaymentReceipt } from '../src/payments/confirmation-worker.js';
import { stripeCurrencyPrecision,PaymentCheckoutError,type CheckoutSnapshot,type PaymentCheckoutAdapter } from '../src/payments/checkout-provider.js';

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
const sourceCampaign=(await db`INSERT INTO campaign (organization_id,branch_id,name,source_kind)
  VALUES (${org},${branch},'Browser Intake Campaign','META') RETURNING id`)[0]!.id;
// Model prerequisite fixture, independent of the actual Source intake journey.
const noContactLead=(await db`INSERT INTO lead (organization_id,branch_id,campaign_id,source_kind,assigned_agent_id)
  VALUES (${org},${branch},${sourceCampaign},'META',${users.agent!}) RETURNING id`)[0]!.id;
const sourceScore=(await db`INSERT INTO field_definition (organization_id,branch_id,campaign_id,key,label,field_type,value_mode,validation)
  VALUES (${org},${branch},${sourceCampaign},'interest','Browser source score','NUMBER','SOURCE','{"min":0}'::jsonb) RETURNING id`)[0]!.id;
await db`INSERT INTO campaign_field (campaign_id,field_id,required_stage,editable_by_agent,editable_by_manager)
  VALUES (${sourceCampaign},${sourceScore},'LEAD_CREATION',false,false)`;
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
const mediaSecret=sealSecret(mediaConnection,JSON.stringify({ accessToken:'test-only-media-fake',appSecret:'test-only-e2e-secret',verifyToken:'test-verify' }));
await db`INSERT INTO connection_secret (connection_id,ciphertext,nonce,auth_tag)
  VALUES (${mediaConnection},${mediaSecret.ciphertext},${mediaSecret.nonce},${mediaSecret.authTag})`;
const mediaSender=(await db`INSERT INTO messaging_sender
  (organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
  VALUES (${org},${mediaConnection},'15550005555','Browser Media Sender','HEALTHY',true,
    ${db.json({ text:true,template:true,...metaMediaCapabilities() })}) RETURNING id`)[0]!.id;
await db`UPDATE campaign SET sender_override_id=${mediaSender} WHERE id=${mediaCampaign}`;
// Initial explicit sender configuration; the reference journey uses real Source intake results.
await db`UPDATE campaign SET sender_override_id=${mediaSender} WHERE id=${sourceCampaign}`;
const mediaCv=(await db`INSERT INTO conversation (lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
  VALUES (${mediaLead},${mediaConnection},${mediaSender},'WHATSAPP','+15550004444','HUMAN',${users.agent!},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
await db`INSERT INTO conversation_message
  (conversation_id,connection_id,sender_id,direction,author_type,body,provider_message_id,delivery_state,received_at)
  VALUES (${mediaCv},${mediaConnection},${mediaSender},'INBOUND','CUSTOMER','Browser media request','wamid.browser-media-inbound','RECEIVED',now()-interval '1 second')`;
let mode: 'accept'|'reject'|'unknown' = 'reject'; let providerCalls = 0;let mediaUploads=0;let sampleUploads=0;
let sourceFailure=false;let sourceCatalogCalls=0;
let sourceSubscribed=false;let sourceSubscriptionFailure=false;
let sourceRetrievalFailure=false;let sourceRetrievalCalls=0;
let paymentFailure=false;let paymentCalls=0;let paymentChargesEnabled=false;
const paymentSessions=new Map<string,CheckoutSnapshot>();
let paymentReceiptAuthFailure=false;
const checkoutAdapter:PaymentCheckoutAdapter={ currencyPrecision:stripeCurrencyPrecision,idempotencyRetentionMs:86400000,
  async create(config,_credentials,intent) {
    if(!paymentSessions.has(intent.id)) { const sessionId='cs_test_'+intent.id.replaceAll('-','');
      paymentSessions.set(intent.id,{ sessionId,url:'https://checkout.stripe.com/c/pay/'+sessionId,expiresAt:new Date(Date.now()+3600000).toISOString(),
        mode:config.mode,currency:intent.money.currency,minor:intent.money.minor,intentId:intent.id,status:'OPEN',paymentStatus:'UNPAID',paymentRef:null }); }
    return structuredClone(paymentSessions.get(intent.id)!);
  },async retrieve(_config,_credentials,intent,sessionId) { if(paymentReceiptAuthFailure)throw new PaymentCheckoutError('PAYMENT_PROVIDER_AUTH_FAILED','REJECTED');
    const result=paymentSessions.get(intent.id);if(!result || result.sessionId!==sessionId)throw new Error('Test Session mismatch');return structuredClone(result); },
};
const templates:ProviderTemplate[]=[{ externalId:'7000',name:'header_only_template',language:'en_US',category:'UTILITY',status:'APPROVED',
  components:[{ type:'HEADER',format:'TEXT',text:'Welcome {{1}}',example:{ header_text:['Approval sample only'] } },
    { type:'BODY',text:'Fixed body' }] },
  { externalId:'7001',name:'malformed_provider_template',language:'en_US',category:'UTILITY',status:'APPROVED',
    components:[null,{ type:'HEADER',format:'TEXT',text:{ untrusted:'not a text value' } },{ type:'BODY',text:'Malformed metadata' }] }];
await mkdir(resolve('.local/e2e'),{ recursive:true });const mediaRoot=await mkdtemp(resolve('.local/e2e/media-'));
const storage=localMediaStorage(mediaRoot);
const app = await buildApp(db, { logger:false,globalRateLimitMax:10000,mediaStorage:storage,
  paymentConnectionAdapters:{ STRIPE:{ verify:async(config)=>{ paymentCalls++;if(paymentFailure)throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');return { mode:config.mode }; },
    inspect:async(config)=>{ paymentCalls++;if(paymentFailure)throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE');return { mode:config.mode,options:{ accountRef:'acct_BrowserSynthetic123',country:'US',defaultCurrency:'USD',
      currencies:['USD','EUR'],paymentMethods:['card','ach'],chargesEnabled:paymentChargesEnabled,cardPayments:paymentChargesEnabled ? 'ACTIVE' : 'PENDING' } }; },
    inspectWebhook:async(config,_credentials,id)=>{ paymentCalls++;if(paymentFailure)throw new PaymentProviderError('PAYMENT_PROVIDER_AUTH_FAILED');
      const w=(await db`SELECT callback_url FROM payment_webhook WHERE external_endpoint_id=${id} ORDER BY created_at DESC LIMIT 1`)[0];
      if(!w)throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
      return { mode:config.mode,endpointId:id,url:w.callback_url,enabled:true,enabledEvents:['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'] }; } } },
  leadSourceSubscriptionAdapter:{ check:async(input)=> {
    if (input.page.externalId!=='100001' || input.config.appId!=='700001') throw new Error('Unexpected browser source subscription');
    if (sourceSubscriptionFailure) throw new SourceProviderError('SOURCE_PROVIDER_AUTH_FAILED');
    if (input.subscribe) sourceSubscribed=true;return { subscribed:sourceSubscribed };
  } },
  leadSourceCatalogAdapter:{
    discoverPages:async()=> { sourceCatalogCalls++;if (sourceFailure) throw new SourceProviderError('SOURCE_PROVIDER_AUTH_FAILED');
      return [{ externalId:'100001',name:'Browser Page <b>literal</b>',accessToken:'synthetic-browser-page-private-token' }]; },
    discoverForms:async(_config,page)=> { sourceCatalogCalls++;if (page.externalId!=='100001') throw new Error('Unexpected browser Page');
      return [{ externalId:'200001',name:'Browser Form',status:'ACTIVE',questions:[{ key:'interest',externalId:'question-1',
        type:'CUSTOM',label:'Interest <img src=x onerror=alert(1)>',options:[{ key:'yes',value:'Yes <b>literal</b>' }] },
        { key:'full_name',externalId:'question-2',type:'CUSTOM',label:'Full name',options:[] },
        { key:'phone',externalId:'question-3',type:'CUSTOM',label:'Phone',options:[] }] }]; },
  },
  mediaScanner:{ scan:async()=>({ clean:true,version:'BrowserFakeScanner/test-only' }) },
  messagingSendAdapter:{ sendText:async()=> { throw new Error('Unexpected operational freeform send'); },
    sendTemplate:async()=>({ providerMessageId:'wamid.browser-operational' }) },
  messagingTemplateAdapter:{
    list:async(config)=>config.wabaId==='987654321' ? templates : [],
    create:async(config,_credentials,input)=> {
      if (config.wabaId!=='987654321') throw new Error('Unexpected test connection');
      const template:ProviderTemplate={ externalId:String(8000+templates.length),name:input.name,language:input.language,
        category:input.category,status:'PENDING',components:[
          ...(input.mediaHeader ? [{ type:'HEADER',format:input.mediaHeader.format,example:{ header_handle:[input.mediaHeader.handle] } }] : []),
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
app.post<{ Body:{ process?:boolean; mode?:'accept'|'reject'|'unknown'; dnc?:boolean; assigned?:'agent'|'second'; approveTemplates?:boolean;replyTo?:string;replyIndex?:number;processSample?:boolean;rejectSample?:boolean;sourceFailure?:boolean;sourceSubscriptionFailure?:boolean;sourceNotification?:string;retrieveSource?:boolean;sourceRetrievalFailure?:boolean;historicalPreview?:boolean;historicalImport?:boolean;historicalFailure?:boolean;sourceReferenceFixture?:boolean;sourceReferral?:'KNOWN'|'UNKNOWN'|'INVALID';paymentFailure?:boolean;paymentChargesEnabled?:boolean;paymentDispatch?:boolean;paymentReceipts?:boolean;paymentPaid?:string;paymentReceiptAuthFailure?:boolean } }>(
  '/__test__/control', { schema: { body:{ type:'object',additionalProperties:false,properties: {
    process:{ type:'boolean' },mode:{ type:'string',enum:['accept','reject','unknown'] },
    dnc:{ type:'boolean' },assigned:{ type:'string',enum:['agent','second'] },
    approveTemplates:{ type:'boolean' },
    processSample:{ type:'boolean' },rejectSample:{ type:'boolean' },
    sourceFailure:{ type:'boolean' },
    sourceSubscriptionFailure:{ type:'boolean' },sourceNotification:{ type:'string',format:'uuid' },
    retrieveSource:{ type:'boolean' },sourceRetrievalFailure:{ type:'boolean' },evaluateSource:{ type:'boolean' },intakeSource:{ type:'boolean' },prepareSourceMatchFixture:{ type:'boolean' },
    historicalPreview:{ type:'boolean' },historicalImport:{ type:'boolean' },historicalFailure:{ type:'boolean' },
    sourceReferenceFixture:{ type:'boolean' },sourceReferral:{ type:'string',enum:['KNOWN','UNKNOWN','INVALID'] },
    paymentFailure:{ type:'boolean' },
    paymentChargesEnabled:{ type:'boolean' },paymentDispatch:{ type:'boolean' },paymentReceipts:{ type:'boolean' },paymentPaid:{ type:'string',format:'uuid' },paymentReceiptAuthFailure:{ type:'boolean' },
    replyTo:{ type:'string',format:'uuid' },replyIndex:{ type:'integer',minimum:0,maximum:2 },
  } } } },async (request)=> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !safeTokenEqual(header,'Bearer '+testToken)) throw new HttpError(403,'TEST_CONTROL_DENIED');
    if (request.body.mode) mode=request.body.mode;
    if(typeof request.body.paymentFailure==='boolean')paymentFailure=request.body.paymentFailure;
    if(typeof request.body.paymentChargesEnabled==='boolean')paymentChargesEnabled=request.body.paymentChargesEnabled;
    if(typeof request.body.paymentReceiptAuthFailure==='boolean')paymentReceiptAuthFailure=request.body.paymentReceiptAuthFailure;
    if(request.body.paymentDispatch)await processOnePaymentDispatch(db,{ STRIPE:checkoutAdapter });
    if(request.body.paymentPaid) {
      const id=request.body.paymentPaid;const snapshot=paymentSessions.get(id);if(!snapshot)throw new HttpError(400,'TEST_PAYMENT_NOT_ISSUED');
      snapshot.status='COMPLETE';snapshot.paymentStatus='PAID';snapshot.url=null;snapshot.paymentRef='pi_'+id.replaceAll('-','');
      const w=(await db`SELECT w.* FROM payment_webhook w JOIN payment_link_intent i ON i.webhook_id=w.id WHERE i.id=${id}`)[0]!;
      const signingSecret=openOpaque('payment-webhook:'+w.id,{ ciphertext:w.ciphertext,nonce:w.nonce,authTag:w.auth_tag,keyVersion:w.key_version });
      const payload=JSON.stringify({ id:'evt_'+randomBytes(16).toString('hex'),object:'event',type:'checkout.session.completed',livemode:false,
        created:Math.floor(Date.now()/1000),data:{ object:{ id:snapshot.sessionId,object:'checkout.session',metadata:{ platform_intent_id:id } } } });
      const now=Math.floor(Date.now()/1000);const response=await app.inject({ method:'POST',url:new URL(w.callback_url).pathname,payload,headers:{ 'content-type':'application/json',
        'stripe-signature':`t=${now},v1=${createHmac('sha256',signingSecret).update(now+'.').update(payload).digest('hex')}` } });
      if(response.statusCode!==200)throw new HttpError(500,'TEST_PAYMENT_RECEIPT_FAILED');
    }
    if(request.body.paymentReceipts)for(let n=0;n<25 && await processOnePaymentReceipt(db,{ STRIPE:checkoutAdapter });n++) { /* bounded test drain */ }
    if (typeof request.body.sourceFailure==='boolean') sourceFailure=request.body.sourceFailure;
    if (typeof request.body.sourceSubscriptionFailure==='boolean') sourceSubscriptionFailure=request.body.sourceSubscriptionFailure;
    if (typeof request.body.sourceRetrievalFailure==='boolean') sourceRetrievalFailure=request.body.sourceRetrievalFailure;
    if (request.body.sourceNotification) {
      const raw=JSON.stringify({ object:'page',entry:[{ id:'100001',time:1700000000,changes:[{ field:'leadgen',value:{ page_id:'100001',form_id:'200001',leadgen_id:'300001',created_time:1699999999 } }] }] });
      const received=await app.inject({ method:'POST',url:'/api/webhooks/sources/meta/'+request.body.sourceNotification,payload:raw,
        headers:{ 'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','synthetic-browser-webhook-secret').update(raw).digest('hex') } });
      if (received.statusCode!==200) throw new HttpError(500,'TEST_SOURCE_NOTIFICATION_FAILED');
    }
    if (request.body.retrieveSource) await processOneSourceRetrieval(db,{ retrieve:async(input)=> {
      sourceRetrievalCalls++;if (sourceRetrievalFailure) throw new Error('synthetic-browser-source-private-error');
      return { id:input.leadId,form_id:input.formId,created_time:'2023-11-14T22:13:19+0000',ad_id:'500001',adset_id:'400001',campaign_id:'555',
        field_data:[{ name:'full_name',values:['<img src=x onerror=alert(1)> Browser source customer'] },{ name:'phone',values:['+15550008888'] },{ name:'interest',values:['12.5'] }] };
    } });
    if ((request.body as { evaluateSource?:boolean }).evaluateSource) await processOneSourceEvaluation(db);
    if ((request.body as { prepareSourceMatchFixture?:boolean }).prepareSourceMatchFixture) {
      // Legacy duplicate identities are deliberate test fixtures. Campaign activation uses the public UI/API.
      for (const name of ['Browser match A','Browser match B']) {
        const [candidate]=await db`INSERT INTO contact (organization_id,name,phone,phone_normalized)
          VALUES (${org},${name},'+15550008888','+15550008888') RETURNING id`;
        await db`INSERT INTO lead (organization_id,branch_id,campaign_id,contact_id,source_kind)
          VALUES (${org},${branch},${sourceCampaign},${candidate!.id},'MANUAL')`;
      }
    }
    if ((request.body as { intakeSource?:boolean }).intakeSource) await processOneSourceIntake(db);
    if (request.body.historicalPreview) await processOneHistoricalPreview(db,{ page:async(input)=> {
      if (request.body.historicalFailure) throw new SourceProviderError('SOURCE_RESPONSE_INVALID');
      const ids=input.after ? ['300001','300002'] : ['300001'];
      return { data:ids.map((id)=>({ id,form_id:input.formId,created_time:'2023-11-14T22:13:19+0000',campaign_id:'555',
        field_data:[{ name:'full_name',values:['<img src=x onerror=alert(1)> Historical customer'] },{ name:'phone',values:['+15550009999'] },{ name:'interest',values:['12.5'] }] })),
        ...(!input.after ? { paging:{ next:'ignored',cursors:{ after:'browser-next' } } } : {}) };
    } });
    if (request.body.historicalImport) await processOneHistoricalImport(db);
    if (request.body.sourceReferenceFixture) {
      const target=(await db`SELECT l.id,l.contact_id FROM lead l JOIN contact c ON c.id=l.contact_id
        WHERE l.campaign_id=${sourceCampaign} AND c.phone_normalized='+15550009999'
          AND EXISTS (SELECT 1 FROM source_submission s WHERE s.lead_id=l.id AND s.state='PROCESSED')`)[0];
      if (!target) throw new HttpError(500,'TEST_SOURCE_INTAKE_REQUIRED');
      // Deliberate competing Campaign, same Contact/sender, existing active conversation.
      const competing=(await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,source_kind)
        VALUES (${org},${branch},${mediaCampaign},${target.contact_id},'MANUAL') RETURNING id`)[0]!;
      await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state,needs_attention_reason)
        VALUES (${competing.id},${mediaConnection},${mediaSender},'WHATSAPP','+15550009999','NONE','WAITING_FOR_HUMAN','NO_HUMAN_CONTROLLER')`;
    }
    if (request.body.sourceReferral) {
      const state=request.body.sourceReferral;
      const raw=JSON.stringify({ object:'whatsapp_business_account',entry:[{ id:'987654321',changes:[{ field:'messages',value:{ messaging_product:'whatsapp',
        metadata:{ phone_number_id:'15550005555' },messages:[{ id:'wamid.browser-source-'+state,from:'15550009999',
          timestamp:'1791200000',type:'text',text:{ body:'Browser source referral '+state },
          referral:{ source_type:'ad',source_id:state==='KNOWN' ? '500001' : '999999',
            headline:state==='INVALID' ? {} : '<img src=x onerror="window.__referralXss=true"> Ad caption',body:'Literal source description',
            source_url:'http://127.0.0.1/never-fetch' } }] } }] }] });
      const response=await app.inject({ method:'POST',url:`/api/webhooks/messaging/meta/${mediaConnection}`,payload:raw,
        headers:{ 'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','test-only-e2e-secret').update(raw).digest('hex') } });
      if (response.statusCode!==200) throw new HttpError(500,'TEST_SOURCE_REFERENCE_WEBHOOK_FAILED');
      await processOneInboundEvent(db);
    }
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
    if (request.body.processSample) await processOneTemplateSample(db,{ storage,
      scanner:{ scan:async()=>({ clean:true,version:'BrowserFakeScanner/test-only' }) },adapter:{ upload:async()=> {
        sampleUploads++;if (request.body.rejectSample) throw new MediaError('SAMPLE_PROVIDER_AUTH_FAILED');
        return { handle:'2:synthetic:browser-private-sample-handle' };
      } } });
    if (request.body.replyTo) {
      const source=(await db`SELECT id,provider_message_id,template_snapshot FROM conversation_message
        WHERE id=${request.body.replyTo} AND conversation_id=${mediaCv} AND direction='OUTBOUND'`)[0];
      const index=request.body.replyIndex ?? 0;const button=source?.template_snapshot?.components.find((part:{ type:string })=>part.type==='BUTTONS')?.buttons[index];
      const payload=source?.template_snapshot?.quickReplyPayloads?.[index];
      if (!source?.provider_message_id || !payload || button?.type!=='QUICK_REPLY') throw new HttpError(400,'TEST_REPLY_SOURCE_INVALID');
      const raw=JSON.stringify({ object:'whatsapp_business_account',entry:[{ id:'987654321',changes:[{ field:'messages',value:{ messaging_product:'whatsapp',
        metadata:{ phone_number_id:'15550005555' },messages:[{ id:`wamid.browser-reply-${source.id}-${index}`,from:'15550004444',
          timestamp:String(Math.floor(Date.now()/1000)),type:'button',button:{ text:button.text,payload },context:{ id:source.provider_message_id } }] } }] }] });
      const received=await app.inject({ method:'POST',url:`/api/webhooks/messaging/meta/${mediaConnection}`,payload:raw,
        headers:{ 'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','test-only-e2e-secret').update(raw).digest('hex') } });
      if (received.statusCode!==200) throw new HttpError(500,'TEST_REPLY_WEBHOOK_FAILED');
      await processOneInboundEvent(db);
    }
    const messages = await db`SELECT id,body,delivery_state,message_kind,conversation_id FROM conversation_message WHERE direction='OUTBOUND' ORDER BY created_at,id`;
    const recoveries = (await db`SELECT count(*)::integer AS n FROM outbound_message_recovery`)[0]!.n;
    const replies=await db`SELECT id,body,reply_to_message_id,reply_button_index FROM conversation_message WHERE conversation_id=${mediaCv} AND reply_to_message_id IS NOT NULL`;
    const sourceSubmissions=(await db`SELECT count(*)::integer AS n FROM source_submission WHERE source_kind='META'`)[0]!.n;
    const sourceReferenceEvents=await db`SELECT id,state,failure_code,lead_id,conversation_id,payload->'message'->>'id' AS provider_id
      FROM integration_event WHERE connection_id=${mediaConnection} AND payload->'message'->>'id' LIKE 'wamid.browser-source-%'`;
    return { providerCalls,mediaUploads,sampleUploads,sourceCatalogCalls,sourceRetrievalCalls,sourceSubmissions,messages,recoveries,replies,sourceReferenceEvents,paymentCalls };
  });
await mkdir(resolve('.local/e2e'),{ recursive:true });
await writeFile(resolve('.local/e2e/fixture.json'),JSON.stringify({ password,testToken,leadId:lead,conversationId:cv,untrusted,mediaLeadId:mediaLead,mediaConversationId:mediaCv,sourceCampaignId:sourceCampaign,noContactLeadId:noContactLead }),{ mode:0o600 });
app.post('/__test__/stop',async(request,reply)=> {
  const header=request.headers.authorization;
  if (typeof header !== 'string' || !safeTokenEqual(header,'Bearer '+testToken)) throw new HttpError(403,'TEST_CONTROL_DENIED');
  reply.send({ stopping:true });
  setImmediate(()=> { void app.close().then(()=>db.end()).then(()=>rm(mediaRoot,{ recursive:true,force:true })); });
  return reply;
});
await app.listen({ host:'127.0.0.1',port:4100 });
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,async()=> { await app.close(); await db.end(); });
