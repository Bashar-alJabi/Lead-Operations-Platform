import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDatabase} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {sha256} from '../src/security.js';
import {processOneAutomationMatch,processOneAutomationExecution} from '../src/automation.js';
import {processOneFollowUpNotification} from '../src/follow-up-notifications.js';
import {processOneInboundEvent} from '../src/messaging/inbound-events.js';
import {sealSecret} from '../src/credentials.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
async function fixture(t:TestContext){
 process.env.APP_ORIGIN='http://127.0.0.1:5173';const db=createDatabase(url),app=await buildApp(db,{logger:false,globalRateLimitMax:10000});
 t.after(async()=>{await app.close();await db.end();});
 await db.begin(async tx=>{await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`;});
 const org=(await db`INSERT INTO organization(name) VALUES('Automation test') RETURNING id`)[0]!.id,
  foreign=(await db`INSERT INTO organization(name) VALUES('Other organization') RETURNING id`)[0]!.id,
  branch=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Automation branch') RETURNING id`)[0]!.id,
  other=(await db`INSERT INTO branch(organization_id,name) VALUES(${org},'Other branch') RETURNING id`)[0]!.id,
  campaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status,routing_method) VALUES(${org},${branch},'Automation campaign','ACTIVE','ROUND_ROBIN') RETURNING id`)[0]!.id;
 const users:Record<string,{id:string;session:string;cookie:string}>={};
 for(const [name,role,bid,oid] of [['admin','SUPER_ADMIN',null,org],['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['second','AGENT',branch,org],['other','MANAGER',other,org],['foreign','SUPER_ADMIN',null,foreign]] as const){
  const id=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${oid},${bid},${role},${name},${name+'@automation.test'},'synthetic') RETURNING id`)[0]!.id,
   token=randomBytes(32).toString('hex'),session=(await db`INSERT INTO user_session(user_id,token_hash,expires_at) VALUES(${id},${sha256(token)},now()+interval '1 hour') RETURNING id`)[0]!.id;
  users[name]={id,session,cookie:'lop_session='+token};
 }
 await db`INSERT INTO campaign_agent(campaign_id,agent_id) VALUES(${campaign},${users.agent!.id})`;
 const api=(method:'GET'|'POST'|'PUT'|'PATCH',path:string,body?:object,who='manager')=>app.inject({method,url:path,payload:body,headers:{cookie:users[who]!.cookie,origin:process.env.APP_ORIGIN!}});
 let count=0;const create=async()=>{const r=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Automation contact',phone:'+1555400'+String(++count).padStart(4,'0')}});assert.equal(r.statusCode,201,r.body);return r.json().id as string;};
 const def={name:'Approved task <img src=x onerror=alert(1)>',enabled:true,triggerType:'LEAD_CREATED',lifecycle:'OPEN',ownerCondition:'ASSIGNED',actionType:'CREATE_FOLLOW_UP',delayMinutes:60,priority:'HIGH',note:'Synthetic internal task',reason:'Approve synthetic rule'};
 const rule=async(input:object={},who='manager')=>{const r=await api('POST','/api/automations',{...def,branchId:branch,campaignId:campaign,...input},who);assert.equal(r.statusCode,201,r.body);return r.json().id as string;};
 async function matches(){for(let i=0;i<200&&await processOneAutomationMatch(db);i++);}
 async function execute(){for(let i=0;i<200&&await processOneAutomationExecution(db);i++);}
 return {db,app,org,branch,other,campaign,users,api,def,rule,create,matches,execute};
}

