import {expect,request as requestContext,test,type APIResponse,type Page} from '@playwright/test';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {configureInitialContact} from './initial-contact-fixture.js';
import {headers,login} from './returning-conversation-fixture.js';

const campaignName='Browser critical Meta journey';
const leadName='Browser Meta acceptance customer';

async function verified(response:APIResponse,status=200){
 expect(response.status(),await response.text()).toBe(status);
 return response.json();
}

async function receiveWebhook(path:string,payload:string,signatureHeader:string,signature:string){
 const sender=await requestContext.newContext({baseURL:headers.origin});
 try {
  const response=await sender.post(path,{data:payload,headers:{'content-type':'application/json',[signatureHeader]:signature}});
  expect(response.status(),await response.text()).toBe(200);
 }finally{await sender.dispose();}
}

async function configureMeta(page:Page,campaignId:string,branchId:string,agentId:string){
 const campaignPath=`/api/campaigns/${campaignId}`;
 const current=await verified(await page.request.get(campaignPath));
 await verified(await page.request.patch(campaignPath,{headers,data:{version:current.campaign.version,name:campaignName,
  sourceKind:'META',routingMethod:'ROUND_ROBIN',messagingEnabled:true,aiEnabled:true,conversion:{type:'ENROLLMENT_CONFIRMED'}}}));
 await verified(await page.request.put(`${campaignPath}/agents`,{headers,data:{agentId}}));

 const collection='/api/sources/meta/connections';
 const credentials={accessToken:'synthetic-browser-critical-meta-root',appSecret:'synthetic-browser-critical-meta-secret',verifyToken:'synthetic-browser-critical-meta-verify'};
 const connection=await verified(await page.request.post(collection,{headers,data:{branchId,name:'Critical journey Meta',config:{appId:'700001',graphVersion:'v25.0'},credentials}}),201);
 const root=`${collection}/${connection.id}`;
 await verified(await page.request.post(`${root}/discover`,{headers,data:{version:connection.version}}));
 const {items:pages}=await verified(await page.request.get(`${root}/resources?kind=PAGE`));
 const sourcePage=pages.find((item:{external_id:string})=>item.external_id==='100001');expect(sourcePage).toBeTruthy();
 await verified(await page.request.post(`${root}/discover`,{headers,data:{version:connection.version,pageId:sourcePage.id}}));
 const {items:forms}=await verified(await page.request.get(`${root}/resources?kind=FORM`));
 const form=forms.find((item:{external_id:string})=>item.external_id==='200001');expect(form).toBeTruthy();
 const subscription=await verified(await page.request.post(`${root}/subscription`,{headers,data:{version:connection.version,
  pageId:sourcePage.id,pageVersion:sourcePage.version,subscribe:true}}));
 expect(subscription.subscribed).toBe(true);
 const webhook=await verified(await page.request.get(`${root}/webhook`,{params:{pageId:sourcePage.id}}));
 const challenge=await page.request.get(webhook.callbackPath,{params:{'hub.mode':'subscribe','hub.verify_token':credentials.verifyToken,'hub.challenge':'380247'}});
 expect(challenge.status()).toBe(200);expect(await challenge.text()).toBe('380247');
 const binding=await verified(await page.request.post(`/api/sources/campaigns/${campaignId}/bindings`,{headers,data:{connectionId:connection.id,formId:form.id,
  requestId:randomUUID(),connectionVersion:connection.version,externalCampaignId:'555',externalAdSetId:null,externalAdId:null,active:true,reason:'Approve the synthetic Meta form'}}),201);
 const mappingPath=`/api/sources/campaigns/${campaignId}/bindings/${binding.id}/mapping`;
 const mapping=await verified(await page.request.get(mappingPath));
 await verified(await page.request.put(mappingPath,{headers,data:{version:0,bindingVersion:mapping.bindingVersion,connectionVersion:mapping.connectionVersion,
  resourceVersion:mapping.resourceVersion,status:'PUBLISHED',reason:'Approve mapping for trusted Meta contacts',entries:[
   {sourceKey:'full_name',kind:'CONTACT_NAME',transform:'TEXT',optionMap:[]},{sourceKey:'phone',kind:'CONTACT_PHONE',transform:'TEXT',optionMap:[]},
  ]}}));
 const now=Math.floor(Date.now()/1000);
 const payload=JSON.stringify({object:'page',entry:[{id:'100001',time:now,changes:[{field:'leadgen',value:{page_id:'100001',form_id:'200001',leadgen_id:'380247',created_time:now}}]}]});
 const signature='sha256='+createHmac('sha256',credentials.appSecret).update(payload).digest('hex');
 const receive=()=>receiveWebhook(webhook.callbackPath,payload,'x-hub-signature-256',signature);
 await receive();
 return receive;
}

