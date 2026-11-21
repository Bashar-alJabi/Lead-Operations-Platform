import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { sha256 } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');

test('Audit listing exposes only scoped safe event metadata with bounded stable pages and current roles and sessions', async t => {
  const db = createDatabase(url), app = await buildApp(db, { logger: false });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async tx => {
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE background_job CASCADE`;
    await tx`TRUNCATE organization CASCADE`;
  });
  const [organization] = await db`INSERT INTO organization(name) VALUES('Audit fixtures') RETURNING id`;
  const [foreignOrganization] = await db`INSERT INTO organization(name) VALUES('Foreign audit fixtures') RETURNING id`;
  const org = organization!.id, foreignOrg = foreignOrganization!.id;
  const addBranch = async (organizationId: string, name: string) =>
    (await db`INSERT INTO branch(organization_id,name) VALUES(${organizationId},${name}) RETURNING id`)[0]!.id as string;
  const branch = await addBranch(org, 'Audit Branch'), other = await addBranch(org, 'Other Audit Branch');
  const foreign = await addBranch(foreignOrg, 'Foreign Audit Branch');

  async function newUser(name: string, role: string, branchId: string | null, organizationId = org) {
    const [user] = await db`INSERT INTO user_account(organization_id,branch_id,role,name,email,password_hash)
      VALUES(${organizationId},${branchId},${role},${name},${randomUUID()+'@audit.test'},'fixture') RETURNING id`;
    const token = randomBytes(32).toString('hex');
    const [session] = await db`INSERT INTO user_session(user_id,token_hash,expires_at)
      VALUES(${user!.id},${sha256(token)},clock_timestamp()+interval '1 hour') RETURNING id`;
    return { id: user!.id as string, session: session!.id as string, cookie: 'lop_session=' + token };
  }
  const admin = await newUser('Audit administrator', 'SUPER_ADMIN', null);
  const manager = await newUser('Audit manager', 'MANAGER', branch);
  const otherManager = await newUser('Other audit manager', 'MANAGER', other);
  const assignee = await newUser('Audit agent', 'AGENT', branch);
  const foreignAdmin = await newUser('Foreign audit administrator', 'SUPER_ADMIN', null, foreignOrg);
  const target = randomUUID(), foreignTarget = randomUUID();
  async function write(organizationId: string, branchId: string | null, actorId: string | null,
    action: string, targetId: string, when: string, detail: Record<string, string>) {
    const [row] = await db`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,created_at,detail)
      VALUES(${organizationId},${branchId},${actorId},${action},'LEAD',${targetId},${when}::timestamptz,${db.json(detail)})
      RETURNING id::text AS id`;
    return row!.id as string;
  }
  const day = '2026-01-08T23:59:59.999999Z';
  const first = await write(org, branch, manager.id, 'LEAD_LIFECYCLE_CHANGED', target, day,
    { from: 'OPEN', to: 'CLOSED', secret: 'Private lifecycle text' });
  const second = await write(org, branch, null, 'LEAD_LIFECYCLE_CHANGED', target, day,
    { from: 'OPEN', to: 'Untrusted transition', secret: 'Private invalid transition' });
  const third = await write(org, branch, admin.id, 'LEAD_REASSIGNED', 'legacy-private-value', '2026-01-09T00:00:00Z',
    { reason: 'Private contact note' });
  const otherId = await write(org, other, otherManager.id, 'LEAD_LIFECYCLE_CHANGED', target, day, { from: 'OPEN', to: 'ARCHIVED' });
  const globalId = await write(org, null, admin.id, 'ORGANIZATION_CHANGED', target, day, {});
  const foreignId = await write(foreignOrg, foreign, foreignAdmin.id, 'LEAD_LIFECYCLE_CHANGED', foreignTarget, day, {});
  const root = '/api/audit-events';
  const read = (query = '', who = manager) => app.inject({ method: 'GET', url: root + query, headers: { cookie: who.cookie } });
  const page = await read('?limit=2');
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.deepEqual(page.json().items.map((item: { id: string }) => item.id), [third, second]);
  assert.equal(page.json().nextBefore, second);
  assert.equal(page.json().items[0].targetId, null);
  assert.equal(page.json().items[0].actorId, null);
  assert.equal(page.json().items[0].systemActor, false);
  assert.equal(page.json().items[1].systemActor, true);
  assert.equal(page.json().items[1].lifecycleChange, null);
  assert.match(page.json().items[1].createdAt, /^2026-01-08T/);
  assert.ok(!page.body.includes('legacy-private-value'));
  assert.ok(!page.body.includes('Private'));
  assert.ok(!page.body.includes(admin.id));
  const tail = (await read('?before=' + second)).json();
  assert.deepEqual(tail.items.map((item: { id: string }) => item.id), [first]);
  assert.deepEqual(tail.items[0].lifecycleChange, { from: 'OPEN', to: 'CLOSED' });
  assert.equal(tail.items[0].actorId, manager.id);
  assert.equal(tail.nextBefore, null);
  assert.deepEqual((await read('?through=2026-01-08&from=2026-01-08&targetId='+target+'&action=LEAD_LIFECYCLE_CHANGED')).json()
    .items.map((item: { id: string }) => item.id), [second, first]);
  assert.deepEqual((await read('?actorId='+manager.id)).json().items.map((item: { id: string }) => item.id), [first]);
  assert.equal((await read('?actorId='+admin.id)).json().items.length, 0);
  assert.deepEqual((await read('', admin)).json().items.map((item: { id: string }) => item.id), [globalId, otherId, third, second, first]);
  assert.deepEqual((await read('?branchId='+other, admin)).json().items.map((item: { id: string }) => item.id), [otherId]);
  assert.deepEqual((await read('', foreignAdmin)).json().items.map((item: { id: string }) => item.id), [foreignId]);
  assert.equal((await read('?branchId='+foreign, admin)).statusCode, 404);
  assert.equal((await read('?branchId='+other)).statusCode, 404);
  assert.equal((await read('', assignee)).statusCode, 403);
  assert.equal((await read('?targetId='+foreignTarget)).json().items.length, 0);
  for (const query of ['?limit=51','?before=9223372036854775808','?action=not-a-code','?from=2026-01-09&through=2026-01-08']) {
    assert.equal((await read(query)).statusCode, 400);
  }
  await db`UPDATE user_account SET branch_id=${other} WHERE id=${manager.id}`;
  assert.deepEqual((await read()).json().items.map((item: { id: string }) => item.id), [otherId]);
  await db`UPDATE user_session SET revoked_at=clock_timestamp() WHERE id=${manager.session}`;
  assert.equal((await read()).statusCode, 401);
});
