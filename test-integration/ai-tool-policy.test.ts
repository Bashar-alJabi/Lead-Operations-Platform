import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/security.js';
import { aiCustomerTools } from '../src/ai/tool-policy.js';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('Approved customer tool configuration enforces native current scope/session/CAS, isolated effective traces, retained history and atomic Audit without action authority', async t => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173'; const db = createDatabase(url), app = await buildApp(db, { logger: false, globalRateLimitMax: 10000 }); t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async tx => { await tx`SET LOCAL client_min_messages TO warning`; await tx`TRUNCATE background_job CASCADE`; await tx`TRUNCATE organization CASCADE`; });
  const org = (await db`INSERT INTO organization(name) VALUES('Tool policy') RETURNING id`)[0]!.id, foreignOrg = (await db`INSERT INTO organization(name) VALUES('Foreign') RETURNING id`)[0]!.id;
  const branch = (await db`INSERT INTO branch(organization_id,name) VALUES(${org},'A') RETURNING id`)[0]!.id, otherBranch = (await db`INSERT INTO branch(organization_id,name) VALUES(${org},'B') RETURNING id`)[0]!.id;
  const campaign = (await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES(${org},${branch},'A') RETURNING id`)[0]!.id, campaignB = (await db`INSERT INTO campaign(organization_id,branch_id,name) VALUES(${org},${branch},'B') RETURNING id`)[0]!.id;
  const users: Record<string, { id: string; session: string; cookie: string }> = {};
  for (const [name, role, b, o] of [['manager','MANAGER',branch,org],['agent','AGENT',branch,org],['other','MANAGER',otherBranch,org],['admin','SUPER_ADMIN',null,org],['foreign','SUPER_ADMIN',null,foreignOrg]] as const) {
    const id = (await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash) VALUES(${o},${b},${role},${name},${name + '@tools.test'},'synthetic-only') RETURNING id`)[0]!.id, token = randomBytes(32).toString('hex');
    const session = (await db`INSERT INTO user_session(user_id,token_hash,created_at,expires_at) VALUES(${id},${sha256(token)},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour') RETURNING id`)[0]!.id; users[name] = { id, session, cookie: 'lop_session=' + token };
  }
  const root = '/api/ai/campaigns/' + campaign + '/tool-policy', defaults = '/api/ai/branches/' + branch + '/tool-defaults', effective = '/api/ai/campaigns/' + campaign + '/effective-configuration';
  const api = (method: 'GET' | 'PUT', path: string, payload?: object, actor = 'manager') => app.inject({ method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, cookie: users[actor]!.cookie } });
  const put = (version: number, allowedTools: string[] | null, path = root, actor = 'manager') => api('PUT', path, { version, definition: { allowedTools }, reason: 'Explicit scoped tool approval <img literal>' }, actor);
  const initial = (await api('GET', effective)).json(); assert.deepEqual(initial.allowedTools, []); assert.equal(initial.toolPolicy.source, 'UNCONFIGURED');
  const catalog = (await api('GET', root)).json(); assert.equal(catalog.version, 0); assert.deepEqual(catalog.definition, { allowedTools: null }); assert.deepEqual(catalog.catalog.map((c: { name: string }) => c.name), aiCustomerTools); assert.equal(catalog.runtimeAuthorized, false); assert.equal(catalog.liveTransferEnabled, false);
  for (const actor of ['agent','other','foreign']) for (const path of [root, defaults, root + '/history', root + '/versions/1', effective]) assert.equal((await api('GET', path, undefined, actor)).statusCode, actor === 'agent' ? 403 : 404);
  for (const actor of ['agent','other','foreign']) assert.equal((await put(0, ['requestHumanHandoff'], root, actor)).statusCode, actor === 'agent' ? 403 : 404);
  for (const definition of [null, [], {}, { allowedTools: false }, { allowedTools: ['SQL'] }, { allowedTools: ['confirmPayment'] }, { allowedTools: ['enrollLead'] }, { allowedTools: ['grantPermission'] }, { allowedTools: [null] }, { allowedTools: ['getLeadContext','getLeadContext'] }, { allowedTools: [], noSecrets: false }]) {
    assert.equal((await api('PUT', root, { version: 0, definition, reason: 'Invalid tools denied' })).statusCode, 400, JSON.stringify(definition));
    assert.equal((await db`SELECT ai_tool_policy_valid(${db.json(definition)}) AS valid`)[0]!.valid, false);
  }
  assert.equal((await db`SELECT ai_tool_policy_valid(NULL) AS valid`)[0]!.valid, false);
  assert.equal((await db`SELECT ai_effective_tool_policy(${otherBranch},${campaign}) AS policy`)[0]!.policy, null);
  const approved = ['updateQualificationField','getCampaignKnowledge','requestHumanHandoff'];
  const raced = await Promise.all(Array.from({ length: 8 }, () => put(0, approved, defaults))); assert.deepEqual(raced.map(r => r.statusCode).sort(), [200,409,409,409,409,409,409,409]);
  const inherited = (await api('GET', effective)).json(); assert.notEqual(inherited.hash, initial.hash); assert.equal(inherited.toolPolicy.source, 'BRANCH'); assert.deepEqual(inherited.allowedTools, [...approved].sort()); assert.equal(inherited.toolPolicy.branchVersion, 1); assert.equal(inherited.assistantReady, false); assert.ok(inherited.blockers.includes('AI_APPROVED_TOOLS_NOT_IMPLEMENTED'));
  assert.equal((await db`SELECT ai_tool_context_current(${db.json(inherited)},${branch},${campaign}) AS current`)[0]!.current, true);
  assert.equal((await db`SELECT ai_tool_context_current(${db.json({ ...inherited, allowedTools: ['SQL'] })},${branch},${campaign}) AS current`)[0]!.current, false);
  const all = [...aiCustomerTools].reverse(); assert.equal((await put(0, all)).statusCode, 200);
  const overridden = (await api('GET', effective)).json(); assert.equal(overridden.toolPolicy.source, 'CAMPAIGN'); assert.deepEqual(overridden.allowedTools, aiCustomerTools); assert.notEqual(overridden.hash, inherited.hash);
  assert.deepEqual((await api('GET', '/api/ai/campaigns/' + campaignB + '/effective-configuration')).json().allowedTools, [...approved].sort());
  assert.equal((await put(1, [])).statusCode, 200); const cleared = (await api('GET', effective)).json(); assert.deepEqual(cleared.allowedTools, []); assert.equal(cleared.toolPolicy.source, 'CAMPAIGN');
  assert.equal((await put(2, ['getLeadContext'], defaults)).statusCode, 409);
  assert.equal((await put(1, ['getLeadContext'], defaults)).statusCode, 200); const branchChanged = (await api('GET', effective)).json(); assert.deepEqual(branchChanged.allowedTools, []); assert.notEqual(branchChanged.hash, cleared.hash);
  assert.equal((await db`SELECT ai_tool_context_current(${db.json(cleared)},${branch},${campaign}) AS current`)[0]!.current, false);
  assert.equal((await put(2, null)).statusCode, 200); const reset = (await api('GET', effective)).json(); assert.deepEqual(reset.allowedTools, ['getLeadContext']); assert.equal(reset.toolPolicy.source, 'BRANCH'); assert.equal(reset.globalGuardrails.noSecrets, true); assert.equal(reset.globalGuardrails.trustedPaymentConfirmationOnly, true);
  const history = (await api('GET', root + '/history?limit=1')).json(); assert.equal(history.items.length, 1); assert.equal(history.nextVersion, 3); assert.equal((await api('GET', root + '/history?before=3&limit=1')).json().items[0].version, 2);
  const original = (await api('GET', root + '/versions/1')).json(); assert.deepEqual(original.definition.allowedTools, aiCustomerTools); assert.match(original.reason, /<img literal>/); assert.equal((await api('GET', root + '/versions/9')).statusCode, 404); assert.equal((await api('GET', root + '/history?limit=101')).statusCode, 400);
  await assert.rejects(db`UPDATE ai_tool_policy_history SET snapshot='{}' WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /HISTORY_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM ai_tool_policy_history WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /HISTORY_IMMUTABLE/);
  await assert.rejects(db`INSERT INTO ai_tool_policy_history(scope,resource_id,version,snapshot) VALUES('CAMPAIGN',${campaign},4,'{}')`, /HISTORY_IMMUTABLE/);
  await assert.rejects(db`DELETE FROM ai_tool_policy WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /HISTORY_RETAINED/);
  await assert.rejects(db`UPDATE ai_tool_policy SET version=version+2 WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /VERSION_REQUIRED/);
  await assert.rejects(db`UPDATE ai_tool_policy SET version=version+1,campaign_id=${campaignB},resource_id=${campaignB} WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /VERSION_REQUIRED/);
  await assert.rejects(db`UPDATE ai_tool_policy SET version=version+1,definition='{"allowedTools":["confirmPayment"]}' WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /AI_TOOL_POLICY_INVALID/);
  for (const actor of ['agent','other','foreign']) await assert.rejects(db`UPDATE ai_tool_policy SET version=version+1,actor_id=${users[actor]!.id},session_id=${users[actor]!.session} WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /CURRENT_ACCESS_REQUIRED/);
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${users.manager!.session}`;
  assert.equal((await put(3, [])).statusCode, 401); await assert.rejects(db`UPDATE ai_tool_policy SET version=version+1 WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /CURRENT_ACCESS_REQUIRED/);
  await db`UPDATE user_session SET revoked_at=NULL,expires_at=clock_timestamp()-interval '1 second' WHERE id=${users.manager!.session}`;
  await assert.rejects(db`UPDATE ai_tool_policy SET version=version+1 WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /CURRENT_ACCESS_REQUIRED/);
  await db`UPDATE user_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=${users.manager!.session}`;
  await db`UPDATE user_account SET active=false WHERE id=${users.manager!.id}`; assert.equal((await put(3, [])).statusCode, 401); await assert.rejects(db`UPDATE ai_tool_policy SET version=version+1 WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /CURRENT_ACCESS_REQUIRED/); await db`UPDATE user_account SET active=true WHERE id=${users.manager!.id}`;
  await db`UPDATE branch SET active=false WHERE id=${branch}`; assert.equal((await put(3, [])).statusCode, 409); await assert.rejects(db`UPDATE ai_tool_policy SET version=version+1 WHERE scope='CAMPAIGN' AND resource_id=${campaign}`, /CURRENT_ACCESS_REQUIRED/); await db`UPDATE branch SET active=true WHERE id=${branch}`;
  await db`CREATE FUNCTION reject_tool_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='AI_TOOL_POLICY_CONFIGURED' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE';END IF;RETURN NEW;END $$`;
  await db`CREATE TRIGGER reject_tool_policy_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_tool_policy_audit()`;
  try { const failed = await put(3, []); assert.equal(failed.statusCode, 500); assert.equal((await api('GET', root)).json().version, 3); assert.equal((await db`SELECT count(*)::integer AS n FROM ai_tool_policy_history WHERE scope='CAMPAIGN' AND resource_id=${campaign}`)[0]!.n, 3); } finally { await db`DROP TRIGGER reject_tool_policy_audit ON audit_log`; await db`DROP FUNCTION reject_tool_policy_audit()`; }
  assert.equal((await put(3, ['requestHumanHandoff'], root, 'admin')).statusCode, 200); const audit = await db`SELECT detail,actor_user_id FROM audit_log WHERE action='AI_TOOL_POLICY_CONFIGURED' ORDER BY created_at`; assert.equal(audit.length, 6); assert.equal(audit.at(-1)!.actor_user_id, users.admin!.id); assert.deepEqual(audit.at(-1)!.detail.allowedTools, ['requestHumanHandoff']);
  assert.equal((await db`SELECT count(*)::integer AS n FROM ai_customer_proposal`)[0]!.n, 0); assert.equal((await db`SELECT count(*)::integer AS n FROM payment_record`)[0]!.n, 0); assert.equal((await db`SELECT count(*)::integer AS n FROM enrollment`)[0]!.n, 0);
});
