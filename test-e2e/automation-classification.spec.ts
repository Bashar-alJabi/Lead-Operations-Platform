import {expect,test} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {emptyAIOperationalConfig} from '../src/ai/operational-config.js';
import {createCampaign,headers,login,showConversation} from './returning-conversation-fixture.js';

test('A manager approves scoped lead classification and reviews an AI suggestion without changing tags',async({page})=>{
 const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8'));
 const control={...headers,authorization:`Bearer ${testToken}`};
 await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
 await login(page,'manager@browser.test',password);
 const {branchId,campaignId}=await createCampaign(page,'Browser lead classification campaign');
 const field=await page.request.post('/api/fields',{headers,data:{scope:'CAMPAIGN',branchId,campaignId,
  key:'browser_classification',label:'Approved inquiry tags',fieldType:'TAGS',valueMode:'MANUAL',validation:{},options:[
   {value:'enrollment',label:'Enrollment inquiry',active:true},{value:'schedule',label:'Scheduling question',active:true},
  ]}});
 expect(field.status(),await field.text()).toBe(201);
 const {id:fieldId}=await field.json();
 const bound=await page.request.put(`/api/campaigns/${campaignId}/fields/${fieldId}`,{headers,data:{
  active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:true,visibleToManager:true,editableByManager:true,
  showInTable:false,showInDetails:true,filterable:false,usableByAutomation:true,usableByAi:true}});
 expect(bound.ok(),await bound.text()).toBeTruthy();
 const connection=await page.request.post('/api/ai/connections',{headers,data:{branchId,name:'Browser classification model',provider:'OPENAI',
  credential:'BrowserSyntheticAI_ClassificationOnly123',reason:'Configure the scoped classifier'}});
 expect(connection.status(),await connection.text()).toBe(201);
 const {id:connectionId}=await connection.json();
 expect((await page.request.post(`/api/ai/connections/${connectionId}/test`,{headers,data:{version:1}})).ok()).toBeTruthy();
 const profile=await page.request.post('/api/ai/profiles',{headers,data:{connectionId,name:'Inquiry classifier',task:'CLASSIFICATION',
  modelId:'Browser-synthetic-model-a',maxOutputTokens:256,active:true,reason:'Approve internal suggestions'}});
 expect(profile.status(),await profile.text()).toBe(201);
 const definition=emptyAIOperationalConfig();definition.profiles.CLASSIFICATION=(await profile.json()).id;
 expect((await page.request.put(`/api/ai/campaigns/${campaignId}/configuration`,{headers,data:{version:0,definition,reason:'Assign classifier'}})).ok()).toBeTruthy();

 await page.getByRole('button',{name:'Retry',exact:true}).click();
 await page.getByRole('button',{name:'Automations',exact:true}).click();
 const panel=page.locator('[data-automation-workspace]'),editor=panel.locator('[data-automation-editor]');
 await panel.getByRole('button',{name:'New automation',exact:true}).first().click();
 await editor.getByLabel('Rule name',{exact:true}).fill('Approved inquiry classification');
 await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaignId);
 await editor.getByLabel('Trigger',{exact:true}).selectOption('MESSAGE_RECEIVED');
 await editor.getByLabel('Owner condition',{exact:true}).selectOption('ANY');
 await editor.getByLabel('Action',{exact:true}).selectOption({label:'Request lead classification'});
 await editor.getByLabel('Campaign classification field',{exact:true}).selectOption(fieldId);
 await editor.getByLabel('Enable this rule',{exact:true}).check();
 await editor.getByLabel('Approval reason',{exact:true}).fill('Classify inquiries using the approved campaign tags');
 await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
 await expect(editor).toHaveCount(0);

 const lead=await page.request.post('/api/leads',{headers,data:{branchId,campaignId,contact:{name:'Browser inquiry classification',phone:'+15558765483'}}});
 expect(lead.status(),await lead.text()).toBe(201);
 const {id:leadId}=await lead.json();
 const conversation=await page.request.post(`/api/leads/${leadId}/conversations`,{headers});
 expect(conversation.status(),await conversation.text()).toBe(201);
 const {id:conversationId}=await conversation.json();
 for(const body of ['Can you explain the enrollment schedule?','card number: 4242 4242 4242 4242']){
  const inbound=await page.request.post('/__test__/ai-customer-inbound',{headers:control,data:{conversationId,body}});
  expect(inbound.ok(),await inbound.text()).toBeTruthy();expect((await inbound.json()).processed).toBe(true);
 }
 for(const phase of ['MATCH','EXECUTE']){
  const run=await page.request.post('/__test__/automation',{headers:control,data:{phase}});
  expect(run.ok(),await run.text()).toBeTruthy();
 }
 let state:string|undefined;
 for(let attempt=0;attempt<25;attempt++){
  const job=await page.request.post('/__test__/ai-handoff-summary',{headers:control});
  expect(job.ok(),await job.text()).toBeTruthy();expect((await job.json()).processed).toBe(true);
  const history=await page.request.get(`/api/conversations/${conversationId}/ai-handoffs`);
  expect(history.ok(),await history.text()).toBeTruthy();
  state=(await history.json()).automationClassifications[0]?.state;
  if(state!=='QUEUED')break;
 }
 expect(state).toBe('COMPLETED');
 const {panel:leadConversation}=await showConversation(page,leadId);
 await leadConversation.getByRole('button',{name:'Review handoff requests',exact:true}).click();
 const suggestions=page.locator('[data-automation-classifications]');
 await expect(suggestions).toContainText('Enrollment inquiry');
 await expect(suggestions).not.toContainText('4242');
 const fields=await page.request.get(`/api/leads/${leadId}/fields`);
 expect(fields.ok(),await fields.text()).toBeTruthy();
 const {items}=await fields.json();expect(items.find((item:{id:string})=>item.id===fieldId)?.value).toBeNull();
 await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('ar');
 await expect(suggestions.getByRole('heading',{name:'اقتراحات التصنيف من Automation',exact:true})).toBeVisible();
});
