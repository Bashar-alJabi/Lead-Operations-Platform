import { test, expect, type Page,type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHmac,randomUUID } from 'node:crypto';
import { testPayPalHeaders,testPayPalEvent } from '../test/paypal-test-support.js';
type Fixture = { password:string;testToken:string;leadId:string;conversationId:string;untrusted:string;mediaLeadId:string;mediaConversationId:string;sourceCampaignId:string;noContactLeadId:string };
let fixture:Fixture;
let agentStorageState:Awaited<ReturnType<BrowserContext['storageState']>>|undefined;
let managerStorageState:Awaited<ReturnType<BrowserContext['storageState']>>|undefined;
let adminStorageState:Awaited<ReturnType<BrowserContext['storageState']>>|undefined;
test.describe.configure({ mode:'serial' });
test.beforeAll(async()=> { fixture=JSON.parse(await readFile(resolve('.local/e2e/fixture.json'),'utf8')); });

async function login(page:Page,name='agent') {
  await page.goto('/'); await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
  await page.getByLabel('Email',{ exact:true }).fill(name+'@browser.test');
  await page.getByLabel('Password',{ exact:true }).fill(fixture.password);
  await page.getByRole('button',{ name:'Sign in',exact:true }).click();
  await expect(page.getByRole('button',{ name:'Sign out',exact:true })).toBeVisible();
}
async function openLead(page:Page) {
  await page.getByRole('row').filter({ hasText:'Browser Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
  const panel=page.getByRole('heading',{ name:'Customer conversations',exact:true }).locator('..');
  await panel.getByRole('button',{ name:'View messages',exact:true }).click(); return panel;
}
async function control(page:Page,body:object={}) {
  const response=await page.request.post('/__test__/control',{ data:body,
    headers:{ origin:'http://127.0.0.1:4100',authorization:'Bearer '+fixture.testToken } });
  expect(response.ok()).toBeTruthy(); return response.json();
}
test('real browser composes, recovers a confirmed failure, shows history and enforces control, DNC, unknown and assignment access',async({ page,browser })=> {
  const browserErrors:string[]=[]; page.on('pageerror',(error)=>browserErrors.push(error.message));
  await login(page);
  const unnamed=page.getByRole('row').filter({ hasText:'Contact unavailable' });await expect(unnamed).toBeVisible();await unnamed.getByRole('button',{ name:'Details',exact:true }).click();
  await expect(page.getByRole('heading',{ name:'Contact unavailable',exact:true })).toBeVisible();await expect(page.getByText('Contact data is required to manage consent.',{ exact:true })).toBeVisible();
  await expect(page.locator('.facts')).toContainText('Browser agent');
  const noContactDenied=await page.request.post(`/api/leads/${fixture.noContactLeadId}/conversations`,{ headers:{ origin:'http://127.0.0.1:4100' } });expect(noContactDenied.status()).toBe(409);expect((await noContactDenied.json()).error).toBe('CONTACT_PHONE_REQUIRED');
  await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await expect(page.getByRole('heading',{ name:'بيانات جهة الاتصال غير متوفرة',exact:true })).toBeVisible();
  await page.setViewportSize({ width:390,height:844 });await page.screenshot({ path:'.local/e2e/optional-contact-ar.png' });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.setViewportSize({ width:1280,height:900 });await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.getByRole('button',{ name:'Back',exact:true }).click();
  let panel=await openLead(page);
  await expect(panel.getByText(fixture.untrusted,{ exact:true })).toBeVisible();
  expect(await page.evaluate(()=>Object.hasOwn(window,'__customerXss'))).toBe(false);
  await expect(panel.locator('img')).toHaveCount(0);
  const body='Browser saved customer reply';
  await panel.getByLabel('Message text',{ exact:true }).fill(body);
  await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
  const message=()=>panel.locator('li').filter({ has:page.getByText(body,{ exact:true }) });
  await expect(message()).toContainText('QUEUED');
  const failed=await control(page,{ process:true,mode:'reject' });
  expect(failed.providerCalls).toBe(1); expect(failed.messages).toHaveLength(1);
  await panel.getByRole('button',{ name:'View messages',exact:true }).click();
  await message().getByRole('button',{ name:'Send details and attempts',exact:true }).click();
  await expect(message()).toContainText('REJECTED');
  await expect(message().getByRole('button',{ name:'Requeue the saved message',exact:true })).toBeDisabled();
  await message().getByLabel('Reason after fixing the failure',{ exact:true }).fill('Browser confirmed failure fixed');
  await message().getByLabel('I fixed the failure and want to send the same saved content',{ exact:true }).check();
  await message().getByRole('button',{ name:'Requeue the saved message',exact:true }).click();
  await expect(message()).toContainText('QUEUED');
  const accepted=await control(page,{ process:true,mode:'accept' });
  expect(accepted.providerCalls).toBe(2); expect(accepted.messages).toHaveLength(1); expect(accepted.recoveries).toBe(1);
  await panel.getByRole('button',{ name:'View messages',exact:true }).click();
  await message().getByRole('button',{ name:'Send details and attempts',exact:true }).click();
  await expect(message()).toContainText('ACKNOWLEDGED'); await expect(message()).toContainText('Browser confirmed failure fixed');
  await expect(message().getByRole('button',{ name:'Requeue the saved message',exact:true })).toHaveCount(0);

  // A branch Manager can read the record and must explicitly take over before replying.
  const managerContext=await browser.newContext(); const manager=await managerContext.newPage();
  try {
    await login(manager,'manager'); const managerPanel=await openLead(manager);
    await expect(managerPanel.getByLabel('Message text',{ exact:true })).toHaveCount(0);
    const rejectedResponse=await manager.request.post(`/api/conversations/${fixture.conversationId}/messages`,{
      headers:{ origin:'http://127.0.0.1:4100' },data:{ body:'Manager cannot reply without takeover',idempotencyKey:'browser-denied-controller' } });
    expect(rejectedResponse.status()).toBe(409);
    expect(await rejectedResponse.text()).toContain('HUMAN_CONTROLLER_REQUIRED');
    await managerPanel.getByLabel('Takeover reason',{ exact:true }).fill('Browser explicit human takeover');
    await managerPanel.getByRole('button',{ name:'Take over conversation',exact:true }).click();
    await expect(managerPanel.getByRole('row').filter({ hasText:'Browser Sender' })).toContainText('Browser manager');
    await panel.getByLabel('Message text',{ exact:true }).fill('Old controller cannot reply');
    await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
    await expect(panel.getByRole('alert')).toContainText('HUMAN_CONTROLLER_REQUIRED');
    await expect(panel.getByLabel('Message text',{ exact:true })).toHaveCount(0);
    await panel.getByLabel('Takeover reason',{ exact:true }).fill('Browser agent regains control');
    await panel.getByRole('button',{ name:'Take over conversation',exact:true }).click();
    await expect(panel.getByRole('row').filter({ hasText:'Browser Sender' })).toContainText('Browser agent');
  } finally { await managerContext.close(); }
  await control(page,{ dnc:true });
  await panel.getByLabel('Message text',{ exact:true }).fill('DNC must block this browser reply');
  await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
  await expect(panel.getByRole('alert')).toContainText('DO_NOT_CONTACT');
  expect((await control(page)).providerCalls).toBe(2);
  await control(page,{ dnc:false });
  const unknownBody='Browser uncertain reply';
  await panel.getByLabel('Message text',{ exact:true }).fill(unknownBody);
  await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
  await expect(panel.locator('li').filter({ has:page.getByText(unknownBody,{ exact:true }) })).toContainText('QUEUED');
  await control(page,{ process:true,mode:'unknown' });
  await panel.getByRole('button',{ name:'View messages',exact:true }).click();
  const unknown=panel.locator('li').filter({ has:page.getByText(unknownBody,{ exact:true }) });
  await expect(unknown).toContainText('UNKNOWN');
  await unknown.getByRole('button',{ name:'Send details and attempts',exact:true }).click();
  await expect(unknown.getByRole('button',{ name:'Requeue the saved message',exact:true })).toHaveCount(0);
  const priorId=accepted.messages[0].id;
  await control(page,{ assigned:'second' });
  const denied=await page.request.get(`/api/conversations/${fixture.conversationId}/messages/${priorId}/attempts`);
  expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain('Browser saved customer reply');
  await page.reload(); await expect(page.getByRole('row').filter({ hasText:'Browser Customer' })).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test('Arabic mobile and French layouts display escaped conversation history and unavailable recovery',async({ page })=> {
  await page.setViewportSize({ width:390,height:844 });
  await control(page,{ assigned:'agent' }); await login(page);
  await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');
  await page.getByRole('row').filter({ hasText:'Browser Customer' }).getByRole('button',{ name:'التفاصيل',exact:true }).click();
  let panel=page.getByRole('heading',{ name:'محادثات العميل',exact:true }).locator('..');
  await panel.getByRole('button',{ name:'عرض الرسائل',exact:true }).click();
  await expect(panel.getByText(fixture.untrusted,{ exact:true })).toBeVisible();
  const unknown=panel.locator('li').filter({ has:page.getByText('Browser uncertain reply',{ exact:true }) });
  await unknown.getByRole('button',{ name:'تفاصيل الإرسال والمحاولات',exact:true }).click();
  await expect(unknown.getByRole('button',{ name:'إعادة وضع الرسالة في قائمة الإرسال',exact:true })).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await unknown.scrollIntoViewIfNeeded(); await page.screenshot({ path:'.local/e2e/conversation-ar.png' });
  await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('dir','ltr');
  panel=page.getByRole('heading',{ name:'Conversations client',exact:true }).locator('..');
  await expect(panel.getByText(fixture.untrusted,{ exact:true })).toBeVisible();
  await expect(panel.getByRole('heading',{ name:'Tentatives d’envoi au client',exact:true })).toBeVisible();
  await page.screenshot({ path:'.local/e2e/mobile-fr.png',fullPage:true });
});

test('browser uploads scanned audio/video/stickers, preserves captions and sends through the real queue and worker',async({ page })=> {
  const browserErrors:string[]=[];page.on('pageerror',(error)=>browserErrors.push(error.message));
  await login(page);
  await page.getByRole('row').filter({ hasText:'Browser Media Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
  const panel=page.getByRole('heading',{ name:'Customer conversations',exact:true }).locator('..');
  await panel.getByRole('button',{ name:'View messages',exact:true }).click();
  await panel.getByLabel('Message type',{ exact:true }).selectOption('ATTACHMENT');
  const start=await control(page,{ mode:'accept' });
  for (const [index,[kind,name]] of ([['audio','tone.ogg'],['video','clip.mp4'],['sticker','animated.webp']] as const).entries()) {
    await panel.getByLabel('Attachment type',{ exact:true }).selectOption(kind);
    if (kind==='video') await panel.getByLabel('Optional caption',{ exact:true }).fill('<img src=x> Literal video caption');
    else await expect(panel.getByLabel('Optional caption',{ exact:true })).toHaveCount(0);
    await panel.getByLabel('File',{ exact:true }).setInputFiles(resolve('test-fixtures/media',name));
    await panel.getByRole('button',{ name:'Upload and scan',exact:true }).click();
    await expect(panel.getByRole('button',{ name:'Queue message',exact:true })).toBeEnabled();
    if (index===0) {
      const [preview]=await Promise.all([page.waitForEvent('download'),panel.locator('form')
        .getByRole('button',{ name:'Download scanned file',exact:true }).click()]);
      expect(await readFile((await preview.path())!)).toEqual(await readFile(resolve('test-fixtures/media/tone.ogg')));
      const noSend=await control(page);expect(noSend.providerCalls).toBe(start.providerCalls);
      expect(noSend.messages.filter((m:{ conversation_id:string })=>m.conversation_id===fixture.mediaConversationId)).toHaveLength(0);
      await panel.getByRole('button',{ name:'View messages',exact:true }).click();
      await expect(panel.getByLabel('Attachment type',{ exact:true })).toHaveValue('audio');
      await expect(panel.getByRole('button',{ name:'Queue message',exact:true })).toBeEnabled();
    }
    await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
    await expect(panel.locator('.conversation-messages li').filter({ hasText:kind }).last()).toContainText('QUEUED');
    const sent=await control(page,{ process:true,mode:'accept' });
    expect(sent.mediaUploads).toBe(start.mediaUploads+index+1);expect(sent.providerCalls).toBe(start.providerCalls+index+1);
    const mediaMessages=sent.messages.filter((m:{ conversation_id:string })=>m.conversation_id===fixture.mediaConversationId);
    expect(mediaMessages).toHaveLength(index+1);expect(mediaMessages[index].delivery_state).toBe('SENT');
    expect(mediaMessages[index].body).toBe(kind==='video' ? '<img src=x> Literal video caption' : '');
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();
    await expect(panel.locator('.conversation-messages li').filter({ hasText:kind }).last()).toContainText('SENT');
  }
  await expect(panel.locator('img')).toHaveCount(0);
  // Wrong codec leaves no new attachment/send and exposes a safe failure in the real UI.
  const [download]=await Promise.all([page.waitForEvent('download'),panel.locator('.conversation-messages li')
    .filter({ hasText:'sticker' }).getByRole('button',{ name:'Download scanned file',exact:true }).click()]);
  expect(await readFile((await download.path())!)).toEqual(await readFile(resolve('test-fixtures/media/animated.webp')));
  await panel.getByLabel('Attachment type',{ exact:true }).selectOption('audio');
  await panel.getByLabel('File',{ exact:true }).setInputFiles(resolve('test-fixtures/media/vorbis.ogg'));
  await panel.getByRole('button',{ name:'Upload and scan',exact:true }).click();
  await expect(panel).toContainText('MEDIA_CODEC_NOT_SUPPORTED');
  await expect(panel.getByRole('button',{ name:'Queue message',exact:true })).toBeDisabled();
  const unchanged=await control(page);expect(unchanged.providerCalls).toBe(start.providerCalls+3);
  await page.setViewportSize({ width:390,height:844 });
  await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');
  await page.getByLabel('نوع المرفق',{ exact:true }).selectOption('sticker');
  await expect(page.getByText('هذا النوع لا يدعم تعليقاً. أرسل أي نص برسالة مستقلة.',{ exact:true })).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.getByLabel('نوع المرفق',{ exact:true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path:'.local/e2e/media-ar.png' });expect(browserErrors).toEqual([]);
});

test('Manager creates and binds an approved composite text template; Agent sends all static parts and body parameters',async({ page,browser })=> {
  const errors:string[]=[];page.on('pageerror',(error)=>errors.push(error.message));
  await login(page,'manager');
  async function openSetup() {
    await page.getByRole('button',{ name:'Messaging setup',exact:true }).click();
    await page.getByRole('row').filter({ hasText:'Browser Media Connection' }).getByRole('button').click();
    return page.getByRole('heading',{ name:'Meta templates',exact:true }).locator('..');
  }
  async function openCampaign() {
    await page.getByRole('button',{ name:'Campaigns',exact:true }).click();
    await page.getByRole('row').filter({ hasText:'Browser Media Campaign' }).getByRole('button',{ name:'Details',exact:true }).click();
    return page.getByRole('heading',{ name:'Campaign templates',exact:true }).locator('..');
  }
  const name='browser_composite_notice';const header='<img src=x> Static header';const footer='Static closing line';
  let setup=await openSetup();
  await setup.getByLabel('TEXT header (optional)',{ exact:true }).fill(header);
  await setup.getByLabel('Static footer (optional)',{ exact:true }).fill(footer);
  await setup.getByLabel('Template name',{ exact:true }).fill(name);
  await setup.getByLabel('BODY text',{ exact:true }).fill('Dear {{1}}, your request is received.');
  await setup.getByLabel('Parameter example 1',{ exact:true }).fill('Approval example only');
  await setup.getByRole('button',{ name:'Submit template',exact:true }).click();
  await expect(setup.getByRole('row').filter({ hasText:name })).toContainText('PENDING');
  const staticName='browser_static_composite';
  await setup.getByLabel('TEXT header (optional)',{ exact:true }).fill('Static test header');
  await setup.getByLabel('Static footer (optional)',{ exact:true }).fill('Static test footer');
  await setup.getByLabel('Template name',{ exact:true }).fill(staticName);
  await setup.getByLabel('BODY text',{ exact:true }).fill('Static test body');
  await setup.getByRole('button',{ name:'Submit template',exact:true }).click();
  await expect(setup.getByRole('row').filter({ hasText:staticName })).toContainText('PENDING');
  const headerName='browser_header_notice';
  await setup.getByLabel('TEXT header (optional)',{ exact:true }).fill('Welcome {{1}}');
  await setup.getByLabel('HEADER parameter example',{ exact:true }).fill('Header approval sample only');
  await setup.getByLabel('Static footer (optional)',{ exact:true }).fill('Header closing line');
  await setup.getByLabel('Template name',{ exact:true }).fill(headerName);
  await setup.getByLabel('BODY text',{ exact:true }).fill('Order {{1}}');
  await setup.getByLabel('Parameter example 1',{ exact:true }).fill('Body approval sample only');
  await setup.getByRole('button',{ name:'Submit template',exact:true }).click();
  await expect(setup.getByRole('row').filter({ hasText:headerName })).toContainText('PENDING');
  const ctaName='browser_cta_notice';
  await setup.getByLabel('TEXT header (optional)',{ exact:true }).fill('CTA greeting');
  await setup.getByLabel('Static footer (optional)',{ exact:true }).fill('CTA closing line');
  await setup.getByLabel('Template name',{ exact:true }).fill(ctaName);
  await setup.getByLabel('BODY text',{ exact:true }).fill('CTA order {{1}}');
  await setup.getByLabel('Parameter example 1',{ exact:true }).fill('CTA approval only');
  await setup.getByLabel('Button type 1',{ exact:true }).selectOption('URL');
  await setup.getByLabel('Button text 1',{ exact:true }).fill('Visit site');
  await setup.getByLabel('Button target 1',{ exact:true }).fill('https://example.test/offer');
  await setup.getByLabel('Button type 2',{ exact:true }).selectOption('PHONE_NUMBER');
  await setup.getByLabel('Button text 2',{ exact:true }).fill('Call us');
  await setup.getByLabel('Button target 2',{ exact:true }).fill('+15550007777');
  await setup.getByRole('button',{ name:'Submit template',exact:true }).click();
  await expect(setup.getByRole('row').filter({ hasText:ctaName })).toContainText('PENDING');
  const urlName='browser_dynamic_url';
  await setup.getByLabel('TEXT header (optional)',{ exact:true }).fill('URL greeting {{1}}');
  await setup.getByLabel('HEADER parameter example',{ exact:true }).fill('Header URL approval only');
  await setup.getByLabel('Static footer (optional)',{ exact:true }).fill('URL closing line');
  await setup.getByLabel('Template name',{ exact:true }).fill(urlName);
  await setup.getByLabel('BODY text',{ exact:true }).fill('URL order {{1}}');
  await setup.getByLabel('Parameter example 1',{ exact:true }).fill('Body URL approval only');
  await setup.getByLabel('Button type 1',{ exact:true }).selectOption('PHONE_NUMBER');
  await setup.getByLabel('Button text 1',{ exact:true }).fill('Call orders');
  await setup.getByLabel('Button target 1',{ exact:true }).fill('+15550007777');
  await setup.getByLabel('Button type 2',{ exact:true }).selectOption('URL');
  await setup.getByLabel('Button text 2',{ exact:true }).fill('Track order');
  await setup.getByLabel('Button target 2',{ exact:true }).fill('https://example.test/orders/{{1}}');
  await setup.getByLabel('URL suffix example',{ exact:true }).fill('URL-APPROVAL-ONLY');
  await setup.getByRole('button',{ name:'Submit template',exact:true }).click();
  await expect(setup.getByRole('row').filter({ hasText:urlName })).toContainText('PENDING');
  let campaign=await openCampaign();
  await expect(campaign.locator('li').filter({ hasText:name }).getByRole('button',{ name:'Allow',exact:true })).toBeDisabled();
  await control(page,{ approveTemplates:true });setup=await openSetup();
  await setup.getByRole('button',{ name:'Sync approvals',exact:true }).click();
  await expect(setup.getByRole('row').filter({ hasText:name })).toContainText('APPROVED');
  await expect(setup.getByRole('row').filter({ hasText:'malformed_provider_template' })).toContainText('Unsupported format');
  await expect(setup.getByRole('row').filter({ hasText:name })).toContainText(header);
  await expect(setup.locator('img')).toHaveCount(0);
  campaign=await openCampaign();const item=campaign.locator('li').filter({ hasText:name });
  await expect(item).toContainText(header);await expect(item).toContainText(footer);
  await item.getByRole('button',{ name:'Allow',exact:true }).click();
  await expect(item.getByRole('button',{ name:'Remove',exact:true })).toBeVisible();
  await campaign.locator('li').filter({ hasText:headerName }).getByRole('button',{ name:'Allow',exact:true }).click();
  await expect(campaign.locator('li').filter({ hasText:headerName }).getByRole('button',{ name:'Remove',exact:true })).toBeVisible();
  await campaign.locator('li').filter({ hasText:ctaName }).getByRole('button',{ name:'Allow',exact:true }).click();
  await expect(campaign.locator('li').filter({ hasText:ctaName }).getByRole('button',{ name:'Remove',exact:true })).toBeVisible();
  await campaign.locator('li').filter({ hasText:urlName }).getByRole('button',{ name:'Allow',exact:true }).click();
  await expect(campaign.locator('li').filter({ hasText:urlName }).getByRole('button',{ name:'Remove',exact:true })).toBeVisible();
  const agentContext=await browser.newContext();const agent=await agentContext.newPage();
  agent.on('pageerror',(error)=>errors.push(error.message));
  try {
    await login(agent);
    await agent.getByRole('row').filter({ hasText:'Browser Media Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    const panel=agent.getByRole('heading',{ name:'Customer conversations',exact:true }).locator('..');
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();
    await panel.getByLabel('Message type',{ exact:true }).selectOption('TEMPLATE');
    await panel.getByLabel('Template',{ exact:true }).selectOption({ label:name+' · en_US' });
    await expect(panel).toContainText(header);await expect(panel).toContainText(footer);
    await expect(panel).not.toContainText('Approval example only');
    await expect(panel.getByRole('button',{ name:'Queue message',exact:true })).toBeDisabled();
    await panel.getByLabel('Parameter 1',{ exact:true }).fill('Alice');
    const start=await control(agent);
    await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
    const full=header+'\n\nDear Alice, your request is received.\n\n'+footer;
    const message=panel.locator('.conversation-messages li').filter({ hasText:full });
    await expect(message).toContainText('QUEUED');
    const sent=await control(agent,{ process:true,mode:'accept' });expect(sent.providerCalls).toBe(start.providerCalls+1);
    expect(sent.messages.filter((m:{ body:string })=>m.body===full)).toHaveLength(1);
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();
    await expect(message).toContainText('SENT');await expect(message.locator('img')).toHaveCount(0);
    await panel.getByLabel('Template',{ exact:true }).selectOption({ label:headerName+' · en_US' });
    await expect(panel.getByRole('button',{ name:'Queue message',exact:true })).toBeDisabled();
    await panel.getByLabel('Parameter 1',{ exact:true }).fill('Order Body');
    await expect(panel.getByRole('button',{ name:'Queue message',exact:true })).toBeDisabled();
    await panel.getByLabel('HEADER parameter value',{ exact:true }).fill('Alice Header');
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();
    await expect(panel.getByLabel('HEADER parameter value',{ exact:true })).toHaveValue('Alice Header');
    await expect(panel.getByLabel('Parameter 1',{ exact:true })).toHaveValue('Order Body');
    await expect(panel).not.toContainText('Header approval sample only');await expect(panel).not.toContainText('Body approval sample only');
    const headerFull='Welcome Alice Header\n\nOrder Order Body\n\nHeader closing line';
    await expect(panel).toContainText(headerFull);
    await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
    const headerMessage=panel.locator('.conversation-messages li').filter({ hasText:headerFull });
    await expect(headerMessage).toContainText('QUEUED');
    const headerSent=await control(agent,{ process:true,mode:'accept' });expect(headerSent.providerCalls).toBe(start.providerCalls+2);
    expect(headerSent.messages.filter((m:{ body:string })=>m.body===headerFull)).toHaveLength(1);
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();await expect(headerMessage).toContainText('SENT');
    await panel.getByLabel('Template',{ exact:true }).selectOption({ label:ctaName+' · en_US' });
    await panel.getByLabel('Parameter 1',{ exact:true }).fill('Order CTA');
    const composer=panel.getByLabel('Message type',{ exact:true }).locator('..').locator('..');
    await expect(composer.getByRole('link',{ name:/Visit site/ })).toHaveAttribute('href','https://example.test/offer');
    await expect(composer.getByRole('link',{ name:/Visit site/ })).toHaveAttribute('rel','noopener noreferrer');
    await expect(composer.getByRole('link',{ name:/Call us/ })).toHaveAttribute('href','tel:+15550007777');
    await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
    const ctaFull='CTA greeting\n\nCTA order Order CTA\n\nCTA closing line';
    const ctaMessage=panel.locator('.conversation-messages li').filter({ hasText:ctaFull });await expect(ctaMessage).toContainText('QUEUED');
    const ctaSent=await control(agent,{ process:true,mode:'accept' });expect(ctaSent.providerCalls).toBe(start.providerCalls+3);
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();await expect(ctaMessage).toContainText('SENT');
    await expect(ctaMessage.getByRole('link',{ name:/Visit site/ })).toHaveAttribute('href','https://example.test/offer');
    await expect(ctaMessage.getByRole('link',{ name:/Call us/ })).toHaveAttribute('href','tel:+15550007777');
    await panel.getByLabel('Template',{ exact:true }).selectOption({ label:urlName+' · en_US' });
    await panel.getByLabel('HEADER parameter value',{ exact:true }).fill('Header Alice');
    await panel.getByLabel('Parameter 1',{ exact:true }).fill('Body Order');
    await expect(panel.getByRole('button',{ name:'Queue message',exact:true })).toBeDisabled();
    await expect(composer.getByRole('link',{ name:/Track order/ })).toHaveCount(0);
    await panel.getByLabel('URL suffix value',{ exact:true }).fill('https://evil.test');
    await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
    await expect(panel.getByRole('alert')).toContainText('TEMPLATE_URL_PARAMETER_INVALID');
    expect((await control(agent)).providerCalls).toBe(start.providerCalls+3);
    await panel.getByLabel('URL suffix value',{ exact:true }).fill('order-123?source=crm');
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();
    await expect(panel.getByLabel('URL suffix value',{ exact:true })).toHaveValue('order-123?source=crm');
    await expect(panel.getByLabel('HEADER parameter value',{ exact:true })).toHaveValue('Header Alice');
    await expect(panel.getByLabel('Parameter 1',{ exact:true })).toHaveValue('Body Order');
    await expect(composer.getByRole('link',{ name:/Track order/ })).toHaveAttribute('href','https://example.test/orders/order-123?source=crm');
    await expect(panel).not.toContainText('URL-APPROVAL-ONLY');await expect(panel).not.toContainText('Header URL approval only');
    const urlFull='URL greeting Header Alice\n\nURL order Body Order\n\nURL closing line';
    await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
    const urlMessage=panel.locator('.conversation-messages li').filter({ hasText:urlFull });await expect(urlMessage).toContainText('QUEUED');
    const urlSent=await control(agent,{ process:true,mode:'accept' });expect(urlSent.providerCalls).toBe(start.providerCalls+4);
    expect(urlSent.messages.filter((m:{ body:string })=>m.body===urlFull)).toHaveLength(1);
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();await expect(urlMessage).toContainText('SENT');
    await expect(urlMessage.getByRole('link',{ name:/Track order/ })).toHaveAttribute('href','https://example.test/orders/order-123?source=crm');
    await agent.setViewportSize({ width:390,height:844 });await agent.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await expect(agent.locator('html')).toHaveAttribute('dir','rtl');
    const mobileCta=agent.locator('.conversation-messages li').filter({ hasText:ctaFull });
    await expect(mobileCta.getByRole('link',{ name:/Visit site/ })).toHaveAttribute('href','https://example.test/offer');
    expect(await agent.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await mobileCta.scrollIntoViewIfNeeded();await agent.screenshot({ path:'.local/e2e/template-buttons-ar.png' });
    const mobileUrl=agent.locator('.conversation-messages li').filter({ hasText:urlFull });
    await expect(mobileUrl.getByRole('link',{ name:/Track order/ })).toHaveAttribute('href','https://example.test/orders/order-123?source=crm');
    const arabicPanel=agent.getByRole('heading',{ name:'محادثات العميل',exact:true }).locator('..');
    await arabicPanel.getByLabel('القالب',{ exact:true }).selectOption({ label:urlName+' · en_US' });
    await expect(arabicPanel.getByLabel('قيمة لاحقة URL',{ exact:true })).toHaveValue('');
    await arabicPanel.getByLabel('قيمة لاحقة URL',{ exact:true }).fill('order-456');
    await mobileUrl.scrollIntoViewIfNeeded();await agent.screenshot({ path:'.local/e2e/template-url-ar.png' });
    await agent.getByRole('combobox',{ name:'Language' }).selectOption('en');
    await agent.getByRole('button',{ name:'Sign out',exact:true }).click();
    await expect(agent.getByRole('button',{ name:'Sign in',exact:true })).toBeVisible();
    expect((await agent.request.get('/api/auth/me')).status()).toBe(401);
  } finally { await agentContext.close(); }
  await openSetup();
  const operational=page.getByRole('heading',{ name:'Test send',exact:true }).locator('..');
  await operational.getByRole('button',{ name:'Refresh templates',exact:true }).click();
  await operational.getByLabel('Sender',{ exact:true }).selectOption({ label:'Browser Media Sender' });
  await expect(operational.getByLabel('Approved template',{ exact:true }).locator('option').filter({ hasText:name })).toHaveCount(0);
  await expect(operational.getByLabel('Approved template',{ exact:true }).locator('option').filter({ hasText:'header_only_template' })).toHaveCount(0);
  await operational.getByLabel('Approved template',{ exact:true }).selectOption({ label:staticName+' · en_US' });
  await operational.getByLabel('Recipient in international + format',{ exact:true }).fill('+15550006666');
  await operational.getByLabel('I control the test number or have explicit consent to message it.',{ exact:true }).check();
  await operational.getByRole('button',{ name:'Send test',exact:true }).click();
  await expect(operational).toContainText('Provider accepted the request; delivery is unconfirmed.');
  await expect(operational).toContainText('SUCCEEDED');
  expect(errors).toEqual([]);
});

test('approval sample setup uploads scanned video, reviews provider failure, retries and downloads safely without sending a customer message',async({ page })=> {
  const errors:string[]=[];page.on('pageerror',(error)=>errors.push(error.message));await login(page,'manager');
  await page.getByRole('button',{ name:'Messaging setup',exact:true }).click();
  await page.getByRole('row').filter({ hasText:'Browser Media Connection' }).getByRole('button').click();
  const samples=page.getByRole('heading',{ name:'Template approval samples',exact:true }).locator('..');
  await expect(samples).toBeVisible();const before=await control(page);
  await samples.getByLabel('Template sample type',{ exact:true }).selectOption('video');
  await samples.getByLabel('Approval sample file',{ exact:true }).setInputFiles(resolve('test-fixtures/media/clip.mp4'));
  await samples.getByRole('button',{ name:'Refresh samples',exact:true }).click();
  await expect(samples.getByRole('button',{ name:'Upload sample for scanning',exact:true })).toBeEnabled();
  await samples.getByRole('button',{ name:'Upload sample for scanning',exact:true }).click();await expect(samples).toContainText('QUEUED');
  await control(page,{ processSample:true,rejectSample:true });await samples.getByRole('button',{ name:'Refresh samples',exact:true }).click();
  await expect(samples).toContainText('FAILED');await expect(samples).toContainText('SAMPLE_PROVIDER_AUTH_FAILED');
  await expect(samples.getByRole('button',{ name:'Retry sample provider upload',exact:true })).toBeDisabled();
  await samples.getByLabel('Reason after fixing sample failure',{ exact:true }).fill('Browser provider upload authentication repaired');
  await samples.getByRole('button',{ name:'Retry sample provider upload',exact:true }).click();await expect(samples).toContainText('QUEUED');
  await control(page,{ processSample:true });await samples.getByRole('button',{ name:'Refresh samples',exact:true }).click();
  await expect(samples).toContainText('Provider reference ready');await expect(samples).not.toContainText('browser-private-sample-handle');
  await samples.getByRole('button',{ name:'Sample upload attempts',exact:true }).click();await expect(samples).toContainText('READY');await expect(samples).toContainText('FAILED');
  const downloaded=page.waitForEvent('download');await samples.getByRole('button',{ name:'Download scanned sample',exact:true }).click();
  const file=await downloaded;expect(file.suggestedFilename()).toMatch(/^sample-[0-9a-f-]+\.mp4$/);
  const path=await file.path();expect(await readFile(path!)).toEqual(await readFile('test-fixtures/media/clip.mp4'));
  const after=await control(page);expect(after.sampleUploads).toBe(before.sampleUploads+2);expect(after.providerCalls).toBe(before.providerCalls);
  expect(after.messages).toHaveLength(before.messages.length);
  await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.getByRole('heading',{ name:'عينات اعتماد القوالب',exact:true }).scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/template-sample-ar.png' });
  expect(errors).toEqual([]);
  managerStorageState=await page.context().storageState();
});

test('Quick Reply templates send approved labels, correlate signed customer replies and retain duplicate-safe history in the browser',async({ page,browser })=> {
  const errors:string[]=[];page.on('pageerror',(error)=>errors.push(error.message));await login(page,'manager');
  await page.getByRole('button',{ name:'Messaging setup',exact:true }).click();
  await page.getByRole('row').filter({ hasText:'Browser Media Connection' }).getByRole('button').click();
  const setup=page.getByRole('heading',{ name:'Meta templates',exact:true }).locator('..');const name='browser_quick_notice';
  await setup.getByLabel('Template name',{ exact:true }).fill(name);await setup.getByLabel('BODY text',{ exact:true }).fill('Please choose a reply');
  await setup.getByLabel('Template button mode',{ exact:true }).selectOption('QUICK_REPLY');
  await setup.getByLabel('Quick reply label 1',{ exact:true }).fill('Yes <b>literal</b>');
  await setup.getByLabel('Quick reply label 2',{ exact:true }).fill('No');
  await setup.getByRole('button',{ name:'Submit template',exact:true }).click();
  await expect(setup.getByRole('row').filter({ hasText:name })).toContainText('PENDING');
  await control(page,{ approveTemplates:true });await setup.getByRole('button',{ name:'Sync approvals',exact:true }).click();
  await expect(setup.getByRole('row').filter({ hasText:name })).toContainText('APPROVED');
  const operational=page.getByRole('heading',{ name:'Test send',exact:true }).locator('..');
  await operational.getByRole('button',{ name:'Refresh templates',exact:true }).click();
  await expect(operational.getByLabel('Approved template',{ exact:true }).locator('option').filter({ hasText:name })).toHaveCount(0);
  await page.getByRole('button',{ name:'Campaigns',exact:true }).click();
  await page.getByRole('row').filter({ hasText:'Browser Media Campaign' }).getByRole('button',{ name:'Details',exact:true }).click();
  await page.getByRole('heading',{ name:'Campaign templates',exact:true }).locator('..').locator('li').filter({ hasText:name }).getByRole('button',{ name:'Allow',exact:true }).click();
  const context=await browser.newContext();const agent=await context.newPage();agent.on('pageerror',(error)=>errors.push(error.message));
  try {
    await login(agent);await agent.getByRole('row').filter({ hasText:'Browser Media Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    const panel=agent.getByRole('heading',{ name:'Customer conversations',exact:true }).locator('..');await panel.getByRole('button',{ name:'View messages',exact:true }).click();
    await panel.getByLabel('Message type',{ exact:true }).selectOption('TEMPLATE');await panel.getByLabel('Template',{ exact:true }).selectOption({ label:name+' · en_US' });
    const composer=panel.getByLabel('Message type',{ exact:true }).locator('..').locator('..');
    await expect(composer).toContainText('Yes <b>literal</b>');await expect(composer.locator('b')).toHaveCount(0);
    await expect(composer.getByRole('button',{ name:'Yes <b>literal</b>',exact:true })).toHaveCount(0);
    const before=await control(agent);await panel.getByRole('button',{ name:'Queue message',exact:true }).click();
    const message=panel.locator('.conversation-messages li').filter({ hasText:'Please choose a reply' });await expect(message).toContainText('QUEUED');
    const sent=await control(agent,{ process:true,mode:'accept' });expect(sent.providerCalls).toBe(before.providerCalls+1);
    const source=sent.messages.find((item:{ body:string })=>item.body==='Please choose a reply');expect(source).toBeTruthy();
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();await expect(message).toContainText('SENT');await expect(message).toContainText('Yes <b>literal</b>');
    const reply=await control(agent,{ replyTo:source.id,replyIndex:0 });expect(reply.replies).toHaveLength(1);
    expect((await control(agent,{ replyTo:source.id,replyIndex:0 })).replies).toHaveLength(1);
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();
    const inbound=panel.locator('.conversation-messages li').filter({ hasText:'Template button reply 1' });
    await expect(inbound).toContainText('Yes <b>literal</b>');await expect(inbound.locator('b')).toHaveCount(0);
    await expect(inbound.getByRole('link',{ name:'Template button reply 1',exact:true })).toHaveAttribute('href','#message-'+source.id);
    await agent.setViewportSize({ width:390,height:844 });await agent.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await expect(agent.getByRole('link',{ name:'رد على زر القالب 1',exact:true })).toHaveAttribute('href','#message-'+source.id);
    expect(await agent.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await agent.getByRole('link',{ name:'رد على زر القالب 1',exact:true }).scrollIntoViewIfNeeded();await agent.screenshot({ path:'.local/e2e/quick-reply-ar.png' });
    agentStorageState=await context.storageState();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('approved video template uses a ready approval sample and a separate scanned customer file with immutable browser recovery and history',async({ page,browser })=> {
  const errors:string[]=[];page.on('pageerror',(error)=>errors.push(error.message));expect(managerStorageState).toBeTruthy();
  await page.context().addCookies(managerStorageState!.cookies);await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
  await page.getByRole('button',{ name:'Messaging setup',exact:true }).click();
  await page.getByRole('row').filter({ hasText:'Browser Media Connection' }).getByRole('button').click();
  const setup=page.getByRole('heading',{ name:'Meta templates',exact:true }).locator('..');const name='browser_video_notice';
  await setup.getByLabel('Template header format',{ exact:true }).selectOption('VIDEO');
  await expect(setup.getByRole('button',{ name:'Submit template',exact:true })).toBeDisabled();
  await setup.getByRole('button',{ name:'Refresh approval samples',exact:true }).click();
  const sampleSelector=setup.getByLabel('Ready approval sample',{ exact:true });
  await expect(sampleSelector.locator('option')).toHaveCount(2);const sampleId=await sampleSelector.locator('option').nth(1).getAttribute('value');await sampleSelector.selectOption(sampleId!);
  await setup.getByLabel('Template name',{ exact:true }).fill(name);await setup.getByLabel('BODY text',{ exact:true }).fill('Video for {{1}} <b>literal</b>');
  await setup.getByLabel('Parameter example 1',{ exact:true }).fill('Approval only');await setup.getByLabel('Static footer (optional)',{ exact:true }).fill('Video closing');
  await setup.getByRole('button',{ name:'Submit template',exact:true }).click();await expect(setup.getByRole('row').filter({ hasText:name })).toContainText('PENDING');
  await expect(setup).not.toContainText('browser-private-sample-handle');await control(page,{ approveTemplates:true });await setup.getByRole('button',{ name:'Sync approvals',exact:true }).click();
  await expect(setup.getByRole('row').filter({ hasText:name })).toContainText('APPROVED');
  const operational=page.getByRole('heading',{ name:'Test send',exact:true }).locator('..');await operational.getByRole('button',{ name:'Refresh templates',exact:true }).click();
  await expect(operational.getByLabel('Approved template',{ exact:true }).locator('option').filter({ hasText:name })).toHaveCount(0);
  await page.getByRole('button',{ name:'Campaigns',exact:true }).click();
  await page.getByRole('row').filter({ hasText:'Browser Media Campaign' }).getByRole('button',{ name:'Details',exact:true }).click();
  await page.getByRole('heading',{ name:'Campaign templates',exact:true }).locator('..').locator('li').filter({ hasText:name }).getByRole('button',{ name:'Allow',exact:true }).click();
  // Reuse the preceding synthetic Agent session in memory; repeated fixture logins hit the real 10/15min IP quota.
  // The production auth limiter remains enabled and no storage state is saved to disk or personal profile.
  expect(agentStorageState).toBeTruthy();const context=await browser.newContext({ storageState:agentStorageState });const agent=await context.newPage();agent.on('pageerror',(error)=>errors.push(error.message));
  try {
    await agent.goto('/');await agent.getByRole('combobox',{ name:'Language' }).selectOption('en');await expect(agent.getByRole('button',{ name:'Sign out',exact:true })).toBeVisible();
    await agent.getByRole('row').filter({ hasText:'Browser Media Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    const panel=agent.getByRole('heading',{ name:'Customer conversations',exact:true }).locator('..');await panel.getByRole('button',{ name:'View messages',exact:true }).click();
    await panel.getByLabel('Message type',{ exact:true }).selectOption('TEMPLATE');await panel.getByLabel('Template',{ exact:true }).selectOption({ label:name+' · en_US' });
    await panel.getByLabel('Parameter 1',{ exact:true }).fill('Alice');await expect(panel.getByRole('button',{ name:'Queue message',exact:true })).toBeDisabled();
    await expect(panel).not.toContainText('Approval only');await expect(panel).not.toContainText('browser-private-sample-handle');
    expect((await agent.request.get('/api/messaging/template-samples/'+sampleId+'/download')).status()).toBe(403);
    await panel.getByLabel('Customer template header file',{ exact:true }).setInputFiles(resolve('test-fixtures/media/clip.mp4'));
    await panel.getByRole('button',{ name:'Upload and scan',exact:true }).click();await expect(panel.getByRole('button',{ name:'Queue message',exact:true })).toBeEnabled();
    const composer=panel.getByLabel('Message type',{ exact:true }).locator('..').locator('..');
    const before=await control(agent);const previewDownload=agent.waitForEvent('download');await composer.getByRole('button',{ name:'Download scanned file',exact:true }).click();await previewDownload;
    expect((await control(agent)).messages).toHaveLength(before.messages.length);
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();await expect(panel.getByLabel('Parameter 1',{ exact:true })).toHaveValue('Alice');
    await expect(panel.getByRole('button',{ name:'Queue message',exact:true })).toBeEnabled();
    await panel.getByRole('button',{ name:'Queue message',exact:true }).click();const body='Video for Alice <b>literal</b>\n\nVideo closing';
    const message=panel.locator('.conversation-messages li').filter({ has:agent.getByText(body,{ exact:true }) });await expect(message).toContainText('QUEUED');
    const rejected=await control(agent,{ process:true,mode:'reject' });expect(rejected.mediaUploads).toBe(before.mediaUploads+1);expect(rejected.providerCalls).toBe(before.providerCalls+1);
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();await expect(message).toContainText('FAILED');
    await message.getByRole('button',{ name:'Send details and attempts',exact:true }).click();
    await message.getByLabel('Reason after fixing the failure',{ exact:true }).fill('Browser video template delivery rejection resolved');
    await message.getByLabel('I fixed the failure and want to send the same saved content',{ exact:true }).check();
    await message.getByRole('button',{ name:'Requeue the saved message',exact:true }).click();await expect(message).toContainText('QUEUED');
    const sent=await control(agent,{ process:true,mode:'accept' });
    expect(sent.mediaUploads).toBe(before.mediaUploads+2);expect(sent.providerCalls).toBe(before.providerCalls+2);expect(sent.sampleUploads).toBe(before.sampleUploads);
    expect(sent.messages.filter((item:{ body:string })=>item.body===body)).toHaveLength(1);
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();await expect(message).toContainText('SENT');await expect(message.locator('b')).toHaveCount(0);
    const downloaded=agent.waitForEvent('download');await message.getByRole('button',{ name:'Download scanned file',exact:true }).click();const file=await downloaded;
    expect(await readFile((await file.path())!)).toEqual(await readFile('test-fixtures/media/clip.mp4'));
    await agent.setViewportSize({ width:390,height:844 });await agent.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await expect(agent.locator('html')).toHaveAttribute('dir','rtl');expect(await agent.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await agent.getByText(body,{ exact:true }).scrollIntoViewIfNeeded();await agent.screenshot({ path:'.local/e2e/media-template-ar.png' });expect(errors).toEqual([]);
  } finally { await context.close(); }
  managerStorageState=await page.context().storageState();
});

test('Meta source setup creates encrypted credentials, discovers scoped Pages and Forms, handles failure and preserves safe mobile history',async({ browser })=> {
  expect(managerStorageState).toBeTruthy();const context=await browser.newContext({ storageState:managerStorageState });const page=await context.newPage();
  const errors:string[]=[];page.on('pageerror',(error)=>errors.push(error.message));
  try {
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await expect(page.getByRole('button',{ name:'Sign out',exact:true })).toBeVisible();
    await page.getByRole('button',{ name:'Meta sources',exact:true }).click();const setup=page.locator('.meta-source-setup');
    await setup.getByRole('button',{ name:'Add Meta source',exact:true }).click();
    await setup.getByLabel('Source name',{ exact:true }).fill('Browser Lead Source');await setup.getByLabel('Source Graph API version',{ exact:true }).fill('v25.0');
    await setup.getByLabel('Meta access token',{ exact:true }).fill('synthetic-browser-root-token');await setup.getByLabel('Source App Secret',{ exact:true }).fill('synthetic-browser-app-secret');
    await setup.getByLabel('Source verification token',{ exact:true }).fill('synthetic-browser-verify-token');await setup.getByRole('button',{ name:'Save source',exact:true }).click();
    const row=setup.getByRole('row').filter({ hasText:'Browser Lead Source' });await expect(row).toContainText('NOT_CONFIGURED');
    await expect(setup.getByRole('heading',{ name:'Browser Lead Source',exact:true })).toBeVisible();const before=await control(page);
    await control(page,{ sourceFailure:true });await setup.getByRole('button',{ name:'Test and discover Pages',exact:true }).click();
    await expect(row).toContainText('AUTH_EXPIRED');await expect(setup.getByRole('alert')).toContainText('SOURCE_PROVIDER_AUTH_FAILED');
    await control(page,{ sourceFailure:false });await setup.getByRole('button',{ name:'Test and discover Pages',exact:true }).click();await expect(row).toContainText('CONNECTED');
    const pageSelector=setup.getByLabel('Select Page',{ exact:true });await expect(pageSelector.locator('option')).toHaveCount(2);
    const pageId=await pageSelector.locator('option').nth(1).getAttribute('value');await pageSelector.selectOption(pageId!);
    await setup.getByRole('button',{ name:'Discover Forms',exact:true }).click();const formSelector=setup.getByLabel('Select Form',{ exact:true });
    await expect(formSelector.locator('option')).toHaveCount(2);await formSelector.selectOption((await formSelector.locator('option').nth(1).getAttribute('value'))!);
    await expect(setup).toContainText('Interest <img src=x onerror=alert(1)>');await expect(setup).toContainText('Yes <b>literal</b>');await expect(setup.locator('img,b')).toHaveCount(0);
    await expect(setup).not.toContainText('synthetic-browser-page-private-token');await expect(setup).not.toContainText('synthetic-browser-root-token');
    await expect(setup).toContainText('Complete source setup and check campaign readiness');await expect(setup).toContainText('SUCCEEDED');await expect(setup).toContainText('FAILED');
    await setup.getByRole('button',{ name:'Edit source',exact:true }).click();await expect(setup.getByLabel('Meta access token',{ exact:true })).toHaveValue('');
    await setup.getByRole('button',{ name:'Cancel',exact:true }).click();
    await setup.getByRole('button',{ name:'Disable source',exact:true }).click();await expect(row).toContainText('DISABLED');
    await expect(setup.getByRole('button',{ name:'Test and discover Pages',exact:true })).toBeDisabled();await expect(setup.getByRole('button',{ name:'Discover Forms',exact:true })).toBeDisabled();
    await setup.getByRole('button',{ name:'Reconfigure source',exact:true }).click();await expect(row).toContainText('NOT_CONFIGURED');
    await expect(setup.getByRole('button',{ name:'Discover Forms',exact:true })).toBeDisabled();
    await setup.getByRole('button',{ name:'Test and discover Pages',exact:true }).click();await expect(row).toContainText('CONNECTED');
    const after=await control(page);expect(after.providerCalls).toBe(before.providerCalls);expect(after.messages).toHaveLength(before.messages.length);expect(after.sourceCatalogCalls).toBe(before.sourceCatalogCalls+4);
    const agentContext=await browser.newContext({ storageState:agentStorageState });
    try { const agent=await agentContext.newPage();await agent.goto('/');await agent.getByRole('combobox',{ name:'Language' }).selectOption('en');
      await expect(agent.getByRole('button',{ name:'Sign out',exact:true })).toBeVisible();await expect(agent.getByRole('button',{ name:'Meta sources',exact:true })).toHaveCount(0);
      expect((await agent.request.get('/api/sources/meta/connections')).status()).toBe(403);
    } finally { await agentContext.close(); }
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('dir','rtl');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await setup.getByRole('heading',{ name:'مصادر Meta',exact:true }).scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/meta-source-ar.png' });expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('shared Form grants and campaign bindings enforce explicit scope, conflicts, history and revoke/restore in the browser',async({ page,browser })=> {
  const errors:string[]=[];page.on('pageerror',(error)=>errors.push(error.message));await login(page,'admin');
  adminStorageState=await page.context().storageState();
  await page.getByRole('button',{ name:'Meta sources',exact:true }).click();const setup=page.locator('.meta-source-setup');
  await setup.getByRole('button',{ name:'Add Meta source',exact:true }).click();await setup.getByLabel('Source name',{ exact:true }).fill('Browser Shared Intake');
  await setup.getByLabel('Source Graph API version',{ exact:true }).fill('v25.0');await setup.getByLabel('Meta access token',{ exact:true }).fill('synthetic-shared-intake-token');
  await setup.getByLabel('Source App Secret',{ exact:true }).fill('synthetic-shared-intake-secret');await setup.getByLabel('Source verification token',{ exact:true }).fill('synthetic-shared-intake-verify');
  await setup.getByRole('button',{ name:'Save source',exact:true }).click();await expect(setup.getByRole('heading',{ name:'Browser Shared Intake',exact:true })).toBeVisible();
  await setup.getByRole('button',{ name:'Test and discover Pages',exact:true }).click();const pages=setup.getByLabel('Select Page',{ exact:true });
  await expect(pages.locator('option')).toHaveCount(2);await pages.selectOption((await pages.locator('option').nth(1).getAttribute('value'))!);
  await setup.getByRole('button',{ name:'Discover Forms',exact:true }).click();const forms=setup.getByLabel('Select Form',{ exact:true });
  await expect(forms.locator('option')).toHaveCount(2);await forms.selectOption((await forms.locator('option').nth(1).getAttribute('value'))!);
  const access=setup.locator('.source-resource-access');await expect(access.getByRole('heading',{ name:'Share Form with branches',exact:true })).toBeVisible();
  await access.getByLabel('Authorized source branch',{ exact:true }).selectOption({ label:'Browser Branch' });
  await access.getByLabel('Source access change reason',{ exact:true }).fill('Browser authorize this Form');await access.getByRole('button',{ name:'Save source access',exact:true }).click();
  await expect(access.getByRole('listitem').filter({ hasText:'Browser Branch' })).toContainText('ACTIVE');
  const context=await browser.newContext({ storageState:managerStorageState });const manager=await context.newPage();manager.on('pageerror',(error)=>errors.push(error.message));
  try {
    await manager.goto('/');await manager.getByRole('combobox',{ name:'Language' }).selectOption('en');await manager.getByRole('button',{ name:'Campaigns',exact:true }).click();
    await manager.getByRole('row').filter({ hasText:'Browser Intake Campaign' }).getByRole('button',{ name:'Details',exact:true }).click();const bindings=manager.locator('.campaign-sources');
    await expect(bindings.getByRole('heading',{ name:'Campaign source bindings',exact:true })).toBeVisible();await bindings.getByRole('button',{ name:'Bind another Form',exact:true }).click();
    await bindings.getByLabel('Campaign source connection',{ exact:true }).selectOption({ label:'Browser Shared Intake · CONNECTED · Shared source authorized for this branch' });
    const campaignPage=bindings.getByLabel('Campaign source Page',{ exact:true });await expect(campaignPage.locator('option')).toHaveCount(2);
    await campaignPage.selectOption((await campaignPage.locator('option').nth(1).getAttribute('value'))!);const campaignForm=bindings.getByLabel('Campaign source Form',{ exact:true });
    await expect(campaignForm.locator('option')).toHaveCount(2);const formId=(await campaignForm.locator('option').nth(1).getAttribute('value'))!;await campaignForm.selectOption(formId);
    await expect(bindings).toContainText('Interest <img src=x onerror=alert(1)>');expect(await bindings.locator('img,b').count()).toBe(0);
    await bindings.getByLabel('External Campaign ID (optional)',{ exact:true }).fill('555');await bindings.getByLabel('Enable source selection',{ exact:true }).check();
    await bindings.getByLabel('Binding change reason',{ exact:true }).fill('Browser explicit selector');await bindings.getByRole('button',{ name:'Save source binding',exact:true }).click();
    const binding=bindings.locator('[data-binding-id]');await expect(binding).toHaveCount(1);await expect(binding).toContainText('ACTIVE');await expect(binding).toContainText('Campaign: 555');
    await expect(binding).toContainText('SOURCE_MAPPING_NOT_CONFIGURED');const bindingId=await binding.getAttribute('data-binding-id');
    const connections=await manager.request.get(`/api/sources/campaigns/${fixture.sourceCampaignId}/connections`);expect(connections.ok()).toBeTruthy();const connection=(await connections.json()).items.find((c:{ name:string })=>c.name==='Browser Shared Intake');
    expect(JSON.stringify(connection)).not.toContain('synthetic-shared');expect((await manager.request.get(`/api/sources/meta/connections/${connection.id}/resources?kind=FORM`)).status()).toBe(404);
    const data={ connectionId:connection.id,formId,requestId:crypto.randomUUID(),connectionVersion:1,
      externalCampaignId:null,externalAdSetId:null,externalAdId:null,active:true,reason:'Browser overlapping wildcard' };
    const conflict=await manager.request.post(`/api/sources/campaigns/${fixture.sourceCampaignId}/bindings`,{ headers:{ origin:'http://127.0.0.1:4100' },data });expect(conflict.status()).toBe(409);
    expect(await conflict.text()).toContain('SOURCE_BINDING_CONTEXT_CONFLICT');expect(await conflict.text()).not.toContain(bindingId!);
    await binding.getByRole('button',{ name:'Edit binding',exact:true }).click();await bindings.getByLabel('External Ad ID (optional)',{ exact:true }).fill('777');
    await bindings.getByLabel('Binding change reason',{ exact:true }).fill('Browser narrow ad');await bindings.getByRole('button',{ name:'Save source binding',exact:true }).click();
    await expect(binding).toContainText('Ad: 777');await binding.getByRole('button',{ name:'Binding history',exact:true }).click();await expect(bindings).toContainText('Browser explicit selector');
    await expect(bindings).toContainText('Browser narrow ad');await expect(manager.getByRole('button',{ name:'Activate',exact:true })).toBeDisabled();
    await access.getByLabel('Allow Form use',{ exact:true }).uncheck();await access.getByLabel('Source access change reason',{ exact:true }).fill('Browser revoke Form');
    await access.getByRole('button',{ name:'Save source access',exact:true }).click();await expect(access.getByRole('listitem').filter({ hasText:'Browser Branch' })).toContainText('INACTIVE');
    await bindings.getByRole('button',{ name:'Refresh bindings',exact:true }).click();await expect(binding).toContainText('INACTIVE');await expect(binding).toContainText('SOURCE_RESOURCE_ACCESS_REQUIRED');
    const hidden=await manager.request.get(`/api/sources/campaigns/${fixture.sourceCampaignId}/connections/${connection.id}/resources?kind=FORM`);expect(hidden.status()).toBe(404);
    await access.getByLabel('Allow Form use',{ exact:true }).check();await access.getByLabel('Source access change reason',{ exact:true }).fill('Browser restore Form');
    await access.getByRole('button',{ name:'Save source access',exact:true }).click();await expect(access.getByRole('listitem').filter({ hasText:'Browser Branch' })).toContainText('ACTIVE');
    await bindings.getByRole('button',{ name:'Refresh bindings',exact:true }).click();await expect(binding).toContainText('INACTIVE');
    await binding.getByRole('button',{ name:'Edit binding',exact:true }).click();await bindings.getByLabel('Enable source selection',{ exact:true }).check();
    await bindings.getByLabel('Binding change reason',{ exact:true }).fill('Browser explicitly reactivate');await bindings.getByRole('button',{ name:'Save source binding',exact:true }).click();await expect(binding).toContainText('ACTIVE');
    await binding.getByRole('button',{ name:'Field Mapping',exact:true }).click();const mapping=bindings.locator('.source-field-mapping');
    await expect(mapping.getByRole('heading',{ name:'Source field mapping',exact:true })).toBeVisible();await mapping.getByRole('button',{ name:'Suggest mapping',exact:true }).click();
    await expect(mapping.locator('.mapping-entry')).toHaveCount(3);await expect(mapping.getByLabel('Value transformation 1',{ exact:true })).toHaveValue('NUMBER');
    await mapping.getByLabel('Mapping change reason',{ exact:true }).fill('Browser mapping draft');await mapping.getByRole('button',{ name:'Save mapping draft',exact:true }).click();
    await expect(mapping).toContainText('Mapping status: DRAFT · v1');await expect(mapping).toContainText('SOURCE_MAPPING_NOT_PUBLISHED');
    await mapping.getByLabel('Preview interest',{ exact:true }).fill('bad');await mapping.getByLabel('Preview full_name',{ exact:true }).fill('<img src=x onerror=alert(1)>');
    await mapping.getByLabel('Preview phone',{ exact:true }).fill('+1 (555) 000-9999');await mapping.getByRole('button',{ name:'Preview mapping',exact:true }).click();
    await expect(mapping.getByRole('status')).toContainText('SOURCE_MAPPING_NUMBER_INVALID');await expect(mapping.getByRole('status')).toContainText('SOURCE_REQUIRED_VALUE_MISSING');
    await mapping.getByLabel('Preview interest',{ exact:true }).fill('12.5');await mapping.getByRole('button',{ name:'Preview mapping',exact:true }).click();
    await expect(mapping.getByRole('status')).toContainText('Preview is valid');await expect(mapping.getByRole('status')).toContainText('Browser source score: 12.5');
    await expect(mapping.getByRole('status')).toContainText('+15550009999');expect(await mapping.locator('img').count()).toBe(0);
    await mapping.getByLabel('Mapping change reason',{ exact:true }).fill('Browser publish reviewed mapping');await mapping.getByRole('button',{ name:'Publish mapping',exact:true }).click();
    await expect(mapping).toContainText('Mapping status: PUBLISHED · v2');await expect(mapping).toContainText('Mapping is published and valid');
    await expect(binding).not.toContainText('SOURCE_MAPPING_NOT_CONFIGURED');await expect(binding).toContainText('SOURCE_PAGE_SUBSCRIPTION_REQUIRED');
    await expect(manager.getByRole('button',{ name:'Activate',exact:true })).toBeDisabled();
    await mapping.getByLabel('Mapping change reason',{ exact:true }).fill('Browser next draft retains published');await mapping.getByRole('button',{ name:'Save mapping draft',exact:true }).click();
    await expect(mapping).toContainText('Mapping status: DRAFT · v3 · Published v2');await expect(mapping).toContainText('Browser publish reviewed mapping');
    const agent=await browser.newContext({ storageState:agentStorageState });try { const tab=await agent.newPage();expect((await tab.request.get(`/api/sources/campaigns/${fixture.sourceCampaignId}/bindings`)).status()).toBe(403); } finally { await agent.close(); }
    await manager.setViewportSize({ width:390,height:844 });await manager.getByRole('combobox',{ name:'Language' }).selectOption('ar');await expect(manager.locator('html')).toHaveAttribute('dir','rtl');
    await bindings.getByRole('heading',{ name:'ربط مصادر الحملة',exact:true }).scrollIntoViewIfNeeded();expect(await manager.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await manager.screenshot({ path:'.local/e2e/source-binding-ar.png' });
    await mapping.getByRole('heading',{ name:'ربط حقول المصدر',exact:true }).scrollIntoViewIfNeeded();expect(await manager.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await manager.screenshot({ path:'.local/e2e/source-mapping-ar.png' });
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await access.getByRole('heading',{ name:'مشاركة Form مع الفروع',exact:true }).scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.screenshot({ path:'.local/e2e/source-access-ar.png' });expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('source Webhook and retrieval preserve signed replays, source submissions and scoped failure recovery with Arabic mobile history',async({ browser })=> {
  const context=await browser.newContext({ storageState:adminStorageState });const page=await context.newPage();
  const errors:string[]=[];page.on('pageerror',(error)=>errors.push(error.message));
  try {
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await expect(page.getByRole('button',{ name:'Sign out',exact:true })).toBeVisible();
    await page.getByRole('button',{ name:'Meta sources',exact:true }).click();const setup=page.locator('.meta-source-setup');
    await setup.getByRole('button',{ name:'Add Meta source',exact:true }).click();await setup.getByLabel('Source name',{ exact:true }).fill('Browser Webhook Source');
    await setup.getByLabel('Source Graph API version',{ exact:true }).fill('v25.0');await setup.getByLabel('Source Meta App ID',{ exact:true }).fill('700001');
    await setup.getByLabel('Meta access token',{ exact:true }).fill('synthetic-browser-webhook-root');await setup.getByLabel('Source App Secret',{ exact:true }).fill('synthetic-browser-webhook-secret');
    await setup.getByLabel('Source verification token',{ exact:true }).fill('synthetic-browser-webhook-verify');await setup.getByRole('button',{ name:'Save source',exact:true }).click();
    await expect(setup.getByRole('heading',{ name:'Browser Webhook Source',exact:true })).toBeVisible();await setup.getByRole('button',{ name:'Test and discover Pages',exact:true }).click();
    const pages=setup.getByLabel('Select Page',{ exact:true });await expect(pages.locator('option')).toHaveCount(2);await pages.selectOption((await pages.locator('option').nth(1).getAttribute('value'))!);
    const webhook=setup.locator('.source-webhook');await expect(webhook.getByRole('button',{ name:'Test Page subscription',exact:true })).toBeEnabled();
    await webhook.getByRole('button',{ name:'Test Page subscription',exact:true }).click();await expect(webhook.getByText('Selected Page subscription: Not subscribed',{ exact:true })).toBeVisible();
    await webhook.getByRole('button',{ name:'Subscribe Page to leadgen',exact:true }).click();await expect(webhook.getByText('Selected Page subscription: Subscribed',{ exact:true })).toBeVisible();
    const callback=(await webhook.getByLabel('Source Callback URL',{ exact:true }).inputValue());const connectionId=new URL(callback).pathname.split('/').at(-1)!;
    expect((await page.request.get(callback+'?'+new URLSearchParams({ 'hub.mode':'subscribe','hub.verify_token':'wrong','hub.challenge':'12345' }))).status()).toBe(403);
    const challenge=await page.request.get(callback+'?'+new URLSearchParams({ 'hub.mode':'subscribe','hub.verify_token':'synthetic-browser-webhook-verify','hub.challenge':'12345' }));expect(await challenge.text()).toBe('12345');
    await control(page,{ sourceNotification:connectionId });await control(page,{ sourceNotification:connectionId });await webhook.getByRole('button',{ name:'Refresh Webhook status',exact:true }).click();
    await expect(webhook).toContainText('Saved events awaiting processing: 1');await expect(webhook).toContainText('Meta Callback verification: Verified');await expect(webhook).toContainText('Valid signed event received: Verified');
    expect((await page.request.get(`/api/sources/meta/connections/${connectionId}/webhook-events`)).ok()).toBeTruthy();
    await control(page,{ sourceSubscriptionFailure:true });await webhook.getByRole('button',{ name:'Test Page subscription',exact:true }).click();await expect(webhook.getByRole('alert')).toContainText('SOURCE_PROVIDER_AUTH_FAILED');
    await expect(webhook).toContainText('FAILED');await control(page,{ sourceSubscriptionFailure:false });await webhook.getByRole('button',{ name:'Test Page subscription',exact:true }).click();
    await expect(webhook.getByText('Selected Page subscription: Subscribed',{ exact:true })).toBeVisible();await expect(webhook.getByRole('alert')).toHaveCount(0);
    const failedRetrieval=await control(page,{ retrieveSource:true,sourceRetrievalFailure:true });expect(failedRetrieval.sourceRetrievalCalls).toBe(1);expect(failedRetrieval.sourceSubmissions).toBe(0);
    await webhook.getByRole('button',{ name:'Refresh Webhook status',exact:true }).click();const notification=webhook.locator('li').filter({ hasText:'Lead 300001' });
    await expect(notification).toContainText('FAILED');await expect(notification).toContainText('SOURCE_RETRIEVAL_FAILED');await notification.getByRole('button',{ name:'Source retrieval attempts',exact:true }).click();
    await expect(notification).toContainText('#1');await expect(notification.getByRole('button',{ name:'Retry source retrieval',exact:true })).toBeDisabled();
    await notification.getByLabel('Source retrieval retry reason',{ exact:true }).fill('Browser source failure repaired');await notification.getByRole('button',{ name:'Retry source retrieval',exact:true }).click();await expect(notification).toContainText('PENDING');
    const retrieved=await control(page,{ retrieveSource:true,sourceRetrievalFailure:false });expect(retrieved.sourceRetrievalCalls).toBe(2);expect(retrieved.sourceSubmissions).toBe(1);
    await webhook.getByRole('button',{ name:'Refresh Webhook status',exact:true }).click();await expect(notification).toContainText('SUCCEEDED');await expect(webhook).toContainText('Source data retrieved: 1');
    await notification.getByRole('button',{ name:'Source retrieval attempts',exact:true }).click();await expect(notification).toContainText('#2');await expect(notification.getByRole('button',{ name:'Retry source retrieval',exact:true })).toHaveCount(0);
    const replay=await control(page,{ sourceNotification:connectionId,retrieveSource:true });expect(replay.sourceRetrievalCalls).toBe(2);expect(replay.sourceSubmissions).toBe(1);
    const review=setup.locator('.source-submissions');await review.getByRole('button',{ name:'Refresh source submissions',exact:true }).click();
    const submission=review.locator('[data-submission-id]');await expect(submission).toHaveCount(1);await expect(submission).toContainText('PENDING');
    await control(page,{ evaluateSource:true });await review.getByRole('button',{ name:'Refresh source submissions',exact:true }).click();
    await expect(submission).toContainText('SOURCE_FORM_NOT_FOUND');await expect(submission.getByRole('button',{ name:'Reprocess source submission',exact:true })).toBeDisabled();
    await setup.getByRole('button',{ name:'Discover Forms',exact:true }).click();
    await expect(setup.getByLabel('Select Form',{ exact:true }).locator('option')).toHaveCount(2);
    const resources=await page.request.get(`/api/sources/meta/connections/${connectionId}/resources?kind=FORM`);const form=(await resources.json()).items[0];
    const campaign=(await (await page.request.get('/api/campaigns/'+fixture.sourceCampaignId)).json());
    const branchId=campaign.campaign.branch_id;
    const headers={ origin:'http://127.0.0.1:4100' };
    const grant=await page.request.put(`/api/sources/meta/connections/${connectionId}/resources/${form.id}/access/${branchId}`,{ headers,data:{ version:0,active:true,reason:'Browser approve runtime source' } });expect(grant.ok()).toBeTruthy();
    const bound=await page.request.post(`/api/sources/campaigns/${fixture.sourceCampaignId}/bindings`,{ headers,data:{ connectionId,formId:form.id,requestId:crypto.randomUUID(),
      connectionVersion:1,externalCampaignId:'555',externalAdSetId:null,externalAdId:null,active:true,reason:'Browser deterministic source' } });expect(bound.ok()).toBeTruthy();
    const runtimeBinding=(await bound.json()).id;const runtimeMapping=`/api/sources/campaigns/${fixture.sourceCampaignId}/bindings/${runtimeBinding}/mapping`;
    const targets=await (await page.request.get(runtimeMapping+'/targets')).json();const score=targets.items.find((f:{ key:string })=>f.key==='interest');expect(score).toBeTruthy();
    const mapped=await page.request.put(runtimeMapping,{ headers,data:{ version:0,bindingVersion:1,connectionVersion:1,resourceVersion:form.version,status:'PUBLISHED',reason:'Browser approve source values',entries:[
      { sourceKey:'full_name',kind:'CONTACT_NAME',transform:'TEXT',optionMap:[] },{ sourceKey:'phone',kind:'CONTACT_PHONE',transform:'TEXT',optionMap:[] },
      { sourceKey:'interest',kind:'LEAD_FIELD',fieldId:score.id,transform:'NUMBER',optionMap:[] }] } });expect(mapped.ok()).toBeTruthy();
    await submission.getByLabel('Source reprocess reason',{ exact:true }).fill('Browser catalog and mapping repaired');
    await submission.getByRole('button',{ name:'Reprocess source submission',exact:true }).click();await expect(submission).toContainText('PENDING');
    await control(page,{ evaluateSource:true });await review.getByRole('button',{ name:'Refresh source submissions',exact:true }).click();
    await expect(submission).toContainText('VALIDATED');await expect(submission).toContainText('Mapped fields: 1');await expect(submission).toContainText('Mapped Contact fields: 2');
    // Retire the earlier journey's incomplete setup using its public versioned binding action.
    const previousBindings=(await (await page.request.get(`/api/sources/campaigns/${fixture.sourceCampaignId}/bindings`)).json()).items;
    expect((await (await page.request.get(`/api/campaigns/${fixture.sourceCampaignId}/readiness`)).json()).ready).toBe(false);
    for (const old of previousBindings.filter((b:{ id:string;active:boolean })=>b.active && b.id!==runtimeBinding)) {
      const retired=await page.request.put(`/api/sources/campaigns/${fixture.sourceCampaignId}/bindings/${old.id}`,{ headers,data:{ version:old.version,
        connectionVersion:old.current_connection_version,externalCampaignId:old.external_campaign_id,externalAdSetId:old.external_adset_id,externalAdId:old.external_ad_id,
        active:false,reason:'Retire prior browser fixture context' } });expect(retired.ok()).toBeTruthy();
    }
    await page.getByRole('button',{ name:'Campaigns',exact:true }).click();await page.getByRole('row').filter({ hasText:'Browser Intake Campaign' }).getByRole('button',{ name:'Details',exact:true }).click();
    await expect(page.getByText('Ready to activate',{ exact:true })).toBeVisible();await page.getByRole('button',{ name:'Activate',exact:true }).click();
    await expect(page.getByRole('button',{ name:'Deactivate',exact:true })).toBeEnabled();
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await page.getByRole('heading',{ name:'الجاهزية',exact:true }).scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/source-activation-ar.png' });
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.setViewportSize({ width:1280,height:900 });
    await page.getByRole('button',{ name:'Meta sources',exact:true }).click();await setup.getByRole('row').filter({ hasText:'Browser Webhook Source' }).getByRole('button',{ name:'Select source',exact:true }).click();
    await expect(submission).toContainText('VALIDATED');await webhook.getByRole('button',{ name:'Refresh Webhook status',exact:true }).click();
    await expect(webhook).toContainText('Source is ready for an active campaign');
    await submission.getByRole('button',{ name:'Source processing history',exact:true }).click();await expect(review).toContainText('Browser catalog and mapping repaired');
    await expect(review).toContainText('SOURCE_FORM_NOT_FOUND');await expect(review).not.toContainText('15550008888');await expect(review.locator('img')).toHaveCount(0);
    const manager=await browser.newContext({ storageState:managerStorageState });try { expect((await manager.request.get(`/api/sources/meta/connections/${connectionId}/webhook`)).status()).toBe(404); } finally { await manager.close(); }
    const agent=await browser.newContext({ storageState:agentStorageState });try { expect((await agent.request.get(`/api/sources/meta/connections/${connectionId}/webhook-events`)).status()).toBe(403); } finally { await agent.close(); }
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await expect(page.locator('html')).toHaveAttribute('dir','rtl');
    await webhook.getByRole('heading',{ name:'Webhook المصدر واشتراك Page',exact:true }).scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.screenshot({ path:'.local/e2e/source-webhook-ar.png' });expect(errors).toEqual([]);
    await notification.scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/source-retrieval-ar.png' });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await review.evaluate((element)=>element.scrollIntoView({ block:'start' }));await page.screenshot({ path:'.local/e2e/source-evaluation-ar.png' });
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.setViewportSize({ width:1280,height:900 });
    await control(page,{ prepareSourceMatchFixture:true,intakeSource:true });await review.getByRole('button',{ name:'Refresh source submissions',exact:true }).click();
    await expect(submission).toContainText('CONTACT_AMBIGUOUS');await expect(submission).not.toContainText('PROCESSED');
    await submission.getByRole('button',{ name:'Review Contact match',exact:true }).click();const matching=review.locator('.source-contact-review');
    await expect(matching.getByLabel('Matching Contact',{ exact:true }).locator('option')).toHaveCount(3);
    await expect(matching.getByRole('button',{ name:'Confirm match and create Lead',exact:true })).toBeDisabled();
    await matching.getByLabel('Matching Contact',{ exact:true }).selectOption({ label:'Browser match A · +15550008888 · —' });
    await matching.getByLabel('Contact match reason',{ exact:true }).fill('Browser approved matching person');
    await expect(matching.locator('img')).toHaveCount(0);await expect(matching).toContainText('<img src=x onerror=alert(1)> Browser source customer');
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await matching.evaluate((element)=>element.scrollIntoView({ block:'start' }));await page.screenshot({ path:'.local/e2e/source-match-review-ar.png' });
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await matching.getByRole('button',{ name:'اعتماد المطابقة وإنشاء Lead',exact:true }).click();await expect(submission).toContainText('PROCESSED');
    await expect(submission.getByRole('button',{ name:'إعادة معالجة المصدر',exact:true })).toHaveCount(0);
    const submissionId=await submission.getAttribute('data-submission-id');
    const processed=(await (await page.request.get('/api/sources/submissions?connectionId='+connectionId)).json()).items.find((r:{ submission_id:string })=>r.submission_id===submissionId);
    expect(processed.lead_id).toBeTruthy();const created=await page.request.get('/api/leads/'+processed.lead_id);expect(created.ok()).toBeTruthy();
    expect((await created.json()).lead.contact_name).toBe('Browser match A');
    await submission.getByRole('button',{ name:'تاريخ معالجة المصدر',exact:true }).click();await expect(review).toContainText('Browser approved matching person');
    await submission.evaluate((element)=>element.scrollIntoView({ block:'start' }));await page.screenshot({ path:'.local/e2e/source-intake-processed-ar.png' });
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
    await page.getByRole('combobox',{ name:'Language',exact:true }).selectOption('en');await page.setViewportSize({ width:1280,height:900 });
    await setup.getByRole('combobox',{ name:'Select Page',exact:true }).selectOption((await pages.locator('option').nth(1).getAttribute('value'))!);
    await setup.getByRole('combobox',{ name:'Select Form',exact:true }).selectOption(form.id);
    const historical=setup.locator('.source-historical');
    await historical.getByLabel('Historical From (UTC)',{ exact:true }).fill('2023-11-14T00:00');
    await historical.getByLabel('Historical Until (UTC)',{ exact:true }).fill('2023-11-15T00:00');
    await historical.getByRole('button',{ name:'Create historical preview',exact:true }).click();await expect(historical.getByRole('status')).toContainText('Preview queued');
    await control(page,{ historicalPreview:true });await historical.getByRole('button',{ name:'Refresh historical jobs',exact:true }).click();await expect(historical.getByRole('status')).toContainText('Preview queued');
    await expect(historical).toContainText('1 / 1');await expect(historical.getByRole('button',{ name:'Confirm historical import',exact:true })).toHaveCount(0);
    await control(page,{ historicalPreview:true });await historical.getByRole('button',{ name:'Refresh historical jobs',exact:true }).click();await expect(historical.getByRole('status')).toContainText('Preview ready');
    await expect(historical.getByRole('button',{ name:'Confirm historical import',exact:true })).toBeDisabled();
    await historical.getByLabel('Historical action reason',{ exact:true }).fill('Browser reviewed original history');await historical.getByRole('button',{ name:'Confirm historical import',exact:true }).click();
    await expect(historical.getByRole('status')).toContainText('Import running');await control(page,{ historicalImport:true });await control(page,{ evaluateSource:true,intakeSource:true });
    await historical.getByRole('button',{ name:'Refresh historical jobs',exact:true }).click();await expect(historical.getByRole('status')).toContainText('Import preserved');
    await expect(historical).toContainText('DUPLICATE_SUBMISSION');await expect(historical).toContainText('IMPORTED');await expect(historical).toContainText('PROCESSED');
    await expect(historical.getByRole('row').filter({ hasText:'300002' })).toContainText('IMPORTED');await expect(historical.getByRole('row').filter({ hasText:'300002' })).toContainText('PROCESSED');
    expect(await historical.locator('img').count()).toBe(0);await expect(historical.getByRole('button',{ name:'Cancel historical job',exact:true })).toHaveCount(0);
    await page.getByRole('combobox',{ name:'Language',exact:true }).selectOption('ar');await page.setViewportSize({ width:390,height:844 });
    await historical.getByRole('heading',{ name:'مزامنة Meta التاريخية',exact:true }).scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/source-historical-ar.png' });
    await historical.getByRole('heading',{ name:'نتائج المزامنة التاريخية',exact:true }).scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/source-historical-results-ar.png' });
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.getByRole('combobox',{ name:'Language',exact:true }).selectOption('en');await page.setViewportSize({ width:1280,height:900 });
    await historical.getByRole('button',{ name:'Create historical preview',exact:true }).click();await expect(historical.getByRole('status')).toContainText('Preview queued');
    await control(page,{ historicalPreview:true,historicalFailure:true });
    await historical.getByRole('button',{ name:'Refresh historical jobs',exact:true }).click();await expect(historical.getByRole('status')).toContainText('Failed');
    await historical.getByLabel('Historical action reason',{ exact:true }).fill('Browser retry explicit failure');await historical.getByRole('button',{ name:'Retry historical job',exact:true }).click();
    await expect(historical.getByRole('status')).toContainText('Preview queued');await historical.getByLabel('Historical action reason',{ exact:true }).fill('Browser cancel preview');
    await historical.getByRole('button',{ name:'Cancel historical job',exact:true }).click();await expect(historical.getByRole('status')).toContainText('Cancelled');expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('source referral picks the proven Campaign over another active thread, preserves safe history and requires explicit review for unknown metadata',async({ browser })=> {
  // Serial prerequisite: Source journey above created and processed the historical Lead.
  const context=await browser.newContext({ storageState:managerStorageState });const page=await context.newPage();
  const errors:string[]=[];page.on('pageerror',(error)=>errors.push(error.message));
  try {
  await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
  await expect(page.getByRole('button',{ name:'Sign out',exact:true })).toBeVisible();
  await control(page,{ sourceReferenceFixture:true });
  const known=await control(page,{ sourceReferral:'KNOWN' });
  const attached=known.sourceReferenceEvents.find((event:{ provider_id:string })=>event.provider_id==='wamid.browser-source-KNOWN');
  expect(attached.state).toBe('PROCESSED');expect(attached.lead_id).toBeTruthy();
  const leadRow=page.getByRole('row').filter({ hasText:'Historical customer' }).filter({ hasText:'Browser Intake Campaign' });
  await leadRow.getByRole('button',{ name:'Details',exact:true }).click();
  const panel=page.locator('.conversation-panel');
  await panel.getByRole('button',{ name:'View messages',exact:true }).click();
  const message=panel.locator('.conversation-messages > li').filter({ has:page.getByText('Browser source referral KNOWN',{ exact:true }) });
  await expect(message).toContainText('Meta ad');await expect(message).toContainText('500001');
  await expect(message).toContainText('<img src=x onerror="window.__referralXss=true"> Ad caption');
  await expect(message.locator('img,a')).toHaveCount(0);expect(await page.evaluate(()=>Object.hasOwn(window,'__referralXss'))).toBe(false);
  const replay=await control(page,{ sourceReferral:'KNOWN' });expect(replay.sourceReferenceEvents).toHaveLength(1);
  expect((await (await page.request.get(`/api/conversations/${attached.conversation_id}/messages`)).json()).items
    .filter((item:{ body:string })=>item.body==='Browser source referral KNOWN')).toHaveLength(1);
  await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
  await message.locator('.message-source-reference').scrollIntoViewIfNeeded();await expect(message).toContainText('مرجع المصدر الوارد');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.screenshot({ path:'.local/e2e/messaging-source-reference-ar.png' });
  await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(message).toContainText('Référence de source entrante');
  await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.setViewportSize({ width:1280,height:900 });
  await control(page,{ sourceReferral:'UNKNOWN' });await page.getByRole('button',{ name:'Messaging setup',exact:true }).click();
  await page.getByRole('row').filter({ hasText:'Browser Media Connection' }).getByRole('button').click();
  const review=page.locator('.inbound-review');
  await review.getByRole('button',{ name:'Refresh',exact:true }).click();
  await review.locator('li').filter({ hasText:'SOURCE_REFERENCE_UNRESOLVED' }).getByRole('button',{ name:'Details',exact:true }).click();
  await expect(review).toContainText('999999');await expect(review.locator('img')).toHaveCount(0);
  await expect(review.getByRole('button',{ name:'Resolve',exact:true })).toBeDisabled();
  await review.getByLabel('Attach to',{ exact:true }).selectOption('lead:'+attached.lead_id);
  await expect(review.locator('.inbound-target-summary')).toContainText('Browser Intake Campaign');
  await review.getByRole('button',{ name:'Resolve',exact:true }).click();
  await expect(review.getByRole('button',{ name:'Resolve',exact:true })).toHaveCount(0);
  const history=(await (await page.request.get(`/api/conversations/${attached.conversation_id}/messages`)).json()).items;
  expect(history.find((item:{ body:string })=>item.body==='Browser source referral UNKNOWN').source_reference.externalId).toBe('999999');
  await control(page,{ sourceReferral:'INVALID' });await review.getByRole('button',{ name:'Refresh',exact:true }).click();
  await review.locator('li').filter({ hasText:'INBOUND_SOURCE_REFERENCE_INVALID' }).getByRole('button',{ name:'Details',exact:true }).click();
  await review.getByLabel('Attach to',{ exact:true }).selectOption('lead:'+attached.lead_id);
  await expect(review.getByRole('button',{ name:'Resolve',exact:true })).toBeDisabled();
  await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
  await review.getByRole('status').scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/messaging-source-review-ar.png' });
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
  await review.getByLabel('Reason to ignore',{ exact:true }).fill('Malformed provider reference retained for investigation');
  await review.getByRole('button',{ name:'Ignore and retain event',exact:true }).click();
  await expect(review.getByRole('button',{ name:'Resolve',exact:true })).toHaveCount(0);expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('Payment setup encrypts and rotates test keys, verifies authentication only, recovers failure and preserves scoped Arabic history',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState });const page=await context.newPage();const errors:string[]=[];
  page.on('pageerror',(error)=>errors.push(error.message));
  try {
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    await page.getByRole('button',{ name:'Payment setup',exact:true }).click();const panel=page.locator('.payment-setup');
    const name='Browser Payment <b>literal</b>';const key='rk_test_'+ 'browserSynthetic'.repeat(3);
    const beforeUnsupported=(await control(page)).paymentCalls;
    const unsupported=await page.request.post('/api/payments/connections',{ headers:{ origin:'http://127.0.0.1:4100' },
      data:{ name:'Unconfigured provider is not ready',provider:'MOLLIE',config:{ mode:'TEST' },credentials:{ apiKey:key } } });
    expect(unsupported.status()).toBe(400);expect((await control(page)).paymentCalls).toBe(beforeUnsupported);
    await panel.getByLabel('Payment connection name',{ exact:true }).fill(name);await panel.getByLabel('Payment API key',{ exact:true }).fill(key);
    await panel.getByRole('button',{ name:'Save payment connection',exact:true }).click();
    const row=panel.getByRole('row').filter({ hasText:name });await expect(row).toContainText('NOT_CONFIGURED');
    await expect(row.locator('b')).toHaveCount(0);await expect(panel.getByLabel('Payment API key',{ exact:true })).toHaveValue('');
    const connections=(await (await page.request.get('/api/payments/connections')).json()).items;const id=connections.find((item:{ name:string })=>item.name===name).id;
    expect(JSON.stringify(connections)).not.toContain(key);
    await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();await expect(row).toContainText('PAYMENT_FLOW_NOT_READY');
    await expect(panel).toContainText('VERIFIED');await expect(panel).toContainText('Account options and webhook verification are required');
    await control(page,{ paymentFailure:true });await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();
    await expect(panel.getByRole('alert')).toContainText('PAYMENT_PROVIDER_AUTH_FAILED');await expect(row).toContainText('AUTH_EXPIRED');await expect(panel).toContainText('FAILED');
    await panel.getByLabel('Payment connection change reason',{ exact:true }).fill('Browser verifies replacement before use');
    await panel.getByRole('button',{ name:'Disable payment connection',exact:true }).click();await expect(row).toContainText('DISABLED');
    await expect(panel.getByRole('button',{ name:'Test authentication',exact:true })).toBeDisabled();
    const before=(await control(page)).paymentCalls;
    const rejected=await page.request.post(`/api/payments/connections/${id}/test`,{ data:{ version:2 },headers:{ origin:'http://127.0.0.1:4100' } });
    expect(rejected.status()).toBe(409);expect((await control(page)).paymentCalls).toBe(before);
    await panel.getByRole('button',{ name:'Reconnect payment connection',exact:true }).click();await expect(row).toContainText('NOT_CONFIGURED');
    await panel.getByLabel('Payment API key',{ exact:true }).fill('rk_test_'+ 'browserReplacement'.repeat(3));
    await panel.getByRole('button',{ name:'Save payment connection',exact:true }).click();await expect(panel.getByLabel('Payment API key',{ exact:true })).toHaveValue('');
    await control(page,{ paymentFailure:false });await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();await expect(row).toContainText('WARNING');
    await expect(panel.getByRole('alert')).toHaveCount(0);expect((await (await page.request.get(`/api/payments/connections/${id}`)).json()).version).toBe(4);
    const agent=await browser.newContext({ storageState:agentStorageState });try {
      expect((await agent.request.get('/api/payments/connections')).status()).toBe(403);
      expect((await agent.request.get(`/api/payments/connections/${id}/history`)).status()).toBe(403);
    } finally { await agent.close(); }
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel.getByRole('heading',{ name:'Connexions de paiement',exact:true })).toBeVisible();
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await panel.getByRole('heading',{ name:'تاريخ اختبارات الدفع',exact:true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.screenshot({ path:'.local/e2e/payment-auth-history-ar.png' });expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('Branch Payment Methods support explicit shared accounts, scoped Agent/Campaign availability, immutable history and truthful payment readiness in the browser',async({ browser })=> {
  const admin=await browser.newContext({ storageState:adminStorageState });const page=await admin.newPage();const errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));
  const manager=await browser.newContext({ storageState:managerStorageState });const agent=await browser.newContext({ storageState:agentStorageState });
  try {
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    const detail=await (await page.request.get('/api/leads/'+fixture.noContactLeadId)).json();const lead=detail.lead;
    await page.getByRole('button',{ name:'Payment setup',exact:true }).click();const setup=page.locator('.payment-setup');
    await setup.getByLabel('Payment connection name',{ exact:true }).fill('Browser shared payment');
    await setup.getByLabel('Payment API key',{ exact:true }).fill('rk_test_'+'browserSharedSynthetic'.repeat(3));
    await setup.getByRole('button',{ name:'Save payment connection',exact:true }).click();
    await expect(setup.getByRole('row').filter({ hasText:'Browser shared payment' })).toContainText('NOT_CONFIGURED');
    const connection=(await (await page.request.get('/api/payments/connections')).json()).items.find((item:{ name:string })=>item.name==='Browser shared payment');
    await setup.getByRole('button',{ name:'Test authentication',exact:true }).click();await expect(setup.getByRole('row').filter({ hasText:'Browser shared payment' })).toContainText('WARNING');
    const methods=page.locator('.payment-methods');const name='Browser Method <img src=x>';
    await methods.getByLabel('Payment method name',{ exact:true }).fill(name);await methods.getByLabel('Payment method branch',{ exact:true }).selectOption(lead.branch_id);
    await expect(methods.getByLabel('Method provider connection',{ exact:true }).locator('option').filter({ hasText:'Browser shared payment' })).toHaveCount(1);
    await methods.getByLabel('Method provider connection',{ exact:true }).selectOption(connection.id);await methods.getByLabel('Method currencies',{ exact:true }).fill('USD, EUR');
    await methods.getByLabel('Method enabled',{ exact:true }).check();await methods.getByLabel('Agent availability',{ exact:true }).selectOption('SELECTED');
    await methods.getByLabel('Allowed payment Agents',{ exact:true }).selectOption([lead.assigned_agent_id]);
    await methods.getByLabel('Campaign availability',{ exact:true }).selectOption('SELECTED');await methods.getByLabel('Allowed payment Campaigns',{ exact:true }).selectOption([lead.campaign_id]);
    await methods.getByLabel('Payment method change reason',{ exact:true }).fill('Explicit shared account assigned to branch method');
    await methods.getByRole('button',{ name:'Save payment method',exact:true }).click();const row=methods.getByRole('row').filter({ hasText:name });
    await expect(row).toContainText('PAYMENT_WEBHOOK_VERIFICATION_REQUIRED');await expect(row.locator('img')).toHaveCount(0);await expect(methods).toContainText('Version: 1');
    const method=(await (await page.request.get('/api/payments/methods')).json()).items.find((item:{ name:string })=>item.name===name);
    const tab=await manager.newPage();tab.on('pageerror',(e)=>errors.push(e.message));await tab.goto('/');await tab.getByRole('combobox',{ name:'Language' }).selectOption('en');
    await tab.getByRole('button',{ name:'Payment setup',exact:true }).click();const managed=tab.locator('.payment-methods');
    await managed.getByRole('row').filter({ hasText:name }).getByRole('button',{ name:'Edit payment method',exact:true }).click();
    await expect(managed.getByLabel('Method provider connection',{ exact:true })).toHaveValue(connection.id);
    expect((await tab.request.get('/api/payments/connections/'+connection.id)).status()).toBe(404);
    await managed.getByLabel('Payment method name',{ exact:true }).fill('Manager maintained shared method');
    await managed.getByLabel('Payment method change reason',{ exact:true }).fill('Manager adjusts method without access to credentials');
    await managed.getByRole('button',{ name:'Save payment method',exact:true }).click();await expect(managed).toContainText('Version: 2');await expect(managed).toContainText(name);
    await managed.getByLabel('Method currencies',{ exact:true }).fill('XYZ');await managed.getByRole('button',{ name:'Save payment method',exact:true }).click();
    await expect(managed.getByRole('alert')).toContainText('PAYMENT_CURRENCIES_INVALID');expect((await (await tab.request.get('/api/payments/methods/'+method.id)).json()).version).toBe(2);
    await managed.getByLabel('Method currencies',{ exact:true }).fill('EUR');
    const customer=await agent.newPage();customer.on('pageerror',(e)=>errors.push(e.message));await customer.goto('/');await customer.getByRole('combobox',{ name:'Language' }).selectOption('en');
    await customer.getByRole('row').filter({ hasText:'Contact unavailable' }).getByRole('button',{ name:'Details',exact:true }).click();const available=customer.locator('.lead-payment-methods');
    await expect(available).toContainText('Manager maintained shared method');await expect(available).toContainText('PAYMENT_WEBHOOK_VERIFICATION_REQUIRED');
    expect((await customer.request.get('/api/payments/methods')).status()).toBe(403);expect((await customer.request.get('/api/payments/methods/'+method.id+'/history')).status()).toBe(403);
    const safe=await (await customer.request.get(`/api/leads/${fixture.noContactLeadId}/payment-methods`)).json();expect(JSON.stringify(safe)).not.toContain('connection_id');
    await managed.getByLabel('Method enabled',{ exact:true }).uncheck();await managed.getByRole('button',{ name:'Save payment method',exact:true }).click();await expect(managed).toContainText('Version: 3');
    await available.getByRole('button',{ name:'Refresh Lead payment methods',exact:true }).click();await expect(available).toContainText('No methods allowed for this Lead and user.');
    await managed.getByLabel('Method enabled',{ exact:true }).check();await managed.getByRole('button',{ name:'Save payment method',exact:true }).click();await expect(managed).toContainText('Version: 4');
    await tab.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(managed.getByRole('heading',{ name:'Moyens de paiement des agences',exact:true })).toBeVisible();
    await tab.setViewportSize({ width:390,height:844 });await tab.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await managed.getByRole('heading',{ name:'تاريخ طريقة الدفع: Manager maintained shared method',exact:true }).scrollIntoViewIfNeeded();
    expect(await tab.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await tab.screenshot({ path:'.local/e2e/payment-method-history-ar.png' });expect(errors).toEqual([]);
  } finally { await admin.close();await manager.close();await agent.close(); }
});

test('Payment provider options show safe country capabilities, fence credential rotation and retain failure/history without Checkout readiness',async({ browser })=> {
  const context=await browser.newContext({ storageState:adminStorageState });const page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));
  try {
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.getByRole('button',{ name:'Payment setup',exact:true }).click();
    const setup=page.locator('.payment-setup');const row=setup.getByRole('row').filter({ hasText:'Browser shared payment' });
    await row.getByRole('button',{ name:'Edit payment connection',exact:true }).click();await expect(setup.getByLabel('Payment connection name',{ exact:true })).toHaveValue('Browser shared payment');
    const connection=(await (await page.request.get('/api/payments/connections')).json()).items.find((item:{ name:string })=>item.name==='Browser shared payment');
    await setup.getByRole('button',{ name:'Inspect payment options',exact:true }).click();const options=page.locator('.payment-provider-options');
    await expect(options).toContainText('EUR, USD');await expect(options).toContainText('PENDING');await expect(options).toContainText('Country payment methods: ach, card');
    await expect(row).toContainText('PAYMENT_FLOW_NOT_READY');await expect(setup).toContainText('Country options do not prove account activation');
    let detail=await (await page.request.get('/api/payments/connections/'+connection.id)).json();expect(detail.capabilities.paymentOptions.chargesEnabled).toBe(false);
    expect(detail.capabilities.paymentLinksReady).toBe(false);expect(detail.capabilities.webhookReady).toBe(false);
    await setup.getByRole('button',{ name:'Test authentication',exact:true }).click();await expect(setup.getByRole('button',{ name:'Inspect payment options',exact:true })).toBeEnabled();
    await expect(options).toContainText('EUR, USD');
    await control(page,{ paymentFailure:true });await setup.getByRole('button',{ name:'Inspect payment options',exact:true }).click();
    await expect(setup.locator(':scope > [role=alert]')).toContainText('PAYMENT_PROVIDER_UNAVAILABLE');await expect(options).toHaveCount(0);await expect(row).toContainText('ERROR');
    const history=await (await page.request.get(`/api/payments/connections/${connection.id}/history`)).json();expect(history.items.some((p:{ purpose:string;state:string;options_snapshot:unknown })=>p.purpose==='OPTIONS' && p.state==='VERIFIED' && p.options_snapshot)).toBe(true);
    await control(page,{ paymentFailure:false });await setup.getByRole('button',{ name:'Inspect payment options',exact:true }).click();await expect(options).toContainText('EUR, USD');
    await setup.getByLabel('Payment API key',{ exact:true }).fill('rk_test_'+'browserOptionsReplacement'.repeat(3));
    await setup.getByRole('button',{ name:'Save payment connection',exact:true }).click();await expect(row).toContainText('NOT_CONFIGURED');await expect(options).toHaveCount(0);
    // The final inspected account becomes the public setup prerequisite for the request journey below.
    await control(page,{ paymentChargesEnabled:true });
    await setup.getByRole('button',{ name:'Inspect payment options',exact:true }).click();await expect(options).toContainText('EUR, USD');
    detail=await (await page.request.get('/api/payments/connections/'+connection.id)).json();expect(detail.version).toBe(2);expect(detail.capabilities.paymentOptionsVersion).toBe(2);
    const methods=page.locator('.payment-methods');await methods.getByRole('row').filter({ hasText:'Manager maintained shared method' }).getByRole('button',{ name:'Edit payment method',exact:true }).click();
    await methods.getByLabel('Method currencies',{ exact:true }).fill('GBP');await methods.getByLabel('Payment method change reason',{ exact:true }).fill('Browser rejects currency not offered by inspected provider');
    await methods.getByRole('button',{ name:'Save payment method',exact:true }).click();await expect(methods.getByRole('alert')).toContainText('PAYMENT_CURRENCY_NOT_OFFERED');await expect(methods).toContainText('Version: 4');
    await methods.getByRole('button',{ name:'New payment method',exact:true }).click();
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(options.getByRole('heading',{ name:'Options de paiement du fournisseur',exact:true })).toBeVisible();
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await options.getByRole('heading',{ name:'خيارات الدفع لدى المزود',exact:true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await page.screenshot({ path:'.local/e2e/payment-provider-options-ar.png' });expect(errors).toEqual([]);
  } finally { await control(page,{ paymentFailure:false,paymentChargesEnabled:false });await context.close(); }
});

test('Payment webhook UI prepares an immutable callback, verifies provider configuration and signed delivery separately and retains scoped safe failure/event history',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState });const page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));
  const secret='whsec_'+'BrowserSigningSyntheticOnly'.repeat(3);
  try {
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.getByRole('button',{ name:'Payment setup',exact:true }).click();
    const setup=page.locator('.payment-setup');await setup.getByRole('button',{ name:'New payment connection',exact:true }).click();
    await setup.getByLabel('Payment connection name',{ exact:true }).fill('Browser signed payment <img src=x>');
    await setup.getByLabel('Payment API key',{ exact:true }).fill('rk_test_'+'BrowserWebhookSyntheticOnly'.repeat(3));
    await setup.getByRole('button',{ name:'Save payment connection',exact:true }).click();
    await expect(setup.getByLabel('Payment API key',{ exact:true })).toHaveValue('');
    const row=setup.getByRole('row').filter({ hasText:'Browser signed payment <img src=x>' });await expect(row).toContainText('NOT_CONFIGURED');
    const panel=page.locator('.payment-webhooks');await panel.getByLabel('Webhook change reason',{ exact:true }).fill('Browser registers exact snapshot destination');
    await panel.getByRole('button',{ name:'Prepare payment callback',exact:true }).click();
    await expect(panel.getByLabel('Payment callback URL',{ exact:true })).toBeVisible();
    const url=await panel.getByLabel('Payment callback URL',{ exact:true }).inputValue();expect(url).toContain('/api/webhooks/payments/stripe/');
    await expect(panel).toContainText('This local HTTP URL cannot receive public Stripe deliveries');
    await panel.getByLabel('Stripe endpoint ID',{ exact:true }).fill('we_BrowserSynthetic123');await panel.getByLabel('Payment signing secret',{ exact:true }).fill(secret);
    await expect(panel.getByLabel('Payment signing secret',{ exact:true })).toHaveAttribute('type','password');
    await panel.getByRole('button',{ name:'Save webhook credentials',exact:true }).click();await expect(panel.getByLabel('Payment signing secret',{ exact:true })).toHaveCount(0);
    await panel.getByRole('button',{ name:'Test payment endpoint',exact:true }).click();
    await expect(panel.getByText('Provider endpoint verified',{ exact:true }).locator('..')).toContainText('Yes');
    await expect(panel.getByText('Signed delivery verified',{ exact:true }).locator('..')).toContainText('No');
    const connection=(await (await page.request.get('/api/payments/connections')).json()).items.find((item:{ name:string })=>item.name==='Browser signed payment <img src=x>');
    const id=new URL(url).pathname.split('/').at(-1)!;const root='/api/payments/connections/'+connection.id;const w=await page.request.get(root+'/webhooks/'+id);expect((await w.text()).includes(secret)).toBe(false);
    const payload=JSON.stringify({ id:'evt_BrowserSynthetic123',object:'event',type:'checkout.session.completed',livemode:false,created:1234567890,
      data:{ object:{ id:'cs_test_BrowserSynthetic123',object:'checkout.session',payment_status:'unpaid',amount_total:1250,currency:'usd',customer_email:'private-browser@example.test' } } });
    const timestamp=Math.floor(Date.now()/1000);const signature=`t=${timestamp},v1=${createHmac('sha256',secret).update(timestamp+'.').update(payload).digest('hex')}`;
    const send=(signed=signature)=>page.request.post(new URL(url).pathname,{ data:payload,headers:{ origin:new URL(url).origin,'content-type':'application/json','stripe-signature':signed } });
    expect((await send('t='+timestamp+',v1='+'0'.repeat(64))).status()).toBe(403);expect((await send()).ok()).toBe(true);expect((await (await send()).json()).duplicate).toBe(true);
    await panel.getByRole('button',{ name:'Refresh payment webhooks',exact:true }).click();await expect(panel.getByText('Signed delivery verified',{ exact:true }).locator('..')).toContainText('Yes');
    await expect(panel.locator('.payment-webhook-events')).toContainText('evt_BrowserSynthetic123');await expect(panel.locator('.payment-webhook-events li')).toHaveCount(1);
    await expect(panel).toContainText('QUEUED');expect(await panel.textContent()).not.toContain('private-browser');
    const receipt=(await (await page.request.get(root+'/webhook-events')).json());expect(receipt.items).toHaveLength(1);expect(receipt.items[0].attempts).toBe(0);
    const agent=await browser.newContext({ storageState:agentStorageState });try { expect((await agent.request.get(root+'/webhook-events')).status()).toBe(403); }finally{ await agent.close(); }
    await control(page,{ paymentFailure:true });await panel.getByRole('button',{ name:'Test payment endpoint',exact:true }).click();await expect(panel.getByRole('alert')).toContainText('PAYMENT_PROVIDER_AUTH_FAILED');
    await expect(panel.getByText('Provider endpoint verified',{ exact:true }).locator('..')).toContainText('No');await expect(panel).toContainText('FAILED');
    await control(page,{ paymentFailure:false });await panel.getByRole('button',{ name:'Test payment endpoint',exact:true }).click();await expect(panel.getByText('Provider endpoint verified',{ exact:true }).locator('..')).toContainText('Yes');
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel.getByRole('heading',{ name:'Webhooks de paiement',exact:true })).toBeVisible();
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await panel.getByRole('heading',{ name:'Webhooks الدفع',exact:true }).scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.screenshot({ path:'.local/e2e/payment-webhook-ar.png' });expect(errors).toEqual([]);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await panel.getByLabel('Webhook change reason',{ exact:true }).fill('Browser reconciled pending payments and disables endpoint');
    await panel.getByRole('button',{ name:'Disable payment webhook',exact:true }).click();await expect(panel.locator('.payment-webhook-detail')).toContainText('DISABLED');
    expect((await send()).status()).toBe(409);await expect(panel.locator('.payment-webhook-events')).toContainText('evt_BrowserSynthetic123');
  }finally{ await control(page,{ paymentFailure:false });await context.close(); }
});

test('browser saves an exact idempotent payment request with scoped setup and immutable history without claiming a customer link',async({ browser })=> {
  expect(adminStorageState).toBeTruthy();expect(agentStorageState).toBeTruthy();
  const admin=await browser.newContext({ storageState:adminStorageState });const adminPage=await admin.newPage();
  const agent=await browser.newContext({ storageState:agentStorageState });const page=await agent.newPage();const errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));
  try {
    await adminPage.goto('/');await control(adminPage,{ paymentChargesEnabled:true,paymentFailure:false,assigned:'agent' });
    const origin='http://127.0.0.1:4100';const api=async(path:string,body:object)=> {
      const response=await adminPage.request.post(path,{ data:body,headers:{ origin } });expect(response.ok(),await response.text()).toBe(true);return response.json();
    };
    const lead=(await (await adminPage.request.get('/api/leads/'+fixture.leadId)).json()).lead;
    const connection=(await (await adminPage.request.get('/api/payments/connections')).json()).items.find((item:{ name:string })=>item.name==='Browser shared payment');
    expect(connection).toBeTruthy();expect(connection.capabilities.paymentOptions.chargesEnabled).toBe(true);
    const root='/api/payments/connections/'+connection.id;
    const webhook=await api(root+'/webhooks',{ connectionVersion:connection.version,reason:'Browser registers request destination' });
    const secret='whsec_'+'BrowserRequestSyntheticOnly'.repeat(3);
    await api(root+'/webhooks/'+webhook.id+'/configure',{ version:1,endpointId:'we_BrowserRequestSynthetic123',signingSecret:secret,reason:'Registered exact endpoint' });
    await api(root+'/webhooks/'+webhook.id+'/test',{ version:2,connectionVersion:connection.version });
    const payload=JSON.stringify({ id:'evt_BrowserRequestSynthetic123',object:'event',type:'checkout.session.expired',livemode:false,created:1234567890,
      data:{ object:{ id:'cs_test_BrowserRequestSynthetic123',object:'checkout.session' } } });
    const timestamp=Math.floor(Date.now()/1000);const signature=`t=${timestamp},v1=${createHmac('sha256',secret).update(timestamp+'.').update(payload).digest('hex')}`;
    expect((await adminPage.request.post(new URL(webhook.callback_url).pathname,{ data:payload,headers:{ origin,'content-type':'application/json','stripe-signature':signature } })).ok()).toBe(true);
    const method=await api('/api/payments/methods',{ name:'Browser request <img src=x>',branchId:lead.branch_id,connectionId:connection.id,currencies:['USD'],active:true,
      agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'SELECTED',ids:[lead.campaign_id] },reason:'Browser selects allowed Campaign' });
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    await page.getByRole('row').filter({ hasText:'Browser Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    const panel=page.locator('.lead-payment-requests');await expect(panel.getByRole('heading',{ name:'Payment link requests',exact:true })).toBeVisible();
    await panel.getByLabel('Payment request method',{ exact:true }).selectOption(method.id);
    await panel.getByLabel('Payment request amount',{ exact:true }).fill('12.501');await panel.getByRole('button',{ name:'Save payment link request',exact:true }).click();
    await expect(panel.getByRole('alert')).toContainText('PAYMENT_AMOUNT_PRECISION_INVALID');
    await panel.getByLabel('Payment request amount',{ exact:true }).fill('12.5');
    const responsePromise=page.waitForResponse((r)=>r.request().method()==='POST' && r.url().endsWith('/payment-link-requests'));
    await panel.getByRole('button',{ name:'Save payment link request',exact:true }).click();const response=await responsePromise;expect(response.status()).toBe(201);
    const saved=await response.json();expect(saved.customerUrl).toBe(null);expect(saved.state).toBe('QUEUED');expect(saved.paymentState).toBe(null);
    await expect(panel.getByRole('status')).toContainText('Request saved once');await expect(panel.locator('.payment-request-history')).toContainText('12.50 USD');
    expect((await (await page.request.post(`/api/leads/${fixture.leadId}/payment-link-requests`,{ data:response.request().postDataJSON(),headers:{ origin } })).json()).duplicate).toBe(true);
    await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();await expect(panel.locator('.payment-request-history li')).toHaveCount(1);
    await expect(panel.locator('img')).toHaveCount(0);expect(await panel.textContent()).not.toContain(secret);expect((await page.request.get(root)).status()).toBe(403);
    expect((await page.request.post(`/api/leads/${fixture.leadId}/payment-link-requests`,{ data:{ ...response.request().postDataJSON(),requestId:randomUUID(),amount:'1e3' },headers:{ origin } })).status()).toBe(400);
    await page.reload();await page.getByRole('row').filter({ hasText:'Browser Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    await expect(page.locator('.payment-request-history')).toContainText('12.50 USD');
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel.getByRole('heading',{ name:'Demandes de liens de paiement',exact:true })).toBeVisible();await expect(panel).toHaveCount(1);
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await panel.getByRole('heading',{ name:'طلبات روابط الدفع',exact:true }).scrollIntoViewIfNeeded();await expect(panel).toHaveCount(1);
    await expect(panel.locator('.payment-request-history')).toContainText('بانتظار الإصدار');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.screenshot({ path:'.local/e2e/payment-request-ar.png' });expect(errors).toEqual([]);
  }finally { await control(adminPage,{ paymentChargesEnabled:false });await admin.close();await agent.close(); }
});

test('browser issues a safe Checkout link and shows trusted Payment and separate Enrollment; success return and reassignment enforce scope',async({ browser })=> {
  expect(agentStorageState).toBeTruthy();expect(adminStorageState).toBeTruthy();
  const agent=await browser.newContext({ storageState:agentStorageState,permissions:['clipboard-read','clipboard-write'] });const page=await agent.newPage();
  const admin=await browser.newContext({ storageState:adminStorageState });const adminPage=await admin.newPage();const errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));
  try {
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    await page.getByRole('row').filter({ hasText:'Browser Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    const panel=page.locator('.lead-payment-requests');await expect(panel.locator('.payment-request-history')).toContainText('Waiting for issuance');
    const root=`/api/leads/${fixture.leadId}/payment-link-requests`;const before=(await (await page.request.get(root)).json()).items[0];expect(before.paymentState).toBe(null);
    await control(adminPage,{ paymentDispatch:true });await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();
    await expect(panel.locator('.payment-request-history')).toContainText('Link issued');const link=panel.getByRole('link',{ name:'Open payment link',exact:true });
    await expect(link).toHaveAttribute('href',/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    await panel.getByRole('button',{ name:'Copy payment link',exact:true }).click();await expect(panel.getByRole('status')).toContainText('Link copied.');
    expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(await link.getAttribute('href'));
    await panel.getByRole('button',{ name:'Issuance attempts',exact:true }).click();await expect(panel).toContainText('ACKNOWLEDGED');
    await page.goto('/?paymentReturn=success');await page.getByRole('row').filter({ hasText:'Browser Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    expect((await (await page.request.get(root)).json()).items[0].enrollmentId).toBe(null);await expect(panel).not.toContainText('Payment confirmed');
    await control(adminPage,{ paymentPaid:before.id,paymentReceipts:true });await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();
    await expect(panel).toContainText('Payment confirmed');await expect(panel).toContainText('Enrollment confirmed');await expect(panel.getByRole('link',{ name:'Open payment link',exact:true })).toHaveCount(0);
    const confirmed=(await (await page.request.get(root)).json()).items[0];expect(confirmed.enrollmentId).toBeTruthy();expect(confirmed.paymentReference).toMatch(/^pi_/);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel).toContainText('Inscription confirmée');
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await panel.getByRole('heading',{ name:'طلبات روابط الدفع',exact:true }).scrollIntoViewIfNeeded();await expect(panel).toHaveCount(1);
    await expect(panel).toContainText('دفع مؤكد');await expect(panel).toContainText('اشتراك مؤكد');await expect(panel.locator('img')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await panel.locator('.payment-request-history').scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/payment-confirmation-ar.png' });
    await control(adminPage,{ assigned:'second' });expect((await page.request.get(root)).status()).toBe(404);expect((await page.request.get(root+'/'+before.id+'/attempts')).status()).toBe(404);
    expect((await page.request.get(root+'/'+before.id)).status()).toBe(404);
    expect(errors).toEqual([]);
  }finally { await control(adminPage,{ assigned:'agent' });await agent.close();await admin.close(); }
});

test('browser authorizes receipt credential repair through scoped setup and retains verification history without a new payment write',async({ browser })=> {
  const admin=await browser.newContext({ storageState:adminStorageState });const rootPage=await admin.newPage();
  const agent=await browser.newContext({ storageState:agentStorageState });const page=await agent.newPage();const errors:string[]=[];rootPage.on('pageerror',(e)=>errors.push(e.message));
  try {
    const origin='http://127.0.0.1:4100';const connection=(await (await rootPage.request.get('/api/payments/connections')).json()).items.find((row:{ name:string })=>row.name==='Browser shared payment');
    const options=(await (await page.request.get(`/api/leads/${fixture.leadId}/payment-link-options`)).json()).items.find((row:{ name:string })=>row.name==='Browser request <img src=x>');
    const saved=await page.request.post(`/api/leads/${fixture.leadId}/payment-link-requests`,{ data:{ requestId:randomUUID(),methodId:options.id,methodVersion:options.version,amount:'25',currency:'USD' },headers:{ origin } });
    expect(saved.status()).toBe(201);const id=(await saved.json()).id;
    await control(rootPage,{ paymentDispatch:true });await control(rootPage,{ paymentPaid:id,paymentReceiptAuthFailure:true,paymentReceipts:true });
    const cr='/api/payments/connections/'+connection.id;const receipts=(await (await rootPage.request.get(cr+'/webhook-events')).json()).items;
    const receipt=receipts.find((row:{ error_code:string;attempts:number })=>row.error_code==='PAYMENT_PROVIDER_AUTH_FAILED' && row.attempts===1);expect(receipt).toBeTruthy();
    expect((await page.request.post(cr+'/webhook-events/'+receipt.id+'/retry',{ data:{ attempts:1,reason:'Unauthorized repair attempt',useCurrentCredentials:true,connectionVersion:connection.version },headers:{ origin } })).status()).toBe(403);
    await rootPage.goto('/');await rootPage.getByRole('combobox',{ name:'Language' }).selectOption('en');await rootPage.getByRole('button',{ name:'Payment setup',exact:true }).click();
    await rootPage.locator('.payment-setup').getByRole('row').filter({ hasText:'Browser shared payment' }).getByRole('button',{ name:'Edit payment connection',exact:true }).click();
    const panel=rootPage.locator('.payment-webhooks');const event=panel.locator('.payment-webhook-events > li').filter({ hasText:receipt.external_event_id });
    await expect(event).toContainText('NEEDS_ATTENTION');await expect(event.getByRole('button',{ name:'Retry receipt verification',exact:true })).toBeDisabled();
    await panel.getByLabel('Webhook change reason',{ exact:true }).fill('Provider read permission repaired; use the verified current account');
    await panel.getByRole('checkbox',{ name:'Use verified current connection credentials for this receipt',exact:true }).check();
    await control(rootPage,{ paymentReceiptAuthFailure:false });
    await event.getByRole('button',{ name:'Retry receipt verification',exact:true }).click();await expect(event).toContainText('RETRY');
    await control(rootPage,{ paymentReceipts:true });await panel.getByRole('button',{ name:'Refresh payment webhooks',exact:true }).click();await expect(event).toContainText('PROCESSED');
    await event.getByRole('button',{ name:'Receipt verification attempts',exact:true }).click();await expect(event.locator('.receipt-verification-history')).toContainText('Approved replacement credentials');
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.getByRole('row').filter({ hasText:'Browser Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    const result=(await (await page.request.get(`/api/leads/${fixture.leadId}/payment-link-requests`)).json()).items.find((row:{ id:string })=>row.id===id);expect(result.paymentState).toBe('CONFIRMED');expect(result.enrollmentId).toBeTruthy();
    await rootPage.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel).toContainText('Identifiants de remplacement approuvés');
    await rootPage.setViewportSize({ width:390,height:844 });await rootPage.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await panel.getByText('بيانات بديلة معتمدة',{ exact:true }).scrollIntoViewIfNeeded();await rootPage.screenshot({ path:'.local/e2e/payment-repair-ar.png' });
    expect(await rootPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await control(rootPage,{ paymentReceiptAuthFailure:false });await admin.close();await agent.close(); }
});

test('browser prepares scoped payment messages without overwriting drafts, sends text and approved templates through policy and rejects stale links',async({ browser })=> {
  const admin=await browser.newContext({ storageState:adminStorageState });const rootPage=await admin.newPage();
  const agent=await browser.newContext({ storageState:agentStorageState });const page=await agent.newPage();const errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));
  const origin='http://127.0.0.1:4100';const lr='/api/leads/'+fixture.mediaLeadId;const requests=lr+'/payment-link-requests';
  async function rootPost(path:string,data:object) { const r=await rootPage.request.post(path,{ data,headers:{ origin } });expect(r.ok(),await r.text()).toBe(true);return r.json(); }
  async function setDnc(value:boolean) { const c=(await (await rootPage.request.get(lr+'/messaging-consent')).json());
    const r=await rootPage.request.put(lr+'/messaging-consent',{ data:{ version:c.version,status:'GRANTED',doNotContact:value,source:'TEST',evidence:'Browser payment policy check' },headers:{ origin } });expect(r.ok(),await r.text()).toBe(true); }
  try {
    await control(rootPage,{ paymentChargesEnabled:true });
    const lead=(await (await rootPage.request.get(lr)).json()).lead;
    const connection=(await (await rootPage.request.get('/api/payments/connections')).json()).items.find((row:{ name:string })=>row.name==='Browser shared payment');
    const method=await rootPost('/api/payments/methods',{ name:'Messaging payment <img src=x>',branchId:lead.branch_id,connectionId:connection.id,currencies:['USD'],active:true,
      agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'ALL',ids:[] },reason:'Approved messaging payment method' });
    const saved=await page.request.post(requests,{ data:{ requestId:randomUUID(),methodId:method.id,methodVersion:method.version,amount:'35',currency:'USD' },headers:{ origin } });expect(saved.status()).toBe(201);
    const id=(await saved.json()).id;await control(rootPage,{ paymentDispatch:true });
    const dto=(await (await page.request.get(requests+'/'+id)).json());const url=dto.customerUrl;expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\//);
    const mc=(await (await rootPage.request.get('/api/messaging/connections')).json()).items.find((row:{ name:string })=>row.name==='Browser Media Connection');
    await rootPost('/api/messaging/connections/'+mc.id+'/templates',{ name:'browser_payment_url',language:'en_US',category:'UTILITY',body:'Payment details',
      buttons:[{ type:'URL',text:'Pay securely',url:'https://checkout.stripe.com/c/pay/{{1}}' }],urlExample:'cs_test_ApprovalOnly123',idempotencyKey:randomUUID() });
    await control(rootPage,{ approveTemplates:true });await rootPost('/api/messaging/connections/'+mc.id+'/templates/sync',{});
    const available=(await (await rootPage.request.get('/api/messaging/campaigns/'+lead.campaign_id+'/templates')).json()).items.find((row:{ name:string })=>row.name==='browser_payment_url');
    const bound=await rootPage.request.put('/api/messaging/campaigns/'+lead.campaign_id+'/templates/'+available.id,{ data:{ version:available.version,bound:true },headers:{ origin } });expect(bound.ok(),await bound.text()).toBe(true);
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.getByRole('row').filter({ hasText:'Browser Media Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    const panel=page.locator('.conversation-panel');const payments=page.locator('.lead-payment-requests');await panel.getByRole('button',{ name:'View messages',exact:true }).click();
    const original='Reviewed payment details <img src=x>';await panel.getByLabel('Message text',{ exact:true }).fill(original);const before=await control(rootPage);
    await payments.getByRole('button',{ name:'Prepare payment message',exact:true }).click();await expect(panel.locator('.payment-message-selection')).toContainText(url);
    await expect(panel.getByLabel('Message text',{ exact:true })).toHaveValue(original);expect((await control(rootPage)).messages).toHaveLength(before.messages.length);
    await panel.getByRole('button',{ name:'Insert payment link into text',exact:true }).click();await expect(panel.getByLabel('Message text',{ exact:true })).toHaveValue(original+'\n'+url);
    await setDnc(true);await panel.getByRole('button',{ name:'Queue message',exact:true }).click();await expect(panel.getByRole('alert')).toContainText('DO_NOT_CONTACT');expect((await control(rootPage)).messages).toHaveLength(before.messages.length);
    await setDnc(false);const textQueued=page.waitForResponse((r)=>r.url().endsWith('/messages') && r.request().method()==='POST');
    await panel.getByRole('button',{ name:'Queue message',exact:true }).click();expect((await textQueued).status()).toBe(202);await control(rootPage,{ process:true,mode:'accept' });
    await panel.getByRole('button',{ name:'View messages',exact:true }).click();const text=panel.locator('.conversation-messages > li').filter({ hasText:original+'\n'+url });await expect(text).toContainText('SENT');await expect(text.locator('img')).toHaveCount(0);
    await panel.getByLabel('Message type',{ exact:true }).selectOption('TEMPLATE');await panel.getByLabel('Template',{ exact:true }).selectOption({ label:'browser_composite_notice · en_US' });
    await panel.getByRole('button',{ name:'Use payment link for this parameter 1',exact:true }).click();await expect(panel.getByLabel('Parameter 1',{ exact:true })).toHaveValue(url);
    const queued=page.waitForResponse((r)=>r.url().endsWith('/messages') && r.request().method()==='POST');await panel.getByRole('button',{ name:'Queue message',exact:true }).click();const templateResponse=await queued;expect(templateResponse.status()).toBe(202);
    const replay=await page.request.post(new URL(templateResponse.url()).pathname,{ data:templateResponse.request().postDataJSON(),headers:{ origin } });expect(replay.status()).toBe(200);
    await control(rootPage,{ process:true });await panel.getByRole('button',{ name:'View messages',exact:true }).click();await expect(panel.locator('.conversation-messages > li').filter({ hasText:'Dear '+url+', your request is received.' })).toContainText('SENT');
    await panel.getByLabel('Template',{ exact:true }).selectOption({ label:'browser_dynamic_url · en_US' });await panel.getByRole('button',{ name:'Insert payment link in URL button',exact:true }).click();await expect(panel.getByRole('alert')).toContainText('PAYMENT_TEMPLATE_URL_INCOMPATIBLE');
    await panel.getByLabel('Template',{ exact:true }).selectOption({ label:'browser_payment_url · en_US' });await panel.getByRole('button',{ name:'Insert payment link in URL button',exact:true }).click();
    const composer=panel.locator('form.workflow-form').first();await expect(composer.getByRole('link',{ name:/Pay securely/ })).toHaveAttribute('href',url);
    const urlQueued=page.waitForResponse((r)=>r.url().endsWith('/messages') && r.request().method()==='POST');
    await panel.getByRole('button',{ name:'Queue message',exact:true }).click();expect((await urlQueued).status()).toBe(202);await control(rootPage,{ process:true });await panel.getByRole('button',{ name:'View messages',exact:true }).click();
    const buttonMessage=panel.locator('.conversation-messages > li').filter({ has:page.getByRole('link',{ name:/Pay securely/ }) });await expect(buttonMessage).toContainText('SENT');await expect(buttonMessage.getByRole('link',{ name:/Pay securely/ })).toHaveAttribute('href',url);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel.locator('.payment-message-selection')).toContainText('Lien de paiement sélectionné');
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await panel.locator('.payment-message-selection').scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/payment-message-ar.png' });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await panel.getByLabel('Message type',{ exact:true }).selectOption('TEXT');await panel.getByLabel('Message text',{ exact:true }).fill('Preserve this draft');
    await control(rootPage,{ paymentPaid:id,paymentReceipts:true });await panel.getByRole('button',{ name:'Insert payment link into text',exact:true }).click();await expect(panel.getByRole('alert')).toContainText('The link is no longer available');await expect(panel.getByLabel('Message text',{ exact:true })).toHaveValue('Preserve this draft');
    expect((await (await page.request.get(requests+'/'+id)).json()).customerUrl).toBe(null);expect(errors).toEqual([]);
  }finally { await setDnc(false);await control(rootPage,{ paymentChargesEnabled:false });await admin.close();await agent.close(); }
});

test('browser configures scoped PayPal client credentials, rotates and recovers authentication without claiming payee or payment readiness',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });const page=await context.newPage();const errors:string[]=[];
  page.on('pageerror',(error)=>errors.push(error.message));
  try {
    await control(page,{ paymentFailure:false });await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    await page.getByRole('button',{ name:'Payment setup',exact:true }).click();const panel=page.locator('.payment-setup');
    await panel.getByLabel('Payment provider',{ exact:true }).selectOption('PAYPAL');
    const name='PayPal browser <img literal>';const clientId='BrowserPayPalClientSynthetic_123456';const secret='BrowserPayPalSecretSynthetic_123456';
    await panel.getByLabel('Payment connection name',{ exact:true }).fill(name);
    await panel.getByLabel('PayPal Client ID',{ exact:true }).fill(clientId);await panel.getByLabel('PayPal Client Secret',{ exact:true }).fill(secret);
    await panel.getByRole('button',{ name:'Save payment connection',exact:true }).click();const row=panel.getByRole('row').filter({ hasText:name });
    await expect(row).toContainText('PAYPAL');await expect(row).toContainText('NOT_CONFIGURED');await expect(row.locator('img')).toHaveCount(0);
    await expect(panel.getByLabel('PayPal Client ID',{ exact:true })).toHaveValue('');await expect(panel.getByLabel('PayPal Client Secret',{ exact:true })).toHaveValue('');
    await expect(panel.getByLabel('Payment provider',{ exact:true })).toBeDisabled();await expect(panel.getByRole('button',{ name:'Inspect payment options',exact:true })).toHaveCount(0);
    await expect(panel.locator('.payment-webhooks')).toHaveCount(1);await expect(panel).toContainText('not payee identity or completed capture');
    const items=(await (await page.request.get('/api/payments/connections')).json()).items;const id=items.find((i:{ name:string })=>i.name===name).id;
    expect(JSON.stringify(items)).not.toContain(secret);expect(JSON.stringify(items)).not.toContain(clientId);
    const authResponse=page.waitForResponse((response)=>response.url().endsWith('/'+id+'/test') && response.request().method()==='POST');
    await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();expect((await authResponse).status()).toBe(200);await expect(row).toContainText('WARNING');await expect(panel).toContainText('VERIFIED');
    const detail=await (await page.request.get(`/api/payments/connections/${id}`)).json();expect(detail.capabilities.authenticationVerified).toBe(true);
    expect(detail.capabilities.paymentLinksReady).toBe(false);expect(detail.capabilities.webhookReady).toBe(false);expect(detail.capabilities.paymentOptions).toBeUndefined();
    await control(page,{ paymentFailure:true });await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();await expect(row).toContainText('AUTH_EXPIRED');
    await expect(panel.getByRole('alert').first()).toContainText('PAYMENT_PROVIDER_AUTH_FAILED');
    await panel.getByLabel('Payment connection change reason',{ exact:true }).fill('Verify PayPal replacement before use');
    await panel.getByRole('button',{ name:'Disable payment connection',exact:true }).click();await expect(row).toContainText('DISABLED');
    await expect(panel.getByRole('button',{ name:'Test authentication',exact:true })).toBeDisabled();
    await panel.getByRole('button',{ name:'Reconnect payment connection',exact:true }).click();await expect(row).toContainText('NOT_CONFIGURED');
    await panel.getByLabel('PayPal Client ID',{ exact:true }).fill('BrowserPayPalRotatedClient_123456');await panel.getByLabel('PayPal Client Secret',{ exact:true }).fill('BrowserPayPalRotatedSecret_123456');
    await panel.getByRole('button',{ name:'Save payment connection',exact:true }).click();await expect(panel.getByLabel('PayPal Client Secret',{ exact:true })).toHaveValue('');
    await control(page,{ paymentFailure:false });await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();await expect(row).toContainText('WARNING');
    const agent=await browser.newContext({ storageState:agentStorageState });try {
      expect((await agent.request.get(`/api/payments/connections/${id}`)).status()).toBe(403);expect((await agent.request.get(`/api/payments/connections/${id}/history`)).status()).toBe(403);
    }finally { await agent.close(); }
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel).toContainText('Le test OAuth');
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await panel.getByRole('heading',{ name:'تاريخ اختبارات الدفع',exact:true }).scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/paypal-auth-ar.png' });
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await control(page,{ paymentFailure:false });await context.close(); }
});

test('browser configures expected PayPal beneficiary with immutable history, stale edit denial, cleared credentials and truthful identity status',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });const page=await context.newPage();const errors:string[]=[];
  const headers={ origin:'http://127.0.0.1:4100' };
  page.on('pageerror',(error)=>errors.push(error.message));
  try {
    await control(page,{ paymentFailure:false });await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    await page.getByRole('button',{ name:'Payment setup',exact:true }).click();const setup=page.locator('.payment-setup');await setup.getByLabel('Payment provider',{ exact:true }).selectOption('PAYPAL');
    const a='ABCD234EFGH56';const b='JKLM234NPQR56';const c='RSTU234VWXY56';const name='PayPal beneficiary browser <img literal>';
    await setup.getByLabel('Payment connection name',{ exact:true }).fill(name);await setup.getByLabel('Expected PayPal Merchant ID',{ exact:true }).fill(a);
    await setup.getByLabel('PayPal Client ID',{ exact:true }).fill('BrowserBeneficiaryClient_123456');await setup.getByLabel('PayPal Client Secret',{ exact:true }).fill('BrowserBeneficiarySecret_123456');
    await setup.getByRole('button',{ name:'Save payment connection',exact:true }).click();const row=setup.getByRole('row').filter({ hasText:name });await expect(row).toContainText('NOT_CONFIGURED');
    const items=(await (await page.request.get('/api/payments/connections')).json()).items;const id=items.find((i:{ name:string })=>i.name===name).id;const path='/api/payments/connections/'+id;
    const history=setup.locator('.payment-beneficiary-history');await expect(history).toContainText(a);await expect(history).toContainText('not provider verified');await expect(history.locator('li')).toHaveCount(1);
    await expect(setup.getByLabel('PayPal Client Secret',{ exact:true })).toHaveValue('');await expect(setup.getByLabel('PayPal Client ID',{ exact:true })).toHaveValue('');
    expect((await page.request.put(path,{ headers,data:{ name,provider:'PAYPAL',config:{ mode:'TEST',expectedMerchantId:'ABCD234EFGH51' },version:1 } })).status()).toBe(400);
    await setup.getByRole('button',{ name:'Test authentication',exact:true }).click();await expect(row).toContainText('WARNING');
    const authenticated=await (await page.request.get(path)).json();expect(authenticated.capabilities.authenticationVerified).toBe(true);expect(authenticated.capabilities.paymentLinksReady).toBe(false);expect(authenticated.capabilities.paymentOptions).toBeUndefined();
    await setup.getByLabel('Expected PayPal Merchant ID',{ exact:true }).fill(b);
    expect((await page.request.put(path,{ headers,data:{ name,provider:'PAYPAL',config:{ mode:'TEST',expectedMerchantId:c },version:1 } })).status()).toBe(200);
    await setup.getByRole('button',{ name:'Refresh payment connections',exact:true }).click();await expect(row).toContainText('NOT_CONFIGURED');
    const conflict=page.waitForResponse((r)=>r.url().endsWith('/'+id) && r.request().method()==='PUT');await setup.getByRole('button',{ name:'Save payment connection',exact:true }).click();expect((await conflict).status()).toBe(409);
    await expect(setup.getByRole('alert').first()).toContainText('CONNECTION_VERSION_CONFLICT');await expect(setup.getByLabel('Expected PayPal Merchant ID',{ exact:true })).toHaveValue(b);
    expect((await (await page.request.get(path)).json()).config.expectedMerchantId).toBe(c);
    await row.getByRole('button',{ name:'Edit payment connection',exact:true }).click();await expect(setup.getByLabel('Expected PayPal Merchant ID',{ exact:true })).toHaveValue(c);
    await setup.getByLabel('Expected PayPal Merchant ID',{ exact:true }).fill(b);await setup.getByRole('button',{ name:'Save payment connection',exact:true }).click();await expect(history.locator('li')).toHaveCount(3);
    await expect(history).toContainText(a);await expect(history).toContainText(b);await expect(history).toContainText(c);await expect(row.locator('img')).toHaveCount(0);
    await setup.getByLabel('Expected PayPal Merchant ID',{ exact:true }).fill('');await setup.getByRole('button',{ name:'Save payment connection',exact:true }).click();await expect(history.locator('li')).toHaveCount(4);await expect(history).toContainText('No beneficiary configured');
    const detail=await (await page.request.get(path)).json();expect(detail.config.expectedMerchantId).toBeUndefined();expect(detail.capabilities).toEqual({});
    expect(JSON.stringify(await (await page.request.get(path+'/beneficiary-history')).json())).not.toContain('BrowserBeneficiarySecret');
    const agent=await browser.newContext({ storageState:agentStorageState });try {
      expect((await agent.request.get(path+'/beneficiary-history')).status()).toBe(403);const denied=await agent.request.put(path,{ headers,data:{ name,provider:'PAYPAL',config:{ mode:'TEST',expectedMerchantId:a },version:4 } });expect(denied.status()).toBe(403);expect((await denied.json()).error).toBe('FORBIDDEN');
    }finally { await agent.close(); }
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(history).toContainText('non vérifié par le fournisseur');
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await history.scrollIntoViewIfNeeded();
    await expect(history).toContainText('إعداد فقط');await page.screenshot({ path:'.local/e2e/paypal-beneficiary-ar.png' });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await control(page,{ paymentFailure:false });await context.close(); }
});

test('browser configures PayPal Webhook ID, verifies RSA receipt and duplicate/failure history without treating callback claims as paid',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });const page=await context.newPage();const errors:string[]=[];
  page.on('pageerror',(error)=>errors.push(error.message));
  try {
    await control(page,{ paymentFailure:false });await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.getByRole('button',{ name:'Payment setup',exact:true }).click();
    const setup=page.locator('.payment-setup');await setup.getByLabel('Payment provider',{ exact:true }).selectOption('PAYPAL');
    const name='PayPal signed callback <img literal>';await setup.getByLabel('Payment connection name',{ exact:true }).fill(name);
    await setup.getByLabel('PayPal Client ID',{ exact:true }).fill('BrowserWebhookClient_123456');await setup.getByLabel('PayPal Client Secret',{ exact:true }).fill('BrowserWebhookSecret_123456');
    await setup.getByRole('button',{ name:'Save payment connection',exact:true }).click();await expect(setup.getByRole('row').filter({ hasText:name })).toContainText('PAYPAL');
    const connection=(await (await page.request.get('/api/payments/connections')).json()).items.find((item:{ name:string })=>item.name===name);const root='/api/payments/connections/'+connection.id;
    const panel=page.locator('.payment-webhooks');await expect(panel).toContainText('No signing secret is required');
    await panel.getByLabel('Webhook change reason',{ exact:true }).fill('Register exact app callback from PayPal');await panel.getByRole('button',{ name:'Prepare payment callback',exact:true }).click();
    const url=await panel.getByLabel('Payment callback URL',{ exact:true }).inputValue();expect(url).toContain('/api/webhooks/payments/paypal/');
    await expect(panel).toContainText('CHECKOUT.ORDER.APPROVED');await expect(panel).toContainText('PAYMENT.CAPTURE.DECLINED');await expect(panel.getByLabel('Payment signing secret',{ exact:true })).toHaveCount(0);
    const id=new URL(url).pathname.split('/').at(-1)!;const path=root+'/webhooks/'+id;
    const wrong=await page.request.post(path+'/configure',{ data:{ version:1,endpointId:'we_WrongProvider123',reason:'Foreign Stripe endpoint denied' },headers:{ origin:new URL(url).origin } });expect(wrong.status()).toBe(400);
    const endpoint='BROWSERWEBHOOK123';await panel.getByLabel('PayPal Webhook ID',{ exact:true }).fill(endpoint);await panel.getByRole('button',{ name:'Save webhook credentials',exact:true }).click();
    await expect(panel.getByLabel('PayPal Webhook ID',{ exact:true })).toHaveCount(0);await panel.getByRole('button',{ name:'Test payment endpoint',exact:true }).click();
    await expect(panel.getByText('Provider endpoint verified',{ exact:true }).locator('..')).toContainText('Yes');await expect(panel.getByText('Signed delivery verified',{ exact:true }).locator('..')).toContainText('No');
    const payload=Buffer.from(JSON.stringify(testPayPalEvent('WH-BROWSER-CAPTURE123'),null,2));const headers={ ...testPayPalHeaders(payload,endpoint),origin:new URL(url).origin };
    const send=()=>page.request.post(new URL(url).pathname,{ data:payload,headers });
    expect((await page.request.post(new URL(url).pathname,{ data:payload,headers:{ 'content-type':'application/json',origin:new URL(url).origin } })).status()).toBe(403);
    expect((await page.request.post(new URL(url).pathname,{ data:Buffer.from(payload.toString()+' '),headers })).status()).toBe(403);
    expect((await send()).status()).toBe(200);expect((await (await send()).json()).duplicate).toBe(true);
    await panel.getByRole('button',{ name:'Refresh payment webhooks',exact:true }).click();await expect(panel.getByText('Signed delivery verified',{ exact:true }).locator('..')).toContainText('Yes');
    await expect(panel.locator('.payment-webhook-events > li')).toHaveCount(1);await expect(panel.locator('.payment-webhook-events')).toContainText('QUEUED');
    const dto=await (await page.request.get(path)).json();expect(dto.webhookReady).toBe(true);expect(dto.financialProcessingReady).toBe(false);expect(dto.secret_configured).toBe(false);
    const safe=await panel.textContent();expect(safe).not.toContain('private-buyer');expect(safe).not.toContain('25.00');expect(safe).not.toContain('BrowserWebhookSecret');
    await control(page,{ paymentReceipts:true });await panel.getByRole('button',{ name:'Refresh payment webhooks',exact:true }).click();
    await expect(panel.locator('.payment-webhook-events')).toContainText('NEEDS_ATTENTION');await expect(panel.locator('.payment-webhook-events')).toContainText('PAYMENT_RECEIPT_UNMATCHED');
    await expect(panel.getByRole('checkbox',{ name:'Use verified current connection credentials for this receipt',exact:true })).toHaveCount(0);
    const agent=await browser.newContext({ storageState:agentStorageState });try { expect((await agent.request.get(path)).status()).toBe(403);expect((await agent.request.get(root+'/webhook-events')).status()).toBe(403); }finally{ await agent.close(); }
    await control(page,{ paymentFailure:true });await panel.getByRole('button',{ name:'Test payment endpoint',exact:true }).click();await expect(panel.getByRole('alert')).toContainText('PAYMENT_PROVIDER_AUTH_FAILED');
    await expect(panel.getByText('Provider endpoint verified',{ exact:true }).locator('..')).toContainText('No');
    await control(page,{ paymentFailure:false });await panel.getByRole('button',{ name:'Test payment endpoint',exact:true }).click();await expect(panel.getByText('Provider endpoint verified',{ exact:true }).locator('..')).toContainText('Yes');
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel).toContainText('Aucun secret de signature');
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');
    await panel.locator('.payment-webhook-detail').scrollIntoViewIfNeeded();await page.screenshot({ path:'.local/e2e/paypal-webhook-ar.png' });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await panel.getByRole('button',{ name:'Disable payment webhook',exact:true }).click();await expect(panel.locator('.payment-webhook-detail')).toContainText('DISABLED');expect((await send()).status()).toBe(409);
    await expect(panel.locator('.payment-webhook-events')).toContainText('WH-BROWSER-CAPTURE123');
  }finally { await control(page,{ paymentFailure:false });await context.close(); }
});

test('browser issues PayPal link, explicitly queues capture and separates acceptance from signed independent confirmation and enrollment',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });const page=await context.newPage();const errors:string[]=[];
  page.on('pageerror',(error)=>errors.push(error.message));
  try {
    await control(page,{ paymentFailure:false });if(!managerStorageState)await login(page,'manager');await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    const origin={ origin:'http://127.0.0.1:4100' };
    const post=async(path:string,data:object)=> { const r=await page.request.post(path,{ data,headers:origin });expect(r.ok(),await r.text()).toBe(true);return r.json(); };
    const { lead }=await (await page.request.get('/api/leads/'+fixture.mediaLeadId)).json();
    const c=await post('/api/payments/connections',{ name:'Browser PayPal financial <img literal>',provider:'PAYPAL',branchId:lead.branch_id,
      config:{ mode:'TEST',expectedMerchantId:'ABCD234EFGH56' },credentials:{ clientId:'BrowserFinancialClient_123456',clientSecret:'BrowserFinancialSecret_123456' } });
    const root='/api/payments/connections/'+c.id;await post(root+'/test',{ version:1 });
    const w=await post(root+'/webhooks',{ connectionVersion:1,reason:'Dedicated browser financial callbacks' });const wr=root+'/webhooks/'+w.id;const endpoint='BROWSERFINANCIAL123';
    await post(wr+'/configure',{ version:1,endpointId:endpoint,reason:'Registered application webhook' });await post(wr+'/test',{ version:2,connectionVersion:1 });
    const probe=Buffer.from(JSON.stringify(testPayPalEvent('WH-BROWSER-FINANCIALPROBE123')));
    const callback=new URL(w.callback_url).pathname;expect((await page.request.post(callback,{ data:probe,headers:{ ...testPayPalHeaders(probe,endpoint),...origin } })).status()).toBe(200);
    const method=await post('/api/payments/methods',{ name:'Browser PayPal tuition <img literal>',branchId:lead.branch_id,connectionId:c.id,currencies:['USD'],active:true,
      agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'SELECTED',ids:[lead.campaign_id] },reason:'Scoped browser PayPal method' });
    await page.getByRole('row').filter({ hasText:'Browser Media Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    const panel=page.locator('.lead-payment-requests');await panel.getByLabel('Payment request method',{ exact:true }).selectOption(method.id);
    await panel.getByLabel('Payment request amount',{ exact:true }).fill('25');await panel.getByRole('button',{ name:'Save payment link request',exact:true }).click();
    await expect(panel.getByRole('status')).toContainText('Request saved once');const requests='/api/leads/'+fixture.mediaLeadId+'/payment-link-requests';
    const intent=(await (await page.request.get(requests)).json()).items.find((i:{ methodName:string })=>i.methodName==='Browser PayPal tuition <img literal>');
    await control(page,{ paymentDispatch:true });await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();
    const row=panel.locator('.payment-request-history > li').filter({ hasText:'Browser PayPal tuition <img literal>' });
    await expect(row.getByRole('link',{ name:'Open payment link',exact:true })).toHaveAttribute('href',/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=O/);
    await expect(row).toContainText('did not specify link expiry');expect((await (await page.request.get(requests+'/'+intent.id)).json()).enrollmentId).toBeNull();
    const orderId='O'+intent.id.replaceAll('-','').toUpperCase();const captureId='C'+intent.id.replaceAll('-','').toUpperCase();
    // A browser return/customer claim supplies no financial authority and cannot enqueue capture.
    await page.goto('/?paymentReturn=success&token='+orderId);expect((await (await page.request.get(requests+'/'+intent.id)).json()).captureState).toBeNull();
    await page.getByRole('row').filter({ hasText:'Browser Media Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    await control(page,{ paypalApprove:intent.id,paypalPending:intent.id });await row.getByRole('button',{ name:'Request PayPal capture',exact:true }).click();
    await expect(row).toContainText('Capture execution status: QUEUED');await control(page,{ paypalCapture:true });await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();
    await expect(row).toContainText('Provider accepted capture');await expect(row.getByRole('link',{ name:'Open payment link',exact:true })).toHaveCount(0);
    await row.getByRole('button',{ name:'PayPal capture attempts',exact:true }).click();await expect(panel.locator('ol')).toContainText('ACKNOWLEDGED');
    const receipt=()=>Buffer.from(JSON.stringify({ ...testPayPalEvent('WH-'+randomUUID().replaceAll('-','').toUpperCase()),resource:{ id:captureId,status:'COMPLETED',
      custom_id:intent.id,amount:{ value:'99999.00',currency_code:'USD' },payee:{ merchant_id:'WRONGCLAIMONLY' },supplementary_data:{ related_ids:{ order_id:orderId } } } }));
    let raw=receipt();expect((await page.request.post(callback,{ data:raw,headers:{ 'content-type':'application/json',...origin } })).status()).toBe(403);
    const send=async(raw:Buffer)=>page.request.post(callback,{ data:raw,headers:{ ...testPayPalHeaders(raw,endpoint),...origin } });
    expect((await send(raw)).status()).toBe(200);expect((await send(raw)).status()).toBe(200);await control(page,{ paymentReceipts:true });
    await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();await expect(row).toContainText('Payment pending');
    expect((await (await page.request.get(requests+'/'+intent.id)).json()).enrollmentId).toBeNull();
    await control(page,{ paypalComplete:intent.id,paypalReadFailure:true });raw=receipt();expect((await send(raw)).status()).toBe(200);await control(page,{ paymentReceipts:true });
    expect((await (await page.request.get(requests+'/'+intent.id)).json()).enrollmentId).toBeNull();
    await page.getByRole('button',{ name:'Payment setup',exact:true }).click();const setup=page.locator('.payment-setup');
    await setup.getByRole('row').filter({ hasText:'Browser PayPal financial <img literal>' }).getByRole('button',{ name:'Edit payment connection',exact:true }).click();
    const webhookPanel=page.locator('.payment-webhooks');await expect(webhookPanel.locator('.payment-webhook-events')).toContainText('PAYMENT_PROVIDER_AUTH_FAILED');
    await webhookPanel.getByLabel('Webhook change reason',{ exact:true }).fill('Explicit read-only PayPal verification recovery');
    await webhookPanel.getByRole('checkbox',{ name:'Use verified current connection credentials for this receipt',exact:true }).check();await control(page,{ paypalReadFailure:false });
    const recoveryResponse=page.waitForResponse((response)=>response.url().includes('/webhook-events/') && response.url().endsWith('/retry') && response.request().method()==='POST');
    await webhookPanel.getByRole('button',{ name:'Retry receipt verification',exact:true }).click();expect((await recoveryResponse).ok()).toBe(true);
    await control(page,{ paymentReceipts:true });
    await page.goto('/');await page.getByRole('row').filter({ hasText:'Browser Media Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    await expect(row).toContainText('Payment confirmed');await expect(row).toContainText('Enrollment confirmed');
    await expect(row).not.toContainText('awaiting financial confirmation');
    await expect(row).toContainText('25.00 USD');await expect(row).not.toContainText('99999.00');await expect(row).toContainText(captureId);
    const second=await browser.newContext({ extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });try { const secondPage=await second.newPage();await login(secondPage,'second');expect((await secondPage.request.get(requests+'/'+intent.id)).status()).toBe(404);
      expect((await secondPage.request.post(requests+'/'+intent.id+'/capture',{ data:{},headers:origin })).status()).toBe(404); }finally { await second.close(); }
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(row).toContainText('Inscription confirmée');
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await row.scrollIntoViewIfNeeded();
    await expect(row).toContainText('اشتراك مؤكد');await page.screenshot({ path:'.local/e2e/paypal-financial-ar.png' });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await control(page,{ paypalReadFailure:false });await context.close(); }
});

test('browser configures Alma encrypted key, verifies merchant identity and retains scoped rotation/failure history without financial readiness',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });const page=await context.newPage();const errors:string[]=[];
  page.on('pageerror',(error)=>errors.push(error.message));
  try {
    if(!managerStorageState)await login(page,'manager');else await page.goto('/');await control(page,{ paymentFailure:false });
    await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.getByRole('button',{ name:'Payment setup',exact:true }).click();const panel=page.locator('.payment-setup');
    await panel.getByLabel('Payment provider',{ exact:true }).selectOption('ALMA');const name='Alma browser <img literal>';const key='AlmaBrowserSyntheticOpaqueKey_123456';const rotated='AlmaBrowserRotatedOpaqueKey_123456';
    await expect(panel.getByRole('link',{ name:'Alma API setup',exact:true })).toHaveAttribute('href','https://docs.almapay.com/reference/authentification');
    await expect(panel.getByLabel('PayPal Client Secret',{ exact:true })).toHaveCount(0);await panel.getByLabel('Payment connection name',{ exact:true }).fill(name);
    await panel.getByLabel('Alma API key',{ exact:true }).fill(key);await panel.getByRole('button',{ name:'Save payment connection',exact:true }).click();
    const row=panel.getByRole('row').filter({ hasText:name });await expect(row).toContainText('ALMA');await expect(row).toContainText('NOT_CONFIGURED');await expect(row.locator('img')).toHaveCount(0);
    await expect(panel.getByLabel('Alma API key',{ exact:true })).toHaveValue('');await expect(panel.getByLabel('Payment provider',{ exact:true })).toBeDisabled();
    await expect(panel.locator('.payment-webhooks')).toHaveCount(0);await expect(panel.getByRole('button',{ name:'Inspect payment options',exact:true })).toHaveCount(0);
    await expect(panel).toContainText('does not prove payment eligibility');
    const items=(await (await page.request.get('/api/payments/connections')).json()).items;const id=items.find((i:{ name:string })=>i.name===name).id;const path='/api/payments/connections/'+id;
    const auth=page.waitForResponse((r)=>r.url().endsWith('/'+id+'/test') && r.request().method()==='POST');
    await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();expect((await auth).status()).toBe(200);await expect(row).toContainText('WARNING');
    await expect(panel.locator('.payment-authentication-identity')).toContainText('merchant_BrowserSynthetic123');
    const detail=await (await page.request.get(path)).json();expect(detail.capabilities.authentication.profile).toBe('ALMA_ME_V1');expect(detail.capabilities.authentication.accountRef).toBe('merchant_BrowserSynthetic123');
    expect(detail.capabilities.authenticationVersion).toBe(1);expect(detail.capabilities.paymentLinksReady).toBe(false);expect(detail.capabilities.webhookReady).toBe(false);expect(detail.capabilities.paymentOptions).toBeUndefined();
    await panel.getByRole('button',{ name:'Inspect Alma offers',exact:true }).click();const offersPanel=panel.locator('.payment-merchant-offers');await expect(offersPanel).toContainText('300000');
    await expect(offersPanel).toContainText('Not allowed');await expect(panel).toContainText('No default installment count');
    const offered=(await (await page.request.get(path)).json()).capabilities.merchantOffers;expect(offered.accountRef).toBe(detail.capabilities.authentication.accountRef);expect(offered.plans.map((p:any)=>p.installments)).toEqual([1,3]);expect(offered.currencies).toBeUndefined();
    const eligibilityPanel=panel.locator('.payment-eligibility');await expect(eligibilityPanel.getByLabel('Alma eligibility plan',{ exact:true })).toHaveValue('');
    await expect(eligibilityPanel.getByRole('button',{ name:'Inspect Alma plan eligibility',exact:true })).toBeDisabled();
    await eligibilityPanel.getByLabel('Alma eligibility amount (EUR)',{ exact:true }).fill('100');
    await eligibilityPanel.getByLabel('Alma eligibility plan',{ exact:true }).selectOption({ index:1 });
    await eligibilityPanel.getByRole('button',{ name:'Inspect Alma plan eligibility',exact:true }).click();const eligibilityResult=eligibilityPanel.locator('.payment-eligibility-result');
    await expect(eligibilityResult).toContainText('100.00 EUR');await expect(eligibilityResult).toContainText('Plan eligible for the assessed amount');
    await expect(eligibilityPanel).toContainText('without final customer credit approval');
    const eligible=(await (await page.request.get(path)).json()).capabilities.paymentEligibility;expect(eligible.eligible).toBe(true);expect(eligible.plan.installments).toBe(3);expect(eligible.accountRef).toBe(detail.capabilities.authentication.accountRef);
    expect(eligible.money.minor).toBe('10000');expect(eligible.customer_total_cost_amount).toBeUndefined();
    await eligibilityPanel.getByLabel('Alma eligibility amount (EUR)',{ exact:true }).fill('50');await eligibilityPanel.getByRole('button',{ name:'Inspect Alma plan eligibility',exact:true }).click();
    await expect(eligibilityResult).toContainText('50.00 EUR');await expect(eligibilityResult).toContainText('Plan not eligible for the assessed amount');await expect(row).toContainText('WARNING');
    await eligibilityPanel.getByLabel('Alma eligibility amount (EUR)',{ exact:true }).fill('1.001');await eligibilityPanel.getByRole('button',{ name:'Inspect Alma plan eligibility',exact:true }).click();
    await expect(eligibilityPanel.getByRole('alert')).toContainText('PAYMENT_AMOUNT_PRECISION_INVALID');await expect(eligibilityResult).toContainText('50.00 EUR');
    await control(page,{ paymentFailure:true });await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();await expect(row).toContainText('AUTH_EXPIRED');
    await expect(panel.getByRole('alert').first()).toContainText('PAYMENT_PROVIDER_AUTH_FAILED');await expect(panel.locator('.payment-authentication-identity')).toHaveCount(0);
    await expect(offersPanel).toHaveCount(0);
    await expect(eligibilityResult).toHaveCount(0);
    await panel.getByLabel('Payment connection change reason',{ exact:true }).fill('Rotate intended Alma key');await panel.getByRole('button',{ name:'Disable payment connection',exact:true }).click();
    await expect(row).toContainText('DISABLED');await expect(panel.getByRole('button',{ name:'Test authentication',exact:true })).toBeDisabled();
    await panel.getByRole('button',{ name:'Reconnect payment connection',exact:true }).click();await expect(row).toContainText('NOT_CONFIGURED');
    await panel.getByLabel('Alma API key',{ exact:true }).fill(rotated);await panel.getByRole('button',{ name:'Save payment connection',exact:true }).click();await expect(panel.getByLabel('Alma API key',{ exact:true })).toHaveValue('');
    await control(page,{ paymentFailure:false });await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();await expect(panel.locator('.payment-authentication-identity')).toContainText('merchant_BrowserRotated456');
    await expect(offersPanel).toHaveCount(0);await panel.getByRole('button',{ name:'Inspect Alma offers',exact:true }).click();await expect(offersPanel).toContainText('300000');
    const history=await (await page.request.get(path+'/history')).json();expect(history.items.some((p:any)=>p.authentication_snapshot?.accountRef==='merchant_BrowserSynthetic123' && p.connection_version===1)).toBe(true);
    expect(history.items.some((p:any)=>p.authentication_snapshot?.accountRef==='merchant_BrowserRotated456' && p.connection_version===4)).toBe(true);
    expect(history.items.some((p:any)=>p.offers_snapshot?.accountRef==='merchant_BrowserSynthetic123' && p.connection_version===1)).toBe(true);
    expect(history.items.some((p:any)=>p.offers_snapshot?.accountRef==='merchant_BrowserRotated456' && p.connection_version===4)).toBe(true);
    expect(history.items.some((p:any)=>p.eligibility_snapshot?.eligible===true && p.eligibility_snapshot.money.amount==='100.00' && p.connection_version===1)).toBe(true);
    expect(history.items.some((p:any)=>p.eligibility_snapshot?.eligible===false && p.eligibility_snapshot.money.amount==='50.00' && p.connection_version===1)).toBe(true);
    const publicText=JSON.stringify([items,detail,history,await (await page.request.get(path)).json()]);
    for(const secret of [key,rotated,'private Alma business data','private Alma bank data','private@alma.browser.test','private Alma underwriting'])expect(publicText).not.toContain(secret);
    const second=await browser.newContext({ extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });try { const unauthorized=await second.newPage();await login(unauthorized,'second');
      expect((await unauthorized.request.get(path)).status()).toBe(403);expect((await unauthorized.request.get(path+'/history')).status()).toBe(403);
      expect((await unauthorized.request.post(path+'/test',{ data:{ version:4 },headers:{ origin:'http://127.0.0.1:4100' } })).status()).toBe(403);
      expect((await unauthorized.request.post(path+'/test',{ data:{ version:4,eligibility:{ amount:'100',currency:'EUR',plan:{ installments:3,deferredMonths:0,deferredDays:0 } } },headers:{ origin:'http://127.0.0.1:4100' } })).status()).toBe(403);
    }finally { await second.close(); }
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel).toContainText('Ce contrôle en lecture seule');await expect(panel.locator('.payment-authentication-identity')).toContainText('Identité Alma vérifiée');
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await eligibilityPanel.scrollIntoViewIfNeeded();
    await expect(panel).toContainText('هوية Alma المفحوصة');await expect(eligibilityPanel).toContainText('أهلية خطة Alma للمبلغ');await expect(panel.locator('.payment-eligibility-history')).toHaveCount(2);await page.screenshot({ path:'.local/e2e/alma-eligibility-ar.png' });
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  } finally { await control(page,{ paymentFailure:false });await context.close(); }
});

test('browser manages Alma unsigned IPN callbacks and unverified history without treating customer claims or reception as payment',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });const page=await context.newPage();const errors:string[]=[];
  page.on('pageerror',(error)=>errors.push(error.message));
  try {
    if(!managerStorageState)await login(page,'manager');else await page.goto('/');await control(page,{ paymentFailure:false });
    await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.getByRole('button',{ name:'Payment setup',exact:true }).click();const panel=page.locator('.payment-setup');
    await panel.getByLabel('Payment provider',{ exact:true }).selectOption('ALMA');const name='Alma IPN browser <script literal>';
    await panel.getByLabel('Payment connection name',{ exact:true }).fill(name);await panel.getByLabel('Alma API key',{ exact:true }).fill('AlmaBrowserNotificationsKey_123456');
    await panel.getByRole('button',{ name:'Save payment connection',exact:true }).click();const notifications=panel.locator('.payment-notifications');
    await expect(notifications).toContainText('unsigned GET');await expect(notifications).toContainText('Financial confirmation requires an independent read');
    await notifications.getByLabel('Alma notification change reason',{ exact:true }).fill('Prepare tested callback <img literal>');
    await expect(notifications.getByRole('button',{ name:'Prepare Alma callback',exact:true })).toBeDisabled();
    await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();await expect(notifications.getByRole('button',{ name:'Prepare Alma callback',exact:true })).toBeEnabled();
    await notifications.getByRole('button',{ name:'Prepare Alma callback',exact:true }).click();const detailPanel=notifications.locator('.payment-notification-detail');
    await expect(detailPanel).toContainText('merchant_BrowserSynthetic123');await expect(detailPanel).toContainText('local HTTP');await expect(detailPanel.locator('img')).toHaveCount(0);
    const callback=await notifications.getByLabel('Alma callback URL',{ exact:true }).inputValue();const items=(await (await page.request.get('/api/payments/connections')).json()).items;
    const id=items.find((i:{ name:string })=>i.name===name).id;const path='/api/payments/connections/'+id;
    const original=(await (await page.request.get(path+'/notification-endpoints')).json()).items[0];expect(callback).toBe(original.callback_url);expect(original.signedDeliveryVerified).toBe(false);expect(original.financialProcessingReady).toBe(true);
    await context.grantPermissions(['clipboard-read','clipboard-write']);await detailPanel.getByRole('button',{ name:'Copy Alma callback',exact:true }).click();await expect(notifications.getByRole('status')).toContainText('Alma callback copied');
    expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(callback);
    const before=await control(page);expect((await page.request.get(callback+'?pid=payment_BrowserNotification&paid=true')).status()).toBe(400);
    expect((await page.request.get(callback+'?pid=payment_BrowserNotification')).status()).toBe(200);
    const duplicated=await page.request.get(callback+'?pid=payment_BrowserNotification');expect((await duplicated.json()).duplicate).toBe(true);
    await notifications.getByRole('button',{ name:'Refresh Alma notifications',exact:true }).click();await expect(notifications.locator('.payment-untrusted-notifications')).toContainText('payment_BrowserNotification');
    await expect(notifications.locator('.payment-untrusted-notifications li')).toHaveCount(1);await expect(notifications).toContainText('receipt only, no financial proof');
    const after=await control(page);expect(after.paymentCalls).toBe(before.paymentCalls);
    // Missing original credential anchor is reviewable. Explicit approval stores the tested same-Merchant key, without inventing a financial proof.
    await control(page,{ paymentIndependentReads:true });await notifications.getByRole('button',{ name:'Refresh Alma notifications',exact:true }).click();
    await expect(notifications.locator('.payment-untrusted-notifications')).toContainText('NEEDS_ATTENTION');
    await notifications.getByRole('button',{ name:'Independent read history',exact:true }).click();const readReview=notifications.locator('.payment-independent-review');
    await expect(readReview).toContainText('never creates a new payment');await expect(readReview.getByRole('button',{ name:'Approve independent read recovery',exact:true })).toBeDisabled();
    const recoveryNote='Approved current key for original account <img literal>';
    await readReview.getByLabel('Independent review recovery reason',{ exact:true }).fill(recoveryNote);await readReview.getByRole('button',{ name:'Approve independent read recovery',exact:true }).click();
    await expect(notifications.getByRole('status')).toContainText('no payment was confirmed');await expect(readReview).toContainText(recoveryNote);await expect(readReview.locator('img')).toHaveCount(0);
    await expect(notifications.locator('.payment-untrusted-notifications')).toContainText('RETRY');await expect(readReview.getByRole('button',{ name:'Approve independent read recovery',exact:true })).toBeDisabled();
    const source=(await (await page.request.get(path+'/untrusted-notifications')).json()).items[0];const readHistoryPath=path+'/untrusted-notifications/'+source.id+'/read-history';
    const safeHistory=await page.request.get(readHistoryPath);expect((await safeHistory.json()).recoveries).toHaveLength(1);
    for(const hidden of ['AlmaBrowserNotificationsKey','ciphertext','nonce','auth_tag','actor_session_id'])expect(await safeHistory.text()).not.toContain(hidden);
    expect((await control(page)).paymentCalls).toBe(after.paymentCalls);
    await detailPanel.getByRole('button',{ name:'Disable Alma callback',exact:true }).click();await expect(detailPanel.getByRole('button',{ name:'Reconnect Alma callback',exact:true })).toBeEnabled();
    expect((await page.request.get(callback+'?pid=payment_BrowserNotification')).status()).toBe(410);
    await notifications.getByRole('button',{ name:'Prepare Alma callback',exact:true }).click();await expect(detailPanel.getByRole('button',{ name:'Reconnect Alma callback',exact:true })).toBeEnabled();
    await detailPanel.getByRole('button',{ name:'Reconnect Alma callback',exact:true }).click();await expect(detailPanel.getByRole('button',{ name:'Disable Alma callback',exact:true })).toBeEnabled();
    expect((await (await page.request.get(callback+'?pid=payment_BrowserNotification')).json()).duplicate).toBe(true);
    await expect(detailPanel).toContainText('Version 3');await expect(detailPanel).toContainText('Prepare tested callback <img literal>');
    // Disabled connection retains a historical callback; configuration rotation cannot re-enable it under a new account.
    await panel.getByLabel('Payment connection change reason',{ exact:true }).fill('Rotate merchant notifications');await panel.getByRole('button',{ name:'Disable payment connection',exact:true }).click();
    await expect(notifications.getByRole('button',{ name:'Prepare Alma callback',exact:true })).toBeDisabled();expect((await page.request.get(callback+'?pid=payment_ConnectionDisabled')).status()).toBe(200);
    await panel.getByRole('button',{ name:'Reconnect payment connection',exact:true }).click();await panel.getByLabel('Alma API key',{ exact:true }).fill('AlmaBrowserRotatedNotificationKey_123456');
    await panel.getByRole('button',{ name:'Save payment connection',exact:true }).click();await panel.getByRole('button',{ name:'Test authentication',exact:true }).click();
    await expect(panel.locator('.payment-authentication-identity')).toContainText('merchant_BrowserRotated456');await notifications.getByRole('button',{ name:'Refresh Alma notifications',exact:true }).click();
    await detailPanel.getByRole('button',{ name:'Disable Alma callback',exact:true }).click();await expect(detailPanel.getByRole('button',{ name:'Reconnect Alma callback',exact:true })).toBeDisabled();
    await notifications.getByRole('button',{ name:'Prepare Alma callback',exact:true }).click();await expect(detailPanel).toContainText('merchant_BrowserRotated456');
    const nextCallback=await notifications.getByLabel('Alma callback URL',{ exact:true }).inputValue();expect(nextCallback).not.toBe(callback);
    expect((await (await page.request.get(nextCallback+'?pid=payment_BrowserNotification')).json()).duplicate).toBe(true);
    await notifications.getByRole('button',{ name:'Refresh Alma notifications',exact:true }).click();await expect(notifications.locator('.payment-untrusted-notifications li')).toHaveCount(2);
    const endpointRows=(await (await page.request.get(path+'/notification-endpoints')).json()).items;expect(endpointRows.length).toBe(2);expect(endpointRows.find((e:any)=>e.id===original.id).current).toBe(false);
    const second=await browser.newContext({ extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });try { const unauthorized=await second.newPage();await login(unauthorized,'second');
      for(const suffix of ['/notification-endpoints','/untrusted-notifications','/notification-endpoints/'+original.id+'/history'])expect((await unauthorized.request.get(path+suffix)).status()).toBe(403);
      expect((await unauthorized.request.get(readHistoryPath)).status()).toBe(403);
      expect((await unauthorized.request.post(path+'/untrusted-notifications/'+source.id+'/recover',{ data:{ connectionVersion:4,reason:'Unauthorized read recovery' },headers:{ origin:'http://127.0.0.1:4100' } })).status()).toBe(403);
      expect((await unauthorized.request.post(path+'/notification-endpoints',{ data:{ connectionVersion:4,reason:'Unauthorized configuration' },headers:{ origin:'http://127.0.0.1:4100' } })).status()).toBe(403);
    }finally { await second.close(); }
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(notifications).toContainText('Notifications non vérifiées');await expect(notifications).toContainText('sans preuve financière');
    await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await notifications.scrollIntoViewIfNeeded();
    await expect(notifications).toContainText('إشعارات غير متحققة');await expect(notifications).toContainText('دون إثبات مالي');await page.screenshot({ path:'.local/e2e/alma-notifications-ar.png' });
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await control(page,{ paymentFailure:false });await context.close(); }
});

test('browser issues Alma with an explicit plan and independently confirms enrollment, reconciles lost ACK without replay and recovers failed reads',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });const page=await context.newPage();const errors:string[]=[];
  page.on('pageerror',(error)=>errors.push(error.message));page.on('console',(message)=>{ if(/Encountered two children|unique.*key/.test(message.text()))errors.push(message.text()); });
  try {
    if(!managerStorageState)await login(page,'manager');else await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    await control(page,{ paymentFailure:false,almaLoseResponse:false,almaReadFailure:false });const origin={ origin:'http://127.0.0.1:4100' };
    const post=async(path:string,data:object)=>{ const response=await page.request.post(path,{ data,headers:origin });expect(response.ok(),await response.text()).toBe(true);return response.json(); };
    const { lead }=await (await page.request.get('/api/leads/'+fixture.mediaLeadId)).json();
    const connection=await post('/api/payments/connections',{ name:'Browser Alma financial <img literal>',provider:'ALMA',config:{ mode:'TEST' },credentials:{ apiKey:'AlmaBrowserFinancialKey_123456' } });
    const root='/api/payments/connections/'+connection.id;await post(root+'/test',{ version:1,inspectOffers:true });
    const endpoint=await post(root+'/notification-endpoints',{ connectionVersion:1,reason:'Original financial browser callback' });
    const method=await post('/api/payments/methods',{ name:'Browser Alma tuition <img literal>',branchId:lead.branch_id,connectionId:connection.id,currencies:['EUR'],active:true,
      agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'SELECTED',ids:[lead.campaign_id] },reason:'Explicit Alma browser availability' });
    const requests='/api/leads/'+fixture.mediaLeadId+'/payment-link-requests';const plan={ installments:3,deferredMonths:0,deferredDays:0 };
    const open=async()=>{ await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.getByRole('row').filter({ hasText:'Browser Media Customer' }).getByRole('button',{ name:'Details',exact:true }).click(); };
    await open();const panel=page.locator('.lead-payment-requests');
    const save=async()=> {
      await panel.getByLabel('Payment request method',{ exact:true }).selectOption(method.id);await panel.getByLabel('Payment request amount',{ exact:true }).fill('100');
      await expect(panel.getByRole('button',{ name:'Save payment link request',exact:true })).toBeDisabled();await expect(panel.getByLabel('Alma request plan',{ exact:true })).toHaveValue('');
      await panel.getByLabel('Alma request plan',{ exact:true }).selectOption(JSON.stringify(plan));
      const submitted=page.waitForRequest((request)=>request.method()==='POST' && request.url().endsWith(requests));
      await panel.getByRole('button',{ name:'Save payment link request',exact:true }).click();const body=(await submitted).postDataJSON();
      await expect(panel.getByRole('status')).toContainText('Request saved once');const replay=await post(requests,body);expect(replay.duplicate).toBe(true);return replay.id as string;
    };
    const before=await control(page);const normal=await save();const normalRow=panel.locator(`[data-payment-request="${normal}"]`);
    await expect.poll(async()=>{ await control(page,{ paymentDispatch:true });return (await (await page.request.get(requests+'/'+normal)).json()).state; }).toBe('ACCEPTED');
    await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();await expect(normalRow.getByRole('link',{ name:'Open payment link',exact:true })).toHaveAttribute('href','https://pay.sandbox.getalma.eu/payment_'+normal.replaceAll('-',''));
    expect((await (await page.request.get(requests+'/'+normal)).json()).enrollmentId).toBeNull();await expect(normalRow.locator('img')).toHaveCount(0);
    await page.goto('/?paymentReturn=success&paid=true');expect((await (await page.request.get(requests+'/'+normal)).json()).paymentState).toBeNull();await open();
    const notify=async(id:string)=>{ const response=await page.request.get(endpoint.callback_url+'?pid=payment_'+id.replaceAll('-',''));expect(response.ok()).toBe(true); };
    expect((await page.request.get(endpoint.callback_url+'?pid=payment_'+normal.replaceAll('-','')+'&paid=true')).status()).toBe(400);await notify(normal);await notify(normal);
    await control(page,{ paymentIndependentReads:true });await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();await expect(normalRow).toContainText('Payment pending');expect((await (await page.request.get(requests+'/'+normal)).json()).enrollmentId).toBeNull();
    await control(page,{ almaCaptured:normal });await expect.poll(async()=>{ await control(page,{ paymentIndependentReads:true });return (await (await page.request.get(requests+'/'+normal)).json()).paymentState; },{ timeout:12000 }).toBe('CONFIRMED');
    await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();await expect(normalRow).toContainText('Enrollment confirmed');await expect(normalRow.getByRole('link',{ name:'Open payment link',exact:true })).toHaveCount(0);
    const enrollment=(await (await page.request.get(requests+'/'+normal)).json()).enrollmentId;await notify(normal);await control(page,{ paymentIndependentReads:true });expect((await (await page.request.get(requests+'/'+normal)).json()).enrollmentId).toBe(enrollment);
    await normalRow.getByRole('button',{ name:'Trusted financial read history',exact:true }).click();await expect(panel.locator('.lead-financial-history')).toContainText('COMPLETE · PAID');await expect(panel.locator('.lead-financial-history')).toContainText('OPEN · UNPAID');
    await panel.getByLabel('Payment request method',{ exact:true }).selectOption('');await control(page,{ almaLoseResponse:true });const unknown=await save();const unknownRow=panel.locator(`[data-payment-request="${unknown}"]`);
    await expect.poll(async()=>{ await control(page,{ paymentDispatch:true });return (await (await page.request.get(requests+'/'+unknown)).json()).state; }).toBe('NEEDS_ATTENTION');await control(page,{ almaLoseResponse:false });
    const lostWrites=(await control(page)).almaWrites;expect(lostWrites).toBe(before.almaWrites+2);await control(page,{ paymentDispatch:true });expect((await control(page)).almaWrites).toBe(lostWrites);
    await notify(unknown);await control(page,{ paymentIndependentReads:true });await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();await expect(unknownRow).toContainText('Link recovered from an independent read');await expect(unknownRow).toContainText('Payment pending');await expect(unknownRow.getByRole('link',{ name:'Open payment link',exact:true })).toBeVisible();
    await control(page,{ almaReadFailure:true,almaCaptured:unknown });await expect.poll(async()=>{ await control(page,{ paymentIndependentReads:true });return (await (await page.request.get(requests+'/'+unknown)).json()).verificationState; },{ timeout:12000 }).toBe('NEEDS_ATTENTION');
    expect((await (await page.request.get(requests+'/'+unknown)).json()).enrollmentId).toBeNull();await panel.getByRole('button',{ name:'Refresh payment requests',exact:true }).click();await expect(unknownRow).toContainText('PAYMENT_PROVIDER_AUTH_FAILED');
    await page.getByRole('button',{ name:'Payment setup',exact:true }).click();const setup=page.locator('.payment-setup');await setup.getByRole('row').filter({ hasText:'Browser Alma financial <img literal>' }).getByRole('button',{ name:'Edit payment connection',exact:true }).click();
    const notifications=setup.locator('.payment-notifications');const reviewRow=notifications.locator('.payment-untrusted-notifications li').filter({ hasText:'payment_'+unknown.replaceAll('-','') });
    await reviewRow.getByRole('button',{ name:'Independent read history',exact:true }).click();const review=notifications.locator('.payment-independent-review');await review.getByLabel('Independent review recovery reason',{ exact:true }).fill('Resume trusted original Alma read after provider recovery');
    await control(page,{ almaReadFailure:false });await review.getByRole('button',{ name:'Approve independent read recovery',exact:true }).click();await expect(notifications.getByRole('status')).toContainText('no payment was confirmed');
    await control(page,{ paymentIndependentReads:true });await open();await expect(unknownRow).toContainText('Payment confirmed');await expect(unknownRow).toContainText('Enrollment confirmed');await expect(unknownRow).not.toContainText('must review payment setup');await expect(unknownRow.getByRole('link',{ name:'Open payment link',exact:true })).toHaveCount(0);expect((await control(page)).almaWrites).toBe(lostWrites);
    const other=await browser.newContext({ extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });try { const unauthorized=await other.newPage();await login(unauthorized,'second');for(const suffix of ['', '/financial-history','/attempts'])expect((await unauthorized.request.get(requests+'/'+unknown+suffix)).status()).toBe(404); }finally { await other.close(); }
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(unknownRow).toContainText('Inscription confirmée');await page.setViewportSize({ width:390,height:844 });await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await unknownRow.scrollIntoViewIfNeeded();await expect(unknownRow).toContainText('اشتراك مؤكد');await page.screenshot({ path:'.local/e2e/alma-financial-ar.png' });
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await control(page,{ almaLoseResponse:false,almaReadFailure:false,paymentFailure:false });await context.close(); }
});

test('Bank Transfer setup, authorized manual approval and signed durable feed keep claims untrusted and Payment/Enrollment separate',async({ browser })=> {
  const managerContext=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } }),agentContext=await browser.newContext({ storageState:agentStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } }),foreignContext=await browser.newContext({ extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });
  const manager=await managerContext.newPage(),agent=await agentContext.newPage(),foreign=await foreignContext.newPage();const errors:string[]=[];
  manager.on('pageerror',(e)=>errors.push(e.message));agent.on('pageerror',(e)=>errors.push(e.message));
  manager.on('console',(m)=>{ if(m.type()==='error' && /same key|unique.*key/i.test(m.text()))errors.push(m.text()); });
  const origin='http://127.0.0.1:4100';
  try {
    if(managerStorageState)await manager.goto('/');else await login(manager,'manager');if(agentStorageState)await agent.goto('/');else await login(agent,'agent');await login(foreign,'second');await control(manager,{ assigned:'agent' });
    await manager.getByRole('combobox',{ name:'Language' }).selectOption('en');
    const lead=(await (await manager.request.get('/api/leads/'+fixture.leadId)).json()).lead;
    await manager.getByRole('button',{ name:'Payment setup',exact:true }).click();const setup=manager.locator('[data-bank-setup]');
    await setup.getByLabel('Name',{ exact:true }).fill('Browser bank transfer <img literal>');await setup.getByLabel('Branch',{ exact:true }).selectOption(lead.branch_id);
    await setup.getByLabel('Beneficiary',{ exact:true }).fill('Synthetic company');await setup.getByLabel('Bank account identifier',{ exact:true }).fill('BROWSER-SYNTHETIC-BANK');
    await setup.getByLabel('Bank name',{ exact:true }).fill('Synthetic bank');await setup.getByLabel('Transfer instructions',{ exact:true }).fill('Exact reference <img src=x onerror=alert(1)>');
    await setup.getByLabel('Currencies, comma separated',{ exact:true }).fill('EUR');await setup.getByLabel('Action reason',{ exact:true }).fill('Browser bank setup from independent records');
    const created=manager.waitForResponse((r)=>r.request().method()==='POST' && r.url().endsWith('/bank-accounts'));await setup.getByRole('button',{ name:'Save transfer account',exact:true }).click();
    const accountResponse=await created;expect(accountResponse.status(),await accountResponse.text()).toBe(201);const account=await accountResponse.json();
    const methodResponse=await manager.request.post('/api/payments/methods',{ headers:{ origin },data:{ name:'Browser Bank Transfer method',branchId:lead.branch_id,connectionId:account.id,currencies:['EUR'],active:true,agents:{ mode:'ALL',ids:[] },campaigns:{ mode:'SELECTED',ids:[lead.campaign_id] },reason:'Enable scoped Browser bank method' } });expect(methodResponse.status(),await methodResponse.text()).toBe(201);const method=await methodResponse.json();
    await setup.locator(`[data-bank-account="${account.id}"]`).getByRole('button',{ name:'History, source and events',exact:true }).click();const sourcePanel=setup.locator('[data-bank-source]');
    const secret='BrowserBankSyntheticOnly'.repeat(3);await sourcePanel.getByLabel('Source description and review',{ exact:true }).fill('Approved synthetic independent bank source <img literal>');
    await sourcePanel.getByLabel('Dedicated HMAC secret',{ exact:true }).fill(secret);await sourcePanel.getByRole('checkbox').check();
    const sourceResponsePromise=manager.waitForResponse((r)=>r.request().method()==='POST' && r.url().endsWith('/sources'));await sourcePanel.getByRole('button',{ name:'Approve source and rotate key',exact:true }).click();
    const sourceResponse=await sourceResponsePromise;expect(sourceResponse.status()).toBe(201);const source=await sourceResponse.json();
    await expect(sourcePanel).toContainText('Live Verification Pending External Credential/Approval');await expect(sourcePanel.getByLabel('Dedicated HMAC secret',{ exact:true })).toHaveValue('');
    await expect(sourcePanel.locator('img')).toHaveCount(0);expect(await sourcePanel.textContent()).not.toContain(secret);
    await agent.goto('/');await agent.getByRole('combobox',{ name:'Language' }).selectOption('en');await agent.getByRole('row').filter({ hasText:'Browser Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    const transfers=agent.locator('[data-bank-transfers]');await transfers.getByLabel('Transfer method',{ exact:true }).selectOption(method.id);await transfers.getByLabel('Transfer amount',{ exact:true }).fill('35.001');await transfers.getByLabel('Transfer currency',{ exact:true }).selectOption('EUR');
    await transfers.getByRole('button',{ name:'Create transfer request',exact:true }).click();await expect(transfers.getByRole('alert')).toContainText('PAYMENT_AMOUNT_PRECISION_INVALID');
    await transfers.getByLabel('Transfer amount',{ exact:true }).fill('35.00');
    async function createRequest() { const promise=agent.waitForResponse((r)=>r.request().method()==='POST' && r.url().endsWith('/bank-transfers'));await transfers.getByRole('button',{ name:'Create transfer request',exact:true }).click();const response=await promise;expect(response.status()).toBe(201);return { row:await response.json(),payload:response.request().postDataJSON() }; }
    const first=await createRequest();const r=first.row;const card=transfers.locator(`[data-bank-transfer="${r.id}"]`);
    await expect(card).toContainText('Awaiting trusted reconciliation');await expect(card).toContainText('35.00 EUR');expect(r.payment_id).toBeNull();expect(r.enrollment_id).toBeNull();
    await expect(card.getByRole('button',{ name:'Authorized manual reconciliation',exact:true })).toHaveCount(0);await expect(card.locator('img')).toHaveCount(0);
    expect((await agent.request.post(`/api/leads/${fixture.leadId}/bank-transfers`,{ headers:{ origin },data:first.payload })).status()).toBe(200);
    const approval={ transactionId:'BROWSER-MANUAL-1',accountIdentifier:r.account_identifier,reference:r.reference,amount:r.amount,currency:r.currency,settledAt:new Date(Date.now()-60_000).toISOString(),reason:'Verified directly in bank records',bankVerified:true };
    expect((await agent.request.post(`/api/leads/${fixture.leadId}/bank-transfers/${r.id}/confirm`,{ headers:{ origin },data:approval })).status()).toBe(403);
    expect((await manager.request.post(`/api/leads/${fixture.leadId}/bank-transfers/${r.id}/confirm`,{ headers:{ origin },data:{ ...approval,uploadedReceipt:'customer-claim' } })).status()).toBe(400);
    expect((await foreign.request.get(`/api/leads/${fixture.leadId}/bank-transfers`)).status()).toBe(404);expect((await agent.request.get(`/api/payments/bank-accounts/${account.id}/sources`)).status()).toBe(403);
    await setup.locator(`[data-bank-account="${account.id}"]`).getByRole('button',{ name:'Edit name and instructions',exact:true }).click();await expect(setup.getByLabel('Beneficiary',{ exact:true })).toBeDisabled();
    await setup.getByLabel('Transfer instructions',{ exact:true }).fill('Updated future transfer instructions');await setup.getByLabel('Action reason',{ exact:true }).fill('Clarified future instructions');
    const edited=manager.waitForResponse((x)=>x.request().method()==='PUT' && x.url().endsWith('/bank-accounts/'+account.id));await setup.getByRole('button',{ name:'Save transfer account',exact:true }).click();expect((await edited).status()).toBe(200);
    await transfers.getByRole('button',{ name:'Refresh transfers',exact:true }).click();await expect(card).toContainText('Exact reference <img src=x onerror=alert(1)>');
    await manager.goto('/');await manager.getByRole('combobox',{ name:'Language' }).selectOption('en');await manager.getByRole('row').filter({ hasText:'Browser Customer' }).getByRole('button',{ name:'Details',exact:true }).click();
    const review=manager.locator('[data-bank-transfers]');await review.locator(`[data-bank-transfer="${r.id}"]`).getByRole('button',{ name:'Authorized manual reconciliation',exact:true }).click();const form=review.locator('[data-bank-approval]');
    await expect(form.getByRole('button',{ name:'Approve after bank verification',exact:true })).toBeDisabled();await form.getByLabel('Settled bank transaction ID',{ exact:true }).fill(approval.transactionId);
    await form.getByLabel('Bank settlement time',{ exact:true }).fill('2026-10-01T12:00');await form.getByLabel('Action reason',{ exact:true }).fill('Reviewed settled bank record <img literal>');await form.getByRole('checkbox').check();
    await form.getByRole('button',{ name:'Approve after bank verification',exact:true }).click();await expect(review.locator(`[data-bank-transfer="${r.id}"]`)).toContainText('Payment: CONFIRMED');await expect(review.locator(`[data-bank-transfer="${r.id}"]`)).toContainText('Enrollment:');
    await transfers.getByRole('button',{ name:'Refresh transfers',exact:true }).click();await expect(card).toContainText('Authorized manual reconciliation');await expect(card.locator('img')).toHaveCount(0);
    const second=await createRequest();const r2=second.row;const event={ eventId:'Browser-bank-event',transactionId:'Browser-auto-1',mode:'TEST',accountIdentifier:r2.account_identifier,reference:r2.reference,amount:r2.amount,currency:r2.currency,settledAt:new Date(Date.now()-60_000).toISOString(),status:'SETTLED' };
    const send=async(body:object,signed=true)=> { const raw=JSON.stringify(body),stamp=Math.floor(Date.now()/1000).toString();return manager.request.post(new URL(source.callbackUrl).pathname,{ headers:{ origin,'content-type':'application/json','x-bank-signature':`t=${stamp},v1=${signed ? createHmac('sha256',secret).update(stamp+'.'+raw).digest('hex') : '0'.repeat(64)}` },data:raw }); };
    expect((await send(event,false)).status()).toBe(400);expect((await send({ ...event,status:'PENDING' })).status()).toBe(400);expect((await send(event)).status()).toBe(200);
    await transfers.getByRole('button',{ name:'Refresh transfers',exact:true }).click();const autoCard=transfers.locator(`[data-bank-transfer="${r2.id}"]`);await expect(autoCard).toContainText('Awaiting trusted reconciliation');
    await control(manager,{ bankSettlements:true });await transfers.getByRole('button',{ name:'Refresh transfers',exact:true }).click();await expect(autoCard).toContainText('Payment: CONFIRMED');await expect(autoCard).toContainText('Trusted bank feed confirmation');
    const paid=(await (await agent.request.get(`/api/leads/${fixture.leadId}/bank-transfers`)).json()).items.find((x:{ id:string })=>x.id===r2.id);expect(paid.payment_id).toBeTruthy();expect(paid.enrollment_id).toBeTruthy();
    expect((await send(event)).status()).toBe(200);await control(manager,{ bankSettlements:true });const after=(await (await agent.request.get(`/api/leads/${fixture.leadId}/bank-transfers`)).json()).items.find((x:{ id:string })=>x.id===r2.id);expect(after.enrollment_id).toBe(paid.enrollment_id);
    const third=await createRequest();expect((await send({ ...event,eventId:'Browser-bank-mismatch',transactionId:'Browser-auto-bad',reference:third.row.reference,amount:'34.00' })).status()).toBe(200);await control(manager,{ bankSettlements:true });
    await manager.getByRole('button',{ name:'Back',exact:true }).click();await manager.getByRole('button',{ name:'Payment setup',exact:true }).click();const fresh=manager.locator('[data-bank-setup]');await fresh.locator(`[data-bank-account="${account.id}"]`).getByRole('button',{ name:'History, source and events',exact:true }).click();
    await expect(fresh).toContainText('BANK_CONFIRMATION_MISMATCH');await expect(fresh.getByRole('button',{ name:'Retry reconciliation after fixing the cause',exact:true })).toBeVisible();
    await manager.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(manager.locator('[data-bank-setup]')).toContainText('Configuration du virement');
    await manager.getByRole('combobox',{ name:'Language' }).selectOption('ar');await manager.setViewportSize({ width:390,height:844 });await expect(manager.locator('[data-bank-setup]')).toContainText('إعداد التحويل البنكي');
    await manager.screenshot({ path:'.local/e2e/bank-transfer-ar.png',fullPage:true });expect(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await managerContext.close();await agentContext.close();await foreignContext.close(); }
});
test('AI setup configures encrypted scoped credentials, discovers catalog and manages task profiles without claiming inference or assistant activation',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } }),foreignContext=await browser.newContext({ extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });
  const page=await context.newPage(),foreign=await foreignContext.newPage(),errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));
  try {
    if(managerStorageState)await page.goto('/');else await login(page,'manager');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    const lead=(await (await page.request.get('/api/leads/'+fixture.leadId)).json()).lead;
    await page.getByRole('button',{ name:'AI setup',exact:true }).click();const panel=page.locator('.ai-setup'),origin='http://127.0.0.1:4100';
    const key='BrowserSyntheticAI_123456789';await panel.getByLabel('AI connection name',{ exact:true }).fill('Browser AI <img literal>');await panel.getByLabel('AI connection scope',{ exact:true }).selectOption(lead.branch_id);
    await panel.getByLabel('AI API key',{ exact:true }).fill(key);await panel.getByLabel('AI setup reason',{ exact:true }).fill('Synthetic scoped AI connection');
    const createdPromise=page.waitForResponse((r)=>r.request().method()==='POST' && r.url().endsWith('/ai/connections'));await panel.getByRole('button',{ name:'Save AI connection',exact:true }).click();const created=await createdPromise;expect(created.status()).toBe(201);const c=await created.json();const row=panel.locator(`[data-ai-connection="${c.id}"]`);
    await expect(row).toContainText('NOT_CONFIGURED');await expect(panel.getByLabel('AI API key',{ exact:true })).toHaveValue('');expect(await panel.textContent()).not.toContain(key);await expect(panel.locator('img')).toHaveCount(0);
    await row.getByRole('button',{ name:'Test AI authentication and catalog',exact:true }).click();await expect(row).toContainText('CONNECTED');await expect(panel).toContainText('Inference unverified; no AI auto-send yet');
    const detail=panel.locator('[data-ai-detail]');await detail.getByLabel('AI profile name',{ exact:true }).fill('Synthetic conversation profile');await detail.getByLabel('AI profile model',{ exact:true }).selectOption('Browser-synthetic-model-a');
    const profilePromise=page.waitForResponse((r)=>r.request().method()==='POST' && r.url().endsWith('/ai/profiles'));await detail.getByRole('button',{ name:'Save AI profile',exact:true }).click();const profileResponse=await profilePromise;expect(profileResponse.status()).toBe(201);const profile=await profileResponse.json();const profileRow=panel.locator(`[data-ai-profile="${profile.id}"]`);await expect(profileRow).toContainText('catalog: AVAILABLE');
    await profileRow.getByRole('button',{ name:'Edit AI profile',exact:true }).click();await expect(detail.getByLabel('AI profile task',{ exact:true })).toBeDisabled();await detail.getByLabel('AI profile name',{ exact:true }).fill('Changed safe profile <img literal>');await panel.getByLabel('AI setup reason',{ exact:true }).fill('Explicit profile edit');
    await detail.getByRole('button',{ name:'Save AI profile',exact:true }).click();await expect(profileRow).toContainText('Changed safe profile <img literal>');await profileRow.getByRole('button',{ name:'AI profile history',exact:true }).click();await expect(panel).toContainText('Synthetic conversation profile');
    await row.getByRole('button',{ name:'Edit AI connection',exact:true }).click();await panel.getByLabel('AI API key',{ exact:true }).fill('BrowserUnusableSyntheticKey_123');await panel.getByLabel('AI setup reason',{ exact:true }).fill('Rotate to failing synthetic credential');await panel.getByRole('button',{ name:'Save AI connection',exact:true }).click();
    await expect(profileRow).toContainText('catalog: UNAVAILABLE');await row.getByRole('button',{ name:'Test AI authentication and catalog',exact:true }).click();await expect(row).toContainText('AUTH_EXPIRED');await expect(panel).toContainText('AI_AUTH_FAILED');
    await row.getByRole('button',{ name:'Edit AI connection',exact:true }).click();await panel.getByLabel('AI API key',{ exact:true }).fill('BrowserSyntheticAI_Rotated123');await panel.getByLabel('AI setup reason',{ exact:true }).fill('Restore dedicated synthetic key');await panel.getByRole('button',{ name:'Save AI connection',exact:true }).click();await row.getByRole('button',{ name:'Test AI authentication and catalog',exact:true }).click();await expect(profileRow).toContainText('catalog: AVAILABLE');
    await panel.getByLabel('AI setup reason',{ exact:true }).fill('Disable reviewed connection');await row.getByRole('button',{ name:'Disable AI connection',exact:true }).click();await expect(row).toContainText('DISABLED');await expect(profileRow).toContainText('catalog: UNAVAILABLE');
    await login(foreign,'second');await expect(foreign.getByRole('button',{ name:'AI setup',exact:true })).toHaveCount(0);expect((await foreign.request.get('/api/ai/connections')).status()).toBe(403);expect((await foreign.request.post('/api/ai/profiles',{ headers:{ origin },data:{ connectionId:c.id,name:'Denied',task:'CONVERSATION',modelId:'Browser-synthetic-model-a',maxOutputTokens:1024,active:true,reason:'Attempt denied setup' } })).status()).toBe(403);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(page.locator('.ai-setup')).toContainText('Configuration IA');await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await page.setViewportSize({ width:390,height:844 });
    await expect(page.locator('.ai-setup')).toContainText('إعداد AI');await page.screenshot({ path:'.local/e2e/ai-setup-ar.png',fullPage:true });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await context.close();await foreignContext.close(); }
});

