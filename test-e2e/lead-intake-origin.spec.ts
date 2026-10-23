import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

test('Lead intake origin shows authorized historical routing separately from current ownership and clears revoked access in localized UI', async ({ browser }) => {
  const f = JSON.parse(await readFile(resolve('.local/e2e/fixture.json'), 'utf8')) as { password: string }, headers = { origin: 'http://127.0.0.1:4100' };
  const managerContext = await browser.newContext({ extraHTTPHeaders: { 'x-e2e-rate-scope': randomUUID() } }), agentContext = await browser.newContext({ extraHTTPHeaders: { 'x-e2e-rate-scope': randomUUID() } });
  const manager = await managerContext.newPage(), page = await agentContext.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && /same key|unique.*key/i.test(m.text())) errors.push(m.text()); });
  const login = async (p: Page, name: string) => { await p.goto('/'); await p.getByRole('combobox', { name: 'Language' }).selectOption('en'); await p.getByLabel('Email', { exact: true }).fill(name+'@browser.test'); await p.getByLabel('Password', { exact: true }).fill(f.password); await p.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(p.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(); };
  try {
    await login(manager, 'manager'); await login(page, 'agent');
    const me = await (await manager.request.get('/api/auth/me')).json(), agent = await (await page.request.get('/api/auth/me')).json();
    const campaignResponse = await manager.request.post('/api/campaigns', { headers, data: { branchId: me.branchId, name: 'Browser intake origin', routingMethod: 'MANUAL' } }); expect(campaignResponse.status()).toBe(201);
    const campaign = (await campaignResponse.json()).id; expect((await manager.request.post('/api/campaigns/'+campaign+'/activate', { headers })).status()).toBe(200);
    const name = 'Browser intake <img src=x onerror="window.__originXss=1">';
    const made = await manager.request.post('/api/leads', { headers, data: { branchId: me.branchId, campaignId: campaign, contact: { name, phone: '+15556667782' } } }); expect(made.status()).toBe(201); const lead = (await made.json()).id, root = '/api/leads/'+lead+'/intake-origin';
    const origin = (await (await manager.request.get(root)).json()).origin; expect(origin.originKind).toBe('HUMAN_MANUAL'); expect(origin.routing.ownerId).toBeNull();
    expect((await page.request.get(root)).status()).toBe(404);
    let version = (await (await manager.request.get('/api/leads/'+lead)).json()).lead.version;
    expect((await manager.request.post('/api/leads/'+lead+'/assignment', { headers, data: { version, agentId: agent.id, reason: 'Current ownership differs from original intake' } })).status()).toBe(200);
    await page.reload(); await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'Details', exact: true }).click();
    const panel = page.locator('[data-lead-intake-origin]'); await panel.getByRole('button', { name: 'Review intake origin', exact: true }).click();
    await expect(panel).toContainText('Manual entry by an authorized user'); await expect(panel).toContainText('Unassigned'); await expect(panel).toContainText('current owner may differ');
    expect((await (await page.request.get(root)).json()).origin.id).toBe(origin.id);
    expect(await panel.locator('img').count()).toBe(0); expect(await page.evaluate(() => Object.hasOwn(window, '__originXss'))).toBe(false);
    await page.getByRole('combobox', { name: 'Language' }).selectOption('fr'); await expect(panel).toContainText('Saisie manuelle par un utilisateur autorisé');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('ar'); await page.setViewportSize({ width: 390, height: 844 }); await expect(panel).toContainText('إدخال يدوي بواسطة مستخدم مخوّل');
    await panel.screenshot({ path: '.local/e2e/lead-intake-origin-ar.png' }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
    await page.getByRole('combobox', { name: 'Language' }).selectOption('en');
    const secondContext = await browser.newContext({ extraHTTPHeaders: { 'x-e2e-rate-scope': randomUUID() } }), second = await secondContext.newPage();
    try { await login(second, 'second'); const secondUser = await (await second.request.get('/api/auth/me')).json();
      version = (await (await manager.request.get('/api/leads/'+lead)).json()).lead.version;
      expect((await manager.request.post('/api/leads/'+lead+'/assignment', { headers, data: { version, agentId: secondUser.id, reason: 'Current authorization must be rechecked' } })).status()).toBe(200);
      await panel.getByRole('button', { name: 'Review intake origin', exact: true }).click(); await expect(panel.getByRole('alert')).toBeVisible(); await expect(panel.locator('[data-lead-intake-record]')).toHaveCount(0);
      const moved = await second.request.get(root); expect(moved.status()).toBe(200); expect((await moved.json()).origin.id).toBe(origin.id);
    } finally { await secondContext.close(); }
    expect((await (await manager.request.get('/api/leads/'+lead+'/conversations')).json()).items).toEqual([]); expect(errors).toEqual([]);
  } finally { await managerContext.close(); await agentContext.close(); }
});
