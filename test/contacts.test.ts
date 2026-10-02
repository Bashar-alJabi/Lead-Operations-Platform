import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityLockKeys, normalizeContact } from '../src/contacts.js';

test('contact normalization preserves source values and produces deterministic match keys', () => {
  const contact = normalizeContact({ name: '  Ada  ', phone: ' +1 (555) 000-0001 ', email: '  Ada@Example.TEST  ' });
  assert.deepEqual(contact, { name: 'Ada', phone: '+1 (555) 000-0001', phoneNormalized: '+15550000001',
    email: 'Ada@Example.TEST', emailNormalized: 'ada@example.test' });
  assert.deepEqual(identityLockKeys('org', contact), ['org:email:ada@example.test', 'org:phone:+15550000001']);
  assert.equal(normalizeContact({ name: 'Full width', email: 'Ａ@Example.TEST' }).emailNormalized, 'a@example.test');
});

test('invalid supplied identity is rejected even if the other identity is valid', () => {
  assert.throws(() => normalizeContact({ name: 'Ada', phone: '555-0001', email: 'ada@example.test' }), { code: 'PHONE_E164_REQUIRED' });
  assert.throws(() => normalizeContact({ name: 'Ada', phone: '+15550000001', email: 'invalid' }), { code: 'EMAIL_INVALID' });
  assert.throws(() => normalizeContact({ name: 'Ada' }), { code: 'CONTACT_IDENTIFIER_REQUIRED' });
  assert.throws(() => normalizeContact({ name: '  ', email: 'ada@example.test' }), { code: 'CONTACT_NAME_REQUIRED' });
});
