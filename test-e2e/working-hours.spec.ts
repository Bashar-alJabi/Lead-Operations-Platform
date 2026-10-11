import { test,expect,type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
test('Working hours are configured in-platform with scoped history, routing availability and safe localized rendering',async({browser})=>{
  const fixture=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string},origin='http://127.0.0.1:4100';
  const managerContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),agentContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),adminContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  const page=await managerContext.newPage(),agent=await agentContext.newPage(),admin=await adminContext.newPage(),errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/same key|unique.*key/i.test(m.text()))errors.push(m.text());});
  const login=async(p:Page,name:string)=>{await p.goto('/');await p.getByRole('combobox',{name:'Language'}).selectOption('en');await p.getByLabel('Email',{exact:true}).fill(name+'@browser.test');await p.getByLabel('Password',{exact:true}).fill(fixture.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await expect(p.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();};
  try{
    await login(page,'manager');await login(agent,'agent');await login(admin,'admin');
    const me=await(await page.request.get('/api/auth/me')).json(),a=await(await agent.request.get('/api/auth/me')).json(),root='/api/users/'+a.id+'/working-hours';
    expect((await agent.request.put(root,{headers:{origin},data:{version:0,hours:{},reason:'Agent cannot manage hours'}})).status()).toBe(403);
    const prior=await(await page.request.get(root)).json();
    await page.getByRole('button',{name:'Users',exact:true}).click();const editor=page.locator('[data-working-hours="'+a.id+'"]');
    await page.locator('[data-hours-open="'+a.id+'"]').click();await editor.getByLabel('No weekly hours restriction',{exact:true}).uncheck();
    const reason='Closed hours <img src=x onerror="window.__hoursXss=true">';await editor.getByLabel('Working hours change reason',{exact:true}).fill(reason);await editor.getByRole('button',{name:'Save working hours',exact:true}).click();
    await expect(editor.getByLabel('Working hours change reason',{exact:true})).toHaveValue('');expect((await(await page.request.get(root)).json()).version).toBe(prior.version+1);
    expect((await page.request.put(root,{headers:{origin},data:{version:prior.version,hours:{},reason:'Stale hours save'}})).status()).toBe(409);
    await editor.getByRole('button',{name:'Working hours history',exact:true}).click();await expect(editor).toContainText(reason);expect(await editor.locator('img').count()).toBe(0);expect(await page.evaluate(()=>Object.hasOwn(window,'__hoursXss'))).toBe(false);
    const c=await page.request.post('/api/campaigns',{headers:{origin},data:{name:'Working hours routing '+randomUUID(),branchId:me.branchId,routingMethod:'ROUND_ROBIN'}});expect(c.status()).toBe(201);const campaign=(await c.json()).id;
    expect((await page.request.put('/api/campaigns/'+campaign+'/agents',{headers:{origin},data:{agentId:a.id}})).status()).toBe(200);expect((await page.request.post('/api/campaigns/'+campaign+'/activate',{headers:{origin}})).status()).toBe(200);
    const lead=await page.request.post('/api/leads',{headers:{origin},data:{branchId:me.branchId,campaignId:campaign,contact:{name:'Outside availability synthetic',email:randomUUID()+'@browser.test'}}});expect(lead.status()).toBe(201);
    const blocked=(await(await page.request.get('/api/leads/'+(await lead.json()).id)).json()).lead;expect(blocked.assigned_agent_id).toBeNull();expect(blocked.needs_attention_reason).toBe('NO_ELIGIBLE_AGENT');
    await editor.getByLabel('No weekly hours restriction',{exact:true}).check();await editor.getByLabel('Working hours change reason',{exact:true}).fill('Resume unrestricted routing availability');await editor.getByRole('button',{name:'Save working hours',exact:true}).click();await expect(editor.getByLabel('Working hours change reason',{exact:true})).toHaveValue('');
    const next=await page.request.post('/api/leads',{headers:{origin},data:{branchId:me.branchId,campaignId:campaign,contact:{name:'Available synthetic',email:randomUUID()+'@browser.test'}}});expect(next.status()).toBe(201);expect((await(await page.request.get('/api/leads/'+(await next.json()).id)).json()).lead.assigned_agent_id).toBe(a.id);
    await page.route('**'+root,route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'WORKING_HOURS_ACCESS_REVOKED'})}));await editor.getByRole('button',{name:'Configure working hours',exact:true}).click();await expect(editor.getByRole('alert')).toBeVisible();await expect(editor.getByLabel('No weekly hours restriction',{exact:true})).toHaveCount(0);await page.unroute('**'+root);
    await page.getByRole('combobox',{name:'Language'}).selectOption('fr');await editor.getByRole('button',{name:'Configurer les horaires',exact:true}).click();await expect(editor).toContainText('fuseau');
    await page.getByRole('combobox',{name:'Language'}).selectOption('ar');await page.setViewportSize({width:390,height:844});await editor.getByRole('button',{name:'إعداد ساعات العمل',exact:true}).click();await expect(editor).toContainText('المنطقة الزمنية');await editor.screenshot({path:'.local/e2e/working-hours-ar.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    const made=await admin.request.post('/api/branches',{headers:{origin},data:{name:'Hours isolated '+randomUUID(),timezone:'Europe/Paris'}});expect(made.status()).toBe(201);const branch=(await made.json()).id,broot='/api/branches/'+branch+'/working-hours';
    expect((await page.request.get(broot)).status()).toBe(404);await admin.reload();await admin.getByRole('button',{name:'Branches',exact:true}).click();await admin.locator('[data-hours-open="'+branch+'"] ').click();const b=admin.locator('[data-working-hours="'+branch+'"]');await b.getByLabel('No weekly hours restriction',{exact:true}).uncheck();
    const monday=b.getByRole('group',{name:'Monday',exact:true});await monday.getByRole('button',{name:'Add period',exact:true}).click();await b.getByLabel('Monday End (24:00 allowed) 1',{exact:true}).fill('24:00');await b.getByLabel('Working hours change reason',{exact:true}).fill('Scoped overnight boundary setup');await b.getByRole('button',{name:'Save working hours',exact:true}).click();await expect(b.getByLabel('Working hours change reason',{exact:true})).toHaveValue('');expect((await(await admin.request.get(broot)).json()).hours.mon).toEqual([['09:00','24:00']]);
    expect(errors).toEqual([]);
  }finally{await managerContext.close();await agentContext.close();await adminContext.close();}
});