test('Campaign knowledge edits and previews Draft separately, publishes immutable approved versions and preserves scoped safe history',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } }),foreignContext=await browser.newContext({ extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });
  const page=await context.newPage(),foreign=await foreignContext.newPage(),errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));page.on('console',(m)=>{ if(m.type()==='error' && /same key|unique.*key/i.test(m.text()))errors.push(m.text()); });
  const origin='http://127.0.0.1:4100';
  try {
    if(managerStorageState)await page.goto('/');else await login(page,'manager');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    const lead=(await (await page.request.get('/api/leads/'+fixture.leadId)).json()).lead;
    const made=await page.request.post('/api/campaigns',{ headers:{ origin },data:{ name:'Browser Knowledge Campaign',branchId:lead.branch_id,routingMethod:'MANUAL' } });expect(made.status()).toBe(201);const c=await made.json();
    await page.getByRole('button',{ name:'Campaigns',exact:true }).click();await page.getByRole('button',{ name:'Retry',exact:true }).click();await page.getByRole('row').filter({ hasText:'Browser Knowledge Campaign' }).getByRole('button',{ name:'Details',exact:true }).click();
    const panel=page.locator('[data-campaign-knowledge]'),root='/api/ai/campaigns/'+c.id+'/knowledge';await expect(panel).toContainText('No published knowledge yet');
    await panel.getByLabel('Knowledge product and service',{ exact:true }).fill('Approved product <img src=x onerror=alert(1)>');await panel.getByLabel('Knowledge approved prices',{ exact:true }).fill('EUR 35');
    await panel.getByRole('button',{ name:'Add Knowledge FAQ',exact:true }).click();await panel.getByLabel('Knowledge FAQ question 1',{ exact:true }).fill('When is registration?');await panel.getByLabel('Knowledge FAQ answer 1',{ exact:true }).fill('Only approved schedules');
    await panel.getByLabel('Allowed claims, one per line',{ exact:true }).fill('Approved product\nApproved price');await panel.getByLabel('Prohibited claims, one per line',{ exact:true }).fill('No invented discounts');
    await panel.getByRole('button',{ name:'Add knowledge link',exact:true }).click();await panel.getByLabel('Knowledge link label 1',{ exact:true }).fill('Approved reference');await panel.getByLabel('Knowledge link URL 1',{ exact:true }).fill('https://example.com/approved');
    await panel.getByRole('button',{ name:'Preview knowledge draft',exact:true }).click();await expect(panel.locator('[data-knowledge-preview]')).toContainText('EUR 35');await expect(panel.locator('img')).toHaveCount(0);await expect(panel.getByRole('button',{ name:'Publish approved knowledge',exact:true })).toBeDisabled();
    await panel.getByLabel('Knowledge edit or publish reason',{ exact:true }).fill('Reviewed campaign facts');await panel.getByRole('button',{ name:'Save knowledge draft',exact:true }).click();await expect(panel).toContainText('Draft version: 1');
    const publishPromise=page.waitForResponse((r)=>r.request().method()==='POST' && r.url().endsWith('/knowledge/publish'));await panel.getByRole('button',{ name:'Publish approved knowledge',exact:true }).click();const publishedResponse=await publishPromise;expect(publishedResponse.status()).toBe(201);const payload=publishedResponse.request().postDataJSON();
    const published=panel.locator('[data-knowledge-published]');await expect(published).toContainText('EUR 35');await expect(published).toContainText('Approved product <img src=x onerror=alert(1)>');expect((await page.request.post(root+'/publish',{ headers:{ origin },data:payload })).status()).toBe(200);
    await panel.getByLabel('Knowledge approved prices',{ exact:true }).fill('EUR 40 Draft only');await panel.getByLabel('Knowledge edit or publish reason',{ exact:true }).fill('Reviewed new price draft');await panel.getByRole('button',{ name:'Save knowledge draft',exact:true }).click();await expect(panel).toContainText('Draft version: 2');await expect(published).toContainText('EUR 35');await expect(published).not.toContainText('EUR 40');
    expect((await page.request.post(root+'/publish',{ headers:{ origin },data:{ ...payload,requestId:randomUUID() } })).status()).toBe(409);
    await panel.getByRole('button',{ name:'Publish approved knowledge',exact:true }).click();await expect(published).toContainText('EUR 40 Draft only');await panel.getByRole('button',{ name:'View knowledge version 1',exact:true }).click();await expect(panel.locator('[data-knowledge-version]')).toContainText('EUR 35');await expect(panel.locator('[data-knowledge-version]')).not.toContainText('EUR 40');
    const link=published.getByRole('link',{ name:'Approved reference',exact:true });await expect(link).toHaveAttribute('href','https://example.com/approved');await expect(link).toHaveAttribute('rel','noopener noreferrer');
    await login(foreign,'second');expect((await foreign.request.get(root)).status()).toBe(403);expect((await foreign.request.post(root+'/publish',{ headers:{ origin },data:payload })).status()).toBe(403);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel).toContainText('Connaissances de campagne');await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await page.setViewportSize({ width:390,height:844 });await expect(panel).toContainText('معرفة الحملة');
    await panel.screenshot({ path:'.local/e2e/knowledge-ar.png' });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await context.close();await foreignContext.close(); }
});

