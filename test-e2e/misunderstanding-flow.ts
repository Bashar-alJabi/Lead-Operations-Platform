import { expect, type APIResponse, type Page } from '@playwright/test';
import { emptyAIBehaviorPolicy } from '../src/ai/behavior-policy.js';

export async function verifyMisunderstandingUI(f: { manager: Page; page: Page; second: Page; campaign: string; cv: string;
  open: () => Promise<void>; inbound: (body: string, aiControl?: boolean) => Promise<APIResponse>;
  infer: () => Promise<APIResponse>; execute: () => Promise<APIResponse> }) {
  const { manager, page, second, campaign, cv } = f, origin = 'http://127.0.0.1:4100';
  const tools = '/api/ai/campaigns/' + campaign + '/tool-policy', policy = '/api/ai/campaigns/' + campaign + '/behavior-policy', root = '/api/conversations/' + cv + '/ai-customer-executions';
  const grant = await (await manager.request.get(tools)).json();
  expect((await manager.request.put(tools, { headers: { origin }, data: { version: grant.version, definition: { allowedTools: ['requestHumanHandoff'] }, reason: 'Explicit fresh misunderstanding Handoff approval' } })).status()).toBe(200);
  const before = await (await manager.request.get(policy)).json();
  expect((await manager.request.put(policy, { headers: { origin }, data: { version: before.version, definition: { ...emptyAIBehaviorPolicy(), handoff: { initialContactWithoutAgent: false, transitionMessage: null, misunderstandingLimit: 3 } }, reason: 'Observed repeated misunderstanding threshold' } })).status()).toBe(200);
  await page.getByRole('combobox', { name: 'Language' }).selectOption('en'); await page.setViewportSize({ width: 1280, height: 900 });
  const history = page.locator('[data-ai-customer-history]'), read = () => history.getByRole('button', { name: 'Review AI executions', exact: true }).click();
  for (let n = 1; n <= 3; n++) {
    expect((await f.inbound('Misunderstanding fixture: Still misunderstood <img src=x onerror="window.__misunderstanding=1">', n === 1)).status()).toBe(200);
    expect((await f.infer()).status()).toBe(200); await f.open(); await read();
    const dto = (await (await page.request.get(root)).json()).items[0]; expect(dto.misunderstanding.count).toBe(String(n)); expect(dto.misunderstanding.threshold).toBe(3); expect(dto.misunderstanding.handoffRequired).toBe(n === 3);
    const observation = history.locator('[data-ai-customer-execution]').first().locator('[data-ai-misunderstanding]');
    await expect(observation).toContainText('Computed count at observation: ' + n); await expect(observation).toContainText('Handoff threshold at observation: 3');
    const result = await f.execute(); expect(result.status()).toBe(200); expect((await result.json()).processed).toBe(n === 3);
    expect((await (await page.request.get('/api/conversations/' + cv)).json()).conversation.state).toBe(n === 3 ? 'WAITING_FOR_HUMAN' : 'AI_ACTIVE');
  }
  expect((await second.request.get(root)).status()).toBe(404); expect((await (await f.execute()).json()).processed).toBe(false);
  await f.open(); await read(); await expect(history.locator('[data-ai-customer-action]').first()).toContainText('requestHumanHandoff'); await expect(history.locator('[data-ai-customer-action]').first()).toContainText('APPLIED');
  await page.route('**/api/conversations/*/ai-customer-executions*', r => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'AI_HISTORY_ACCESS_REVOKED' }) }));
  await read(); await expect(history.getByRole('alert')).toBeVisible(); await expect(history.locator('[data-ai-misunderstanding]')).toHaveCount(0); await page.unroute('**/api/conversations/*/ai-customer-executions*'); await read();
  await page.getByRole('combobox', { name: 'Language' }).selectOption('fr'); await history.getByRole('button', { name: 'Consulter les exécutions IA', exact: true }).click(); await expect(history.locator('[data-ai-misunderstanding]').first()).toContainText('Nombre calculé lors de l’observation: 3');
  await page.getByRole('combobox', { name: 'Language' }).selectOption('ar'); await page.setViewportSize({ width: 390, height: 844 }); await history.getByRole('button', { name: 'مراجعة تنفيذ AI', exact: true }).click();
  const localized = history.locator('[data-ai-misunderstanding]').first(); await expect(localized).toContainText('العدد المحسوب عند الملاحظة: 3'); await expect(localized).toContainText('تحقق شرط التحويل وقت الملاحظة');
  await localized.screenshot({ path: '.local/e2e/ai-misunderstanding-ar.png' }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await history.locator('img').count()).toBe(0); expect(await page.evaluate(() => Object.hasOwn(window, '__misunderstanding'))).toBe(false);
  expect((await (await page.request.get('/api/conversations/' + cv + '/messages')).json()).items.every((m: any) => m.direction === 'INBOUND')).toBe(true);
  await page.getByRole('combobox', { name: 'Language' }).selectOption('en'); await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('Takeover reason', { exact: true }).fill('Human accepts repeated misunderstanding Handoff');
  const accepted = page.waitForResponse(r => r.url().endsWith('/api/conversations/' + cv + '/takeover') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Take over conversation', exact: true }).click(); expect((await accepted).status()).toBe(200); await expect(page.getByText('HUMAN_ACTIVE', { exact: false }).first()).toBeVisible();
  expect((await (await page.request.get('/api/conversations/' + cv)).json()).conversation.controller_type).toBe('HUMAN');
  await read(); await expect(history.locator('[data-ai-misunderstanding]').first()).toContainText('Computed count at observation: 3');
}
