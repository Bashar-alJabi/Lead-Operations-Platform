import {expect,test} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('Automation assigns an unowned lead to the approved campaign agent and shows attributed history',async({page,request})=>{
 const fixture=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string};
 const headers={origin:'http://127.0.0.1:4100'},control={authorization:'Bearer '+fixture.testToken};
 await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
 await page.goto('/');
 await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
 await page.getByLabel('Email',{exact:true}).fill('manager@browser.test');
 await page.getByLabel('Password',{exact:true}).fill(fixture.password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 const {branchId}=await(await page.request.get('/api/auth/me')).json();
 const campaign=await page.request.post('/api/campaigns',{headers,data:{branchId,name:'Synthetic automation assignment campaign'}});
 expect(campaign.status(),await campaign.text()).toBe(201);
 const {id:campaignId}=await campaign.json(),root='/api/campaigns/'+campaignId;
 const {items}=await(await page.request.get(root+'/eligible-agents')).json() as {items:{id:string;name:string}[]};
 const agent=items.find(item=>item.name==='Browser agent')!;
 expect((await page.request.put(root+'/agents',{headers,data:{agentId:agent.id}})).status()).toBe(200);
 expect((await page.request.post(root+'/activate',{headers})).status()).toBe(200);

 await page.getByRole('button',{name:'Automations',exact:true}).click();
 const panel=page.locator('[data-automation-workspace]'),editor=panel.locator('[data-automation-editor]');
 await panel.getByRole('button',{name:'New automation',exact:true}).click();
 await editor.getByLabel('Rule name',{exact:true}).fill('Assign the synthetic lead');
 await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaignId);
 await editor.getByLabel('Owner condition',{exact:true}).selectOption('UNASSIGNED');
 await editor.getByLabel('Action',{exact:true}).selectOption('ASSIGN_LEAD');
 await expect(editor.getByRole('button',{name:'Approve and save automation',exact:true})).toBeDisabled();
 await editor.getByRole('combobox',{name:'Assignment agent',exact:true}).selectOption(agent.id);
 await editor.getByLabel('Enable this rule',{exact:true}).check();
 await editor.getByLabel('Approval reason',{exact:true}).fill('Approve synthetic lead assignment');
 await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
 await expect(editor).toHaveCount(0);

 const lead=await page.request.post('/api/leads',{headers,data:{branchId,campaignId,
  contact:{name:'Synthetic unassigned contact',email:randomUUID()+'@browser.test'}}});
 expect(lead.status(),await lead.text()).toBe(201);
 const {id:leadId}=await lead.json();
 for(const phase of ['MATCH','EXECUTE','MATCH','EXECUTE']){
  const run=await request.post('/__test__/automation',{headers:control,data:{phase}});
  expect(run.ok(),await run.text()).toBeTruthy();
 }
 await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();
 const result=panel.locator('[data-automation-processing-id]').filter({hasText:'Assign the synthetic lead'});
 await expect(result).toHaveCount(1);
 await expect(result).toContainText('Action applied');
 await result.getByRole('button',{name:'Open lead',exact:true}).click();
 const history=page.getByRole('heading',{name:'Assignment history',exact:true}).locator('..');
 await expect(history).toContainText('Unassigned → Browser agent');
 await expect(history.getByText('Assigned by automation',{exact:true})).toHaveCount(1);
 const {items:assignments}=await(await page.request.get('/api/leads/'+leadId+'/assignments')).json();
 expect(assignments[0]).toMatchObject({method:'AUTOMATION',new_agent_id:agent.id,actor_user_id:null});
});
