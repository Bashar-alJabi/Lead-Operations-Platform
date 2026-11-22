import { expect,test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('Super Admin queues a reset link for the registered staff address and the recipient restores access',async({browser,page})=>{
  const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string};
  const headers={origin:'http://127.0.0.1:4100'};
  await page.setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
  await page.goto('/');
  await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
  await page.getByLabel('Email',{exact:true}).fill('admin@browser.test');
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Users',exact:true}).click();
  const smtp=await page.request.put('/api/identity/email',{headers,data:{name:'Synthetic Identity mail',host:'smtp.identity.browser.test',
    port:465,secure:true,username:'synthetic-identity',password:'synthetic-browser-identity-password',fromAddress:'identity@browser.test'}});
  expect(smtp.ok(),await smtp.text()).toBeTruthy();
  expect((await page.request.post('/api/identity/email/test',{headers})).status()).toBe(200);
  const branches=(await (await page.request.get('/api/branches')).json()).items;
  const branchId=branches.find((branch:{name:string})=>branch.name==='Browser Branch').id;
  const email='reset-'+randomUUID()+'@browser.test';
  const invite=await page.request.post('/api/users',{headers,data:{branchId,role:'AGENT',name:'Synthetic reset recipient',email}});
  expect(invite.status(),await invite.text()).toBe(201);

  async function deliverIdentityLink() {
    const response=await page.request.post('/__test__/identity-delivery',{headers:{...headers,authorization:'Bearer '+testToken}});
    expect(response.ok()).toBeTruthy();
    const {message}=await response.json() as {message:{to:string;text:string}};
    expect(message.to).toBe(email);
    return new URL(message.text.match(/https?:\/\/\S+/)![0]!);
  }
  const invitation=await deliverIdentityLink(),initialPassword='Synthetic initial password '+randomUUID();
  const staff=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  try {
    const invitationToken=new URLSearchParams(invitation.hash.slice(1)).get('invite');
    const accepted=await staff.request.post('/api/auth/invitations/accept',{headers,data:{token:invitationToken,password:initialPassword}});
    expect(accepted.status()).toBe(200);
    expect((await staff.request.post('/api/auth/login',{headers,data:{email,password:initialPassword}})).status()).toBe(200);
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    const row=page.getByRole('row').filter({has:page.getByRole('cell',{name:email,exact:true})});
    await row.getByRole('button',{name:'Send password reset link',exact:true}).click();
    const panel=page.locator('[data-user-password-reset]');
    await expect(panel).toContainText(email);
    await panel.getByRole('textbox',{name:'Reset request reason',exact:true}).fill('Synthetic staff request for access recovery');
    await panel.getByRole('button',{name:'Queue reset link',exact:true}).click();
    await expect(panel.getByRole('status')).toContainText('The password reset email was queued.');
    expect((await staff.request.get('/api/auth/me')).status()).toBe(200);

    const reset=await deliverIdentityLink();
    expect(reset.hash).toMatch(/^#reset=/);
    const recovery=await browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
    try {
      const tab=await recovery.newPage(),newPassword='Synthetic restored password '+randomUUID();
      await tab.goto(reset.href);
      await tab.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
      await tab.getByLabel('Password',{exact:true}).fill(newPassword);
      await tab.getByRole('button',{name:'Save',exact:true}).click();
      await expect(tab.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
      expect((await staff.request.get('/api/auth/me')).status()).toBe(401);
      expect((await recovery.request.post('/api/auth/login',{headers,data:{email,password:newPassword}})).status()).toBe(200);
    } finally { await recovery.close(); }
  } finally { await staff.close(); }
});
