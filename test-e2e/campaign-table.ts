import { expect, type Page } from '@playwright/test';

export async function campaignRow(page: Page, name: string) {
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
  const more = page.locator('[data-campaign-next-page]');
  await expect(row.or(more).first()).toBeVisible();
  while (!(await row.isVisible()) && await more.isVisible()) {
    const [response] = await Promise.all([
      page.waitForResponse(result => {
        const url = new URL(result.url());
        return result.request().method()==='GET' && url.pathname==='/api/campaigns' && url.searchParams.has('cursor');
      }),
      more.click(),
    ]);
    expect(response.ok(), await response.text()).toBeTruthy();
    await expect(page.locator('[data-campaign-next-page]:disabled')).toHaveCount(0);
  }
  await expect(row).toBeVisible();
  return row;
}
