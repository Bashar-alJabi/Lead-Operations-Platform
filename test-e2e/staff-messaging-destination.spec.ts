import { expect,test,type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('Staff can consent to a masked number configured by their Manager and withdraw from their account',async({browser})=>{
 const {password}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string};
 const managerContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
 const staffContext=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
 const manager=await managerContext.newPage(),staff=await staffContext.newPage();
 const login=async(page:Page,actor:string)=>{
  await page.goto('/');
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
  await page.getByLabel('Email',{exact:true}).fill(actor+'@browser.test');
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 };
 try{
  await login(manager,'manager');await login(staff,'second');
  await manager.getByRole('button',{name:'Users',exact:true}).click();
  await manager.getByRole('row').filter({hasText:'second@browser.test'}).getByRole('button',{name:'Internal messaging number',exact:true}).click();
  const setup=manager.locator('[data-staff-messaging-destination]'),owner=staff.locator('[data-staff-messaging-destination]');
  const number='+15553560159';
  await setup.getByLabel('Staff phone in international format',{exact:true}).fill(number);
  await setup.getByRole('button',{name:'Save staff number',exact:true}).click();
  await expect(setup).toContainText('••••0159');
  await expect(setup).toContainText('Awaiting staff consent');
  await expect(setup.getByRole('button',{name:'Consent to internal notifications',exact:true})).toHaveCount(0);

  await staff.getByRole('button',{name:'My account',exact:true}).click();
  await expect(owner).toContainText('••••0159');
  await owner.getByLabel('Confirm your international phone number',{exact:true}).fill(number);
  await owner.getByRole('button',{name:'Consent to internal notifications',exact:true}).click();
  await expect(owner).toContainText('Consent recorded');
  await expect(owner).not.toContainText(number);
  await owner.getByRole('button',{name:'Number and consent history',exact:true}).click();
  await expect(owner).toContainText('Consent granted');
  await staff.getByRole('button',{name:'Notifications',exact:true}).click();
  await staff.getByText('Internal messaging notifications',{exact:true}).click();
  const preferences=staff.locator('[data-staff-messaging-preference]');
  await preferences.getByLabel('Internal messaging language',{exact:true}).selectOption('fr');
  await preferences.getByLabel('Enable event',{exact:true}).check();
  await preferences.getByRole('button',{name:'Save messaging preference',exact:true}).click();
  await preferences.getByRole('button',{name:'History',exact:true}).click();
  await expect(preferences).toContainText('Enabled · fr');
  await expect(preferences.getByLabel('Internal messaging event',{exact:true}).locator('option[value="SYSTEM_ALERT"]')).toHaveCount(0);
  await staff.getByRole('button',{name:'My account',exact:true}).click();
  await owner.getByRole('button',{name:'Withdraw consent',exact:true}).click();
  await expect(owner).toContainText('Awaiting staff consent');
  await staff.getByRole('combobox',{name:'Language',exact:true}).selectOption('ar');
  await staff.setViewportSize({width:390,height:844});
  await expect(owner).toContainText('بانتظار موافقة الموظف');
  expect(await staff.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();

  await setup.getByRole('button',{name:'Refresh number',exact:true}).click();
  await setup.getByRole('button',{name:'Remove number',exact:true}).click();
  await expect(setup).toContainText('No internal messaging number configured.');
  await expect(setup).not.toContainText(number);
 }finally{
  await managerContext.close();await staffContext.close();
 }
});
