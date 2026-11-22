import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw Error('Isolated TEST_DATABASE_URL required');

test('A Super Admin transfers a lead once with current branch access, private field history, open task ownership and atomic audit', async t => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  const db = createDatabase(url), app = await buildApp(db, { logger: false });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async tx => {
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`;
    await tx`TRUNCATE organization CASCADE`;
  });
  const [org, foreignOrg] = await db`INSERT INTO organization(name) VALUES('Transfer test'),('Foreign tenant') RETURNING id`;
  const [source, target, foreignBranch] = await db`INSERT INTO branch(organization_id,name)
   VALUES(${org!.id},'Source'),(${org!.id},'Destination'),(${foreignOrg!.id},'Foreign') RETURNING id`;
  const [original, destination, foreignCampaign] = await db`INSERT INTO campaign(organization_id,branch_id,name,status)
   VALUES(${org!.id},${source!.id},'Original campaign','ACTIVE'),(${org!.id},${target!.id},'Destination campaign','ACTIVE'),
   (${foreignOrg!.id},${foreignBranch!.id},'Foreign campaign','ACTIVE') RETURNING id`;
  async function session(role: string, organizationId: string, branchId: string | null) {
    const [user] = await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
      VALUES(${organizationId},${branchId},${role},${role},${randomUUID()+'@transfer.test'},'fixture') RETURNING id`;
    const token = randomBytes(32).toString('hex');
    const [s] = await db`INSERT INTO user_session(user_id,token_hash,expires_at)
      VALUES(${user!.id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`;
    return { id: user!.id, cookie: 'lop_session='+token, session: s!.id };
  }
  const admin = await session('SUPER_ADMIN', org!.id, null);
  const fromManager = await session('MANAGER', org!.id, source!.id);
  const toManager = await session('MANAGER', org!.id, target!.id);
  const fromAgent = await session('AGENT', org!.id, source!.id);
  const toAgent = await session('AGENT', org!.id, target!.id);
  const foreign = await session('SUPER_ADMIN', foreignOrg!.id, null);
  const api = (method: 'GET'|'POST'|'PUT', path: string, payload?: object, actor = admin) => app.inject({
    method, url: path, payload, headers: { cookie: actor.cookie, origin: process.env.APP_ORIGIN! },
  });
  async function createLead() {
    const result = await api('POST', '/api/leads', { branchId: source!.id, campaignId: original!.id,
      contact: { name: 'Synthetic Lead', email: randomUUID()+'@transfer.test' } });
    assert.equal(result.statusCode, 201, result.body);
    return '/api/leads/'+result.json().id;
  }

  const root = await createLead();
  const id = root.split('/').at(-1)!;
  const created = (await api('GET', root)).json().lead;
  assert.equal((await api('POST', root+'/assignment', {version: created.version, agentId: fromAgent.id})).statusCode, 200);
  const [field] = await db`INSERT INTO field_definition(organization_id,branch_id,campaign_id,key,label,field_type)
   VALUES(${org!.id},${source!.id},${original!.id},'source_private','Source-only field','TEXT') RETURNING id`;
  await db`INSERT INTO campaign_field(campaign_id,field_id) VALUES(${original!.id},${field!.id})`;
  assert.equal((await api('PUT', root+'/fields/'+field!.id, {value: 'Original field value'})).statusCode, 200);
  assert.equal((await api('POST', root+'/notes', {text: 'Lead context for the next owner'}, fromAgent)).statusCode, 201);
  const [open, completed] = await db`INSERT INTO follow_up(lead_id,owner_user_id,due_at,status)
   VALUES(${id},${fromAgent.id},now()+interval '1 day','OPEN'),(${id},${fromAgent.id},now(),'COMPLETED') RETURNING id`;
  assert.ok((await api('GET', root+'/intake-origin', undefined, fromAgent)).json().origin);
  const version = (await api('GET', root)).json().lead.version;
  const path = root+'/branch-transfers';
  const payload = { version, branchId: target!.id, campaignId: destination!.id, agentId: toAgent.id, reason: 'Authorized move' };
  assert.equal((await api('POST', path, payload, fromManager)).statusCode, 403);
  assert.equal((await api('POST', path, payload, fromAgent)).statusCode, 403);
  assert.equal((await api('POST', path, payload, foreign)).statusCode, 404);
  assert.equal((await api('POST', path, { ...payload, branchId: foreignBranch!.id, campaignId: foreignCampaign!.id })).statusCode, 400);
  assert.equal((await api('POST', path, { ...payload, agentId: fromAgent.id })).statusCode, 400);
  await assert.rejects(db`UPDATE lead SET branch_id=${target!.id},campaign_id=${destination!.id},
   version=version+1,assigned_agent_id=${toAgent.id} WHERE id=${id}`, /LEAD_TRANSFER_PROOF_REQUIRED/);
  await assert.rejects(db`INSERT INTO lead_branch_transfer(lead_id,source_version,organization_id,destination_branch_id,
   destination_campaign_id,destination_agent_id,actor_id,session_id,reason) VALUES(${id},${version},${org!.id},${target!.id},
   ${destination!.id},${toAgent.id},${admin.id},${fromManager.session},'Wrong native session')`, /LEAD_TRANSFER_ACCESS_REVOKED/);
  await assert.rejects(db.begin(async tx => {
    await tx`CREATE FUNCTION test_transfer_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='LEAD_BRANCH_TRANSFERRED' THEN RAISE EXCEPTION 'SIMULATED_TRANSFER_AUDIT_FAILURE'; END IF; RETURN NEW;
      END $$`;
    await tx`CREATE TRIGGER test_transfer_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_transfer_audit_failure()`;
    await tx`INSERT INTO lead_branch_transfer(lead_id,source_version,organization_id,destination_branch_id,
      destination_campaign_id,destination_agent_id,actor_id,session_id,reason) VALUES(${id},${version},${org!.id},${target!.id},
      ${destination!.id},${toAgent.id},${admin.id},${admin.session},'Test atomic rollback')`;
  }), /SIMULATED_TRANSFER_AUDIT_FAILURE/);
  assert.equal((await api('GET', root)).json().lead.branch_id, source!.id);
  assert.equal((await api('GET', path)).json().items.length, 0);

  const raced = await Promise.all(Array.from({length: 4}, () => api('POST', path, payload)));
  assert.deepEqual(raced.map(result => result.statusCode).sort(), [200,409,409,409], raced.map(result => result.body).join('\n'));
  assert.equal((await api('GET', root, undefined, fromManager)).statusCode, 404);
  assert.equal((await api('GET', root+'/assignments', undefined, fromAgent)).statusCode, 404);
  assert.equal((await api('GET', path, undefined, toManager)).statusCode, 403);
  const currentDetail = (await api('GET', root, undefined, toAgent)).json();
  const current = currentDetail.lead;
  assert.equal(current.branch_id, target!.id);
  assert.equal(current.campaign_id, destination!.id);
  assert.equal(current.assigned_agent_id, toAgent.id);
  assert.equal(current.contact_id, created.contact_id);
  assert.equal(current.version, version+1);
  assert.equal((await api('GET', root+'/intake-origin', undefined, toManager)).json().origin, null);
  assert.ok((await api('GET', root+'/intake-origin')).json().origin);
  assert.equal((await api('GET', root+'/fields/'+field!.id+'/history', undefined, toAgent)).statusCode, 404);
  for (const items of [currentDetail.activities, (await api('GET', root+'/activity', undefined, toAgent)).json().items]) {
    assert.deepEqual(items.find((entry: {event_type: string}) => entry.event_type==='FIELD_VALUE_CHANGED').detail, {});
    assert.equal(items.find((entry: {event_type: string}) => entry.event_type==='NOTE_ADDED').detail.text, 'Lead context for the next owner');
  }
  assert.equal((await db`SELECT value FROM lead_field_value WHERE lead_id=${id} AND field_id=${field!.id}`)[0]!.value, 'Original field value');
  const assignment = (await api('GET', root+'/assignments', undefined, toManager)).json().items[0];
  assert.equal(assignment.old_agent_id, null);
  assert.equal(assignment.new_agent_id, toAgent.id);
  const tasks = await db`SELECT id,owner_user_id FROM follow_up WHERE lead_id=${id}`;
  assert.equal(tasks.find(task => task.id===open!.id)!.owner_user_id, toAgent.id);
  assert.equal(tasks.find(task => task.id===completed!.id)!.owner_user_id, fromAgent.id);
  assert.equal((await db`SELECT count(*)::int AS n FROM follow_up_history WHERE follow_up_id=${open!.id}
    AND event_type='OWNER_CHANGED_BY_REASSIGNMENT'`)[0]!.n, 1);
  assert.equal((await api('GET', path)).json().items[0].sourceCampaign, 'Original campaign');
  assert.equal((await db`SELECT count(*)::int AS n FROM audit_log WHERE target_id=${id} AND action='LEAD_BRANCH_TRANSFERRED'`)[0]!.n, 2);
  await assert.rejects(db`DELETE FROM lead_branch_transfer WHERE lead_id=${id}`, /LEAD_TRANSFER_HISTORY_IMMUTABLE/);

  const pinnedRoot = await createLead();
  const pinned = (await api('GET', pinnedRoot)).json().lead;
  const [connection] = await db`INSERT INTO integration_connection(organization_id,branch_id,kind,provider,name,status)
   VALUES(${org!.id},${source!.id},'MESSAGING','META_WHATSAPP_CLOUD','Synthetic transfer fixture','CONNECTED') RETURNING id`;
  const [sender] = await db`INSERT INTO messaging_sender(organization_id,connection_id,external_sender_id,display_name)
   VALUES(${org!.id},${connection!.id},'15550000002','Original pinned sender') RETURNING id`;
  await db`INSERT INTO conversation(lead_id,connection_id,sender_id,channel,participant_ref,controller_type,state)
    VALUES(${pinned.id},${connection!.id},${sender!.id},'WHATSAPP','+15550000003','NONE','WAITING_FOR_HUMAN')`;
  const blocked = await api('POST', pinnedRoot+'/branch-transfers', {...payload,version:pinned.version});
  assert.equal(blocked.statusCode,409,blocked.body);
  assert.equal(blocked.json().error,'LEAD_TRANSFER_CONVERSATION_REVIEW');
  assert.equal((await api('GET', pinnedRoot)).json().lead.branch_id, source!.id);
});
