import { test,expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
test('Independent startup catalogs retain authorized branches and campaigns when Users network request fails, show failure and recover explicitly',async({ browser })=> {
  const fixture=JSON.parse(await readFile(resolve('.local/e2e/fixture.json'),'utf8')) as { password:string };
  const context=await browser.newContext({ extraHTTPHeaders:{ 'x-e2e-rate-scope':randomUUID() } }),page=await context.newPage();let fail=true;
  try {
    await page.route('**/api/users',async route=>{ if(fail)await route.abort('failed');else await route.continue(); });
    await page.goto('/');await page.getByRole('combobox',{ name:'Language' }).selectOption('en');await page.getByLabel('Email',{ exact:true }).fill('admin@browser.test');await page.getByLabel('Password',{ exact:true }).fill(fixture.password);await page.getByRole('button',{ name:'Sign in',exact:true }).click();
    await expect(page.getByRole('button',{ name:'Sign out',exact:true })).toBeVisible();await expect(page.getByRole('alert')).toContainText('Failed to fetch');
    await page.getByRole('button',{ name:'Branches',exact:true }).click();await expect(page.getByRole('row').filter({ hasText:'Browser Branch' })).toBeVisible();
    await page.getByRole('button',{ name:'Campaigns',exact:true }).click();await expect(page.getByRole('row').filter({ hasText:'Browser Campaign' })).toBeVisible();
    await page.getByRole('button',{ name:'Users',exact:true }).click();await expect(page.getByRole('cell',{ name:'admin@browser.test',exact:true })).toHaveCount(0);
    fail=false;await page.getByRole('button',{ name:'Retry',exact:true }).click();await expect(page.getByRole('cell',{ name:'admin@browser.test',exact:true })).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
  }finally { await context.close(); }
});
