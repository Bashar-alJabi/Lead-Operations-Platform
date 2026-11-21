import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('An authorized rule closes a lead when Campaign Status changes and required closure fields are present', async ({ page, request }) => {
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
  const campaign = await page.request.post('/api/campaigns', { headers, data: { branchId, name: 'Synthetic closure automation campaign' } });
  expect(campaign.status(), await campaign.text()).toBe(201);
  const { id: campaignId } = await campaign.json();
  const campaignPath = '/api/campaigns/' + campaignId;

  async function addField(key: string, label: string, fieldType: 'STATUS' | 'TEXT', requiredStage: 'NONE' | 'CLOSE') {
    const field = await page.request.post('/api/fields', { headers, data: { scope: 'CAMPAIGN', branchId, campaignId,
      key, label, fieldType, valueMode: 'MANUAL', options: fieldType === 'STATUS' ? [{ value: 'won', label: 'Won', active: true }] : [], validation: {} } });
    expect(field.status(), await field.text()).toBe(201);
    const { id } = await field.json();
    const binding = await page.request.put(campaignPath + '/fields/' + id, { headers, data: {
      active: true, position: 0, requiredStage, visibleToAgent: true, editableByAgent: true, visibleToManager: true,
      editableByManager: true, showInTable: false, showInDetails: true, filterable: false, usableByAutomation: true, usableByAi: false,
    } });
    expect(binding.status(), await binding.text()).toBe(200);
    return id as string;
  }
  const statusField = await addField('browser_closure_status', 'Campaign sales status', 'STATUS', 'NONE');
  const requiredField = await addField('browser_closure_required', 'Closure evidence', 'TEXT', 'CLOSE');
  const activate = await page.request.post(campaignPath + '/activate', { headers });
  expect(activate.status(), await activate.text()).toBe(200);
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  const workspace = page.locator('[data-automation-workspace]'), editor = workspace.locator('[data-automation-editor]');
  async function approve(name: string, action: string) {
    await workspace.getByRole('button', { name: 'New automation', exact: true }).click();
    await editor.getByLabel('Rule name', { exact: true }).fill(name);
    await editor.getByLabel('Campaign scope', { exact: true }).selectOption(campaignId);
    await editor.getByLabel('Owner condition', { exact: true }).selectOption('ANY');
    await editor.getByLabel('Action', { exact: true }).selectOption(action);
    await editor.getByLabel('Enable this rule', { exact: true }).check();
    await editor.getByLabel('Approval reason', { exact: true }).fill('Approve the synthetic sales workflow');
  }
  async function save() {
    await editor.getByRole('button', { name: 'Approve and save automation', exact: true }).click();
    await expect(editor).toHaveCount(0);
  }
  await approve('Set Won campaign status', 'SET_FIELD_VALUE');
  await editor.getByLabel('Field to update', { exact: true }).selectOption(statusField);
  await editor.getByLabel('Value to set', { exact: true }).selectOption('won');
  await save();
  await approve('Close after status change', 'CLOSE_LEAD');
  await editor.getByLabel('Trigger', { exact: true }).selectOption('FIELD_CHANGED');
  await editor.getByLabel('Watched field', { exact: true }).selectOption(statusField);
  await save();

  async function createLead(name: string, withEvidence: boolean) {
    const lead = await page.request.post('/api/leads', { headers, data: { branchId, campaignId,
      contact: { name, email: randomUUID() + '@browser.test' },
      fields: withEvidence ? [{ fieldId: requiredField, value: 'Evidence checked' }] : [],
    } });
    expect(lead.status(), await lead.text()).toBe(201);
    return (await lead.json()).id as string;
  }
  const blocked = await createLead('Synthetic missing closure evidence', false);
  const closed = await createLead('Synthetic ready for closure', true);
  for (const phase of ['MATCH', 'EXECUTE', 'MATCH', 'EXECUTE']) {
    const result = await request.post('/__test__/automation', { headers: control, data: { phase } });
    expect(result.ok(), await result.text()).toBeTruthy();
  }
  await workspace.getByRole('button', { name: 'Refresh processing', exact: true }).click();
  const outcomes = workspace.locator('[data-automation-processing-id]').filter({ hasText: 'Close after status change' });
  await expect(outcomes).toHaveCount(2);
  await expect(outcomes.filter({ hasText: 'Required closure fields are missing' })).toHaveCount(1);
  await outcomes.filter({ hasText: 'Action applied' }).getByRole('button', { name: 'Open lead', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic ready for closure' })).toBeVisible();
  await expect(page.getByText('Lead closed by automation', { exact: true })).toBeVisible();
  const completed = await page.request.get('/api/leads/' + closed);
  expect((await completed.json()).lead.lifecycle).toBe('CLOSED');
  const incomplete = await page.request.get('/api/leads/' + blocked);
  expect((await incomplete.json()).lead.lifecycle).toBe('OPEN');
});
