import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';import type {FastifyRequest} from 'fastify';import type {Database} from '../db.js';
import {HttpError,type Principal} from '../security.js';import {bulkHash} from '../bulk-actions.js';import {exportSession} from '../exports/service.js';
import {ownedGoogleExport,visibleGoogleExport} from './export-preparation.js';
type Tx=postgres.TransactionSql;type Row=postgres.Row;
export type DeliveryApproval={version:number;requestId:string;reason:string;confirmed:true};
export function googleDeliveryReceipt(d:Row){return {id:d.id,state:d.state,version:d.version,verifiedRows:d.verified_rows,attempted:d.attempt_at!==null,
 failures:d.failures,errorCode:d.error_code,reason:d.reason,createdAt:d.created_at};}
function reason(value:string){if(value.trim().length<3)throw new HttpError(400,'GOOGLE_EXPORT_REASON_REQUIRED');return value.trim();}
async function lockPrepared(tx:Tx,actor:Principal,request:FastifyRequest,id:string){
 const found=(await tx`SELECT connection_id FROM google_export_job WHERE id=${id} AND actor_id=${actor.id} AND organization_id=${actor.organizationId}`)[0];
 if(!found)throw new HttpError(404,'GOOGLE_EXPORT_NOT_FOUND');await tx`SELECT id FROM integration_connection WHERE id=${found.connection_id} FOR UPDATE`;
 const sid=await exportSession(tx,actor,request),j=await ownedGoogleExport(tx,actor,id,true);return {sid,j};
}
export async function approveGoogleExportDelivery(db:Database,actor:Principal,request:FastifyRequest,id:string,input:DeliveryApproval){
 if(input.confirmed!==true)throw new HttpError(400,'GOOGLE_EXPORT_DELIVERY_CONFIRMATION_REQUIRED');
 const why=reason(input.reason),hash=bulkHash({preparedId:id,version:input.version,reason:why});
 return db.begin(async tx=>{
  const {sid,j}=await lockPrepared(tx,actor,request,id);await visibleGoogleExport(tx,actor,j);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id+':google-delivery:'+input.requestId},0))`;
  const old=(await tx`SELECT * FROM google_export_delivery WHERE actor_id=${actor.id} AND request_id=${input.requestId}`)[0];
  if(old){if(old.job_id!==id||!Buffer.from(old.request_hash).equals(hash))throw new HttpError(409,'GOOGLE_EXPORT_DELIVERY_INTENT_CONFLICT');await exportSession(tx,actor,request);return googleDeliveryReceipt(old);}
  if((await tx`SELECT 1 FROM google_export_delivery WHERE job_id=${id}`).length)throw new HttpError(409,'GOOGLE_EXPORT_DELIVERY_ALREADY_APPROVED');
  if(j.state!=='READY'||j.version!==input.version)throw new HttpError(409,'GOOGLE_EXPORT_PREVIEW_CHANGED');
  const deliveryId=randomUUID();await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
   VALUES(${actor.organizationId},${actor.branchId},${actor.id},'GOOGLE_EXPORT_DELIVERY_APPROVED','GOOGLE_EXPORT_DELIVERY',${deliveryId},${tx.json({preparedId:id,sessionId:sid,requestId:input.requestId})})`;
  const [d]=await tx`INSERT INTO google_export_delivery(id,job_id,actor_id,approval_session_id,request_id,request_hash,payload_version,payload_sha256,reason)
   VALUES(${deliveryId},${id},${actor.id},${sid},${input.requestId},${hash},${j.version},sha256(convert_to(google_export_expected_grid(${id},0,${j.expected_rows+1})::text,'UTF8')),${why}) RETURNING *`;
  await exportSession(tx,actor,request);return googleDeliveryReceipt(d!);
 });
}
export async function getGoogleExportDelivery(db:Database,actor:Principal,request:FastifyRequest,id:string,before:number|null=null){
 return db.begin(async tx=>{
  await exportSession(tx,actor,request);const j=await ownedGoogleExport(tx,actor,id);await visibleGoogleExport(tx,actor,j);
  const d=(await tx`SELECT * FROM google_export_delivery WHERE job_id=${id} AND actor_id=${actor.id}`)[0];if(!d)return {delivery:null,history:[],nextHistoryVersion:null};
  const history=await tx`SELECT version,state,verified_rows,failures,attempt_at IS NOT NULL attempted,error_code,reason,created_at
   FROM google_export_delivery_history WHERE delivery_id=${d.id} AND (${before}::integer IS NULL OR version<${before}::integer) ORDER BY version DESC LIMIT 21`;
  await exportSession(tx,actor,request);return {delivery:googleDeliveryReceipt(d),history:history.slice(0,20),nextHistoryVersion:history.length>20?history[19]!.version:null};
 });
}
export async function changeGoogleExportDelivery(db:Database,actor:Principal,request:FastifyRequest,id:string,input:{version:number;reason:string},cancel:boolean){
 const why=reason(input.reason);return db.begin(async tx=>{
  const {sid,j}=await lockPrepared(tx,actor,request,id),d=(await tx`SELECT * FROM google_export_delivery WHERE job_id=${id} AND actor_id=${actor.id} FOR UPDATE`)[0];
  if(!d)throw new HttpError(404,'GOOGLE_EXPORT_DELIVERY_NOT_FOUND');if(d.version!==input.version)throw new HttpError(409,'GOOGLE_EXPORT_DELIVERY_VERSION_CONFLICT');
  if(['DONE','CANCELLED','EXPIRED'].includes(d.state))throw new HttpError(409,'GOOGLE_EXPORT_DELIVERY_NOT_RECOVERABLE');
  if(cancel){if(d.attempt_at!==null||['SENDING','READING'].includes(d.state))throw new HttpError(409,'GOOGLE_EXPORT_WRITE_CANNOT_BE_RETRACTED');}
  else{if(!['NEEDS_ATTENTION','DEAD_LETTER','UNKNOWN'].includes(d.state))throw new HttpError(409,'GOOGLE_EXPORT_DELIVERY_NOT_RECOVERABLE');await visibleGoogleExport(tx,actor,j);}
  await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail)
   VALUES(${actor.organizationId},${actor.branchId},${actor.id},${cancel?'GOOGLE_EXPORT_DELIVERY_CANCELLED':'GOOGLE_EXPORT_DELIVERY_RECOVERED'},'GOOGLE_EXPORT_DELIVERY',${d.id},${tx.json({sessionId:sid})})`;
  const [updated]=await tx`UPDATE google_export_delivery SET state=${cancel?'CANCELLED':d.attempt_at===null?'WAITING':'VERIFYING'},version=version+1,
   approval_session_id=${sid},reason=${why},failures=0,error_code=NULL,lease_token=NULL,lease_until=NULL,next_run_at=clock_timestamp() WHERE id=${d.id} RETURNING *`;
  await exportSession(tx,actor,request);return googleDeliveryReceipt(updated!);
 });
}
