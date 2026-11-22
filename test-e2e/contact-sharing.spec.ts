import {expect,test,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('Manual Contact sharing requires an administrator and keeps each Branch’s Lead history scoped',async({browser})=>{
  const {password}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string};
  const headers={origin:'http://127.0.0.1:4100'};
  const contexts=await Promise.all(Array.from({length:3},()=>browser.newContext({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}})));
  const [manager,other,admin]=await Promise.all(contexts.map(context=>context.newPage())) as [Page,Page,Page];
  async function login(page:Page,role:string){
    await page.goto('/');
    await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('en');
    await page.getByLabel('Email',{exact:true}).fill(role+'@browser.test');
    await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  }
  async function newCampaign(page:Page,branchId:string,name:string){
    const created=await page.request.post('/api/campaigns',{headers,data:{branchId,name,routingMethod:'MANUAL'}});
    expect(created.status()).toBe(201);
    const {id}=await created.json();
    expect((await page.request.post(`/api/campaigns/${id}/activate`,{headers})).status()).toBe(200);
    return id as string;
  }
  async function openContact(page:Page,name:string){
    await page.getByRole('button',{name:'Contacts',exact:true}).click();
    const workspace=page.locator('.contact-workspace');
    await workspace.getByLabel('Search name, phone, or email').fill('Shared contact');
    await workspace.getByRole('button',{name:'Search',exact:true}).click();
    await workspace.getByRole('row').filter({hasText:name}).getByRole('button',{name:'Details',exact:true}).click();
    return workspace;
  }
  try{
    await Promise.all([login(manager,'manager'),login(other,'other'),login(admin,'admin')]);
    const {branchId}=await (await manager.request.get('/api/auth/me')).json();
    const {branchId:otherBranch}=await (await other.request.get('/api/auth/me')).json();
    const campaign=await newCampaign(manager,branchId,'Contact sharing origin');
    const otherCampaign=await newCampaign(other,otherBranch,'Contact sharing destination');
    const originalName='Shared contact <img src=x onerror=alert(1)>';
    const original=await manager.request.post('/api/leads',{headers,data:{branchId,campaignId:campaign,
      contact:{name:originalName,phone:'+1 (555) 412-9088'}}});
    expect(original.status()).toBe(201);
    const {id:originalLead}=await original.json();
    const {lead}=await (await manager.request.get('/api/leads/'+originalLead)).json();
    const contactId=lead.contact_id as string;

    const ownerWorkspace=await openContact(manager,originalName);
    await expect(ownerWorkspace.getByRole('button',{name:'Save changes',exact:true})).toBeVisible();
    await expect(ownerWorkspace.locator('img')).toHaveCount(0);
    expect((await other.request.get('/api/contacts/'+contactId)).status()).toBe(404);
    const missingName='Contact sharing request';
    const queued=await other.request.post('/api/leads',{headers,data:{branchId:otherBranch,campaignId:otherCampaign,
      contact:{name:missingName,phone:'+15554129088'}}});
    expect(queued.status()).toBe(202);
    const {reviewId}=await queued.json();
    const reviewPath=`/api/contact-reviews/${reviewId}/resolve`;
    await other.getByRole('button',{name:'Match reviews',exact:true}).click();
    const localReview=other.locator('.contact-workspace .panel').filter({has:other.getByRole('heading',{name:missingName,exact:true})});
    await expect(localReview).toContainText('a Super Admin must decide');
    await expect(localReview.getByRole('button',{name:'Link lead to this contact'})).toBeDisabled();
    await expect(localReview).not.toContainText(originalName);
    expect((await other.request.post(reviewPath,{headers,data:{contactId}})).status()).toBe(403);

    await admin.getByRole('button',{name:'Match reviews',exact:true}).click();
    const adminReview=admin.locator('.contact-workspace .panel').filter({has:admin.getByRole('heading',{name:missingName,exact:true})});
    await adminReview.getByLabel('Candidate contacts').selectOption(contactId);
    const resolution=admin.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===reviewPath);
    await adminReview.getByRole('button',{name:'Link lead to this contact'}).click();
    const linked=await resolution;
    expect(linked.status()).toBe(200);
    const {id:linkedLead}=await linked.json();
    expect(linkedLead).not.toBe(originalLead);
    const retry=await admin.request.post(reviewPath,{headers,data:{contactId}});
    expect((await retry.json()).id).toBe(linkedLead);

    await ownerWorkspace.getByRole('textbox',{name:'Name',exact:true}).fill('Shared contact unapproved edit');
    await ownerWorkspace.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(ownerWorkspace.getByRole('alert')).toHaveText('This contact is read only.');
    await expect(ownerWorkspace.getByRole('button',{name:'Save changes',exact:true})).toHaveCount(0);
    await expect(ownerWorkspace.getByRole('button',{name:originalLead,exact:true})).toBeVisible();
    await expect(ownerWorkspace.getByRole('button',{name:linkedLead,exact:true})).toHaveCount(0);

    const adminWorkspace=await openContact(admin,originalName);
    const updated='Shared contact verified';
    await adminWorkspace.getByRole('textbox',{name:'Name',exact:true}).fill(updated);
    await adminWorkspace.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(adminWorkspace.getByRole('heading',{name:updated,exact:true})).toBeVisible();
    const otherWorkspace=await openContact(other,updated);
    await expect(otherWorkspace.getByText('This contact is read only.',{exact:true})).toBeVisible();
    await expect(otherWorkspace.getByRole('button',{name:linkedLead,exact:true})).toBeVisible();
    await expect(otherWorkspace.getByRole('button',{name:originalLead,exact:true})).toHaveCount(0);
    await other.getByRole('combobox',{name:'Language',exact:true}).selectOption('ar');
    await expect(otherWorkspace.getByText('جهة الاتصال هذه متاحة للقراءة فقط.',{exact:true})).toBeVisible();
  }finally{await Promise.all(contexts.map(context=>context.close()));}
});
