import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { campaignRow } from './campaign-table.js';

const origin='http://127.0.0.1:4100';
const headers={origin};

async function login(tab:Page,email:string,password:string) {
  await tab.goto('/');
  await tab.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
  await tab.getByLabel('Email',{exact:true}).fill(email);
  await tab.getByLabel('Password',{exact:true}).fill(password);
  await tab.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(tab.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
}

async function createCampaign(manager:Page,name:string) {
  const {branchId}=await (await manager.request.get('/api/auth/me')).json();
  const draft=await manager.request.post('/api/campaigns',{headers,data:{branchId,name,routingMethod:'MANUAL'}});
  expect(draft.status(),await draft.text()).toBe(201);
  const {id:campaignId}=await draft.json();
  const senderOptions=await (await manager.request.get(`/api/messaging/branches/${branchId}/senders`)).json();
  const senderId=senderOptions.items.find((item:{display_name:string})=>item.display_name==='Browser Intake Sender').id;
  const sender=await manager.request.put(`/api/messaging/campaigns/${campaignId}/sender-override`,{headers,data:{version:1,senderId}});
  expect(sender.status(),await sender.text()).toBe(200);
  const {version}=await sender.json();
  const configured=await manager.request.patch(`/api/campaigns/${campaignId}`,{headers,data:{version,name,sourceKind:'MANUAL',
    routingMethod:'MANUAL',messagingEnabled:true,aiEnabled:false}});
  expect(configured.status(),await configured.text()).toBe(200);
  const active=await manager.request.post(`/api/campaigns/${campaignId}/activate`,{headers});
  expect(active.status(),await active.text()).toBe(200);
  return {branchId,campaignId};
}

async function showConversation(page:Page,leadId:string) {
  await page.getByRole('button',{name:'Leads',exact:true}).click();
  const search=page.locator('.lead-search-form');
  await search.getByRole('textbox',{name:'Name, phone, email or lead ID',exact:true}).fill(leadId);
  await search.getByRole('button',{name:'Apply filters',exact:true}).click();
  await page.locator(`[data-lead-row="${leadId}"]`).getByRole('button',{name:'Details',exact:true}).click();
  const panel=page.getByRole('heading',{name:'Customer conversations',exact:true}).locator('..');
  const thread=panel.getByRole('row').filter({hasText:'Browser Intake Sender'});
  await thread.getByRole('button',{name:'View messages',exact:true}).click();
  return {panel,thread};
}

test('Only the current controller closes a conversation and keeps its history visible', async ({page,browser}) => {
  const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8'));
  const context=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  const manager=await context.newPage();
  try {
    await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
    await login(manager,'manager@browser.test',password);
    await login(page,'agent@browser.test',password);
    const {id:agentId}=await (await page.request.get('/api/auth/me')).json();
    const {branchId,campaignId}=await createCampaign(manager,'Browser Conversation Closure');
    const made=await manager.request.post('/api/leads',{headers,data:{branchId,campaignId,
      contact:{name:'Browser closure customer',phone:'+15558765478'}}});
    expect(made.status(),await made.text()).toBe(201);
    const {id:leadId}=await made.json();
    const details=(await (await manager.request.get('/api/leads/'+leadId)).json()).lead;
    const assignment=await manager.request.post(`/api/leads/${leadId}/assignment`,{headers,data:{
      version:details.version,agentId,reason:'Assign closure journey owner'}});
    expect(assignment.status(),await assignment.text()).toBe(200);
    const opened=await page.request.post(`/api/leads/${leadId}/conversations`,{headers});
    expect(opened.status(),await opened.text()).toBe(201);
    const {id:conversationId}=await opened.json();
    const root=`/api/conversations/${conversationId}`;
    const savedMessage='Historical customer message';
    const inserted=await page.request.post('/__test__/ai-copilot-inbound',{
      headers:{...headers,authorization:`Bearer ${testToken}`},data:{conversationId,body:savedMessage}});
    expect(inserted.ok(),await inserted.text()).toBeTruthy();
    const reason='<img src=x onerror=alert(1)> Customer completed the discussion';
    const denied=await manager.request.post(root+'/close',{headers,data:{version:1,reason}});
    expect(denied.status(),await denied.text()).toBe(403);

    const {panel,thread}=await showConversation(page,leadId);
    await expect(panel.getByText(savedMessage,{exact:true})).toBeVisible();
    await expect(panel.getByRole('button',{name:'Queue message',exact:true})).toBeVisible();
    const close=panel.getByRole('button',{name:'Close conversation',exact:true});
    await expect(close).toBeDisabled();
    await panel.getByLabel('Reason for closing the conversation',{exact:true}).fill(reason);
    await close.click();
    await expect(thread).toContainText('CLOSED');
    await expect(close).toHaveCount(0);
    await expect(panel.getByRole('button',{name:'Queue message',exact:true})).toHaveCount(0);
    await expect(panel.getByText(savedMessage,{exact:true})).toBeVisible();
    const activity=page.getByRole('heading',{name:'Activity',exact:true}).locator('..');
    await expect(activity).toContainText('Conversation closed');
    await expect(activity).toContainText(reason);
    await expect(activity.locator('img')).toHaveCount(0);
    const history=await (await page.request.get(root+'/messages')).json();
    expect(history.items.map((item:{body:string})=>item.body)).toEqual([savedMessage]);
    expect((await (await page.request.get('/api/leads/'+leadId)).json()).lead.lifecycle).toBe('OPEN');
  } finally { await context.close(); }
});

test('A signed returning message restores the same conversation for an explicit human takeover',async({page})=>{
  const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8'));
  await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
  await login(page,'manager@browser.test',password);
  const name='Browser Returning Customer Policy';
  const {branchId,campaignId}=await createCampaign(page,name);
  await page.getByRole('button',{name:'Campaigns',exact:true}).click();
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await (await campaignRow(page,name)).getByRole('button',{name:'Details',exact:true}).click();
  const policy=page.locator('[data-ai-behavior-scope="CAMPAIGN"]');
  const label=(field:string)=>'Campaign AI behavior · '+field;
  await policy.getByLabel(label('Configure explicitly Returning-contact policy'),{exact:true}).check();
  await policy.getByLabel(label('Return to closed conversation with open Lead'),{exact:true}).selectOption('REOPEN_EXISTING');
  await policy.getByLabel(label('AI behavior edit reason'),{exact:true}).fill('Return customers to their existing thread for human review');
  await policy.getByRole('button',{name:'Save AI behavior',exact:true}).click();
  await expect(policy).toContainText('Version: 1');
  const lead=await page.request.post('/api/leads',{headers,data:{branchId,campaignId,
    contact:{name:'Browser returning customer',phone:'+15558765479'}}});
  expect(lead.status(),await lead.text()).toBe(201);
  const {id:leadId}=await lead.json();
  const opened=await page.request.post(`/api/leads/${leadId}/conversations`,{headers});
  expect(opened.status(),await opened.text()).toBe(201);
  const {id:conversationId}=await opened.json();
  async function inbound(body:string){
    const response=await page.request.post('/__test__/ai-customer-inbound',{
      headers:{...headers,authorization:`Bearer ${testToken}`},data:{conversationId,body}});
    expect(response.status(),await response.text()).toBe(200);
    expect((await response.json()).processed).toBe(true);
  }
  const originalMessage='Question before closing';
  const returnMessage='<img src=x onerror=alert(1)> Returning customer question';
  await inbound(originalMessage);
  let {panel,thread}=await showConversation(page,leadId);
  await expect(panel.getByText(originalMessage,{exact:true})).toBeVisible();
  await panel.getByLabel('Reason for closing the conversation',{exact:true}).fill('Original discussion completed');
  await panel.getByRole('button',{name:'Close conversation',exact:true}).click();
  await expect(thread).toContainText('CLOSED');
  await inbound(returnMessage);
  await page.getByRole('button',{name:'Back',exact:true}).click();
  ({panel,thread}=await showConversation(page,leadId));
  await expect(thread).toHaveCount(1);
  await expect(thread).toContainText('WAITING_FOR_HUMAN');
  await expect(panel.getByText(originalMessage,{exact:true})).toBeVisible();
  await expect(panel.getByText(returnMessage,{exact:true})).toBeVisible();
  await expect(panel.locator('img')).toHaveCount(0);
  await expect(panel.getByRole('button',{name:'Queue message',exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Activity',exact:true}).locator('..')).toContainText('Conversation reopened by an incoming message');
  const history=await (await page.request.get(`/api/conversations/${conversationId}/messages`)).json();
  expect(history.items).toHaveLength(2);
  expect(history.items.every((item:{direction:string})=>item.direction==='INBOUND')).toBe(true);
  await panel.getByLabel('Takeover reason',{exact:true}).fill('Staff member reviewed the returning message');
  await panel.getByRole('button',{name:'Take over conversation',exact:true}).click();
  await expect(thread).toContainText('HUMAN_ACTIVE');
  await expect(panel.getByRole('button',{name:'Queue message',exact:true})).toBeVisible();
});

test('An approved returning policy reopens the existing closed Lead and preserves its conversation',async({page})=>{
  const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8'));
  await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
  await login(page,'manager@browser.test',password);
  const name='Browser Closed Lead Return';
  const {branchId,campaignId}=await createCampaign(page,name);
  await page.getByRole('button',{name:'Campaigns',exact:true}).click();
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await (await campaignRow(page,name)).getByRole('button',{name:'Details',exact:true}).click();
  const policy=page.locator('[data-ai-behavior-scope="CAMPAIGN"]');
  await policy.getByLabel('Campaign AI behavior · Configure explicitly Returning-contact policy',{exact:true}).check();
  await policy.getByLabel('Campaign AI behavior · Return to closed Lead',{exact:true}).selectOption('REOPEN_EXISTING');
  await policy.getByLabel('Campaign AI behavior · AI behavior edit reason',{exact:true}).fill('Restore an existing closed Lead for human follow-up');
  await policy.getByRole('button',{name:'Save AI behavior',exact:true}).click();
  await expect(policy).toContainText('Version: 1');

  const created=await page.request.post('/api/leads',{headers,data:{branchId,campaignId,
    contact:{name:'Browser returning closed Lead',phone:'+15558765480'}}});
  expect(created.status(),await created.text()).toBe(201);
  const {id:leadId}=await created.json();
  const opened=await page.request.post(`/api/leads/${leadId}/conversations`,{headers});
  expect(opened.status(),await opened.text()).toBe(201);
  const {id:conversationId}=await opened.json();
  const closed=await page.request.post(`/api/leads/${leadId}/lifecycle`,{headers,data:{lifecycle:'CLOSED'}});
  expect(closed.status(),await closed.text()).toBe(200);
  const {panel,thread}=await showConversation(page,leadId);
  await expect(page.locator('.facts')).toContainText('CLOSED');
  const customerText='Customer returns to the previously closed Lead';
  const received=await page.request.post('/__test__/ai-customer-inbound',{
    headers:{...headers,authorization:`Bearer ${testToken}`},data:{conversationId,body:customerText}});
  expect(received.status(),await received.text()).toBe(200);
  expect((await received.json()).processed).toBe(true);
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await showConversation(page,leadId);
  await expect(page.locator('.facts')).toContainText('OPEN');
  await expect(page.getByRole('heading',{name:'Activity',exact:true}).locator('..')).toContainText('Lead reopened by an incoming message');
  await expect(thread).toHaveCount(1);
  await expect(thread).toContainText('WAITING_FOR_HUMAN');
  await expect(panel.getByText(customerText,{exact:true})).toBeVisible();
  await expect(panel.getByRole('button',{name:'Queue message',exact:true})).toHaveCount(0);
});