async function configureQualification(page:Page,campaignId:string,branchId:string){
 const field=await verified(await page.request.post('/api/fields',{headers,data:{scope:'CAMPAIGN',branchId,campaignId,
  key:'journey_confirmed_interest',label:'Confirmed enrollment interest',fieldType:'BOOLEAN',valueMode:'MANUAL',options:[],validation:{}}}),201);
 await verified(await page.request.put(`/api/campaigns/${campaignId}/fields/${field.id}`,{headers,data:{
  active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:true,visibleToManager:true,editableByManager:true,
  showInTable:false,showInDetails:true,filterable:false,usableByAutomation:false,usableByAi:true}}));
 await verified(await page.request.put(`/api/ai/campaigns/${campaignId}/qualification`,{headers,data:{version:0,
  definition:{enabled:true,questions:[{id:randomUUID(),prompt:'Would you like to enroll?',fieldId:field.id,required:true}],
   completion:{mode:'ALL_REQUIRED',match:'ALL',conditions:[]},handoff:{onCompletion:true,match:'ALL',conditions:[]}},reason:'Qualify one answer before staff handoff'}}));
 await verified(await page.request.put(`/api/ai/campaigns/${campaignId}/tool-policy`,{headers,data:{version:1,
  definition:{allowedTools:['sendConversationMessage','updateQualificationField','requestHumanHandoff']},reason:'Approve the three tools for this journey'}}));
 return field.id as string;
}

async function configureCheckout(page:Page,campaignId:string,branchId:string){
 const connection=await verified(await page.request.post('/api/payments/connections',{headers,data:{branchId,name:'Critical journey Stripe test',
  provider:'STRIPE',config:{mode:'TEST'},credentials:{apiKey:'rk_test_'+'MetaJourneySynthetic'.repeat(3)}}}),201);
 const path=`/api/payments/connections/${connection.id}`;
 await verified(await page.request.post(`${path}/test`,{headers,data:{version:1,inspectOptions:true}}));
 const webhook=await verified(await page.request.post(`${path}/webhooks`,{headers,data:{connectionVersion:1,reason:'Configure the isolated test callback'}}),201);
 const secret='whsec_'+'MetaJourneySynthetic'.repeat(3);
 const receiver=`${path}/webhooks/${webhook.id}`;
 await verified(await page.request.post(`${receiver}/configure`,{headers,data:{version:1,endpointId:'we_MetaJourneySynthetic',signingSecret:secret,
  reason:'Authorize this synthetic Stripe endpoint'}}));
 await verified(await page.request.post(`${receiver}/test`,{headers,data:{version:2,connectionVersion:1}}));
 const now=Math.floor(Date.now()/1000);
 const payload=JSON.stringify({id:'evt_MetaJourneySyntheticProbe',object:'event',type:'checkout.session.expired',livemode:false,created:now,
  data:{object:{id:'cs_test_MetaJourneySyntheticProbe',object:'checkout.session'}}});
 const signature=`t=${now},v1=${createHmac('sha256',secret).update(`${now}.`).update(payload).digest('hex')}`;
 await receiveWebhook(new URL(webhook.callback_url).pathname,payload,'stripe-signature',signature);
 return verified(await page.request.post('/api/payments/methods',{headers,data:{branchId,connectionId:connection.id,name:'Critical journey checkout',
  currencies:['EUR'],active:true,agents:{mode:'ALL',ids:[]},campaigns:{mode:'SELECTED',ids:[campaignId]},reason:'Use test checkout for this campaign'}}),201);
}

