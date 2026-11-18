import {randomUUID} from 'node:crypto';import type postgres from 'postgres';import type {FastifyRequest} from 'fastify';import type {Database} from '../db.js';
import {HttpError,requireRole,sha256,type Principal} from '../security.js';
import {googleSession,openGoogleValue,sealGoogleValue,googleClientCredentials,applyGoogleHealth,type StoredGoogleTokens} from './connections.js';
import {googleOperationalResource} from './resource-access.js';import {GoogleSheetsError,googleSheetsAdapter,type GoogleSheetsAdapter} from './sheets.js';
type Tx=postgres.TransactionSql;type Row=postgres.Row;
export type CaptureInput={resourceId:string;connectionVersion:number;resourceVersion:number;sheetId:number;row:number;column:number;rows:number;columns:number;requestId:string;label:string;reason:string};
export async function captureJob(tx:Tx,actor:Principal,request:FastifyRequest,id:string){
 requireRole(actor,'SUPER_ADMIN','MANAGER');await googleSession(tx,actor,request);
 const j=(await tx`SELECT j.*,expires_at<=clock_timestamp() AS expired FROM google_capture_job j JOIN branch b ON b.id=j.branch_id JOIN campaign ca ON ca.id=j.campaign_id
  WHERE j.id=${id} AND j.actor_id=${actor.id} AND j.organization_id=${actor.organizationId} AND j.actor_role=${actor.role} AND j.actor_branch_id IS NOT DISTINCT FROM ${actor.branchId}::uuid
  AND b.active AND b.organization_id=${actor.organizationId} AND ca.organization_id=${actor.organizationId} AND ca.branch_id=b.id
  AND (${actor.role==='SUPER_ADMIN'} OR b.id=${actor.branchId})`)[0];
 if(!j)throw new HttpError(404,'GOOGLE_CAPTURE_NOT_FOUND');return j;
}
export function captureReceipt(j:Row){return {id:j.id,label:j.label,state:j.state,version:j.version,sheetId:j.sheet_id,sheetTitle:j.sheet_title,row:j.start_row,column:j.start_column,rows:j.row_count,columns:j.column_count,
 capturedRows:j.captured_rows,payloadBytes:j.payload_bytes,failures:j.failures,errorCode:j.error_code,expiresAt:j.expires_at,expired:j.expired??false};}
