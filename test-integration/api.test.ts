import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { passwordHash, sha256 } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
const databaseName = url ? new URL(url).pathname.slice(1) : '';
if (!url || databaseName !== 'lead_operations_test') {
  throw new Error('TEST_DATABASE_URL must target the isolated lead_operations_test database');
}

test('PostgreSQL API: bootstrap, isolation, sessions, and concurrent routing', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  const db = createDatabase(url);
  const app = await buildApp(db, { logger: false });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => {
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE organization CASCADE`;
  });

  const send = async (method: 'GET'|'POST'|'PUT'|'PATCH', path: string, payload?: Record<string, unknown>, cookie?: string) => await app.inject({
    method, url: path, payload,
    headers: { origin: process.env.APP_ORIGIN!, ...(cookie ? { cookie } : {}) },
  });
  const login = async (email: string, password: string) => {
    const response = await send('POST', '/api/auth/login', { email, password });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.headers['set-cookie'];
    assert.ok(cookie);
    return (Array.isArray(cookie) ? cookie[0]! : cookie).split(';')[0]!;
  };
  const createUser = async (_adminCookie: string, branchId: string, role: 'MANAGER'|'AGENT', name: string, email: string, capacity?: number) => {
    const organizationId = (await db`SELECT id FROM organization LIMIT 1`)[0]!.id;
    const hashed = await passwordHash('Test password 12345!');
    const rows = await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash, capacity)
      VALUES (${organizationId}, ${branchId}, ${role}, ${name}, ${email}, ${hashed}, ${capacity ?? null}) RETURNING id`;
    return rows[0]!.id as string;
  };

  assert.deepEqual((await send('GET', '/api/setup/status')).json(), { initialized: false });
  const deniedBootstrap = await send('POST', '/api/setup/bootstrap', {
    token: 'wrong-token-long-enough-for-schema', organizationName: 'Test Org', name: 'Owner', email: 'owner@example.test', password: 'Test password 12345!',
  });
  assert.equal(deniedBootstrap.statusCode, 403);
  const bootstrapPayload = {
    token: process.env.BOOTSTRAP_TOKEN, organizationName: 'Test Org', name: 'Owner', email: 'owner@example.test', password: 'Test password 12345!',
  };
  const competingBootstrap = await Promise.all([
    send('POST', '/api/setup/bootstrap', bootstrapPayload),
    send('POST', '/api/setup/bootstrap', bootstrapPayload),
  ]);
  assert.deepEqual(competingBootstrap.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal((await db`SELECT count(*)::integer AS count FROM organization`)[0]!.count, 1);
  assert.deepEqual((await send('GET', '/api/setup/status')).json(), { initialized: true });
  assert.equal((await send('POST', '/api/setup/bootstrap', {
    token: process.env.BOOTSTRAP_TOKEN, organizationName: 'Another', name: 'Owner', email: 'other@example.test', password: 'Test password 12345!',
  })).statusCode, 409);
  assert.equal((await send('POST', '/api/auth/login', { email: 'owner@example.test', password: 'wrong password' })).statusCode, 401);
  const admin = await login('owner@example.test', 'Test password 12345!');
  const wrongOrigin = await app.inject({ method: 'POST', url: '/api/branches', payload: { name: 'Denied', timezone: 'UTC' }, headers: { origin: 'https://evil.example', cookie: admin } });
  assert.equal(wrongOrigin.statusCode, 403);
  assert.equal((await send('GET', '/api/auth/me')).statusCode, 401);

  const branchAResponse = await send('POST', '/api/branches', { name: 'A', timezone: 'UTC' }, admin);
  const branchBResponse = await send('POST', '/api/branches', { name: 'B', timezone: 'UTC' }, admin);
  assert.equal(branchAResponse.statusCode, 201, branchAResponse.body);
  assert.equal(branchBResponse.statusCode, 201, branchBResponse.body);
  const branchA = branchAResponse.json().id as string;
  const branchB = branchBResponse.json().id as string;
  await createUser(admin, branchA, 'MANAGER', 'Manager A', 'manager-a@example.test');
  await createUser(admin, branchB, 'MANAGER', 'Manager B', 'manager-b@example.test');
  const agentA1 = await createUser(admin, branchA, 'AGENT', 'Agent A1', 'agent-a1@example.test', 1);
  const agentA2 = await createUser(admin, branchA, 'AGENT', 'Agent A2', 'agent-a2@example.test', 1);
  const managerA = await login('manager-a@example.test', 'Test password 12345!');
  const managerB = await login('manager-b@example.test', 'Test password 12345!');
  const agent1 = await login('agent-a1@example.test', 'Test password 12345!');
  const agent2 = await login('agent-a2@example.test', 'Test password 12345!');
  assert.equal((await send('POST', '/api/campaigns', { branchId: branchB, name: 'Denied' }, managerA)).statusCode, 403);

  const campaignResponse = await send('POST', '/api/campaigns', { branchId: branchA, name: 'Campaign A', routingMethod: 'ROUND_ROBIN' }, managerA);
  assert.equal(campaignResponse.statusCode, 201, campaignResponse.body);
  const campaignId = campaignResponse.json().id as string;
  assert.equal((await send('POST', `/api/campaigns/${campaignId}/activate`, undefined, managerA)).statusCode, 409);
  for (const agentId of [agentA1, agentA2]) {
    const bound = await send('PUT', `/api/campaigns/${campaignId}/agents`, { agentId }, managerA);
    assert.equal(bound.statusCode, 200, bound.body);
  }
  assert.equal((await send('PUT', `/api/campaigns/${campaignId}/agents`, { agentId: agentA1 }, managerB)).statusCode, 403);
  const campaignsA = await send('GET', '/api/campaigns', undefined, managerA);
  assert.equal(campaignsA.statusCode, 200, campaignsA.body);
  assert.deepEqual(new Set(campaignsA.json().items[0].agents.map((agent: { agentId: string }) => agent.agentId)), new Set([agentA1, agentA2]));
  assert.deepEqual((await send('GET', '/api/campaigns', undefined, managerB)).json().items, []);
  assert.equal((await send('POST', `/api/campaigns/${campaignId}/activate`, undefined, managerA)).statusCode, 200);

  const intakes = await Promise.all([1, 2, 3].map((n) => send('POST', '/api/leads', {
    branchId: branchA, campaignId, contact: { name: `Contact ${n}`, phone: `+1555000000${n}` },
  }, managerA)));
  for (const result of intakes) assert.equal(result.statusCode, 201, result.body);
  const leadIds = intakes.map((result) => result.json().id as string);
  const assigned = await db`SELECT id, assigned_agent_id, needs_attention_reason FROM lead WHERE id IN ${db(leadIds)}`;
  assert.deepEqual(new Set(assigned.map((row) => row.assigned_agent_id).filter(Boolean)), new Set([agentA1, agentA2]));
  assert.equal(assigned.filter((row) => row.needs_attention_reason === 'NO_ELIGIBLE_AGENT').length, 1);
  const firstAssigned = assigned.find((row) => row.assigned_agent_id === agentA1)!;
  const unrelatedCampaign = await send('POST', '/api/campaigns', { branchId: branchA, name: 'Unrelated' }, managerA);
  assert.equal(unrelatedCampaign.statusCode, 201, unrelatedCampaign.body);
  const agentCampaigns = await send('GET', '/api/campaigns', undefined, agent1);
  assert.equal(agentCampaigns.statusCode, 200, agentCampaigns.body);
  assert.deepEqual(agentCampaigns.json().items.map((campaign: { id: string }) => campaign.id), [campaignId]);
  assert.equal('routing_method' in agentCampaigns.json().items[0], false);
  assert.equal('agents' in agentCampaigns.json().items[0], false);
  assert.equal((await send('GET', `/api/leads/${firstAssigned.id}`, undefined, agent1)).statusCode, 200);
  assert.equal((await send('GET', `/api/leads/${firstAssigned.id}`, undefined, agent2)).statusCode, 404);
  assert.equal((await send('GET', `/api/leads/${firstAssigned.id}`, undefined, managerB)).statusCode, 404);
  assert.equal((await send('GET', `/api/leads?branchId=${branchA}`, undefined, managerB)).statusCode, 403);
  assert.equal((await send('POST', '/api/leads', {
    branchId: branchA, campaignId, contact: { name: 'Cross Branch', phone: '+15550000005' },
  }, managerB)).statusCode, 403);
  const firstPage = await send('GET', '/api/leads?limit=1', undefined, managerA);
  assert.equal(firstPage.statusCode, 200, firstPage.body);
  assert.equal(firstPage.json().items.length, 1);
  assert.ok(firstPage.json().nextCursor);
  const secondPage = await send('GET', `/api/leads?limit=1&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`, undefined, managerA);
  assert.equal(secondPage.statusCode, 200, secondPage.body);
  assert.notEqual(secondPage.json().items[0].id, firstPage.json().items[0].id);
  assert.equal((await send('POST', `/api/leads/${firstAssigned.id}/lifecycle`, { lifecycle: 'CLOSED' }, agent1)).statusCode, 403);
  assert.equal((await send('POST', `/api/leads/${firstAssigned.id}/lifecycle`, { lifecycle: 'CLOSED' }, managerB)).statusCode, 404);
  assert.equal((await send('POST', `/api/leads/${firstAssigned.id}/lifecycle`, { lifecycle: 'CLOSED' }, managerA)).statusCode, 200);
  assert.equal((await db`SELECT lifecycle FROM lead WHERE id = ${firstAssigned.id}`)[0]!.lifecycle, 'CLOSED');

  const sameContact = await send('POST', '/api/leads', {
    branchId: branchA, campaignId, contact: { name: 'Contact 1 repeat', phone: '+15550000001' },
  }, managerA);
  assert.equal(sameContact.statusCode, 201, sameContact.body);
  assert.equal((await db`SELECT count(*)::integer AS count FROM contact`)[0]!.count, 3);
  assert.equal((await db`SELECT assigned_agent_id FROM lead WHERE id = ${sameContact.json().id}`)[0]!.assigned_agent_id, agentA1);
  const repeatedIntake = await Promise.all([1, 2].map((n) => send('POST', '/api/leads', {
    branchId: branchA, campaignId, contact: { name: `Shared ${n}`, phone: '+15550000004' },
  }, managerA)));
  for (const result of repeatedIntake) assert.equal(result.statusCode, 201, result.body);
  assert.equal((await db`SELECT count(*)::integer AS count FROM contact WHERE phone_normalized = '+15550000004'`)[0]!.count, 1);

  assert.equal((await send('POST', '/api/leads', { branchId: branchA, campaignId,
    contact: { name: 'Invalid phone', phone: '555 1234', email: 'valid@example.test' } }, managerA)).statusCode, 400);
  assert.equal((await send('POST', '/api/leads', { branchId: branchA, campaignId,
    contact: { name: 'Invalid email', phone: '+15550000009', email: 'not-an-email' } }, managerA)).statusCode, 400);
  const emailOnly = await send('POST', '/api/leads', { branchId: branchA, campaignId,
    contact: { name: 'Email candidate', email: '  Candidate@Example.TEST  ' } }, managerA);
  assert.equal(emailOnly.statusCode, 201, emailOnly.body);
  const sameEmail = await send('POST', '/api/leads', { branchId: branchA, campaignId,
    contact: { name: 'Email candidate again', email: 'candidate@example.test' } }, managerA);
  assert.equal(sameEmail.statusCode, 201, sameEmail.body);
  assert.equal((await db`SELECT contact_id FROM lead WHERE id = ${emailOnly.json().id}`)[0]!.contact_id,
    (await db`SELECT contact_id FROM lead WHERE id = ${sameEmail.json().id}`)[0]!.contact_id);

  const contactA = (await db`SELECT contact_id FROM lead WHERE id = ${leadIds[0]!}`)[0]!.contact_id as string;
  const contactB = (await db`SELECT contact_id FROM lead WHERE id = ${emailOnly.json().id}`)[0]!.contact_id as string;
  const ambiguous = await send('POST', '/api/leads', { branchId: branchA, campaignId,
    contact: { name: 'Ambiguous', phone: '+1 (555) 000-0001', email: 'candidate@example.test' } }, managerA);
  assert.equal(ambiguous.statusCode, 202, ambiguous.body);
  const reviewId = ambiguous.json().reviewId as string;
  assert.equal((await db`SELECT state FROM source_submission WHERE id = ${reviewId}`)[0]!.state, 'NEEDS_ATTENTION');
  assert.equal((await db`SELECT raw_payload FROM source_submission WHERE id = ${reviewId}`)[0]!.raw_payload.contact.phone, '+1 (555) 000-0001');
  assert.equal((await send('GET', '/api/contact-reviews', undefined, agent1)).statusCode, 403);
  assert.equal((await send('GET', '/api/contact-reviews', undefined, managerB)).json().items.length, 0);
  const reviews = await send('GET', '/api/contact-reviews', undefined, managerA);
  assert.equal(reviews.statusCode, 200, reviews.body);
  assert.deepEqual(new Set(reviews.json().items[0].candidates.map((item: { id: string }) => item.id)), new Set([contactA, contactB]));
  assert.equal((await send('POST', `/api/contact-reviews/${reviewId}/resolve`, { contactId: contactA }, managerB)).statusCode, 403);
  assert.equal((await send('POST', `/api/contact-reviews/${reviewId}/resolve`, { contactId: agentA1 }, managerA)).statusCode, 400);
  const resolved = await send('POST', `/api/contact-reviews/${reviewId}/resolve`, { contactId: contactA }, managerA);
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal((await send('POST', `/api/contact-reviews/${reviewId}/resolve`, { contactId: contactA }, managerA)).json().id, resolved.json().id);
  assert.equal((await send('POST', `/api/contact-reviews/${reviewId}/resolve`, { contactId: contactB }, managerA)).statusCode, 409);
  assert.equal((await db`SELECT count(*)::integer AS count FROM lead WHERE id = ${resolved.json().id}`)[0]!.count, 1);
  assert.equal((await send('GET', '/api/contact-reviews', undefined, managerA)).json().items.length, 0);

  const contactsA = await send('GET', '/api/contacts?limit=2', undefined, managerA);
  assert.equal(contactsA.statusCode, 200, contactsA.body);
  assert.equal(contactsA.json().items.length, 2);
  assert.ok(contactsA.json().nextCursor);
  const phoneSearch = await send('GET', `/api/contacts?q=${encodeURIComponent('+1 (555) 000')}`, undefined, managerA);
  assert.equal(phoneSearch.statusCode, 200, phoneSearch.body);
  assert.ok(phoneSearch.json().items.some((item: { id: string }) => item.id === contactA));
  assert.deepEqual((await send('GET', '/api/contacts?q=%25_', undefined, managerA)).json().items, []);
  assert.equal((await send('GET', `/api/contacts/${contactA}`, undefined, managerB)).statusCode, 404);
  assert.equal((await send('GET', `/api/contacts/${contactA}`, undefined, agent1)).statusCode, 200);
  assert.equal((await send('PATCH', `/api/contacts/${contactA}`, { name: 'Denied', version: 1, phone: '+15550000001' }, agent1)).statusCode, 403);
  const beforeEdit = (await send('GET', `/api/contacts/${contactA}`, undefined, managerA)).json().contact;
  const edit = await send('PATCH', `/api/contacts/${contactA}`, { name: 'Updated person', phone: '+1 555 000 0001', version: beforeEdit.version }, managerA);
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal((await send('PATCH', `/api/contacts/${contactA}`, { name: 'Stale', phone: '+15550000001', version: beforeEdit.version }, managerA)).statusCode, 409);
  assert.equal((await send('PATCH', `/api/contacts/${contactA}`, { name: 'Conflict', email: 'candidate@example.test', version: edit.json().version }, managerA)).statusCode, 409);
  assert.equal((await db`SELECT count(*)::integer AS count FROM contact_history WHERE contact_id = ${contactA}`)[0]!.count, 1);
  assert.equal((await db`SELECT count(*)::integer AS count FROM audit_log WHERE action = 'CONTACT_UPDATED' AND target_id = ${contactA}`)[0]!.count, 1);

  const campaignBResponse = await send('POST', '/api/campaigns', { branchId: branchB, name: 'Campaign B' }, managerB);
  assert.equal(campaignBResponse.statusCode, 201, campaignBResponse.body);
  const campaignB = campaignBResponse.json().id as string;
  assert.equal((await send('POST', `/api/campaigns/${campaignB}/activate`, undefined, managerB)).statusCode, 200);
  const sharedLeadReview = await send('POST', '/api/leads', { branchId: branchB, campaignId: campaignB,
    contact: { name: 'Shared contact', phone: '+15550000001' } }, managerB);
  assert.equal(sharedLeadReview.statusCode, 202, sharedLeadReview.body);
  const restrictedReview = (await send('GET', '/api/contact-reviews', undefined, managerB)).json().items[0];
  assert.equal(restrictedReview.id, sharedLeadReview.json().reviewId);
  assert.equal(restrictedReview.restrictedCandidates, true);
  assert.deepEqual(restrictedReview.candidates, []);
  assert.equal((await send('POST', `/api/contact-reviews/${restrictedReview.id}/resolve`, { contactId: contactA }, managerB)).statusCode, 403);
  const sharedLead = await send('POST', `/api/contact-reviews/${restrictedReview.id}/resolve`, { contactId: contactA }, admin);
  assert.equal(sharedLead.statusCode, 200, sharedLead.body);
  assert.equal((await db`SELECT contact_id FROM lead WHERE id = ${sharedLead.json().id}`)[0]!.contact_id, contactA);
  const branchBContact = await send('GET', `/api/contacts/${contactA}`, undefined, managerB);
  assert.equal(branchBContact.statusCode, 200, branchBContact.body);
  assert.equal(branchBContact.json().contact.editable, false);
  assert.deepEqual(branchBContact.json().leads.map((item: { id: string }) => item.id), [sharedLead.json().id]);
  assert.equal((await send('GET', `/api/leads?contactId=${contactA}`, undefined, managerB)).json().items.length, 1);
  assert.equal((await send('PATCH', `/api/contacts/${contactA}`, { name: 'Cross branch edit', version: edit.json().version }, managerA)).statusCode, 403);
  assert.equal((await send('PATCH', `/api/contacts/${contactA}`, { name: 'Cross branch edit', version: edit.json().version }, managerB)).statusCode, 403);
  const adminEdit = await send('PATCH', `/api/contacts/${contactA}`, { name: 'Admin reviewed shared contact', version: edit.json().version }, admin);
  assert.equal(adminEdit.statusCode, 200, adminEdit.body);
  const editRace = await Promise.all(['First edit', 'Second edit'].map((name) => send('PATCH', `/api/contacts/${contactA}`,
    { name, version: adminEdit.json().version }, admin)));
  assert.deepEqual(editRace.map((response) => response.statusCode).sort(), [200, 409]);

  const branchBOnly = await send('POST', '/api/leads', { branchId: branchB, campaignId: campaignB,
    contact: { name: 'Branch B only', email: 'b-only@example.test' } }, managerB);
  assert.equal(branchBOnly.statusCode, 201, branchBOnly.body);
  const branchBContactId = (await db`SELECT contact_id FROM lead WHERE id = ${branchBOnly.json().id}`)[0]!.contact_id as string;
  assert.equal((await send('GET', `/api/contacts/${branchBContactId}`, undefined, managerA)).statusCode, 404);
  assert.ok(!(await send('GET', '/api/contacts', undefined, agent1)).json().items.some((item: { id: string }) => item.id === branchBContactId));
  const crossBranchReview = await send('POST', '/api/leads', { branchId: branchA, campaignId,
    contact: { name: 'Needs admin review', phone: '+15550000001', email: 'b-only@example.test' } }, managerA);
  assert.equal(crossBranchReview.statusCode, 202, crossBranchReview.body);
  const crossReviewId = crossBranchReview.json().reviewId as string;
  const managerReview = (await send('GET', '/api/contact-reviews', undefined, managerA)).json().items[0];
  assert.equal(managerReview.id, crossReviewId);
  assert.equal(managerReview.restrictedCandidates, true);
  assert.deepEqual(managerReview.candidates, []);
  assert.equal((await send('POST', `/api/contact-reviews/${crossReviewId}/resolve`, { contactId: branchBContactId }, managerA)).statusCode, 403);
  const competingResolution = await Promise.all([1, 2].map(() => send('POST', `/api/contact-reviews/${crossReviewId}/resolve`, { contactId: contactA }, admin)));
  assert.deepEqual(competingResolution.map((response) => response.statusCode), [200, 200]);
  assert.equal(competingResolution[0]!.json().id, competingResolution[1]!.json().id);
  assert.equal((await db`SELECT count(*)::integer AS count FROM lead WHERE id = ${competingResolution[0]!.json().id}`)[0]!.count, 1);
  assert.equal((await db`SELECT count(*)::integer AS count FROM source_submission WHERE id = ${crossReviewId} AND state = 'PROCESSED'`)[0]!.count, 1);
  const mixedReview = await send('POST', '/api/leads', { branchId: branchA, campaignId,
    contact: { name: 'One visible candidate', phone: '+15550000004', email: 'b-only@example.test' } }, managerA);
  assert.equal(mixedReview.statusCode, 202, mixedReview.body);
  const mixedReviewId = mixedReview.json().reviewId as string;
  const branchAContact = (await db`SELECT id FROM contact WHERE phone_normalized = '+15550000004'`)[0]!.id as string;
  const mixedReviewList = (await send('GET', '/api/contact-reviews', undefined, managerA)).json().items[0];
  assert.equal(mixedReviewList.id, mixedReviewId);
  assert.deepEqual(mixedReviewList.candidates.map((item: { id: string }) => item.id), [branchAContact]);
  assert.equal(mixedReviewList.restrictedCandidates, true);
  assert.equal((await send('POST', `/api/contact-reviews/${mixedReviewId}/resolve`, { contactId: branchAContact }, managerA)).statusCode, 403);
  assert.equal((await send('POST', `/api/contact-reviews/${mixedReviewId}/resolve`, { contactId: branchAContact }, admin)).statusCode, 200);

  const disable = await send('PATCH', `/api/users/${agentA1}/status`, { active: false }, managerA);
  assert.equal(disable.statusCode, 200, disable.body);
  assert.equal((await send('GET', '/api/auth/me', undefined, agent1)).statusCode, 401);
  assert.equal((await send('POST', '/api/auth/login', { email: 'agent-a1@example.test', password: 'Test password 12345!' })).statusCode, 401);
  assert.equal((await send('POST', '/api/auth/logout', undefined, managerB)).statusCode, 200);
  assert.equal((await send('GET', '/api/auth/me', undefined, managerB)).statusCode, 401);

  assert.equal((await send('POST', '/api/auth/password', { currentPassword: 'wrong', newPassword: 'Another test password 123!' }, managerA)).statusCode, 401);
  assert.equal((await send('GET', '/api/auth/me', undefined, managerA)).statusCode, 200);
  assert.equal((await send('POST', '/api/auth/password', { currentPassword: 'Test password 12345!', newPassword: 'Another test password 123!' }, managerA)).statusCode, 200);
  assert.equal((await send('GET', '/api/auth/me', undefined, managerA)).statusCode, 401);
  assert.equal((await send('POST', '/api/auth/login', { email: 'manager-a@example.test', password: 'Test password 12345!' })).statusCode, 401);
  const changedPasswordSession = await login('manager-a@example.test', 'Another test password 123!');
  await db`UPDATE user_session SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
    WHERE token_hash = ${sha256(changedPasswordSession.split('=')[1]!)}`;
  assert.equal((await send('GET', '/api/auth/me', undefined, changedPasswordSession)).statusCode, 401);

  const audit = await db`SELECT action FROM audit_log WHERE action IN ('FIRST_SUPER_ADMIN_BOOTSTRAP', 'USER_DISABLED', 'PASSWORD_CHANGED') ORDER BY id`;
  assert.deepEqual(audit.map((row) => row.action), ['FIRST_SUPER_ADMIN_BOOTSTRAP', 'USER_DISABLED', 'PASSWORD_CHANGED']);
});
