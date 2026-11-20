import {expect,test,type Page} from '@playwright/test';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('A verified inbound alert opens scoped review and becomes historical after disposition',async({browser,request})=>{
 const fixture=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string};
 const control=()=>request.post('/__test__/operational-alerts',{headers:{authorization:'Bearer '+fixture.testToken}});
 const response=await control();
 expect(response.ok()).toBeTruthy();
 const {connectionId}=await response.json();
 const body='<img src=x onerror="window.alertXss=1"> Synthetic unresolved message';
 const payload=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'123456789',changes:[{field:'messages',value:{
  messaging_product:'whatsapp',metadata:{phone_number_id:'15550001111'},messages:[{
   id:'wamid.alert.'+randomUUID(),from:'15550001757',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body},
  }],
 }}]}]});
 const signature=createHmac('sha256','test-customer-ai-e2e-secret').update(payload).digest('hex');
 const webhook=await request.post('/api/webhooks/messaging/meta/'+connectionId,{data:payload,headers:{
  'content-type':'application/json','x-hub-signature-256':'sha256='+signature,
 }});
 expect(webhook.ok()).toBeTruthy();
 expect((await webhook.json()).created).toBe(1);
 expect((await control()).ok()).toBeTruthy();

 const login=async(actor:string)=>{
  const context=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  const page=await context.newPage();
  await page.goto('/');
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
  await page.getByLabel('Email',{exact:true}).fill(actor+'@browser.test');
  await page.getByLabel('Password',{exact:true}).fill(fixture.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Notifications',exact:true}).click();
  return page;
 };
 const refresh=(page:Page)=>page.getByRole('button',{name:'Refresh notifications',exact:true}).click();
 const manager=await login('manager');
 const other=await login('other');
 const agent=await login('agent');
 try{
  const feed=await manager.request.get('/api/notifications?language=en&limit=50');
  expect(feed.ok()).toBeTruthy();
  const {items}=await feed.json();
  const alert=items.find((item:{eventType:string;operational?:{connectionId:string;current:boolean}})=>
   item.eventType==='INBOUND_REVIEW_REQUIRED'&&item.operational?.connectionId===connectionId&&item.operational?.current);
  expect(alert).toBeTruthy();
  const cardFor=(page:Page)=>page.locator(`[data-notification="${alert.id}"]`);
  const card=cardFor(manager);
  await expect(card).toContainText('Message needs review');
  await expect(card).not.toContainText('Synthetic unresolved message');
  await expect(card.getByRole('button',{name:'Open Lead',exact:true})).toHaveCount(0);
  for(const denied of [other,agent]) {
   await refresh(denied);
   await expect(cardFor(denied)).toHaveCount(0);
   const read=await denied.request.get('/api/messaging/connections/'+connectionId+'/inbound-review/'+alert.operational.inboundEventId);
   expect([403,404]).toContain(read.status());
  }

  const preferences=manager.locator('[data-operational-notification-controls]');
  const enabled=preferences.getByLabel('Enable in-app alert',{exact:true});
  const save=preferences.getByRole('button',{name:'Save operational preference',exact:true});
  await enabled.uncheck();await save.click();await expect(card).toHaveCount(0);
  await enabled.check();await save.click();await expect(card).toBeVisible();

  await card.getByRole('button',{name:'Open inbound review',exact:true}).click();
  const review=card.locator('.inbound-review');
  await expect(review).toContainText(body);
  await expect(review.locator('img')).toHaveCount(0);
  await review.getByLabel('Reason to ignore',{exact:true}).fill('Disposition of synthetic unmatched message');
  await review.getByRole('button',{name:'Ignore and retain event',exact:true}).click();
  await expect(review.getByLabel('Reason to ignore',{exact:true})).toHaveCount(0);
  await refresh(manager);
  await expect(card).toContainText('Historical alert');
  await manager.getByRole('combobox',{name:'Language',exact:true}).selectOption('ar');
  await manager.setViewportSize({width:390,height:844});
  await expect(card).toContainText('تنبيه سابق');
  expect(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
 }finally{
  for(const page of [manager,other,agent])await page.context().close();
 }
});
