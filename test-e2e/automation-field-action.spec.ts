import {expect,test} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('Automation sets the approved typed field and retains its actual history after repeated processing',async({page,request})=>{
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
 const campaign=await page.request.post('/api/campaigns',{headers,data:{branchId,name:'Automation field action fixture'}});
 expect(campaign.status(),await campaign.text()).toBe(201);
 const {id:campaignId}=await campaign.json(),root='/api/campaigns/'+campaignId;
 const field=await page.request.post('/api/fields',{headers,data:{scope:'CAMPAIGN',branchId,campaignId,
  key:'approved_auto_review',label:'Approved automation review',fieldType:'BOOLEAN',valueMode:'MANUAL',options:[],validation:{}}});
 expect(field.status(),await field.text()).toBe(201);
 const {id:fieldId}=await field.json();
 expect((await page.request.put(root+'/fields/'+fieldId,{headers,data:{active:true,position:0,requiredStage:'NONE',
  visibleToAgent:true,editableByAgent:true,visibleToManager:true,editableByManager:true,showInTable:false,
  showInDetails:true,filterable:false,usableByAutomation:true,usableByAi:false}})).status()).toBe(200);
 expect((await page.request.post(root+'/activate',{headers})).status()).toBe(200);
 await page.getByRole('button',{name:'Automations',exact:true}).click();
 const panel=page.locator('[data-automation-workspace]'),editor=panel.locator('[data-automation-editor]');
 await panel.getByRole('button',{name:'New automation',exact:true}).click();
 await editor.getByLabel('Rule name',{exact:true}).fill('Set synthetic review flag');
 await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaignId);
 await editor.getByLabel('Owner condition',{exact:true}).selectOption('ANY');
 await editor.getByLabel('Action',{exact:true}).selectOption('SET_FIELD_VALUE');
 await editor.getByRole('combobox',{name:'Field to update',exact:true}).selectOption(fieldId);
 await expect(editor.getByRole('button',{name:'Approve and save automation',exact:true})).toBeDisabled();
 await editor.getByLabel('Value to set',{exact:true}).selectOption('false');
 await editor.getByLabel('Enable this rule',{exact:true}).check();
 await editor.getByLabel('Approval reason',{exact:true}).fill('Approve the synthetic field write');
 await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
 await expect(editor).toHaveCount(0);
 const lead=await page.request.post('/api/leads',{headers,data:{branchId,campaignId,
  contact:{name:'Synthetic field action customer',email:randomUUID()+'@browser.test'}}});
 expect(lead.status(),await lead.text()).toBe(201);
 for(const phase of ['MATCH','EXECUTE','MATCH','EXECUTE']){
  const run=await request.post('/__test__/automation',{headers:control,data:{phase}});
  expect(run.ok(),await run.text()).toBeTruthy();
 }
 await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();
 const result=panel.locator('[data-automation-processing-id]').filter({hasText:'Set synthetic review flag'});
 await expect(result).toHaveCount(1);
 await expect(result).toContainText('Action applied');
 await result.getByRole('button',{name:'Open lead',exact:true}).click();
 const fields=page.locator('.lead-fields');
 await fields.locator('.lead-field').filter({hasText:'Approved automation review'})
  .getByRole('button',{name:'History',exact:true}).click();
 await expect(fields.locator('.timeline li')).toHaveCount(1);
 await expect(fields.locator('.timeline')).toContainText('New value: false');
 await expect(fields.locator('.timeline')).toContainText('AUTOMATION');
});
