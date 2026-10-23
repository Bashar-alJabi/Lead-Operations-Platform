import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

test('Fresh lead and assignment inbox events support scoped wording, personal preferences, read history and current-owner revocation in localized UI',async({browser})=>{
 const f=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string},origin='http://127.0.0.1:4100',headers={origin};
 const managerContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),agentContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),page=await managerContext.newPage(),agent=await agentContext.newPage(),errors:string[]=[];
 for(const p of [page,agent]){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/same key|unique.*key/i.test(m.text()))errors.push(m.text());});}
 const login=async(p:Page,name:string)=>{await p.goto('/');await p.getByRole('combobox',{name:'Language'}).selectOption('en');await p.getByLabel('Email',{exact:true}).fill(name+'@browser.test');await p.getByLabel('Password',{exact:true}).fill(f.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await expect(p.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();};
 try{
  await login(page,'manager');await login(agent,'agent');const me=await(await page.request.get('/api/auth/me')).json(),owner=await(await agent.request.get('/api/auth/me')).json();
  const campaign=await page.request.post('/api/campaigns',{headers,data:{branchId:me.branchId,name:'Browser operational notices',routingMethod:'MANUAL'}});expect(campaign.status()).toBe(201);const cid=(await campaign.json()).id;
  expect((await page.request.post('/api/campaigns/'+cid+'/activate',{headers})).status()).toBe(200);
  const create=await page.request.post('/api/leads',{headers,data:{branchId:me.branchId,campaignId:cid,contact:{name:'Operational notification customer',phone:'+15553337902'}}});expect(create.status()).toBe(201);const lead=(await create.json()).id;
  const events=async(p:Page)=>(await(await p.request.get('/api/notifications?language=en&limit=50')).json()).items.filter((n:any)=>n.leadId===lead);
  expect((await events(page)).map((n:any)=>n.eventType)).toEqual(['LEAD_CREATED']);expect(await events(agent)).toEqual([]);
  expect((await page.request.post('/api/leads/'+lead+'/assignment',{headers,data:{version:1,agentId:owner.id,reason:'Assign for actual notification'}})).status()).toBe(200);
  await agent.getByRole('button',{name:'Notifications',exact:true}).click();const center=agent.locator('[data-notification-center]');await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();
  const created=(await events(agent)).find((n:any)=>n.eventType==='LEAD_CREATED'),assigned=(await events(agent)).find((n:any)=>n.eventType==='LEAD_ASSIGNED');expect(assigned).toBeTruthy();
  const notice=center.locator('[data-notification="'+created.id+'"]');await expect(notice).toBeVisible();await expect(notice).toContainText('Recorded operational event');
  await notice.getByRole('button',{name:'Mark read',exact:true}).click();await expect(notice.getByRole('button',{name:'Mark unread',exact:true})).toBeVisible();await notice.getByRole('button',{name:'Read status history',exact:true}).click();await expect(center.locator('[data-notification-history]')).toContainText('Version 1');
  const pref=agent.locator('[data-lead-notification-preferences]');await pref.getByLabel('Enable this In-App notification',{exact:true}).uncheck();await pref.getByRole('button',{name:'Save lead notification preference',exact:true}).click();await expect(notice).toHaveCount(0);await expect(center.locator('[data-notification="'+assigned.id+'"]')).toBeVisible();
  await pref.getByLabel('Enable this In-App notification',{exact:true}).check();await pref.getByRole('button',{name:'Save lead notification preference',exact:true}).click();await expect(notice).toBeVisible();
  await page.getByRole('button',{name:'Notifications',exact:true}).click();const editor=page.locator('[data-notification-templates]');await editor.getByLabel('Notification event',{exact:true}).selectOption('LEAD_CREATED');await editor.getByRole('button',{name:'Load wording',exact:true}).click();
  await editor.getByLabel('Use this wording',{exact:true}).check();await editor.getByLabel('Notification title',{exact:true}).fill('Operational {{campaign}}');await editor.getByLabel('Notification body',{exact:true}).fill('Current owner {{owner}} <img src=x onerror="window.noticeXss=1">');await editor.getByLabel('Wording change reason',{exact:true}).fill('Approve Lead notification wording');await editor.getByRole('button',{name:'Save notification wording',exact:true}).click();await expect(editor.getByLabel('Wording change reason',{exact:true})).toHaveValue('');
  await editor.getByRole('button',{name:'Wording history',exact:true}).click();await expect(editor).toContainText('Approve Lead notification wording');await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();await expect(notice).toContainText('Operational Browser operational notices');await expect(notice).toContainText('<img');await expect(notice.locator('img')).toHaveCount(0);
  await agent.getByRole('combobox',{name:'Language'}).selectOption('fr');await expect(center).toContainText('Événement opérationnel enregistré');await agent.getByRole('combobox',{name:'Language'}).selectOption('ar');await agent.setViewportSize({width:390,height:844});await expect(center).toContainText('حدث تشغيلي محفوظ');await center.screenshot({path:'.local/e2e/lead-notifications-ar.png'});expect(await agent.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  // Revocation is decided by the real backend after unassignment, including old event state/history URLs.
  expect((await page.request.post('/api/leads/'+lead+'/assignment',{headers,data:{version:2,agentId:null,reason:'Remove current access'}})).status()).toBe(200);
  await agent.getByRole('combobox',{name:'Language'}).selectOption('en');await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();await expect(notice).toHaveCount(0);
  expect((await agent.request.get('/api/notifications/'+created.id+'/history')).status()).toBe(404);expect((await agent.request.put('/api/notifications/'+created.id+'/state',{headers,data:{version:1,isRead:false}})).status()).toBe(404);
  expect((await events(page)).some((n:any)=>n.eventType==='LEAD_REASSIGNED')).toBe(true);
  await agent.route('**/api/notification-preferences/LEAD_CREATED',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'NOTIFICATION_ACCESS_REVOKED'})}));await pref.getByRole('button',{name:'Reload lead notification preference',exact:true}).click();await expect(pref.getByRole('alert')).toBeVisible();await expect(pref.getByLabel('Enable this In-App notification',{exact:true})).toHaveCount(0);
  expect(errors).toEqual([]);expect(await agent.evaluate(()=>Boolean((window as unknown as {noticeXss?:unknown}).noticeXss))).toBe(false);
 }finally{await managerContext.close();await agentContext.close();}
});
