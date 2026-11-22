import {expect,test,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('A calculated filter matches the campaign table, persists in a saved view and rechecks current access',async({browser})=>{
  const {password}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string};
  const headers={origin:'http://127.0.0.1:4100'};
  const managerContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  const agentContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  const manager=await managerContext.newPage(),agent=await agentContext.newPage();
  async function login(page:Page,role:string){
    await page.goto('/');
    await page.getByRole('combobox',{name:'Language'}).selectOption('en');
    await page.getByLabel('Email',{exact:true}).fill(role+'@browser.test');
    await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  }
  try{
    await login(manager,'manager');await login(agent,'agent');
    const {id:agentId,branchId}=await (await agent.request.get('/api/auth/me')).json();
    const campaign=await manager.request.post('/api/campaigns',{headers,data:{branchId,name:'Calculated filter campaign',routingMethod:'MANUAL'}});
    expect(campaign.status()).toBe(201);
    const {id:campaignId}=await campaign.json();
    const definition=await manager.request.post('/api/fields',{headers,data:{scope:'CAMPAIGN',branchId,campaignId,
      key:'human_attempt_count',label:'Human attempt count',fieldType:'CALCULATED',valueMode:'CALCULATED',options:[],validation:{},
      calculation:{kind:'HUMAN_CONTACT_ATTEMPTS'}}});
    expect(definition.status()).toBe(201);
    const {id:fieldId}=await definition.json();
    const bindingUrl=`/api/campaigns/${campaignId}/fields/${fieldId}`;
    const binding={active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:false,visibleToManager:true,
      editableByManager:false,showInTable:true,showInDetails:true,filterable:true,usableByAutomation:false,usableByAi:false};
    expect((await manager.request.put(bindingUrl,{headers,data:binding})).status()).toBe(200);
    expect((await manager.request.post(`/api/campaigns/${campaignId}/activate`,{headers})).status()).toBe(200);
    const lead=await manager.request.post('/api/leads',{headers,data:{campaignId,branchId,
      contact:{name:'Uncontacted customer',email:randomUUID()+'@browser.test'}}});
    expect(lead.status()).toBe(201);
    const {id:leadId}=await lead.json();
    expect((await manager.request.post(`/api/leads/${leadId}/assignment`,{headers,data:{version:1,agentId,reason:'Synthetic filter setup'}})).status()).toBe(200);

    await agent.reload();
    await agent.getByRole('combobox',{name:'Campaign',exact:true}).selectOption(campaignId);
    await agent.getByRole('combobox',{name:'Campaign field',exact:true}).selectOption(fieldId);
    const input=agent.getByRole('spinbutton',{name:'Field value',exact:true});
    const apply=agent.getByRole('button',{name:'Apply filters',exact:true});
    const cell=agent.locator(`[data-lead-row="${leadId}"] td[data-lead-table-field="${fieldId}"]`);
    await input.fill('0');
    await apply.click();
    await expect(cell).toHaveText('0');
    await agent.getByLabel('View name',{exact:true}).fill('Zero human attempts');
    await agent.getByRole('button',{name:'Save view',exact:true}).click();
    const saved=agent.getByRole('button',{name:'Zero human attempts',exact:true});
    await expect(saved).toBeVisible();
    await input.fill('1');
    await apply.click();
    await expect(cell).toHaveCount(0);
    await saved.click();
    await expect(input).toHaveValue('0');
    await expect(cell).toHaveText('0');
    expect((await manager.request.put(bindingUrl,{headers,data:{...binding,version:1,visibleToAgent:false}})).status()).toBe(200);
    await saved.click();
    await expect(agent.getByRole('alert')).toContainText('uses a filter field you can no longer access');
    await expect(cell).toHaveCount(0);
    await expect(input).toHaveCount(0);
  }finally{await managerContext.close();await agentContext.close();}
});
