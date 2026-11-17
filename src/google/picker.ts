import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import type {FastifyRequest} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,type Principal} from '../security.js';
import {openOpaque} from '../credentials.js';
import {currentPaymentSession} from '../payments/access.js';
import {googleConnection,googleSession,googleSetup} from './connections.js';
import {GoogleSheetsError,type GoogleSheetsAdapter,type GoogleSpreadsheet} from './sheets.js';
type Tx=postgres.TransactionSql;type Row=postgres.Row;
function token(g:Row){const s=g.result;const value=JSON.parse(openOpaque('google-result:'+g.id,{ciphertext:Buffer.from(s.ciphertext,'base64'),nonce:Buffer.from(s.nonce,'base64'),authTag:Buffer.from(s.authTag,'base64'),keyVersion:s.keyVersion}));
 if(typeof value.accessToken!=='string'||!/^[A-Za-z0-9._~+/-]+=*$/.test(value.accessToken)||value.accessToken.length>8192)throw new HttpError(409,'GOOGLE_ACTIVE_GRANT_REQUIRED');return value.accessToken as string;
}
async function current(tx:Tx,id:string){return (await tx`SELECT google_picker_context_current(t) AS current,expires_at<=clock_timestamp() AS expired FROM google_picker_ticket t WHERE id=${id}`)[0]!;}
async function grant(tx:Tx,c:Row,id:string){const g=(await tx`SELECT *,access_expires_at>clock_timestamp()+interval '30 seconds' AS usable FROM google_oauth_operation WHERE id=${id} AND connection_id=${c.id} AND connection_version=${c.version} AND state='VERIFIED' FOR SHARE`)[0];
 if(c.status!=='CONNECTED'||c.capabilities.grantId!==id||!g)throw new HttpError(409,'GOOGLE_ACTIVE_GRANT_REQUIRED');if(!g.usable)throw new HttpError(409,'GOOGLE_TOKEN_REFRESH_REQUIRED');return g;
}
async function own(tx:Tx,actor:Principal,request:FastifyRequest,id:string){
 const found=(await tx`SELECT connection_id FROM google_picker_ticket WHERE id=${id}`)[0];if(!found)throw new HttpError(404,'GOOGLE_PICKER_TICKET_NOT_FOUND');
 const c=await googleConnection(tx,actor,found.connection_id,true),session=await googleSession(tx,actor,request),t=(await tx`SELECT * FROM google_picker_ticket WHERE id=${id} FOR UPDATE`)[0]!;
 if(t.actor_id!==actor.id||t.session_id!==session||t.actor_role!==actor.role||t.actor_branch_id!==actor.branchId)throw new HttpError(403,'GOOGLE_ORIGINAL_SESSION_REQUIRED');return {c,t};
}
function receipt(t:Row){return {id:t.id,state:t.state,attempts:t.attempts,expiresAt:t.expires_at,errorCode:t.error_code,retryable:t.retryable,spreadsheetId:t.spreadsheet_id,resourceId:t.resource_id,resourceVersion:t.resource_version,
 openUrl:googleSetup().returnUrl+'api/google/picker/tickets/'+t.id+'/open'};}
