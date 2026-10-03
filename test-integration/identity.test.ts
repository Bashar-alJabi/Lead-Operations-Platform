import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { processOneIdentityEmailJob, type IdentityEmailAdapter } from '../src/identity-email.js';
import { passwordHash, sha256 } from '../src/security.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') {
  throw new Error('TEST_DATABASE_URL must target lead_operations_test');
}

test('identity invitation and recovery enforce scope, one-time tokens, and retryable delivery', async (t) => {
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  process.env.BOOTSTRAP_TOKEN = randomBytes(32).toString('base64url');
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const delivered: { to: string; text: string }[] = [];
  let failNextSend = false;
  let failNextVerify = false;
  const fakeEmail: IdentityEmailAdapter = {
    async verify() { if (failNextVerify) { failNextVerify = false; throw new Error('sandbox credential rejected'); } },
    async send(_settings, _password, message) {
      if (failNextSend) { failNextSend = false; throw new Error('sandbox SMTP unavailable'); }
      delivered.push({ to: message.to, text: message.text });
    },
  };
  const db = createDatabase(url);
  const app = await buildApp(db, { logger: false, emailAdapter: fakeEmail });
  t.after(async () => { await app.close(); await db.end(); });
  await db.begin(async (tx) => {
    await tx`SET LOCAL client_min_messages TO warning`;
    await tx`TRUNCATE organization CASCADE`;
    await tx`TRUNCATE background_job CASCADE`;
  });
  const send = async (method: 'GET'|'POST'|'PUT', path: string, payload?: Record<string, unknown>, cookie?: string) => await app.inject({
    method, url: path, payload, headers: { origin: process.env.APP_ORIGIN!, ...(cookie ? { cookie } : {}) },
  });
  const login = async (email: string, password: string) => {
    const response = await send('POST', '/api/auth/login', { email, password });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.headers['set-cookie'];
    return (Array.isArray(cookie) ? cookie[0]! : cookie!).split(';')[0]!;
  };
  const tokenFromLastMail = (kind: 'invite'|'reset') => {
    const urlText = delivered.at(-1)!.text.match(/https?:\/\/\S+/)![0]!;
    const token = new URLSearchParams(new URL(urlText).hash.slice(1)).get(kind);
    assert.ok(token);
    return token;
  };

  const bootstrap = await send('POST', '/api/setup/bootstrap', {
    token: process.env.BOOTSTRAP_TOKEN, organizationName: 'Identity Test', name: 'Owner',
    email: 'owner@example.test', password: 'Owner test password 123!',
  });
  assert.equal(bootstrap.statusCode, 201, bootstrap.body);
  const admin = await login('owner@example.test', 'Owner test password 123!');
  const branchResponse = await send('POST', '/api/branches', { name: 'Identity Branch', timezone: 'UTC' }, admin);
  assert.equal(branchResponse.statusCode, 201, branchResponse.body);
  const branchId = branchResponse.json().id as string;
  const otherBranchResponse = await send('POST', '/api/branches', { name: 'Other Branch', timezone: 'UTC' }, admin);
  const otherBranchId = otherBranchResponse.json().id as string;
  const managerHash = await passwordHash('Manager test password 123!');
  const organizationId = (await db`SELECT id FROM organization LIMIT 1`)[0]!.id;
  await db`INSERT INTO user_account (organization_id, branch_id, role, name, email, password_hash)
    VALUES (${organizationId}, ${branchId}, 'MANAGER', 'Manager', 'manager@example.test', ${managerHash})`;
  const manager = await login('manager@example.test', 'Manager test password 123!');

  assert.equal((await send('GET', '/api/identity/email', undefined, manager)).statusCode, 403);
  assert.equal((await send('POST', '/api/users', {
    branchId, role: 'AGENT', name: 'Invited', email: 'invited@example.test',
  }, manager)).statusCode, 409);
  const configured = await send('PUT', '/api/identity/email', {
    name: 'Sandbox SMTP', host: 'smtp.example.test', port: 465, secure: true,
    username: 'sandbox-user', password: 'sandbox-password', fromAddress: 'security@example.test',
  }, admin);
  assert.equal(configured.statusCode, 200, configured.body);
  const details = await send('GET', '/api/identity/email', undefined, admin);
  assert.equal(details.statusCode, 200, details.body);
  assert.equal(details.json().hasCredential, true);
  assert.equal('password' in details.json().settings, false);
  const stored = await db`SELECT ciphertext FROM connection_secret WHERE connection_id = ${configured.json().id}`;
  assert.equal(stored[0]!.ciphertext.toString().includes('sandbox-password'), false);
  assert.equal((await send('POST', '/api/identity/email/test', undefined, manager)).statusCode, 403);
  failNextVerify = true;
  const failedVerification = await send('POST', '/api/identity/email/test', undefined, admin);
  assert.equal(failedVerification.statusCode, 502);
  assert.equal(failedVerification.body.includes('sandbox credential rejected'), false);
  assert.equal((await send('POST', '/api/identity/email/test', undefined, admin)).statusCode, 200);

  assert.equal((await send('POST', '/api/users', {
    branchId: otherBranchId, role: 'AGENT', name: 'Denied', email: 'denied@example.test',
  }, manager)).statusCode, 403);
  assert.equal((await send('POST', '/api/users', {
    branchId, role: 'MANAGER', name: 'Denied', email: 'denied@example.test',
  }, manager)).statusCode, 403);
  assert.equal((await send('POST', '/api/users', {
    branchId, role: 'AGENT', name: 'Insecure', email: 'insecure@example.test', password: 'Admin-chosen password 123!',
  }, manager)).statusCode, 400);
  const invitation = await send('POST', '/api/users', {
    branchId, role: 'AGENT', name: 'Invited', email: 'invited@example.test',
  }, manager);
  assert.equal(invitation.statusCode, 201, invitation.body);
  assert.equal(invitation.json().delivery, 'QUEUED');
  assert.equal((await send('POST', '/api/auth/login', { email: 'invited@example.test', password: 'Some password 123!' })).statusCode, 401);
  assert.equal((await send('POST', '/api/users', {
    branchId, role: 'AGENT', name: 'Duplicate', email: 'invited@example.test',
  }, manager)).statusCode, 409);
  assert.equal(await processOneIdentityEmailJob(db, fakeEmail), true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.to, 'invited@example.test');
  const inviteToken = tokenFromLastMail('invite');
  assert.equal((await send('POST', '/api/auth/invitations/accept', { token: inviteToken, password: 'Invited password 123!' })).statusCode, 200);
  assert.equal((await send('POST', '/api/auth/invitations/accept', { token: inviteToken, password: 'Another password 123!' })).statusCode, 400);
  const agent = await login('invited@example.test', 'Invited password 123!');
  assert.equal((await send('GET', '/api/auth/me', undefined, agent)).statusCode, 200);

  assert.deepEqual((await send('POST', '/api/auth/forgot', { email: 'unknown@example.test' })).json(), { accepted: true });
  assert.equal((await db`SELECT count(*)::integer AS count FROM credential_token WHERE purpose = 'RESET'`)[0]!.count, 0);
  assert.deepEqual((await send('POST', '/api/auth/forgot', { email: 'invited@example.test' })).json(), { accepted: true });
  assert.equal(await processOneIdentityEmailJob(db, fakeEmail), true);
  const resetToken = tokenFromLastMail('reset');
  const competingReset = await Promise.all([
    send('POST', '/api/auth/reset', { token: resetToken, password: 'Recovered password 123!' }),
    send('POST', '/api/auth/reset', { token: resetToken, password: 'Recovered password 123!' }),
  ]);
  assert.deepEqual(competingReset.map((response) => response.statusCode).sort(), [200, 400]);
  assert.equal((await send('GET', '/api/auth/me', undefined, agent)).statusCode, 401);
  assert.equal((await send('POST', '/api/auth/login', { email: 'invited@example.test', password: 'Invited password 123!' })).statusCode, 401);
  const recoveredAgent = await login('invited@example.test', 'Recovered password 123!');
  assert.deepEqual((await send('POST', '/api/auth/forgot', { email: 'invited@example.test' })).json(), { accepted: true });
  assert.equal(await processOneIdentityEmailJob(db, fakeEmail), true);
  const expiringResetToken = tokenFromLastMail('reset');
  await db`UPDATE credential_token SET expires_at = now() - interval '1 second' WHERE token_hash = ${sha256(expiringResetToken)}`;
  assert.equal((await send('POST', '/api/auth/reset', { token: expiringResetToken, password: 'Expired password 123!' })).statusCode, 400);

  failNextSend = true;
  const retryInvite = await send('POST', '/api/users', {
    branchId, role: 'AGENT', name: 'Retry', email: 'retry@example.test',
  }, manager);
  assert.equal(retryInvite.statusCode, 201, retryInvite.body);
  assert.equal(await processOneIdentityEmailJob(db, fakeEmail), true);
  const failedJobs = await db`SELECT id, status, last_error_code FROM background_job WHERE queue = 'identity_email' AND status = 'QUEUED'`;
  assert.equal(failedJobs.length, 1);
  assert.equal(failedJobs[0]!.last_error_code, 'EMAIL_DELIVERY_FAILED');
  await db`UPDATE background_job SET run_after = now() WHERE id = ${failedJobs[0]!.id}`;
  assert.equal(await processOneIdentityEmailJob(db, fakeEmail), true);
  assert.equal(delivered.at(-1)!.to, 'retry@example.test');
  const originalRetryToken = tokenFromLastMail('invite');
  assert.equal((await send('POST', `/api/users/${retryInvite.json().id}/invitation`, undefined, manager)).statusCode, 409);
  assert.equal((await send('POST', '/api/identity/email/test', undefined, admin)).statusCode, 200);
  assert.equal((await send('POST', `/api/users/${retryInvite.json().id}/invitation`, undefined, manager)).statusCode, 200);
  assert.equal(await processOneIdentityEmailJob(db, fakeEmail), true);
  const renewedToken = tokenFromLastMail('invite');
  assert.notEqual(renewedToken, originalRetryToken);
  assert.equal((await send('POST', '/api/auth/invitations/accept', { token: originalRetryToken, password: 'Retry password 123!' })).statusCode, 400);
  assert.equal((await send('POST', '/api/auth/invitations/accept', { token: renewedToken, password: 'Retry password 123!' })).statusCode, 200);
  assert.equal((await db`SELECT count(*)::integer AS count FROM audit_log WHERE action = 'INVITATION_ACCEPTED'`)[0]!.count, 2);
  assert.equal((await db`SELECT count(*)::integer AS count FROM credential_token WHERE token_hash = ${sha256(renewedToken)} AND used_at IS NOT NULL`)[0]!.count, 1);

  const deadInvite = await send('POST', '/api/users', {
    branchId, role: 'AGENT', name: 'Dead Job', email: 'dead-job@example.test',
  }, manager);
  assert.equal(deadInvite.statusCode, 201, deadInvite.body);
  await db`UPDATE background_job SET attempts = max_attempts - 1
    WHERE payload ->> 'userId' = ${deadInvite.json().id}`;
  failNextSend = true;
  assert.equal(await processOneIdentityEmailJob(db, fakeEmail), true);
  const deadJob = (await db`SELECT id, status FROM background_job WHERE payload ->> 'userId' = ${deadInvite.json().id}`)[0]!;
  assert.equal(deadJob.status, 'DEAD');
  assert.equal((await send('GET', '/api/identity/deliveries', undefined, recoveredAgent)).statusCode, 403);
  const managerDeliveries = await send('GET', '/api/identity/deliveries', undefined, manager);
  assert.equal(managerDeliveries.statusCode, 200, managerDeliveries.body);
  assert.equal(managerDeliveries.body.includes('ciphertext'), false);
  assert.ok(managerDeliveries.json().items.some((job: { id: string }) => job.id === deadJob.id));
  const firstDeliveryPage = await send('GET', '/api/identity/deliveries?limit=1', undefined, manager);
  assert.equal(firstDeliveryPage.json().items.length, 1);
  assert.ok(firstDeliveryPage.json().nextCursor);
  const secondDeliveryPage = await send('GET', `/api/identity/deliveries?limit=1&cursor=${encodeURIComponent(firstDeliveryPage.json().nextCursor)}`, undefined, manager);
  assert.notEqual(firstDeliveryPage.json().items[0].id, secondDeliveryPage.json().items[0].id);
  assert.equal((await send('GET', '/api/identity/deliveries?cursor=bad', undefined, manager)).statusCode, 400);
  assert.equal((await send('POST', `/api/identity/deliveries/${deadJob.id}/retry`, undefined, manager)).statusCode, 200);
  assert.equal(await processOneIdentityEmailJob(db, fakeEmail), true);
  assert.equal(delivered.at(-1)!.to, 'dead-job@example.test');
  assert.equal((await send('POST', '/api/identity/email/test', undefined, admin)).statusCode, 200);

  const expiredInvite = await send('POST', '/api/users', {
    branchId, role: 'AGENT', name: 'Expired', email: 'expired@example.test',
  }, manager);
  assert.equal(expiredInvite.statusCode, 201, expiredInvite.body);
  await db`UPDATE credential_token SET expires_at = now() - interval '1 second'
    WHERE user_id = ${expiredInvite.json().id} AND purpose = 'INVITATION'`;
  assert.equal(await processOneIdentityEmailJob(db, fakeEmail), true);
  const expiredJob = (await db`SELECT id, status, last_error_code FROM background_job WHERE payload ->> 'userId' = ${expiredInvite.json().id}`)[0]!;
  assert.equal(expiredJob.last_error_code, 'TOKEN_EXPIRED');
  assert.equal((await send('POST', `/api/identity/deliveries/${expiredJob.id}/retry`, undefined, manager)).statusCode, 409);
  assert.equal(delivered.some((message) => message.to === 'expired@example.test'), false);

  const disabledInvite = await send('POST', '/api/users', {
    branchId, role: 'AGENT', name: 'Disabled', email: 'disabled@example.test',
  }, manager);
  assert.equal(disabledInvite.statusCode, 201, disabledInvite.body);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/users/${disabledInvite.json().id}/status`, payload: { active: false }, headers: { origin: process.env.APP_ORIGIN!, cookie: manager } })).statusCode, 200);
  assert.equal(await processOneIdentityEmailJob(db, fakeEmail), true);
  assert.equal(delivered.some((message) => message.to === 'disabled@example.test'), false);

  const otherBranchInvite = await send('POST', '/api/users', {
    branchId: otherBranchId, role: 'AGENT', name: 'Other Branch Agent', email: 'other-agent@example.test',
  }, admin);
  assert.equal(otherBranchInvite.statusCode, 201, otherBranchInvite.body);
  const otherJob = (await db`SELECT id FROM background_job WHERE payload ->> 'userId' = ${otherBranchInvite.json().id}`)[0]!;
  assert.equal((await send('POST', `/api/identity/deliveries/${otherJob.id}/retry`, undefined, manager)).statusCode, 403);
  const scopedJobs = (await send('GET', '/api/identity/deliveries', undefined, manager)).json().items as { id: string }[];
  assert.equal(scopedJobs.some((job) => job.id === otherJob.id), false);
  const firstUserPage = await send('GET', '/api/users?limit=1', undefined, manager);
  assert.equal(firstUserPage.json().items.length, 1);
  assert.ok(firstUserPage.json().nextCursor);
  const secondUserPage = await send('GET', `/api/users?limit=1&cursor=${encodeURIComponent(firstUserPage.json().nextCursor)}`, undefined, manager);
  assert.notEqual(firstUserPage.json().items[0].id, secondUserPage.json().items[0].id);
});
