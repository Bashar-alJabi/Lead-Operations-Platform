import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

test('Approved scoped automations create actual tasks and safe internal notices, with durable failure recovery, rule history and localized UI',async({browser})=>{
 const f=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string},headers={origin:'http://127.0.0.1:4100'};
 const mc=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),ac=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),page=await mc.newPage(),agent=await ac.newPage(),errors:string[]=[];
 for(const p of [page,agent]){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/same key|unique.*key/i.test(m.text()))errors.push(m.text());});}
 const control=(data:object)=>page.request.post('/__test__/automation',{headers:{...headers,authorization:'Bearer '+f.testToken},data});
 async function login(p:Page,name:string){await p.goto('/');await p.getByRole('combobox',{name:'Language'}).selectOption('en');await p.getByLabel('Email',{exact:true}).fill(name+'@browser.test');await p.getByLabel('Password',{exact:true}).fill(f.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await expect(p.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();}
 let taskRule='';
 try{
  await login(page,'manager');await login(agent,'agent');await expect(agent.getByRole('button',{name:'Automations',exact:true})).toHaveCount(0);expect((await agent.request.get('/api/automations')).status()).toBe(403);
  const me=await(await page.request.get('/api/auth/me')).json(),owner=await(await agent.request.get('/api/auth/me')).json();
  const made=await page.request.post('/api/campaigns',{headers,data:{branchId:me.branchId,name:'Browser automation campaign',routingMethod:'MANUAL'}});expect(made.status()).toBe(201);const campaign=(await made.json()).id;
  expect((await page.request.post('/api/campaigns/'+campaign+'/activate',{headers})).status()).toBe(200);
  await page.getByRole('button',{name:'Automations',exact:true}).click();const panel=page.locator('[data-automation-workspace]'),editor=panel.locator('[data-automation-editor]');
  async function addRule(name:string,action:string,trigger:string){
   await panel.getByRole('button',{name:'New automation',exact:true}).first().click();await editor.getByLabel('Rule name',{exact:true}).fill(name);await editor.getByLabel('Campaign scope',{exact:true}).selectOption(campaign);
   await editor.getByLabel('Trigger',{exact:true}).selectOption(trigger);await editor.getByLabel('Action',{exact:true}).selectOption(action);await editor.getByLabel('Task note or internal notification text',{exact:true}).fill('Synthetic automation <img src=x onerror="window.automationXss=1">');
   await editor.getByLabel('Enable this rule',{exact:true}).check();await editor.getByLabel('Approval reason',{exact:true}).fill('Approve browser internal action');
   const saved=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/automations'));await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();const response=await saved;expect(response.status()).toBe(201);await expect(editor).toHaveCount(0);return(await response.json()).id as string;
  }
  taskRule=await addRule('Synthetic task rule','CREATE_FOLLOW_UP','LEAD_CREATED');const noticeRule=await addRule('Synthetic internal notice','SEND_IN_APP_NOTIFICATION','LEAD_ASSIGNED');
  await panel.locator('[data-automation-rule="'+taskRule+'"]').getByRole('button',{name:'Rule history',exact:true}).click();await expect(panel.locator('[data-automation-history]')).toContainText('Version 1');
  const leadResponse=await page.request.post('/api/leads',{headers,data:{branchId:me.branchId,campaignId:campaign,contact:{name:'Automation flow contact',phone:'+15553338500'}}});expect(leadResponse.status()).toBe(201);const lead=(await leadResponse.json()).id;
  expect((await page.request.post('/api/leads/'+lead+'/assignment',{headers,data:{version:1,agentId:owner.id,reason:'Assign actual automation lead'}})).status()).toBe(200);
  expect((await control({phase:'MATCH'})).status()).toBe(200);expect((await control({failRuleId:taskRule,fail:true})).status()).toBe(200);
  const executions=async()=>(await(await page.request.get('/api/automation/executions?limit=50')).json()).items;
  for(let n=1;n<=5;n++){
   if(n>1){const e=(await executions()).find((x:any)=>x.rule_name==='Synthetic task rule'&&x.lead_id===lead);await new Promise(resolve=>setTimeout(resolve,Math.max(0,+new Date(e.next_run_at)-Date.now())+40));}
   expect((await control({phase:'EXECUTE'})).status()).toBe(200);
  }
  const failed=(await executions()).find((x:any)=>x.rule_name==='Synthetic task rule'&&x.lead_id===lead);expect(failed.state).toBe('DEAD_LETTER');
  expect((await(await agent.request.get('/api/leads/'+lead+'/followups')).json()).items).toHaveLength(0);
  await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();const row=panel.locator('[data-automation-processing-id="'+failed.id+'"]');await expect(row).toContainText('Needs recovery');
  await row.getByRole('button',{name:'Processing history',exact:true}).click();await expect(panel.locator('[data-automation-history]')).toContainText('Version 6');
  expect((await agent.request.post('/api/automation/executions/'+failed.id+'/retry',{headers,data:{version:6}})).status()).toBe(403);
  expect((await control({failRuleId:taskRule,fail:false})).status()).toBe(200);await row.getByRole('button',{name:'Retry failed processing',exact:true}).click();await expect(row).toContainText('Queued');
  await control({phase:'EXECUTE'});await panel.getByRole('button',{name:'Refresh processing',exact:true}).click();await expect(row).toContainText('Applied');
  const task=(await(await agent.request.get('/api/leads/'+lead+'/followups')).json()).items;expect(task).toHaveLength(1);expect(task[0].kind).toBe('AUTOMATION');
  await agent.getByRole('button',{name:'Notifications',exact:true}).click();const center=agent.locator('[data-notification-center]');await center.getByRole('button',{name:'Refresh notifications',exact:true}).click();const notice=center.locator('[data-automation-notice]').filter({hasText:'Synthetic internal notice'});await expect(notice).toContainText('<img');await expect(notice.locator('img')).toHaveCount(0);
  const alerts=(await(await agent.request.get('/api/notifications?language=en&limit=50')).json()).items.filter((x:any)=>x.eventType==='AUTOMATION_NOTICE'&&x.leadId===lead);expect(alerts).toHaveLength(1);expect(alerts[0].automation.ruleId).toBe(noticeRule);
  const pref=center.locator('[data-lead-notification-preferences]');await pref.getByLabel('Lead notification preference event',{exact:true}).selectOption('AUTOMATION_NOTICE');await pref.getByLabel('Enable this In-App notification',{exact:true}).uncheck();await pref.getByRole('button',{name:'Save lead notification preference',exact:true}).click();await expect(notice).toHaveCount(0);
  await pref.getByLabel('Enable this In-App notification',{exact:true}).check();await pref.getByRole('button',{name:'Save lead notification preference',exact:true}).click();await expect(notice).toHaveCount(1);
  await panel.locator('[data-automation-rule="'+taskRule+'"]').getByRole('button',{name:'Edit automation',exact:true}).click();await editor.getByLabel('Enable this rule',{exact:true}).uncheck();await editor.getByLabel('Approval reason',{exact:true}).fill('Explicitly stop this approved rule');await editor.getByRole('button',{name:'Approve and save automation',exact:true}).click();await expect(editor).toHaveCount(0);
  await panel.locator('[data-automation-rule="'+taskRule+'"]').getByRole('button',{name:'Rule history',exact:true}).click();await expect(panel.locator('[data-automation-history]')).toContainText('Version 2');
  await page.getByRole('combobox',{name:'Language'}).selectOption('fr');await expect(panel.getByRole('heading',{name:'Automatisations',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'Language'}).selectOption('ar');await page.setViewportSize({width:390,height:844});await expect(panel.getByRole('heading',{name:'الأتمتة',exact:true})).toBeVisible();
  await panel.screenshot({path:'.local/e2e/automation-ar.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.getByRole('combobox',{name:'Language'}).selectOption('en');await page.route('**/api/automations?*',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'ACCESS_REVOKED'})}));await panel.getByRole('button',{name:'Reload automations',exact:true}).click();await expect(panel.getByRole('alert')).toBeVisible();await expect(panel.locator('[data-automation-rule]')).toHaveCount(0);await expect(panel.locator('[data-automation-history]')).toHaveCount(0);
  expect(errors).toEqual([]);expect(await agent.evaluate(()=>Boolean((window as unknown as {automationXss?:unknown}).automationXss))).toBe(false);
 }finally{if(taskRule)await control({failRuleId:taskRule,fail:false});await mc.close();await ac.close();}
});
