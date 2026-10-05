import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;if (!url || new URL(url).pathname!=='/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('Leads without Contact preserve scoped CRM operations and history while consent, conversation creation and outbound remain blocked',async(t)=> {
  process.env.APP_ORIGIN='http://127.0.0.1:5173';const db=createDatabase(url);const app=await buildApp(db,{ logger:false,globalRateLimitMax:10000 });
  t.after(async()=> { await app.close();await db.end(); });
  await db.begin(async(tx)=> { await tx`SET LOCAL client_min_messages TO warning`;await tx`TRUNCATE background_job CASCADE`;await tx`TRUNCATE organization CASCADE`; });
  const org=(await db`INSERT INTO organization (name) VALUES ('Optional Contact') RETURNING id`)[0]!.id;
  const branch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'A') RETURNING id`)[0]!.id;
  const otherBranch=(await db`INSERT INTO branch (organization_id,name) VALUES (${org},'B') RETURNING id`)[0]!.id;
  const users:Record<string,{ id:string;cookie:string }>={};
  for (const [name,role,scope] of [['admin','SUPER_ADMIN',null],['manager','MANAGER',branch],['other','MANAGER',otherBranch],['agent','AGENT',branch],['second','AGENT',branch]] as const) {
    const id=(await db`INSERT INTO user_account (organization_id,branch_id,name,role,email,password_hash)
      VALUES (${org},${scope},${name},${role},${name+'@optional.test'},'synthetic-hash') RETURNING id`)[0]!.id;
    const token=randomBytes(32).toString('hex');await db`INSERT INTO user_session (user_id,token_hash,expires_at) VALUES (${id},${sha256(token)},now()+interval '1 hour')`;
    users[name]={ id,cookie:'lop_session='+token };
  }
  let ip=1;const api=(method:'GET'|'POST'|'PUT',path:string,body?:object,actor='agent')=>app.inject({ method,url:path,payload:body,
    headers:{ origin:process.env.APP_ORIGIN!,cookie:users[actor]!.cookie },remoteAddress:`127.0.0.${ip++}` });
  const campaign=(await db`INSERT INTO campaign (organization_id,branch_id,name,source_kind,status,messaging_config)
    VALUES (${org},${branch},'Contact optional','META','ACTIVE','{"enabled":true}'::jsonb) RETURNING id`)[0]!.id;
  // Source creation is a later service. This fixture verifies the corrected Core model and every affected read/action path.
  const lead=(await db`INSERT INTO lead (organization_id,branch_id,campaign_id,source_kind,assigned_agent_id)
    VALUES (${org},${branch},${campaign},'META',${users.agent!.id}) RETURNING id`)[0]!.id;
  const base='/api/leads/'+lead;
  for (const actor of ['admin','manager','agent']) {
    const detail=await api('GET',base,undefined,actor);assert.equal(detail.statusCode,200);assert.equal(detail.json().lead.contact_id,null);assert.equal(detail.json().lead.contact_name,null);
    assert.equal((await api('GET','/api/leads?q='+lead,undefined,actor)).json().items[0].id,lead);
  }
  for (const actor of ['other','second']) {
    assert.equal((await api('GET',base,undefined,actor)).statusCode,404);
    assert.equal((await api('GET','/api/leads?q='+lead,undefined,actor)).json().items.length,0);
    assert.equal((await api('GET',base+'/messaging-consent',undefined,actor)).statusCode,404);
    assert.equal((await api('POST',base+'/conversations',undefined,actor)).statusCode,404);
  }
  for (const actor of ['admin','manager','agent']) {
    const consent=(await api('GET',base+'/messaging-consent',undefined,actor)).json();assert.equal(consent.editable,false);assert.equal(consent.unavailable_reason,'CONTACT_REQUIRED');
    assert.equal((await api('POST',base+'/conversations',undefined,actor)).json().error,'CONTACT_PHONE_REQUIRED');
  }
  const consentBody={ version:0,status:'GRANTED',doNotContact:false,source:'EXPLICIT',evidence:'Test only evidence' };
  for (const actor of ['admin','manager']) assert.equal((await api('PUT',base+'/messaging-consent',consentBody,actor)).json().error,'CONTACT_REQUIRED');
  assert.equal((await api('PUT',base+'/messaging-consent',consentBody)).statusCode,403);
  assert.equal((await db`SELECT count(*)::integer AS n FROM messaging_consent`)[0]!.n,0);
  assert.equal((await api('POST',base+'/notes',{ text:'Contact not supplied in source' })).statusCode,201);
  const followup=await api('POST',base+'/followups',{ dueAt:new Date(Date.now()+3600000).toISOString(),note:'Use operational source fields' });assert.equal(followup.statusCode,201);
  const tasks=(await api('GET','/api/followups')).json();assert.equal(tasks.items[0].lead_id,lead);assert.equal(tasks.items[0].contact_name,null);
  assert.equal((await api('GET','/api/followups',undefined,'second')).json().items.length,0);
  const field=(await db`INSERT INTO field_definition (organization_id,branch_id,campaign_id,key,label,field_type,value_mode)
    VALUES (${org},${branch},${campaign},'interest','Interest','NUMBER','MANUAL') RETURNING id`)[0]!.id;
  await db`INSERT INTO campaign_field (campaign_id,field_id) VALUES (${campaign},${field})`;
  const stored=await api('PUT',base+'/fields/'+field,{ value:12 });assert.equal(stored.statusCode,200,stored.body);
  assert.equal((await db`SELECT value FROM lead_field_value WHERE lead_id=${lead}`)[0]!.value,12);
  // An existing historical thread remains readable, but its participant reference never fabricates a current Contact or consent.
  const connection=(await db`INSERT INTO integration_connection (organization_id,branch_id,kind,provider,name,status)
    VALUES (${org},${branch},'MESSAGING','META_WHATSAPP_CLOUD','Historical','CONNECTED') RETURNING id`)[0]!.id;
  const sender=(await db`INSERT INTO messaging_sender (organization_id,connection_id,external_sender_id,display_name,health,operator_enabled)
    VALUES (${org},${connection},'100','Historical','HEALTHY',true) RETURNING id`)[0]!.id;
  const conversation=(await db`INSERT INTO conversation (lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
    VALUES (${lead},${connection},${sender},'WHATSAPP','+15550009999','HUMAN',${users.agent!.id},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
  const message=(await db`INSERT INTO conversation_message (conversation_id,connection_id,sender_id,direction,author_type,body,provider_message_id,delivery_state,received_at)
    VALUES (${conversation},${connection},${sender},'INBOUND','CUSTOMER','Historical content','old-reference','RECEIVED',now()) RETURNING id`)[0]!.id;
  assert.equal((await api('GET',`/api/conversations/${conversation}/messages`)).json().items[0].id,message);
  const blocked=await api('POST',`/api/conversations/${conversation}/messages`,{ body:'Must not dispatch',idempotencyKey:randomUUID() });assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error,'CONTACT_REQUIRED');
  assert.equal((await db`SELECT count(*)::integer AS n FROM outbound_delivery_job`)[0]!.n,0);
  assert.equal((await api('POST',base+'/assignment',{ version:1,agentId:users.second!.id,reason:'Continue without identity' },'manager')).statusCode,200);
  assert.equal((await api('GET',base)).statusCode,404);assert.equal((await api('GET',base,undefined,'second')).statusCode,200);
  assert.equal((await api('GET','/api/followups')).json().items.length,0);assert.equal((await api('GET','/api/followups',undefined,'second')).json().items[0].lead_id,lead);
  assert.equal((await api('GET',`/api/conversations/${conversation}/messages`)).statusCode,404);
  assert.equal((await api('GET',`/api/conversations/${conversation}/messages`,undefined,'second')).json().items[0].id,message);
  const foreignOrg=(await db`INSERT INTO organization (name) VALUES ('Foreign Contact') RETURNING id`)[0]!.id;
  const foreignContact=(await db`INSERT INTO contact (organization_id,name) VALUES (${foreignOrg},'Foreign') RETURNING id`)[0]!.id;
  await assert.rejects(db`UPDATE lead SET contact_id=${foreignContact} WHERE id=${lead}`);
  assert.equal((await db`SELECT count(*)::integer AS n FROM contact WHERE organization_id=${org}`)[0]!.n,0,'no fabricated Contact');
});
