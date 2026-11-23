import { expect,test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { emptyAIOperationalConfig } from '../src/ai/operational-config.js';
import { createCampaign,headers,login,showConversation } from './returning-conversation-fixture.js';

test('Manager approves an automation summary and reviews only attributed excerpts in the conversation',async({page})=>{
  const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8'));
  const testHeaders={...headers,authorization:`Bearer ${testToken}`};
  await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
  await login(page,'manager@browser.test',password);
  const {branchId,campaignId}=await createCampaign(page,'Browser summary automation campaign');
  const connection=await page.request.post('/api/ai/connections',{headers,data:{branchId,name:'Browser automation summaries',provider:'OPENAI',
    credential:'BrowserSyntheticAI_AutomationSummary123',reason:'Configure a dedicated summary profile'}});
  expect(connection.status(),await connection.text()).toBe(201);
  const {id:connectionId}=await connection.json();
  const checked=await page.request.post(`/api/ai/connections/${connectionId}/test`,{headers,data:{version:1}});
  expect(checked.status(),await checked.text()).toBe(200);
  const profile=await page.request.post('/api/ai/profiles',{headers,data:{connectionId,name:'Operations summary',task:'SUMMARIZATION',
    modelId:'Browser-synthetic-model-a',maxOutputTokens:512,active:true,reason:'Approve internal excerpts'}});
  expect(profile.status(),await profile.text()).toBe(201);
  const config=emptyAIOperationalConfig();config.profiles.SUMMARIZATION=(await profile.json()).id;
  const configured=await page.request.put(`/api/ai/campaigns/${campaignId}/configuration`,{headers,data:{version:0,definition:config,
    reason:'Apply the approved summary profile to this campaign'}});
  expect(configured.status(),await configured.text()).toBe(200);

  const created=await page.request.post('/api/leads',{headers,data:{branchId,campaignId,contact:{name:'Browser summary customer',phone:'+15558765482'}}});
  expect(created.status(),await created.text()).toBe(201);
  const {id:leadId}=await created.json();
  const opened=await page.request.post(`/api/leads/${leadId}/conversations`,{headers});
  expect(opened.status(),await opened.text()).toBe(201);
  const {id:conversationId}=await opened.json();

  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByRole('button',{name:'Automations',exact:true}).click();
  const panel=page.locator('[data-automation-workspace]'),editor=panel.locator('[data-automation-editor]');
  await panel.getByRole('button',{name:'New automation',exact:true}).first().click();
  await editor.getByLabel('Rule name',{exact:true}).fill('Approved conversation summary');
  await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaignId);
  await editor.getByLabel('Trigger',{exact:true}).selectOption('MESSAGE_RECEIVED');
  await editor.getByLabel('Owner condition',{exact:true}).selectOption('ANY');
  await editor.getByLabel('Action',{exact:true}).selectOption({label:'Summarize conversation for staff'});
  await editor.getByLabel('Enable this rule',{exact:true}).check();
  await editor.getByLabel('Approval reason',{exact:true}).fill('Summarize new questions for scoped employees');
  await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
  await expect(editor).toHaveCount(0);
  for(const body of ['<img src=x onerror=alert(1)> Can staff explain the enrollment schedule?','card number: 4242 4242 4242 4242']){
    const inbound=await page.request.post('/__test__/ai-customer-inbound',{headers:testHeaders,data:{conversationId,body}});
    expect(inbound.status(),await inbound.text()).toBe(200);
    expect((await inbound.json()).processed).toBe(true);
  }
  for(const phase of ['MATCH','EXECUTE']){
    const response=await page.request.post('/__test__/automation',{headers:testHeaders,data:{phase}});
    expect(response.ok(),await response.text()).toBeTruthy();
  }
  // The worker also picks up earlier Handoff summaries in the shared Browser fixture.
  let summaryState: string | undefined;
  for(let attempt=0;attempt<25;attempt++){
    const inference=await page.request.post('/__test__/ai-handoff-summary',{headers:testHeaders});
    expect(inference.status(),await inference.text()).toBe(200);
    expect((await inference.json()).processed).toBe(true);
    const history=await page.request.get(`/api/conversations/${conversationId}/ai-handoffs`);
    expect(history.status(),await history.text()).toBe(200);
    summaryState=(await history.json()).automationSummaries[0]?.state;
    if(summaryState!=='QUEUED')break;
  }
  expect(summaryState).toBe('COMPLETED');
  const {panel:conversation}=await showConversation(page,leadId);
  await conversation.getByRole('button',{name:'Review handoff requests',exact:true}).click();
  const summaries=page.locator('[data-automation-conversation-summaries]');
  await expect(summaries).toContainText('COMPLETED');
  await expect(summaries).toContainText('INBOUND / CUSTOMER / RECEIVED');
  await expect(summaries).toContainText('Can staff explain the enrollment schedule?');
  await expect(summaries).not.toContainText('4242');
  await expect(summaries.locator('img')).toHaveCount(0);
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('ar');
  await expect(summaries.getByRole('heading',{name:'ملخصات أُنشئت بواسطة Automation',exact:true})).toBeVisible();
  const saved=await (await page.request.get(`/api/conversations/${conversationId}/messages`)).json();
  expect(saved.items).toHaveLength(2);
  expect(saved.items.every((item:{direction:string})=>item.direction==='INBOUND')).toBe(true);
});
