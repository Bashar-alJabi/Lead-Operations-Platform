import {expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {emptyKnowledge} from '../src/ai/knowledge.js';
import {emptyAIOperationalConfig} from '../src/ai/operational-config.js';
import {emptyAIBehaviorPolicy} from '../src/ai/behavior-policy.js';
type InitialContactFixture={
 campaignName:string;templateName:string;phone:string;customerName:string;followupEnabled:boolean;
 messagingConnectionName?:string;
 prepareCampaign?:(campaignId:string,branchId:string)=>Promise<void>;
};

export async function configureInitialContact(page:Page, fixture:InitialContactFixture){
 const f=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string},origin='http://127.0.0.1:4100',headers={origin},fixtureHeaders={origin,authorization:'Bearer '+f.testToken};
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.context().setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
 await page.goto('/');await page.getByRole('combobox',{name:'Language'}).selectOption('en');await page.getByLabel('Email',{exact:true}).fill('manager@browser.test');await page.getByLabel('Password',{exact:true}).fill(f.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 const me=await(await page.request.get('/api/auth/me')).json(),cr=await page.request.post('/api/campaigns',{headers,data:{branchId:me.branchId,name:fixture.campaignName,routingMethod:'MANUAL'}});expect(cr.status()).toBe(201);const cid=(await cr.json()).id;
 const connections=(await(await page.request.get('/api/messaging/connections',{params:{limit:100}})).json()).items;
 const connectionName=fixture.messagingConnectionName??'Browser Connection';
 const mc=connections.find((item:{provider:string;name:string})=>item.provider==='META_WHATSAPP_CLOUD'&&item.name===connectionName);
 expect(mc?.status).toBe('CONNECTED');
 if(fixture.messagingConnectionName){
  const senders=await page.request.get('/api/messaging/connections/'+mc.id+'/senders');
  expect(senders.ok(),await senders.text()).toBeTruthy();
  const {items}=await senders.json();
  expect(items).toHaveLength(1);
  const bound=await page.request.put('/api/messaging/campaigns/'+cid+'/sender-override',{headers,data:{version:1,senderId:items[0].id}});
  expect(bound.ok(),await bound.text()).toBeTruthy();
 }
 expect((await page.request.post('/api/campaigns/'+cid+'/activate',{headers})).status()).toBe(200);
 const kr='/api/ai/campaigns/'+cid+'/knowledge',knowledge={...emptyKnowledge(),sections:{...emptyKnowledge().sections,prices:'Approved first contact price 100 EUR'}};
 expect((await page.request.put(kr+'/draft',{headers,data:{version:0,content:knowledge,reason:'Synthetic campaign knowledge'}})).status()).toBe(200);expect((await page.request.post(kr+'/publish',{headers,data:{version:1,requestId:randomUUID(),reason:'Publish approved campaign knowledge'}})).status()).toBe(201);
 const ac=await page.request.post('/api/ai/connections',{headers,data:{name:fixture.campaignName+' AI',branchId:me.branchId,provider:'OPENAI',credential:'BrowserSyntheticAI_InitialFlow123',reason:'Synthetic fixture'}});expect(ac.status()).toBe(201);const aid=(await ac.json()).id;expect((await page.request.post('/api/ai/connections/'+aid+'/test',{headers,data:{version:1}})).status()).toBe(200);
 const pr=await page.request.post('/api/ai/profiles',{headers,data:{connectionId:aid,name:'Conversation first contact',task:'CONVERSATION',modelId:'Browser-synthetic-model-a',maxOutputTokens:1024,active:true,reason:'Synthetic profile'}});expect(pr.status()).toBe(201);
 expect((await page.request.put('/api/ai/campaigns/'+cid+'/configuration',{headers,data:{version:0,definition:{...emptyAIOperationalConfig(),profiles:{...emptyAIOperationalConfig().profiles,CONVERSATION:(await pr.json()).id},language:{supported:['en'],preferred:'en',detect:true}},reason:'Initial contact config'}})).status()).toBe(200);
 const disclosure='I am the campaign AI assistant';expect((await page.request.put('/api/ai/campaigns/'+cid+'/behavior-policy',{headers,data:{version:0,definition:{...emptyAIBehaviorPolicy(),disclosure:{mode:'FIRST_AI_MESSAGE',text:disclosure},handoff:{initialContactWithoutAgent:true,transitionMessage:null,misunderstandingLimit:null}},reason:'Explicit Manager attention fallback'}})).status()).toBe(200);
 expect((await page.request.put('/api/ai/campaigns/'+cid+'/tool-policy',{headers,data:{version:0,definition:{allowedTools:['sendConversationMessage','requestHumanHandoff']},reason:'Approved initial contact tools'}})).status()).toBe(200);
 const tr=await page.request.post('/api/messaging/connections/'+mc.id+'/templates',{headers,data:{idempotencyKey:randomUUID(),name:fixture.templateName,language:'en_US',category:'UTILITY',body:disclosure+'. Welcome to this campaign. {{1}}',examples:['Approved campaign price']}});expect(tr.status(),await tr.text()).toBe(201);
 expect((await page.request.post('/__test__/control',{headers:fixtureHeaders,data:{approveTemplates:true}})).status()).toBe(200);expect((await page.request.post('/api/messaging/connections/'+mc.id+'/templates/sync',{headers,data:{}})).status()).toBe(200);
 const tpl=(await(await page.request.get('/api/messaging/campaigns/'+cid+'/templates')).json()).items.find((x:{name:string})=>x.name===fixture.templateName);expect(tpl).toBeTruthy();expect((await page.request.put('/api/messaging/campaigns/'+cid+'/templates/'+tpl.id,{headers,data:{version:tpl.version,bound:true}})).status()).toBe(200);
 await page.getByRole('button',{name:'Campaigns',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('row').filter({hasText:fixture.campaignName}).getByRole('button',{name:'Details',exact:true}).click();
 const setup=page.locator('[data-ai-initial-setup]');await setup.getByRole('button',{name:'Review first message setup',exact:true}).click();await setup.getByRole('combobox',{name:'Approved campaign template',exact:true}).selectOption(tpl.id);await setup.getByLabel('Body parameter values (one per line)',{exact:true}).fill('Approved first contact price 100 EUR');await setup.getByLabel('Content approval reason',{exact:true}).fill('Approve exact campaign-specific first message');await setup.getByRole('button',{name:'Approve first message',exact:true}).click();await expect(setup).toContainText('Template and published knowledge match');await expect(setup).toContainText('Approved first contact price 100 EUR');
 const followup=page.locator('[data-ai-followup-message]');
 await followup.getByRole('button',{name:'Review follow-up message setup',exact:true}).click();
 await followup.getByRole('combobox',{name:'Approved campaign template',exact:true}).selectOption(tpl.id);
 await followup.getByLabel('Body parameter values (one per line)',{exact:true}).fill('Approved synthetic follow-up');
 await followup.getByLabel('Content approval reason',{exact:true}).fill('Independent follow-up approval');
 await followup.getByRole('button',{name:'Approve follow-up message',exact:true}).click();
 await expect(followup).toContainText('Approved synthetic follow-up');
 await expect(followup.getByRole('list')).toContainText('Independent follow-up approval');
 await expect(setup).toContainText('Approved first contact price 100 EUR');
 expect((await page.request.put('/api/ai/campaigns/'+cid+'/followup-policy',{headers,data:{version:0,definition:{enabled:fixture.followupEnabled,
  initialDelaySeconds:0,delaysSeconds:[1],stopOnReply:true,finalAction:'COMPLETE'},reason:'Synthetic scheduled follow-up'}})).status()).toBe(200);
 const create=async()=>{const r=await page.request.post('/api/leads',{headers,data:{branchId:me.branchId,campaignId:cid,contact:{name:fixture.customerName,phone:fixture.phone}}});expect(r.status(),await r.text()).toBe(201);return(await r.json()).id as string;};
 const old=await create(),consentPath='/api/leads/'+old+'/messaging-consent',v=(await(await page.request.get(consentPath)).json()).version;
 expect((await page.request.put(consentPath,{headers,data:{version:v,status:'GRANTED',doNotContact:false,evidence:'Authorized synthetic prior opt-in',source:'Dedicated synthetic record'}})).status()).toBe(200);
 await page.getByRole('button',{name:'Deactivate',exact:true}).click();
 await page.getByLabel('Enable customer messaging',{exact:true}).check();await page.getByLabel('Enable AI assistant',{exact:true}).check();
 const updated=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname===`/api/campaigns/${cid}`);
 await page.getByRole('button',{name:'Save settings',exact:true}).first().click();
 const saved=await updated;expect(saved.ok(),await saved.text()).toBeTruthy();
 if(fixture.prepareCampaign){
  await fixture.prepareCampaign(cid,me.branchId);
  const active=await page.request.post(`/api/campaigns/${cid}/activate`,{headers});
  expect(active.ok(),await active.text()).toBeTruthy();
 }else{
  await page.getByRole('button',{name:'Activate',exact:true}).click();
  await expect(page.getByRole('button',{name:'Deactivate',exact:true})).toBeVisible();
 }
 return {cid,headers,fixtureHeaders,create,old,errors};
}
