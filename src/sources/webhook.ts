import { createHmac,timingSafeEqual } from 'node:crypto';
import { HttpError } from '../security.js';

export function sourceSecretEqual(actual:string,expected:string):boolean {
  const a=Buffer.from(actual);const b=Buffer.from(expected);return a.length===b.length && timingSafeEqual(a,b);
}
export function verifySourceSignature(raw:Buffer,signature:unknown,secret:string):void {
  if (typeof signature!=='string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) throw new HttpError(403,'SOURCE_WEBHOOK_SIGNATURE_INVALID');
  const expected=createHmac('sha256',secret).update(raw).digest();
  if (!timingSafeEqual(Buffer.from(signature.slice(7),'hex'),expected)) throw new HttpError(403,'SOURCE_WEBHOOK_SIGNATURE_INVALID');
}
function record(value:unknown):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new HttpError(400,'SOURCE_WEBHOOK_PAYLOAD_INVALID');
  return value as Record<string,unknown>;
}
function identity(value:unknown):string {
  // Numeric identifiers in JSON can already have lost precision. Never coerce them.
  if (typeof value!=='string' || !/^\d{1,30}$/.test(value)) throw new HttpError(400,'SOURCE_WEBHOOK_PAYLOAD_INVALID');return value;
}
function epoch(value:unknown):number {
  if (!Number.isSafeInteger(value) || (value as number)<946684800 || (value as number)>4102444800)
    throw new HttpError(400,'SOURCE_WEBHOOK_PAYLOAD_INVALID');return value as number;
}
export type SourceNotification={ pageId:string;formId:string;leadId:string;createdAt:string;raw:Record<string,unknown> };
export function parseSourceWebhook(body:unknown):SourceNotification[] {
  const root=record(body);
  if (root.object!=='page' || !Array.isArray(root.entry) || !root.entry.length || root.entry.length>100)
    throw new HttpError(400,'SOURCE_WEBHOOK_PAYLOAD_INVALID');
  const events:SourceNotification[]=[];
  for (const rawEntry of root.entry) {
    const entry=record(rawEntry);const pageId=identity(entry.id);const time=epoch(entry.time);
    if (!Array.isArray(entry.changes) || !entry.changes.length || entry.changes.length>100) throw new HttpError(400,'SOURCE_WEBHOOK_PAYLOAD_INVALID');
    for (const rawChange of entry.changes) {
      const change=record(rawChange);const value=record(change.value);
      if (change.field!=='leadgen' || identity(value.page_id)!==pageId) throw new HttpError(400,'SOURCE_WEBHOOK_SCOPE_INVALID');
      const formId=identity(value.form_id);const leadId=identity(value.leadgen_id);const createdAt=new Date(epoch(value.created_time)*1000).toISOString();
      for (const key of ['ad_id','adgroup_id','adset_id','campaign_id']) if (value[key]!=null) identity(value[key]);
      // Preserve the notification, including opaque legacy adgroup_id. Retrieval resolves actual Ad Set/Campaign IDs later.
      const raw={ pageId,entryTime:time,change };
      if (Buffer.byteLength(JSON.stringify(raw))>32768 || events.length>=100) throw new HttpError(400,'SOURCE_WEBHOOK_PAYLOAD_TOO_LARGE');
      events.push({ pageId,formId,leadId,createdAt,raw });
    }
  }
  return events;
}
