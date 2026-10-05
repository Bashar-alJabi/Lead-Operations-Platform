import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourceContact,identityLockKeys } from '../src/contacts.js';
test('Source identity normalization accepts available Contact data without fixed required fields or name matching',()=> {
  assert.equal(normalizeSourceContact({}),null);
  const name=normalizeSourceContact({ name:'  Customer  ' })!;assert.equal(name.name,'Customer');assert.deepEqual(identityLockKeys('org',name),[]);
  const phone=normalizeSourceContact({ phone:'+1 (555) 000-9999' })!;assert.equal(phone.name,'');assert.equal(phone.phoneNormalized,'+15550009999');
  const email=normalizeSourceContact({ email:'  PERSON@Example.test  ' })!;assert.equal(email.emailNormalized,'person@example.test');
  assert.deepEqual(identityLockKeys('org',normalizeSourceContact({ phone:'+15550009999',email:'PERSON@Example.test' })!),['org:email:person@example.test','org:phone:+15550009999']);
});
test('Source identity normalization rejects malformed provided identities',()=> {
  assert.throws(()=>normalizeSourceContact({ phone:'555' }),/PHONE_E164_REQUIRED/);
  assert.throws(()=>normalizeSourceContact({ email:'bad' }),/EMAIL_INVALID/);
});
