import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedAt, evaluateSend, resolveSender, type Sender } from '../src/messaging/policy.js';
import { resolveInbound } from '../src/messaging/inbound.js';

const sender = (id: string, branches = ['a']): Sender => ({ id, connectionId: `c-${id}`, active: true,
  health: 'HEALTHY', connectionStatus: 'CONNECTED', branchIds: branches, sharedFallbackBranchIds: [],
  supportsText: true, requiresTemplate: false });

test('sender selection honors campaign override, branch default and explicit shared fallback', () => {
  const a = sender('a'); const override = sender('override');
  const shared = { ...sender('shared'), sharedFallbackBranchIds: ['a'] };
  assert.equal(resolveSender({ branchId: 'a', branchDefaultId: 'a', senders: [a, override] }).sender?.id, 'a');
  assert.equal(resolveSender({ branchId: 'a', campaignOverrideId: 'override', branchDefaultId: 'a', senders: [a, override] }).sender?.id, 'override');
  assert.equal(resolveSender({ branchId: 'a', senders: [shared] }).sender?.id, 'shared');
});

test('pinned sender never silently moves and cross-branch sender is denied', () => {
  const a = sender('a'); const bad = { ...sender('bad'), health: 'UNHEALTHY' as const };
  assert.equal(resolveSender({ branchId: 'a', pinnedSenderId: 'bad', branchDefaultId: 'a', senders: [a, bad] }).reason, 'PINNED_SENDER_UNHEALTHY');
  assert.equal(resolveSender({ branchId: 'a', campaignOverrideId: 'b', branchDefaultId: 'a', senders: [a, sender('b', ['b'])] }).reason, 'SENDER_OUT_OF_SCOPE');
});

test('policy blocks DNC, template, frequency and AI during human control', () => {
  const base = { author: 'HUMAN' as const, actorUserId: 'u', controllerType: 'HUMAN' as const, controllerUserId: 'u',
    conversationState: 'HUMAN_ACTIVE', consentStatus: 'GRANTED' as const, doNotContact: false, consentRequired: true,
    sender: sender('a'), timezone: 'UTC', attempts: 0 };
  assert.deepEqual(evaluateSend(base), { allowed: true });
  assert.equal(evaluateSend({ ...base, doNotContact: true }).reason, 'DO_NOT_CONTACT');
  assert.equal(evaluateSend({ ...base, sender: { ...base.sender, requiresTemplate: true } }).reason, 'TEMPLATE_REQUIRED');
  assert.equal(evaluateSend({ ...base, maxAttempts: 1, attempts: 1 }).reason, 'MAX_ATTEMPTS');
  assert.equal(evaluateSend({ ...base, author: 'AI' }).reason, 'AI_CONTROLLER_REQUIRED');
});

test('sending window applies timezone and supports overnight windows', () => {
  assert.equal(allowedAt(new Date('2026-10-02T20:30:00Z'), 'Asia/Damascus', { start: '22:00', end: '06:00' }), true);
  assert.equal(allowedAt(new Date('2026-10-02T10:00:00Z'), 'Asia/Damascus', { start: '22:00', end: '06:00' }), false);
});

test('inbound exact thread wins and ambiguous leads remain unassigned', () => {
  const leads = [
    { id: 'lead-a', campaignId: 'campaign-a', contactParticipantRefs: ['+123'], lifecycle: 'OPEN' as const },
    { id: 'lead-b', campaignId: 'campaign-b', contactParticipantRefs: ['+123'], lifecycle: 'OPEN' as const },
  ];
  const base = { connectionId: 'conn', senderId: 'sender', participantRef: '+123', conversations: [], leads };
  assert.deepEqual(resolveInbound(base), { kind: 'NEEDS_ATTENTION', reason: 'MULTIPLE_ACTIVE_LEADS' });
  assert.deepEqual(resolveInbound({ ...base, campaignRef: 'campaign-b' }), { kind: 'LEAD', leadId: 'lead-b' });
  assert.deepEqual(resolveInbound({ ...base, threadRef: 'thread-1', conversations: [{ id: 'conversation-a',
    leadId: 'lead-a', connectionId: 'conn', senderId: 'sender', participantRef: '+123', threadRef: 'thread-1', state: 'HUMAN_ACTIVE' }] }),
  { kind: 'CONVERSATION', conversationId: 'conversation-a', leadId: 'lead-a' });
});