async function rejectStale(tx:Tx,t:Row,allowFailedRetry=false){const ctx=await current(tx,t.id);if(ctx.current&&(!ctx.expired||allowFailedRetry&&t.state==='FAILED'))return null;
 if(['WAITING','PICKING','VERIFYING'].includes(t.state)||t.state==='FAILED'&&t.retryable){const state=ctx.expired&&t.state!=='FAILED'?'EXPIRED':'SUPERSEDED';
  await tx`UPDATE google_picker_ticket SET state=${state},version=version+1,error_code=${state==='EXPIRED'?'GOOGLE_PICKER_TICKET_EXPIRED':'GOOGLE_PICKER_CONTEXT_CHANGED'},retryable=false WHERE id=${t.id}`;
 }return ctx.expired?'GOOGLE_PICKER_TICKET_EXPIRED':'GOOGLE_PICKER_CONTEXT_CHANGED';
}
export async function beginGooglePicker(db:Database,actor:Principal,request:FastifyRequest,id:string,p:{connectionVersion:number;settingsVersion:number;requestId:string;locale:'ar'|'en'|'fr'}){
 return db.begin(async tx=>{
  const c=await googleConnection(tx,actor,id,true),session=await googleSession(tx,actor,request);
  const old=(await tx`SELECT * FROM google_picker_ticket WHERE actor_id=${actor.id} AND session_id=${session} AND request_id=${p.requestId}`)[0];
  if(old){if(old.connection_id!==id||old.connection_version!==p.connectionVersion||old.settings_version!==p.settingsVersion||old.locale!==p.locale)throw new HttpError(409,'GOOGLE_PICKER_REQUEST_REUSED');
   if(old.actor_role!==actor.role||old.actor_branch_id!==actor.branchId)throw new HttpError(403,'GOOGLE_ORIGINAL_SESSION_REQUIRED');return receipt(old);}
  if(c.version!==p.connectionVersion)throw new HttpError(409,'GOOGLE_VERSION_CONFLICT');const s=(await tx`SELECT version FROM google_picker_settings WHERE connection_id=${id} FOR SHARE`)[0];
  if(!s||s.version!==p.settingsVersion)throw new HttpError(409,'GOOGLE_PICKER_VERSION_CONFLICT');await grant(tx,c,c.capabilities.grantId??'00000000-0000-0000-0000-000000000000');
  if(c.branch_id&&!(await tx`SELECT 1 FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length)throw new HttpError(409,'GOOGLE_BRANCH_DISABLED');
  const pending=await tx`SELECT *,expires_at<=clock_timestamp() AS expired FROM google_picker_ticket WHERE connection_id=${id} AND actor_id=${actor.id} AND session_id=${session} AND state IN ('WAITING','PICKING','VERIFYING') FOR UPDATE`;
  for(const t of pending){if(t.state==='VERIFYING'&&!t.expired)throw new HttpError(409,'GOOGLE_OPERATION_IN_PROGRESS');await tx`UPDATE google_picker_ticket SET state=${t.expired?'EXPIRED':'SUPERSEDED'},version=version+1,error_code=${t.expired?'GOOGLE_PICKER_TICKET_EXPIRED':'GOOGLE_NEW_SELECTION'},retryable=false WHERE id=${t.id}`;}
  const t=(await tx`INSERT INTO google_picker_ticket(connection_id,connection_version,settings_version,grant_id,request_id,actor_id,session_id,actor_role,actor_branch_id,locale)
   VALUES(${id},${c.version},${s.version},${c.capabilities.grantId},${p.requestId},${actor.id},${session},${actor.role},${actor.branchId},${p.locale}) RETURNING *`)[0]!;return receipt(t);
 });
}
export async function googlePickerStatus(db:Database,actor:Principal,request:FastifyRequest,id:string){return db.begin(async tx=>{const {t}=await own(tx,actor,request,id),ctx=await current(tx,id);return {...receipt(t),current:ctx.current,expired:ctx.expired,locale:t.locale as 'ar'|'en'|'fr'};});}
export async function googlePickerBootstrap(db:Database,actor:Principal,request:FastifyRequest,id:string){
 const result=await db.begin(async tx=>{
  const {c,t}=await own(tx,actor,request,id);if(!['WAITING','PICKING'].includes(t.state))throw new HttpError(409,'GOOGLE_PICKER_NOT_OPEN');
  const stale=await rejectStale(tx,t);if(stale)return {error:stale};const g=await grant(tx,c,t.grant_id),s=(await tx`SELECT * FROM google_picker_settings WHERE connection_id=${c.id} FOR SHARE`)[0]!;
  if(t.state==='WAITING')await tx`UPDATE google_picker_ticket SET state='PICKING',version=version+1 WHERE id=${id}`;
  else await tx`INSERT INTO audit_log(organization_id,branch_id,actor_user_id,action,target_type,target_id,detail) VALUES(${c.organization_id},${c.branch_id},${actor.id},'GOOGLE_PICKER_BOOTSTRAP_REPLAY','GOOGLE_CONNECTION',${c.id},${tx.json({ticketId:id})})`;
  return {accessToken:token(g),apiKey:openOpaque('google-picker:'+c.id,{ciphertext:s.ciphertext,nonce:s.nonce,authTag:s.auth_tag,keyVersion:s.key_version}),appId:s.project_number as string,
   expiresAt:g.access_expires_at,origin:new URL(googleSetup().returnUrl).origin,locale:t.locale as 'ar'|'en'|'fr'};
 });if('error' in result)throw new HttpError(409,result.error!);return result;
}
export async function cancelGooglePicker(db:Database,actor:Principal,request:FastifyRequest,id:string){return db.begin(async tx=>{
 const {t}=await own(tx,actor,request,id);if(t.state==='CANCELLED')return receipt(t);if(!['WAITING','PICKING'].includes(t.state))throw new HttpError(409,'GOOGLE_PICKER_NOT_OPEN');
 const row=(await tx`UPDATE google_picker_ticket SET state='CANCELLED',version=version+1,error_code='GOOGLE_PICKER_CANCELLED',retryable=false WHERE id=${id} RETURNING *`)[0]!;return receipt(row);
});}
export async function selectGoogleSpreadsheet(db:Database,adapter:GoogleSheetsAdapter,actor:Principal,request:FastifyRequest,id:string,spreadsheetId:string){
 const claim=await db.begin(async tx=>{
  const {c,t}=await own(tx,actor,request,id);
  if(t.spreadsheet_id&&t.spreadsheet_id!==spreadsheetId)throw new HttpError(409,'GOOGLE_PICKER_SELECTED_ID_IMMUTABLE');
  if(t.state==='VERIFIED')return {completed:receipt(t)};
  if(!['PICKING','FAILED'].includes(t.state)||t.state==='FAILED'&&!t.retryable)throw new HttpError(409,'GOOGLE_PICKER_NOT_READY');
  if(t.attempts>=5)throw new HttpError(409,'GOOGLE_PICKER_RETRIES_EXHAUSTED');const stale=await rejectStale(tx,t,true);if(stale)return {error:stale};
  if((await tx`SELECT 1 FROM google_picker_ticket WHERE connection_id=${c.id} AND actor_id=${actor.id} AND session_id=${t.session_id} AND id<>${id} AND state IN ('WAITING','PICKING','VERIFYING')`).length)throw new HttpError(409,'GOOGLE_OPERATION_IN_PROGRESS');
  const g=await grant(tx,c,t.grant_id);await tx`UPDATE google_picker_ticket SET state='VERIFYING',version=version+1,attempts=attempts+1,spreadsheet_id=${spreadsheetId},error_code=NULL,retryable=false WHERE id=${id}`;
  return {connectionId:c.id as string,accessToken:token(g)};
 });
 if('completed' in claim)return claim.completed;if('error' in claim)throw new HttpError(409,claim.error!);
 let metadata:GoogleSpreadsheet|null=null,errorCode:string|null=null,retryable=false;
 try{metadata=await adapter.metadata(claim.accessToken!,spreadsheetId);}catch(e){errorCode=e instanceof GoogleSheetsError?e.code:'GOOGLE_PROVIDER_UNAVAILABLE';retryable=e instanceof GoogleSheetsError?e.retryable:true;}
 const result=await db.begin(async tx=>{
  const c=(await tx`SELECT * FROM integration_connection WHERE id=${claim.connectionId!} FOR UPDATE`)[0]!,t=(await tx`SELECT * FROM google_picker_ticket WHERE id=${id} FOR UPDATE`)[0]!;
  const session=await currentPaymentSession(tx,actor,request),ctx=await current(tx,id),allowed=session===t.session_id;
  if(t.state!=='VERIFYING')return {...receipt(t),allowed};
  if(!ctx.current||ctx.expired||!allowed){const row=(await tx`UPDATE google_picker_ticket SET state='SUPERSEDED',version=version+1,error_code='GOOGLE_PICKER_CONTEXT_CHANGED',retryable=false WHERE id=${id} RETURNING *`)[0]!;return {...receipt(row),allowed};}
  if(!metadata){const row=(await tx`UPDATE google_picker_ticket SET state='FAILED',version=version+1,error_code=${errorCode??'GOOGLE_RESPONSE_INVALID'},retryable=${retryable&&t.attempts<5} WHERE id=${id} RETURNING *`)[0]!;return {...receipt(row),allowed};}
  const old=(await tx`SELECT id,version FROM google_resource WHERE connection_id=${c.id} AND spreadsheet_id=${spreadsheetId} FOR UPDATE`)[0],resourceId=(old?.id??randomUUID()) as string,resourceVersion=(old?.version??0)+1;
  const row=(await tx`UPDATE google_picker_ticket SET state='VERIFIED',version=version+1,metadata=${tx.json(metadata)},resource_id=${resourceId},resource_version=${resourceVersion},error_code=NULL,retryable=false WHERE id=${id} RETURNING *`)[0]!;
  const values={metadata:tx.json(metadata),connection_version:c.version,active:true,source_ticket_id:id,actor_id:actor.id,session_id:t.session_id,actor_role:actor.role,actor_branch_id:actor.branchId,reason:'Verified Google Picker selection',version:resourceVersion};
  if(old)await tx`UPDATE google_resource SET ${tx(values)} WHERE id=${resourceId}`;
  else await tx`INSERT INTO google_resource ${tx({id:resourceId,connection_id:c.id,organization_id:c.organization_id,branch_id:c.branch_id,spreadsheet_id:spreadsheetId,...values})}`;
  return {...receipt(row),allowed};
 });if(!result.allowed)throw new HttpError(403,'GOOGLE_ACCESS_REVOKED');return result;
}
