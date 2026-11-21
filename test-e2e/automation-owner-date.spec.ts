import {expect,test} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('Approve a scoped assigned-agent and date rule and see its effect in the browser',async({page,request})=>{
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
 const campaign=await page.request.post('/api/campaigns',{headers,
  data:{branchId,name:'Automation owner and date fixture',routingMethod:'ROUND_ROBIN'}});
 expect(campaign.status(),await campaign.text()).toBe(201);
 const {id:campaignId}=await campaign.json(),root='/api/campaigns/'+campaignId;
 const {items}=await(await page.request.get(root+'/eligible-agents')).json() as {items:{id:string;name:string}[]};
 const agent=items.find(option=>option.name==='Browser agent')!;
 expect((await page.request.put(root+'/agents',{headers,data:{agentId:agent.id}})).status()).toBe(200);
 expect((await page.request.post(root+'/activate',{headers})).status()).toBe(200);

 await page.getByRole('button',{name:'Automations',exact:true}).click();
 const panel=page.locator('[data-automation-workspace]'),editor=panel.locator('[data-automation-editor]');
 async function approve(name:string,agentLabel:string){
  await panel.getByRole('button',{name:'New automation',exact:true}).click();
  await editor.getByLabel('Rule name',{exact:true}).fill(name);
  await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaignId);
  await editor.getByRole('combobox',{name:'Assigned agent condition',exact:true}).selectOption({label:agentLabel});
  await editor.getByRole('combobox',{name:'Date condition',exact:true}).selectOption('EVENT_CAPTURED');
  await expect(editor.getByRole('button',{name:'Approve and save automation',exact:true})).toBeDisabled();
  await editor.getByLabel('From date (UTC)',{exact:true}).fill('2001-01-01');
  await editor.getByLabel('Action',{exact:true}).selectOption('SEND_IN_APP_NOTIFICATION');
  await editor.getByLabel('Task note or internal notification text',{exact:true}).fill(name);
  await editor.getByLabel('Enable this rule',{exact:true}).check();
  await editor.getByLabel('Approval reason',{exact:true}).fill('Approve synthetic criteria');
  await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
  await expect(panel.locator('[data-automation-rule]').filter({hasText:name})).toBeVisible();
 }
 await approve('Notify for current assigned employee','Browser agent');
 await approve('Skip a different assigned employee','Browser second');
 const lead=await page.request.post('/api/leads',{headers,data:{branchId,campaignId,
  contact:{name:'Synthetic automation assignee',email:randomUUID()+'@browser.test'}}});
 expect(lead.status(),await lead.text()).toBe(201);
 const {id:leadId}=await lead.json();
 for(const phase of ['MATCH','EXECUTE']){
  const run=await request.post('/__test__/automation',{headers:control,data:{phase}});
  expect(run.ok(),await run.text()).toBeTruthy();
 }
 await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();
 const processing=panel.locator('[data-automation-processing-id]');
 await expect(processing.filter({hasText:'Notify for current assigned employee'})).toContainText('Action applied');
 await expect(processing.filter({hasText:'Skip a different assigned employee'})).toContainText('Conditions do not match');
 const notifications=await(await page.request.get('/api/notifications?language=en&limit=50')).json() as {items:{leadId:string;eventType:string}[]};
 expect(notifications.items.filter(item=>item.leadId===leadId&&item.eventType==='AUTOMATION_NOTICE')).toHaveLength(1);
 await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('fr');
 const rule=panel.locator('[data-automation-rule]').filter({hasText:'Notify for current assigned employee'});
 await rule.getByRole('button',{name:'Historique de la règle',exact:true}).click();
 await expect(panel.locator('[data-automation-history]')).toContainText('Date de capture de l’événement');
 await expect(panel.locator('[data-automation-history]')).toContainText('2001-01-01');
 await rule.getByRole('button',{name:'Modifier l’automatisation',exact:true}).click();
 await expect(editor.getByRole('combobox',{name:'Condition d’agent attribué',exact:true})).toHaveValue(agent.id);
 await expect(editor.getByLabel('À partir du (UTC)',{exact:true})).toHaveValue('2001-01-01');
});