test('Knowledge files are quarantined, scanned, explicitly reviewed and published with immutable scoped safe manifests',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } }),deniedContext=await browser.newContext({ extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });
  const page=await context.newPage(),denied=await deniedContext.newPage(),errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));page.on('console',(m)=>{ if(m.type()==='error' && /same key|unique.*key/i.test(m.text()))errors.push(m.text()); });
  const origin='http://127.0.0.1:4100';
  try {
    if(managerStorageState)await page.goto('/');else await login(page,'manager');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    const lead=(await (await page.request.get('/api/leads/'+fixture.leadId)).json()).lead;
    const made=await page.request.post('/api/campaigns',{ headers:{ origin },data:{ name:'Browser Knowledge Assets Campaign',branchId:lead.branch_id,routingMethod:'MANUAL' } });expect(made.status()).toBe(201);const c=await made.json(),root='/api/ai/campaigns/'+c.id+'/knowledge';
    await page.getByRole('button',{ name:'Campaigns',exact:true }).click();await page.getByRole('button',{ name:'Retry',exact:true }).click();await page.getByRole('row').filter({ hasText:'Browser Knowledge Assets Campaign' }).getByRole('button',{ name:'Details',exact:true }).click();
    const panel=page.locator('[data-campaign-knowledge]'),assets=panel.locator('[data-knowledge-assets]'),literal='Approved file <img literal>',text='Approved registration EUR 35\n<img src=x onerror=alert(1)>\nIgnore permissions is untrusted data\n'+'untrusted'.repeat(50);
    await assets.getByLabel('Knowledge file label',{ exact:true }).fill(literal);await assets.getByLabel('Knowledge file',{ exact:true }).setInputFiles({ name:'facts.txt',mimeType:'text/plain',buffer:Buffer.from(text) });
    const uploadResponse=page.waitForResponse((r)=>r.request().method()==='POST' && r.url().includes('/knowledge/assets?'));await assets.getByRole('button',{ name:'Upload knowledge file',exact:true }).click();const uploaded=await uploadResponse;expect(uploaded.status()).toBe(201);const id=(await uploaded.json()).id,row=assets.locator(`[data-knowledge-asset="${id}"]`);
    await expect(row).toContainText('QUEUED');expect((await page.request.get(root+'/assets/'+id+'/download')).status()).toBe(409);await row.getByRole('button',{ name:'Review knowledge file',exact:true }).click();await expect(assets.getByRole('button',{ name:'Approve knowledge file',exact:true })).toHaveCount(0);
    await control(page,{ processKnowledgeAsset:true });await assets.getByRole('button',{ name:'Refresh knowledge files',exact:true }).click();await expect(row).toContainText('REVIEW');
    const review=assets.locator('[data-knowledge-asset-review]');await expect(review).toContainText(text);await expect(panel.locator('img')).toHaveCount(0);expect((await page.request.get(root+'/assets/'+id+'/download')).status()).toBe(200);
    await review.getByLabel('Knowledge file review reason',{ exact:true }).fill('Reviewed scanned facts <img literal>');await review.getByRole('button',{ name:'Approve knowledge file',exact:true }).click();await expect(row).toContainText('APPROVED');await row.getByRole('checkbox').check();
    await panel.getByRole('button',{ name:'Preview knowledge draft',exact:true }).click();await expect(panel.locator('[data-knowledge-preview]')).toContainText(text);await expect(panel.getByRole('button',{ name:'Publish approved knowledge',exact:true })).toBeDisabled();
    await panel.getByLabel('Knowledge edit or publish reason',{ exact:true }).fill('Publish explicitly approved file manifest');await panel.getByRole('button',{ name:'Save knowledge draft',exact:true }).click();await panel.getByRole('button',{ name:'Publish approved knowledge',exact:true }).click();
    const published=panel.locator('[data-knowledge-published]');await expect(published).toContainText(text);await expect(published).toContainText(literal);await expect(published).toContainText('SHA256');
    const promise=page.waitForEvent('download');await published.getByRole('link',{ name:literal,exact:true }).click();const download=await promise;expect(download.suggestedFilename()).toBe('knowledge-'+id+'.txt');expect(await download.failure()).toBeNull();
    await row.getByRole('checkbox').uncheck();await panel.getByLabel('Knowledge product and service',{ exact:true }).fill('Next published version without files');await panel.getByLabel('Knowledge edit or publish reason',{ exact:true }).fill('New draft removes file');await panel.getByRole('button',{ name:'Save knowledge draft',exact:true }).click();await expect(published).toContainText(text);await panel.getByRole('button',{ name:'Publish approved knowledge',exact:true }).click();await expect(published).not.toContainText(text);await panel.getByRole('button',{ name:'View knowledge version 1',exact:true }).click();await expect(panel.locator('[data-knowledge-version]')).toContainText(text);
    await assets.getByLabel('Knowledge file label',{ exact:true }).fill('Rejected scan');await assets.getByLabel('Knowledge file',{ exact:true }).setInputFiles({ name:'rejected.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic rejected content') });await assets.getByRole('button',{ name:'Upload knowledge file',exact:true }).click();await expect(assets).toContainText('Rejected scan');await control(page,{ processKnowledgeAsset:true,rejectKnowledgeAsset:true });await assets.getByRole('button',{ name:'Refresh knowledge files',exact:true }).click();await expect(assets).toContainText('KNOWLEDGE_CONTENT_REJECTED');
    await login(denied,'second');expect((await denied.request.get(root+'/assets')).status()).toBe(403);expect((await denied.request.get(root+'/assets/'+id+'/download')).status()).toBe(403);expect((await denied.request.post(root+'/assets/'+id+'/review',{ headers:{ origin },data:{ decision:'APPROVED',version:3,reason:'Unauthorized review' } })).status()).toBe(403);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(assets).toContainText('Fichiers de connaissances approuvés');await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await page.setViewportSize({ width:390,height:844 });await expect(assets).toContainText('ملفات المعرفة المعتمدة');await assets.screenshot({ path:'.local/e2e/knowledge-assets-ar.png' });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await context.close();await deniedContext.close(); }
});

