import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { HttpError } from '../security.js';
import type { SourceValue } from './field-mapping.js';

type GenericEvent = { eventId: string; fields: SourceValue[] };
type IntakeContext = {
  organization_id: string; branch_id: string; campaign_id: string; connection_version: number;
  resource_id: string; schema_version: number; binding_id: string; binding_version: number;
  mapping_version: number; questions: { key: string }[];
};
const eventIdPattern=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const keyPattern=/^[a-z][a-z0-9_]{0,63}$/;

export function parseGenericSourceEvent(body: Buffer): GenericEvent {
  let value: unknown;
  try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)); }
  catch { throw new HttpError(400,'GENERIC_SOURCE_EVENT_INVALID'); }
  if (!value || typeof value!=='object' || Object.keys(value).length!==2 || !('eventId' in value) || !('fields' in value)
    || typeof value.eventId!=='string' || !eventIdPattern.test(value.eventId)
    || !value.fields || typeof value.fields!=='object' || Array.isArray(value.fields)) throw new HttpError(400,'GENERIC_SOURCE_EVENT_INVALID');
  const keys=Object.entries(value.fields);
  if (!keys.length || keys.length>100) throw new HttpError(400,'GENERIC_SOURCE_EVENT_INVALID');
  const fields=keys.map(([key,entry])=>{
    const values=Array.isArray(entry)?entry:[entry];
    if (!keyPattern.test(key) || !values.length || values.length>50 || values.some(item=>typeof item!=='string' || item.length>4096 || item.includes('\0')))
      throw new HttpError(400,'GENERIC_SOURCE_EVENT_INVALID');
    return {key,values:values as string[]};
  });
  return {eventId:value.eventId.toLowerCase(),fields};
}

// The receiver already locks the authenticated Connection and Branch before using this function.
export async function acceptGenericSourceEvent(tx:postgres.TransactionSql,c:{id:string;version:number},body:Buffer,signedAt:number) {
  const event=parseGenericSourceEvent(body);
  const digest=createHash('sha256').update(body).digest();
  const [prior]=await tx`SELECT s.id,r.connection_version,r.payload_hash FROM source_submission s
    JOIN generic_source_intake_receipt r ON r.submission_id=s.id WHERE s.connection_id=${c.id} AND s.external_event_id=${event.eventId}`;
  if (prior) {
    if (prior.connection_version!==c.version || !digest.equals(prior.payload_hash)) throw new HttpError(409,'GENERIC_SOURCE_EVENT_CONFLICT');
    return { id:prior.id,duplicate:true };
  }
  // Connection serializes source publications. A shared Campaign lock fences deactivation and field setup changes.
  await tx`SELECT k.id FROM source_campaign_binding b JOIN campaign k ON k.id=b.campaign_id
    WHERE b.connection_id=${c.id} AND b.active FOR SHARE OF k`;
  const context=await tx<IntakeContext[]>`SELECT * FROM generic_source_intake_context(${c.id})`;
  const target=context[0];
  if (context.length!==1 || !target) throw new HttpError(409,'SOURCE_WEBHOOK_INTAKE_NOT_READY');
  const allow=new Set(target.questions.map(question=>question.key));
  if (event.fields.some(field=>!allow.has(field.key))) throw new HttpError(400,'GENERIC_SOURCE_EVENT_FIELD_UNKNOWN');
  const [saved]=await tx`INSERT INTO source_submission(organization_id,branch_id,campaign_id,source_kind,connection_id,external_event_id,raw_payload,source_timestamp)
    VALUES(${target.organization_id},${target.branch_id},${target.campaign_id},'GENERIC_SOURCE',${c.id},${event.eventId},${tx.json(event)},to_timestamp(${signedAt})) RETURNING id`;
  await tx`INSERT INTO generic_source_intake_receipt(submission_id,connection_id,connection_version,schema_version,resource_id,binding_id,binding_version,mapping_version,
    signed_at,payload_hash) VALUES(${saved!.id},${c.id},${c.version},${target.schema_version},${target.resource_id},${target.binding_id},${target.binding_version},
    ${target.mapping_version},to_timestamp(${signedAt}),${digest})`;
  return {id:saved!.id,duplicate:false};
}
