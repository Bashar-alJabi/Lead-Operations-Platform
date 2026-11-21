import {expect,test} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('Conversation and controller settings independently gate a real internal notification',async({page,request})=>{
 const fixture=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string};
 const control={authorization:'Bearer '+fixture.testToken};
 const seeded=await request.post('/__test__/conversation-notifications',{headers:control,data:{fixture:true}});
 expect(seeded.ok(),await seeded.text()).toBeTruthy();
 const {leadId,campaignId}=await seeded.json();
 await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
 await page.goto('/');
 await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
 await page.getByLabel('Email',{exact:true}).fill('manager@browser.test');
 await page.getByLabel('Password',{exact:true}).fill(fixture.password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('button',{name:'Automations',exact:true}).click();
 const panel=page.locator('[data-automation-workspace]'),editor=panel.locator('[data-automation-editor]');

 async function approve(name:string,controller:'NONE'|'HUMAN'){
  await panel.getByRole('button',{name:'New automation',exact:true}).first().click();
  await editor.getByLabel('Rule name',{exact:true}).fill(name);
  await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaignId);
  await editor.getByLabel('Trigger',{exact:true}).selectOption({label:'Conversation state changed'});
  await editor.getByLabel('Owner condition',{exact:true}).selectOption('ANY');
  await editor.getByLabel('Conversation state condition',{exact:true}).selectOption('WAITING_FOR_HUMAN');
  await editor.getByLabel('Conversation controller condition',{exact:true}).selectOption(controller);
  await editor.getByLabel('Action',{exact:true}).selectOption('SEND_IN_APP_NOTIFICATION');
  await editor.getByLabel('Task note or internal notification text',{exact:true}).fill(name);
  await editor.getByLabel('Enable this rule',{exact:true}).check();
  await editor.getByLabel('Approval reason',{exact:true}).fill('Approve synthetic conversation conditions');
  await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
  await expect(editor).toHaveCount(0);
 }
 await approve('Waiting without a controller','NONE');
 await approve('Waiting with a human controller','HUMAN');
 const assigned=await page.request.post('/api/leads/'+leadId+'/assignment',{
  headers:{origin:'http://127.0.0.1:4100'},
  data:{version:1,agentId:null,reason:'Unassign the synthetic lead to release the conversation'},
 });
 expect(assigned.ok(),await assigned.text()).toBeTruthy();
 for(const phase of ['MATCH','EXECUTE']){
  const run=await request.post('/__test__/automation',{headers:control,data:{phase}});
  expect(run.ok(),await run.text()).toBeTruthy();
 }
 await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();
 const processing=panel.locator('[data-automation-processing-id]');
 await expect(processing.filter({hasText:'Waiting without a controller'})).toContainText('Action applied');
 await expect(processing.filter({hasText:'Waiting with a human controller'})).toContainText('Conditions do not match');
 const response=await page.request.get('/api/notifications?language=en&limit=50');
 expect(response.ok()).toBeTruthy();
 const {items}=await response.json() as {items:{eventType:string;leadId:string}[]};
 expect(items.filter(event=>event.eventType==='AUTOMATION_NOTICE'&&event.leadId===leadId)).toHaveLength(1);
 await panel.locator('[data-automation-rule]').filter({hasText:'Waiting without a controller'}).getByRole('button',{name:'Edit automation',exact:true}).click();
 await expect(editor.getByLabel('Conversation state condition',{exact:true})).toHaveValue('WAITING_FOR_HUMAN');
 await expect(editor.getByLabel('Conversation controller condition',{exact:true})).toHaveValue('NONE');
});