test('Qualification setup maps current fields, previews typed explicit completion and handoff without writes, and retains scoped version history',async({ browser })=> {
  const context=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } }),deniedContext=await browser.newContext({ extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });const page=await context.newPage(),denied=await deniedContext.newPage(),errors:string[]=[];
  page.on('pageerror',(e)=>errors.push(e.message));page.on('console',(m)=>{ if(m.type()==='error' && /same key|unique.*key/i.test(m.text()))errors.push(m.text()); });const origin='http://127.0.0.1:4100';
  try {
    if(managerStorageState)await page.goto('/');else await login(page,'manager');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');
    const lead=(await (await page.request.get('/api/leads/'+fixture.leadId)).json()).lead;
    const made=await page.request.post('/api/campaigns',{ headers:{ origin },data:{ name:'Browser Qualification Campaign',branchId:lead.branch_id,routingMethod:'MANUAL' } });expect(made.status()).toBe(201);const c=await made.json(),root='/api/ai/campaigns/'+c.id+'/qualification';
    const fieldResponse=await page.request.post('/api/fields',{ headers:{ origin },data:{ scope:'CAMPAIGN',branchId:lead.branch_id,campaignId:c.id,key:'qualified_interest',label:'Confirmed interest',fieldType:'BOOLEAN',valueMode:'MANUAL',options:[],validation:{} } });expect(fieldResponse.status()).toBe(201);const f=await fieldResponse.json();
    const binding={ active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:true,visibleToManager:true,editableByManager:true,showInTable:false,showInDetails:true,filterable:false,usableByAutomation:false,usableByAi:true };
    expect((await page.request.put('/api/campaigns/'+c.id+'/fields/'+f.id,{ headers:{ origin },data:binding })).status()).toBe(200);
    await page.getByRole('button',{ name:'Campaigns',exact:true }).click();await page.getByRole('button',{ name:'Retry',exact:true }).click();await page.getByRole('row').filter({ hasText:'Browser Qualification Campaign' }).getByRole('button',{ name:'Details',exact:true }).click();
    const panel=page.locator('[data-campaign-qualification]');await expect(panel).toContainText('Version: 0');await panel.getByLabel('Enable qualification definition',{ exact:true }).check();await panel.getByRole('button',{ name:'Add qualification question',exact:true }).click();await panel.getByLabel('Qualification question 1',{ exact:true }).fill('Interest <img literal>');await panel.getByLabel('Qualification question field 1',{ exact:true }).selectOption(f.id);
    await panel.getByRole('button',{ name:'Add qualification question',exact:true }).click();await panel.getByLabel('Qualification question 2',{ exact:true }).fill('Need a human?');await panel.getByLabel('Required question 2',{ exact:true }).uncheck();await panel.getByLabel('Handoff on qualification completion',{ exact:true }).check();
    await panel.getByRole('button',{ name:'Preview qualification',exact:true }).click();await expect(panel.locator('[data-qualification-preview]')).toContainText('Qualification complete: No');
    await panel.getByLabel('Qualification preview answer 1 · Interest <img literal>',{ exact:true }).selectOption('false');await panel.getByLabel('Qualification preview answer 2 · Need a human?',{ exact:true }).fill('human');await panel.getByRole('button',{ name:'Preview qualification',exact:true }).click();await expect(panel.locator('[data-qualification-preview]')).toContainText('Qualification complete: Yes');await expect(panel.locator('[data-qualification-preview]')).toContainText('Handoff required: Yes');
    await panel.getByLabel('Qualification completion criterion',{ exact:true }).selectOption('CONDITIONS');const completion=panel.getByRole('group',{ name:'Explicit conditions',exact:true }),handoff=panel.getByRole('group',{ name:'Additional handoff conditions',exact:true });await completion.getByRole('button',{ name:'Add condition',exact:true }).click();await panel.getByLabel('Condition operator completion 1',{ exact:true }).selectOption('EQUALS');await panel.getByLabel('Condition value completion 1',{ exact:true }).selectOption('false');
    await handoff.getByRole('button',{ name:'Add condition',exact:true }).click();const questionIds=await panel.locator('[data-qualification-question]').evaluateAll((els)=>els.map((el)=>el.getAttribute('data-qualification-question')!));await panel.getByLabel('Condition question handoff 1',{ exact:true }).selectOption(questionIds[1]!);await panel.getByLabel('Condition operator handoff 1',{ exact:true }).selectOption('EQUALS');await panel.getByLabel('Condition value handoff 1',{ exact:true }).fill('human');await panel.getByLabel('Qualification edit reason',{ exact:true }).fill('Reviewed explicit completion and handoff');await panel.getByRole('button',{ name:'Save qualification definition',exact:true }).click();await expect(panel).toContainText('Version: 1');
    const saved=(await (await page.request.get(root)).json()).definition;expect(saved.completion.conditions[0].value).toBe(false);expect((await (await page.request.get('/api/leads/'+fixture.leadId)).json()).lead.lifecycle).toBe(lead.lifecycle);
    await panel.getByLabel('Qualification question 2',{ exact:true }).fill('Updated question <img literal>');await panel.locator('[data-qualification-question]').nth(1).getByRole('button',{ name:'Move question up',exact:true }).click();await panel.getByLabel('Qualification edit reason',{ exact:true }).fill('Reorder questions with retained original history');await panel.getByRole('button',{ name:'Save qualification definition',exact:true }).click();await expect(panel).toContainText('Version: 2');await panel.getByRole('button',{ name:'View past qualification definition 1',exact:true }).click();await expect(panel.locator('[data-qualification-version]')).toContainText('Need a human?');await expect(panel.locator('[data-qualification-version]')).not.toContainText('Updated question');await expect(panel.locator('img')).toHaveCount(0);
    expect((await page.request.put('/api/campaigns/'+c.id+'/fields/'+f.id,{ headers:{ origin },data:{ ...binding,version:1,usableByAi:false } })).status()).toBe(200);await panel.getByRole('button',{ name:'Preview qualification',exact:true }).click();await expect(panel.getByRole('alert')).toContainText('QUALIFICATION_FIELD_UNAVAILABLE');
    await panel.getByLabel('Enable qualification definition',{ exact:true }).uncheck();await panel.getByLabel('Qualification edit reason',{ exact:true }).fill('Disable safely after mapping revocation');await panel.getByRole('button',{ name:'Save qualification definition',exact:true }).click();await expect(panel).toContainText('Version: 3');expect((await (await page.request.get(root)).json()).definition.enabled).toBe(false);
    await panel.getByLabel('Enable qualification definition',{ exact:true }).check();await panel.getByRole('button',{ name:'Save qualification definition',exact:true }).click();await expect(panel.getByRole('alert')).toContainText('QUALIFICATION_FIELD_UNAVAILABLE');await panel.getByRole('button',{ name:'Reload qualification',exact:true }).click();await expect(panel.getByLabel('Enable qualification definition',{ exact:true })).not.toBeChecked();
    await login(denied,'second');expect((await denied.request.get(root)).status()).toBe(403);expect((await denied.request.post(root+'/preview',{ headers:{ origin },data:{ version:2,definition:saved,answers:[] } })).status()).toBe(403);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(panel).toContainText('Qualification de campagne');await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await page.setViewportSize({ width:390,height:844 });await panel.screenshot({ path:'.local/e2e/qualification-ar.png' });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await context.close();await deniedContext.close(); }
});

