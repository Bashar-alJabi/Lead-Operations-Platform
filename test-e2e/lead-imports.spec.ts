import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import * as XLSX from 'xlsx';
test('Private CSV/Excel inspection has real durable worker, lost upload ACK replay, paged safe localized preview, failure recovery and current-scope denial without intake writes',async({browser})=>{
 test.setTimeout(90000);
 const f=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string},headers={origin:'http://127.0.0.1:4100'};
 const mc=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),ac=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}),page=await mc.newPage(),agent=await ac.newPage(),errors:string[]=[];
 for(const p of [page,agent]){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/same key|unique.*key/i.test(m.text()))errors.push(m.text());});}
 async function login(p:Page,name:string){await p.goto('/');await p.getByRole('combobox',{name:'Language'}).selectOption('en');await p.getByLabel('Email',{exact:true}).fill(name+'@browser.test');await p.getByLabel('Password',{exact:true}).fill(f.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await expect(p.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();}
 const work=(data:object={})=>page.request.post('/__test__/import-files',{headers:{...headers,authorization:'Bearer '+f.testToken},data});
 try{
  await login(page,'manager');await login(agent,'agent');const me=await(await page.request.get('/api/auth/me')).json();
  const c=await page.request.post('/api/campaigns',{headers,data:{branchId:me.branchId,name:'Import inspection target',routingMethod:'MANUAL'}});expect(c.status()).toBe(201);const campaign=(await c.json()).id;
  await page.getByRole('button',{name:'Leads',exact:true}).click();await page.reload();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  const panel=page.locator('[data-import-workspace]');await expect(panel).toHaveCount(1);await expect(agent.locator('[data-import-workspace]')).toHaveCount(0);
  const choices=panel.getByRole('combobox',{name:'Import campaign',exact:true});await expect(choices.locator('option')).not.toHaveCount(1);
  while(!await choices.locator('option[value="'+campaign+'"]').count()){
   const previous=await choices.locator('option').nth(1).getAttribute('value');await panel.locator('[data-import-campaign-choices]').getByRole('button',{name:'More choices',exact:true}).click();
   await expect.poll(()=>choices.locator('option').nth(1).getAttribute('value')).not.toBe(previous);
  }await choices.selectOption(campaign);
  const text='name,phone\r\n'+Array.from({length:60},(_,i)=>'"'+(i===0?'<img src=x onerror=window.importXss=1>':'Synthetic '+i)+'",001'+i).join('\r\n');
  await panel.getByLabel('Import file',{exact:true}).setInputFiles({name:'inspection.csv',mimeType:'text/csv',buffer:Buffer.from(text)});
  let job='',first=true;const keys:string[]=[];
  await page.route('**/api/lead-imports?*',async route=>{if(route.request().method()!=='POST')return route.continue();keys.push(new URL(route.request().url()).searchParams.get('requestId')!);if(first){first=false;const r=await route.fetch();expect(r.status()).toBe(202);job=(await r.json()).id;await route.abort('failed');}else await route.continue();});
  await panel.getByRole('button',{name:'Upload for inspection',exact:true}).click();await expect(panel.getByRole('alert')).toBeVisible();await page.getByRole('combobox',{name:'Language'}).selectOption('fr');
  await panel.getByRole('button',{name:'Réessayer le même chargement',exact:true}).click();await expect(panel.locator('[data-import-detail]')).toContainText(job);expect(new Set(keys).size).toBe(1);
  for(let i=0;i<5;i++)expect((await work({unavailable:true})).status()).toBe(200);
  await page.getByRole('combobox',{name:'Language'}).selectOption('en');await panel.getByRole('button',{name:'Refresh file status',exact:true}).click();await expect(panel.locator('[data-import-detail]')).toContainText('DEAD_LETTER');
  const recovery=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/lead-imports/'+job+'/retry'));await panel.getByRole('button',{name:'Retry failed inspection',exact:true}).click();expect((await recovery).status()).toBe(200);
  expect((await work()).status()).toBe(200);await panel.getByRole('button',{name:'Refresh file status',exact:true}).click();await expect(panel.locator('[data-import-preview] tbody tr')).toHaveCount(25);await expect(panel.locator('[data-import-preview]')).toContainText('<img src=x onerror=window.importXss=1>');expect(await panel.locator('img').count()).toBe(0);
  await panel.getByRole('button',{name:'Next rows',exact:true}).click();await expect(panel.locator('[data-import-preview]')).toContainText('Synthetic 25');await panel.getByRole('button',{name:'Next rows',exact:true}).click();await expect(panel.locator('[data-import-preview] tbody tr')).toHaveCount(10);
  await page.getByRole('combobox',{name:'Language'}).selectOption('ar');await page.setViewportSize({width:390,height:844});await expect(panel.getByRole('heading',{name:'فحص ملف الاستيراد',exact:true})).toBeVisible();
  await panel.screenshot({path:'.local/e2e/lead-imports-ar.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await page.evaluate(()=>Boolean((window as unknown as {importXss?:unknown}).importXss))).toBe(false);
  expect((await agent.request.get('/api/lead-imports/'+job+'/rows?sheet=0')).status()).toBe(404);
  await page.getByRole('combobox',{name:'Language'}).selectOption('en');const cancel=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/lead-imports/'+job+'/cancel'));page.once('dialog',d=>d.accept());await panel.getByRole('button',{name:'Delete private file',exact:true}).click();expect((await cancel).status()).toBe(200);await expect(panel.locator('[data-import-preview]')).toHaveCount(0);expect((await page.request.get('/api/lead-imports/'+job+'/rows?sheet=0')).status()).toBe(410);await work();
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['name'],['Excel one']]),'One');XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['phone'],['001234']]),'Two');
  await panel.getByLabel('Import file',{exact:true}).setInputFiles({name:'inspection.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true}) as Buffer});
  await panel.getByRole('button',{name:'Upload for inspection',exact:true}).click();await expect(panel.locator('[data-import-detail]')).toContainText('WAITING');await work();await panel.getByRole('button',{name:'Refresh file status',exact:true}).click();await expect(panel.locator('[data-import-preview]')).toContainText('Excel one');await panel.getByRole('combobox',{name:'Worksheet',exact:true}).selectOption('1');await expect(panel.locator('[data-import-preview]')).toContainText('001234');
  await page.route('**/api/lead-imports/*/rows?*',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'ACCESS_REVOKED'})}));await panel.getByRole('button',{name:'First rows',exact:true}).click();await expect(panel.getByRole('alert')).toBeVisible();await expect(panel.locator('[data-import-detail]')).toHaveCount(0);await expect(panel.locator('[data-import-preview]')).toHaveCount(0);
  expect(errors).toEqual([]);
 }finally{await mc.close();await ac.close();}
});
