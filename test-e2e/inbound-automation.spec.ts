import {expect,test} from '@playwright/test';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('Manager approves message and conversation rules and observes each internal effect once',async({browser,request})=>{
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
  const origin={origin:'http://127.0.0.1:4100'};
  const {branchId}=await(await page.request.get('/api/auth/me')).json();
  const defined=await page.request.post('/api/fields',{headers:origin,data:{
   scope:'CAMPAIGN',branchId,campaignId,key:'browser_automation_field',label:'Synthetic automation field',
   fieldType:'TEXT',valueMode:'MANUAL',options:[],validation:{},
  }});
  expect(defined.status(),await defined.text()).toBe(201);
  const fieldId=(await defined.json()).id as string;
  const fieldBinding='/api/campaigns/'+campaignId+'/fields/'+fieldId;
  const settings={active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:true,visibleToManager:true,
   editableByManager:true,showInTable:false,showInDetails:true,filterable:false,usableByAutomation:true,usableByAi:false};
  expect((await page.request.put(fieldBinding,{headers:origin,data:settings})).status()).toBe(200);
  async function approve(name:string,trigger:string,action:string,watchedField?:string) {
   await panel.getByRole('button',{name:'New automation',exact:true}).first().click();
   await editor.getByLabel('Rule name',{exact:true}).fill(name);
   await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaignId);
   await editor.getByLabel('Trigger',{exact:true}).selectOption({label:trigger});
   if(watchedField)await editor.getByLabel('Watched field',{exact:true}).selectOption(watchedField);
   await editor.getByLabel('Action',{exact:true}).selectOption(action);
   await editor.getByLabel('Owner condition',{exact:true}).selectOption('ANY');
   await editor.getByLabel('Task note or internal notification text',{exact:true}).fill(name);
   await editor.getByLabel('Enable this rule',{exact:true}).check();
   await editor.getByLabel('Approval reason',{exact:true}).fill('Approve synthetic internal action');
   await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();
   await expect(editor).toHaveCount(0);
  }
  await approve('Synthetic inbound task','Message received','CREATE_FOLLOW_UP');
  await approve('Synthetic conversation changed','Conversation state changed','SEND_IN_APP_NOTIFICATION');
  await approve('Synthetic field changed','Field changed','SEND_IN_APP_NOTIFICATION',fieldId);

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
  async function processRules() {
   for(const phase of ['MATCH','EXECUTE']){
    const run=await request.post('/__test__/automation',{headers,data:{phase}});
    expect(run.ok(),await run.text()).toBeTruthy();
   }
  }
  await processRules();
  expect(await tasks()).toHaveLength(1);
  expect((await tasks())[0].kind).toBe('AUTOMATION');
  await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();
  const entry=panel.locator('[data-automation-processing-id]').filter({hasText:'Synthetic inbound task'});
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('Action applied');
  await expect(panel).not.toContainText(privateText);
  await expect(panel).not.toContainText(eventId);
  const assignment='/api/leads/'+leadId+'/assignment';
  for(const version of [1,2]){
   const moved=await page.request.post(assignment,{headers:origin,data:{
    version,agentId:null,reason:'Unassign synthetic lead to trigger the conversation transition',
   }});
   expect(moved.ok(),await moved.text()).toBeTruthy();
  }
  await processRules();
  await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();
  const transition=panel.locator('[data-automation-processing-id]').filter({hasText:'Synthetic conversation changed'});
  await expect(transition).toHaveCount(1);
  await expect(transition).toContainText('Action applied');
  const notices=await page.request.get('/api/notifications?language=en&limit=50');
  expect(notices.ok()).toBeTruthy();
  const events=(await notices.json()).items as {eventType:string;leadId:string}[];
  expect(events.filter(event=>event.eventType==='AUTOMATION_NOTICE'&&event.leadId===leadId)).toHaveLength(1);
  const fieldValue='/api/leads/'+leadId+'/fields/'+fieldId;
  expect((await page.request.put(fieldValue,{headers:origin,data:{value:'Private synthetic field observation'}})).status()).toBe(200);
  await processRules();
  expect((await page.request.put(fieldValue,{headers:origin,data:{value:'Synthetic update before revocation',version:1}})).status()).toBe(200);
  expect((await page.request.put(fieldBinding,{headers:origin,data:{...settings,usableByAutomation:false,version:1}})).status()).toBe(200);
  await processRules();
  await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();
  const fields=panel.locator('[data-automation-processing-id]').filter({hasText:'Synthetic field changed'});
  await expect(fields).toHaveCount(2);
  await expect(fields.filter({hasText:'Action applied'})).toHaveCount(1);
  await expect(fields.filter({hasText:'Field unavailable for automation'})).toHaveCount(1);
  await expect(panel).not.toContainText('Private synthetic field observation');
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('fr');
  await expect(panel).toContainText('Message reçu');
  await expect(panel).toContainText('État de la conversation modifié');
  await expect(panel).toContainText('Champ modifié');
  expect(errors).toEqual([]);
 } finally {
  await context.close();
 }
});
