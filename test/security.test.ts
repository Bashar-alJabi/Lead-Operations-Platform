import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newToken, passwordHash, passwordVerify, requireBranch, safeTokenEqual } from '../src/security.js';

test('session tokens are random and compared without plain-text equality', () => {
  const first = newToken(); const second = newToken();
  assert.notEqual(first, second);
  assert.equal(safeTokenEqual(first, first), true);
  assert.equal(safeTokenEqual(first, second), false);
});

test('Argon2id password hash verifies only the matching password', async () => {
  const encoded = await passwordHash('a secure example password');
  assert.match(encoded, /^\$argon2id\$/);
  assert.equal(await passwordVerify(encoded, 'a secure example password'), true);
  assert.equal(await passwordVerify(encoded, 'another password'), false);
});

test('manager branch boundary rejects cross branch access', () => {
  const manager = { id: 'u', organizationId: 'o', branchId: 'branch-a', role: 'MANAGER' as const, name: 'M', email: 'm@test.invalid' };
  assert.doesNotThrow(() => requireBranch(manager, 'branch-a'));
  assert.throws(() => requireBranch(manager, 'branch-b'), { code: 'FORBIDDEN' });
});
