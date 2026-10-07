// Public, synthetic test-only signing key. No provider account or real credentials.
import { readFile } from 'node:fs/promises';
import { sign,X509Certificate } from 'node:crypto';
import { crc32 } from 'node:zlib';
export const testPayPalCertificate=await readFile('test/fixtures/paypal-test-only-certificate.pem','utf8');
const key=await readFile('test/fixtures/paypal-test-only-key.pem','utf8');
export const testPayPalInstant=Math.max(Date.now(),new X509Certificate(testPayPalCertificate).validFromDate.getTime()+1000);
export const testPayPalCertUrl='https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-SYNTHETIC-ONLY';
export function testPayPalHeaders(raw:Buffer,webhookId:string,time=new Date(testPayPalInstant).toISOString(),certUrl=testPayPalCertUrl) {
  const id='synthetic-transmission-123';const message=id+'|'+time+'|'+webhookId+'|'+crc32(raw);
  return { 'content-type':'application/json','paypal-transmission-id':id,'paypal-transmission-time':time,
    'paypal-transmission-sig':sign('RSA-SHA256',Buffer.from(message),key).toString('base64'),
    'paypal-auth-algo':'SHA256withRSA','paypal-cert-url':certUrl };
}
export function testPayPalEvent(id='WH-SYNTHETIC-EVENT-123') {
  return { id,event_type:'PAYMENT.CAPTURE.COMPLETED',resource_type:'capture',create_time:'2024-05-16T05:19:19.355Z',
    resource:{ id:'SYNTHETICCAPTURE123',status:'COMPLETED',amount:{ value:'25.00',currency_code:'USD' },
      payee:{ merchant_id:'SYNTHETICMERCHANT123',email_address:'private-buyer@fixture.test' },
      supplementary_data:{ related_ids:{ order_id:'SYNTHETICORDER123' } } } };
}
