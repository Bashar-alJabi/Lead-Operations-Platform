import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { openSecret, sealSecret } from '../src/credentials.js';

test('credentials are authenticated and bound to their connection', () => {
  const key = randomBytes(32);
  const sealed = sealSecret('connection-a', 'test credential', key);
  assert.equal(openSecret('connection-a', sealed, key), 'test credential');
  assert.notEqual(sealed.ciphertext.toString('utf8'), 'test credential');
  assert.throws(() => openSecret('connection-b', sealed, key));
  assert.throws(() => openSecret('connection-a', { ...sealed, ciphertext: Buffer.from(sealed.ciphertext.map((byte, index) => index === 0 ? byte ^ 1 : byte)) }, key));
});
