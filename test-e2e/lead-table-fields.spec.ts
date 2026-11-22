import {expect,test,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('Campaign lead columns show current permitted field values and clear after a display change',async({browser})=>{
  const {password}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string};
  const headers={origin:'http://127.0.0.1:4100'};
  const managerContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  const agentContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  const manager=await managerContext.newPage(),agent=await agentContext.newPage();
  async function login(page:Page,name:string){
    await page.goto('/');
    await page.getByRole('combobox',{name:'Language'}).selectOption('en');
    await page.getByLabel('Email',{exact:true}).fill(name+'@browser.test');
    await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  }
  try{
    await login(manager,'manager');await login(agent,'agent');
    const {id:agentId,branchId}=await (await agent.request.get('/api/auth/me')).json();
    const created=await manager.request.post('/api/campaigns',{headers,data:{branchId,name:'Campaign table fields',routingMethod:'MANUAL'}});
    expect(created.status()).toBe(201);
    const {id:campaignId}=await created.json();
    const field=await manager.request.post('/api/fields',{headers,data:{scope:'CAMPAIGN',branchId,campaignId,key:'table_answer',label:'Table answer',
      fieldType:'TEXT',valueMode:'MANUAL',options:[],validation:{}}});
    expect(field.status()).toBe(201);
    const {id:fieldId}=await field.json();
    const bindingUrl=`/api/campaigns/${campaignId}/fields/${fieldId}`;
    const binding={active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:false,visibleToManager:true,
      editableByManager:true,showInTable:true,showInDetails:true,filterable:true,usableByAutomation:false,usableByAi:false};
    expect((await manager.request.put(bindingUrl,{headers,data:binding})).status()).toBe(200);
    expect((await manager.request.post(`/api/campaigns/${campaignId}/activate`,{headers})).status()).toBe(200);
    const lead=await manager.request.post('/api/leads',{headers,data:{campaignId,branchId,contact:{name:'Campaign table customer',email:'table-'+randomUUID()+'@browser.test'}}});
    expect(lead.status()).toBe(201);
    const {id:leadId}=await lead.json();
    expect((await manager.request.post(`/api/leads/${leadId}/assignment`,{headers,data:{version:1,agentId,reason:'Synthetic table scope'}})).status()).toBe(200);
    const untrusted='<img src=x onerror="window.leadTableXss=1">';
    expect((await manager.request.put(`/api/leads/${leadId}/fields/${fieldId}`,{headers,data:{value:untrusted}})).status()).toBe(200);

    await agent.reload();
    await agent.getByRole('combobox',{name:'Campaign',exact:true}).selectOption(campaignId);
    await agent.getByRole('button',{name:'Apply filters',exact:true}).click();
    const column=agent.locator(`th[data-lead-table-field="${fieldId}"]`);
    const cell=agent.locator(`[data-lead-row="${leadId}"] td[data-lead-table-field="${fieldId}"]`);
    await expect(column).toHaveText('Table answer');
    await expect(cell).toHaveText(untrusted);
    await expect(cell.locator('img')).toHaveCount(0);

    const fieldChoice=agent.locator(`[data-campaign-field-column="${fieldId}"]`);
    await expect(fieldChoice).toBeChecked();
    await agent.getByLabel('View name',{exact:true}).fill('Campaign field saved');
    await agent.getByRole('button',{name:'Save view',exact:true}).click();
    await expect(agent.getByRole('button',{name:'Campaign field saved',exact:true})).toBeVisible();
    await fieldChoice.uncheck();
    await agent.getByRole('button',{name:'Apply filters',exact:true}).click();
    await expect(column).toHaveCount(0);
    await agent.getByRole('button',{name:'Campaign field saved',exact:true}).click();
    await expect(cell).toHaveText(untrusted);
    expect((await agent.request.post('/api/lead-views',{headers,data:{name:'Sensitive field filter',scope:'PERSONAL',
      filters:{campaignId,fieldId,fieldValue:JSON.stringify(untrusted)},columns:['contact'],fieldColumns:[fieldId]}})).status()).toBe(201);

    expect((await manager.request.put(bindingUrl,{headers,data:{...binding,version:1,visibleToAgent:false}})).status()).toBe(200);
    await agent.getByRole('button',{name:'Campaign field saved',exact:true}).click();
    await expect(agent.locator(`[data-lead-row="${leadId}"]`)).toBeVisible();
    await expect(column).toHaveCount(0);
    await expect(cell).toHaveCount(0);
    await agent.reload();
    await agent.getByRole('button',{name:'Sensitive field filter',exact:true}).click();
    await expect(agent.getByRole('alert')).toContainText('uses a filter field you can no longer access');
    expect(await agent.evaluate(()=>Object.hasOwn(window,'leadTableXss'))).toBe(false);
  }finally{await managerContext.close();await agentContext.close();}
});
