import test from 'node:test';
import assert from 'node:assert/strict';
import { almaNotificationResource,paymentNotificationUrl,paymentNotificationAdmissionLimit } from '../src/payments/notifications.js';
test('Alma notification accepts only bounded opaque payment reference, not money or a customer claim',()=> {
  assert.equal(almaNotificationResource('payment_A123'),'payment_A123');assert.equal(almaNotificationResource('payment_'+'a'.repeat(120)).length,128);
  for(const value of [null,{},['payment_a'],'paid','payment_','payment_a\n','payment_../a','payment_'+'a'.repeat(121)])assert.throws(()=>almaNotificationResource(value),/PAYMENT_NOTIFICATION_RESOURCE_INVALID/);
});
test('Notification callback uses configured safe origin and explicit profile without secrets or guessed public URL',()=> {
  const origin=process.env.APP_ORIGIN;const environment=process.env.NODE_ENV;const id='12345678-1234-1234-1234-123456789012';
  try {
    process.env.NODE_ENV='test';for(const value of ['http://127.0.0.1:4100','http://localhost:5173','http://[::1]:4100','https://app.example.test']) {
      process.env.APP_ORIGIN=value;assert.equal(paymentNotificationUrl(id),value+'/api/webhooks/payments/alma/'+id);
    }
    for(const value of ['', 'https://user:secret@app.example.test','https://app.example.test?secret=x','https://app.example.test/path','https://app.example.test#x','http://remote.test','https://app.example.test:8443','ftp://app.example.test']) {
      process.env.APP_ORIGIN=value;assert.throws(()=>paymentNotificationUrl(id),/PAYMENT_CALLBACK_ORIGIN_NOT_CONFIGURED/);
    }
    process.env.APP_ORIGIN='http://127.0.0.1:4100';process.env.NODE_ENV='production';assert.throws(()=>paymentNotificationUrl(id),/PAYMENT_CALLBACK_ORIGIN_NOT_CONFIGURED/);
    process.env.APP_ORIGIN='https://app.example.test';assert.throws(()=>paymentNotificationUrl(id,'STRIPE'),/PAYMENT_NOTIFICATION_PROFILE_INVALID/);
    assert.throws(()=>paymentNotificationUrl('../payment'),/PAYMENT_NOTIFICATION_PROFILE_INVALID/);
  }finally { if(origin===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=origin;if(environment===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=environment; }
});
test('Notification hourly admission bound is technical, configurable, finite and fail-closed',()=> {
  const previous=process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT;try {
    delete process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT;assert.equal(paymentNotificationAdmissionLimit(),600);
    process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT='1';assert.equal(paymentNotificationAdmissionLimit(),1);
    for(const value of ['', '0','-1','1.5','Infinity','10001','unknown']) { process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT=value;assert.throws(()=>paymentNotificationAdmissionLimit(),/PAYMENT_NOTIFICATION_LIMIT_NOT_CONFIGURED/); }
  }finally { if(previous===undefined)delete process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT;else process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT=previous; }
});
