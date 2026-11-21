import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { passwordHash } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Campaign configuration, readiness, scope, concurrency, and history on PostgreSQL', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  const db = createDatabase(url);
  const app = await buildApp(db, { logger: false });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE organization CASCADE`; });
  const send = async (method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', path: string, body?: object, cookie?: string) => app.inject({
    method, url: path, payload: body, headers: { origin: process.env.APP_ORIGIN!, ...(cookie ? { cookie } : {}) },
  });
  const password = 'Test password 12345!';
  const bootstrap = await send('POST', '/api/setup/bootstrap', {
    token: process.env.BOOTSTRAP_TOKEN, organizationName: 'Campaign Test', name: 'Owner', email: 'owner@example.test', password,
  });
  assert.equal(bootstrap.statusCode, 201, bootstrap.body);
  const login = async (email: string) => {
    const response = await send('POST', '/api/auth/login', { email, password });
    assert.equal(response.statusCode, 200, response.body);
    return (response.headers['set-cookie'] as string).split(';')[0]!;
  };
  const admin = await login('owner@example.test');
  const branchA = (await send('POST', '/api/branches', { name: 'A', timezone: 'UTC' }, admin)).json().id as string;
  const branchB = (await send('POST', '/api/branches', { name: 'B', timezone: 'UTC' }, admin)).json().id as string;
  const organizationId = (await db`SELECT id FROM organization LIMIT 1`)[0]!.id as string;
  const hash = await passwordHash(password);
  const createUser = async (branchId: string, role: 'MANAGER'|'AGENT', email: string) => {
    const rows = await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash)
      VALUES (${organizationId}, ${branchId}, ${role}, ${email}, ${email}, ${hash}) RETURNING id`;
    return rows[0]!.id as string;
  };
  await createUser(branchA, 'MANAGER', 'manager-a@example.test');
  await createUser(branchB, 'MANAGER', 'manager-b@example.test');
  const agentA = await createUser(branchA, 'AGENT', 'agent-a@example.test');
  const agentB = await createUser(branchB, 'AGENT', 'agent-b@example.test');
  const managerA = await login('manager-a@example.test');
  const managerB = await login('manager-b@example.test');
  const agent = await login('agent-a@example.test');

  assert.equal((await send('POST', '/api/campaigns', { branchId: branchA, name: ' ' }, managerA)).statusCode, 400);
  assert.equal((await send('POST', '/api/campaigns', { branchId: branchA, name: 'X', sourceKind: 'bad' }, managerA)).statusCode, 400);
  const created = await send('POST', '/api/campaigns', { branchId: branchA, name: 'Autumn' }, managerA);
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  for (const path of [`/api/campaigns/${id}`, `/api/campaigns/${id}/readiness`]) {
    assert.equal((await send('GET', path, undefined, managerB)).statusCode, 403);
    assert.equal((await send('GET', path, undefined, agent)).statusCode, 403);
  }
  assert.equal((await send('GET', `/api/campaigns/${id}/eligible-agents`, undefined, managerB)).statusCode, 403);
  assert.equal((await send('GET', `/api/campaigns/${id}/eligible-agents`, undefined, agent)).statusCode, 403);
  const eligible = await send('GET', `/api/campaigns/${id}/eligible-agents?q=agent-a`, undefined, managerA);
  assert.deepEqual(eligible.json().items.map((item: { id: string }) => item.id), [agentA]);
  assert.deepEqual((await send('GET', `/api/campaigns/${id}/eligible-agents?q=agent-b`, undefined, managerA)).json().items, []);
  assert.equal((await send('GET', `/api/campaigns/${id}/readiness`, undefined, managerA)).json().ready, true);
  assert.equal((await send('GET', '/api/campaigns?branchId=' + branchB, undefined, managerA)).statusCode, 403);
  assert.deepEqual((await send('GET', '/api/campaigns', undefined, managerB)).json().items, []);
  const initialVersion = (await send('GET', `/api/campaigns/${id}`, undefined, managerA)).json().campaign.version as number;
  const config = { version: initialVersion, name: 'Autumn Updated', sourceKind: 'META', routingMethod: 'WEIGHTED',
    messagingEnabled: true, aiEnabled: true, conversion: { type: 'PAYMENT_CONFIRMED' } };
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, config, agent)).statusCode, 403);
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, config, managerB)).statusCode, 403);
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, { ...config, unknown: true }, managerA)).statusCode, 400);
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, { ...config, conversion: { type: 'CLOSED' } }, managerA)).statusCode, 400);
  const competing = await Promise.all([send('PATCH', `/api/campaigns/${id}`, config, managerA),
    send('PATCH', `/api/campaigns/${id}`, { ...config, name: 'Competing' }, managerA)]);
  assert.deepEqual(competing.map((response) => response.statusCode).sort(), [200, 409]);
  const configured = (await send('GET', `/api/campaigns/${id}`, undefined, managerA)).json();
  assert.equal(configured.campaign.conversion_config.type, 'PAYMENT_CONFIRMED');
  assert.deepEqual(new Set(configured.issues), new Set([
    'NO_ELIGIBLE_AGENTS_CONFIGURED', 'SOURCE_BINDING_NOT_READY',
    'MESSAGING_CONFIGURATION_NOT_READY', 'AI_CONFIGURATION_NOT_READY',
  ]));
  assert.equal((await send('POST', `/api/campaigns/${id}/activate`, undefined, managerA)).statusCode, 409);
  assert.equal((await send('PUT', `/api/campaigns/${id}/agents`, { agentId: agentB }, managerA)).statusCode, 400);
  assert.equal((await send('PUT', `/api/campaigns/${id}/agents`, { agentId: agentA }, managerB)).statusCode, 403);
  const bound = await send('PUT', `/api/campaigns/${id}/agents`, { agentId: agentA, weight: 3, capacityOverride: 2 }, managerA);
  assert.equal(bound.statusCode, 200, bound.body);
  const latestVersion = bound.json().version as number;
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, { ...config, version: latestVersion - 1 }, managerA)).statusCode, 409);
  const performance = await send('PATCH', `/api/campaigns/${id}`, { ...config, version: latestVersion,
    sourceKind: 'MANUAL', routingMethod: 'PERFORMANCE', messagingEnabled: false, aiEnabled: false }, managerA);
  assert.equal(performance.statusCode, 200, performance.body);
  assert.deepEqual((await send('GET', `/api/campaigns/${id}/readiness`, undefined, managerA)).json().issues, ['PERFORMANCE_POLICY_REQUIRED']);
  assert.equal((await send('POST', `/api/campaigns/${id}/activate`, undefined, managerA)).statusCode, 409);
  const policyPath=`/api/campaigns/${id}/performance-routing`;
  const policy={version:0,lookbackDays:30,minimumSamples:12,responseWeight:70,followUpWeight:30,
    fallbackMethod:'WEIGHTED',reason:'Approve synthetic measured routing policy'};
  assert.equal((await send('GET',policyPath,undefined,managerA)).json().policy,null);
  assert.equal((await send('GET',policyPath,undefined,managerB)).statusCode,403);
  assert.equal((await send('GET',policyPath+'/history',undefined,agent)).statusCode,403);
  assert.equal((await send('PUT',policyPath,policy,managerB)).statusCode,403);
  assert.equal((await send('PUT',policyPath,{...policy,responseWeight:90},managerA)).statusCode,400);
  const approvals=await Promise.all([send('PUT',policyPath,policy,managerA),send('PUT',policyPath,policy,managerA)]);
  assert.deepEqual(approvals.map(result=>result.statusCode).sort(),[200,409]);
  const configuredPolicy=await send('GET',policyPath,undefined,managerA);
  assert.equal(configuredPolicy.json().policy.responseWeight,70);
  assert.equal(configuredPolicy.json().policy.fallbackMethod,'WEIGHTED');
  assert.equal(Object.hasOwn(configuredPolicy.json().policy,'session_id'),false);
  const revision={...policy,version:1,minimumSamples:15,reason:'Increase approved sample size'};
  await db`CREATE FUNCTION test_performance_policy_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='CAMPAIGN_PERFORMANCE_POLICY_SAVED' THEN RAISE EXCEPTION 'Synthetic policy Audit failure'; END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER test_performance_policy_audit_failure BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION test_performance_policy_audit_failure()`;
  try{
    const failed=await send('PUT',policyPath,revision,managerA);
    assert.equal(failed.statusCode,500);
    assert.doesNotMatch(failed.body,/Synthetic policy Audit failure/);
    assert.equal((await send('GET',policyPath,undefined,managerA)).json().policy.version,1);
  }finally{
    await db`DROP TRIGGER test_performance_policy_audit_failure ON audit_log`;
    await db`DROP FUNCTION test_performance_policy_audit_failure()`;
  }
  assert.equal((await send('PUT',policyPath,revision,managerA)).json().version,2);
  const policyHistory=(await send('GET',policyPath+'/history',undefined,managerA)).json().items;
  assert.deepEqual(policyHistory.map((item:{version:number;minimumSamples:number})=>[item.version,item.minimumSamples]),[[2,15],[1,12]]);
  await assert.rejects(db`DELETE FROM campaign_performance_routing_policy_history WHERE campaign_id=${id}`,/PERFORMANCE_POLICY_HISTORY_IMMUTABLE/);
  assert.equal((await send('GET', `/api/campaigns/${id}/readiness`, undefined, managerA)).json().ready, true);
  const readyConfig = await send('PATCH', `/api/campaigns/${id}`, { ...config, version: performance.json().version,
    sourceKind: 'MANUAL', routingMethod: 'WEIGHTED', messagingEnabled: false, aiEnabled: false }, managerA);
  assert.equal(readyConfig.statusCode, 200, readyConfig.body);
  assert.equal((await send('GET', `/api/campaigns/${id}/readiness`, undefined, managerA)).json().ready, true);
  assert.equal((await send('POST', `/api/campaigns/${id}/activate`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('PUT',policyPath,{...revision,version:2},managerA)).statusCode,409);
  assert.equal((await send('PATCH', `/api/campaigns/${id}`, { ...config, version: readyConfig.json().version }, managerA)).statusCode, 409);
  assert.equal((await send('DELETE', `/api/campaigns/${id}/agents/${agentA}`, undefined, managerA)).statusCode, 409);
  assert.equal((await db`SELECT active FROM campaign_agent WHERE campaign_id = ${id} AND agent_id = ${agentA}`)[0]!.active, true);
  const lead = await send('POST', '/api/leads', { branchId: branchA, campaignId: id,
    contact: { name: 'A customer', phone: '+15550009876' } }, managerA);
  assert.equal(lead.statusCode, 201, lead.body);
  assert.equal((await send('POST', `/api/campaigns/${id}/deactivate`, undefined, managerB)).statusCode, 403);
  const deactivated = await send('POST', `/api/campaigns/${id}/deactivate`, undefined, managerA);
  assert.equal(deactivated.statusCode, 200, deactivated.body);
  assert.equal((await send('POST', `/api/campaigns/${id}/deactivate`, undefined, managerA)).json().version, deactivated.json().version);
  assert.equal((await send('POST', '/api/leads', { branchId: branchA, campaignId: id,
    contact: { name: 'B customer', phone: '+15550009877' } }, managerA)).statusCode, 404);
  assert.equal((await send('GET', `/api/leads/${lead.json().id}`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('DELETE', `/api/campaigns/${id}/agents/${agentA}`, undefined, managerA)).statusCode, 200);
  assert.equal((await send('DELETE', `/api/campaigns/${id}/agents/${agentA}`, undefined, managerA)).statusCode, 404);
  assert.equal((await send('POST', `/api/campaigns/${id}/activate`, undefined, managerA)).statusCode, 409);
  const second = await send('POST', '/api/campaigns', { branchId: branchA, name: 'Spring' }, managerA);
  assert.equal(second.statusCode, 201);
  const page = await send('GET', '/api/campaigns?limit=1', undefined, managerA);
  assert.equal(page.json().items.length, 1);
  assert.ok(page.json().nextCursor);
  const nextPage = await send('GET', `/api/campaigns?limit=1&cursor=${encodeURIComponent(page.json().nextCursor)}`, undefined, managerA);
  assert.equal(nextPage.json().items.length, 1);
  assert.notEqual(nextPage.json().items[0].id, page.json().items[0].id);
  const audit = await db`SELECT action FROM audit_log WHERE target_id = ${id} ORDER BY id`;
  assert.deepEqual(audit.map((row) => row.action), [
    'CAMPAIGN_CREATED', 'CAMPAIGN_UPDATED', 'CAMPAIGN_AGENT_SET', 'CAMPAIGN_UPDATED',
    'CAMPAIGN_PERFORMANCE_POLICY_SAVED','CAMPAIGN_PERFORMANCE_POLICY_SAVED','CAMPAIGN_UPDATED',
    'CAMPAIGN_ACTIVATED', 'CAMPAIGN_DEACTIVATED', 'CAMPAIGN_AGENT_REMOVED',
  ]);

  await t.test('actual Lead routing uses human work with campaign isolation, fallback and serialized capacity', async () => {
    const otherAgent = await createUser(branchA, 'AGENT', 'performance-agent@example.test');
    const created = await send('POST', '/api/campaigns', { branchId: branchA, name: 'Measured', routingMethod: 'PERFORMANCE' }, managerA);
    assert.equal(created.statusCode, 201, created.body);
    const campaignId = created.json().id as string;
    const root = '/api/campaigns/' + campaignId;
    for (const agentId of [agentA, otherAgent]) {
      assert.equal((await send('PUT', root + '/agents', { agentId, weight: 2 }, managerA)).statusCode, 200);
    }
    const measuredPolicy = { ...policy, minimumSamples: 1, responseWeight: 60, followUpWeight: 40, fallbackMethod: 'MANUAL' };
    assert.equal((await send('PUT', root + '/performance-routing', measuredPolicy, managerA)).statusCode, 200);
    assert.equal((await send('POST', root + '/activate', undefined, managerA)).statusCode, 200);
    async function intake(label: string) {
      const response = await send('POST', '/api/leads', { branchId: branchA, campaignId,
        contact: { name: label, email: label.replaceAll(' ', '-')+'@example.test' } }, managerA);
      assert.equal(response.statusCode, 201, response.body);
      const leadId = response.json().id as string;
      const origin = (await send('GET', '/api/leads/'+leadId+'/intake-origin', undefined, managerA)).json().origin;
      assert.equal(origin.routing.method, 'PERFORMANCE');
      return { leadId, reason: origin.routing.reason, ownerId: origin.routing.ownerId };
    }
    const fallback = await intake('No Human History');
    assert.equal(fallback.reason, 'INSUFFICIENT_HUMAN_SAMPLE_FALLBACK');
    assert.equal(fallback.ownerId, null);
    assert.equal((await send('GET', '/api/leads/'+fallback.leadId, undefined, managerA)).json().lead.needs_attention_reason, fallback.reason);
    assert.equal((await send('GET', '/api/leads/'+fallback.leadId+'/intake-origin', undefined, managerB)).statusCode, 404);
    await db`CREATE FUNCTION test_drop_performance_decision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='LEAD_PERFORMANCE_ROUTED' THEN RETURN NULL; END IF; RETURN NEW; END $$`;
    await db`CREATE TRIGGER test_drop_performance_decision BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION test_drop_performance_decision()`;
    try {
      const rejected = await send('POST', '/api/leads', { branchId: branchA, campaignId,
        contact: { name: 'Routing proof test', email: 'routing-proof-missing@example.test' } }, managerA);
      assert.equal(rejected.statusCode, 500, rejected.body);
      assert.equal((await db`SELECT id FROM contact WHERE email_normalized='routing-proof-missing@example.test'`).length, 0);
    } finally {
      await db`DROP TRIGGER test_drop_performance_decision ON audit_log`;
      await db`DROP FUNCTION test_drop_performance_decision()`;
    }
    const conn = (await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status)
      VALUES(${organizationId},${branchA},'MESSAGING','META_WHATSAPP_CLOUD','Performance fixture','CONNECTED') RETURNING id`)[0]!.id;
    const sender = (await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name,health,capabilities)
      VALUES(${organizationId},${conn},'performance-fixture','Synthetic','HEALTHY','{"text":true}') RETURNING id`)[0]!.id;
    const historicLead = lead.json().id as string;
    for (const fixtureLead of [fallback.leadId, historicLead]) {
      const cv = (await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,controller_user_id,state)
        VALUES(${fixtureLead},${conn},${sender},'WHATSAPP',${fixtureLead},'HUMAN',${agentA},'HUMAN_ACTIVE') RETURNING id`)[0]!.id;
      // Pre-148 historical fixture. Restore the send guard before running any real intake.
      await db.begin(async tx => {
        await tx`ALTER TABLE conversation_message DISABLE TRIGGER ai_send_message_guard`;
        await tx`INSERT INTO conversation_message(conversation_id,connection_id,sender_id,direction,author_type,body,delivery_state,sent_at)
          VALUES(${cv},${conn},${sender},'OUTBOUND','AI','Automated','SENT',now()-interval '2 hours'+interval '10 seconds')`;
        await tx`ALTER TABLE conversation_message ENABLE TRIGGER ai_send_message_guard`;
      });
      await db`INSERT INTO conversation_message(conversation_id,connection_id,sender_id,direction,author_type,author_user_id,body,
        delivery_state,sent_at,received_at) VALUES
        (${cv},${conn},${sender},'INBOUND','CUSTOMER',NULL,'Question','RECEIVED',NULL,now()-interval '2 hours'),
        (${cv},${conn},${sender},'OUTBOUND','HUMAN',${otherAgent},'Fast reply','SENT',now()-interval '119 minutes',NULL),
        (${cv},${conn},${sender},'OUTBOUND','HUMAN',${otherAgent},'Second reply','SENT',now()-interval '118 minutes',NULL),
        (${cv},${conn},${sender},'OUTBOUND','HUMAN',${agentA},'Late reply','SENT',now()-interval '80 minutes',NULL)`;
      await db`INSERT INTO follow_up(lead_id,owner_user_id,due_at,created_by,status,completed_by,completed_at) VALUES
        (${fixtureLead},${agentA},now()-interval '1 hour',${agentA},'OPEN',NULL,NULL),
        (${fixtureLead},${otherAgent},now()-interval '1 hour',${otherAgent},'COMPLETED',${otherAgent},now()-interval '61 minutes'),
        (${fixtureLead},${otherAgent},now()-interval '1 hour',${otherAgent},'COMPLETED',${agentA},now()-interval '61 minutes')`;
    }
    assert.equal((await send('PUT', root+'/agents', { agentId: otherAgent, capacityOverride: 1 }, managerA)).statusCode, 200);
    const simultaneous = await Promise.all([intake('First Measured Intake'), intake('Second Measured Intake')]);
    assert.deepEqual(new Set(simultaneous.map(result => result.ownerId)), new Set([otherAgent, agentA]));
    assert.ok(simultaneous.every(result => result.reason==='HUMAN_PERFORMANCE'));
    const winner = simultaneous.find(result => result.ownerId===otherAgent)!;
    const [proof] = await db`SELECT detail FROM audit_log WHERE action='LEAD_PERFORMANCE_ROUTED' AND target_id=${winner.leadId}`;
    assert.equal(proof!.detail.performance.policyVersion, 1);
    assert.deepEqual(proof!.detail.performance.sample, { id: otherAgent, replies: 1, responseSeconds: 60, followUps: 1, onTime: 1 });
    assert.equal((await send('PUT', root+'/agents', { agentId: agentA, capacityOverride: 0 }, managerA)).statusCode, 200);
    assert.equal((await db`SELECT capacity_override FROM campaign_agent WHERE campaign_id=${campaignId} AND agent_id=${agentA}`)[0]!.capacity_override, 0);
    const capacity = await intake('Beyond Available Capacity');
    assert.equal(capacity.ownerId, null);
    assert.equal(capacity.reason, 'NO_ELIGIBLE_AGENT');
    assert.equal((await send('PUT', root+'/agents', { agentId: agentA, capacityOverride: null }, managerA)).statusCode, 200);
    assert.equal((await db`SELECT capacity_override FROM campaign_agent WHERE campaign_id=${campaignId} AND agent_id=${agentA}`)[0]!.capacity_override, null);
  });
});
