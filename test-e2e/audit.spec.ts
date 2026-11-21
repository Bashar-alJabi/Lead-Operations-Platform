import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('The audit workspace finds a real scoped administrative event and clears results after access is denied', async ({ page, browser }) => {
  const { password } = JSON.parse(await readFile('.local/e2e/fixture.json', 'utf8')) as { password: string };
  async function signIn(target: Page, email: string) {
    await target.setExtraHTTPHeaders({ 'x-e2e-rate-scope': randomUUID() });
    await target.goto('/');
    await target.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
    await target.getByLabel('Email', { exact: true }).fill(email);
    await target.getByLabel('Password', { exact: true }).fill(password);
    await target.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(target.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  }
  await signIn(page, 'manager@browser.test');
  const { branchId } = await (await page.request.get('/api/auth/me')).json();
  const created = await page.request.post('/api/campaigns', { headers: { origin: 'http://127.0.0.1:4100' },
    data: { branchId, name: 'Synthetic audit campaign' } });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = await created.json();
  await page.getByRole('button', { name: 'Audit log', exact: true }).click();
  const workspace = page.locator('[data-audit-workspace]');
  await workspace.getByLabel('Action code', { exact: true }).fill('CAMPAIGN_CREATED');
  await workspace.getByLabel('Record ID', { exact: true }).fill(id);
  await workspace.getByRole('button', { name: 'Search audit log', exact: true }).click();
  const rows = workspace.locator('[data-audit-event]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(id);
  await expect(rows.first()).toContainText('CAMPAIGN_CREATED');
  await expect(workspace.getByLabel('Branch', { exact: true })).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ar');
  await expect(page.getByRole('heading', { name: 'سجل التدقيق', exact: true })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await page.route('**/api/audit-events*', route => route.fulfill({ status: 403, json: { error: 'AUDIT_ACCESS_REVOKED' } }));
  await workspace.getByRole('button', { name: 'بحث في سجل التدقيق', exact: true }).click();
  await expect(workspace.getByRole('alert')).toHaveText('تعذّر جلب أحداث التدقيق.');
  await expect(rows).toHaveCount(0);

  const agent = await browser.newPage();
  try {
    await signIn(agent, 'agent@browser.test');
    await expect(agent.getByRole('button', { name: 'Audit log', exact: true })).toHaveCount(0);
    expect((await agent.request.get('/api/audit-events')).status()).toBe(403);
  } finally {
    await agent.close();
  }
});
