import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentDispatchWindow,resolvePaymentAttempt,type PaymentDispatchPolicy,type PaymentAttemptEvidence } from '../src/payments/dispatch-policy.js';
const policy:PaymentDispatchPolicy={ writeReplay:'NEVER',retentionMs:null,maxAttempts:1,dispatchBudgetMs:30000,retryBaseMs:2000,retryMaxMs:60000 };
test('no provider idempotency guarantee permits one dispatch without inventing a retention window and forbids every subsequent write',()=> {
  assert.deepEqual(paymentDispatchWindow({ policy,nowMs:100000,firstDispatchMs:null,history:[] }),{ allowed:true,deadlineMs:null });
  for(const state of ['UNKNOWN','INTERRUPTED','RETRYABLE'] as const) {
    const context={ policy,nowMs:100000,firstDispatchMs:1000,history:[{ number:1,state }] };
    assert.deepEqual(paymentDispatchWindow(context),{ allowed:false,reason:'PAYMENT_DISPATCH_REPLAY_UNSUPPORTED',deadlineMs:null });
    const result=resolvePaymentAttempt(context,60);assert.notEqual(result.state,'RETRY');assert.equal(result.reason,'PAYMENT_DISPATCH_REPLAY_UNSUPPORTED');
    assert.equal(result.state,state==='RETRYABLE' ? 'FAILED' : 'NEEDS_ATTENTION');
  }
});
test('no-replay policy preserves ACK, blocks in-flight attempts and keeps unknowns visible across rejection and exhausted histories',()=> {
  const context={ policy,nowMs:100000,firstDispatchMs:1000,history:[{ number:1,state:'UNKNOWN' as PaymentAttemptEvidence['state'] }] };
  assert.equal(resolvePaymentAttempt({ ...context,history:[{ number:1,state:'REJECTED' }] }).state,'FAILED');
  assert.equal(resolvePaymentAttempt({ ...context,history:[{ number:1,state:'RUNNING' }] }).state,'NEEDS_ATTENTION');
  assert.equal(resolvePaymentAttempt({ ...context,history:[...context.history,{ number:2,state:'REJECTED' }] }).state,'NEEDS_ATTENTION');
  assert.equal(resolvePaymentAttempt({ ...context,policy:{ ...policy,maxAttempts:2 },history:[{ number:1,state:'ACKNOWLEDGED' }] }).state,'ACCEPTED');
});
test('no-replay rejects fake guarantee fields, extra attempts, clock corruption or sparse evidence while existing provider-key replay is unchanged',()=> {
  const context={ policy,nowMs:100000,firstDispatchMs:null,history:[] };
  for(const broken of [{ ...policy,maxAttempts:2 },{ ...policy,retentionMs:3600000 },{ ...policy,writeReplay:'PROVIDER_KEY' as const },{ ...policy,writeReplay:undefined }])
    assert.equal(paymentDispatchWindow({ ...context,policy:broken }).allowed,false);
  for(const history of [[{ number:2,state:'UNKNOWN' }],Array(1),[{ number:1,state:'BAD' }]] as unknown as PaymentAttemptEvidence[][])
    assert.equal(paymentDispatchWindow({ ...context,firstDispatchMs:1000,history }).allowed,false);
  assert.equal(paymentDispatchWindow({ ...context,nowMs:Number.MAX_SAFE_INTEGER }).allowed,false);
  const legacy={ maxAttempts:5,retentionMs:21600000,dispatchBudgetMs:20000,retryBaseMs:2000,retryMaxMs:60000 };
  const old={ ...context,policy:legacy,firstDispatchMs:1000,history:[{ number:1,state:'UNKNOWN' as const }] };
  assert.equal(resolvePaymentAttempt(old).state,'RETRY');assert.deepEqual(resolvePaymentAttempt(old),resolvePaymentAttempt({ ...old,policy:{ ...legacy,writeReplay:'PROVIDER_KEY' } }));
});
