import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
type Fixture = { password:string;testToken:string;leadId:string;conversationId:string;untrusted:string;mediaLeadId:string;mediaConversationId:string };
let fixture:Fixture;
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
  await login(page); let panel=await openLead(page);
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
