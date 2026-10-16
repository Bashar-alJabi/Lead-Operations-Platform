import { expect, type APIResponse, type Page } from '@playwright/test';
export async function verifyActionRecoveryUI(f: { manager: Page; page: Page; cv: string; kind: 'QUALIFICATION' | 'HANDOFF'; leadName: string; token: string; execute: () => Promise<APIResponse> }) {
  const { manager, page, cv, kind } = f, origin = 'http://127.0.0.1:4100';
  const control = (offsetSeconds: number, failStep?: boolean) => manager.request.post('/__test__/ai-local-action', { headers: { origin, authorization: 'Bearer ' + f.token }, data: { conversationId: cv, kind, offsetSeconds, failStep } });
  const root = '/api/conversations/' + cv + '/ai-action-jobs';
  try {
    expect((await page.request.post('/__test__/ai-local-action', { data: { conversationId: cv, kind, offsetSeconds: 0 } })).status()).toBe(403);
    for (let attempt = 0; attempt < 5; attempt++) { expect((await control(attempt * 60, true)).status()).toBe(200); const r = await f.execute(); expect(r.status()).toBe(200); expect((await r.json()).processed).toBe(true); }
    expect((await (await f.execute()).json()).processed).toBe(false);
    const jobs = page.locator('[data-ai-action-jobs]'); await jobs.getByRole('button', { name: 'Review AI action jobs', exact: true }).click();
    await expect(jobs).toContainText('Automatic retries stopped'); await expect(jobs).toContainText('AI_LOCAL_ACTION_FAILED'); await expect(jobs.getByRole('button', { name: 'Retry AI action job', exact: true })).toHaveCount(0);
    const failed = (await (await page.request.get(root)).json()).items.find((j: any) => j.kind === kind); expect(failed.failureCount).toBe(5); expect(failed.canRetry).toBe(false);
    expect((await page.request.post(root + '/' + failed.id + '/retry', { headers: { origin }, data: { version: failed.version, reason: 'Agent cannot repair queue' } })).status()).toBe(403);
    await manager.reload(); await manager.getByRole('row').filter({ hasText: f.leadName }).getByRole('button', { name: 'Details', exact: true }).click();
    await manager.getByRole('heading', { name: 'Customer conversations', exact: true }).locator('..').getByRole('button', { name: 'View messages', exact: true }).click();
    const adminJobs = manager.locator('[data-ai-action-jobs]'), read = () => adminJobs.getByRole('button', { name: 'Review AI action jobs', exact: true }).click();
    await read(); const job = adminJobs.locator('[data-ai-action-job="' + failed.id + '"]'); await expect(job).toContainText('Automatic retries stopped');
    await job.getByRole('button', { name: 'Action job history', exact: true }).click(); await expect(job.locator('[data-ai-action-job-history]')).toContainText('FAILURE');
    expect(await adminJobs.textContent()).not.toContain('NeverExposeBrowserSQLSecret');
    await manager.getByRole('combobox', { name: 'Language' }).selectOption('fr'); await adminJobs.getByRole('button', { name: 'Consulter les tâches des actions IA', exact: true }).click(); await expect(adminJobs).toContainText('Relances automatiques arrêtées');
    await manager.getByRole('combobox', { name: 'Language' }).selectOption('ar'); await manager.setViewportSize({ width: 390, height: 844 });
    await adminJobs.getByRole('button', { name: 'مراجعة وظائف إجراءات AI', exact: true }).click(); await expect(adminJobs).toContainText('توقفت المحاولات التلقائية');
    await adminJobs.screenshot({ path: '.local/e2e/ai-action-jobs-' + kind.toLowerCase() + '-ar.png' }); expect(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await manager.getByRole('combobox', { name: 'Language' }).selectOption('en'); await manager.setViewportSize({ width: 1280, height: 900 });
    await adminJobs.getByLabel('Include completed action jobs', { exact: true }).check(); await read();
    // Failed authorization clears every previously loaded job/history and requires a new successful read.
    await manager.route('**/api/conversations/*/ai-action-jobs?**', r => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'AI_ACTION_JOB_ACCESS_REVOKED' }) }));
    await read(); await expect(adminJobs.getByRole('alert')).toBeVisible(); await expect(adminJobs.locator('[data-ai-action-job]')).toHaveCount(0); await manager.unroute('**/api/conversations/*/ai-action-jobs?**'); await read();
    expect((await control(240, false)).status()).toBe(200);
    const reason = 'Repair <img src=x onerror="window.__queueXss=1">'; await job.getByLabel('Action job retry reason', { exact: true }).fill(reason); await job.getByRole('button', { name: 'Retry AI action job', exact: true }).click();
    await expect(job).toContainText('Scheduled'); await expect(job).toContainText('Failed attempts: 0');
    const applied = await f.execute(); expect(applied.status()).toBe(200); expect((await applied.json()).processed).toBe(true); await read(); await expect(job).toContainText('Local processing finished');
    await job.getByRole('button', { name: 'Action job history', exact: true }).click(); await expect(job.locator('[data-ai-action-job-history]')).toContainText('HUMAN_RETRY'); await expect(job).toContainText(reason);
    expect(await job.locator('img').count()).toBe(0); expect(await manager.evaluate(() => Object.hasOwn(window, '__queueXss'))).toBe(false);
  } finally { await control(0, false).catch(() => undefined); }
}