test('Approved assignment shares ownership effects, enforces eligibility and limits repeated reassignment',async t=>{
 const {db,org,branch,other,campaign,users,api,def,rule,create,matches,execute}=await fixture(t);
 const first=users.agent!.id,second=users.second!.id;
 const options={actionType:'ASSIGN_LEAD',delayMinutes:0,priority:'NORMAL',note:''};
 const foreign=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
  VALUES(${org},${other},'AGENT','Other branch agent','assignment-other@automation.test','synthetic') RETURNING id`)[0]!.id;
 const approve={...def,branchId:branch,campaignId:campaign,...options};
 assert.equal((await api('POST','/api/automations',{...approve,actionAgentId:foreign})).statusCode,409);
 assert.equal((await api('POST','/api/automations',{...approve,actionAgentId:second},'agent')).statusCode,403);
 const origin=await rule({...options,actionAgentId:second,ownerCondition:'ANY'});
 const rebound=await rule({...options,triggerType:'LEAD_REASSIGNED',actionAgentId:first});
 const leadId=await create();
 const task=await api('POST','/api/leads/'+leadId+'/followups',{dueAt:new Date(Date.now()+3600_000).toISOString()});
 assert.equal(task.statusCode,201,task.body);
 const conn=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name)
  VALUES(${org},${branch},'MESSAGING','FAKE','Assignment fixture') RETURNING id`)[0]!.id;
 const sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name)
  VALUES(${org},${conn},'assignment-fixture','Assignment fixture') RETURNING id`)[0]!.id;
 const human=(await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
  VALUES(${leadId},${conn},${sender},'TEST','Synthetic human','HUMAN',${first},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
 const ai=(await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state)
  VALUES(${leadId},${conn},${sender},'WHATSAPP','Synthetic AI','AI','AI_ACTIVE') RETURNING id`)[0]!.id;
 const addToCampaign=(capacityOverride:number|null)=>api('PUT','/api/campaigns/'+campaign+'/agents',{agentId:second,capacityOverride});
 assert.equal((await addToCampaign(null)).statusCode,200);
 await matches();await execute();
 const owner=async(id:string)=>(await db`SELECT assigned_agent_id FROM lead WHERE id=${id}`)[0]!.assigned_agent_id;
 assert.equal(await owner(leadId),second);
 assert.equal((await db`SELECT owner_user_id FROM follow_up WHERE id=${task.json().id}`)[0]!.owner_user_id,second);
 assert.equal((await db`SELECT controller_user_id FROM conversation WHERE id=${human}`)[0]!.controller_user_id,second);
 assert.equal((await db`SELECT controller_type FROM conversation WHERE id=${ai}`)[0]!.controller_type,'AI');
 assert.equal((await api('GET','/api/leads/'+leadId,undefined,'agent')).statusCode,404);
 assert.equal((await api('GET','/api/leads/'+leadId+'/assignments',undefined,'second')).json().items[0].method,'AUTOMATION');
 const effects=()=>db`SELECT id,automation_execution_id,actor_user_id,new_agent_id FROM assignment_history
  WHERE lead_id=${leadId} AND method='AUTOMATION' ORDER BY id`;
 await matches();await execute();await matches();await execute();
 assert.equal(await owner(leadId),first);
 const history=await effects();
 assert.deepEqual(history.map(row=>row.new_agent_id),[second,first]);
 assert.ok(history.every(row=>row.actor_user_id===null));
 const [repeat]=await db`SELECT e.result_code,s.causal_rule_ids,s.parent_execution_id FROM automation_execution e
  JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${leadId} AND e.rule_id=${rebound} AND e.state='SKIPPED'`;
 assert.equal(repeat!.result_code,'AUTOMATION_CAUSAL_REPEAT');
 assert.deepEqual(repeat!.causal_rule_ids,[origin,rebound]);
 assert.equal(repeat!.parent_execution_id,history[1]!.automation_execution_id);
 await assert.rejects(db`UPDATE assignment_history SET reason='Changed' WHERE id=${history[0]!.id}`,/IMMUTABLE/);
 await assert.rejects(db`SELECT apply_scoped_lead_assignment(${leadId},3,${second},NULL,NULL,'Replay',
  ${history[0]!.automation_execution_id})`,/AUTOMATION_ASSIGNMENT_EFFECT_REQUIRED/);
 assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE target_id=${leadId} AND action='LEAD_REASSIGNED'`)[0]!.n,2);

 await db`UPDATE campaign SET routing_method='MANUAL' WHERE id=${campaign}`;
 const outcome=async(id:string)=>(await db`SELECT e.result_code FROM automation_execution e
  JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${id} AND e.rule_id=${origin}`)[0]!.result_code;
 assert.equal((await addToCampaign(0)).statusCode,200);
 const full=await create();await matches();await execute();
 assert.equal(await owner(full),null);assert.equal(await outcome(full),'AUTOMATION_ASSIGNMENT_AGENT_UNAVAILABLE');
 assert.equal((await addToCampaign(1)).statusCode,200);
 const hours='/api/users/'+second+'/working-hours';
 assert.equal((await api('PUT',hours,{version:0,hours:{mon:[]},reason:'Close synthetic working hours'})).statusCode,200);
 const unavailable=await create();await matches();await execute();
 assert.equal(await owner(unavailable),null);assert.equal(await outcome(unavailable),'AUTOMATION_ASSIGNMENT_AGENT_UNAVAILABLE');
 assert.equal((await api('PUT',hours,{version:1,hours:{},reason:'Reopen synthetic working hours'})).statusCode,200);
 const contenders=[await create(),await create()];await matches();
 await Promise.all([execute(),execute()]);
 assert.deepEqual((await Promise.all(contenders.map(outcome))).sort(),['APPLIED','AUTOMATION_ASSIGNMENT_AGENT_UNAVAILABLE']);
 assert.equal((await Promise.all(contenders.map(owner))).filter(id=>id===second).length,1);
});

test('Adding tags merges current values under competing workers, skips duplicates and respects the field limit',async t=>{
 const {db,branch,campaign,api,def,rule,create,matches,execute}=await fixture(t);
 const bind={active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:true,visibleToManager:true,
  editableByManager:true,showInTable:false,showInDetails:true,filterable:false,usableByAutomation:true,usableByAi:false};
 async function defineField(fieldType:'TAGS'|'NUMBER',key:string){
  const added=await api('POST','/api/fields',{scope:'CAMPAIGN',branchId:branch,campaignId:campaign,key,label:key,
   fieldType,valueMode:'MANUAL',options:[],validation:{}});
  assert.equal(added.statusCode,201,added.body);
  const id=added.json().id as string;
  assert.equal((await api('PUT','/api/campaigns/'+campaign+'/fields/'+id,bind)).statusCode,200);
  return id;
 }
 const tags=await defineField('TAGS','automated_tags'),number=await defineField('NUMBER','ordinary_automation_field');
 const available=await api('GET','/api/automations/trigger-fields?usage=TAGS&branchId='+branch+'&campaignId='+campaign);
 assert.deepEqual(available.json().items.map((item:{id:string})=>item.id),[tags]);
 const action={actionType:'SET_FIELD_VALUE',delayMinutes:0,priority:'NORMAL',note:''};
 const approval={...def,branchId:branch,campaignId:campaign,...action};
 const fieldAction=(value:unknown,fieldId=tags)=>({fieldId,value,operation:'ADD_TAGS'});
 assert.equal((await api('POST','/api/automations',{...approval,fieldAction:fieldAction(12,number)})).statusCode,409);
 assert.equal((await api('POST','/api/automations',{...approval,fieldAction:fieldAction([])})).statusCode,400);
 const priority=await rule({...action,name:'Add the priority tag',fieldAction:fieldAction(['priority','keep'])});
 await rule({...action,name:'Add the contact tag',fieldAction:fieldAction(['contacted','keep'])});
 const history=(await api('GET','/api/automations/'+priority+'/history')).json().items;
 assert.equal(history[0].definition.action_field_operation,'ADD_TAGS');

 async function intakeWithTags(value:string[]){
  const id=await create();
  const set=await api('PUT','/api/leads/'+id+'/fields/'+tags,{value});
  assert.equal(set.statusCode,200,set.body);
  await matches();
  return id;
 }
 const leadId=await intakeWithTags(['keep','original']);
 await Promise.all([execute(),execute()]);
 const [latest]=await db`SELECT value,version FROM lead_field_value WHERE lead_id=${leadId} AND field_id=${tags}`;
 assert.deepEqual(latest!.value.slice(0,2),['keep','original']);
 assert.deepEqual(new Set(latest!.value),new Set(['keep','original','priority','contacted']));
 assert.equal(latest!.value.length,4);assert.equal(latest!.version,3);
 const changes=await db`SELECT operation,previous_version FROM automation_field_effect WHERE lead_id=${leadId} ORDER BY previous_version`;
 assert.deepEqual(changes.map(row=>[row.operation,row.previous_version]),[['ADD_TAGS',1],['ADD_TAGS',2]]);

 const full=Array.from({length:50},(_,index)=>'existing-'+index);
 for(const [value,reason] of [[full,'AUTOMATION_TAG_LIMIT_REACHED'],[['keep','priority','contacted'],'FIELD_ALREADY_MATCHES']] as const){
  const id=await intakeWithTags([...value]);await execute();
  const [unchanged]=await db`SELECT value,version FROM lead_field_value WHERE lead_id=${id} AND field_id=${tags}`;
  assert.deepEqual(unchanged!.value,value);assert.equal(unchanged!.version,1);
  const results=await db`SELECT e.state,e.result_code FROM automation_execution e
   JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${id}`;
  assert.deepEqual(results.map(row=>[row.state,row.result_code]),[['SKIPPED',reason],['SKIPPED',reason]]);
  assert.equal((await db`SELECT 1 FROM automation_field_effect WHERE lead_id=${id}`).length,0);
 }
});

test('Scoped automation writes typed fields atomically and propagates the source chain to stop repeated rules',async t=>{
 const {db,branch,campaign,api,def,rule,create,matches,execute}=await fixture(t);
 const settings={active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:true,visibleToManager:true,
  editableByManager:true,showInTable:false,showInDetails:true,filterable:false,usableByAutomation:true,usableByAi:false};
 async function createField(key:string,type:string,editable=true){
  const response=await api('POST','/api/fields',{scope:'CAMPAIGN',branchId:branch,campaignId:campaign,key,label:key,
   fieldType:type,valueMode:'MANUAL',options:[],validation:{}});
  assert.equal(response.statusCode,201,response.body);
  const id=response.json().id as string,path='/api/campaigns/'+campaign+'/fields/'+id;
  assert.equal((await api('PUT',path,{...settings,editableByManager:editable})).statusCode,200);
  return {id,path};
 }
 const a=await createField('field_action_score','NUMBER'),b=await createField('field_action_review','BOOLEAN');
 const readOnly=await createField('field_action_read_only','NUMBER',false);
 const targetPath='/api/automations/trigger-fields?usage=ACTION&branchId='+branch+'&campaignId='+campaign;
 assert.deepEqual(new Set((await api('GET',targetPath)).json().items.map((item:{id:string})=>item.id)),new Set([a.id,b.id]));
 assert.equal((await api('GET',targetPath,undefined,'other')).statusCode,404);
 assert.equal((await api('GET',targetPath,undefined,'agent')).statusCode,403);
 const action={actionType:'SET_FIELD_VALUE',delayMinutes:0,priority:'NORMAL',note:''};
 const base={...def,branchId:branch,campaignId:campaign,...action};
 const denied=await api('POST','/api/automations',{...base,fieldAction:{fieldId:readOnly.id,value:42}});
 assert.equal(denied.statusCode,409);assert.match(denied.body,/AUTOMATION_ACTION_FIELD_UNAVAILABLE/);
 assert.equal((await api('POST','/api/automations',{...base,fieldAction:{fieldId:a.id,value:'42'}})).statusCode,400);
 const origin=await rule({...action,name:'Set score when created',fieldAction:{fieldId:a.id,value:11}});
 const agentReview=await rule({...action,name:'Set review when score changes',triggerType:'FIELD_CHANGED',
  triggerFieldId:a.id,fieldAction:{fieldId:b.id,value:false}});
 const secondScore=await rule({...action,name:'Change score when review changes',triggerType:'FIELD_CHANGED',
  triggerFieldId:b.id,fieldAction:{fieldId:a.id,value:12}});
 const leadId=await create();
 for(let i=0;i<4;i++){await matches();await execute();}
 const changed=await db`SELECT field_id,value,source,updated_by,version FROM lead_field_value WHERE lead_id=${leadId}`;
 assert.deepEqual(changed.find(row=>row.field_id===a.id),{field_id:a.id,value:12,source:'AUTOMATION',updated_by:null,version:2});
 assert.deepEqual(changed.find(row=>row.field_id===b.id),{field_id:b.id,value:false,source:'AUTOMATION',updated_by:null,version:1});
 const [repeat]=await db`SELECT x.result_code,s.causal_rule_ids,s.parent_execution_id FROM automation_execution x
  JOIN automation_source s ON s.id=x.source_id WHERE s.lead_id=${leadId} AND x.rule_id=${agentReview} AND x.state='SKIPPED'`;
 assert.equal(repeat!.result_code,'AUTOMATION_CAUSAL_REPEAT');
 assert.deepEqual(repeat!.causal_rule_ids,[origin,agentReview,secondScore]);
 const effects=await db`SELECT e.*,h.id AS history_id FROM automation_field_effect e
  JOIN field_value_history h ON h.automation_execution_id=e.execution_id WHERE e.lead_id=${leadId} ORDER BY h.id`;
 assert.deepEqual(effects.map(effect=>effect.value),[11,false,12]);
 assert.equal(repeat!.parent_execution_id,effects[2]!.execution_id);
 await assert.rejects(db`UPDATE automation_field_effect SET value='99' WHERE execution_id=${effects[0]!.execution_id}`,/IMMUTABLE/);
 await assert.rejects(db`UPDATE field_value_history SET new_value='99' WHERE id=${effects[0]!.history_id}`,/IMMUTABLE/);
 await assert.rejects(db`UPDATE lead_field_value SET value='99' WHERE lead_id=${leadId} AND field_id=${a.id}`,/CURRENT_EFFECT_REQUIRED/);
 assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='AUTOMATION_ACTION_APPLIED' AND detail->>'fieldId' IN (${a.id},${b.id})`)[0]!.n,3);

 const rollbackLead=await create();await matches();
 await db`CREATE FUNCTION test_field_action_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.action='AUTOMATION_ACTION_APPLIED' THEN RAISE EXCEPTION 'Synthetic field action Audit failure'; END IF; RETURN NEW; END $$`;
 await db`CREATE TRIGGER test_field_action_audit_failure BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION test_field_action_audit_failure()`;
 try{
  await execute();
  assert.equal((await db`SELECT 1 FROM lead_field_value WHERE lead_id=${rollbackLead}`).length,0);
  assert.equal((await db`SELECT 1 FROM field_value_history WHERE lead_id=${rollbackLead}`).length,0);
  assert.equal((await db`SELECT 1 FROM automation_field_effect WHERE lead_id=${rollbackLead}`).length,0);
  assert.equal((await db`SELECT 1 FROM automation_source WHERE lead_id=${rollbackLead} AND trigger_type='FIELD_CHANGED'`).length,0);
 }finally{
  await db`DROP TRIGGER test_field_action_audit_failure ON audit_log`;
  await db`DROP FUNCTION test_field_action_audit_failure()`;
 }
 const [failed]=await db`SELECT x.next_run_at,x.failure_count FROM automation_execution x
  JOIN automation_source s ON s.id=x.source_id WHERE s.lead_id=${rollbackLead} AND x.rule_id=${origin}`;
 assert.equal(failed!.failure_count,1);
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,+failed!.next_run_at-Date.now())+40));
 await execute();
 assert.equal((await db`SELECT 1 FROM automation_field_effect WHERE lead_id=${rollbackLead}`).length,1);
 for(let i=0;i<3;i++){await matches();await execute();}

 const newLead=await create();await matches();
 assert.equal((await api('PUT',a.path,{...settings,version:1,editableByManager:false})).statusCode,200);
 await execute();
 const [revoked]=await db`SELECT x.result_code FROM automation_execution x
  JOIN automation_source s ON s.id=x.source_id WHERE x.rule_id=${origin} AND s.lead_id=${newLead}`;
 assert.equal(revoked!.result_code,'AUTOMATION_ACTION_FIELD_UNAVAILABLE');
 assert.equal((await db`SELECT * FROM automation_field_effect WHERE lead_id=${newLead}`).length,0);
 const rules=(await api('GET','/api/automations')).json().items;
 assert.equal(rules.find((item:{id:string})=>item.id===origin).action_field_value,null);
 const revisions=(await api('GET','/api/automations/'+origin+'/history')).json().items;
 assert.equal(Object.hasOwn(revisions[0].definition,'action_field_value'),false);
 assert.equal((await api('PUT','/api/automations/'+origin,{...def,...action,enabled:false,version:1})).statusCode,200);

 const humanUpdate=await api('PUT','/api/leads/'+leadId+'/fields/'+b.id,{value:true,version:1});
 assert.equal(humanUpdate.statusCode,200,humanUpdate.body);
 const [manual]=await db`SELECT source,automation_execution_id FROM lead_field_value WHERE lead_id=${leadId} AND field_id=${b.id}`;
 assert.equal(manual!.source,'MANUAL');assert.equal(manual!.automation_execution_id,null);
 assert.equal((await db`SELECT source FROM field_value_history WHERE id=${effects[1]!.history_id}`)[0]!.source,'AUTOMATION');
});

