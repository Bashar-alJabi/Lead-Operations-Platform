import { expect,type Page } from '@playwright/test';

export const origin='http://127.0.0.1:4100';
export const headers={origin};

export async function login(tab:Page,email:string,password:string) {
  await tab.goto('/');
  await tab.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
  await tab.getByLabel('Email',{exact:true}).fill(email);
  await tab.getByLabel('Password',{exact:true}).fill(password);
  await tab.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(tab.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
}

export async function createCampaign(manager:Page,name:string) {
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

export async function showConversation(page:Page,leadId:string) {
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
