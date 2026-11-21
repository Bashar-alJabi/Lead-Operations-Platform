import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('A scoped automation requests human review and the manager resolves it from the attention center', async ({ page, request }) => {
  const fixture = JSON.parse(await readFile('.local/e2e/fixture.json', 'utf8')) as { password: string; testToken: string };
  const headers = { origin: 'http://127.0.0.1:4100' };
  const control = { authorization: 'Bearer ' + fixture.testToken };
  await page.setExtraHTTPHeaders({ 'x-e2e-rate-scope': randomUUID() });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
  await page.getByLabel('Email', { exact: true }).fill('manager@browser.test');
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const { branchId } = await (await page.request.get('/api/auth/me')).json();
  const campaign = await page.request.post('/api/campaigns', { headers, data: { branchId, name: 'Synthetic review workflow campaign' } });
  expect(campaign.status(), await campaign.text()).toBe(201);
  const { id: campaignId } = await campaign.json();
  const activate = await page.request.post('/api/campaigns/' + campaignId + '/activate', { headers });
  expect(activate.status(), await activate.text()).toBe(200);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const workspace = page.locator('[data-automation-workspace]'), editor = workspace.locator('[data-automation-editor]');
  await workspace.getByRole('button', { name: 'New automation', exact: true }).click();
  await editor.getByLabel('Rule name', { exact: true }).fill('Review the intake');
  await editor.getByLabel('Campaign scope', { exact: true }).selectOption(campaignId);
  await editor.getByLabel('Owner condition', { exact: true }).selectOption('UNASSIGNED');
  await editor.getByLabel('Action', { exact: true }).selectOption('REQUEST_HUMAN_ATTENTION');
  const unsafeNote = 'Review <img src=x onerror=alert(1)> as text';
  await editor.locator('textarea').fill(unsafeNote);
  await editor.getByLabel('Enable this rule', { exact: true }).check();
  await editor.getByLabel('Approval reason', { exact: true }).fill('Approve synthetic human review');
  await editor.getByRole('button', { name: 'Approve and save automation', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(workspace.locator('[data-automation-rule]').filter({ hasText: 'Review the intake' })).toContainText('Request human review');

  const lead = await page.request.post('/api/leads', { headers, data: { branchId, campaignId,
    contact: { name: 'Synthetic automation review lead', email: randomUUID() + '@browser.test' } } });
  expect(lead.status(), await lead.text()).toBe(201);
  const { id: leadId } = await lead.json();
  for (const phase of ['MATCH', 'EXECUTE']) {
    const run = await request.post('/__test__/automation', { headers: control, data: { phase } });
    expect(run.ok(), await run.text()).toBeTruthy();
  }
  const publication = await request.post('/__test__/lead-attention', { headers: control });
  expect(publication.ok(), await publication.text()).toBeTruthy();

  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const notice = page.locator('[data-lead-attention]').filter({ hasText: 'Automation requested human review' });
  await expect(notice).toContainText('Lead still needs review');
  await notice.locator('..').getByRole('button', { name: 'Open Lead', exact: true }).click();
  const review = page.locator('[data-automation-human-review]');
  await expect(review).toContainText(unsafeNote);
  await expect(review.locator('img')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Complete review', exact: true })).toBeDisabled();
  await review.getByLabel('Review resolution note', { exact: true }).fill('Reviewed from the attention center');
  await review.getByRole('button', { name: 'Complete review', exact: true }).click();
  await expect(review.getByRole('status')).toHaveText('Review completed.');
  await expect(page.getByText('Reviewed from the attention center', { exact: true })).toBeVisible();
  const current = await page.request.get('/api/leads/' + leadId + '/automation-review');
  expect((await current.json()).review).toBeNull();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(notice).toBeVisible();
  await expect(notice).not.toContainText('Lead still needs review');
});
