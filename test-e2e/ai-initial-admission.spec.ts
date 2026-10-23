import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyKnowledge } from '../src/ai/knowledge.js';
import { emptyAIOperationalConfig } from '../src/ai/operational-config.js';
import { emptyAIBehaviorPolicy } from '../src/ai/behavior-policy.js';

test('Initial AI admission retains blocked and admitted intake history, real scope denial and localized safe UI without fabricating a conversation or send', async ({ browser }) => {
  const f=JSON.parse(await readFile(resolve('.local/e2e/fixture.json'),'utf8')) as {password:string;testToken:string}, origin='http://127.0.0.1:4100', headers={origin};
  const context=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}}), secondContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  const page=await context.newPage(),second=await secondContext.newPage(),errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/same key|unique.*key/i.test(m.text()))errors.push(m.text());});
  const login=async(p:Page,user:string)=>{await p.goto('/');await p.getByRole('combobox',{name:'Language'}).selectOption('en');await p.getByLabel('Email',{exact:true}).fill(user+'@browser.test');await p.getByLabel('Password',{exact:true}).fill(f.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await expect(p.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();};
  try {
    await login(page,'manager');await login(second,'second');const me=await(await page.request.get('/api/auth/me')).json();
    const made=await page.request.post('/api/campaigns',{headers,data:{name:'Browser initial admission',branchId:me.branchId,routingMethod:'MANUAL'}});expect(made.status()).toBe(201);const campaign=(await made.json()).id;
    expect((await page.request.post('/api/campaigns/'+campaign+'/activate',{headers})).status()).toBe(200);
    expect((await page.request.post('/__test__/ai-initial-intake',{headers,data:{campaignId:campaign,enabled:true}})).status()).toBe(403);
    expect((await page.request.post('/__test__/ai-initial-intake',{headers:{...headers,authorization:'Bearer '+f.testToken},data:{campaignId:campaign,enabled:true}})).status()).toBe(200);
    const create=async(name:string,phone:string)=>{const r=await page.request.post('/api/leads',{headers,data:{branchId:me.branchId,campaignId:campaign,contact:{name,phone}}});expect(r.status(),await r.text()).toBe(201);return(await r.json()).id;};
    const blockedName='Browser initial blocked',blocked=await create(blockedName,'+15556667810');
    const blockedRecord=(await(await page.request.get('/api/leads/'+blocked+'/intake-origin')).json()).origin.initialAI;expect(blockedRecord.state).toBe('BLOCKED');
    await page.reload();await page.getByRole('row').filter({hasText:blockedName}).getByRole('button',{name:'Details',exact:true}).click();
    let panel=page.locator('[data-lead-intake-origin]');await panel.getByRole('button',{name:'Review intake origin',exact:true}).click();await expect(panel.locator('[data-initial-ai-admission]')).toContainText('Initial admission blocked');await expect(panel).toContainText('AI_PUBLISHED_KNOWLEDGE_REQUIRED');
    const kr='/api/ai/campaigns/'+campaign+'/knowledge';
    const content={...emptyKnowledge(),sections:{...emptyKnowledge().sections,prices:'Private approved initial knowledge <img src=x onerror="window.__initialXss=1">'}};
    expect((await page.request.put(kr+'/draft',{headers,data:{version:0,content,reason:'Synthetic published source'}})).status()).toBe(200);
    expect((await page.request.post(kr+'/publish',{headers,data:{version:1,requestId:randomUUID(),reason:'Approve synthetic publication'}})).status()).toBe(201);
    const connection=await page.request.post('/api/ai/connections',{headers,data:{name:'Browser initial AI',branchId:me.branchId,provider:'OPENAI',credential:'BrowserSyntheticAI_Initial123456',reason:'Synthetic fixture'}});expect(connection.status()).toBe(201);const cid=(await connection.json()).id;
    const probe=await page.request.post('/api/ai/connections/'+cid+'/test',{headers,data:{version:1}});expect(probe.status()).toBe(200);expect((await probe.json()).state).toBe('VERIFIED');
    const profile=await page.request.post('/api/ai/profiles',{headers,data:{connectionId:cid,name:'Initial conversation',task:'CONVERSATION',modelId:'Browser-synthetic-model-a',maxOutputTokens:1024,active:true,reason:'Synthetic profile'}});expect(profile.status()).toBe(201);
    expect((await page.request.put('/api/ai/campaigns/'+campaign+'/configuration',{headers,data:{version:0,definition:{...emptyAIOperationalConfig(),profiles:{...emptyAIOperationalConfig().profiles,CONVERSATION:(await profile.json()).id},language:{supported:['en'],preferred:'en',detect:true}},reason:'Isolated initial configuration'}})).status()).toBe(200);
    expect((await page.request.put('/api/ai/campaigns/'+campaign+'/behavior-policy',{headers,data:{version:0,definition:{...emptyAIBehaviorPolicy(),disclosure:{mode:'FIRST_AI_MESSAGE',text:'Approved synthetic AI identity'},handoff:{initialContactWithoutAgent:true,transitionMessage:null,misunderstandingLimit:null}},reason:'Explicit unassigned attention fallback'}})).status()).toBe(200);
    expect((await page.request.put('/api/ai/campaigns/'+campaign+'/tool-policy',{headers,data:{version:0,definition:{allowedTools:['sendConversationMessage']},reason:'Explicit original send grant'}})).status()).toBe(200);
    await panel.getByRole('button',{name:'Review intake origin',exact:true}).click();await expect(panel).toContainText('Initial admission blocked'); // no revival of old blocked source.
    const name='Browser admitted <img src=x onerror="window.__initialXss=1">',lead=await create(name,'+15556667811'),root='/api/leads/'+lead+'/intake-origin';
    const originDto=(await(await page.request.get(root)).json()).origin,dto=originDto.initialAI;expect(dto.state).toBe('ADMITTED');expect(dto.runtimeStarted).toBe(false);expect(dto.sendAuthorized).toBe(false);expect(dto.knowledgeVersion).toBe(1);expect(dto.ownerAvailable).toBe(false);
    expect((await second.request.get(root)).status()).toBe(404);
    await page.reload();await page.getByRole('row').filter({hasText:name}).getByRole('button',{name:'Details',exact:true}).click();panel=page.locator('[data-lead-intake-origin]');await panel.getByRole('button',{name:'Review intake origin',exact:true}).click();
    const assessment=panel.locator('[data-initial-ai-admission]');await expect(assessment).toContainText('Initial configuration admitted');await expect(assessment).toContainText('have not started');await expect(assessment).toContainText('branch manager attention');
    expect(await panel.locator('img').count()).toBe(0);expect(await page.evaluate(()=>Object.hasOwn(window,'__initialXss'))).toBe(false);
    expect(await panel.textContent()).not.toContain('Private approved initial knowledge');
    await page.getByRole('combobox',{name:'Language'}).selectOption('fr');await expect(assessment).toContainText('Configuration initiale admise');
    await page.getByRole('combobox',{name:'Language'}).selectOption('ar');await page.setViewportSize({width:390,height:844});await expect(assessment).toContainText('استوفت إعدادات القبول الأولي');await expect(assessment).toContainText('لم يبدأ التشغيل');
    await panel.screenshot({path:'.local/e2e/ai-initial-admission-ar.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect((await(await page.request.get('/api/leads/'+lead+'/conversations')).json()).items).toEqual([]);
    await page.getByRole('combobox',{name:'Language'}).selectOption('en');
    // UI-only failure DTO, independent from the actual DB contention integration scenario.
    await page.route('**/api/leads/*/intake-origin',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({origin:{...originDto,initialAI:{...dto,state:'BLOCKED',blockers:['AI_INITIAL_DEPENDENCY_BUSY'],ownerAvailable:null,initialContactWithoutAgent:null,senderReason:null,knowledgeVersion:null}}})}));
    await panel.getByRole('button',{name:'Review intake origin',exact:true}).click();await expect(assessment).toContainText('Not assessed');await expect(assessment).toContainText('configuration is being updated or busy');await expect(assessment).not.toContainText('branch manager attention');
    await page.unroute('**/api/leads/*/intake-origin');await page.route('**/api/leads/*/intake-origin',r=>r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'LEAD_INTAKE_ACCESS_REVOKED'})}));
    await panel.getByRole('button',{name:'Review intake origin',exact:true}).click();await expect(panel.getByRole('alert')).toBeVisible();await expect(panel.locator('[data-initial-ai-admission]')).toHaveCount(0);expect(errors).toEqual([]);
  } finally {await context.close();await secondContext.close();}
});
