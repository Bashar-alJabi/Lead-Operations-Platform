import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

test('Super Admin changes staff role and branch from Users and the old staff session loses access',async({page,browser})=>{
  const {password}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string};
  const staffEmail='scope-staff@browser.test';
  const staff=await browser.newContext({baseURL:'http://127.0.0.1:4100',extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  try {
    const staffLogin=()=>staff.request.post('/api/auth/login',{headers:{origin:'http://127.0.0.1:4100'},data:{email:staffEmail,password}});
    expect((await staffLogin()).ok()).toBeTruthy();
    expect((await (await staff.request.get('/api/auth/me')).json()).role).toBe('AGENT');
    await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
    await page.goto('/');
    await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
    await page.getByLabel('Email',{exact:true}).fill('admin@browser.test');
    await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Users',exact:true}).click();
    const row=page.getByRole('row').filter({has:page.getByRole('cell',{name:staffEmail,exact:true})});
    await row.getByRole('button',{name:'Role and branch',exact:true}).click();
    const panel=page.locator('[data-staff-operational-scope]');
    await panel.getByRole('combobox',{name:'Staff role',exact:true}).selectOption('MANAGER');
    await panel.getByRole('combobox',{name:'Staff branch',exact:true}).selectOption({label:'Other Branch'});
    const reason='<svg onload=alert(1)> Verified team change';
    await panel.getByRole('textbox',{name:'Scope change reason',exact:true}).fill(reason);
    await panel.getByRole('button',{name:'Save role and branch',exact:true}).click();
    await expect(row.getByRole('cell',{name:'MANAGER',exact:true})).toBeVisible();
    await expect(row.getByRole('cell',{name:'Other Branch',exact:true})).toBeVisible();
    await expect(panel).toContainText(reason);
    await expect(panel.locator('svg')).toHaveCount(0);
    expect((await staff.request.get('/api/auth/me')).status()).toBe(401);
    expect((await staffLogin()).ok()).toBeTruthy();
    expect((await (await staff.request.get('/api/auth/me')).json()).role).toBe('MANAGER');
    const branches=(await (await staff.request.get('/api/branches')).json()).items as Array<{name:string}>;
    expect(branches.map(branch=>branch.name)).toEqual(['Other Branch']);
    await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('ar');
    await page.setViewportSize({width:390,height:844});
    await expect(panel.getByRole('heading',{name:'سجل الدور والفرع',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  } finally { await staff.close(); }
});