test('Automation checks a scoped current assignee and the selected UTC date basis after matching',async t=>{
 const {db,org,branch,other,campaign,users,api,def,rule,create,matches,execute}=await fixture(t);
 const outside=(await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
  VALUES(${org},${other},'AGENT','Other branch agent','outside@automation.test','synthetic') RETURNING id`)[0]!.id;
 const picker='/api/automations/condition-agents';
 const options=(await api('GET',picker+'?branchId='+branch)).json().items;
 assert.deepEqual(new Set(options.map((item:{id:string})=>item.id)),new Set([users.agent!.id,users.second!.id]));
 assert.equal((await api('GET',picker+'?branchId='+branch,undefined,'other')).statusCode,404);
 assert.equal((await api('GET',picker+'?branchId='+branch,undefined,'agent')).statusCode,403);
 assert.deepEqual((await api('GET',picker+'?branchId='+branch,undefined,'foreign')).statusCode,404);
 const full={...def,branchId:branch,campaignId:campaign};
 assert.equal((await api('POST','/api/automations',{...full,conditionAgentId:outside})).statusCode,409);
 assert.equal((await api('POST','/api/automations',{...full,conditionAgentId:users.agent!.id,ownerCondition:'UNASSIGNED'})).statusCode,400);
 for(const dateCondition of [{basis:'LEAD_CREATED'},{basis:'LEAD_CREATED',from:'2031-02-29'},
  {basis:'EVENT_CAPTURED',from:'2025-04-02',through:'2025-04-01'}]){
  assert.equal((await api('POST','/api/automations',{...full,dateCondition})).statusCode,400);
 }

 const [days]=await db`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS today,
  ((clock_timestamp() AT TIME ZONE 'UTC')::date+1)::text AS tomorrow`;
 const eventDay={basis:'EVENT_CAPTURED',from:days!.today,through:days!.tomorrow};
 const agentRule=await rule({name:'Current agent and captured date',conditionAgentId:users.agent!.id,dateCondition:eventDay});
 const historical='2001-09-12';
 const createdRule=await rule({name:'Historical lead date',dateCondition:{basis:'LEAD_CREATED',from:historical,through:historical}});
 const noMatch=await rule({name:'No historical event',dateCondition:{basis:'EVENT_CAPTURED',through:historical}});
 const deniedAgent=await rule({name:'Other permitted owner',conditionAgentId:users.second!.id});
 const result=(leadId:string,ruleId:string)=>db`SELECT e.result_code FROM automation_execution e
   JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${leadId} AND e.rule_id=${ruleId}`;
 const current=await create(),reassigned=await create();
 await db`UPDATE lead SET created_at='2001-09-12 23:59:59.999999+00' WHERE id=${current}`;
 await db`UPDATE lead SET created_at='2001-09-13 00:00:00+00' WHERE id=${reassigned}`;
 await matches();
 assert.equal((await api('POST','/api/leads/'+reassigned+'/assignment',{version:1,agentId:users.second!.id})).statusCode,200);
 await execute();
 assert.equal((await result(current,agentRule))[0]!.result_code,'APPLIED');
 assert.equal((await result(reassigned,agentRule))[0]!.result_code,'CONDITIONS_NOT_MET');
 assert.equal((await result(current,createdRule))[0]!.result_code,'APPLIED');
 assert.equal((await result(reassigned,createdRule))[0]!.result_code,'CONDITIONS_NOT_MET');
 assert.equal((await result(current,noMatch))[0]!.result_code,'CONDITIONS_NOT_MET');
 assert.equal((await result(reassigned,deniedAgent))[0]!.result_code,'APPLIED');

 const retain=await api('PUT','/api/automations/'+agentRule,{...def,version:1});
 assert.equal(retain.statusCode,200,retain.body);
 const history=(await api('GET','/api/automations/'+agentRule+'/history')).json().items;
 assert.deepEqual(history.map((item:{definition:{condition_agent_id:string;condition_date_from:string}})=>
  [item.definition.condition_agent_id,item.definition.condition_date_from]),
 [[users.agent!.id,days!.today],[users.agent!.id,days!.today]]);
 const disabled=await create();await matches();
 await db`UPDATE user_account SET active=false WHERE id=${users.agent!.id}`;
 await execute();
 assert.equal((await result(disabled,agentRule))[0]!.result_code,'CONDITIONS_NOT_MET');
 const off=await api('PUT','/api/automations/'+agentRule,{...def,version:2,enabled:false});
 assert.equal(off.statusCode,200,off.body);
 assert.equal((await api('PUT','/api/automations/'+agentRule,{...def,version:3})).statusCode,409);
 assert.equal((await api('PUT','/api/automations/'+agentRule,{...def,version:3,conditionAgentId:null,dateCondition:null})).statusCode,200);
 const cleared=(await db`SELECT condition_agent_id,condition_date_basis FROM automation_rule WHERE id=${agentRule}`)[0]!;
 assert.equal(cleared.condition_agent_id,null);assert.equal(cleared.condition_date_basis,null);
});

test('Field equality uses typed current values, withholds the criterion after revocation and skips pending work',async t=>{
 const {db,branch,campaign,api,def,rule,create,matches,execute}=await fixture(t);
 const made=await api('POST','/api/fields',{scope:'CAMPAIGN',branchId:branch,campaignId:campaign,key:'automation_score',
  label:'Synthetic automation score',fieldType:'NUMBER',valueMode:'MANUAL',options:[],validation:{}});
 assert.equal(made.statusCode,201,made.body);
 const fieldId=made.json().id as string,binding='/api/campaigns/'+campaign+'/fields/'+fieldId;
 const settings={active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:true,visibleToManager:true,
  editableByManager:true,showInTable:false,showInDetails:true,filterable:false,usableByAutomation:true,usableByAi:false};
 assert.equal((await api('PUT',binding,settings)).statusCode,200);
 const details='/api/automations/trigger-fields/'+fieldId+'?branchId='+branch+'&campaignId='+campaign;
 assert.equal((await api('GET',details)).json().field_type,'NUMBER');
 assert.equal((await api('GET',details,undefined,'other')).statusCode,404);
 assert.equal((await api('GET',details,undefined,'agent')).statusCode,403);
 const wrongType=await api('POST','/api/automations',{...def,branchId:branch,campaignId:campaign,fieldCondition:{fieldId,value:'0'}});
 assert.equal(wrongType.statusCode,400);
 const id=await rule({fieldCondition:{fieldId,value:0}}),root='/api/automations/'+id;
 const readRule=async()=>(await api('GET','/api/automations')).json().items.find((item:{id:string})=>item.id===id);
 assert.equal((await readRule()).condition_field_value,0);
 const versionHistory=await api('GET',root+'/history');
 assert.equal(Object.hasOwn(versionHistory.json().items[0].definition,'condition_field_value'),false);
 assert.equal(versionHistory.json().items[0].definition.condition_field_id,fieldId);
 const fieldValue=(lead:string,value:number,version?:number)=>api('PUT','/api/leads/'+lead+'/fields/'+fieldId,{value,version},'agent');
 const eligible=await create(),changed=await create(),absent=await create();
 for(const lead of [eligible,changed])assert.equal((await fieldValue(lead,0)).statusCode,200);
 await matches();
 assert.equal((await fieldValue(changed,5,1)).statusCode,200);
 await execute();
 const processing=async()=>db`SELECT s.lead_id,e.state,e.result_code FROM automation_execution e
  JOIN automation_source s ON s.id=e.source_id WHERE e.rule_id=${id}`;
 const first=await processing();
 assert.equal(first.find(row=>row.lead_id===eligible)?.state,'SUCCEEDED');
 for(const lead of [changed,absent])assert.equal(first.find(row=>row.lead_id===lead)?.result_code,'CONDITIONS_NOT_MET');
 const revoked=await create();
 assert.equal((await fieldValue(revoked,0)).statusCode,200);
 await matches();
 const hidden=await api('PUT',binding,{...settings,visibleToManager:false,editableByManager:false,version:1});
 assert.equal(hidden.statusCode,200,hidden.body);
 assert.equal((await api('GET',details)).statusCode,404);
 assert.equal((await readRule()).condition_field_value,null);
 await execute();
 assert.equal((await processing()).find(row=>row.lead_id===revoked)?.result_code,'AUTOMATION_CONDITION_FIELD_UNAVAILABLE');
 assert.equal((await db`SELECT id FROM follow_up WHERE kind='AUTOMATION'`).length,1);
 assert.equal((await api('PUT',root,{...def,version:1,enabled:false})).statusCode,200);
 const restored=await api('PUT',root,{...def,version:2,enabled:true});
 assert.equal(restored.statusCode,409,restored.body);
});

test('Only a changed, approved field matches its rule and revoking its binding stops pending execution',async t=>{
 const {db,branch,campaign,api,def,rule,create,matches,execute}=await fixture(t);
 const lead=await create();
 const settings={active:true,position:0,requiredStage:'NONE',visibleToAgent:true,editableByAgent:true,visibleToManager:true,
  editableByManager:true,showInTable:false,showInDetails:true,filterable:false,usableByAutomation:true,usableByAi:false};
 const binding=(id:string)=>'/api/campaigns/'+campaign+'/fields/'+id;
 async function makeField(name:string,usableByAutomation:boolean){
  const made=await api('POST','/api/fields',{scope:'CAMPAIGN',branchId:branch,campaignId:campaign,key:name,label:name,
   fieldType:'TEXT',valueMode:'MANUAL',options:[],validation:{}});
  assert.equal(made.statusCode,201,made.body);
  const id=made.json().id as string;
  assert.equal((await api('PUT',binding(id),{...settings,usableByAutomation})).statusCode,200);
  return id;
 }
 const tracked=await makeField('watched_entry',true);
 const other=await makeField('different_entry',true);
 const excluded=await makeField('excluded_entry',false);
 const options='/api/automations/trigger-fields?branchId='+branch+'&campaignId='+campaign;
 const listed=await api('GET',options);
 assert.equal(listed.statusCode,200,listed.body);
 assert.deepEqual(listed.json().items.map((item:{id:string})=>item.id).sort(),[other,tracked].sort());
 assert.equal((await api('GET',options,undefined,'other')).statusCode,404);
 assert.equal((await api('GET',options,undefined,'agent')).statusCode,403);
 const ruleDefinition={...def,branchId:branch,campaignId:campaign,triggerType:'FIELD_CHANGED'};
 assert.equal((await api('POST','/api/automations',ruleDefinition)).statusCode,400);
 assert.equal((await api('POST','/api/automations',{...ruleDefinition,triggerFieldId:excluded})).statusCode,409);
 const ruleId=await rule({triggerType:'FIELD_CHANGED',triggerFieldId:tracked});
 const change=(id:string,value:string,version?:number)=>api('PUT','/api/leads/'+lead+'/fields/'+id,{value,version},'agent');
 const value='Synthetic field value for Lead only';
 for(const id of [tracked,other,excluded]){
  const result=await change(id,value);
  assert.equal(result.statusCode,200,result.body);
 }
 const unchanged=await change(tracked,value,1);
 assert.equal(unchanged.statusCode,200,unchanged.body);
 assert.equal((await db`SELECT id FROM automation_field_change WHERE lead_id=${lead}`).length,2);
 await matches();
 await execute();
 const executions=()=>db`SELECT e.state,e.result_code FROM automation_execution e
  JOIN automation_source s ON s.id=e.source_id JOIN automation_field_change f ON f.id=s.field_change_id
  WHERE e.rule_id=${ruleId} ORDER BY f.value_version`;
 const initial=await executions();
 assert.equal(initial.length,1);
 assert.equal(initial[0]!.state,'SUCCEEDED');
 assert.equal((await change(tracked,'Revoked before execution',2)).statusCode,200);
 await matches();
 const revoked=await api('PUT',binding(tracked),{...settings,version:1,usableByAutomation:false});
 assert.equal(revoked.statusCode,200,revoked.body);
 await execute();
 const outcomes=await executions();
 assert.equal(outcomes.length,2);
 assert.equal(outcomes[1]!.state,'SKIPPED');
 assert.equal(outcomes[1]!.result_code,'AUTOMATION_TRIGGER_FIELD_UNAVAILABLE');
 assert.equal((await db`SELECT id FROM follow_up WHERE lead_id=${lead} AND kind='AUTOMATION'`).length,1);
 assert.equal((await api('PUT','/api/automations/'+ruleId,{...def,triggerType:'FIELD_CHANGED',triggerFieldId:tracked,enabled:false,version:1})).statusCode,200);
 await assert.rejects(db`INSERT INTO automation_field_change(lead_id,field_id,value_version)
  VALUES(${lead},${tracked},3)`,/AUTOMATION_FIELD_CHANGE_WRITE_REQUIRED/);
 assert.equal((await api('GET','/api/automation/executions?limit=50')).body.includes(value),false);
});

test('Conversation conditions evaluate the current controller and fail closed without a unique subject',async t=>{
 const {db,org,branch,campaign,users,api,def,rule,create,matches,execute}=await fixture(t);
 const policy={conversationStateCondition:'HUMAN_ACTIVE',controllerCondition:'HUMAN'};
 assert.equal((await api('POST','/api/automations',{...def,branchId:branch,campaignId:campaign,controllerCondition:'EXTERNAL'})).statusCode,400);
 const ruleId=await rule({...policy,name:'Follow up under current human control'});
 const connection=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name)
  VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic condition connection') RETURNING id`)[0]!.id;
 const sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,capabilities)
  VALUES(${org},${connection},'15550001234','Synthetic condition sender','{}') RETURNING id`)[0]!.id;
 async function conversation(leadId:string,channel='WHATSAPP'){
  return (await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
   VALUES(${leadId},${connection},${sender},${channel},'+15554000001','HUMAN',${users.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
 }
 const eligible=await create(),released=await create(),ambiguous=await create(),absent=await create();
 await conversation(eligible);
 const changed=await conversation(released);
 await conversation(ambiguous);
 await conversation(ambiguous,'SYNTHETIC_SECOND_CHANNEL');
 await matches();
 await db`UPDATE conversation SET controller_type='NONE',controller_user_id=NULL,state='WAITING_FOR_HUMAN' WHERE id=${changed}`;
 await execute();
 const results=await db`SELECT s.lead_id,e.state,e.result_code FROM automation_execution e
  JOIN automation_source s ON s.id=e.source_id WHERE e.rule_id=${ruleId}`;
 assert.equal(results.length,4);
 assert.equal(results.find(r=>r.lead_id===eligible)?.state,'SUCCEEDED');
 for(const lead of [released,ambiguous,absent]){
  const result=results.find(r=>r.lead_id===lead);
  assert.equal(result?.state,'SKIPPED');
  assert.equal(result?.result_code,'CONDITIONS_NOT_MET');
 }
 assert.equal((await db`SELECT id FROM follow_up WHERE kind='AUTOMATION'`).length,1);
 const path='/api/automations/'+ruleId;
 const kept=await api('PUT',path,{...def,version:1});
 assert.equal(kept.statusCode,200,kept.body);
 const [versionTwo]=await db`SELECT conversation_state_condition,controller_condition FROM automation_rule WHERE id=${ruleId}`;
 assert.equal(versionTwo!.conversation_state_condition,'HUMAN_ACTIVE');
 assert.equal(versionTwo!.controller_condition,'HUMAN');
 const cleared=await api('PUT',path,{...def,version:2,conversationStateCondition:null,controllerCondition:null});
 assert.equal(cleared.statusCode,200,cleared.body);
 const [versionThree]=await db`SELECT conversation_state_condition,controller_condition FROM automation_rule WHERE id=${ruleId}`;
 assert.equal(versionThree!.conversation_state_condition,null);
 assert.equal(versionThree!.controller_condition,null);
 const history=(await api('GET',path+'/history')).json();
 assert.equal(history.items[1].definition.conversation_state_condition,'HUMAN_ACTIVE');
});

test('A permitted conversation state transition admits one scoped rule and preserves its original states',async t=>{
 const {db,org,branch,api,rule,create,matches,execute}=await fixture(t);
 const lead=await create();
 const connection=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name)
  VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic conversation source') RETURNING id`)[0]!.id;
 const sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,capabilities)
  VALUES(${org},${connection},'15550001234','Synthetic conversation sender','{"text":true}') RETURNING id`)[0]!.id;
 const conversation=(await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,
  controller_type,state,needs_attention_reason)
  VALUES(${lead},${connection},${sender},'WHATSAPP','+15554000001','NONE','WAITING_FOR_HUMAN','NO_HUMAN_CONTROLLER') RETURNING id`)[0]!.id;
 const ruleId=await rule({name:'Respond to conversation state change',triggerType:'CONVERSATION_STATE_CHANGED',
  conversationStateCondition:'HUMAN_ACTIVE',controllerCondition:'HUMAN'});
 await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state)
  VALUES(${lead},${connection},${sender},'SYNTHETIC_SECOND_CHANNEL','+15554000001','NONE','WAITING_FOR_HUMAN')`;
 const path='/api/conversations/'+conversation+'/takeover';
 const takeover=(version:number,actor='agent')=>api('POST',path,{version,reason:'Take over synthetic conversation'},actor);
 assert.equal((await takeover(1,'other')).statusCode,404);
 assert.equal((await db`SELECT id FROM automation_conversation_change`).length,0);
 const attempts=await Promise.all([takeover(1),takeover(1)]);
 assert.deepEqual(attempts.map(r=>r.statusCode).sort(),[200,409]);
 assert.equal((await takeover(2)).json().existing,true);
 await db`UPDATE conversation SET state=state WHERE id=${conversation}`;
 const sources=await db`SELECT s.id,c.from_state,c.to_state,s.lead_id,s.branch_id,s.notification_event_id
  FROM automation_source s JOIN automation_conversation_change c ON c.id=s.conversation_change_id
  WHERE c.conversation_id=${conversation}`;
 assert.equal(sources.length,1);
 const source=sources[0]!;
 assert.equal(source.from_state,'WAITING_FOR_HUMAN');
 assert.equal(source.to_state,'HUMAN_ACTIVE');
 assert.equal(source.lead_id,lead);
 assert.equal(source.branch_id,branch);
 assert.equal(source.notification_event_id,null);
 await assert.rejects(db`INSERT INTO automation_conversation_change(conversation_id,from_state,to_state)
  VALUES(${conversation},'WAITING_FOR_HUMAN','HUMAN_ACTIVE')`,/AUTOMATION_CONVERSATION_TRANSITION_REQUIRED/);
 await assert.rejects(db`UPDATE automation_conversation_change SET from_state='CLOSED' WHERE id=${source.id}`,
  /AUTOMATION_CONVERSATION_CHANGE_IMMUTABLE/);
 await matches();
 await execute();
 const [outcome]=await db`SELECT id,state FROM automation_execution WHERE source_id=${source.id} AND rule_id=${ruleId}`;
 assert.equal(outcome?.state,'SUCCEEDED');
 assert.equal((await db`SELECT id FROM follow_up WHERE automation_execution_id=${outcome!.id}`).length,1);
 assert.equal((await api('GET','/api/automation/sources/'+source.id+'/history',undefined,'other')).statusCode,404);
});

test('Only a freshly attached authenticated customer message admits a scoped Message Received rule',async t=>{
 const {db,app,org,branch,campaign,users,api,rule,create,matches,execute}=await fixture(t);
 process.env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const lead=await create();
 const connection=(await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status,config)
  VALUES(${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic automation source','CONNECTED',
   '{"graphVersion":"v25.0","wabaId":"123456789"}') RETURNING id`)[0]!.id;
 const secret=sealSecret(connection,JSON.stringify({accessToken:'synthetic-token',appSecret:'synthetic-signature-key',verifyToken:'synthetic-verification'}));
 await db`INSERT INTO connection_secret(connection_id,ciphertext,nonce,auth_tag)
  VALUES(${connection},${secret.ciphertext},${secret.nonce},${secret.authTag})`;
 const sender=(await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,operator_enabled,capabilities)
  VALUES(${org},${connection},'15550001111','Synthetic sender','HEALTHY',true,'{"text":true}') RETURNING id`)[0]!.id;
 await db`UPDATE branch SET default_sender_id=${sender} WHERE id=${branch}`;
 const conversation=(await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
  VALUES(${lead},${connection},${sender},'WHATSAPP','+15554000001','HUMAN',${users.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
 const approved=await rule({name:'Receive customer reply',triggerType:'MESSAGE_RECEIVED',
  conversationStateCondition:'HUMAN_ACTIVE',controllerCondition:'HUMAN'});
 const body='Synthetic message text must remain in the conversation';
 const message={id:'wamid.autoreceived.'+randomUUID(),from:'15554000001',type:'text',text:{body},timestamp:String(Math.floor(Date.now()/1000))};
 const post=(candidate:typeof message,key='synthetic-signature-key')=>{
  const payload=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'123456789',changes:[{field:'messages',value:{
   messaging_product:'whatsapp',metadata:{phone_number_id:'15550001111'},messages:[candidate],
  }}]}]});
  return app.inject({method:'POST',url:'/api/webhooks/messaging/meta/'+connection,payload,headers:{
   'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',key).update(payload).digest('hex'),
  }});
 };
 const sources=()=>db`SELECT * FROM automation_source WHERE trigger_type='MESSAGE_RECEIVED'`;
 assert.equal((await post(message,'wrong-key')).statusCode,403);
 assert.equal((await post(message)).json().created,1);
 assert.equal((await sources()).length,0,'a signature alone does not resolve the destination');
 assert.deepEqual((await Promise.all([processOneInboundEvent(db),processOneInboundEvent(db)])).sort(),[false,true]);
 assert.equal((await post(message)).json().created,0);
 const results=await sources();
 assert.equal(results.length,1);
 const source=results[0]!;
 const attached=(await db`SELECT id,source_event_id FROM conversation_message WHERE conversation_id=${conversation} AND provider_message_id=${message.id}`)[0]!;
 assert.equal(source.id,attached.source_event_id);
 assert.equal(source.inbound_message_id,attached.id);
 assert.equal(source.notification_event_id,null);
 assert.equal(source.lead_id,lead);
 assert.deepEqual(source.causal_rule_ids,[]);
 await assert.rejects(db`INSERT INTO automation_source(id,inbound_message_id) VALUES(${randomUUID()},${attached.id})`,/AUTOMATION_TRUSTED_SOURCE_REQUIRED/);
 const unrelated={...message,id:'wamid.unmatched.'+randomUUID(),from:'15559998888'};
 assert.equal((await post(unrelated)).json().created,1);
 assert.equal(await processOneInboundEvent(db),true);
 const unsigned={...message,id:'wamid.unsigned.'+randomUUID()};
 const event=(await db`INSERT INTO integration_event(connection_id,provider_event_id,event_kind,sender_id,participant_ref,payload)
  VALUES(${connection},${randomUUID()},'INBOUND_MESSAGE',${sender},'+15554000001',${db.json({senderExternalId:'15550001111',message:unsigned})}) RETURNING id`)[0]!.id;
 assert.equal(await processOneInboundEvent(db),true);
 assert.equal((await db`SELECT state FROM integration_event WHERE id=${event}`)[0]!.state,'PROCESSED');
 assert.equal((await sources()).length,1);
 await rule({name:'Future approval cannot match',triggerType:'MESSAGE_RECEIVED'});
 await matches();
 await execute();
 const applied=await db`SELECT id,rule_id,state FROM automation_execution WHERE source_id=${source.id}`;
 assert.equal(applied.length,1);
 assert.equal(applied[0]!.rule_id,approved);
 assert.equal(applied[0]!.state,'SUCCEEDED');
 assert.equal((await db`SELECT id FROM follow_up WHERE automation_execution_id=${applied[0]!.id} AND lead_id=${lead}`).length,1);
 const history='/api/automation/sources/'+source.id+'/history';
 for(const actor of ['other','foreign']) assert.equal((await api('GET',history,undefined,actor)).statusCode,404);
 assert.equal((await api('GET',history,undefined,'agent')).statusCode,403);
 const processing=await api('GET','/api/automation/sources?limit=50');
 assert.equal(processing.statusCode,200);
 assert.ok(processing.json().items.some((item:{id:string})=>item.id===source.id));
 assert.equal(processing.body.includes(body),false);
 assert.equal(processing.body.includes(message.id),false);
 assert.equal((await db`SELECT id FROM audit_log WHERE action='AUTOMATION_ACTION_APPLIED' AND detail->>'ruleId'=${approved}`).length,1);
});

test('Follow-up due automation preserves task causation and skips a repeated rule in the same chain',async t=>{
 const {db,api,rule,create,matches,execute}=await fixture(t);
 const origin=await rule({name:'Open the first follow-up',delayMinutes:0});
 const due=await rule({name:'Create one follow-up after the task is due',triggerType:'FOLLOW_UP_DUE',delayMinutes:0});
 const lead=await create();
 await matches();await execute();
 const rows=()=>db`SELECT e.id,e.rule_id,e.state,e.result_code,s.parent_execution_id,s.causal_rule_ids
  FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${lead} ORDER BY cardinality(s.causal_rule_ids)`;
 const initial=(await rows())[0]!;
 assert.equal(initial.rule_id,origin);
 assert.equal(await processOneFollowUpNotification(db),true);
 await matches();await execute();
 const firstDue=(await rows())[1]!;
 assert.equal(firstDue.rule_id,due);
 assert.equal(firstDue.state,'SUCCEEDED');
 assert.equal(firstDue.parent_execution_id,initial.id);
 assert.deepEqual(firstDue.causal_rule_ids,[origin]);

 assert.equal(await processOneFollowUpNotification(db),true);
 await matches();await execute();
 const final=await rows();
 assert.equal(final.length,3);
 const skipped=final[2]!;
 assert.equal(skipped.rule_id,due);
 assert.equal(skipped.state,'SKIPPED');
 assert.equal(skipped.result_code,'AUTOMATION_CAUSAL_REPEAT');
 assert.equal(skipped.parent_execution_id,firstDue.id);
 assert.deepEqual(skipped.causal_rule_ids,[origin,due]);
 assert.equal((await db`SELECT count(*)::int n FROM follow_up WHERE lead_id=${lead}`)[0]!.n,2);
 assert.equal(await processOneFollowUpNotification(db),false);
 assert.equal(await processOneAutomationMatch(db),false);
 assert.equal(await processOneAutomationExecution(db),false);
 const checked=await api('GET',`/api/automation/executions/${skipped.id}/history`);
 assert.equal(checked.statusCode,200,checked.body);
 assert.equal(checked.json().items[0].result_code,'AUTOMATION_CAUSAL_REPEAT');
 assert.equal((await api('GET',`/api/automation/executions/${skipped.id}/history`,undefined,'other')).statusCode,404);
});

test('Automation uses committed versioned approvals and trusted durable sources, scoped CAS and exactly-once typed internal effects',async t=>{
 const {db,org,branch,other,campaign,users,api,def,rule,create,matches,execute}=await fixture(t);
 for(const who of ['agent','other','foreign']){
  assert.equal((await api('POST','/api/automations',{...def,branchId:branch,campaignId:campaign},who)).statusCode,who==='agent'?403:404);
 }
 assert.equal((await api('POST','/api/automations',{...def,branchId:null,campaignId:null})).statusCode,404);
 assert.equal((await api('POST','/api/automations',{...def,branchId:branch,campaignId:campaign,sql:'DELETE FROM lead'})).statusCode,400);
 assert.equal((await api('POST','/api/automations',{...def,branchId:branch,campaignId:campaign,actionType:'CONFIRM_PAYMENT'})).statusCode,400);
 const r=await rule(),notice=await rule({name:'Internal attention',actionType:'SEND_IN_APP_NOTIFICATION',delayMinutes:0,priority:'NORMAL',note:'Plain <img src=x onerror=alert(1)> text'});
 const lead=await create();assert.equal((await db`SELECT count(*)::int AS n FROM follow_up`)[0]!.n,0);
 const future=await rule({name:'Do not backfill earlier sources'});
 await Promise.all(Array.from({length:8},()=>matches()));await Promise.all(Array.from({length:8},()=>execute()));
 const ex=await db`SELECT e.* FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${lead}`;
 assert.equal(ex.length,2);assert.ok(ex.every(e=>e.state==='SUCCEEDED'));assert.ok(ex.every(e=>e.rule_id!==future));
 const task=(await db`SELECT f.*,f.due_at=s.captured_at+interval '60 minutes' AS correct_due FROM follow_up f
  JOIN automation_execution e ON e.id=f.automation_execution_id JOIN automation_source s ON s.id=e.source_id WHERE f.lead_id=${lead}`)[0]!;
 assert.equal(task.kind,'AUTOMATION');assert.equal(task.created_by,null);assert.equal(task.owner_user_id,users.agent!.id);assert.equal(task.correct_due,true);assert.equal(task.priority,'HIGH');
 assert.equal((await db`SELECT actor_user_id,event_type FROM follow_up_history WHERE follow_up_id=${task.id}`)[0]!.event_type,'AUTOMATION_CREATED');
 const feed=(await api('GET','/api/notifications?language=en&limit=50',undefined,'agent')).json().items,alert=feed.find((n:any)=>n.eventType==='AUTOMATION_NOTICE');
 assert.equal(alert.automation.ruleId,notice);assert.match(alert.automation.note,/<img/);assert.equal(alert.automation.ruleVersion,1);
 assert.equal((await db`SELECT count(*)::int AS n FROM automation_source WHERE trigger_type='AUTOMATION_NOTICE'`)[0]!.n,0);
 assert.equal((await db`SELECT count(*)::int AS n FROM conversation`)[0]!.n,0);assert.equal((await db`SELECT count(*)::int AS n FROM payment_record`)[0]!.n,0);
 const page=(await api('GET','/api/automations?limit=1')).json();assert.equal(page.items.length,1);assert.ok(page.nextCursor);
 assert.ok((await api('GET','/api/automations?limit=1&cursor='+encodeURIComponent(page.nextCursor))).json().items.every((x:any)=>x.id!==page.items[0].id));
 assert.equal((await api('GET','/api/automations',undefined,'agent')).statusCode,403);
 for(const who of ['other','foreign']){
  assert.equal((await api('GET','/api/automations',undefined,who)).json().items.length,0);
  assert.equal((await api('GET','/api/automations/'+r+'/history',undefined,who)).statusCode,404);
  assert.equal((await api('GET','/api/automation/executions/'+ex[0]!.id+'/history',undefined,who)).statusCode,404);
 }
 const h=(await api('GET','/api/automations/'+r+'/history')).json().items[0];assert.equal(h.version,1);assert.ok(!('session_id'in h.definition));assert.ok(!('approval_xid'in h.definition));
 const changes=await Promise.all(Array.from({length:8},()=>api('PUT','/api/automations/'+r,{...def,version:1,enabled:false,reason:'Explicitly stop pending rules'})));
 assert.equal(changes.filter(x=>x.statusCode===200).length,1);assert.equal(changes.filter(x=>x.statusCode===409).length,7);
 assert.equal((await api('GET','/api/automations/'+r+'/history')).json().items.length,2);
 const source=(await db`SELECT id FROM automation_source WHERE lead_id=${lead} AND trigger_type='LEAD_CREATED'`)[0]!.id;
 await assert.rejects(db`INSERT INTO automation_source(id) VALUES(${source})`,/TRUSTED_SOURCE/);
 await assert.rejects(db`UPDATE automation_source SET trigger_type='LEAD_ASSIGNED' WHERE id=${source}`,/IMMUTABLE/);
 await assert.rejects(db`INSERT INTO automation_execution(source_id,rule_id,rule_version) VALUES(${source},${r},1)`,/MATCHED_SOURCE/);
 await assert.rejects(db`UPDATE automation_execution SET version=version+1,operation='EXECUTE' WHERE id=${ex[0]!.id}`,/NOT_READY/);
 await assert.rejects(db`INSERT INTO follow_up(automation_execution_id) VALUES(${ex[0]!.id})`,/APPROVED_ACTION/);
 await assert.rejects(db`UPDATE follow_up SET automation_execution_id=NULL WHERE id=${task.id}`,/PROVENANCE/);
 await assert.rejects(db`INSERT INTO notification_event(event_type,automation_execution_id) VALUES('AUTOMATION_NOTICE',${ex[0]!.id})`,/APPROVED_ACTION/);
 await assert.rejects(db`UPDATE automation_rule_version SET snapshot='{}' WHERE rule_id=${r}`,/IMMUTABLE/);
 await assert.rejects(db`UPDATE automation_processing_history SET snapshot='{}' WHERE resource_id=${ex[0]!.id}`,/IMMUTABLE/);
 await assert.rejects(db`UPDATE automation_rule SET branch_id=${other},version=version+1 WHERE id=${r}`,/IDENTITY/);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
 assert.equal((await api('PUT','/api/automations/'+r,{...def,version:2})).statusCode,401);
 assert.equal((await api('GET','/api/automation/sources')).statusCode,401);
 // The original source is still immutable, distinct from a notification's read state.
 assert.equal((await db`SELECT organization_id FROM automation_source WHERE id=${source}`)[0]!.organization_id,org);
});

test('Automation evaluates current scope, owner, conditions and approver without borrowing an expired human session or replaying old rule versions',async t=>{
 const {db,org,branch,campaign,users,api,def,rule,create,matches,execute}=await fixture(t);
 const r=await rule();const lead=await create();await matches();
 await api('PUT','/api/automations/'+r,{...def,version:1,enabled:false});await execute();
 assert.equal((await db`SELECT result_code FROM automation_execution WHERE rule_id=${r}`)[0]!.result_code,'RULE_CHANGED');
 await api('PUT','/api/automations/'+r,{...def,version:2,enabled:true});
 const moved=await create();await matches();const assignment=await api('POST','/api/leads/'+moved+'/assignment',{version:1,agentId:users.second!.id});assert.equal(assignment.statusCode,200,assignment.body);
 // Logout is not deauthorization of a persisted approved rule; current account role/scope still apply.
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
 await execute();assert.equal((await db`SELECT owner_user_id FROM follow_up WHERE lead_id=${moved}`)[0]!.owner_user_id,users.second!.id);
 // Create further real manual intake through a separately authorized Super Admin.
 const fresh=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Authority revoked',phone:'+15554001234'}},'admin');assert.equal(fresh.statusCode,201,fresh.body);await matches();
 await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`;await execute();
 assert.equal((await db`SELECT e.result_code FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${fresh.json().id} AND e.rule_id=${r}`)[0]!.result_code,'APPROVAL_REVOKED');
 assert.equal((await db`SELECT count(*)::int AS n FROM follow_up WHERE lead_id=${fresh.json().id}`)[0]!.n,0);
 const cond=await rule({ownerCondition:'UNASSIGNED'},'admin'),condLead=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Conditions',phone:'+15554001235'}},'admin');await matches();await execute();
 assert.equal((await db`SELECT e.result_code FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${condLead.json().id} AND e.rule_id=${cond}`)[0]!.result_code,'CONDITIONS_NOT_MET');
 // An approval started earlier but still uncommitted at capture is never retrospectively admitted.
 let release!:()=>void,ready!:()=>void;const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>ready=r);let invisibleRule='';
 const pending=db.begin(async tx=>{invisibleRule=(await tx`INSERT INTO automation_rule(organization_id,name,version,enabled,trigger_type,lifecycle,owner_condition,action_type,delay_minutes,priority,note,actor_id,session_id,reason)
  VALUES(${org},'Uncommitted global approval',1,true,'LEAD_CREATED','OPEN','ASSIGNED','CREATE_FOLLOW_UP',0,'NORMAL','Synthetic',${users.admin!.id},${users.admin!.session},'Synthetic pending approval') RETURNING id`)[0]!.id;ready();await wait;});
 await started;
 try{const before=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Before commit',phone:'+15554001236'}},'admin');assert.equal(before.statusCode,201,before.body);release();await pending;await matches();await execute();
  assert.equal((await db`SELECT count(*)::int AS n FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE s.lead_id=${before.json().id} AND e.rule_id=${invisibleRule}`)[0]!.n,0);
 }finally{release();await pending;}
 // Scope drift fences an already-admitted action, and its old source is not exposed through new-scope history.
 const scopeRule=await rule({},'admin'),last=await api('POST','/api/leads',{branchId:branch,campaignId:campaign,contact:{name:'Changed scope',phone:'+15554001237'}},'admin');await matches();
 const e=(await db`SELECT e.id,e.source_id FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE e.rule_id=${scopeRule} AND s.lead_id=${last.json().id}`)[0]!;
 const newCampaign=(await db`INSERT INTO campaign(organization_id,branch_id,name,status) VALUES(${org},${branch},'New scope','ACTIVE') RETURNING id`)[0]!.id;
 await db`UPDATE lead SET campaign_id=${newCampaign} WHERE id=${last.json().id}`;await execute();
 assert.equal((await db`SELECT result_code FROM automation_execution WHERE id=${e.id}`)[0]!.result_code,'SCOPE_CHANGED');
 assert.equal((await api('GET','/api/automation/executions/'+e.id+'/history',undefined,'admin')).statusCode,404);
 assert.equal((await db`SELECT count(*)::int AS n FROM follow_up WHERE lead_id=${last.json().id}`)[0]!.n,0);
});

