import {test,expect} from '@playwright/test';
import {configureInitialContact} from './initial-contact-fixture.js';

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
