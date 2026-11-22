import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
async function fixture(t:TestContext){
 process.env.APP_ORIGIN='http://127.0.0.1:5173';process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});t.after(async()=>{await app.close();await db.end();});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Analytics') RETURNING id`)[0]!.id,foreign=(await db`INSERT INTO organization(name) VALUES('Foreign analytics') RETURNING id`)[0]!.id,
  branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id,other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id,
  foreignBranch=(await db`INSERT INTO branch(organization_id,name) VALUES(${foreign},'Foreign') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,bid,oid] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['second','AGENT',branch,org],['other','MANAGER',other,org],['foreign','SUPER_ADMIN',null,foreign]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${oid},${bid},${role},${name},${name+'@analytics.test'},'synthetic') RETURNING id`)[0]!.id,
   token=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
  users[name]={id,session,cookie:'lop_session='+token};
 }
 const campaigns:string[]=[];
 for(const [name,type,bid,oid] of [['Payment campaign <img literal>','PAYMENT_CONFIRMED',branch,org],['Undefined',null,branch,org],['Enrollment campaign','ENROLLMENT_CONFIRMED',branch,org],['Other',null,other,org],['Foreign',null,foreignBranch,foreign]] as const){
  campaigns.push((await db`INSERT INTO campaign(organization_id,branch_id,name,status,conversion_config) VALUES(${oid},${bid},${name},'ACTIVE',${db.json(type?{type}:{})}) RETURNING id`)[0]!.id);
 }
 const leads:string[]=[];
 for(const [i,ci,owner,bid,oid] of [[0,0,users.agent!.id,branch,org],[1,1,users.second!.id,branch,org],[2,2,users.agent!.id,branch,org],[3,0,null,branch,org],[4,3,null,other,org],[5,4,null,foreignBranch,foreign]] as const){
  const contact=(await db`INSERT INTO contact(organization_id,name,phone,phone_normalized) VALUES(${oid},${'Analytics contact '+i},${'+15554441'+String(i).padStart(3,'0')},${'+15554441'+String(i).padStart(3,'0')}) RETURNING id`)[0]!.id;
  leads.push((await db`INSERT INTO lead(organization_id,branch_id,campaign_id,contact_id,assigned_agent_id,source_kind,created_at,lifecycle,needs_attention_reason)
   VALUES(${oid},${bid},${campaigns[ci]!},${contact},${owner},${i===1?'META':'MANUAL'},${'2020-01-01T00:00:00.000'+String(i+1)+'00Z'}::text::timestamptz,${i===3?'CLOSED':'OPEN'},${i===3?'SYNTHETIC_ATTENTION':null}) RETURNING id`)[0]!.id);
 }
 const api=(method:'GET'|'POST'|'PUT'|'PATCH',path:string,payload?:object,who='manager')=>app.inject({method,url:path,payload,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}});
 const overview=async(query='',who='manager')=>{const r=await api('GET','/api/analytics/overview'+(query?'?'+query:''),undefined,who);assert.equal(r.statusCode,200,r.body);return r.json();};
 return {db,app,org,branch,other,campaigns,leads,users,api,overview};
}

