import {expect,test} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('A typed field criterion controls execution and is masked when field visibility is withdrawn',async({page,request})=>{
 const fixture=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string};
 const control={authorization:'Bearer '+fixture.testToken},origin={origin:'http://127.0.0.1:4100'};
 const seeded=await request.post('/__test__/conversation-notifications',{headers:control,data:{fixture:true}});
 expect(seeded.ok(),await seeded.text()).toBeTruthy();
 const {leadId,campaignId}=await seeded.json();
 await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
 await page.goto('/');
 await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
 await page.getByLabel('Email',{exact:true}).fill('manager@browser.test');
 await page.getByLabel('Password',{exact:true}).fill(fixture.password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 const {branchId}=await(await page.request.get('/api/auth/me')).json();
 const settings={active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:true,visibleToManager:true,
  editableByManager:true,showInTable:false,showInDetails:true,filterable:false,usableByAutomation:true,usableByAi:false};
 async function field(key:string,label:string,fieldType:string){
  const definition=await page.request.post('/api/fields',{headers:origin,data:{
   scope:'CAMPAIGN',branchId,campaignId,key,label,fieldType,valueMode:'MANUAL',options:[],validation:{},
  }});
  expect(definition.status(),await definition.text()).toBe(201);
  const {id}=await definition.json();
  const binding='/api/campaigns/'+campaignId+'/fields/'+id;
  expect((await page.request.put(binding,{headers:origin,data:settings})).status()).toBe(200);
  return {id,binding};
 }
 const watched=await field('automation_change_marker','Automation change marker','TEXT');
 const condition=await field('automation_review_required','Synthetic review requirement','BOOLEAN');
 await page.getByRole('button',{name:'Automations',exact:true}).click();
 const panel=page.locator('[data-automation-workspace]'),editor=panel.locator('[data-automation-editor]');
 await panel.getByRole('button',{name:'New automation',exact:true}).first().click();
 await editor.getByLabel('Rule name',{exact:true}).fill('Synthetic field equality rule');
 await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaignId);
 await editor.getByLabel('Trigger',{exact:true}).selectOption('FIELD_CHANGED');
 await editor.getByLabel('Watched field',{exact:true}).selectOption(watched.id);
 await editor.getByLabel('Field equality condition',{exact:true}).selectOption(condition.id);
 await editor.getByLabel('Matching value',{exact:true}).selectOption('false');
 await editor.getByLabel('Action',{exact:true}).selectOption('SEND_IN_APP_NOTIFICATION');
 await editor.getByLabel('Task note or internal notification text',{exact:true}).fill('Synthetic approved result');
 await editor.getByLabel('Enable this rule',{exact:true}).check();
 await editor.getByLabel('Approval reason',{exact:true}).fill('Approve the typed comparison');
 await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
 await expect(editor).toHaveCount(0);
 const setValue=(id:string,value:unknown,version?:number)=>page.request.put('/api/leads/'+leadId+'/fields/'+id,{headers:origin,data:{value,version}});
 async function processRules(){
  for(const phase of ['MATCH','EXECUTE']){
   const run=await request.post('/__test__/automation',{headers:control,data:{phase}});
   expect(run.ok(),await run.text()).toBeTruthy();
  }
 }
 expect((await setValue(condition.id,false)).status()).toBe(200);
 expect((await setValue(watched.id,'Initial synthetic change')).status()).toBe(200);
 await processRules();
 expect((await setValue(watched.id,'Later synthetic change',1)).status()).toBe(200);
 expect((await setValue(condition.id,true,1)).status()).toBe(200);
 await processRules();
 await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();
 const entries=panel.locator('[data-automation-processing-id]').filter({hasText:'Synthetic field equality rule'});
 await expect(entries.filter({hasText:'Action applied'})).toHaveCount(1);
 await expect(entries.filter({hasText:'Conditions do not match'})).toHaveCount(1);

 expect((await page.request.put(condition.binding,{headers:origin,data:{...settings,visibleToManager:false,editableByManager:false,version:1}})).status()).toBe(200);
 await panel.getByRole('button',{name:'Reload automations',exact:true}).click();
 const rule=panel.locator('[data-automation-rule]').filter({hasText:'Synthetic field equality rule'});
 await rule.getByRole('button',{name:'Edit automation',exact:true}).click();
 await expect(editor).toContainText('Field unavailable for automation');
 await expect(editor.getByLabel('Matching value',{exact:true})).toHaveCount(0);
 await editor.getByLabel('Enable this rule',{exact:true}).uncheck();
 await editor.getByLabel('Approval reason',{exact:true}).fill('Disable after losing access to the field');
 await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
 await expect(editor).toHaveCount(0);
});
