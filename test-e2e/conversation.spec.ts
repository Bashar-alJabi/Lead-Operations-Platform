import { test, expect, type Page,type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHmac,randomUUID } from 'node:crypto';
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
