import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseAgent, isWithinWorkingHours } from '../src/routing.js';

const agent = (id: string, assigned_count = 0, weight = 1, capacity: number | null = null, working_hours: unknown = {}) =>
  ({ id, assigned_count, weight, capacity, working_hours });

test('round robin uses current human workload and deterministic tie break', () => {
  assert.equal(chooseAgent([agent('b', 2), agent('a', 1)], 'ROUND_ROBIN', 'UTC').agentId, 'a');
  assert.equal(chooseAgent([agent('b'), agent('a')], 'ROUND_ROBIN', 'UTC').agentId, 'a');
});

test('weighted routing and capacity never choose ineligible agent', () => {
  assert.equal(chooseAgent([agent('a', 3, 3), agent('b', 2, 1)], 'WEIGHTED', 'UTC').agentId, 'a');
  assert.equal(chooseAgent([agent('a', 3, 3, 3), agent('b', 2, 1)], 'WEIGHTED', 'UTC').agentId, 'b');
  assert.deepEqual(chooseAgent([agent('a', 3, 1, 3)], 'ROUND_ROBIN', 'UTC'),
    { agentId: null, reason: 'NO_ELIGIBLE_AGENT' });
});

test('working hours use branch timezone', () => {
  const hours = { mon: [['09:00', '17:00']] };
  assert.equal(isWithinWorkingHours(hours, 'Asia/Damascus', new Date('2026-10-05T07:00:00Z')), true);
  assert.equal(isWithinWorkingHours(hours, 'UTC', new Date('2026-10-05T07:00:00Z')), false);
  assert.equal(chooseAgent([agent('a', 0, 1, null, hours)], 'ROUND_ROBIN', 'UTC', new Date('2026-10-05T07:00:00Z')).agentId, null);
});

test('manual stays unassigned and performance without sample falls back fairly', () => {
  assert.deepEqual(chooseAgent([agent('a')], 'MANUAL', 'UTC'), { agentId: null, reason: 'MANUAL_ROUTING' });
  assert.deepEqual(chooseAgent([agent('b', 2), agent('a', 1)], 'PERFORMANCE', 'UTC'),
    { agentId: 'a', reason: 'INSUFFICIENT_HUMAN_SAMPLE_FALLBACK' });
});
