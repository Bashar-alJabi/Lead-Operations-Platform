import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('Campaign setup defines conversion from Status and Analytics lists only the matching lead', async ({ page }) => {
  const { password } = JSON.parse(await readFile('.local/e2e/fixture.json', 'utf8')) as { password: string };
  const headers = { origin: 'http://127.0.0.1:4100' };
  await page.setExtraHTTPHeaders({ 'x-e2e-rate-scope': randomUUID() });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
  await page.getByLabel('Email', { exact: true }).fill('manager@browser.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const { branchId } = await (await page.request.get('/api/auth/me')).json();
  const name = 'Synthetic field conversion campaign';
  const campaign = await page.request.post('/api/campaigns', { headers, data: { branchId, name } });
  expect(campaign.status(), await campaign.text()).toBe(201);
  const { id: campaignId } = await campaign.json(), root = '/api/campaigns/' + campaignId;
  const field = await page.request.post('/api/fields', { headers, data: {
    scope: 'CAMPAIGN', branchId, campaignId, key: 'browser_conversion_status', label: 'Sales outcome',
    fieldType: 'STATUS', valueMode: 'MANUAL', validation: {},
    options: [{ value: 'won', label: 'Won', active: true }, { value: 'new', label: 'New', active: true }],
  } });
  expect(field.status(), await field.text()).toBe(201);
  const { id: fieldId } = await field.json();
  const binding = await page.request.put(root+'/fields/'+fieldId, { headers, data: {
    active: true, position: 0, requiredStage: 'NONE', visibleToAgent: false, editableByAgent: false,
    visibleToManager: true, editableByManager: true, showInTable: false, showInDetails: true,
    filterable: false, usableByAutomation: false, usableByAi: false,
  } });
  expect(binding.status(), await binding.text()).toBe(200);
  await page.getByRole('button', { name: 'Campaigns', exact: true }).click();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'Details', exact: true }).click();
  const editor = page.locator('.campaign-form');
  await editor.getByRole('combobox', { name: 'Conversion definition', exact: true }).selectOption('FIELD_VALUE');
  await editor.getByRole('combobox', { name: 'Conversion field', exact: true }).selectOption(fieldId);
  const save = editor.getByRole('button', { name: 'Save settings', exact: true });
  await expect(save).toBeDisabled();
  const value = editor.getByRole('combobox', { name: 'Conversion field value', exact: true });
  await value.selectOption('won');
  const [saved] = await Promise.all([
    page.waitForResponse(response => response.request().method()==='PATCH' && response.url().endsWith(root)),
    save.click(),
  ]);
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(value).toHaveValue('won');
  const activated = await page.request.post(root+'/activate', { headers });
  expect(activated.status(), await activated.text()).toBe(200);
  for (const [label, value] of [['Synthetic matching conversion', 'won'], ['Synthetic unmatched conversion', 'new']]) {
    const lead = await page.request.post('/api/leads', { headers, data: {
      branchId, campaignId, contact: { name: label, email: randomUUID()+'@browser.test' }, fields: [{ fieldId, value }],
    } });
    expect(lead.status(), await lead.text()).toBe(201);
  }
  await page.getByRole('button', { name: 'Analytics', exact: true }).click();
  const analytics=page.locator('[data-analytics-workspace]');
  await analytics.getByLabel('Campaign', { exact: true }).selectOption(campaignId);
  await analytics.getByRole('button', { name: 'Load analytics', exact: true }).click();
  await expect(analytics.locator('[data-analytics-conversion]')).toHaveText('50.00%');
  await expect(analytics.locator('[data-analytics-groups]')).toContainText('Campaign field value');
  await analytics.locator('[data-analytics-metric="CONVERTED"]').click();
  const drill=analytics.locator('[data-analytics-drilldown]');
  await expect(drill.locator('[data-analytics-lead]')).toHaveCount(1);
  await expect(drill).toContainText('Synthetic matching conversion');
});