test('Automation bounds database failures, rolls back partial actions, recovers with current scoped CAS and resumes through the compiled durable worker',async t=>{
 const {db,users,api,rule,create,matches}=await fixture(t);const r=await rule(),lead=await create();await matches();
 const e=(await db`SELECT e.id FROM automation_execution e JOIN automation_source s ON s.id=e.source_id WHERE e.rule_id=${r} AND s.lead_id=${lead}`)[0]!;
 await db`CREATE FUNCTION reject_automation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AUTOMATION_ACTION_APPLIED' THEN RAISE EXCEPTION 'SYNTHETIC_AUTOMATION_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_automation_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_automation_fixture()`;
 try{for(let n=1;n<=5;n++){
  if(n>1){const next=(await db`SELECT next_run_at FROM automation_execution WHERE id=${e.id}`)[0]!.next_run_at;await new Promise(resolve=>setTimeout(resolve,Math.max(0,+next-Date.now())+35));}
  assert.equal(await processOneAutomationExecution(db),true);
  assert.equal((await db`SELECT failure_count FROM automation_execution WHERE id=${e.id}`)[0]!.failure_count,n);
  assert.equal((await db`SELECT count(*)::int AS n FROM follow_up WHERE lead_id=${lead}`)[0]!.n,0);
 }}finally{await db`DROP TRIGGER reject_automation_fixture ON audit_log`;await db`DROP FUNCTION reject_automation_fixture()`;}
 const dead=(await db`SELECT * FROM automation_execution WHERE id=${e.id}`)[0]!;assert.equal(dead.state,'DEAD_LETTER');assert.equal(dead.version,6);
 const root='/api/automation/executions/'+e.id;assert.equal((await api('GET',root+'/history')).json().items.length,6);
 for(const who of ['agent','other','foreign'])assert.equal((await api('POST',root+'/retry',{version:6},who)).statusCode,who==='agent'?403:404);
 const attempts=await Promise.all(Array.from({length:8},()=>api('POST',root+'/retry',{version:6})));
 assert.equal(attempts.filter(x=>x.statusCode===200).length,1);assert.equal(attempts.filter(x=>x.statusCode===409).length,7);
 const worker=spawn(process.execPath,[fileURLToPath(new URL('../src/automation-worker.js',import.meta.url))],{env:{...process.env,DATABASE_URL:url!,AUTOMATION_WORKER_BATCH:'1',AUTOMATION_WORKER_POLL_MS:'250'},stdio:['ignore','pipe','pipe']});
 let output='';worker.stdout.on('data',d=>output+=String(d));worker.stderr.on('data',()=>{});
 try{const until=Date.now()+12000;while(Date.now()<until&&(await db`SELECT state FROM automation_execution WHERE id=${e.id}`)[0]!.state!=='SUCCEEDED')await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal((await db`SELECT state FROM automation_execution WHERE id=${e.id}`)[0]!.state,'SUCCEEDED');assert.match(output,/automation_worker_started/);
 }finally{worker.kill();await new Promise<void>(resolve=>{if(worker.exitCode!==null)resolve();else worker.once('exit',()=>resolve());});}
 assert.equal((await db`SELECT count(*)::int AS n FROM follow_up WHERE automation_execution_id=${e.id}`)[0]!.n,1);
 assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE action='AUTOMATION_ACTION_APPLIED' AND target_id=${e.id}`)[0]!.n,1);
 assert.equal((await api('POST',root+'/retry',{version:8})).statusCode,409);
 await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;assert.equal((await api('GET',root+'/history')).statusCode,401);
 assert.equal((await db`SELECT count(*)::int AS n FROM conversation_message`)[0]!.n,0);
});

test('Automation matching is bounded per source, survives failures and concurrent recovery, and never admits future approvals or loses batch boundaries',async t=>{
 const {db,api,rule,create}=await fixture(t);
 for(let i=0;i<51;i++)await rule({name:'Bounded matching rule '+i});
 const lead=await create(),source=(await db`SELECT id FROM automation_source WHERE lead_id=${lead} AND trigger_type='LEAD_CREATED'`)[0]!.id;
 // Drain the unrelated assigned source, without fabricating a queue result or event timestamp.
 await db`CREATE FUNCTION reject_match_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AUTOMATION_MATCH' THEN RAISE EXCEPTION 'SYNTHETIC_MATCH_FAILURE';END IF;RETURN NEW;END $$`;
 await db`CREATE TRIGGER reject_match_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_match_fixture()`;
 try{for(let n=1;n<=5;n++){
  if(n>1){const when=(await db`SELECT next_run_at FROM automation_match_queue WHERE source_id=${source}`)[0]!.next_run_at;await new Promise(resolve=>setTimeout(resolve,Math.max(0,+when-Date.now())+35));}
  for(let drain=0;drain<5;drain++){
   await processOneAutomationMatch(db);if((await db`SELECT failure_count FROM automation_match_queue WHERE source_id=${source}`)[0]!.failure_count===n)break;
  }
  assert.equal((await db`SELECT failure_count FROM automation_match_queue WHERE source_id=${source}`)[0]!.failure_count,n);
  assert.equal((await db`SELECT count(*)::int AS n FROM automation_execution WHERE source_id=${source}`)[0]!.n,0);
 }}finally{await db`DROP TRIGGER reject_match_fixture ON audit_log`;await db`DROP FUNCTION reject_match_fixture()`;}
 const q=(await db`SELECT state,version FROM automation_match_queue WHERE source_id=${source}`)[0]!;assert.equal(q.state,'DEAD_LETTER');
 const root='/api/automation/sources/'+source;
 assert.equal((await api('POST',root+'/retry',{version:q.version},'agent')).statusCode,403);
 const retries=await Promise.all(Array.from({length:8},()=>api('POST',root+'/retry',{version:q.version})));
 assert.equal(retries.filter(r=>r.statusCode===200).length,1);assert.equal(retries.filter(r=>r.statusCode===409).length,7);
 const future=await rule({name:'Approval committed after capture'});
 // At most 50 matches are admitted in a single source transition; the second page has exactly one.
 for(let n=0;n<5;n++){
  await processOneAutomationMatch(db);const count=(await db`SELECT count(*)::int AS n FROM automation_execution WHERE source_id=${source}`)[0]!.n;
  if(count){assert.equal(count,50);break;}
 }
 assert.equal((await db`SELECT state FROM automation_match_queue WHERE source_id=${source}`)[0]!.state,'QUEUED');
 await Promise.all(Array.from({length:8},()=>processOneAutomationMatch(db)));
 assert.equal((await db`SELECT state FROM automation_match_queue WHERE source_id=${source}`)[0]!.state,'DONE');
 assert.equal((await db`SELECT count(*)::int AS n FROM automation_execution WHERE source_id=${source}`)[0]!.n,51);
 assert.equal((await db`SELECT count(*)::int AS n FROM automation_execution WHERE source_id=${source} AND rule_id=${future}`)[0]!.n,0);
 assert.ok((await api('GET',root+'/history')).json().items.length>=8);
 const first=(await api('GET','/api/automation/executions?limit=2')).json();assert.equal(first.items.length,2);assert.ok(first.nextCursor);
 assert.ok((await api('GET','/api/automation/executions?limit=2&cursor='+encodeURIComponent(first.nextCursor))).json().items.every((x:any)=>!first.items.some((f:any)=>f.id===x.id)));
});
