import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyKnowledge } from '../src/ai/knowledge.js';
import { emptyAIOperationalConfig } from '../src/ai/operational-config.js';
test('Actual customer AI Qualification applies approved typed actions with current permissions, separate receipts and safe Lead UI', async ({ browser }) => {
  const fixture = JSON.parse(await readFile(resolve('.local/e2e/fixture.json'), 'utf8')) as { password: string; testToken: string }, origin = 'http://127.0.0.1:4100';
  const managerContext = await browser.newContext({ extraHTTPHeaders: { 'x-e2e-rate-scope': randomUUID() } }), context = await browser.newContext({ extraHTTPHeaders: { 'x-e2e-rate-scope': randomUUID() } }), secondContext = await browser.newContext({ extraHTTPHeaders: { 'x-e2e-rate-scope': randomUUID() } });
  const manager = await managerContext.newPage(), page = await context.newPage(), second = await secondContext.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && /same key|unique.*key/i.test(m.text())) errors.push(m.text()); });
  const login = async (p: Page, name: string) => { await p.goto('/'); await p.getByRole('combobox', { name: 'Language' }).selectOption('en'); await p.getByLabel('Email', { exact: true }).fill(name + '@browser.test'); await p.getByLabel('Password', { exact: true }).fill(fixture.password); await p.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(p.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(); };
  try {
    await login(manager, 'manager'); await login(page, 'agent'); await login(second, 'second');
    const me = await (await manager.request.get('/api/auth/me')).json(), agent = await (await page.request.get('/api/auth/me')).json();
    const created = await manager.request.post('/api/campaigns', { headers: { origin }, data: { name: 'Browser AI Qualification Action Campaign', branchId: me.branchId, routingMethod: 'MANUAL' } }); expect(created.status()).toBe(201); const campaign = (await created.json()).id;
    expect((await manager.request.post('/api/campaigns/' + campaign + '/activate', { headers: { origin } })).status()).toBe(200);
    const made = await manager.request.post('/api/leads', { headers: { origin }, data: { branchId: me.branchId, campaignId: campaign, contact: { name: 'Browser AI Qualification Action Customer', phone: '+15556667773' } } }); expect(made.status()).toBe(201); const lead = (await made.json()).id;
    const version = (await (await manager.request.get('/api/leads/' + lead)).json()).lead.version;
    expect((await manager.request.post('/api/leads/' + lead + '/assignment', { headers: { origin }, data: { version, agentId: agent.id, reason: 'Authorized proposal runtime reader' } })).status()).toBe(200);
    const opened = await page.request.post('/api/leads/' + lead + '/conversations', { headers: { origin } }); expect(opened.status()).toBe(201); const cv = (await opened.json()).id, root = '/api/conversations/' + cv + '/ai-customer-executions', kr = '/api/ai/campaigns/' + campaign + '/knowledge';
    const approved = 'Published 100 EUR <img src=x onerror="window.__customerProposalXss=true">', content = { ...emptyKnowledge(), sections: { ...emptyKnowledge().sections, prices: approved } };
    expect((await manager.request.put(kr + '/draft', { headers: { origin }, data: { version: 0, content, reason: 'Current approved business facts' } })).status()).toBe(200);
    expect((await manager.request.post(kr + '/publish', { headers: { origin }, data: { version: 1, requestId: randomUUID(), reason: 'Publish source for runtime' } })).status()).toBe(201);
    const connection = await manager.request.post('/api/ai/connections', { headers: { origin }, data: { name: 'Browser Proposal Connection', branchId: me.branchId, provider: 'OPENAI', credential: 'BrowserSyntheticAI_CustomerProposal12345', reason: 'Isolated synthetic runtime' } }); expect(connection.status()).toBe(201); const cid = (await connection.json()).id;
    expect((await manager.request.post('/api/ai/connections/' + cid + '/test', { headers: { origin }, data: { version: 1 } })).status()).toBe(200);
    const profile = await manager.request.post('/api/ai/profiles', { headers: { origin }, data: { connectionId: cid, name: 'Browser Proposal Model', task: 'CONVERSATION', modelId: 'Browser-synthetic-model-a', maxOutputTokens: 1024, active: true, reason: 'Current managed Conversation profile' } }); expect(profile.status()).toBe(201); const pid = (await profile.json()).id;
    expect((await manager.request.put('/api/ai/campaigns/' + campaign + '/configuration', { headers: { origin }, data: { version: 0, definition: { ...emptyAIOperationalConfig(), profiles: { ...emptyAIOperationalConfig().profiles, CONVERSATION: pid }, language: { supported: ['en', 'ar', 'fr'], preferred: 'ar', detect: true } }, reason: 'Campaign-specific runtime isolation' } })).status()).toBe(200);
    const control = (data: object) => manager.request.post('/__test__/ai-customer-proposal', { headers: { origin, authorization: 'Bearer ' + fixture.testToken }, data: { conversationId: cv, ...data } });
    const f = await manager.request.post('/api/fields', { headers: { origin }, data: { scope: 'CAMPAIGN', branchId: me.branchId, campaignId: campaign,
      key: 'ai_interest', label: 'AI qualification interest', fieldType: 'BOOLEAN', valueMode: 'MANUAL', options: [], validation: {} } }); expect(f.status()).toBe(201); const field = (await f.json()).id;
    const binding = { active: true, position: 0, requiredStage: 'NONE', visibleToAgent: true, editableByAgent: true, visibleToManager: true, editableByManager: true,
      showInTable: false, showInDetails: true, filterable: false, usableByAutomation: false, usableByAi: true };
    expect((await manager.request.put('/api/campaigns/' + campaign + '/fields/' + field, { headers: { origin }, data: binding })).status()).toBe(200);
    const question = randomUUID(), free = randomUUID(), prompt = 'AI confirmed interest?', textPrompt = 'Availability from AI?';
    const definition = { enabled: true, questions: [{ id: question, prompt, fieldId: field, required: true }, { id: free, prompt: textPrompt, fieldId: null, required: false }],
      completion: { mode: 'ALL_REQUIRED', match: 'ALL', conditions: [] }, handoff: { onCompletion: false, match: 'ALL', conditions: [] } };
    expect((await manager.request.put('/api/ai/campaigns/' + campaign + '/qualification', { headers: { origin }, data: { version: 0, definition, reason: 'Actual autonomous Qualification fixture' } })).status()).toBe(200);
    const tools = '/api/ai/campaigns/' + campaign + '/tool-policy';
    expect((await manager.request.put(tools, { headers: { origin }, data: { version: 0, definition: { allowedTools: ['updateQualificationField'] }, reason: 'Explicit current Qualification approval' } })).status()).toBe(200);
    expect((await control({ enable: true })).status()).toBe(200);
    const inbound = (body: string, aiControl = false) => manager.request.post('/__test__/ai-customer-inbound', { headers: { origin, authorization: 'Bearer ' + fixture.testToken }, data: { conversationId: cv, body, aiControl } });
    const execute = () => manager.request.post('/__test__/ai-qualification-action', { headers: { origin, authorization: 'Bearer ' + fixture.testToken } });
    expect((await page.request.post('/__test__/ai-qualification-action')).status()).toBe(403);
    expect((await inbound('Qualification fixture: Yes, interested', true)).status()).toBe(200);
    expect((await control({ process: true })).status()).toBe(200);
    await page.reload(); await page.getByRole('row').filter({ hasText: 'Browser AI Qualification Action Customer' }).getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByRole('heading', { name: 'Customer conversations', exact: true }).locator('..').getByRole('button', { name: 'View messages', exact: true }).click();
    const panel = page.locator('[data-ai-customer-history]'), refresh = () => panel.getByRole('button', { name: 'Review AI executions', exact: true }).click();
    await refresh(); await expect(panel).toContainText('QUALIFICATION'); await expect(panel).toContainText('No action or customer message has been executed.');
    expect((await execute()).status()).toBe(200); expect((await (await execute()).json()).processed).toBe(false);
    await refresh(); await expect(panel.locator('[data-ai-customer-action]')).toContainText('APPLIED'); await expect(panel).toContainText('No customer message was sent.');
    const qr = '/api/leads/' + lead + '/qualification', qual = page.locator('[data-lead-qualification]'), mapped = qual.locator(`[data-qualification-question="${question}"]`);
    await qual.getByRole('button', { name: 'Reload collected answers', exact: true }).click(); await expect(mapped).toContainText('AI'); await expect(mapped.getByLabel(prompt, { exact: true })).toHaveValue('true');
    await mapped.getByRole('button', { name: 'Collected answer history', exact: true }).click(); await expect(qual.locator('[data-qualification-history]')).toContainText('AI');
    const dto = (await (await page.request.get(root)).json()).items[0]; expect(dto.toolsExecuted).toEqual(['updateQualificationField']); expect(dto.action.value).toBeUndefined(); expect(dto.sendAllowed).toBe(false);
    expect((await second.request.get(qr)).status()).toBe(404); expect((await second.request.get(root)).status()).toBe(404);
    // Current Human UI overwrites only with its real permissions/session and retains both sources in history.
    await mapped.getByLabel(prompt, { exact: true }).selectOption('false'); await mapped.getByRole('button', { name: 'Save collected answer', exact: true }).click(); await expect(mapped).toContainText('HUMAN');
    await mapped.getByRole('button', { name: 'Collected answer history', exact: true }).click(); await expect(qual.locator('[data-qualification-history]')).toContainText('AI'); await expect(qual.locator('[data-qualification-history]')).toContainText('HUMAN');
    // Revoked tool permission after inference yields a separate BLOCKED action and no data change.
    expect((await inbound('Qualification fixture: Yes, interested')).status()).toBe(200); expect((await control({ process: true })).status()).toBe(200);
    expect((await manager.request.put(tools, { headers: { origin }, data: { version: 1, definition: { allowedTools: [] }, reason: 'Revoke before autonomous action' } })).status()).toBe(200);
    expect((await execute()).status()).toBe(200); await refresh(); await expect(panel.locator('[data-ai-customer-action]').first()).toContainText('BLOCKED'); await expect(panel).toContainText('AI_ACTION_CONTEXT_CHANGED');
    expect((await (await page.request.get(qr)).json()).questions[0].value).toBe(false);
    // Unmapped answers display untrusted text literally and retain source AI.
    expect((await manager.request.put(tools, { headers: { origin }, data: { version: 2, definition: { allowedTools: ['updateQualificationField'] }, reason: 'Approve fresh test source only' } })).status()).toBe(200);
    expect((await manager.request.put('/api/ai/campaigns/' + campaign + '/qualification', { headers: { origin }, data: { version: 1, definition: { ...definition, questions: [definition.questions[1], definition.questions[0]] }, reason: 'Current unmapped evidence question' } })).status()).toBe(200);
    const untrusted = 'Evening <img src=x onerror="window.__aiQualificationXss=1">';
    expect((await inbound('Qualification fixture: ' + untrusted, true)).status()).toBe(200); expect((await control({ process: true })).status()).toBe(200); expect((await execute()).status()).toBe(200);
    await qual.getByRole('button', { name: 'Reload collected answers', exact: true }).click(); const unmapped = qual.locator(`[data-qualification-question="${free}"]`); await expect(unmapped).toContainText('AI'); await expect(unmapped.getByLabel(textPrompt, { exact: true })).toHaveValue(untrusted);
    await unmapped.getByRole('button', { name: 'Collected answer history', exact: true }).click(); await expect(qual.locator('[data-qualification-history]')).toContainText(untrusted); expect(await qual.locator('img').count()).toBe(0); expect(await page.evaluate(() => Object.hasOwn(window, '__aiQualificationXss'))).toBe(false);
    expect(((await (await page.request.get('/api/conversations/' + cv + '/messages')).json()).items as { direction: string }[]).every(m => m.direction === 'INBOUND')).toBe(true);
    await page.getByRole('combobox', { name: 'Language' }).selectOption('fr'); await expect(qual).toContainText('Qualification du Lead'); await expect(panel).toContainText('Qualification enregistrée');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('ar'); await page.setViewportSize({ width: 390, height: 844 }); await refreshArabic();
    async function refreshArabic() { await panel.getByRole('button', { name: 'مراجعة تنفيذ AI', exact: true }).click(); }
    await panel.screenshot({ path: '.local/e2e/ai-qualification-action-ar.png' }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]);
  } finally { await managerContext.close(); await context.close(); await secondContext.close(); }
});
