import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCursor, encodeCursor } from '../src/pagination.js';

test('keyset cursor round-trips timestamp and id and rejects malformed input', () => {
  const cursor = { timestamp: '2026-10-02T12:00:00.000Z', id: '11111111-1111-4111-8111-111111111111' };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  assert.throws(() => decodeCursor('not-a-cursor'), { code: 'INVALID_CURSOR' });
});
