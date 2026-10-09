import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyAIFollowupPolicy,normalizeAIFollowupPolicy,evaluateAIFollowupTiming,aiFollowupMandatoryStops } from '../src/ai/followup-policy.js';
test('AI Follow-up policy strictly bounds configurable timing without allowing disable of mandatory control and lifecycle stops',()=> {
  const p={ ...emptyAIFollowupPolicy(),enabled:true,delaysSeconds:[10,20],finalAction:'HANDOFF' as const };
  assert.deepEqual(normalizeAIFollowupPolicy(p),p);assert.equal(Object.isFrozen(aiFollowupMandatoryStops),true);
  for(const bad of [{ ...p,enabled:null },{ ...p,delaysSeconds:[] },{ ...p,delaysSeconds:[0] },{ ...p,delaysSeconds:[1.5] },{ ...p,delaysSeconds:Array(41).fill(1) },{ ...p,initialDelaySeconds:-1 },{ ...p,initialDelaySeconds:2147483648 },{ ...p,stopOnHumanTakeover:false },{ ...p,finalAction:'MARK_PAID' }])assert.throws(()=>normalizeAIFollowupPolicy(bad));
});
test('AI Follow-up timing is deterministic and stops on current Human/handoff/closed/reply states before exhaustion actions; DUE never authorizes send',()=> {
  const p={ ...emptyAIFollowupPolicy(),enabled:true,delaysSeconds:[10,20],finalAction:'HANDOFF' as const },c={ now:new Date('2026-10-09T12:00:09Z'),anchorAt:new Date('2026-10-09T12:00:00Z'),attemptsSent:0,hasInboundReply:false,leadLifecycle:'OPEN' as const,controllerType:'AI' as const,conversationState:'AI_WAITING_FOR_LEAD' };
  assert.equal(evaluateAIFollowupTiming(p,c).decision,'WAIT');const due=evaluateAIFollowupTiming(p,{ ...c,now:new Date('2026-10-09T12:00:10Z') });assert.equal(due.decision,'DUE');assert.equal(due.sendAllowed,false);assert.equal(due.eligibleAt,'2026-10-09T12:00:10.000Z');
  assert.equal(evaluateAIFollowupTiming(p,{ ...c,attemptsSent:1 }).eligibleAt,'2026-10-09T12:00:20.000Z');assert.equal(evaluateAIFollowupTiming(p,{ ...c,attemptsSent:2 }).decision,'HANDOFF');
  assert.equal(evaluateAIFollowupTiming({ ...p,finalAction:'COMPLETE' },{ ...c,attemptsSent:2 }).decision,'COMPLETE');
  for(const changed of [{ leadLifecycle:'CLOSED' as const },{ leadLifecycle:'ARCHIVED' as const },{ controllerType:'HUMAN' as const },{ controllerType:'NONE' as const },{ conversationState:'WAITING_FOR_HUMAN' },{ conversationState:'AI_HANDOFF_REQUIRED' },{ conversationState:'CLOSED' },{ hasInboundReply:true }])assert.equal(evaluateAIFollowupTiming(p,{ ...c,...changed,attemptsSent:2 }).decision,'STOPPED');
  assert.equal(evaluateAIFollowupTiming({ ...p,stopOnReply:false },{ ...c,hasInboundReply:true }).decision,'WAIT');
  assert.throws(()=>evaluateAIFollowupTiming(p,{ ...c,anchorAt:new Date('invalid') }));assert.throws(()=>evaluateAIFollowupTiming(p,{ ...c,attemptsSent:-1 }));
});
