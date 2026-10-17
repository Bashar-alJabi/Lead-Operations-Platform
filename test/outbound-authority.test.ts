import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueOutboundMessage, type OutboundRequest } from '../src/messaging/outbound.js';
import { HttpError } from '../src/security.js';
import type { Database } from '../src/db.js';

test('Human outbound entry point rejects automated authors before database or credential access', async () => {
  for (const author of ['AI','AUTOMATION','FOLLOW_UP']) {
    // No database or Principal is supplied: the authority failure must precede all other work.
    await assert.rejects(enqueueOutboundMessage(null as unknown as Database, { author } as unknown as OutboundRequest),
      (e: unknown) => e instanceof HttpError && e.statusCode === 403 && e.code === 'AUTOMATED_OUTBOUND_AUTHORITY_REQUIRED');
  }
});
