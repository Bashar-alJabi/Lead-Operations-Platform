import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

test('Analytics displays trusted scoped cohort facts, explicit conversion, separate exact currencies and modes, safe drilldown and localized failure clearing',async({browser})=>{
 const f=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string},headers={origin:'http://127.0.0.1:4100'};
 const mc=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),ac=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),page=await mc.newPage(),agent=await ac.newPage(),errors:string[]=[];
 for(const p of [page,agent]){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/same key|unique.*key/i.test(m.text()))errors.push(m.text());});}
 async function login(p:Page,name:string){await p.goto('/');await p.getByRole('combobox',{name:'Language'}).selectOption('en');await p.getByLabel('Email',{exact:true}).fill(name+'@browser.test');await p.getByLabel('Password',{exact:true}).fill(f.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await expect(p.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();}
 try{
  await login(page,'manager');await login(agent,'agent');const me=await(await page.request.get('/api/auth/me')).json(),owner=await(await agent.request.get('/api/auth/me')).json();
  const campaigns:string[]=[];
  for(const [name,conversion] of [['Analytics defined <img src=x onerror="window.analyticsXss=1">',{type:'PAYMENT_CONFIRMED'}],['Analytics undefined',null]] as const){
   const r=await page.request.post('/api/campaigns',{headers,data:{branchId:me.branchId,name,routingMethod:'MANUAL'}});expect(r.status()).toBe(201);const id=(await r.json()).id;
   const patch=await page.request.patch('/api/campaigns/'+id,{headers,data:{version:1,name,sourceKind:'MANUAL',routingMethod:'MANUAL',messagingEnabled:false,aiEnabled:false,conversion}});expect(patch.status()).toBe(200);
   expect((await page.request.post('/api/campaigns/'+id+'/activate',{headers})).status()).toBe(200);campaigns.push(id);
  }
  const leads:string[]=[];
  for(let i=0;i<2;i++){const r=await page.request.post('/api/leads',{headers,data:{branchId:me.branchId,campaignId:campaigns[i],contact:{name:'Analytics flow '+(i?'beta':'alpha'),phone:'+1555333860'+i}}});expect(r.status()).toBe(201);const id=(await r.json()).id;
   expect((await page.request.post('/api/leads/'+id+'/assignment',{headers,data:{version:1,agentId:owner.id,reason:'Assign analytics cohort'}})).status()).toBe(200);leads.push(id);
  }
  const account=await page.request.post('/api/payments/bank-accounts',{headers,data:{name:'Synthetic analytics browser bank',branchId:me.branchId,mode:'TEST',beneficiary:'Synthetic company',accountIdentifier:'SYNTHETIC-ANALYTICS-BROWSER',bankName:'Synthetic bank',instructions:'Synthetic only',currencies:['EUR','JPY'],active:true,reason:'Synthetic independently reviewed account'}});expect(account.status()).toBe(201);
  const method=await page.request.post('/api/payments/methods',{headers,data:{name:'Synthetic analytics transfer',branchId:me.branchId,connectionId:(await account.json()).id,currencies:['EUR','JPY'],active:true,agents:{mode:'ALL',ids:[]},campaigns:{mode:'SELECTED',ids:[campaigns[0]]},reason:'Synthetic method limited to this scenario'}});expect(method.status()).toBe(201);const methodId=(await method.json()).id;
  const requests:{id:string;reference:string;amount:string;currency:string}[]=[];
  for(const [amount,currency] of [['0.10','EUR'],['0.20','EUR'],['300','JPY']]){const made=await agent.request.post('/api/leads/'+leads[0]+'/bank-transfers',{headers,data:{requestId:randomUUID(),methodId,methodVersion:1,amount,currency}});expect(made.status()).toBe(201);requests.push({...await made.json(),amount,currency});}
  // Keep metadata paging synthetic and local to this context. Persisting 26 unrelated
  // draft Campaigns would change the shared startup catalog used by later Browser flows.
  const pagingChoices=[{id:campaigns[1],name:'Analytics undefined'},...Array.from({length:24},(_,i)=>({id:randomUUID(),name:'Synthetic paging choice '+i}))];
  await page.route('**/api/campaigns?limit=25*',r=>{const next=new URL(r.request().url()).searchParams.has('cursor');return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:next?[{id:campaigns[0],name:'Analytics defined <img src=x onerror="window.analyticsXss=1">'}]:pagingChoices,nextCursor:next?null:'synthetic-browser-page'})});});
  await page.getByRole('button',{name:'Analytics',exact:true}).click();const panel=page.locator('[data-analytics-workspace]'),form=panel.locator('[data-analytics-filters]'),campaignChoice=form.getByLabel('Campaign',{exact:true});
  await expect(campaignChoice.locator('option')).toHaveCount(26);const firstChoice=await campaignChoice.locator('option').nth(1).evaluate(e=>({value:(e as HTMLOptionElement).value,label:e.textContent}));await campaignChoice.selectOption(firstChoice.value);
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/campaigns?')&&r.url().includes('cursor=')),form.getByRole('button',{name:'More campaign choices',exact:true}).click()]);
  await expect(campaignChoice).toHaveValue(firstChoice.value);await expect(campaignChoice.locator('option:checked')).toHaveText(firstChoice.label!);
  await page.unroute('**/api/campaigns?limit=25*');
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/campaigns?limit=25')&&!r.url().includes('cursor=')),form.getByRole('button',{name:'First campaign choices',exact:true}).click()]);
  await expect(campaignChoice).toHaveValue(firstChoice.value);await expect(campaignChoice.locator('option[value="'+campaigns[0]+'"]').first()).toHaveCount(1);
  await form.getByLabel('Campaign',{exact:true}).selectOption(campaigns[0]!);await form.getByLabel('Financial record mode',{exact:true}).selectOption('TEST');await form.getByRole('button',{name:'Load analytics',exact:true}).click();
  await expect(panel.locator('[data-analytics-metric="ALL"]')).toContainText('1');await expect(panel.locator('[data-analytics-revenue] tbody tr')).toHaveCount(0);await expect(panel.locator('[data-analytics-conversion]')).toHaveText('0.00%');
  for(const r of requests){const proof={transactionId:'BROWSER-ANALYTICS-'+randomUUID(),accountIdentifier:'SYNTHETIC-ANALYTICS-BROWSER',reference:r.reference,amount:r.amount,currency:r.currency,settledAt:new Date(Date.now()-60000).toISOString(),reason:'Synthetic settled bank transaction independently reviewed',bankVerified:true};
   const confirmed=await page.request.post('/api/leads/'+leads[0]+'/bank-transfers/'+r.id+'/confirm',{headers,data:proof});expect(confirmed.status()).toBe(200);
   expect((await page.request.post('/api/leads/'+leads[0]+'/bank-transfers/'+r.id+'/confirm',{headers,data:proof})).status()).toBe(200);
  }
  await panel.getByRole('button',{name:'Refresh analytics',exact:true}).first().click();await expect(panel.locator('[data-analytics-revenue] tbody tr')).toHaveCount(2);
  await expect(panel.locator('[data-analytics-revenue]')).toContainText('0.30');await expect(panel.locator('[data-analytics-revenue]')).toContainText('300');await expect(panel.locator('[data-analytics-revenue]')).toContainText('EUR');await expect(panel.locator('[data-analytics-revenue]')).toContainText('JPY');
  await expect(panel.locator('[data-analytics-conversion]')).toHaveText('100.00%');await expect(panel.locator('[data-analytics-groups]')).toContainText('Payment confirmed');await expect(panel.locator('[data-analytics-groups] img')).toHaveCount(0);
  await panel.locator('[data-analytics-metric="CONVERTED"]').click();const drill=panel.locator('[data-analytics-drilldown]');await expect(drill.locator('[data-analytics-lead]')).toHaveCount(1);await expect(drill).toContainText('Analytics flow alpha');
  await form.getByLabel('Financial record mode',{exact:true}).selectOption('LIVE');await form.getByRole('button',{name:'Load analytics',exact:true}).click();await expect(panel.locator('[data-analytics-revenue] tbody tr')).toHaveCount(0);await expect(panel.locator('[data-analytics-conversion]')).toHaveText('0.00%');
  await form.getByLabel('Campaign',{exact:true}).selectOption(campaigns[1]!);await form.getByRole('button',{name:'Load analytics',exact:true}).click();await expect(panel.locator('[data-analytics-conversion]')).toHaveText('Not configured');
  await agent.getByRole('button',{name:'Analytics',exact:true}).click();const ap=agent.locator('[data-analytics-workspace]');await ap.getByLabel('Campaign',{exact:true}).selectOption(campaigns[0]!);await ap.getByLabel('Financial record mode',{exact:true}).selectOption('TEST');await ap.getByRole('button',{name:'Load analytics',exact:true}).click();await expect(ap.locator('[data-analytics-metric="ALL"]')).toContainText('1');
  expect((await page.request.post('/api/leads/'+leads[0]+'/assignment',{headers,data:{version:2,agentId:null,reason:'Revoke prior owner scope'}})).status()).toBe(200);
  await ap.getByRole('button',{name:'Refresh analytics',exact:true}).first().click();await expect(ap.locator('[data-analytics-metric="ALL"]')).toContainText('0');await expect(ap.locator('[data-analytics-revenue] tbody tr')).toHaveCount(0);
  const read=(await(await agent.request.get('/api/analytics/leads?q='+leads[0]+'&paymentMode=TEST')).json()).items;expect(read).toHaveLength(0);
  await form.getByLabel('Campaign',{exact:true}).selectOption(campaigns[0]!);await form.getByLabel('Financial record mode',{exact:true}).selectOption('TEST');await form.getByRole('button',{name:'Load analytics',exact:true}).click();
  await page.getByRole('combobox',{name:'Language'}).selectOption('fr');await panel.getByRole('button',{name:'Charger les analyses',exact:true}).click();await expect(panel.getByRole('heading',{name:'Analyses',exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Language'}).selectOption('ar');await page.setViewportSize({width:390,height:844});await panel.getByRole('button',{name:'تحميل التحليلات',exact:true}).click();await expect(panel.locator('[data-analytics-revenue] tbody tr')).toHaveCount(2);await panel.screenshot({path:'.local/e2e/analytics-ar.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.getByRole('combobox',{name:'Language'}).selectOption('en');await panel.getByRole('button',{name:'Load analytics',exact:true}).click();await expect(panel.locator('[data-analytics-report]')).toBeVisible();
  await page.route('**/api/analytics/overview?*',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'ACCESS_REVOKED'})}));await panel.getByRole('button',{name:'Refresh analytics',exact:true}).first().click();await expect(panel.getByRole('alert')).toBeVisible();await expect(panel.locator('[data-analytics-report]')).toHaveCount(0);await expect(drill).toHaveCount(0);
  expect(errors).toEqual([]);expect(await page.evaluate(()=>Boolean((window as unknown as {analyticsXss?:unknown}).analyticsXss))).toBe(false);
 }finally{await mc.close();await ac.close();}
});
