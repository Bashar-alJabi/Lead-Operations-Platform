import {expect,test} from '@playwright/test';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('Manager approves Message Received and only a resolved signed customer message creates the task',async({browser,request})=>{
 const fixture=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string};
 const headers={authorization:'Bearer '+fixture.testToken};
 const seeded=await request.post('/__test__/conversation-notifications',{headers,data:{fixture:true}});
 expect(seeded.status()).toBe(200);
 const {leadId,campaignId,connectionId}=await seeded.json();
 const context=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
 const page=await context.newPage(),errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 const privateText='Synthetic customer message content isolated from Automation';
 try {
  await page.goto('/');
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
  await page.getByLabel('Email',{exact:true}).fill('manager@browser.test');
  await page.getByLabel('Password',{exact:true}).fill(fixture.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Automations',exact:true}).click();
  const panel=page.locator('[data-automation-workspace]'),editor=panel.locator('[data-automation-editor]');
  await panel.getByRole('button',{name:'New automation',exact:true}).first().click();
  await editor.getByLabel('Rule name',{exact:true}).fill('Synthetic inbound task');
  await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaignId);
  await editor.getByLabel('Trigger',{exact:true}).selectOption({label:'Message received'});
  await editor.getByLabel('Task note or internal notification text',{exact:true}).fill('Review the customer reply');
  await editor.getByLabel('Enable this rule',{exact:true}).check();
  await editor.getByLabel('Approval reason',{exact:true}).fill('Approve synthetic inbound task');
  await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
  await expect(editor).toHaveCount(0);

  const eventId='wamid.browser-automation.'+randomUUID();
  const payload=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'123456789',changes:[{field:'messages',value:{
   messaging_product:'whatsapp',metadata:{phone_number_id:'15551110000'},messages:[{
    id:eventId,from:'15551112222',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:privateText},
   }],
  }}]}]});
  const deliver=(secret:string)=>request.post('/api/webhooks/messaging/meta/'+connectionId,{data:payload,headers:{
   'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(payload).digest('hex'),
  }});
  const tasks=async()=>(await(await page.request.get('/api/leads/'+leadId+'/followups')).json()).items;
  expect((await deliver('wrong-synthetic-key')).status()).toBe(403);
  expect((await deliver('SyntheticAttentionSecret')).ok()).toBeTruthy();
  expect(await tasks()).toHaveLength(0);
  expect((await request.post('/__test__/operational-alerts',{headers})).ok()).toBeTruthy();
  expect((await(await deliver('SyntheticAttentionSecret')).json()).created).toBe(0);
  for(const phase of ['MATCH','EXECUTE']){
   const run=await request.post('/__test__/automation',{headers,data:{phase}});
   expect(run.ok(),await run.text()).toBeTruthy();
  }
  expect(await tasks()).toHaveLength(1);
  expect((await tasks())[0].kind).toBe('AUTOMATION');
  await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();
  const entry=panel.locator('[data-automation-processing-id]').filter({hasText:'Synthetic inbound task'});
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('Action applied');
  await expect(panel).not.toContainText(privateText);
  await expect(panel).not.toContainText(eventId);
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('fr');
  await expect(panel).toContainText('Message reçu');
  expect(errors).toEqual([]);
 } finally {
  await context.close();
 }
});
