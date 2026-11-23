import {expect,test,type APIResponse} from '@playwright/test';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createCampaign,headers,login,showConversation} from './returning-conversation-fixture.js';

async function read(response:APIResponse,status=200){
  expect(response.status(),await response.text()).toBe(status);
  return response.json();
}

test('A signed incoming message for two open Leads waits for the scoped Manager to choose one',async({page,browser,request})=>{
  const {password,testToken}=JSON.parse(await readFile('.local/e2e/fixture.json','utf8')) as {password:string;testToken:string};
  const agent=await browser.newPage({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  const other=await browser.newPage({extraHTTPHeaders:{'x-e2e-rate-scope':randomUUID()}});
  try{
    await page.context().setExtraHTTPHeaders({'x-e2e-rate-scope':randomUUID()});
    await login(page,'manager@browser.test',password);
    await login(agent,'agent@browser.test',password);
    await login(other,'other@browser.test',password);
    const selectedCampaign=await createCampaign(page,'Ambiguous inbound enrollment');
    const otherCampaign=await createCampaign(page,'Ambiguous inbound orientation');
    const contact={name:'Synthetic customer with two open Leads',phone:'+15556668135'};
    async function lead(campaign:{campaignId:string;branchId:string}){
      const created=await read(await page.request.post('/api/leads',{headers,data:{...campaign,contact}}),201);
      const detail=await read(await page.request.get('/api/leads/'+created.id));
      expect(detail.lead.lifecycle).toBe('OPEN');
      return detail.lead as {id:string;contact_id:string};
    }
    const selected=await lead(selectedCampaign);
    const alternate=await lead(otherCampaign);
    expect(selected.contact_id).toBeTruthy();
    expect(alternate.contact_id).toBe(selected.contact_id);
    const conversations=async(leadId:string)=>(await read(await page.request.get(`/api/leads/${leadId}/conversations`))).items;
    expect(await conversations(selected.id)).toHaveLength(0);
    expect(await conversations(alternate.id)).toHaveLength(0);

    const {items:connections}=await read(await page.request.get('/api/messaging/connections',{params:{limit:100}}));
    const connection=connections.find((item:{name:string})=>item.name==='Browser Intake Messaging Connection');
    expect(connection).toBeTruthy();
    const message='<img src=x onerror="window.inboundAcceptanceXss=1"> Please link this to the correct enrollment.';
    const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'5621275203',changes:[{field:'messages',value:{
      messaging_product:'whatsapp',metadata:{phone_number_id:'15550001834'},messages:[{id:'wamid.ambiguity.'+randomUUID(),
        from:contact.phone.slice(1),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:message}}]
    }}]}]});
    const signature=createHmac('sha256','test-intake-returning-e2e-secret').update(body).digest('hex');
    const webhook=async()=>(await read(await request.post(`/api/webhooks/messaging/meta/${connection.id}`,{data:body,
      headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+signature}}))).created;
    const publish=()=>request.post('/__test__/operational-alerts',{headers:{authorization:'Bearer '+testToken}}).then(response=>read(response));
    expect(await webhook()).toBe(1);
    expect(await webhook()).toBe(0);
    await publish();

    const root=`/api/messaging/connections/${connection.id}/inbound-review`;
    const pending=(await read(await page.request.get(root))).items.find((item:{participant_last4:string})=>item.participant_last4==='8135');
    expect(pending?.failure_code).toBe('MULTIPLE_ACTIVE_LEADS');
    const eventPath=`${root}/${pending.id}`;
    const detail=await read(await page.request.get(eventPath));
    expect(detail.event).toMatchObject({state:'NEEDS_ATTENTION',leadId:null,conversationId:null,body:message});
    expect(detail.leads.map((item:{id:string})=>item.id).sort()).toEqual([selected.id,alternate.id].sort());
    expect(detail.conversations).toHaveLength(0);
    for(const denied of [agent,other]){
      expect([403,404]).toContain((await denied.request.get(eventPath)).status());
      expect([403,404]).toContain((await denied.request.post(`${eventPath}/resolve`,{headers,data:{leadId:selected.id}})).status());
    }
    expect(await conversations(selected.id)).toHaveLength(0);
    expect(await conversations(alternate.id)).toHaveLength(0);

    const inbox=await read(await page.request.get('/api/notifications',{params:{language:'en',limit:50}}));
    const notice=inbox.items.find((item:{eventType:string;operational?:{inboundEventId:string}})=>
      item.eventType==='INBOUND_REVIEW_REQUIRED'&&item.operational?.inboundEventId===pending.id);
    expect(notice?.operational.current).toBe(true);
    await page.getByRole('button',{name:'Notifications',exact:true}).click();
    const card=page.locator(`[data-notification="${notice.id}"]`);
    await card.getByRole('button',{name:'Open inbound review',exact:true}).click();
    const review=card.locator('.inbound-review');
    await expect(review).toContainText(message);
    await expect(review.locator('img')).toHaveCount(0);
    const chooser=review.getByRole('combobox',{name:'Attach to',exact:true});
    await expect(chooser.getByRole('option')).toHaveCount(3);
    const resolve=review.getByRole('button',{name:'Resolve',exact:true});
    await expect(resolve).toBeDisabled();
    await chooser.selectOption('lead:'+selected.id);
    await expect(review.locator('.inbound-target-summary')).toContainText('Ambiguous inbound enrollment');
    await resolve.click();
    await expect(chooser).toHaveCount(0);

    const resolved=(await read(await page.request.get(eventPath))).event;
    expect(resolved).toMatchObject({state:'PROCESSED',leadId:selected.id,body:message});
    expect(resolved.conversationId).toBeTruthy();
    expect(await webhook()).toBe(0);
    await publish();
    expect(await conversations(alternate.id)).toHaveLength(0);
    expect(await conversations(selected.id)).toMatchObject([{id:resolved.conversationId,state:'WAITING_FOR_HUMAN'}]);
    const transcript=await read(await page.request.get(`/api/conversations/${resolved.conversationId}/messages`));
    expect(transcript.items).toMatchObject([{direction:'INBOUND',author_type:'CUSTOMER',body:message}]);
    await page.getByRole('button',{name:'Refresh notifications',exact:true}).click();
    await expect(card).toContainText('Historical alert');
    const {panel}=await showConversation(page,selected.id);
    await expect(panel.getByText(message,{exact:true})).toBeVisible();
    expect(await page.evaluate(()=>Object.hasOwn(window,'inboundAcceptanceXss'))).toBe(false);
  }finally{
    await Promise.all([agent.close(),other.close()]);
  }
});