test('One signed Meta lead proceeds through AI qualification, human handoff, verified checkout, enrollment and analytics',async({page,browser})=>{
 const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8'));
 const controlHeaders={...headers,authorization:`Bearer ${testToken}`};
 const control=(data:object)=>page.request.post('/__test__/control',{headers:controlHeaders,data}).then(response=>verified(response));
 const run=(path:string,data:object={})=>page.request.post(`/__test__/${path}`,{headers:controlHeaders,data}).then(response=>verified(response));
 const agent=await browser.newPage({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
 try {
  await login(agent,'agent@browser.test',password);
  await control({sourceFailure:false,sourceSubscriptionFailure:false,sourceRetrievalFailure:false,paymentFailure:false,paymentReceiptAuthFailure:false});
  const owner=await verified(await agent.request.get('/api/auth/me'));
  const setup:{qualifiedFieldId?:string;replay?:()=>Promise<void>}={};
  const fixture=await configureInitialContact(page,{campaignName,templateName:'browser_critical_meta',phone:'+15556668047',customerName:leadName,followupEnabled:false,
   prepareCampaign:async(campaignId,branchId)=>{
    setup.qualifiedFieldId=await configureQualification(page,campaignId,branchId);
    setup.replay=await configureMeta(page,campaignId,branchId,owner.id);
   }});
  const readSubmissions=async()=>(await verified(await page.request.get('/api/sources/submissions',{params:{campaignId:fixture.cid}}))).items;
  const processSource=async()=>{for(const step of ['retrieveSource','evaluateSource','intakeSource'])await control({[step]:true});};
  await expect.poll(async()=>{await processSource();return (await readSubmissions()).filter((item:{lead_id:string|null})=>item.lead_id).length;}).toBe(1);
  if(!setup.replay||!setup.qualifiedFieldId)throw new Error('Expected the authenticated Meta and Qualification fixtures');
  await setup.replay();
  await processSource();
  const submissions=await readSubmissions();
  expect(submissions).toHaveLength(1);
  expect(submissions[0].lead_id).toBeTruthy();
  const leadId=submissions[0].lead_id as string,root=`/api/leads/${leadId}`;
  const previousContact=(await verified(await page.request.get(`/api/leads/${fixture.old}`))).lead.contact_id;
  expect(previousContact).toBeTruthy();
  expect((await verified(await agent.request.get(root))).lead.contact_id).toBe(previousContact);
  const readOrigin=async()=>(await verified(await agent.request.get(`${root}/intake-origin`))).origin;
  const intake=await readOrigin();expect(intake.originKind).toBe('SOURCE');expect(intake.routing.ownerId).toBe(owner.id);
  expect(intake.initialAI.state).toBe('ADMITTED');
  await expect.poll(async()=>{
   await run('ai-initial-process');await run('ai-customer-send',{dispatch:true});
   return (await readOrigin()).initialAI.runtime?.deliveryState;
  }).toBe('SENT');
  const firstContact=(await readOrigin()).initialAI.runtime;
  expect(firstContact.deliveryState).toBe('SENT');
  const conversationId=firstContact.conversationId as string;
  await run('ai-customer-inbound',{conversationId,body:'Qualification fixture: Yes, I am interested in enrolling'});
  await run('ai-customer-proposal',{conversationId,process:true});
  await expect.poll(async()=>{
   await run('ai-qualification-action');const fields=await verified(await agent.request.get(`${root}/fields`));
   return fields.items.find((item:{id:string})=>item.id===setup.qualifiedFieldId)?.value;
  }).toBe(true);
  const readConversation=async()=>(await verified(await agent.request.get(`${root}/conversations`))).items.find((item:{id:string})=>item.id===conversationId);
  await expect.poll(async()=>{await run('ai-human-handoff');return (await readConversation()).state;}).toBe('WAITING_FOR_HUMAN');
  const conversation=await readConversation();
  await verified(await agent.request.post(`/api/conversations/${conversationId}/takeover`,{headers,data:{version:conversation.version,reason:'Review the qualified Meta enrollment request'}}));

  await agent.getByRole('button',{name:'Leads',exact:true}).click();
  await agent.getByRole('textbox',{name:'Name, phone, email or lead ID',exact:true}).fill(leadId);
  await agent.getByRole('button',{name:'Apply filters',exact:true}).click();
  await agent.locator(`[data-lead-row="${leadId}"]`).getByRole('button',{name:'Details',exact:true}).click();
  const thread=agent.getByRole('heading',{name:'Customer conversations',exact:true}).locator('..');
  await thread.getByRole('button',{name:'View messages',exact:true}).click();
  const humanReply='Staff confirms the next step for your enrollment.';
  await thread.getByLabel('Message text',{exact:true}).fill(humanReply);
  await thread.getByRole('button',{name:'Queue message',exact:true}).click();
  await expect(thread.getByText(humanReply,{exact:true})).toBeVisible();
  await expect.poll(async()=>{
   await control({process:true,mode:'accept'});
   const messages=await verified(await agent.request.get(`/api/conversations/${conversationId}/messages`));
   return messages.items.find((item:{body:string;author_type:string})=>item.body===humanReply&&item.author_type==='HUMAN')?.delivery_state;
  }).toBe('SENT');

  await control({paymentChargesEnabled:true});
  const method=await configureCheckout(page,fixture.cid,owner.branchId);
  const requests=`${root}/payment-link-requests`;
  const link=await verified(await agent.request.post(requests,{headers,data:{requestId:randomUUID(),methodId:method.id,methodVersion:1,amount:'29.00',currency:'EUR'}}),201);
  const currentPayment=async()=>(await verified(await agent.request.get(requests))).items.find((item:{id:string})=>item.id===link.id);
  await expect.poll(async()=>{await control({paymentDispatch:true});return (await currentPayment()).customerUrl;}).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  const issued=await currentPayment();expect(issued.customerUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  expect(issued.paymentState).toBeNull();expect(issued.enrollmentId).toBeNull();
  await agent.goto('/?paymentReturn=success');
  expect((await currentPayment()).paymentState).toBeNull();expect((await currentPayment()).enrollmentId).toBeNull();
  await control({paymentPaid:link.id,paymentReceipts:true});
  const confirmed=await currentPayment();expect(confirmed.paymentState).toBe('CONFIRMED');expect(confirmed.enrollmentId).toBeTruthy();
  await agent.getByRole('button',{name:'Analytics',exact:true}).click();
  const analytics=agent.locator('[data-analytics-workspace]');
  await analytics.getByLabel('Campaign',{exact:true}).selectOption(fixture.cid);
  await analytics.getByLabel('Financial record mode',{exact:true}).selectOption('TEST');
  await analytics.getByRole('button',{name:'Load analytics',exact:true}).click();
  await expect(analytics.locator('[data-analytics-metric="PAID"] strong')).toHaveText('1');
  await expect(analytics.locator('[data-analytics-metric="ENROLLED"] strong')).toHaveText('1');
  await expect(analytics.locator('[data-analytics-conversion]')).toHaveText('100.00%');
  await expect(analytics.locator('[data-analytics-revenue]')).toContainText('29.00');
  await analytics.locator('[data-analytics-metric="ENROLLED"]').click();
  await expect(analytics.locator('[data-analytics-drilldown] [data-analytics-lead]')).toHaveCount(1);
  await expect(analytics.locator('[data-analytics-drilldown]')).toContainText(leadName);
 }finally{
  await control({paymentChargesEnabled:false});
  await agent.close();
 }
});
