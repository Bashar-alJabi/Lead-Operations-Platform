import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

test('Actual UNKNOWN records a durable attention notice independently of publication failure, with scoped recovery, preferences, wording and historical localized UI',async({browser})=>{
 const f=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string},headers={origin:'http://127.0.0.1:4100'};
 const mc=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),ac=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),manager=await mc.newPage(),agent=await ac.newPage(),errors:string[]=[];
 for(const p of [manager,agent]){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/same key|unique.*key/i.test(m.text()))errors.push(m.text());});}
 const control=(data:object)=>manager.request.post('/__test__/conversation-notifications',{headers:{...headers,authorization:'Bearer '+f.testToken},data});
 async function login(p:Page,user:string){await p.goto('/');await p.getByRole('combobox',{name:'Language'}).selectOption('en');await p.getByLabel('Email',{exact:true}).fill(user+'@browser.test');await p.getByLabel('Password',{exact:true}).fill(f.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await expect(p.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();}
 async function open(p:Page){await p.goto('/');await p.getByRole('row').filter({hasText:'Attention test contact'}).getByRole('button',{name:'Details',exact:true}).click();await p.getByRole('button',{name:'View messages',exact:true}).click();}
 try{
  await login(manager,'manager');await login(agent,'agent');const made=await control({fixture:true});expect(made.status()).toBe(200);const {leadId,conversationId}=await made.json(),statusRoot='/api/conversations/'+conversationId+'/notification-delivery';
  await open(agent);const panel=agent.locator('.conversation-panel');await panel.getByLabel('Message text',{exact:true}).fill('Synthetic attention browser message');
  const queue=agent.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/conversations/'+conversationId+'/messages'));
  await panel.getByRole('button',{name:'Queue message',exact:true}).click();const response=await queue;expect(response.status()).toBe(202);const messageId=(await response.json()).id;
  expect((await control({failConversationId:conversationId,fail:true,unknownMessageId:messageId})).status()).toBe(200);
  const status=async()=>(await(await manager.request.get(statusRoot)).json()).items[0];
  expect((await status()).state).toBe('QUEUED');
  // Drain actual queued sources, including sources from earlier full-suite scenarios. No test clock or queue-state bypass.
  for(let n=0;n<120&&(await status()).state!=='DEAD_LETTER';n++){
   const s=await status();if(s.failureCount>0&&s.nextRunAt)await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(s.nextRunAt)-Date.now()+50)));
   expect((await control({process:true})).status()).toBe(200);
  }
  const dead=await status();expect(dead.state).toBe('DEAD_LETTER');expect(dead.failureCount).toBe(5);
  const messages=async()=>(await(await agent.request.get('/api/conversations/'+conversationId+'/messages')).json()).items;
  expect((await messages()).find((m:any)=>m.id===messageId).delivery_state).toBe('UNKNOWN');
  const notices=async(p:Page=agent)=>(await(await p.request.get('/api/notifications?language=en&limit=50')).json()).items.filter((n:any)=>n.conversationId===conversationId&&n.eventType==='CONVERSATION_NEEDS_ATTENTION');
  expect(await notices()).toEqual([]);await open(manager);const delivery=manager.locator('[data-conversation-notification-delivery]');await delivery.getByRole('button',{name:'Conversation notification status',exact:true}).click();await expect(delivery).toContainText('Recording failed five times');await expect(delivery).not.toContainText('NeverExposeAttentionBrowserSecret');
  await delivery.getByRole('button',{name:'Notification processing history',exact:true}).click();await expect(delivery.locator('[data-notification-processing-history]')).toContainText('Failures: 5');
  expect((await agent.request.post(statusRoot+'/'+dead.id+'/retry',{headers,data:{version:dead.version}})).status()).toBe(403);
  expect((await control({failConversationId:conversationId,fail:false})).status()).toBe(200);
  await delivery.getByRole('button',{name:'Retry recording the notification',exact:true}).click();await expect(delivery).toContainText('Waiting to record notification');expect((await control({process:true})).status()).toBe(200);
  await delivery.getByRole('button',{name:'Refresh conversation notification status',exact:true}).click();await expect(delivery).toContainText('Notification recorded');
  expect((await notices()).length).toBe(1);const notice=(await notices())[0];expect(notice.attention.currentlyNeedsAttention).toBe(true);
  await agent.getByRole('button',{name:'Notifications',exact:true}).click();const center=agent.locator('[data-notification-center]'),card=center.locator('[data-notification="'+notice.id+'"]');await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();await expect(card).toContainText('Conversation still needs review');await expect(card).toContainText('Send outcome is unknown');
  await card.getByRole('button',{name:'Mark read',exact:true}).click();await card.getByRole('button',{name:'Read status history',exact:true}).click();await expect(center.locator('[data-notification-history]')).toContainText('Version 1');
  const pref=agent.locator('[data-lead-notification-preferences]');await pref.getByLabel('Lead notification preference event',{exact:true}).selectOption('CONVERSATION_NEEDS_ATTENTION');await pref.getByLabel('Enable this In-App notification',{exact:true}).uncheck();await pref.getByRole('button',{name:'Save lead notification preference',exact:true}).click();await expect(card).toHaveCount(0);
  await pref.getByLabel('Enable this In-App notification',{exact:true}).check();await pref.getByRole('button',{name:'Save lead notification preference',exact:true}).click();await expect(card).toBeVisible();
  await manager.getByRole('button',{name:'Notifications',exact:true}).click();const editor=manager.locator('[data-notification-templates]');await editor.getByLabel('Notification event',{exact:true}).selectOption('CONVERSATION_NEEDS_ATTENTION');await editor.getByRole('button',{name:'Load wording',exact:true}).click();await editor.getByLabel('Use this wording',{exact:true}).check();await editor.getByLabel('Notification title',{exact:true}).fill('Review {{campaign}}');await editor.getByLabel('Notification body',{exact:true}).fill('Owner {{owner}} <img src=x onerror="window.attentionXss=1">');await editor.getByLabel('Wording change reason',{exact:true}).fill('Approved conversation attention wording');await editor.getByRole('button',{name:'Save notification wording',exact:true}).click();await expect(editor.getByLabel('Wording change reason',{exact:true})).toHaveValue('');
  await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();await expect(card).toContainText('Review Browser attention campaign');await expect(card).toContainText('<img');await expect(card.locator('img')).toHaveCount(0);
  const cv=(await(await agent.request.get('/api/leads/'+leadId+'/conversations')).json()).items[0];expect(cv.needs_attention_reason).toBe('SEND_OUTCOME_UNKNOWN');
  expect((await control({})).status()).toBe(200);expect((await(await control({})).json()).providerCalls).toBe(1);
  expect((await manager.request.post('/api/conversations/'+conversationId+'/attention/acknowledge',{headers,data:{version:cv.version,expectedReason:'SEND_OUTCOME_UNKNOWN',reviewNote:'Reviewed the synthetic provider outcome',reviewConfirmed:true}})).status()).toBe(200);
  await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();await expect(card).toContainText('Historical review notice');expect((await messages()).find((m:any)=>m.id===messageId).delivery_state).toBe('UNKNOWN');
  await agent.getByRole('combobox',{name:'Language'}).selectOption('fr');await expect(card).toContainText('Notification historique');await agent.getByRole('combobox',{name:'Language'}).selectOption('ar');await agent.setViewportSize({width:390,height:844});await expect(card).toContainText('تنبيه مراجعة سابق');await center.screenshot({path:'.local/e2e/conversation-notifications-ar.png'});expect(await agent.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await agent.getByRole('combobox',{name:'Language'}).selectOption('en');await agent.route('**/api/notification-preferences/CONVERSATION_NEEDS_ATTENTION',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'NOTIFICATION_ACCESS_REVOKED'})}));await pref.getByRole('button',{name:'Reload lead notification preference',exact:true}).click();await expect(pref.getByRole('alert')).toBeVisible();await expect(pref.getByLabel('Enable this In-App notification',{exact:true})).toHaveCount(0);
  expect((await manager.request.post('/api/leads/'+leadId+'/assignment',{headers,data:{version:1,agentId:null,reason:'Remove attention notice access'}})).status()).toBe(200);await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();await expect(card).toHaveCount(0);expect((await agent.request.get(statusRoot)).status()).toBe(404);expect((await agent.request.get('/api/notifications/'+notice.id+'/history')).status()).toBe(404);
  expect((await(await control({})).json()).providerCalls).toBe(1);expect(errors).toEqual([]);expect(await agent.evaluate(()=>Boolean((window as unknown as {attentionXss?:unknown}).attentionXss))).toBe(false);
 }finally{await mc.close();await ac.close();}
});
