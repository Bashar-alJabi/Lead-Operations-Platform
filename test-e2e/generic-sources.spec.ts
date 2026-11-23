import { expect,request as requestContext,test,type Page } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { campaignRow } from './campaign-table.js';
import { headers as appHeaders,login } from './returning-conversation-fixture.js';

async function completeHumanJourney(manager:Page,agent:Page,leadId:string,campaignId:string,branchId:string) {
 const path=`/api/leads/${leadId}`;
 const dueAt=new Date(Date.now()+3600_000).toISOString();
 const followUp=await agent.request.post(`${path}/followups`,{headers:appHeaders,data:{dueAt,note:'Human follow-up after signed intake'}});
 expect(followUp.status(),await followUp.text()).toBe(201);
 const account=await manager.request.post('/api/payments/bank-accounts',{headers:appHeaders,data:{branchId,name:'AI-disabled journey bank',
  mode:'TEST',beneficiary:'Synthetic company',accountIdentifier:'BROWSER-AI-DISABLED',bankName:'Synthetic bank',instructions:'Use the exact reference',
  active:true,currencies:['EUR'],reason:'Use only the isolated acceptance account'}});
 expect(account.status(),await account.text()).toBe(201);
 const {id:accountId}=await account.json();
 const method=await manager.request.post('/api/payments/methods',{headers:appHeaders,data:{branchId,connectionId:accountId,
  name:'AI-disabled journey transfer',currencies:['EUR'],active:true,agents:{mode:'ALL',ids:[]},campaigns:{mode:'SELECTED',ids:[campaignId]},
  reason:'Enable the test transfer for the signed-intake campaign'}});
 expect(method.status(),await method.text()).toBe(201);
 const {id:methodId}=await method.json();

 const search=agent.locator('.lead-search-form');
 await search.getByRole('textbox',{name:'Name, phone, email or lead ID',exact:true}).fill(leadId);
 await search.getByRole('button',{name:'Apply filters',exact:true}).click();
 await agent.locator(`[data-lead-row="${leadId}"]`).getByRole('button',{name:'Details',exact:true}).click();
 const task=agent.getByRole('row').filter({hasText:'Human follow-up after signed intake'});
 await task.getByRole('button',{name:'Complete',exact:true}).click();
 await expect(task).toContainText('Completed');

 const transfers=agent.locator('[data-bank-transfers]');
 await transfers.getByLabel('Transfer method',{exact:true}).selectOption(methodId);
 await transfers.getByLabel('Transfer amount',{exact:true}).fill('19.00');
 await transfers.getByLabel('Transfer currency',{exact:true}).selectOption('EUR');
 const created=agent.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`${path}/bank-transfers`);
 await transfers.getByRole('button',{name:'Create transfer request',exact:true}).click();
 const requested=await created;expect(requested.status(),await requested.text()).toBe(201);
 const transfer=await requested.json();
 const card=transfers.locator(`[data-bank-transfer="${transfer.id}"]`);
 await expect(card).toContainText('Awaiting trusted reconciliation');
 expect(transfer.payment_id).toBeNull();expect(transfer.enrollment_id).toBeNull();
 const proof={transactionId:'BROWSER-AI-DISABLED-'+randomUUID(),accountIdentifier:transfer.account_identifier,
  reference:transfer.reference,amount:transfer.amount,currency:transfer.currency,settledAt:new Date(Date.now()-60000).toISOString(),
  reason:'Independently reviewed synthetic bank record',bankVerified:true};
 const confirm=`${path}/bank-transfers/${transfer.id}/confirm`;
 expect((await agent.request.post(confirm,{headers:appHeaders,data:proof})).status()).toBe(403);
 const approved=await manager.request.post(confirm,{headers:appHeaders,data:proof});
 expect(approved.status(),await approved.text()).toBe(200);
 const result=await approved.json();
 expect(result.payment_id).toBeTruthy();expect(result.enrollment_id).toBeTruthy();expect(result.enrollment_id).not.toBe(result.payment_id);
 await transfers.getByRole('button',{name:'Refresh transfers',exact:true}).click();
 await expect(card).toContainText('Payment: CONFIRMED');await expect(card).toContainText('Enrollment:');
 expect((await(await agent.request.get(`${path}/intake-origin`)).json()).origin.initialAI).toBeNull();

 await agent.getByRole('button',{name:'Analytics',exact:true}).click();
 const analytics=agent.locator('[data-analytics-workspace]');
 await analytics.getByLabel('Campaign',{exact:true}).selectOption(campaignId);
 await analytics.getByLabel('Financial record mode',{exact:true}).selectOption('TEST');
 await analytics.getByRole('button',{name:'Load analytics',exact:true}).click();
 await expect(analytics.locator('[data-analytics-metric="PAID"] strong')).toHaveText('1');
 await expect(analytics.locator('[data-analytics-metric="ENROLLED"] strong')).toHaveText('1');
 await expect(analytics.locator('[data-analytics-metric="AI_CONTACTED"] strong')).toHaveText('0');
 await expect(analytics.locator('[data-analytics-revenue]')).toContainText('19.00');
}

