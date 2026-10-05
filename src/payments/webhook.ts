import { createHash,createHmac,timingSafeEqual } from 'node:crypto';
import { HttpError } from '../security.js';
import { PaymentProviderError,stripePaymentEvents,type PaymentWebhookInspection } from './providers.js';

export function validateStripeWebhookSecret(secret:string):void {
  if(typeof secret!=='string' || !/^whsec_[A-Za-z0-9]{16,200}$/.test(secret))throw new HttpError(400,'PAYMENT_WEBHOOK_SECRET_INVALID');
}
export function verifyStripePaymentSignature(raw:Buffer,header:unknown,secret:string,nowSeconds:number):void {
  // Fresh signature time, not event.created: provider retries may deliver old events legitimately.
  if(typeof header!=='string' || header.length>4096)throw new HttpError(403,'PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  const parts=header.split(',').map((part)=>part.trim());const times=parts.filter((part)=>part.startsWith('t='));
  const signatures=parts.filter((part)=>/^v1=[a-f0-9]{64}$/i.test(part)).map((part)=>Buffer.from(part.slice(3),'hex'));
  if(times.length!==1 || !/^t=\d{1,12}$/.test(times[0]!) || signatures.length<1 || signatures.length>20
    || !Number.isFinite(nowSeconds) || Math.abs(nowSeconds-Number(times[0]!.slice(2)))>300)throw new HttpError(403,'PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  const expected=createHmac('sha256',secret).update(times[0]!.slice(2)+'.').update(raw).digest();
  if(!signatures.some((candidate)=>timingSafeEqual(expected,candidate)))throw new HttpError(403,'PAYMENT_WEBHOOK_SIGNATURE_INVALID');
}
export function checkedWebhookInspection(value:PaymentWebhookInspection,expected:{ mode:string;endpointId:string;callbackUrl:string }):PaymentWebhookInspection {
  if(!value || typeof value!=='object' || value.mode!==expected.mode)throw new PaymentProviderError('PAYMENT_MODE_MISMATCH');
  if(value.endpointId!==expected.endpointId || value.url!==expected.callbackUrl)throw new PaymentProviderError('PAYMENT_WEBHOOK_ENDPOINT_MISMATCH');
  if(value.enabled!==true)throw new PaymentProviderError('PAYMENT_WEBHOOK_ENDPOINT_DISABLED');
  if(!Array.isArray(value.enabledEvents) || value.enabledEvents.length<1 || value.enabledEvents.length>256
    || value.enabledEvents.some((e)=>typeof e!=='string' || !/^(\*|[a-z][a-z0-9_.]{1,127})$/.test(e)))throw new PaymentProviderError('PAYMENT_PROVIDER_RESPONSE_INVALID');
  const events=[...new Set(value.enabledEvents)].sort();
  if(!events.includes('*') && stripePaymentEvents.some((e)=>!events.includes(e)))throw new PaymentProviderError('PAYMENT_WEBHOOK_EVENTS_MISSING');
  return { mode:value.mode,endpointId:value.endpointId,url:value.url,enabled:true,enabledEvents:events };
}
export type PaymentReceipt={ externalId:string;type:string;objectId:string;objectType:string;created:number;mode:'TEST'|'LIVE';semanticHash:Buffer;raw:string };
function canonical(value:unknown,depth=0):unknown {
  if(depth>24)throw new HttpError(400,'PAYMENT_WEBHOOK_PAYLOAD_INVALID');
  if(Array.isArray(value))return value.map((v)=>canonical(v,depth+1));
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b ? -1 : a>b ? 1 : 0).map(([k,v])=>[k,canonical(v,depth+1)]));
  return value;
}
export function parseStripePaymentReceipt(raw:Buffer,mode:string):PaymentReceipt {
  let text:string;let event:Record<string,unknown>;
  try { text=new TextDecoder('utf-8',{ fatal:true }).decode(raw);event=JSON.parse(text); }catch{ throw new HttpError(400,'PAYMENT_WEBHOOK_PAYLOAD_INVALID'); }
  if(!event || typeof event!=='object' || Array.isArray(event) || event.object!=='event' || typeof event.id!=='string' || !/^evt_[A-Za-z0-9]{6,100}$/.test(event.id)
    || typeof event.type!=='string' || !/^[a-z][a-z0-9_.]{1,127}$/.test(event.type) || typeof event.livemode!=='boolean'
    || !Number.isSafeInteger(event.created) || (event.created as number)<0 || (event.created as number)>253402300799
    || !event.data || typeof event.data!=='object' || Array.isArray(event.data))throw new HttpError(400,'PAYMENT_WEBHOOK_PAYLOAD_INVALID');
  // This profile accepts snapshot events from Your account; Connect/thin destinations need their own adapter scope.
  if(event.account!=null || event.context!=null)throw new HttpError(400,'PAYMENT_WEBHOOK_ACCOUNT_SCOPE_INVALID');
  const actualMode=event.livemode ? 'LIVE' : 'TEST';if(actualMode!==mode)throw new HttpError(400,'PAYMENT_MODE_MISMATCH');
  const object=(event.data as { object?:unknown }).object as Record<string,unknown>|null;
  if(!object || typeof object!=='object' || Array.isArray(object) || typeof object.id!=='string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(object.id)
    || typeof object.object!=='string' || !/^[a-z][a-z0-9_.]{1,63}$/.test(object.object))throw new HttpError(400,'PAYMENT_WEBHOOK_PAYLOAD_INVALID');
  if(stripePaymentEvents.includes(event.type as typeof stripePaymentEvents[number]) && (object.object!=='checkout.session' || !/^cs_(test_|live_)?[A-Za-z0-9]{6,120}$/.test(object.id)))
    throw new HttpError(400,'PAYMENT_WEBHOOK_PAYLOAD_INVALID');
  const semanticHash=createHash('sha256').update(JSON.stringify(canonical({ id:event.id,type:event.type,created:event.created,livemode:event.livemode,data:event.data }))).digest();
  return { externalId:event.id,type:event.type,objectId:object.id,objectType:object.object,created:event.created as number,mode:actualMode,semanticHash,raw:text! };
}
