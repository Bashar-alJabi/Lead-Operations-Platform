import { expect,test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

test('A manager reads Agent workload, changes default capacity and reviews safe localized profile history',async({page})=>{
  const {password}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string};
  const headers={origin:'http://127.0.0.1:4100'};
  await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
  await page.goto('/');
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
  await page.getByLabel('Email',{exact:true}).fill('manager@browser.test');
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Users',exact:true}).click();
  const agent=(await (await page.request.get('/api/users')).json()).items.find((item:{email:string})=>item.email==='agent@browser.test');
  const root='/api/users/'+agent.id+'/agent-profile';
  const before=(await (await page.request.get(root)).json());
  const row=page.getByRole('row').filter({has:page.getByRole('cell',{name:agent.email,exact:true})});
  const profile=page.locator('[data-agent-profile]');
  try {
    await row.getByRole('button',{name:'Agent profile',exact:true}).click();
    await expect(profile).toContainText('Assigned open leads · '+before.openLeadCount);
    const name='<img src=x onerror=alert(1)> Synthetic Agent';
    await profile.getByRole('textbox',{name:'Agent name',exact:true}).fill(name);
    await profile.getByRole('spinbutton',{name:'Default capacity',exact:true}).fill('0');
    await profile.getByRole('textbox',{name:'Profile change reason',exact:true}).fill('Pause new automatic assignments');
    await profile.getByRole('button',{name:'Save agent profile',exact:true}).click();
    await expect(row).toContainText(name);
    await expect(profile.getByRole('heading',{name:'Agent profile history',exact:true})).toBeVisible();
    await expect(profile.locator('img')).toHaveCount(0);
    expect((await (await page.request.get(root)).json()).capacity).toBe(0);
    await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('ar');
    await page.setViewportSize({width:390,height:844});
    await expect(profile.getByRole('heading',{name:'سجل ملف الوكيل',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  } finally {
    const current=(await (await page.request.get(root)).json());
    if (current.version!==before.version) {
      const restored=await page.request.put(root,{headers,data:{version:current.version,name:before.name,capacity:before.capacity,
        reason:'Restore browser fixture settings'}});
      expect(restored.ok(),await restored.text()).toBeTruthy();
    }
  }
});
