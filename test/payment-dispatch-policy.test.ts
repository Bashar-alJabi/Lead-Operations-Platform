import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentAttemptUncertain,paymentDispatchWindow,resolvePaymentAttempt,type PaymentDispatchContext,type PaymentAttemptEvidence } from '../src/payments/dispatch-policy.js';
const first=1_000_000;const retention=86_400_000;
const policy={ maxAttempts:5,retentionMs:retention,dispatchBudgetMs:30_000,retryBaseMs:1000,retryMaxMs:60_000 };
function context(states:PaymentAttemptEvidence['state'][],nowMs=first+1000):PaymentDispatchContext {
  return { nowMs,firstDispatchMs:states.length ? first : null,policy,history:states.map((state,index)=>({ number:index+1,state })) };
}

test('Financial dispatch uses database instants and reserves the full I/O budget before the immutable retention deadline',()=> {
  assert.deepEqual(paymentDispatchWindow(context([])),{ allowed:true,deadlineMs:null });
  assert.deepEqual(paymentDispatchWindow(context(['RETRYABLE'],first+retention-policy.dispatchBudgetMs-1)),{ allowed:true,deadlineMs:first+retention });
  for(const now of [first+retention-policy.dispatchBudgetMs,first+retention,first+retention+1]) {
    const decision=paymentDispatchWindow(context(['UNKNOWN'],now));assert.equal(decision.allowed,false);
    if(!decision.allowed)assert.equal(decision.reason,'PAYMENT_DISPATCH_WINDOW_ELAPSED');
  }
  const previous=Date.now;try { Date.now=()=>Number.MAX_SAFE_INTEGER;assert.equal(paymentDispatchWindow(context(['RETRYABLE'])).allowed,true); }finally{ Date.now=previous; }
});
test('Earlier UNKNOWN, interrupted lease or unfinished I/O survives later rejection/exhaustion; acceptance cannot be downgraded or retried',()=> {
  for(const uncertain of ['UNKNOWN','INTERRUPTED','RUNNING'] as const) {
    const decision=resolvePaymentAttempt(context([uncertain,'REJECTED']));assert.equal(decision.state,'NEEDS_ATTENTION');assert.equal(decision.uncertain,true);
    assert.equal(resolvePaymentAttempt(context([uncertain,'RETRYABLE','RETRYABLE','RETRYABLE','RETRYABLE'])).state,'NEEDS_ATTENTION');
    assert.equal(resolvePaymentAttempt(context([uncertain],first+retention)).state,'NEEDS_ATTENTION');
  }
  assert.equal(resolvePaymentAttempt(context(['REJECTED'])).state,'FAILED');
  assert.equal(resolvePaymentAttempt(context(['RETRYABLE','RETRYABLE','RETRYABLE','RETRYABLE','RETRYABLE'])).state,'FAILED');
  assert.deepEqual(resolvePaymentAttempt(context(['UNKNOWN','ACKNOWLEDGED','REJECTED'],first+retention*2)),{ state:'ACCEPTED',uncertain:false,reason:null });
  assert.equal(resolvePaymentAttempt({ ...context(['ACKNOWLEDGED']),nowMs:NaN,policy:{ ...policy,maxAttempts:0 } }).state,'ACCEPTED');
  const replay=paymentDispatchWindow(context(['ACKNOWLEDGED']));assert.equal(replay.allowed,false);if(!replay.allowed)assert.equal(replay.reason,'PAYMENT_DISPATCH_ALREADY_ACCEPTED');
  assert.equal(paymentAttemptUncertain(context(['UNKNOWN','REJECTED']).history),true);
  const running=paymentDispatchWindow(context(['RUNNING']));assert.equal(running.allowed,false);if(!running.allowed)assert.equal(running.reason,'PAYMENT_DISPATCH_ATTEMPT_IN_PROGRESS');
  assert.equal(paymentDispatchWindow(context(['INTERRUPTED'])).allowed,true);
});
test('Bounded exponential backoff honors provider Retry-After without truncating it into an unsafe retry and leaves inputs untouched',()=> {
  const input=context(['UNKNOWN','RETRYABLE']);const original=JSON.stringify(input);
  assert.deepEqual(resolvePaymentAttempt(input),{ state:'RETRY',uncertain:true,reason:null,runAfterMs:input.nowMs+2000,deadlineMs:first+retention });
  const delayed=resolvePaymentAttempt(input,120,500);assert.equal(delayed.state,'RETRY');if(delayed.state==='RETRY')assert.equal(delayed.runAfterMs,input.nowMs+120_500);
  const near=context(['UNKNOWN'],first+retention-100_000);assert.equal(resolvePaymentAttempt(near,120).state,'NEEDS_ATTENTION');
  assert.equal(resolvePaymentAttempt(context(['RETRYABLE'],near.nowMs),120).state,'FAILED');
  assert.equal(JSON.stringify(input),original);
});
test('Corrupt/missing/reordered attempt evidence, inconsistent first dispatch and unsafe policy/time fail closed',()=> {
  const valid=context(['RETRYABLE']);
  const invalid:PaymentDispatchContext[]=[{ ...valid,firstDispatchMs:null },{ ...valid,history:[] },{ ...valid,history:null as unknown as PaymentAttemptEvidence[] },
    { ...valid,history:[null as unknown as PaymentAttemptEvidence] },{ ...valid,history:new Array(1) as PaymentAttemptEvidence[] },
    { ...valid,history:[{ number:2,state:'RETRYABLE' }] },{ ...valid,history:[{ number:1,state:'RETRYABLE' },{ number:1,state:'UNKNOWN' }] },
    { ...valid,history:[{ number:1,state:'foreign' as PaymentAttemptEvidence['state'] }] },{ ...valid,nowMs:NaN },{ ...valid,firstDispatchMs:Infinity },
    { ...valid,policy:{ ...policy,retentionMs:policy.dispatchBudgetMs } },{ ...valid,policy:{ ...policy,maxAttempts:0 } },
    { ...valid,policy:{ ...policy,retryBaseMs:0 } },{ ...valid,policy:{ ...policy,retryMaxMs:1 } },{ ...valid,nowMs:1.5 }];
  for(const input of invalid) { assert.equal(paymentDispatchWindow(input).allowed,false);assert.equal(resolvePaymentAttempt(input).state,'NEEDS_ATTENTION'); }
  assert.equal(resolvePaymentAttempt(context(['RETRYABLE'],first-1)).state,'NEEDS_ATTENTION');
  for(const seconds of [-1,0,NaN,1.5,Number.MAX_SAFE_INTEGER])assert.equal(resolvePaymentAttempt(valid,seconds).state,'NEEDS_ATTENTION');
  assert.equal(resolvePaymentAttempt(valid,null,-1).state,'NEEDS_ATTENTION');assert.equal(resolvePaymentAttempt(context([])).state,'NEEDS_ATTENTION');
});