test('Campaign Status defines a typed conversion with matching aggregate and drilldown, current visibility and native integrity',async t=>{
 const {db,branch,campaigns,leads,users,api,overview}=await fixture(t);
 const campaign=campaigns[0]!,root='/api/campaigns/'+campaign,filter='campaignId='+campaign;
 await db`UPDATE campaign SET status='DRAFT' WHERE id=${campaign}`;
 const definition=await api('POST','/api/fields',{scope:'CAMPAIGN',branchId:branch,campaignId:campaign,key:'analytics_status',
  label:'Approved conversion status',fieldType:'STATUS',valueMode:'MANUAL',options:[
   {value:'won',label:'Won',active:true},{value:'pending',label:'Pending',active:true},
  ],validation:{}});
 assert.equal(definition.statusCode,201,definition.body);
 const {id:field}=definition.json();
 const binding=await api('PUT',root+'/fields/'+field,{active:true,position:0,requiredStage:'NONE',
  visibleToAgent:false,editableByAgent:false,visibleToManager:true,editableByManager:true,showInTable:false,
  showInDetails:true,filterable:false,usableByAutomation:false,usableByAi:false});
 assert.equal(binding.statusCode,200,binding.body);
 const detail=async(who='manager')=>(await api('GET',root,undefined,who)).json();
 const edit={version:(await detail()).campaign.version,name:'Scoped conversion campaign',sourceKind:'MANUAL',
  routingMethod:'MANUAL',messagingEnabled:false,aiEnabled:false};
 const conversion={type:'FIELD_VALUE',fieldId:field,value:'won'};
 assert.equal((await api('PATCH',root,{...edit,conversion:{...conversion,value:'fabricated'}})).statusCode,400);
 assert.equal((await api('PATCH',root,{...edit,conversion:{...conversion,fieldId:randomUUID()}})).statusCode,404);
 assert.equal((await api('PATCH',root,{...edit,conversion},'agent')).statusCode,403);
 assert.equal((await api('PATCH',root,{...edit,conversion},'other')).statusCode,403);
 const save=await api('PATCH',root,{...edit,conversion});
 assert.equal(save.statusCode,200,save.body);
 assert.equal((await api('PATCH',root,{...edit,conversion})).statusCode,409);
 assert.equal((await detail()).conversionField.id,field);
 for(const [id,value] of [[leads[0],'won'],[leads[3],'pending']]){
  const write=await api('PUT','/api/leads/'+id+'/fields/'+field,{value});
  assert.equal(write.statusCode,200,write.body);
 }
 assert.deepEqual((await overview(filter)).conversion,{configuredLeads:'2',converted:'1',unconfiguredLeads:'0',rate:'50.00'});
 assert.equal((await overview(filter)).leads.paid,'0');
 assert.equal((await overview(filter+'&paymentMode=TEST')).conversion.converted,'1');
 const group=(await api('GET','/api/analytics/groups?'+filter+'&by=CAMPAIGN')).json().items[0];
 assert.equal(group.definition,'FIELD_VALUE');assert.equal(group.rate,'50.00');
 const drill=(who='manager')=>api('GET','/api/analytics/leads?metric=CONVERTED&'+filter,undefined,who);
 assert.deepEqual((await drill('manager')).json().items.map((item:{id:string})=>item.id),[leads[0]]);
 assert.equal((await overview(filter,'agent')).conversion.rate,null);
 assert.equal((await drill('agent')).json().items.length,0);
 await assert.rejects(db`UPDATE campaign SET conversion_config=${db.json({...conversion,value:'fabricated'})} WHERE id=${campaign}`,
  /CAMPAIGN_CONVERSION_INVALID/);

 await db`UPDATE campaign_field SET visible_to_manager=false,editable_by_manager=false,version=version+1
  WHERE campaign_id=${campaign} AND field_id=${field}`;
 const redacted=await detail();
 assert.deepEqual(redacted.campaign.conversion_config,{type:'FIELD_VALUE',unavailable:true});
 assert.equal(redacted.conversionField,null);
 assert.deepEqual((await api('GET',root+'/conversion-fields')).json().items,[]);
 assert.equal((await overview(filter)).conversion.rate,null);
 assert.equal((await overview(filter,'admin')).conversion.converted,'1');
 assert.equal((await api('PATCH',root,{...edit,version:save.json().version,name:'Rename without replacing the protected definition'})).statusCode,200);
 assert.deepEqual((await detail('admin')).campaign.conversion_config,conversion);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
 assert.equal((await api('GET',root+'/conversion-fields')).statusCode,401);
});

