import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const headers={origin:'http://127.0.0.1:4100'};
async function login(page:Page,password:string,name='manager'){
 await page.goto('/');await page.getByRole('combobox',{name:'Language'}).selectOption('en');
 await page.getByLabel('Email',{exact:true}).fill(name+'@browser.test');await page.getByLabel('Password',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
}
async function createLead(page:Page,phone:string,agentId?:string){
 const me=await(await page.request.get('/api/auth/me')).json(),c=await page.request.post('/api/campaigns',{headers,data:{branchId:me.branchId,name:'Browser due follow-ups',routingMethod:'MANUAL'}});
 expect(c.status()).toBe(201);const cid=(await c.json()).id;expect((await page.request.post('/api/campaigns/'+cid+'/activate',{headers})).status()).toBe(200);
 const r=await page.request.post('/api/leads',{headers,data:{branchId:me.branchId,campaignId:cid,contact:{name:'Synthetic due customer',phone}}});expect(r.status()).toBe(201);const id=(await r.json()).id;
 if(agentId)expect((await page.request.post('/api/leads/'+id+'/assignment',{headers,data:{version:1,agentId,reason:'Task notification journey'}})).status()).toBe(200);
 return id as string;
}
async function openLead(page:Page,lead:string){
 await page.getByRole('button',{name:'Notifications',exact:true}).click();const center=page.locator('[data-notification-center]');await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();
 const notices=(await(await page.request.get('/api/notifications?language=en&limit=50')).json()).items;
 const notice=notices.find((n:any)=>n.leadId===lead);expect(notice).toBeTruthy();
 await center.locator('[data-notification="'+notice.id+'"]').getByRole('button',{name:'Open Lead',exact:true}).click();await expect(page.locator('.lead-workflow')).toBeVisible();
}
function localInput(value:number){const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}

test('A real follow-up created in UI becomes a deduplicated due notice with wording, preferences, history and current vs historical status in three languages',async({browser})=>{
 const f=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string};
 const context=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),other=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),page=await context.newPage(),agent=await other.newPage(),errors:string[]=[];
 for(const p of [page,agent]){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/same key|unique.*key/i.test(m.text()))errors.push(m.text());});}
 try{
  await login(page,f.password);await login(agent,f.password,'agent');const owner=await(await agent.request.get('/api/auth/me')).json(),lead=await createLead(page,'+15553337910',owner.id);
  await openLead(agent,lead);const form=agent.getByRole('button',{name:'Create follow-up',exact:true}).locator('..');
  await form.getByLabel('Due at',{exact:true}).fill(localInput(Date.now()-3600000));await form.getByLabel('Task details',{exact:true}).fill('Browser internal due task');
  const saved=agent.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/leads/'+lead+'/followups'));
  await form.getByRole('button',{name:'Create follow-up',exact:true}).click();expect((await saved).status()).toBe(201);
  await expect(form.getByLabel('Task details',{exact:true})).toHaveValue('');
  const tasks=await(await agent.request.get('/api/leads/'+lead+'/followups')).json(),task=tasks.items.find((n:any)=>n.note==='Browser internal due task');expect(task).toBeTruthy();
  const status=agent.locator('[data-follow-up-notification-status="'+task.id+'"]');await status.getByRole('button',{name:'Follow-up notification status',exact:true}).click();await expect(status).toContainText('Waiting for due time or processing');
  const control=()=>page.request.post('/__test__/follow-up-notifications',{headers:{...headers,authorization:'Bearer '+f.testToken},data:{process:true}});
  expect((await control()).status()).toBe(200);expect((await control()).status()).toBe(200);
  await status.getByRole('button',{name:'Refresh notification status',exact:true}).click();await expect(status).toContainText('Notification recorded');
  await page.getByRole('button',{name:'Notifications',exact:true}).click();const editor=page.locator('[data-notification-templates]');await editor.getByLabel('Notification event',{exact:true}).selectOption('FOLLOW_UP_DUE');await editor.getByRole('button',{name:'Load wording',exact:true}).click();
  await editor.getByLabel('Use this wording',{exact:true}).check();await editor.getByLabel('Notification title',{exact:true}).fill('Due task {{campaign}}');await editor.getByLabel('Notification body',{exact:true}).fill('Task owner {{owner}} <img src=x onerror="window.dueXss=1">');await editor.getByLabel('Wording change reason',{exact:true}).fill('Approved due wording');await editor.getByRole('button',{name:'Save notification wording',exact:true}).click();await expect(editor.getByLabel('Wording change reason',{exact:true})).toHaveValue('');
  await editor.getByRole('button',{name:'Wording history',exact:true}).click();await expect(editor).toContainText('Approved due wording');
  await agent.getByRole('button',{name:'Notifications',exact:true}).click();const center=agent.locator('[data-notification-center]');await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();
  const dueEvents=async()=>(await(await agent.request.get('/api/notifications?language=en&limit=50')).json()).items.filter((n:any)=>n.followUp?.id===task.id);
  expect((await dueEvents()).length).toBe(1);const noticeId=(await dueEvents())[0].id,notice=center.locator('[data-notification="'+noticeId+'"]');
  await expect(notice).toContainText('Due task Browser due follow-ups');await expect(notice).toContainText('Currently due follow-up');await expect(notice).toContainText('<img');await expect(notice.locator('img')).toHaveCount(0);
  await notice.getByRole('button',{name:'Mark read',exact:true}).click();await notice.getByRole('button',{name:'Read status history',exact:true}).click();await expect(center.locator('[data-notification-history]')).toContainText('Version 1');
  const pref=agent.locator('[data-follow-up-notification-preference]');await pref.getByLabel('Enable In-App follow-up due notifications',{exact:true}).uncheck();await pref.getByRole('button',{name:'Save follow-up notification preference',exact:true}).click();await expect(notice).toHaveCount(0);
  await pref.getByLabel('Enable In-App follow-up due notifications',{exact:true}).check();await pref.getByRole('button',{name:'Save follow-up notification preference',exact:true}).click();await expect(notice).toBeVisible();
  expect((await page.request.patch('/api/followups/'+task.id,{headers,data:{version:1,dueAt:new Date(Date.now()+3600000).toISOString()}})).status()).toBe(200);
  await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();await expect(notice).toContainText('Historical due notice');
  expect((await page.request.patch('/api/followups/'+task.id,{headers,data:{version:2,status:'COMPLETED'}})).status()).toBe(200);
  await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();await expect(notice).toContainText('Completed');
  await agent.getByRole('combobox',{name:'Language'}).selectOption('fr');await expect(notice).toContainText('Notification d’échéance historique');await agent.getByRole('combobox',{name:'Language'}).selectOption('ar');await agent.setViewportSize({width:390,height:844});await expect(notice).toContainText('تنبيه استحقاق سابق');await center.screenshot({path:'.local/e2e/follow-up-notifications-ar.png'});expect(await agent.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await agent.getByRole('combobox',{name:'Language'}).selectOption('en');await agent.route('**/api/notification-preferences/FOLLOW_UP_DUE',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'NOTIFICATION_ACCESS_REVOKED'})}));await pref.getByRole('button',{name:'Reload follow-up notification preference',exact:true}).click();await expect(pref.getByRole('alert')).toBeVisible();await expect(pref.getByLabel('Enable In-App follow-up due notifications',{exact:true})).toHaveCount(0);
  expect(errors).toEqual([]);expect(await agent.evaluate(()=>Boolean((window as unknown as {dueXss?:unknown}).dueXss))).toBe(false);
 }finally{await context.close();await other.close();}
});

