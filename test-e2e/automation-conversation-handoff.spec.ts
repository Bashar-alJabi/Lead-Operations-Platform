import {expect,test} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

test('Manager approves a conversation handoff rule and can take over the waiting conversation',async({page,request})=>{
 const fixture=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string};
 const headers={origin:'http://127.0.0.1:4100'},control={...headers,authorization:'Bearer '+fixture.testToken};
 await page.context().setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
 await page.goto('/');
 await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
 await page.getByLabel('Email',{exact:true}).fill('manager@browser.test');
 await page.getByLabel('Password',{exact:true}).fill(fixture.password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 const {branchId,id:managerId}=await (await page.request.get('/api/auth/me')).json();
 const campaign=await page.request.post('/api/campaigns',{headers,data:{branchId,name:'Automation conversation handoff',routingMethod:'MANUAL'}});
 expect(campaign.status()).toBe(201);const {id:campaignId}=await campaign.json();
 expect((await page.request.post(`/api/campaigns/${campaignId}/activate`,{headers})).status()).toBe(200);
 const subject=await page.request.post('/api/leads',{headers,data:{branchId,campaignId,contact:{name:'Automation handoff customer',phone:'+15556667498'}}});
 expect(subject.status()).toBe(201);const {id:leadId}=await subject.json();
 const root=`/api/leads/${leadId}`;
 const opened=await page.request.post(root+'/conversations',{headers});
 expect(opened.status(),await opened.text()).toBe(201);const {id:conversationId}=await opened.json();
 expect((await page.request.put(`/api/ai/campaigns/${campaignId}/tool-policy`,{headers,data:{version:0,
  definition:{allowedTools:['requestHumanHandoff']},reason:'Approve synthetic automation handoff'}})).status()).toBe(200);
 expect((await request.post('/__test__/ai-customer-proposal',{headers:control,data:{conversationId,enable:true}})).status()).toBe(200);

 await page.getByRole('button',{name:'Retry',exact:true}).click();
 await page.getByRole('button',{name:'Automations',exact:true}).click();
 const panel=page.locator('[data-automation-workspace]'),editor=panel.locator('[data-automation-editor]');
 await panel.getByRole('button',{name:'New automation',exact:true}).first().click();
 await editor.getByLabel('Rule name',{exact:true}).fill('Approved automation handoff');
 await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaignId);
 await editor.getByLabel('Trigger',{exact:true}).selectOption('MESSAGE_RECEIVED');
 await editor.getByLabel('Owner condition',{exact:true}).selectOption('ANY');
 await editor.getByLabel('Action',{exact:true}).selectOption({label:'Hand conversation to staff'});
 await editor.getByLabel('Enable this rule',{exact:true}).check();
 await editor.getByLabel('Approval reason',{exact:true}).fill('Let staff handle the synthetic customer reply');
 await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
 await expect(editor).toHaveCount(0);

 const inbound=await request.post('/__test__/ai-customer-inbound',{headers:control,data:{conversationId,body:'Synthetic request for staff',aiControl:true}});
 expect(inbound.status(),await inbound.text()).toBe(200);
 for(const phase of ['MATCH','EXECUTE']){
  const response=await request.post('/__test__/automation',{headers:control,data:{phase}});
  expect(response.ok(),await response.text()).toBeTruthy();
 }
 await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();
 const execution=panel.locator('[data-automation-processing-id]').filter({hasText:'Approved automation handoff'});
 await expect(execution).toHaveCount(1);
 await expect(execution).toContainText('Action applied');
 const read=async()=>(await (await page.request.get(root+'/conversations')).json()).items.find((item:{id:string})=>item.id===conversationId);
 const waiting=await read();
 expect(waiting.state).toBe('WAITING_FOR_HUMAN');expect(waiting.controller_type).toBe('NONE');
 expect((await (await page.request.get(root)).json()).lead.assigned_agent_id).toBeNull();
 await execution.getByRole('button',{name:'Open lead',exact:true}).click();
 const conversations=page.getByRole('heading',{name:'Customer conversations',exact:true}).locator('..');
 await conversations.getByRole('button',{name:'View messages',exact:true}).click();
 await page.getByLabel('Takeover reason',{exact:true}).fill('Accept waiting conversation');
 await page.getByRole('button',{name:'Take over conversation',exact:true}).click();
 await expect.poll(async()=>(await read()).controller_user_id).toBe(managerId);
});
