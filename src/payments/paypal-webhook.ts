import { X509Certificate,verify,constants } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { HttpError } from '../security.js';
import { boundedResponse } from '../media/meta-provider.js';
import { paymentReceiptSemanticHash,type PaymentReceipt } from './webhook.js';
import type { PaymentConfig } from './providers.js';
const invalid=()=>new HttpError(403,'PAYMENT_WEBHOOK_SIGNATURE_INVALID');
function instant(value:unknown):number {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value))throw invalid();
  const ms=Date.parse(value);if(!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,19)!==value.slice(0,19))throw invalid();return ms;
}
export function paypalCertificateUrl(value:unknown,mode:PaymentConfig['mode']):string {
  if(typeof value!=='string' || value.length>512)throw invalid();let url:URL;try { url=new URL(value); }catch{ throw invalid(); }
  const hosts=mode==='TEST' ? ['api.sandbox.paypal.com','api-m.sandbox.paypal.com'] : mode==='LIVE' ? ['api.paypal.com','api-m.paypal.com'] : [];
  if(url.protocol!=='https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash
    || !/^\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]{1,128}$/.test(url.pathname) || url.toString()!==value)throw invalid();return value;
}
// Public certificates only, bounded per process. TLS authenticates the fixed PayPal origin; redirects are forbidden.
export class PayPalCertificateCache {
  private readonly entries=new Map<string,{ cert:X509Certificate;until:number }>();
  private readonly pending=new Map<string,Promise<X509Certificate>>();
  async read(url:string,now:number,mode:PaymentConfig['mode']):Promise<X509Certificate> {
    paypalCertificateUrl(url,mode);if(!Number.isFinite(now))throw invalid();
    const cached=this.entries.get(url);if(cached && now<cached.until) { this.entries.delete(url);this.entries.set(url,cached);return cached.cert; }
    this.entries.delete(url);const running=this.pending.get(url);if(running)return running;
    if(this.pending.size>=16)throw new HttpError(503,'PAYMENT_CERTIFICATE_BUSY');
    const promise=this.download(url,now);this.pending.set(url,promise);
    try { return await promise; }finally { this.pending.delete(url); }
  }
  private async download(url:string,now:number):Promise<X509Certificate> {
    let response:Response;try { response=await fetch(url,{ method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{ accept:'application/x-pem-file' } }); }
    catch { throw new HttpError(503,'PAYMENT_CERTIFICATE_UNAVAILABLE'); }
    if(!response.ok)throw new HttpError(503,'PAYMENT_CERTIFICATE_UNAVAILABLE');
    let cert:X509Certificate;
    try { const pem=new TextDecoder('utf-8',{ fatal:true }).decode(await boundedResponse(response,16384));
      if(!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(pem) || (pem.match(/BEGIN CERTIFICATE/g) ?? []).length!==1)throw invalid();
      cert=new X509Certificate(pem);const bits=cert.publicKey.asymmetricKeyDetails?.modulusLength;
      if(cert.publicKey.asymmetricKeyType!=='rsa' || !bits || bits<2048 || bits>8192 || now<cert.validFromDate.getTime() || now>=cert.validToDate.getTime())throw invalid();
    }catch { throw invalid(); }
    if(this.entries.size>=128)this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(url,{ cert,until:Math.min(now+3600000,cert.validToDate.getTime()) });return cert;
  }
}
const certificates=new PayPalCertificateCache();
export async function verifyPayPalPaymentSignature(raw:Buffer,headers:Record<string,unknown>,webhookId:string,mode:PaymentConfig['mode'],nowSeconds:number,cache=certificates):Promise<void> {
  const id=headers['paypal-transmission-id'];const stamp=headers['paypal-transmission-time'];const signature=headers['paypal-transmission-sig'];
  if(!Buffer.isBuffer(raw) || raw.length>65536 || !/^[A-Z0-9]{8,64}$/.test(webhookId) || !Number.isFinite(nowSeconds)
    || typeof id!=='string' || !/^[A-Za-z0-9-]{1,128}$/.test(id) || headers['paypal-auth-algo']!=='SHA256withRSA'
    || typeof signature!=='string' || signature.length>1400 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature))throw invalid();
  const time=instant(stamp);const now=nowSeconds*1000;
  // Bound replay age while admitting the documented three-day delivery retry period; creation time is separate.
  if(now-time>72*3600000 || time-now>300000)throw invalid();
  const decoded=Buffer.from(signature,'base64');if(decoded.toString('base64')!==signature)throw invalid();
  const url=paypalCertificateUrl(headers['paypal-cert-url'],mode);const cert=await cache.read(url,now,mode);
  if(now<cert.validFromDate.getTime() || now>=cert.validToDate.getTime() || decoded.length!==cert.publicKey.asymmetricKeyDetails!.modulusLength!/8)throw invalid();
  const message=String(id)+'|'+String(stamp)+'|'+webhookId+'|'+crc32(raw);
  if(!verify('RSA-SHA256',Buffer.from(message),{ key:cert.publicKey,padding:constants.RSA_PKCS1_PADDING },decoded))throw invalid();
}
export function parsePayPalPaymentReceipt(raw:Buffer,mode:PaymentConfig['mode']):PaymentReceipt {
  let text:string;let event:Record<string,unknown>;
  try { if(raw.length>65536)throw invalid();text=new TextDecoder('utf-8',{ fatal:true }).decode(raw);event=JSON.parse(text); }
  catch { throw new HttpError(400,'PAYMENT_WEBHOOK_PAYLOAD_INVALID'); }
  const resource=event?.resource as Record<string,unknown>|null;let created:number;
  try { created=instant(event?.create_time)/1000; }catch{ throw new HttpError(400,'PAYMENT_WEBHOOK_PAYLOAD_INVALID'); }
  if(!event || Array.isArray(event) || typeof event.id!=='string' || !/^WH-[A-Z0-9-]{5,180}$/.test(event.id)
    || typeof event.event_type!=='string' || !/^[A-Z][A-Z0-9_.-]{1,127}$/.test(event.event_type)
    || !['TEST','LIVE'].includes(mode) || typeof event.resource_type!=='string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(event.resource_type)
    || !resource || typeof resource!=='object' || Array.isArray(resource) || typeof resource.id!=='string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(resource.id))
    throw new HttpError(400,'PAYMENT_WEBHOOK_PAYLOAD_INVALID');
  const objectType=event.resource_type.replaceAll('-','.');
  if((event.event_type.startsWith('PAYMENT.CAPTURE.') && objectType!=='capture')
    || (event.event_type==='CHECKOUT.ORDER.APPROVED' && objectType!=='checkout.order'))throw new HttpError(400,'PAYMENT_WEBHOOK_PAYLOAD_INVALID');
  return { externalId:event.id,type:event.event_type,objectId:resource.id,objectType,created,mode,raw:text!,
    semanticHash:paymentReceiptSemanticHash({ id:event.id,event_type:event.event_type,create_time:event.create_time,resource_type:event.resource_type,resource }) };
}