export async function createGoogleCapture(db:Database,actor:Principal,request:FastifyRequest,campaignId:string,p:CaptureInput){
 if(p.label.trim().length<1||p.reason.trim().length<3)throw new HttpError(400,'GOOGLE_TEXT_INVALID');
 const ttl=Number(process.env.GOOGLE_CAPTURE_TTL_SECONDS??86400);if(!Number.isInteger(ttl)||ttl<5||ttl>86400)throw Error('Invalid Google capture retention');
 return db.begin(async tx=>{
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id+':'+p.requestId},189))`;
  const found=(await tx`SELECT connection_id FROM google_resource WHERE id=${p.resourceId} AND organization_id=${actor.organizationId}`)[0];if(!found)throw new HttpError(404,'GOOGLE_RESOURCE_UNAVAILABLE');
  await tx`SELECT id FROM integration_connection WHERE id=${found.connection_id} FOR UPDATE`;
  const {campaign,resource:r}=await googleOperationalResource(tx,actor,request,campaignId,p.resourceId);
  const old=(await tx`SELECT * FROM google_capture_job WHERE actor_id=${actor.id} AND request_id=${p.requestId}`)[0];
  if(old){const initial=(await tx`SELECT reason FROM google_capture_history WHERE job_id=${old.id} AND version=1`)[0];if(old.campaign_id!==campaignId||old.resource_id!==p.resourceId||old.connection_version!==p.connectionVersion||old.resource_version!==p.resourceVersion||old.sheet_id!==p.sheetId||old.start_row!==p.row||old.start_column!==p.column||old.row_count!==p.rows||old.column_count!==p.columns||old.label!==p.label.trim()||initial?.reason!==p.reason.trim())throw new HttpError(409,'GOOGLE_CAPTURE_REQUEST_REUSED');return captureReceipt(old);}
  if(r.version!==p.resourceVersion||r.connection_version!==p.connectionVersion)throw new HttpError(409,'GOOGLE_RESOURCE_VERSION_CONFLICT');
  const sheet=(await tx`SELECT s FROM google_resource r CROSS JOIN LATERAL jsonb_array_elements(r.metadata->'sheets') s WHERE r.id=${r.id} AND (s->>'id')::integer=${p.sheetId}`)[0]?.s;
  if(!sheet||sheet.kind!=='GRID'||p.row+p.rows-1>sheet.rows||p.column+p.columns-1>sheet.columns)throw new HttpError(400,'GOOGLE_CAPTURE_GRID_INVALID');
  const access=(await tx`SELECT CASE WHEN c.branch_id IS NULL THEN a.version ELSE 0 END version FROM integration_connection c LEFT JOIN google_resource_access a ON a.resource_id=${r.id} AND a.branch_id=${campaign.branch_id} AND a.active WHERE c.id=${r.connection_id}`)[0]!;
  const j=(await tx`INSERT INTO google_capture_job(organization_id,branch_id,campaign_id,resource_id,connection_id,connection_version,resource_version,access_version,actor_id,actor_role,actor_branch_id,approval_session_id,request_id,label,sheet_id,sheet_title,spreadsheet_id,start_row,start_column,row_count,column_count,reason,expires_at)
   VALUES(${actor.organizationId},${campaign.branch_id},${campaignId},${r.id},${r.connection_id},${p.connectionVersion},${p.resourceVersion},${access.version},${actor.id},${actor.role},${actor.branchId},${campaign.session},${p.requestId},${p.label.trim()},${p.sheetId},${sheet.title},${r.spreadsheet_id},${p.row},${p.column},${p.rows},${p.columns},${p.reason.trim()},clock_timestamp()+${ttl}*interval '1 second') RETURNING *`)[0]!;
  return captureReceipt(j);
 });
}
async function allowed(tx:Tx,id:string){return (await tx`SELECT google_capture_allowed(j) AS allowed,j.lease_until>clock_timestamp() AS live,j.expires_at>clock_timestamp() AS retained FROM google_capture_job j WHERE id=${id}`)[0]!;}
async function updateJob(tx:Tx,j:Row,state:string,error:string|null,p:{captured?:number;bytes?:number;failures?:number;metadata?:postgres.JSONValue|null;delay?:number;reason?:string;session?:string;access?:number}={}){
 return (await tx`UPDATE google_capture_job SET state=${state},version=version+1,error_code=${error},lease_token=NULL,lease_until=NULL,
  captured_rows=${p.captured??j.captured_rows},payload_bytes=${p.bytes??j.payload_bytes},failures=${p.failures??j.failures},verified_metadata=${p.metadata?tx.json(p.metadata):j.verified_metadata?tx.json(j.verified_metadata):null},
  next_run_at=clock_timestamp()+${p.delay??0}*interval '1 second',reason=${p.reason??j.reason},approval_session_id=${p.session??j.approval_session_id},access_version=${p.access??j.access_version} WHERE id=${j.id} RETURNING *`)[0]!;
}
export async function changeGoogleCapture(db:Database,actor:Principal,request:FastifyRequest,id:string,p:{version:number;reason:string},cancel:boolean){
 if(p.reason.trim().length<3)throw new HttpError(400,'GOOGLE_TEXT_INVALID');return db.begin(async tx=>{
  const found=await captureJob(tx,actor,request,id);await tx`SELECT id FROM integration_connection WHERE id=${found.connection_id} FOR UPDATE`;
  const j=(await tx`SELECT *,expires_at<=clock_timestamp() expired FROM google_capture_job WHERE id=${id} FOR UPDATE`)[0]!;await googleSession(tx,actor,request);
  if(j.version!==p.version)throw new HttpError(409,'GOOGLE_CAPTURE_VERSION_CONFLICT');if(j.expired)throw new HttpError(410,'GOOGLE_CAPTURE_EXPIRED');
  if(cancel){if(['CANCELLED','EXPIRED'].includes(j.state))throw new HttpError(409,'GOOGLE_CAPTURE_NOT_RECOVERABLE');const changed=await updateJob(tx,j,'CANCELLED','GOOGLE_CAPTURE_CANCELLED',{reason:p.reason.trim()});await tx`DELETE FROM google_capture_row WHERE job_id=${id}`;return captureReceipt(changed);}
  if(!['NEEDS_ATTENTION','DEAD_LETTER'].includes(j.state))throw new HttpError(409,'GOOGLE_CAPTURE_NOT_RECOVERABLE');
  const {campaign,resource:r}=await googleOperationalResource(tx,actor,request,j.campaign_id,j.resource_id);if(r.version!==j.resource_version||r.connection_version!==j.connection_version)throw new HttpError(409,'GOOGLE_CAPTURE_NEW_REQUEST_REQUIRED');
  const access=(await tx`SELECT CASE WHEN c.branch_id IS NULL THEN a.version ELSE 0 END version FROM integration_connection c LEFT JOIN google_resource_access a ON a.resource_id=${r.id} AND a.branch_id=${j.branch_id} AND a.active WHERE c.id=${r.connection_id}`)[0]!;
  return captureReceipt(await updateJob(tx,j,'WAITING',null,{reason:p.reason.trim(),session:campaign.session,access:access.version,failures:0}));
 });
}
async function refreshCaptureGrant(db:Database,adapter:GoogleSheetsAdapter,j:Row,c:Row,g:Row,tokens:StoredGoogleTokens){
 const claim=await db.begin(async tx=>{
  const conn=(await tx`SELECT * FROM integration_connection WHERE id=${c.id} FOR UPDATE`)[0]!,current=(await tx`SELECT * FROM google_capture_job WHERE id=${j.id} FOR UPDATE`)[0]!,ctx=await allowed(tx,j.id);
  if(current.state!=='RUNNING'||current.lease_token!==j.lease_token||!ctx.allowed||!ctx.live||!ctx.retained||conn.capabilities.grantId!==g.id)return null;
  if(!(await tx`SELECT google_refresh_parent_safe(${g.id}) ok`)[0]!.ok){await updateJob(tx,current,'NEEDS_ATTENTION','GOOGLE_NEW_AUTHORIZATION_REQUIRED');return null;}
  if((await tx`SELECT 1 FROM google_oauth_operation WHERE connection_id=${c.id} AND state IN ('WAITING','RUNNING')`).length){await updateJob(tx,current,'NEEDS_ATTENTION','GOOGLE_AUTHORIZATION_IN_PROGRESS');return null;}
  const id=randomUUID(),credentials=await googleClientCredentials(tx,conn);
  await tx`INSERT INTO google_oauth_operation(id,connection_id,connection_version,kind,actor_id,session_id,actor_role,actor_branch_id,previous_operation_id,capture_id,capture_lease,state)
   VALUES(${id},${c.id},${j.connection_version},'RUNTIME',${j.actor_id},${j.approval_session_id},${j.actor_role},${j.actor_branch_id},${g.id},${j.id},${j.lease_token},'RUNNING')`;
  return {id,credentials};
 });if(!claim)return;
 let result:StoredGoogleTokens|null=null,subjectHash:Buffer|null=null,error:string|null=null;
 try{const value=await adapter.refresh(claim.credentials,tokens.refreshToken!,g.scopes);result={...value,refreshToken:value.refreshToken??tokens.refreshToken,expiresAt:new Date(Date.now()+value.expiresIn*1000).toISOString()};subjectHash=sha256('google:'+await adapter.subject(result.accessToken));}
 catch(e){error=e instanceof GoogleSheetsError?e.code:'GOOGLE_RESULT_UNKNOWN';}
 const sealed=result?sealGoogleValue('google-result:'+claim.id,result):null;
 await db.begin(async tx=>{
  const conn=(await tx`SELECT * FROM integration_connection WHERE id=${c.id} FOR UPDATE`)[0]!,current=(await tx`SELECT * FROM google_capture_job WHERE id=${j.id} FOR UPDATE`)[0]!,op=(await tx`SELECT *,expires_at<=clock_timestamp() expired FROM google_oauth_operation WHERE id=${claim.id} FOR UPDATE`)[0]!,ctx=await allowed(tx,j.id);
  if(op.state!=='RUNNING')return;const stale=current.state!=='RUNNING'||current.lease_token!==j.lease_token||!ctx.allowed||!ctx.live||!ctx.retained||op.expired||conn.capabilities.grantId!==g.id;
  const pin=(await tx`SELECT subject_hash FROM google_connection_subject WHERE connection_id=${c.id}`)[0]?.subject_hash as Buffer|undefined;
  if(subjectHash&&(!pin||!pin.equals(subjectHash)))error='GOOGLE_ACCOUNT_MISMATCH';if(result&&!result.refreshToken)error='GOOGLE_REFRESH_REQUIRED';
  const state=stale?'SUPERSEDED':!error&&result&&subjectHash?'VERIFIED':error==='GOOGLE_RESULT_UNKNOWN'?'UNKNOWN':'FAILED';
  const updated=(await tx`UPDATE google_oauth_operation SET state=${state},version=version+1,error_code=${state==='VERIFIED'?null:stale?'GOOGLE_CONTEXT_CHANGED':error??'GOOGLE_RESPONSE_INVALID'},result=${sealed?tx.json(sealed):null},subject_hash=${subjectHash},scopes=${tx.array(result?.scopes??[])},access_expires_at=${result?.expiresAt??null} WHERE id=${op.id} RETURNING *`)[0]!;
  if(!stale)await applyGoogleHealth(tx,conn,updated);
  if(current.state==='RUNNING'&&current.lease_token===j.lease_token)await updateJob(tx,current,state==='VERIFIED'?'WAITING':'NEEDS_ATTENTION',state==='VERIFIED'?null:updated.error_code);
 });
}
export async function processOneGoogleCapture(db:Database,adapter:GoogleSheetsAdapter=googleSheetsAdapter(),options:{batchRows?:number;retryDelaySeconds?:number}={}):Promise<boolean>{
 const batch=options.batchRows??100;if(!Number.isInteger(batch)||batch<1||batch>1000)throw Error('Invalid Google capture batch');
 const claim=await db.begin(async tx=>{
  await tx`SET LOCAL lock_timeout='750ms'`;await tx`SET LOCAL statement_timeout='10s'`;
  const found=(await tx`SELECT id,connection_id FROM google_capture_job WHERE (state IN ('WAITING','RUNNING') AND next_run_at<=clock_timestamp() AND (state<>'RUNNING' OR lease_until<=clock_timestamp()))
   OR (expires_at<=clock_timestamp() AND state NOT IN ('CANCELLED','EXPIRED')) ORDER BY next_run_at,id LIMIT 1`)[0];if(!found)return null;
  const c=(await tx`SELECT * FROM integration_connection WHERE id=${found.connection_id} FOR UPDATE SKIP LOCKED`)[0];if(!c)return null;
  const j=(await tx`SELECT *,expires_at<=clock_timestamp() expired,lease_until>clock_timestamp() live_lease FROM google_capture_job WHERE id=${found.id} FOR UPDATE`)[0]!;
  if(j.expired){await updateJob(tx,j,'EXPIRED','GOOGLE_CAPTURE_EXPIRED');await tx`DELETE FROM google_capture_row WHERE job_id=${j.id}`;return {handled:true};}
  if(!['WAITING','RUNNING'].includes(j.state)||j.state==='RUNNING'&&j.live_lease)return {handled:true};
  const pending=await tx`SELECT * FROM google_oauth_operation WHERE connection_id=${c.id} AND kind='RUNTIME' AND state='RUNNING' AND expires_at<=clock_timestamp() FOR UPDATE`;
  for(const o of pending){const ended=(await tx`UPDATE google_oauth_operation SET state='UNKNOWN',version=version+1,error_code='GOOGLE_RESULT_UNKNOWN' WHERE id=${o.id} RETURNING *`)[0]!;if(o.connection_version===c.version&&c.status!=='DISABLED')await applyGoogleHealth(tx,c,ended);}
  if(pending.length){await updateJob(tx,j,'NEEDS_ATTENTION','GOOGLE_RESULT_UNKNOWN');return {handled:true};}
  const ctx=await allowed(tx,j.id);if(!ctx.allowed){await updateJob(tx,j,'NEEDS_ATTENTION','GOOGLE_CAPTURE_ACCESS_CHANGED');return {handled:true};}
  const g=(await tx`SELECT *,access_expires_at>clock_timestamp()+interval '30 seconds' usable FROM google_oauth_operation WHERE id=${c.capabilities.grantId} AND connection_id=${c.id} AND connection_version=${j.connection_version} AND state='VERIFIED'`)[0];
  if(!g){await updateJob(tx,j,'NEEDS_ATTENTION','GOOGLE_NEW_AUTHORIZATION_REQUIRED');return {handled:true};}
  const tokens=openGoogleValue<StoredGoogleTokens>('google-result:'+g.id,g.result),lease=randomUUID();
  const row=(await tx`UPDATE google_capture_job SET state='RUNNING',version=version+1,lease_token=${lease},lease_until=clock_timestamp()+interval '60 seconds',active_grant_id=${g.id},error_code=NULL WHERE id=${j.id} RETURNING *`)[0]!;
  return {j:row,c,g,tokens};
 });if(!claim)return false;if('handled' in claim)return true;const {j,c,g,tokens}=claim;
 if(!g.usable){await refreshCaptureGrant(db,adapter,j,c,g,tokens);return true;}
 let rows:{rowNumber:number;cells:(string|null)[]}[]|null=null,metadata:Record<string,postgres.JSONValue>|null=null,error:string|null=null,retryable=false;
 try{
  if(!j.verified_metadata){const m=await adapter.metadata(tokens.accessToken,j.spreadsheet_id),sheet=m.sheets.find(s=>s.id===j.sheet_id);
   if(!sheet||sheet.kind!=='GRID'||!sheet.rows||!sheet.columns||sheet.rows<j.start_row+j.row_count-1||sheet.columns<j.start_column+j.column_count-1)throw new GoogleSheetsError('GOOGLE_RESOURCE_UNAVAILABLE');
   metadata={spreadsheetId:m.id,title:m.title,locale:m.locale,timezone:m.timezone,sheetId:sheet.id,sheetTitle:sheet.title,rows:sheet.rows,columns:sheet.columns};
  }
  rows=await adapter.readGrid(tokens.accessToken,j.spreadsheet_id,{sheetId:j.sheet_id,row:j.start_row+j.captured_rows,column:j.start_column,rows:Math.min(batch,j.row_count-j.captured_rows),columns:j.column_count});
 }catch(e){error=e instanceof GoogleSheetsError?e.code:'GOOGLE_PROVIDER_UNAVAILABLE';retryable=e instanceof GoogleSheetsError&&e.retryable;}
 try{await db.begin(async tx=>{
  await tx`SET LOCAL statement_timeout='10s'`;const conn=(await tx`SELECT * FROM integration_connection WHERE id=${c.id} FOR UPDATE`)[0]!,current=(await tx`SELECT * FROM google_capture_job WHERE id=${j.id} FOR UPDATE`)[0]!,ctx=await allowed(tx,j.id);
  if(current.state!=='RUNNING'||current.lease_token!==j.lease_token)return;
  if(!ctx.allowed||!ctx.live||!ctx.retained){await updateJob(tx,current,'NEEDS_ATTENTION','GOOGLE_CAPTURE_ACCESS_CHANGED');return;}
  if(conn.capabilities.grantId!==g.id){await updateJob(tx,current,'WAITING','GOOGLE_CAPTURE_GRANT_CHANGED');return;}
  if(!rows){const failures=Math.min(5,current.failures+1);await updateJob(tx,current,retryable&&failures<5?'WAITING':retryable?'DEAD_LETTER':'NEEDS_ATTENTION',error??'GOOGLE_RESPONSE_INVALID',{failures,delay:options.retryDelaySeconds??2**(failures-1)});return;}
  const inserted=await tx`INSERT INTO google_capture_row ${tx(rows.map(r=>({job_id:j.id,row_number:r.rowNumber,cells:tx.json(r.cells),page_version:current.version+1,lease_token:j.lease_token})))} RETURNING payload_bytes`;
  const bytes=inserted.reduce((sum,r)=>sum+r.payload_bytes,0)+current.payload_bytes;if(bytes>8388608)throw new HttpError(409,'GOOGLE_CAPTURE_PAYLOAD_LIMIT');
  const count=current.captured_rows+rows.length;await updateJob(tx,current,count===current.row_count?'READY':'WAITING',null,{captured:count,bytes,failures:0,metadata:metadata??undefined});
 });}catch(e){
  await db.begin(async tx=>{await tx`SELECT id FROM integration_connection WHERE id=${c.id} FOR UPDATE`;const current=(await tx`SELECT * FROM google_capture_job WHERE id=${j.id} FOR UPDATE`)[0]!;
   if(current.state!=='RUNNING'||current.lease_token!==j.lease_token)return;const failures=Math.min(5,current.failures+1),limit=e instanceof HttpError&&e.message==='GOOGLE_CAPTURE_PAYLOAD_LIMIT';
   await updateJob(tx,current,limit?'NEEDS_ATTENTION':failures>=5?'DEAD_LETTER':'WAITING',limit?'GOOGLE_CAPTURE_PAYLOAD_LIMIT':'GOOGLE_CAPTURE_PAGE_FAILED',{failures,delay:options.retryDelaySeconds??2**(failures-1)});
  });
 }
 return true;
}
