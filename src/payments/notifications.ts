import { HttpError } from '../security.js';
export const almaNotificationProfile='ALMA_IPN_GET_V1';
// Technical admission bound per connection/hour; repeated resources consume no new slot.
export function paymentNotificationAdmissionLimit():number {
  const value=Number(process.env.PAYMENT_NOTIFICATION_HOURLY_LIMIT ?? '600');
  if(!Number.isSafeInteger(value) || value<1 || value>10000)throw new HttpError(503,'PAYMENT_NOTIFICATION_LIMIT_NOT_CONFIGURED');return value;
}
export function almaNotificationResource(value:unknown):string {
  if(typeof value!=='string' || !/^payment_[A-Za-z0-9]{1,120}$/.test(value))throw new HttpError(400,'PAYMENT_NOTIFICATION_RESOURCE_INVALID');return value;
}
export function paymentNotificationUrl(id:string,profile=almaNotificationProfile):string {
  if(profile!==almaNotificationProfile || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw new HttpError(400,'PAYMENT_NOTIFICATION_PROFILE_INVALID');
  let url:URL;try { url=new URL(process.env.APP_ORIGIN ?? ''); }catch { throw new HttpError(503,'PAYMENT_CALLBACK_ORIGIN_NOT_CONFIGURED'); }
  if(url.username || url.password || url.search || url.hash || url.pathname!=='/' || !['http:','https:'].includes(url.protocol) || url.origin.length>1900
    || (url.protocol==='https:' && !!url.port) || (url.protocol==='http:' && (process.env.NODE_ENV==='production' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new HttpError(503,'PAYMENT_CALLBACK_ORIGIN_NOT_CONFIGURED');
  return url.origin+'/api/webhooks/payments/alma/'+id;
}