test('Failed due notification is visible and recoverable by Manager without replaying the task or exposing internal errors',async({browser})=>{
 const f=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string},context=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),page=await context.newPage();
 try{
  await login(page,f.password);const lead=await createLead(page,'+15553337911'),r=await page.request.post('/api/leads/'+lead+'/followups',{headers,data:{dueAt:new Date(Date.now()-3600000).toISOString(),note:'Retry browser task'}});expect(r.status()).toBe(201);const task=(await r.json()).id;
  const control=(data:object)=>page.request.post('/__test__/follow-up-notifications',{headers:{...headers,authorization:'Bearer '+f.testToken},data});
  expect((await control({failTaskId:task,fail:true})).status()).toBe(200);
  for(let n=0;n<5;n++){if(n)await new Promise(resolve=>setTimeout(resolve,2**(n-1)*1000+50));expect((await control({process:true})).status()).toBe(200);}
  await openLead(page,lead);const panel=page.locator('[data-follow-up-notification-status="'+task+'"]');await panel.getByRole('button',{name:'Follow-up notification status',exact:true}).click();await expect(panel).toContainText('Recording failed five times');await expect(panel).not.toContainText('NeverExposeBrowserSQLSecret');
  expect((await control({failTaskId:task,fail:false})).status()).toBe(200);await panel.getByRole('button',{name:'Retry follow-up notification',exact:true}).click();await expect(panel).toContainText('Waiting for due time or processing');expect((await control({process:true})).status()).toBe(200);await panel.getByRole('button',{name:'Refresh notification status',exact:true}).click();await expect(panel).toContainText('Notification recorded');await expect(panel.getByRole('button',{name:'Retry follow-up notification',exact:true})).toHaveCount(0);
  const notices=(await(await page.request.get('/api/notifications?language=en&limit=50')).json()).items.filter((n:any)=>n.followUp?.id===task);expect(notices.length).toBe(1);expect(notices[0].followUp.currentlyDue).toBe(true);
  await page.route('**/api/followups/'+task+'/notification',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'NOTIFICATION_ACCESS_REVOKED'})}));await panel.getByRole('button',{name:'Refresh notification status',exact:true}).click();await expect(panel.getByRole('alert')).toBeVisible();await expect(panel).not.toContainText('Notification recorded');
 }finally{await context.close();}
});