test('Signed intake with AI disabled routes one lead through human follow-up, verified payment and enrollment',async({page,browser})=>{
  const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string};
  await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
  await page.goto('/');
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
  await page.getByLabel('Email',{exact:true}).fill('manager@browser.test');
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Webhook sources',exact:true}).click();
  const workspace=page.locator('[data-generic-sources]'),form=workspace.locator('form');
  const [branchId]=await form.getByRole('combobox',{name:'Branch',exact:true}).selectOption({label:'Browser Branch'});
  if(!branchId)throw new Error('The signed intake requires the Browser Branch');
  await form.getByRole('textbox',{name:'Connection name',exact:true}).fill('Synthetic signed webhook');
  await form.getByRole('textbox',{name:'Change reason',exact:true}).fill('Approve local synthetic setup');
  await form.getByRole('button',{name:'Create webhook connection',exact:true}).click();
  const detail=workspace.locator('[data-generic-source-detail]');
  const secret=detail.getByRole('textbox',{name:'Signing secret',exact:true});
  await expect(secret).toHaveValue(/^[0-9a-f]{64}$/);
  const firstSecret=await secret.inputValue();
  const testUrl=detail.getByRole('textbox',{name:'Signature test URL',exact:true});
  await expect(testUrl).toHaveValue(/\/api\/webhooks\/sources\/generic\/[0-9a-f-]+\/test$/);
  const path=new URL(await testUrl.inputValue()).pathname;
  const connectionId=path.split('/').at(-2)!;
  await expect(detail).toContainText('Waiting for a signed test');
  await detail.getByRole('button',{name:'Send signed test',exact:true}).click();
  const receipts=detail.locator('[data-generic-source-test]');
  const changes=detail.locator('.actions');
  const schema=detail.locator('[data-generic-source-schema]');
  await expect(receipts).toHaveCount(1);
  await expect(receipts.first()).toContainText('Current version');
  await detail.getByRole('button',{name:'Hide signing secret',exact:true}).click();
  await expect(secret).toHaveCount(0);
  await schema.getByRole('textbox',{name:'Field keys',exact:true}).fill('name\nemail');
  await schema.getByRole('textbox',{name:'Change reason',exact:true}).fill('Declare synthetic field schema');
  await schema.getByRole('button',{name:'Save field schema',exact:true}).click();
  await expect(schema).toContainText('Version 1 · Current version');

  const campaignName='Synthetic webhook campaign '+randomUUID().slice(0,8);
  const campaign=await page.request.post('/api/campaigns',{headers:{origin:'http://127.0.0.1:4100'},
    data:{branchId,name:campaignName,sourceKind:'GENERIC_SOURCE',routingMethod:'ROUND_ROBIN'}});
  expect(campaign.status(),await campaign.text()).toBe(201);
  const campaignId=(await campaign.json()).id as string;
  const users=await page.request.get('/api/users');expect(users.ok(),await users.text()).toBeTruthy();
  const assignee=(await users.json()).items.find((item:{email:string})=>item.email==='agent@browser.test');
  expect(assignee).toBeTruthy();
  const eligible=await page.request.put(`/api/campaigns/${campaignId}/agents`,{headers:appHeaders,data:{agentId:assignee.id}});
  expect(eligible.status(),await eligible.text()).toBe(200);
  await page.getByRole('button',{name:'Campaigns',exact:true}).click();
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await (await campaignRow(page,campaignName)).getByRole('button',{name:'Details',exact:true}).click();
  await page.getByLabel('Enable customer messaging',{exact:true}).check();
  await expect(page.getByLabel('Enable AI assistant',{exact:true})).not.toBeChecked();
  const saved=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname.startsWith('/api/campaigns/'));
  await page.getByRole('button',{name:'Save settings',exact:true}).first().click();
  const savedSettings=await saved;
  expect(savedSettings.status(),await savedSettings.text()).toBe(200);
  const override=page.getByRole('heading',{name:'Campaign sender override',exact:true}).locator('..');
  const [senderId]=await override.getByRole('combobox',{name:'Campaign sender override',exact:true})
    .selectOption({label:'Browser Intake Sender · Browser Intake Messaging Connection'});
  await override.getByRole('button',{name:'Save settings',exact:true}).click();
  await expect(override).toContainText('Effective sender for new messages: '+senderId);
  const sources=page.locator('.campaign-sources');
  await sources.getByRole('button',{name:'Bind Webhook schema',exact:true}).click();
  await sources.getByRole('combobox',{name:'Campaign source connection',exact:true}).selectOption({label:'Synthetic signed webhook · CONNECTED'});
  await sources.getByRole('combobox',{name:'Webhook schema',exact:true}).selectOption({label:'Webhook fields'});
  await sources.getByRole('checkbox',{name:'Enable source selection',exact:true}).check();
  await sources.getByRole('textbox',{name:'Binding change reason',exact:true}).fill('Bind synthetic webhook to the campaign');
  await sources.getByRole('button',{name:'Save source binding',exact:true}).click();
  await sources.getByRole('button',{name:'Field Mapping',exact:true}).click();
  const mapping=sources.locator('.source-field-mapping');
  await mapping.getByRole('button',{name:'Suggest mapping',exact:true}).click();
  await expect(mapping.locator('.mapping-entry')).toHaveCount(2);
  await mapping.getByRole('textbox',{name:'Preview name',exact:true}).fill('Synthetic lead preview');
  await mapping.getByRole('button',{name:'Preview mapping',exact:true}).click();
  await expect(mapping.getByRole('status')).toContainText('Synthetic lead preview');
  await mapping.getByRole('textbox',{name:'Mapping change reason',exact:true}).fill('Approve synthetic field mapping');
  await mapping.getByRole('button',{name:'Publish mapping',exact:true}).click();
  await expect(mapping).toContainText('Published v1');
  await page.getByRole('button',{name:'Activate',exact:true}).click();
  await expect(page.getByRole('button',{name:'Deactivate',exact:true})).toBeVisible();
  const eventId=randomUUID(),name='<img src=x onerror=alert(1)> Synthetic webhook prospect';
  const event=JSON.stringify({eventId,fields:{name,email:eventId+'@browser.test'}});
  const signedAt=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',Buffer.from(firstSecret,'hex'))
    .update(`lead-operations.generic-source:intake:v1\n${connectionId}\n${signedAt}\n`).update(event).digest('hex');
  const request={ data:event,headers:{'content-type':'application/json','x-source-timestamp':signedAt,'x-source-signature':'v1='+signature} };
  const endpoint=path.replace(/\/test$/,'/leads');
  const sender=await requestContext.newContext({baseURL:'http://127.0.0.1:4100'});
  let submissionId:string;
  try {
    const intake=await sender.post(endpoint,request);
    expect(intake.status(),await intake.text()).toBe(202);
    submissionId=(await intake.json()).id;
    expect(await (await sender.post(endpoint,request)).json()).toEqual({id:submissionId,duplicate:true});
  } finally { await sender.dispose(); }
  const review=sources.locator('.source-submissions');
  const submission=review.locator(`[data-submission-id="${submissionId}"]`);
  await review.getByRole('button',{name:'Refresh source submissions',exact:true}).click();
  await expect(submission).toContainText('PENDING');
  for (const step of ['evaluateSource','intakeSource']) {
    const ran=await page.request.post('/__test__/control',{data:{[step]:true},
      headers:{origin:'http://127.0.0.1:4100',authorization:'Bearer '+testToken}});
    expect(ran.ok(),await ran.text()).toBeTruthy();
  }
  await review.getByRole('button',{name:'Refresh source submissions',exact:true}).click();
  await expect(submission).toContainText('PROCESSED');
  await expect(submission).not.toContainText(name);
  const result=await page.request.get('/api/sources/submissions?campaignId='+campaignId);
  const leadId=(await result.json()).items.find((item:{submission_id:string})=>item.submission_id===submissionId).lead_id;
  await page.getByRole('button',{name:'Leads',exact:true}).click();
  const search=page.locator('.lead-search-form');
  await search.getByRole('textbox',{name:'Name, phone, email or lead ID',exact:true}).fill(leadId);
  await search.getByRole('button',{name:'Apply filters',exact:true}).click();
  const lead=page.locator(`[data-lead-row="${leadId}"]`);
  await expect(lead).toContainText(name);
  await expect(lead).toContainText(campaignName);
  await expect(lead.locator('img')).toHaveCount(0);
  const origin=(await (await page.request.get('/api/leads/'+leadId+'/intake-origin')).json()).origin;
  expect(origin.initialAI).toBeNull();
  expect(origin.routing.ownerId).toBe(assignee.id);
  expect((await (await page.request.get('/api/leads/'+leadId+'/conversations')).json()).items).toEqual([]);
  const agent=await browser.newPage({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  try {
    await login(agent,'agent@browser.test',password);
    await completeHumanJourney(page,agent,leadId,campaignId,branchId);
  } finally { await agent.close(); }

  await page.getByRole('button',{name:'Webhook sources',exact:true}).click();
  await workspace.getByRole('listitem').filter({hasText:'Synthetic signed webhook'}).getByRole('button',{name:'Open connection',exact:true}).click();
  await changes.getByRole('textbox',{name:'Change reason',exact:true}).fill('Rotate local synthetic secret');
  await detail.getByRole('button',{name:'Issue a new secret and reverify',exact:true}).click();
  await expect(secret).toHaveValue(/^[0-9a-f]{64}$/);
  expect(await secret.inputValue()).not.toEqual(firstSecret);
  await expect(receipts.first()).toContainText('Previous version');
  await expect(schema.getByRole('textbox',{name:'Field keys',exact:true})).toBeDisabled();
  await detail.getByRole('button',{name:'Send signed test',exact:true}).click();
  await expect(receipts).toHaveCount(2);
  await expect(schema).toContainText('Version 1 · Previous version');
  await changes.getByRole('textbox',{name:'Change reason',exact:true}).fill('Disable local synthetic source');
  await detail.getByRole('button',{name:'Disable connection',exact:true}).click();
  await expect(detail).toContainText('Disabled');
  await expect(secret).toHaveCount(0);
  await expect(receipts).toHaveCount(2);
  await expect(receipts.filter({hasText:'Current version'})).toHaveCount(0);
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('ar');
  await expect(page.getByRole('heading',{name:'مصادر Webhook',exact:true})).toBeVisible();
  await expect(detail).toContainText('معطّل');
});
