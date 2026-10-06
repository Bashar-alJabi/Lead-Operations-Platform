import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedLinkRequest,paymentReturnTargets,preparationIssues,linkIntentDto } from '../src/payments/link-intent.js';

test('Link requests preserve exact canonical money and do not imply issuance or expose private snapshots',()=> {
  const input={ requestId:'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',methodId:'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',methodVersion:2,amount:'12.5',currency:'USD' };
  const normalized=normalizedLinkRequest(input,{ scale:2,quantum:'1' });assert.equal(normalized.requestId,input.requestId.toLowerCase());
  assert.equal(normalized.money.amount,'12.50');assert.equal(normalized.money.minor,'1250');
  assert.throws(()=>normalizedLinkRequest({ ...input,amount:'12.501' },{ scale:2,quantum:'1' }));
  const dto=linkIntentDto({ id:'opaque',method_name:'Name <img src=x>',method_version:2,amount:'12.50',currency:'USD',created_at:'date',
    ciphertext:'private',account_ref:'private',connection_id:'private',requester_session_id:'private' });
  assert.equal(dto.state,'QUEUED');assert.equal(dto.customerUrl,null);assert.equal(dto.paymentState,null);assert.equal(dto.enrollmentId,null);assert.equal(JSON.stringify(dto).includes('private'),false);
  assert.deepEqual(preparationIssues({ active:true,branch_active:true,connection_status:'WARNING',connection_version:2,
    capabilities:{ authenticationVerified:true,paymentOptionsVersion:2,paymentOptions:{ chargesEnabled:true } },webhook_ready:true }),[]);
  assert.ok(preparationIssues({ active:true,branch_active:true,connection_status:'WARNING',connection_version:2,
    capabilities:{ authenticationVerified:true,paymentOptionsVersion:1,paymentOptions:{ chargesEnabled:true } },webhook_ready:true }).includes('PAYMENT_OPTIONS_REQUIRED'));
});
test('Payment return targets use an approved deployment origin and never constitute a payment proof',()=> {
  const origin=process.env.APP_ORIGIN;const env=process.env.NODE_ENV;
  try {
    process.env.APP_ORIGIN='https://platform.example.test';process.env.NODE_ENV='production';
    assert.deepEqual(paymentReturnTargets(),{ successUrl:'https://platform.example.test/?paymentReturn=success',cancelUrl:'https://platform.example.test/?paymentReturn=cancel' });
    for(const bad of ['http://platform.example.test','https://user:secret@platform.example.test','https://platform.example.test/path','https://platform.example.test/?x=1','javascript:alert(1)','']) {
      process.env.APP_ORIGIN=bad;assert.throws(paymentReturnTargets);
    }
    process.env.APP_ORIGIN='http://127.0.0.1:4100';assert.throws(paymentReturnTargets);process.env.NODE_ENV='test';assert.ok(paymentReturnTargets().successUrl.startsWith(process.env.APP_ORIGIN));
  }finally { if(origin===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=origin;if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env; }
});
