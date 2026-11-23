import { expect,test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { campaignRow } from './campaign-table.js';
import { createCampaign,headers,login,showConversation } from './returning-conversation-fixture.js';

test('A verified returning ad creates a separately routed Lead with scoped intake history',async({page})=>{
  const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8'));
  await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
  await login(page,'manager@browser.test',password);
  const name='Browser Returning Ad Campaign';
  const {branchId,campaignId}=await createCampaign(page,name);
  await page.getByRole('button',{name:'Campaigns',exact:true}).click();
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await (await campaignRow(page,name)).getByRole('button',{name:'Details',exact:true}).click();
  const policy=page.locator('[data-ai-behavior-scope="CAMPAIGN"]');
  await policy.getByLabel('Campaign AI behavior · Configure explicitly Returning-contact policy',{exact:true}).check();
  await policy.getByLabel('Campaign AI behavior · Return to closed Lead',{exact:true}).selectOption('CREATE_NEW');
  await policy.getByLabel('Campaign AI behavior · AI behavior edit reason',{exact:true}).fill('Accept new opportunities from verified ad context');
  await policy.getByRole('button',{name:'Save AI behavior',exact:true}).click();
  await expect(policy).toContainText('Version: 1');
  const nameOfContact='Browser verified returning ad contact';
  const previousLead=await page.request.post('/api/leads',{headers,data:{branchId,campaignId,
    contact:{name:nameOfContact,phone:'+15558765481'}}});
  expect(previousLead.status(),await previousLead.text()).toBe(201);
  const {id:leadId}=await previousLead.json();
  const opened=await page.request.post(`/api/leads/${leadId}/conversations`,{headers});
  expect(opened.status(),await opened.text()).toBe(201);
  const {id:conversationId}=await opened.json();
  async function receive(body:string,returningAd=false) {
    const response=await page.request.post('/__test__/ai-customer-inbound',{
      headers:{...headers,authorization:`Bearer ${testToken}`},data:{conversationId,body,returningAd}});
    expect(response.status(),await response.text()).toBe(200);
    expect((await response.json()).processed).toBe(true);
  }
  const oldMessage='Historical thread remains on the old Lead';
  const returningMessage='Returning from the campaign ad';
  await receive(oldMessage);
  const closed=await page.request.post(`/api/leads/${leadId}/lifecycle`,{headers,data:{lifecycle:'CLOSED'}});
  expect(closed.status(),await closed.text()).toBe(200);
  await receive(returningMessage,true);
  await page.getByRole('button',{name:'Leads',exact:true}).click();
  const search=page.locator('.lead-search-form');
  await search.getByRole('textbox',{name:'Name, phone, email or lead ID',exact:true}).fill(nameOfContact);
  await search.getByRole('combobox',{name:'Source',exact:true}).selectOption('MESSAGING_INBOUND');
  await search.getByRole('button',{name:'Apply filters',exact:true}).click();
  const row=page.locator('[data-lead-row]').filter({hasText:nameOfContact});
  await expect(row).toHaveCount(1);
  const successorId=await row.getAttribute('data-lead-row');
  expect(successorId).toBeTruthy();
  expect(successorId).not.toBe(leadId);
  await row.getByRole('button',{name:'Details',exact:true}).click();
  const origin=page.locator('[data-lead-intake-origin]');
  await origin.getByRole('button',{name:'Review intake origin',exact:true}).click();
  await expect(origin).toContainText('Created from a returning customer message');
  await expect(origin).toContainText('Routing at intake: MANUAL · NO_ELIGIBLE_AGENT');
  const panel=page.getByRole('heading',{name:'Customer conversations',exact:true}).locator('..');
  await panel.getByRole('button',{name:'View messages',exact:true}).click();
  await expect(panel.getByText(returningMessage,{exact:true})).toBeVisible();
  await expect(panel.getByText(oldMessage,{exact:true})).toHaveCount(0);
  await expect(panel.getByRole('row').filter({hasText:'Browser Intake Sender'})).toContainText('WAITING_FOR_HUMAN');
  const original=await (await page.request.get(`/api/conversations/${conversationId}/messages`)).json();
  expect(original.items.map((item:{body:string})=>item.body)).toEqual([oldMessage]);
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await search.getByRole('combobox',{name:'Source',exact:true}).selectOption('');
  const previous=await showConversation(page,leadId);
  await expect(previous.thread).toContainText('CLOSED');
  await expect(previous.panel.getByText(oldMessage,{exact:true})).toBeVisible();
});