test('Shared AI profiles require explicit admin Branch use, omit credentials and Manager configuration rights, and revoke with retained safe history',async({ browser })=> {
  const adminContext=await browser.newContext({ storageState:adminStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } }),managerContext=await browser.newContext({ storageState:managerStorageState,extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } });
  const page=await adminContext.newPage(),manager=await managerContext.newPage(),errors:string[]=[];page.on('pageerror',(e)=>errors.push(e.message));manager.on('pageerror',(e)=>errors.push(e.message));const origin='http://127.0.0.1:4100';
  try {
    if(adminStorageState)await page.goto('/');else await login(page,'admin');if(managerStorageState)await manager.goto('/');else await login(manager,'manager');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await manager.getByRole('combobox',{ name:'Language' }).selectOption('en');
    const lead=(await (await manager.request.get('/api/leads/'+fixture.leadId)).json()).lead,key='BrowserSyntheticAI_Shared123';
    const made=await page.request.post('/api/ai/connections',{ headers:{ origin },data:{ name:'Shared AI Browser <img literal>',branchId:null,provider:'OPENAI',credential:key,reason:'Dedicated synthetic shared runtime' } });expect(made.status()).toBe(201);const c=await made.json();
    expect((await page.request.post('/api/ai/connections/'+c.id+'/test',{ headers:{ origin },data:{ version:1 } })).status()).toBe(200);
    const createdProfile=await page.request.post('/api/ai/profiles',{ headers:{ origin },data:{ connectionId:c.id,name:'Shared Browser conversation',task:'CONVERSATION',modelId:'Browser-synthetic-model-a',maxOutputTokens:1024,active:true,reason:'Configure shared task explicitly' } });expect(createdProfile.status()).toBe(201);const profile=await createdProfile.json();
    await manager.getByRole('button',{ name:'AI setup',exact:true }).click();const usable=manager.locator('[data-ai-usable-profiles]');await usable.getByLabel('AI use branch',{ exact:true }).selectOption(lead.branch_id);await expect(usable.locator(`[data-ai-usable-profile="${profile.id}"]`)).toHaveCount(0);
    await page.getByRole('button',{ name:'AI setup',exact:true }).click();const panel=page.locator('.ai-setup'),row=panel.locator(`[data-ai-connection="${c.id}"]`);await row.getByRole('button',{ name:'AI configuration and test history',exact:true }).click();const grant=panel.locator('[data-ai-shared-use]');
    await grant.getByLabel('AI use branch',{ exact:true }).selectOption(lead.branch_id);await grant.getByLabel('Shared AI use reason',{ exact:true }).fill('Approve Branch shared use <img literal>');await grant.getByRole('button',{ name:'Save shared AI use',exact:true }).click();await expect(grant.locator(`[data-ai-grant="${lead.branch_id}"]`)).toContainText('ACTIVE');
    await usable.getByRole('button',{ name:'Refresh AI grants',exact:true }).click();const p=usable.locator(`[data-ai-usable-profile="${profile.id}"]`);await expect(p).toContainText('SHARED');await expect(p).toContainText('catalog: AVAILABLE');await expect(usable.locator('img')).toHaveCount(0);expect(await panel.textContent()).not.toContain(key);expect(await usable.textContent()).not.toContain(key);
    expect((await manager.request.get('/api/ai/connections/'+c.id+'/models')).status()).toBe(404);expect((await manager.request.get('/api/ai/connections/'+c.id+'/branch-use')).status()).toBe(403);await expect(manager.locator('[data-ai-shared-use]')).toHaveCount(0);await expect(usable.getByRole('button',{ name:'Edit AI profile',exact:true })).toHaveCount(0);
    await panel.getByLabel('AI setup reason',{ exact:true }).fill('Disable shared runtime temporarily');await row.getByRole('button',{ name:'Disable AI connection',exact:true }).click();await usable.getByRole('button',{ name:'Refresh AI grants',exact:true }).click();await expect(p).toContainText('catalog: UNAVAILABLE');
    await row.getByRole('button',{ name:'AI configuration and test history',exact:true }).click();await grant.locator(`[data-ai-grant="${lead.branch_id}"]`).getByRole('button',{ name:'Edit AI grant',exact:true }).click();await grant.getByRole('checkbox').uncheck();await grant.getByLabel('Shared AI use reason',{ exact:true }).fill('Revoke Branch shared use');await grant.getByRole('button',{ name:'Save shared AI use',exact:true }).click();await expect(grant).toContainText('REVOKED');await expect(grant).toContainText('Approve Branch shared use <img literal>');
    await usable.getByRole('button',{ name:'Refresh AI grants',exact:true }).click();await expect(p).toHaveCount(0);await expect(grant.locator('img')).toHaveCount(0);
    await page.getByRole('combobox',{ name:'Language' }).selectOption('fr');await expect(grant).toContainText('Usage de connexion IA partagée');await page.getByRole('combobox',{ name:'Language' }).selectOption('ar');await page.setViewportSize({ width:390,height:844 });await expect(grant).toContainText('إتاحة اتصال AI المشترك للفروع');await grant.screenshot({ path:'.local/e2e/ai-shared-use-ar.png' });expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
  }finally { await adminContext.close();await managerContext.close(); }
});
