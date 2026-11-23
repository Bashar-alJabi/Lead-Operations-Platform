import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('Only the current controller closes a conversation and keeps its history visible', async ({page,browser}) => {
  const origin='http://127.0.0.1:4100';
  const headers={origin};
  const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8'));
  const context=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  const manager=await context.newPage();
  async function login(tab:Page,email:string) {
    await tab.goto('/');
    await tab.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
    await tab.getByLabel('Email',{exact:true}).fill(email);
    await tab.getByLabel('Password',{exact:true}).fill(password);
    await tab.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(tab.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  }
  try {
    await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
    await login(manager,'manager@browser.test');
    await login(page,'agent@browser.test');
    const {branchId}=await (await manager.request.get('/api/auth/me')).json();
    const {id:agentId}=await (await page.request.get('/api/auth/me')).json();
    const name='Browser Conversation Closure';
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

    await page.getByRole('button',{name:'Leads',exact:true}).click();
    const search=page.locator('.lead-search-form');
    await search.getByRole('textbox',{name:'Name, phone, email or lead ID',exact:true}).fill(leadId);
    await search.getByRole('button',{name:'Apply filters',exact:true}).click();
    await page.locator(`[data-lead-row="${leadId}"]`).getByRole('button',{name:'Details',exact:true}).click();
    const panel=page.getByRole('heading',{name:'Customer conversations',exact:true}).locator('..');
    const thread=panel.getByRole('row').filter({hasText:'Browser Intake Sender'});
    await thread.getByRole('button',{name:'View messages',exact:true}).click();
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
