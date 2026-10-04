import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageRecoveryBlock, type RecoveryFacts } from '../src/messaging/message-recovery.js';

test('message recovery excludes every acceptance or uncertainty signal and retains original author boundary', () => {
  const safe: RecoveryFacts = { direction: 'OUTBOUND', author_type: 'HUMAN', author_user_id: 'owner',
    delivery_state: 'FAILED', provider_message_id: null, delivery_rank: 0, sent_at: null,
    delivery_provider_at: null, job_status: 'DEAD', locked_until: null, unsafe_attempt: false, has_delivery_event: false };
  assert.equal(messageRecoveryBlock(safe, 'owner'), null);
  assert.equal(messageRecoveryBlock(safe, 'manager'), 'ORIGINAL_AUTHOR_REQUIRED');
  for (const accepted of [{ provider_message_id: 'wamid.accepted' }, { delivery_rank: 1 }, { sent_at: new Date() },
    { delivery_provider_at: new Date() }, { unsafe_attempt: true }, { has_delivery_event: true }])
    assert.equal(messageRecoveryBlock({ ...safe, ...accepted }, 'owner'), 'SEND_ACCEPTANCE_NOT_EXCLUDED');
  for (const unavailable of [{ delivery_state: 'UNKNOWN' }, { delivery_state: 'SENT' },
    { job_status: 'RUNNING' }, { job_status: 'QUEUED' }, { locked_until: new Date() }])
    assert.equal(messageRecoveryBlock({ ...safe, ...unavailable }, 'owner'), 'MESSAGE_NOT_RETRYABLE');
});
