import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

test('Human qualification answers are collected through authorized typed Fields with current results, immutable history, duplicate protection and Arabic/French UI', async ({ browser }) => {
  const fixture = JSON.parse(await readFile(resolve('.local/e2e/fixture.json'), 'utf8')) as { password: string };
  const origin = 'http://127.0.0.1:4100', managerContext = await browser.newContext({ extraHTTPHeaders: { 'x-e2e-rate-scope': randomUUID() } }),
    agentContext = await browser.newContext({ extraHTTPHeaders: { 'x-e2e-rate-scope': randomUUID() } }), secondContext = await browser.newContext({ extraHTTPHeaders: { 'x-e2e-rate-scope': randomUUID() } });
  const manager = await managerContext.newPage(), page = await agentContext.newPage(), second = await secondContext.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && /same key|unique.*key/i.test(m.text())) errors.push(m.text()); });
  const login = async (p: Page, name: string) => {
    await p.goto('/'); await p.getByRole('combobox', { name: 'Language' }).selectOption('en');
    await p.getByLabel('Email', { exact: true }).fill(name + '@browser.test'); await p.getByLabel('Password', { exact: true }).fill(fixture.password);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(p.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  };
  try {
    await login(manager, 'manager'); await login(page, 'agent'); await login(second, 'second');
    const actor = await (await page.request.get('/api/auth/me')).json(), other = await (await second.request.get('/api/auth/me')).json();
    const campaignResponse = await manager.request.post('/api/campaigns', { headers: { origin }, data: { name: 'Collected qualification Browser', branchId: actor.branchId, routingMethod: 'MANUAL' } });
    expect(campaignResponse.status()).toBe(201); const campaign = await campaignResponse.json();
    const fieldResponse = await manager.request.post('/api/fields', { headers: { origin }, data: { scope: 'CAMPAIGN', branchId: actor.branchId, campaignId: campaign.id,
      key: 'collected_interest', label: 'Collected interest field', fieldType: 'BOOLEAN', valueMode: 'MANUAL', options: [], validation: {} } });
    expect(fieldResponse.status()).toBe(201); const field = await fieldResponse.json();
    const binding = { active: true, position: 0, requiredStage: 'NONE', visibleToAgent: true, editableByAgent: true, visibleToManager: true, editableByManager: true,
      showInTable: false, showInDetails: true, filterable: false, usableByAutomation: false, usableByAi: true };
    expect((await manager.request.put('/api/campaigns/' + campaign.id + '/fields/' + field.id, { headers: { origin }, data: binding })).status()).toBe(200);
    const question = randomUUID(), free = randomUUID(), prompt = 'Confirmed interest <img literal>', textPrompt = 'Collected availability?',
      definition = { enabled: true, questions: [{ id: question, prompt, fieldId: field.id, required: true }, { id: free, prompt: textPrompt, fieldId: null, required: true }],
        completion: { mode: 'ALL_REQUIRED', match: 'ALL', conditions: [] }, handoff: { onCompletion: true, match: 'ALL', conditions: [] } };
    expect((await manager.request.put('/api/ai/campaigns/' + campaign.id + '/qualification', { headers: { origin }, data: { version: 0, definition, reason: 'Collect actual authorized answers' } })).status()).toBe(200);
    expect((await manager.request.post('/api/campaigns/' + campaign.id + '/activate', { headers: { origin } })).status()).toBe(200);
    const made = await manager.request.post('/api/leads', { headers: { origin }, data: { branchId: actor.branchId, campaignId: campaign.id,
      contact: { name: 'Collected Qualification Customer', email: randomUUID() + '@collected.browser.test' } } });
    expect(made.status(), await made.text()).toBe(201); const lead = await made.json();
    const before = (await (await manager.request.get('/api/leads/' + lead.id)).json()).lead;
    expect((await manager.request.post('/api/leads/' + lead.id + '/assignment', { headers: { origin }, data: { version: before.version, agentId: actor.id, reason: 'Browser authorized owner' } })).status()).toBe(200);
    const root = '/api/leads/' + lead.id + '/qualification';
    expect((await second.request.get(root)).status()).toBe(404);
    expect((await second.request.put(root + '/answers/' + question, { headers: { origin }, data: { requestId: randomUUID(), definitionVersion: 1, answerVersion: 0, fieldValueVersion: 0, value: false } })).status()).toBe(404);
    await page.reload(); await page.getByRole('row').filter({ hasText: 'Collected Qualification Customer' }).getByRole('button', { name: 'Details', exact: true }).click();
    const panel = page.locator('[data-lead-qualification]'), mapped = panel.locator(`[data-qualification-question="${question}"]`), unmapped = panel.locator(`[data-qualification-question="${free}"]`);
    await expect(panel.locator('[data-qualification-result]')).toContainText('Qualification incomplete');
    await mapped.getByLabel(prompt, { exact: true }).selectOption('false');
    const savedPromise = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/answers/' + question));
    await mapped.getByRole('button', { name: 'Save collected answer', exact: true }).click(); const saved = await savedPromise;
    expect(saved.status()).toBe(200); const replay = saved.request().postDataJSON();
    expect((await page.request.put(root + '/answers/' + question, { headers: { origin }, data: replay })).status()).toBe(200);
    const untrusted = 'Availability <img src=x onerror="window.__qualificationXss=1"> ' + 'LongToken'.repeat(40);
    await unmapped.getByLabel(textPrompt, { exact: true }).fill(untrusted); await unmapped.getByRole('button', { name: 'Save collected answer', exact: true }).click();
    await expect(panel.locator('[data-qualification-result]')).toContainText('Qualification complete'); await expect(panel.locator('[data-qualification-result]')).toContainText('Campaign handoff criteria met');
    await expect(mapped).toContainText('HUMAN'); await expect(unmapped).toContainText('HUMAN');
    expect((await (await manager.request.get('/api/leads/' + lead.id)).json()).lead.lifecycle).toBe('OPEN');
    expect((await (await manager.request.get('/api/leads/' + lead.id + '/fields')).json()).items.find((f: { id: string }) => f.id === field.id).value).toBe(false);
    await unmapped.getByRole('button', { name: 'Collected answer history', exact: true }).click(); await expect(panel.locator('[data-qualification-history]')).toContainText(untrusted);
    await expect(panel.locator('img')).toHaveCount(0); expect(await page.evaluate(() => Object.hasOwn(window, '__qualificationXss'))).toBe(false);
    expect((await manager.request.put('/api/leads/' + lead.id + '/fields/' + field.id, { headers: { origin }, data: { value: true, version: 1 } })).status()).toBe(200);
    await panel.getByRole('button', { name: 'Reload collected answers', exact: true }).click(); await expect(mapped.getByLabel(prompt, { exact: true })).toHaveValue('true');
    await mapped.getByRole('button', { name: 'Collected answer history', exact: true }).click(); await expect(panel.locator('[data-qualification-history]')).toContainText('false');
    expect((await page.request.put(root + '/answers/' + question, { headers: { origin }, data: { ...replay, requestId: randomUUID(), answerVersion: 1 } })).status()).toBe(409);
    const configRoot = '/api/ai/campaigns/' + campaign.id + '/qualification';
    expect((await manager.request.put(configRoot, { headers: { origin }, data: { version: 1, definition: { ...definition, enabled: false }, reason: 'Disable retains collected history' } })).status()).toBe(200);
    await panel.getByRole('button', { name: 'Reload collected answers', exact: true }).click(); await expect(panel).toContainText('Qualification is disabled');
    await expect(unmapped).toContainText(untrusted); await expect(panel.getByRole('button', { name: 'Save collected answer', exact: true })).toHaveCount(0);
    await unmapped.getByRole('button', { name: 'Collected answer history', exact: true }).click(); await expect(panel.locator('[data-qualification-history]')).toContainText(untrusted);
    expect((await manager.request.put(configRoot, { headers: { origin }, data: { version: 2, definition, reason: 'Reenable without recollecting identical questions' } })).status()).toBe(200);
    await panel.getByRole('button', { name: 'Reload collected answers', exact: true }).click(); await expect(panel.locator('[data-qualification-result]')).toContainText('Qualification complete');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('fr'); await expect(panel).toContainText('Qualification du Lead');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('ar'); await page.setViewportSize({ width: 390, height: 844 });
    await unmapped.getByRole('button', { name: 'تاريخ الإجابة المجمعة', exact: true }).click();
    await panel.screenshot({ path: '.local/e2e/qualification-answers-ar.png' }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await manager.request.put('/api/campaigns/' + campaign.id + '/fields/' + field.id, { headers: { origin }, data: { ...binding, version: 1, visibleToAgent: false, editableByAgent: false } })).status()).toBe(200);
    await panel.getByRole('button', { name: 'تحديث الإجابات المحفوظة', exact: true }).click(); await expect(mapped).toHaveCount(0);
    await expect(panel.locator('[data-qualification-result]')).toContainText('النتيجة غير متاحة');
    const privateRead = await page.request.get(root); expect(await privateRead.text()).not.toContain(prompt); expect(await privateRead.text()).not.toContain(field.id);
    expect((await (await page.request.get(root + '/answers/' + question + '/history')).json()).items).toEqual([]);
    const current = (await (await manager.request.get('/api/leads/' + lead.id)).json()).lead;
    expect((await manager.request.post('/api/leads/' + lead.id + '/assignment', { headers: { origin }, data: { version: current.version, agentId: other.id, reason: 'Reassignment preserves collected history' } })).status()).toBe(200);
    expect((await page.request.get(root)).status()).toBe(404); expect((await page.request.get(root + '/answers/' + free + '/history')).status()).toBe(404);
    await panel.getByRole('button', { name: 'تحديث الإجابات المحفوظة', exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('LEAD_NOT_FOUND'); await expect(unmapped).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await managerContext.close(); await agentContext.close(); await secondContext.close(); }
});
