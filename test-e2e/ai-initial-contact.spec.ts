import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {emptyKnowledge} from '../src/ai/knowledge.js';
import {emptyAIOperationalConfig} from '../src/ai/operational-config.js';
import {emptyAIBehaviorPolicy} from '../src/ai/behavior-policy.js';
async function configureInitialContact(page:Page, fixture:{campaignName:string;templateName:string;phone:string;customerName:string;followupEnabled:boolean}){
 const f=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string},origin='http://127.0.0.1:4100',headers={origin},fixtureHeaders={origin,authorization:'Bearer '+f.testToken};
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.context().setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
 await page.goto('/');await page.getByRole('combobox',{name:'Language'}).selectOption('en');await page.getByLabel('Email',{exact:true}).fill('manager@browser.test');await page.getByLabel('Password',{exact:true}).fill(f.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 const me=await(await page.request.get('/api/auth/me')).json(),cr=await page.request.post('/api/campaigns',{headers,data:{branchId:me.branchId,name:fixture.campaignName,routingMethod:'MANUAL'}});expect(cr.status()).toBe(201);const cid=(await cr.json()).id;
 expect((await page.request.post('/api/campaigns/'+cid+'/activate',{headers})).status()).toBe(200);
 const kr='/api/ai/campaigns/'+cid+'/knowledge',knowledge={...emptyKnowledge(),sections:{...emptyKnowledge().sections,prices:'Approved first contact price 100 EUR'}};
 expect((await page.request.put(kr+'/draft',{headers,data:{version:0,content:knowledge,reason:'Synthetic campaign knowledge'}})).status()).toBe(200);expect((await page.request.post(kr+'/publish',{headers,data:{version:1,requestId:randomUUID(),reason:'Publish approved campaign knowledge'}})).status()).toBe(201);
 const ac=await page.request.post('/api/ai/connections',{headers,data:{name:fixture.campaignName+' AI',branchId:me.branchId,provider:'OPENAI',credential:'BrowserSyntheticAI_InitialFlow123',reason:'Synthetic fixture'}});expect(ac.status()).toBe(201);const aid=(await ac.json()).id;expect((await page.request.post('/api/ai/connections/'+aid+'/test',{headers,data:{version:1}})).status()).toBe(200);
 const pr=await page.request.post('/api/ai/profiles',{headers,data:{connectionId:aid,name:'Conversation first contact',task:'CONVERSATION',modelId:'Browser-synthetic-model-a',maxOutputTokens:1024,active:true,reason:'Synthetic profile'}});expect(pr.status()).toBe(201);
 expect((await page.request.put('/api/ai/campaigns/'+cid+'/configuration',{headers,data:{version:0,definition:{...emptyAIOperationalConfig(),profiles:{...emptyAIOperationalConfig().profiles,CONVERSATION:(await pr.json()).id},language:{supported:['en'],preferred:'en',detect:true}},reason:'Initial contact config'}})).status()).toBe(200);
 const disclosure='I am the campaign AI assistant';expect((await page.request.put('/api/ai/campaigns/'+cid+'/behavior-policy',{headers,data:{version:0,definition:{...emptyAIBehaviorPolicy(),disclosure:{mode:'FIRST_AI_MESSAGE',text:disclosure},handoff:{initialContactWithoutAgent:true,transitionMessage:null,misunderstandingLimit:null}},reason:'Explicit Manager attention fallback'}})).status()).toBe(200);
 expect((await page.request.put('/api/ai/campaigns/'+cid+'/tool-policy',{headers,data:{version:0,definition:{allowedTools:['sendConversationMessage','requestHumanHandoff']},reason:'Approved initial contact tools'}})).status()).toBe(200);
 const connections=(await(await page.request.get('/api/messaging/connections')).json()).items,mc=connections.find((x:{provider:string;name:string})=>x.provider==='META_WHATSAPP_CLOUD'&&x.name==='Browser Connection');expect(mc).toBeTruthy();
 const tr=await page.request.post('/api/messaging/connections/'+mc.id+'/templates',{headers,data:{idempotencyKey:randomUUID(),name:fixture.templateName,language:'en_US',category:'UTILITY',body:disclosure+'. Welcome to this campaign. {{1}}',examples:['Approved campaign price']}});expect(tr.status(),await tr.text()).toBe(201);
 expect((await page.request.post('/__test__/control',{headers:fixtureHeaders,data:{approveTemplates:true}})).status()).toBe(200);expect((await page.request.post('/api/messaging/connections/'+mc.id+'/templates/sync',{headers,data:{}})).status()).toBe(200);
 const tpl=(await(await page.request.get('/api/messaging/campaigns/'+cid+'/templates')).json()).items.find((x:{name:string})=>x.name===fixture.templateName);expect(tpl).toBeTruthy();expect((await page.request.put('/api/messaging/campaigns/'+cid+'/templates/'+tpl.id,{headers,data:{version:tpl.version,bound:true}})).status()).toBe(200);
 await page.getByRole('button',{name:'Campaigns',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('row').filter({hasText:fixture.campaignName}).getByRole('button',{name:'Details',exact:true}).click();
 const setup=page.locator('[data-ai-initial-setup]');await setup.getByRole('button',{name:'Review first message setup',exact:true}).click();await setup.getByRole('combobox',{name:'Approved campaign template',exact:true}).selectOption(tpl.id);await setup.getByLabel('Body parameter values (one per line)',{exact:true}).fill('Approved first contact price 100 EUR');await setup.getByLabel('Content approval reason',{exact:true}).fill('Approve exact campaign-specific first message');await setup.getByRole('button',{name:'Approve first message',exact:true}).click();await expect(setup).toContainText('Template and published knowledge match');await expect(setup).toContainText('Approved first contact price 100 EUR');
 const followup=page.locator('[data-ai-followup-message]');
 await followup.getByRole('button',{name:'Review follow-up message setup',exact:true}).click();
 await followup.getByRole('combobox',{name:'Approved campaign template',exact:true}).selectOption(tpl.id);
 await followup.getByLabel('Body parameter values (one per line)',{exact:true}).fill('Approved synthetic follow-up');
 await followup.getByLabel('Content approval reason',{exact:true}).fill('Independent follow-up approval');
 await followup.getByRole('button',{name:'Approve follow-up message',exact:true}).click();
 await expect(followup).toContainText('Approved synthetic follow-up');
 await expect(followup.getByRole('list')).toContainText('Independent follow-up approval');
 await expect(setup).toContainText('Approved first contact price 100 EUR');
 expect((await page.request.put('/api/ai/campaigns/'+cid+'/followup-policy',{headers,data:{version:0,definition:{enabled:fixture.followupEnabled,
  initialDelaySeconds:0,delaysSeconds:[1],stopOnReply:true,finalAction:'COMPLETE'},reason:'Synthetic scheduled follow-up'}})).status()).toBe(200);
 const create=async()=>{const r=await page.request.post('/api/leads',{headers,data:{branchId:me.branchId,campaignId:cid,contact:{name:fixture.customerName,phone:fixture.phone}}});expect(r.status(),await r.text()).toBe(201);return(await r.json()).id as string;};
 const old=await create(),consentPath='/api/leads/'+old+'/messaging-consent',v=(await(await page.request.get(consentPath)).json()).version;
 expect((await page.request.put(consentPath,{headers,data:{version:v,status:'GRANTED',doNotContact:false,evidence:'Authorized synthetic prior opt-in',source:'Dedicated synthetic record'}})).status()).toBe(200);
 await page.getByRole('button',{name:'Deactivate',exact:true}).click();await page.getByLabel('Enable customer messaging',{exact:true}).check();await page.getByLabel('Enable AI assistant',{exact:true}).check();await page.getByRole('button',{name:'Save settings',exact:true}).first().click();await page.getByRole('button',{name:'Activate',exact:true}).click();
 return {cid,headers,fixtureHeaders,create,old,errors};
}

test('First AI contact uses managed approved template UI, fresh real intake, trusted consent and durable mocked delivery with localized history',async({page})=>{
 const {cid,headers,fixtureHeaders,create,old,errors}=await configureInitialContact(page,{campaignName:'Browser first contact flow',
  templateName:'browser_initial_flow',phone:'+15556667901',customerName:'Browser actual initial customer',followupEnabled:true});
 const lead=await create();expect((await page.request.post('/__test__/ai-initial-process')).status()).toBe(403);expect((await page.request.post('/__test__/ai-initial-process',{headers:fixtureHeaders})).status()).toBe(200);
 const freshOrigin=(await(await page.request.get('/api/leads/'+lead+'/intake-origin')).json()).origin.initialAI;
 expect(freshOrigin.state).toBe('ADMITTED');expect(freshOrigin.runtime.deliveryState).toBe('QUEUED');
 expect((await(await page.request.get('/api/leads/'+old+'/intake-origin')).json()).origin.initialAI).toBeNull();
 // The earlier consent Lead shares this Contact/name. Wait for the exact newly created
 // Lead rather than selecting a cached row while the list refresh is still pending.
 await page.getByRole('button',{name:'Leads',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).click();await page.locator('[data-lead-row="'+lead+'"]').getByRole('button',{name:'Details',exact:true}).click();
 const panel=page.locator('[data-lead-intake-origin]');await panel.getByRole('button',{name:'Review intake origin',exact:true}).click();await expect(panel.locator('[data-initial-ai-runtime]')).toContainText('QUEUED');
 expect((await page.request.post('/__test__/ai-customer-send',{headers:fixtureHeaders,data:{dispatch:true}})).status()).toBe(200);await panel.getByRole('button',{name:'Review intake origin',exact:true}).click();await expect(panel.locator('[data-initial-ai-runtime]')).toContainText('SENT');
 const dto=(await(await page.request.get('/api/leads/'+lead+'/intake-origin')).json()).origin.initialAI;expect(dto.runtime.deliveryState).toBe('SENT');expect(dto.liveTransferEnabled).toBe(false);
 const scheduled=page.locator('[data-ai-followup-schedule]');
 await scheduled.getByRole('button',{name:'Review AI follow-ups',exact:true}).click();
 await expect(scheduled.getByRole('listitem')).toContainText('Scheduled');
 expect((await page.request.post('/__test__/ai-followup-process')).status()).toBe(403);
 await expect.poll(async()=>{
  const action=await page.request.post('/__test__/ai-followup-process',{headers:fixtureHeaders});
  return action.ok() && (await action.json()).queued;
 }).toBe(true);
 await scheduled.getByRole('button',{name:'Review AI follow-ups',exact:true}).click();
 await expect(scheduled.getByRole('listitem')).toContainText('Queued to send');
 const takeover=await page.request.post(`/api/conversations/${dto.runtime.conversationId}/takeover`,{headers,data:{version:1,reason:'Manager stops the scheduled follow-up'}});
 expect(takeover.ok(),await takeover.text()).toBeTruthy();
 expect((await page.request.post('/__test__/ai-customer-send',{headers:fixtureHeaders,data:{dispatch:true}})).status()).toBe(200);
 await scheduled.getByRole('button',{name:'Review AI follow-ups',exact:true}).click();
 await expect(scheduled.getByRole('listitem')).toContainText('Conversation control changed');
 const completedLead=await create();
 expect((await page.request.post('/__test__/ai-initial-process',{headers:fixtureHeaders})).ok()).toBeTruthy();
 expect((await page.request.post('/__test__/ai-customer-send',{headers:fixtureHeaders,data:{dispatch:true}})).ok()).toBeTruthy();
 await expect.poll(async()=>{
  const action=await page.request.post('/__test__/ai-followup-process',{headers:fixtureHeaders});
  return action.ok() && (await action.json()).queued;
 }).toBe(true);
 expect((await page.request.post('/__test__/ai-customer-send',{headers:fixtureHeaders,data:{dispatch:true}})).ok()).toBeTruthy();
 const final=await page.request.post('/__test__/ai-followup-process',{headers:fixtureHeaders});
 expect(final.ok(),await final.text()).toBeTruthy();expect((await final.json()).finalized).toBe(true);
 await page.getByRole('button',{name:'Leads',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).click();
 await page.locator('[data-lead-row="'+completedLead+'"]').getByRole('button',{name:'Details',exact:true}).click();
 await scheduled.getByRole('button',{name:'Review AI follow-ups',exact:true}).click();
 await expect(scheduled.getByRole('listitem')).toContainText('Follow-up cycle completed');
 await panel.getByRole('button',{name:'Review intake origin',exact:true}).click();
 const delayedLead=await create();
 expect((await page.request.post('/__test__/ai-initial-process',{headers:fixtureHeaders})).ok()).toBeTruthy();
 expect((await page.request.post('/__test__/ai-customer-send',{headers:fixtureHeaders,data:{dispatch:true}})).ok()).toBeTruthy();
 const policyPath='/api/messaging/campaigns/'+cid+'/policy',policy=(await (await page.request.get(policyPath)).json());
 expect((await page.request.put(policyPath,{headers,data:{version:policy.version,sendingWindow:null,maxAttempts:null,minIntervalSeconds:20}})).ok()).toBeTruthy();
 await expect.poll(async()=>{
  const action=await page.request.post('/__test__/ai-followup-process',{headers:fixtureHeaders});
  return action.ok() && (await action.json()).queued;
 }).toBe(true);
 await page.getByRole('button',{name:'Leads',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).click();
 await page.locator('[data-lead-row="'+delayedLead+'"]').getByRole('button',{name:'Details',exact:true}).click();
 await scheduled.getByRole('button',{name:'Review AI follow-ups',exact:true}).click();
 await expect(scheduled.getByRole('listitem')).toContainText('Next policy check');
 await expect(scheduled.getByRole('listitem')).toContainText('Waiting for the minimum sending interval');
 await panel.getByRole('button',{name:'Review intake origin',exact:true}).click();
 await page.getByRole('combobox',{name:'Language'}).selectOption('fr');await expect(panel).toContainText('La mise en file ne prouve pas');await page.getByRole('combobox',{name:'Language'}).selectOption('ar');await page.setViewportSize({width:390,height:844});await expect(panel).toContainText('الإدراج في قائمة الإرسال');await panel.screenshot({path:'.local/e2e/ai-initial-contact-ar.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 // Complete the real dispatch after its policy delay. A later scenario must not consume this send.
 await expect.poll(async()=>{
  const dispatch=await page.request.post('/__test__/ai-customer-send',{headers:fixtureHeaders,data:{dispatch:true}});
  expect(dispatch.ok()).toBeTruthy();
  return (await dispatch.json()).processed;
 },{timeout:30_000,intervals:[250,500,1000]}).toBe(true);
 const completed=await page.request.post('/__test__/ai-followup-process',{headers:fixtureHeaders});
 expect(completed.ok(),await completed.text()).toBeTruthy();
 expect((await completed.json()).finalized).toBe(true);
 await page.getByRole('combobox',{name:'Language'}).selectOption('en');
 await scheduled.getByRole('button',{name:'Review AI follow-ups',exact:true}).click();
 await expect(scheduled.getByRole('listitem')).toContainText('Follow-up cycle completed');
 expect(errors).toEqual([]);
});

test('An approved Automation starts AI follow-up from a delivery receipt and staff takeover cancels the queued send',async({page})=>{
 const {cid,headers,fixtureHeaders,create,errors}=await configureInitialContact(page,{campaignName:'Browser automation AI follow-up',
  templateName:'browser_automation_ai_followup',phone:'+15556667947',customerName:'Browser automation follow-up customer',followupEnabled:false});
 await page.getByRole('button',{name:'Automations',exact:true}).click();
 const workspace=page.locator('[data-automation-workspace]'),editor=workspace.locator('[data-automation-editor]');
 await workspace.getByRole('button',{name:'New automation',exact:true}).first().click();
 await editor.getByLabel('Rule name',{exact:true}).fill('Approved AI follow-up rule');
 await editor.getByLabel('Campaign scope',{exact:true}).selectOption(cid);
 await editor.getByLabel('Trigger',{exact:true}).selectOption('LEAD_CREATED');
 await editor.getByLabel('Owner condition',{exact:true}).selectOption('ANY');
 await editor.getByLabel('Action',{exact:true}).selectOption({label:'Start AI follow-up'});
 await editor.getByLabel('Enable this rule',{exact:true}).check();
 await editor.getByLabel('Approval reason',{exact:true}).fill('Manager approves the campaign follow-up');
 await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
 await expect(editor).toHaveCount(0);

 const lead=await create();
 const path=`/api/leads/${lead}`;
 const initial=await page.request.post('/__test__/ai-initial-process',{headers:fixtureHeaders});
 expect(initial.ok(),await initial.text()).toBeTruthy();
 const dispatch=()=>page.request.post('/__test__/ai-customer-send',{headers:fixtureHeaders,data:{dispatch:true}});
 const sent=await dispatch();expect(sent.ok(),await sent.text()).toBeTruthy();
 const receipt=await page.request.get(`${path}/intake-origin`);
 expect(receipt.ok(),await receipt.text()).toBeTruthy();
 const runtime=(await receipt.json()).origin.initialAI.runtime;
 expect(runtime.deliveryState).toBe('SENT');
 const before=await page.request.get(`${path}/ai-followups`);
 expect(before.ok(),await before.text()).toBeTruthy();expect((await before.json()).items).toHaveLength(0);
 const timing=await page.request.put(`/api/ai/campaigns/${cid}/followup-policy`,{headers,data:{version:1,definition:{enabled:true,
  initialDelaySeconds:0,delaysSeconds:[1],stopOnReply:true,finalAction:'COMPLETE'},reason:'Enable approved campaign follow-up'}});
 expect(timing.ok(),await timing.text()).toBeTruthy();
 for(const phase of ['MATCH','EXECUTE']){
  const response=await page.request.post('/__test__/automation',{headers:fixtureHeaders,data:{phase}});
  expect(response.ok(),await response.text()).toBeTruthy();
 }
 await workspace.getByRole('button',{name:'Refresh processing',exact:true}).click();
 const execution=workspace.locator('[data-automation-processing-id]').filter({hasText:'Approved AI follow-up rule'});
 await expect(execution).toContainText('Action applied');
 await execution.getByRole('button',{name:'Open lead',exact:true}).click();
 const schedule=page.locator('[data-ai-followup-schedule]');
 await schedule.getByRole('button',{name:'Review AI follow-ups',exact:true}).click();
 await expect(schedule.getByRole('listitem')).toHaveCount(1);
 await expect(schedule.getByRole('listitem')).toContainText('Started by automation');
 await expect.poll(async()=>{
  const action=await page.request.post('/__test__/ai-followup-process',{headers:fixtureHeaders});
  expect(action.ok(),await action.text()).toBeTruthy();
  return (await action.json()).queued;
 }).toBe(true);
 await schedule.getByRole('button',{name:'Review AI follow-ups',exact:true}).click();
 await expect(schedule.getByRole('listitem')).toContainText('Queued to send');
 const takeover=await page.request.post(`/api/conversations/${runtime.conversationId}/takeover`,{headers,
  data:{version:1,reason:'Staff takes over the scheduled conversation'}});
 expect(takeover.ok(),await takeover.text()).toBeTruthy();
 const blocked=await dispatch();expect(blocked.ok(),await blocked.text()).toBeTruthy();
 await schedule.getByRole('button',{name:'Review AI follow-ups',exact:true}).click();
 await expect(schedule.getByRole('listitem')).toContainText('Conversation control changed');
 await page.getByRole('combobox',{name:'Language'}).selectOption('ar');
 await expect(schedule.getByRole('listitem')).toContainText('بدأت بواسطة Automation');
 expect(errors).toEqual([]);
});