test('Analytics computes scoped exact financial cohort totals from real trusted confirmations, separates currencies/modes and explicit conversion, with matching bounded drilldown',async t=>{
 const {db,branch,campaigns,leads,users,api,overview}=await fixture(t);
 assert.equal((await overview()).leads.total,'4');assert.equal((await overview('', 'admin')).leads.total,'5');assert.equal((await overview('', 'foreign')).leads.total,'1');
 assert.equal((await overview('', 'other')).leads.total,'1');assert.equal((await overview('', 'agent')).leads.total,'2');assert.equal((await overview('', 'second')).leads.total,'1');
 assert.equal((await api('GET','/api/analytics/overview?branchId='+branch,undefined,'other')).statusCode,403);
 assert.equal((await overview('campaignId='+campaigns[1])).conversion.rate,null);
 const account=await api('POST','/api/payments/bank-accounts',{name:'Synthetic analytics bank',branchId:branch,mode:'TEST',beneficiary:'Synthetic company',accountIdentifier:'SYNTHETIC-ANALYTICS',bankName:'Synthetic bank',instructions:'Synthetic only',currencies:['EUR','JPY'],active:true,reason:'Synthetic independently verified setup'});
 assert.equal(account.statusCode,201,account.body);
 const method=await api('POST','/api/payments/methods',{name:'Synthetic transfer',branchId:branch,connectionId:account.json().id,currencies:['EUR','JPY'],active:true,agents:{mode:'ALL',ids:[]},campaigns:{mode:'ALL',ids:[]},reason:'Synthetic payment method'});
 assert.equal(method.statusCode,201,method.body);
 const confirm=async(lead:string,amount:string,currency:string)=>{
  const made=await api('POST','/api/leads/'+lead+'/bank-transfers',{requestId:randomUUID(),methodId:method.json().id,methodVersion:1,amount,currency},'agent');assert.equal(made.statusCode,201,made.body);const r=made.json();
  // A saved request/customer claim cannot change financial facts.
  assert.equal((await api('POST','/api/leads/'+lead+'/bank-transfers',{requestId:randomUUID(),methodId:method.json().id,methodVersion:1,amount,currency,paid:true},'agent')).statusCode,400);
  const proof={transactionId:'ANALYTICS-'+randomUUID(),accountIdentifier:'SYNTHETIC-ANALYTICS',reference:r.reference,amount,currency,settledAt:new Date(Date.now()-60000).toISOString(),reason:'Synthetic settled bank record reviewed',bankVerified:true};
  const confirmations=await Promise.all(Array.from({length:4},()=>api('POST','/api/leads/'+lead+'/bank-transfers/'+r.id+'/confirm',proof)));assert.ok(confirmations.every(x=>x.statusCode===200),confirmations.map(x=>x.body).join('\n'));
 };
 await confirm(leads[0]!,'90071992547409.91','EUR');await confirm(leads[0]!,'90071992547409.91','EUR');await confirm(leads[0]!,'0.10','EUR');await confirm(leads[0]!,'0.20','EUR');await confirm(leads[2]!,'300','JPY');
 const live=await overview();assert.equal(live.leads.paid,'0');assert.deepEqual(live.revenue,[]);assert.equal(live.paymentMode,'LIVE');
 const r=await overview('paymentMode=TEST');assert.equal(r.basis,'CURRENT_LEAD_CREATED_COHORT');assert.equal(r.leads.paid,'2');assert.equal(r.leads.enrolled,'2');assert.equal(r.enrollment_records,'5');
 assert.deepEqual(r.revenue,[{mode:'TEST',currency:'EUR',amount:'180143985094820.12',payments:'4'},{mode:'TEST',currency:'JPY',amount:'300',payments:'1'}]);
 assert.deepEqual(r.conversion,{configuredLeads:'3',converted:'2',unconfiguredLeads:'1',rate:'66.67'});assert.equal(r.revenue.some((x:any)=>'exchangeRate'in x),false);
 const noDef=await overview('campaignId='+campaigns[1]+'&paymentMode=ALL');assert.equal(noDef.conversion.rate,null);
 const filtered=await overview('paymentMode=TEST&from=2020-01-01T00%3A00%3A00.000100Z&to=2020-01-01T00%3A00%3A00.000100Z');assert.equal(filtered.leads.total,'1');assert.equal(filtered.leads.paid,'1');
 const groups=(await api('GET','/api/analytics/groups?paymentMode=TEST&by=CAMPAIGN')).json().items;
 assert.equal(groups.find((g:any)=>g.id===campaigns[0]).definition,'PAYMENT_CONFIRMED');assert.equal(groups.find((g:any)=>g.id===campaigns[0]).rate,'50.00');
 assert.equal(groups.find((g:any)=>g.id===campaigns[1]).definition,null);assert.equal(groups.find((g:any)=>g.id===campaigns[1]).rate,null);
 const ids:string[]=[];let cursor:string|null=null;
 do{const page:{items:{id:string}[];nextCursor:string|null}=(await api('GET','/api/analytics/leads?paymentMode=TEST&metric=ALL&limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''))).json();assert.equal(page.items.length,1);ids.push(page.items[0]!.id);cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(ids,[leads[3],leads[2],leads[1],leads[0]]);assert.equal(new Set(ids).size,4);
 const paid=(await api('GET','/api/analytics/leads?paymentMode=TEST&metric=PAID')).json().items.map((x:any)=>x.id).sort();
 assert.deepEqual(paid,[leads[0],leads[2]].sort());
 const list=(await api('GET','/api/leads?paymentMode=TEST&payment=CONFIRMED')).json().items.map((x:any)=>x.id).sort();assert.deepEqual(list,paid);
 const view=await api('POST','/api/lead-views',{name:'Confirmed scoped financial cohort',scope:'PERSONAL',filters:{paymentMode:'TEST',payment:'CONFIRMED',enrollment:'ENROLLED'},columns:['contact','campaign']});assert.equal(view.statusCode,201,view.body);
 assert.equal((await overview('sourceKind=META')).leads.total,'1');assert.equal((await overview('attention=YES')).leads.total,'1');
 assert.equal((await api('GET','/api/analytics/overview?from=2021-01-01T00:00:00Z&to=2020-01-01T00:00:00Z')).statusCode,400);
 assert.equal((await api('GET','/api/analytics/leads?metric=RAW_SQL')).statusCode,400);assert.equal((await api('GET','/api/analytics/overview?formula=SELECT')).statusCode,400);
 assert.equal((await db`SELECT lifecycle FROM lead WHERE id=${leads[0]!}`)[0]!.lifecycle,'OPEN');
 await api('POST','/api/leads/'+leads[0]+'/assignment',{version:1,agentId:users.second!.id,reason:'Actual current owner changes analytics access'});
 assert.equal((await overview('paymentMode=TEST','agent')).leads.total,'1');
 assert.equal((await api('GET','/api/analytics/leads?q='+leads[0],undefined,'agent')).json().items.length,0);
 assert.equal((await overview('q='+leads[0]+'&paymentMode=TEST','second')).leads.paid,'1');
});

test('Analytics separates historical Human contacts from actual author performance, applies current field permissions, and preserves precise cohort and conversation filters',async t=>{
 const {db,org,branch,campaigns,leads,users,api,overview}=await fixture(t);
 const conn=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status) VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic','CONNECTED') RETURNING id`)[0]!.id,
  sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,capabilities) VALUES(${org},${conn},'analytics-history','Synthetic','HEALTHY','{"text":true}') RETURNING id`)[0]!.id,
  cv=(await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state) VALUES(${leads[0]!},${conn},${sender},'WHATSAPP','synthetic','HUMAN',${users.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
 // Isolated immutable historical messages; author attribution intentionally differs from current ownership.
 await db`INSERT INTO conversation_message(conversation_id,connection_id,sender_id,direction,author_type,author_user_id,body,delivery_state,sent_at,received_at) VALUES
  (${cv},${conn},${sender},'INBOUND','CUSTOMER',NULL,'Synthetic initial','RECEIVED',NULL,'2020-01-01T01:00:00Z'),
  (${cv},${conn},${sender},'OUTBOUND','HUMAN',${users.agent!.id},'Synthetic first Human','SENT','2020-01-01T01:00:10Z',NULL),
  (${cv},${conn},${sender},'OUTBOUND','HUMAN',${users.second!.id},'Synthetic other historical Human','SENT','2020-01-01T01:00:20Z',NULL),
  (${cv},${conn},${sender},'INBOUND','CUSTOMER',NULL,'Synthetic response','RECEIVED',NULL,'2020-01-01T01:00:30Z')`;
 const all=await overview();assert.equal(all.communication.humanAttempts,'2');assert.equal(all.communication.humanResponseSeconds,'10.000');assert.equal(all.communication.aiAttempts,'0');assert.equal(all.communication.aiResponseSeconds,null);assert.equal(all.communication.customerResponded,'1');
 const self=await overview('', 'agent');assert.equal(self.communication.humanAttempts,'1');assert.equal(self.communication.humanResponseSeconds,'10.000');
 assert.equal((await api('GET','/api/analytics/agents',undefined,'agent')).json().items.length,1);
 const authors=(await api('GET','/api/analytics/agents')).json().items;assert.equal(authors.length,2);assert.equal(authors.find((x:any)=>x.id===users.second!.id).response_seconds,'20.000');
 assert.equal((await overview('conversationState=HUMAN_ACTIVE&controller=HUMAN')).leads.total,'1');assert.equal((await overview('conversationState=HUMAN_ACTIVE&controller=AI')).leads.total,'0');
 assert.equal((await api('GET','/api/leads?conversationState=HUMAN_ACTIVE&controller=HUMAN')).json().items[0].id,leads[0]);
 const follow=await api('POST','/api/leads/'+leads[0]+'/followups',{dueAt:'2020-01-01T01:00:00Z',note:'Synthetic overdue'},'agent');assert.equal(follow.statusCode,201,follow.body);
 assert.equal((await overview('followup=OVERDUE')).leads.total,'1');assert.equal((await overview()).follow_ups.overdue,'1');assert.equal((await overview()).follow_ups.human,'1');
 const fd=await api('POST','/api/fields',{scope:'CAMPAIGN',branchId:branch,campaignId:campaigns[0],key:'analytics_private',label:'Restricted analytics field',fieldType:'TEXT',valueMode:'MANUAL',options:[],validation:{}});assert.equal(fd.statusCode,201,fd.body);const fid=fd.json().id;
 const binding={active:true,position:1,requiredStage:'NONE',visibleToAgent:false,editableByAgent:false,visibleToManager:true,editableByManager:true,showInTable:true,showInDetails:true,filterable:true,usableByAutomation:false,usableByAi:false};
 const bind=await api('PUT','/api/campaigns/'+campaigns[0]+'/fields/'+fid,binding);assert.equal(bind.statusCode,200,bind.body);
 const value=await api('PUT','/api/leads/'+leads[0]+'/fields/'+fid,{value:'north'});assert.equal(value.statusCode,200,value.body);
 const query='campaignId='+campaigns[0]+'&fieldId='+fid+'&fieldValue='+encodeURIComponent('"north"');assert.equal((await overview(query)).leads.total,'1');
 for(const path of ['/api/analytics/overview?','/api/analytics/leads?','/api/analytics/groups?','/api/analytics/agents?','/api/leads?'])assert.equal((await api('GET',path+query,undefined,'agent')).statusCode,404);
 assert.equal((await api('GET','/api/analytics/overview?campaignId='+campaigns[0]+'&fieldId='+fid+'&fieldValue=null')).statusCode,400);
 const changed=await api('PUT','/api/campaigns/'+campaigns[0]+'/fields/'+fid,{...binding,version:1,visibleToManager:false,editableByManager:false});assert.equal(changed.statusCode,200,changed.body);
 assert.equal((await api('GET','/api/analytics/overview?'+query)).statusCode,404);
 await api('POST','/api/leads/'+leads[0]+'/assignment',{version:1,agentId:users.second!.id,reason:'Current owner is not necessarily historical author'});
 const after=await overview('', 'second');assert.equal(after.communication.humanContacted,'1');assert.equal(after.communication.humanAttempts,'1');assert.equal(after.communication.humanResponseSeconds,'20.000');
 const drill=(await api('GET','/api/analytics/leads?metric=HUMAN_CONTACTED',undefined,'second')).json().items[0];assert.equal(drill.first_human,'2020-01-01T01:00:10.000Z');assert.equal(drill.first_customer_response,'2020-01-01T01:00:30.000Z');
 const reopened=await api('PUT','/api/campaigns/'+campaigns[0]+'/fields/'+fid,{...binding,version:2,visibleToAgent:true,editableByAgent:true,visibleToManager:false,editableByManager:false});assert.equal(reopened.statusCode,200,reopened.body);
 // A generally Agent-visible field is still inaccessible through another Agent's Campaign/Lead.
 assert.equal((await overview(query,'agent')).leads.total,'0');
 const empty=await api('GET','/api/leads?'+query,undefined,'agent');assert.equal(empty.statusCode,200,empty.body);assert.deepEqual(empty.json().items,[]);
 const noMetadata='campaignId='+campaigns[0]+'&fieldId='+randomUUID()+'&fieldValue=not-json';
 assert.equal((await overview(noMetadata,'agent')).leads.total,'0');
 const opaque=await api('GET','/api/leads?'+noMetadata,undefined,'agent');assert.equal(opaque.statusCode,200,opaque.body);assert.deepEqual(opaque.json().items,[]);
 assert.equal((await overview(query,'second')).leads.total,'1');
});

test('Analytics fails closed on revoked sessions and Audit failure, rejects unsupported requests, and never leaks a previously authorized report',async t=>{
 const {db,users,api,overview}=await fixture(t);assert.equal((await overview()).leads.total,'4');
 await db`CREATE FUNCTION reject_analytics_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ANALYTICS_READ' THEN RAISE EXCEPTION 'SyntheticPrivateAnalyticsFailure';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_analytics_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_analytics_fixture()`;
 try{for(const path of ['overview','leads','groups','agents']){const denied=await api('GET','/api/analytics/'+path);assert.equal(denied.statusCode,500);assert.ok(!denied.body.includes('Analytics contact'));assert.ok(!denied.body.includes('SyntheticPrivateAnalyticsFailure'));}}
 finally{await db`DROP TRIGGER reject_analytics_fixture ON audit_log`;await db`DROP FUNCTION reject_analytics_fixture()`;}
 let unlock!:()=>void,ready!:()=>void;const release=new Promise<void>(r=>unlock=r),started=new Promise<void>(r=>ready=r);
 const block=db.begin(async tx=>{await tx`SELECT id FROM user_session WHERE id=${users.manager!.session} FOR UPDATE`;ready();await release;await tx`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;});
 await started;const pending=api('GET','/api/analytics/overview');await new Promise(resolve=>setTimeout(resolve,75));unlock();await block;const denied=await pending;assert.ok([401,403].includes(denied.statusCode),denied.body);assert.ok(!denied.body.includes('total'));
 for(const path of ['overview','leads','groups','agents'])assert.equal((await api('GET','/api/analytics/'+path)).statusCode,401);
 assert.equal((await api('GET','/api/analytics/groups?limit=51',undefined,'agent')).statusCode,400);
 assert.equal((await api('GET','/api/analytics/groups?by=provider_secret',undefined,'agent')).statusCode,400);
});

test('Analytics aggregates a larger cohort on the server while lead and grouping responses remain bounded',async t=>{
 const {db,org,branch,campaigns,api,overview}=await fixture(t);
 await db`INSERT INTO lead(organization_id,branch_id,campaign_id,source_kind)
  SELECT ${org},${branch},${campaigns[0]!},'GENERIC_SOURCE' FROM generate_series(1,5000)`;
 await db`ANALYZE lead`;
 const r=await overview('sourceKind=GENERIC_SOURCE');assert.equal(r.leads.total,'5000');assert.equal(r.leads.unassigned,'5000');
 const page=await api('GET','/api/analytics/leads?sourceKind=GENERIC_SOURCE&limit=50');assert.equal(page.statusCode,200,page.body);
 assert.equal(page.json().items.length,50);assert.ok(page.json().nextCursor);assert.ok(Buffer.byteLength(page.body)<60000);
 const next=await api('GET','/api/analytics/leads?sourceKind=GENERIC_SOURCE&limit=50&cursor='+encodeURIComponent(page.json().nextCursor));assert.equal(next.statusCode,200,next.body);
 assert.ok(next.json().items.every((l:any)=>!page.json().items.some((p:any)=>p.id===l.id)));
 assert.equal((await overview('sourceKind=GENERIC_SOURCE','agent')).leads.total,'0');
 const groups=await api('GET','/api/analytics/groups?sourceKind=GENERIC_SOURCE&limit=1');assert.equal(groups.statusCode,200,groups.body);assert.equal(groups.json().items.length,1);assert.equal(groups.json().items[0].leads,'5000');
});
