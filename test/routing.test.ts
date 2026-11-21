import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseAgent, isWithinWorkingHours } from '../src/routing.js';
import { rankHumanPerformance, type PerformancePolicy } from '../src/performance-routing.js';

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

test('manual stays unassigned', () => {
  assert.deepEqual(chooseAgent([agent('a')], 'MANUAL', 'UTC'), { agentId: null, reason: 'MANUAL_ROUTING' });
});

test('performance compares enabled human metrics and falls back for a new staff member', () => {
  const policy: PerformancePolicy = { version: 1, lookback_days: 30, minimum_samples: 2,
    response_weight: 50, follow_up_weight: 50, fallback_method: 'WEIGHTED' };
  const candidates = [agent('fast', 2), agent('reliable', 3)];
  const samples = [
    { id: 'fast', replies: 2, responseSeconds: 0, followUps: 2, onTime: 0 },
    { id: 'reliable', replies: 2, responseSeconds: 3600, followUps: 2, onTime: 2 },
  ];
  assert.equal(rankHumanPerformance(candidates, samples, policy)?.candidate.id, 'reliable');
  assert.equal(rankHumanPerformance(candidates, samples, { ...policy, response_weight: 100, follow_up_weight: 0 })?.candidate.id, 'fast');
  assert.equal(rankHumanPerformance([...candidates, agent('new')], samples, policy), null);
  assert.equal(rankHumanPerformance(candidates, samples, { ...policy, minimum_samples: 3 }), null);
  const tied = [{ ...samples[1]!, id: 'fast' }, samples[1]!];
  assert.equal(rankHumanPerformance(candidates, tied, policy)?.candidate.id, 'fast');
});
