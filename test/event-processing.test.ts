import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventProcessingDelay, eventProcessingFailure, eventWorkerOptions } from '../src/messaging/event-processing.js';

test('event retry diagnostics never copy untrusted secrets and backoff remains bounded', () => {
  assert.equal(eventProcessingFailure(new Error('secret-from-provider')), 'EVENT_PROCESSING_FAILED');
  assert.equal(eventProcessingFailure({ code: 'secret-from-provider' }), 'EVENT_PROCESSING_FAILED');
  assert.equal(eventProcessingFailure({ code: '40P01' }), 'PROCESSING_DEADLOCK');
  assert.equal(eventProcessingFailure({ code: '40001' }), 'PROCESSING_SERIALIZATION');
  assert.equal(eventProcessingFailure({ code: '57014' }), 'PROCESSING_TIMEOUT');
  assert.equal(eventProcessingDelay(1), 30); assert.equal(eventProcessingDelay(2), 60);
  assert.ok(eventProcessingDelay(100) <= 1800);
  assert.deepEqual(eventWorkerOptions({}), { batchSize:50,pollMs:2000 });
  assert.throws(()=>eventWorkerOptions({ MESSAGING_EVENT_BATCH_SIZE:'100000' }));
  assert.throws(()=>eventWorkerOptions({ MESSAGING_EVENT_POLL_MS:'0' }));
  assert.throws(()=>eventWorkerOptions({ MESSAGING_EVENT_BATCH_SIZE:'NaN' }));
});
