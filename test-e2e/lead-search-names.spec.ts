import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

test('Lead search accepts campaign, branch and owner names within the current assignment scope',async({browser})=>{
 const {password}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string};
 const headers={origin:'http://127.0.0.1:4100'};
 const managerContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
 const agentContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
 const manager=await managerContext.newPage(),agent=await agentContext.newPage();
 async function login(page:Page,name:string){
  await page.goto('/');
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
  await page.getByLabel('Email',{exact:true}).fill(name+'@browser.test');
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 }
 try{
  await login(manager,'manager');await login(agent,'agent');
  const {id:owner,branchId,name:ownerName}=await (await agent.request.get('/api/auth/me')).json();
  const {items:branches}=await (await manager.request.get('/api/branches')).json();
  const branchName=branches.find((branch:{id:string})=>branch.id===branchId).name as string;
  const created=await manager.request.post('/api/campaigns',{headers,data:{branchId,name:'Named search campaign',routingMethod:'MANUAL'}});
  expect(created.status()).toBe(201);const {id:campaignId}=await created.json();
  expect((await manager.request.post(`/api/campaigns/${campaignId}/activate`,{headers})).status()).toBe(200);
  const lead=await manager.request.post('/api/leads',{headers,data:{branchId,campaignId,contact:{name:'Synthetic named search customer',email:randomUUID()+'@browser.test'}}});
  expect(lead.status()).toBe(201);const {id}=await lead.json();
  const assignment=`/api/leads/${id}/assignment`;
  expect((await manager.request.post(assignment,{headers,data:{version:1,agentId:owner,reason:'Assign named search fixture'}})).status()).toBe(200);
  await agent.reload();
  const search=agent.getByPlaceholder('Or campaign, branch or owner name',{exact:true});
  const apply=agent.getByRole('button',{name:'Apply filters',exact:true});
  const row=agent.locator(`[data-lead-row="${id}"]`);
  async function runSearch(value:string){
   await search.fill(value);
   await Promise.all([agent.waitForResponse(response=>new URL(response.url()).pathname==='/api/leads'&&
    new URL(response.url()).searchParams.get('q')===value),apply.click()]);
  }
  for(const term of ['NaMeD sEaRcH',branchName,ownerName]){
   await runSearch(term);
   await expect(row).toBeVisible();
  }
  expect((await manager.request.post(assignment,{headers,data:{version:2,agentId:null,reason:'Remove assignment before next search'}})).status()).toBe(200);
  await runSearch('Named search campaign');
  await expect(row).toHaveCount(0);
 }finally{await managerContext.close();await agentContext.close();}
});
