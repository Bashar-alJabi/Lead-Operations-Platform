import {randomUUID} from 'node:crypto';import type postgres from 'postgres';import type {Database} from '../db.js';
import {sha256} from '../security.js';import {bulkHash} from '../bulk-actions.js';
import {openGoogleValue,sealGoogleValue,googleClientCredentials,applyGoogleHealth,type StoredGoogleTokens} from './connections.js';
import {googleSheetsAdapter,GoogleSheetsError,type GoogleSheetsAdapter} from './sheets.js';import {googleNewWorksheetBody,type GoogleExportCell} from './export-cells.js';
type Tx=postgres.TransactionSql;type Row=postgres.Row;
async function transition(tx:Tx,d:Row,state:string,error:string|null,p:{failures?:number;verified?:number;delay?:number;attemptAt?:string;keepLease?:boolean}={}){
 return (await tx`UPDATE google_export_delivery SET state=${state},error_code=${error},version=version+1,failures=${p.failures??d.failures},verified_rows=${p.verified??d.verified_rows},
  attempt_at=${p.attemptAt===undefined?tx`attempt_at`:tx`${p.attemptAt}::text::timestamptz`},lease_token=${p.keepLease?tx`lease_token`:null},lease_until=${p.keepLease?tx`lease_until`:null},
  next_run_at=clock_timestamp()+${p.delay??0}*interval '1 second' WHERE id=${d.id} AND version=${d.version} RETURNING *`)[0]!;
}
async function context(tx:Tx,id:string){
 const ref=(await tx`SELECT j.connection_id FROM google_export_delivery d JOIN google_export_job j ON j.id=d.job_id WHERE d.id=${id}`)[0]!;
 const c=(await tx`SELECT * FROM integration_connection WHERE id=${ref.connection_id} FOR UPDATE`)[0]!,d=(await tx`SELECT *,lease_until>clock_timestamp() live FROM google_export_delivery WHERE id=${id} FOR UPDATE`)[0]!,
  j=(await tx`SELECT *,expires_at<=clock_timestamp() expired FROM google_export_job WHERE id=${d.job_id} FOR SHARE`)[0]!,
  allowed=(await tx`SELECT google_export_delivery_allowed(d) ok FROM google_export_delivery d WHERE id=${id}`)[0]!.ok as boolean;
 return {c,d,j,allowed};
}
async function failure(db:Database,id:string,lease:string,error:string,retryable:boolean,delay:number|undefined){
 await db.begin(async tx=>{const {d,allowed}=await context(tx,id);if(!['SENDING','READING'].includes(d.state)||d.lease_token!==lease)return;
  if(!allowed){await transition(tx,d,'NEEDS_ATTENTION','GOOGLE_EXPORT_ACCESS_CHANGED');return;}
  const failures=Math.min(5,d.failures+1);await transition(tx,d,retryable?failures===5?'DEAD_LETTER':d.attempt_at===null?'WAITING':'VERIFYING':'NEEDS_ATTENTION',error,
   {failures,delay:delay??2**(failures-1)});
 });
}
async function refresh(db:Database,adapter:GoogleSheetsAdapter,d:Row,j:Row,g:Row,tokens:StoredGoogleTokens){
 const claim=await db.begin(async tx=>{
  const current=await context(tx,d.id);if(current.d.state!==d.state||current.d.lease_token!==d.lease_token||!current.d.live||!current.allowed||current.c.capabilities.grantId!==g.id)return null;
  if(!(await tx`SELECT google_refresh_parent_safe(${g.id}) ok`)[0]!.ok){await transition(tx,current.d,'NEEDS_ATTENTION','GOOGLE_NEW_AUTHORIZATION_REQUIRED');return null;}
  if((await tx`SELECT 1 FROM google_oauth_operation WHERE connection_id=${j.connection_id} AND state IN ('WAITING','RUNNING')`).length){await transition(tx,current.d,'NEEDS_ATTENTION','GOOGLE_AUTHORIZATION_IN_PROGRESS');return null;}
  const id=randomUUID(),credentials=await googleClientCredentials(tx,current.c);
  await tx`INSERT INTO google_oauth_operation(id,connection_id,connection_version,kind,actor_id,session_id,actor_role,actor_branch_id,previous_operation_id,export_delivery_id,export_lease,state)
   VALUES(${id},${j.connection_id},${j.connection_version},'RUNTIME',${j.actor_id},${d.approval_session_id},${j.actor_role},${j.branch_scope},${g.id},${d.id},${d.lease_token},'RUNNING')`;
  return {id,credentials};
 });if(!claim)return;
 let result:StoredGoogleTokens|null=null,subjectHash:Buffer|null=null,error:string|null=null;
 try{const value=await adapter.refresh(claim.credentials,tokens.refreshToken!,g.scopes);result={...value,refreshToken:value.refreshToken??tokens.refreshToken,expiresAt:new Date(Date.now()+value.expiresIn*1000).toISOString()};subjectHash=sha256('google:'+await adapter.subject(result.accessToken));}
 catch(e){error=e instanceof GoogleSheetsError?e.code:'GOOGLE_RESULT_UNKNOWN';}
 const sealed=result?sealGoogleValue('google-result:'+claim.id,result):null;
 await db.begin(async tx=>{
  const current=await context(tx,d.id),op=(await tx`SELECT *,expires_at<=clock_timestamp() expired FROM google_oauth_operation WHERE id=${claim.id} FOR UPDATE`)[0]!;if(op.state!=='RUNNING')return;
  const stale=current.d.state!==d.state||current.d.lease_token!==d.lease_token||!current.d.live||!current.allowed||op.expired||current.c.capabilities.grantId!==g.id,
   pin=(await tx`SELECT subject_hash FROM google_connection_subject WHERE connection_id=${j.connection_id}`)[0]?.subject_hash as Buffer|undefined;
  if(subjectHash&&(!pin||!pin.equals(subjectHash)))error='GOOGLE_ACCOUNT_MISMATCH';if(result&&!result.refreshToken)error='GOOGLE_REFRESH_REQUIRED';
  const state=stale?'SUPERSEDED':!error&&result&&subjectHash?'VERIFIED':error==='GOOGLE_RESULT_UNKNOWN'?'UNKNOWN':'FAILED';
  const updated=(await tx`UPDATE google_oauth_operation SET state=${state},version=version+1,error_code=${state==='VERIFIED'?null:stale?'GOOGLE_CONTEXT_CHANGED':error??'GOOGLE_RESPONSE_INVALID'},
   result=${sealed?tx.json(sealed):null},subject_hash=${subjectHash},scopes=${tx.array(result?.scopes??[])},access_expires_at=${result?.expiresAt??null} WHERE id=${op.id} RETURNING *`)[0]!;
  if(!stale)await applyGoogleHealth(tx,current.c,updated);
  if(current.d.state===d.state&&current.d.lease_token===d.lease_token)await transition(tx,current.d,state==='VERIFIED'?d.attempt_at===null?'WAITING':'VERIFYING':'NEEDS_ATTENTION',state==='VERIFIED'?null:updated.error_code);
 });
}
export async function processOneGoogleExportDelivery(db:Database,adapter:GoogleSheetsAdapter=googleSheetsAdapter(),options:{batchRows?:number;retryDelaySeconds?:number}={}):Promise<boolean>{
 const batch=options.batchRows??100;if(!Number.isInteger(batch)||batch<1||batch>1000)throw Error('Invalid Google delivery read capacity');
 const claim=await db.begin(async tx=>{
  await tx`SET LOCAL statement_timeout='10s'`;await tx`SET LOCAL lock_timeout='750ms'`;
  const found=(await tx`SELECT d.id,j.connection_id FROM google_export_delivery d JOIN google_export_job j ON j.id=d.job_id
   WHERE (d.state IN ('WAITING','VERIFYING') AND d.next_run_at<=clock_timestamp()) OR (d.state IN ('SENDING','READING') AND d.lease_until<=clock_timestamp())
    OR (d.state NOT IN ('DONE','CANCELLED','EXPIRED') AND (j.expires_at<=clock_timestamp() OR j.state IN ('CANCELLED','EXPIRED'))) ORDER BY d.next_run_at,d.id LIMIT 1`)[0];if(!found)return null;
  if(!(await tx`SELECT id FROM integration_connection WHERE id=${found.connection_id} FOR UPDATE SKIP LOCKED`).length)return null;
  const {c,d,j,allowed}=await context(tx,found.id);if(['DONE','CANCELLED','EXPIRED'].includes(d.state))return {handled:true};
  if(j.expired||['CANCELLED','EXPIRED'].includes(j.state)){await transition(tx,d,'EXPIRED','GOOGLE_EXPORT_SOURCE_EXPIRED');return {handled:true};}
  if(['SENDING','READING'].includes(d.state)){
   if(d.live)return {handled:true};if(d.state==='SENDING'&&d.attempt_at!==null){await transition(tx,d,'UNKNOWN','GOOGLE_RESULT_UNKNOWN');return {handled:true};}
   if(!allowed){await transition(tx,d,'NEEDS_ATTENTION','GOOGLE_EXPORT_ACCESS_CHANGED');return {handled:true};}
   const failures=Math.min(5,d.failures+1);await transition(tx,d,failures===5?'DEAD_LETTER':d.attempt_at===null?'WAITING':'VERIFYING','GOOGLE_EXPORT_LEASE_EXPIRED',{failures});return {handled:true};
  }
  if(!allowed){await transition(tx,d,'NEEDS_ATTENTION','GOOGLE_EXPORT_ACCESS_CHANGED');return {handled:true};}
  const pending=await tx`SELECT * FROM google_oauth_operation WHERE connection_id=${c.id} AND kind='RUNTIME' AND state='RUNNING' AND expires_at<=clock_timestamp() FOR UPDATE`;
  for(const op of pending){const ended=(await tx`UPDATE google_oauth_operation SET state='UNKNOWN',version=version+1,error_code='GOOGLE_RESULT_UNKNOWN' WHERE id=${op.id} RETURNING *`)[0]!;if(op.connection_version===c.version&&c.status!=='DISABLED')await applyGoogleHealth(tx,c,ended);}
  if(pending.length){await transition(tx,d,'NEEDS_ATTENTION','GOOGLE_NEW_AUTHORIZATION_REQUIRED');return {handled:true};}
  const g=(await tx`SELECT *,access_expires_at>clock_timestamp()+interval '30 seconds' usable FROM google_oauth_operation WHERE id=${c.capabilities.grantId} AND connection_id=${c.id} AND connection_version=${j.connection_version} AND state='VERIFIED'`)[0];
  if(!g){await transition(tx,d,'NEEDS_ATTENTION','GOOGLE_NEW_AUTHORIZATION_REQUIRED');return {handled:true};}
  const tokens=openGoogleValue<StoredGoogleTokens>('google-result:'+g.id,g.result),row=(await tx`UPDATE google_export_delivery SET state=${d.state==='WAITING'?'SENDING':'READING'},version=version+1,
   lease_token=${randomUUID()},lease_until=clock_timestamp()+interval '60 seconds',active_grant_id=${g.id},error_code=NULL WHERE id=${d.id} RETURNING *`)[0]!;return {d:row,j,g,tokens};
 });if(!claim)return false;if('handled' in claim)return true;const {d,j,g,tokens}=claim;
 if(!g.usable){await refresh(db,adapter,d,j,g,tokens);return true;}
 if(d.state==='SENDING'){
  let metadata:Awaited<ReturnType<GoogleSheetsAdapter['metadata']>>;
  try{metadata=await adapter.metadata(tokens.accessToken,j.spreadsheet_id);if(metadata.sheets.some(s=>s.id===j.sheet_id||s.title===j.sheet_title)){
   await failure(db,d.id,d.lease_token,'GOOGLE_EXPORT_TARGET_EXISTS',false,options.retryDelaySeconds);return true;
  }}catch(e){await failure(db,d.id,d.lease_token,e instanceof GoogleSheetsError?e.code:'GOOGLE_PROVIDER_UNAVAILABLE',e instanceof GoogleSheetsError&&e.retryable,options.retryDelaySeconds);return true;}
  const payload=await db.begin(async tx=>{
   const current=await context(tx,d.id);if(current.d.state!=='SENDING'||current.d.lease_token!==d.lease_token)return null;
   if(!current.allowed||!current.d.live||current.c.capabilities.grantId!==g.id){await transition(tx,current.d,'NEEDS_ATTENTION','GOOGLE_EXPORT_ACCESS_CHANGED');return null;}
   const cells=(await tx`SELECT google_export_expected_grid(${j.id},0,${j.expected_rows+1}) cells`)[0]!.cells as GoogleExportCell[][];
   googleNewWorksheetBody({sheetId:j.sheet_id,title:j.sheet_title,cells});
   const [attempt]=await tx`INSERT INTO google_export_write_attempt(delivery_id,lease_token,grant_id,payload_sha256,metadata_sha256)
    VALUES(${d.id},${d.lease_token},${g.id},${d.payload_sha256},${bulkHash(metadata)}) RETURNING created_at::text at`;
   await transition(tx,current.d,'SENDING',null,{attemptAt:attempt!.at,keepLease:true});return cells;
  });if(!payload)return true;
  // This transaction has committed the unique attempt. Nothing can authorize its replay.
  let acknowledged=false;try{await adapter.createWorksheet(tokens.accessToken,j.spreadsheet_id,{sheetId:j.sheet_id,title:j.sheet_title,cells:payload});acknowledged=true;}catch{/* Provider uncertainty is retained; never a write retry. */}
  await db.begin(async tx=>{const current=await context(tx,d.id);if(current.d.state!=='SENDING'||current.d.lease_token!==d.lease_token)return;
   const trusted=acknowledged&&current.allowed&&current.d.live&&current.c.capabilities.grantId===g.id;await transition(tx,current.d,trusted?'VERIFYING':'UNKNOWN',trusted?null:'GOOGLE_RESULT_UNKNOWN');
  });return true;
 }
 const count=Math.min(batch,j.expected_rows+1-d.verified_rows);let observed:Awaited<ReturnType<GoogleSheetsAdapter['readEnteredGrid']>>;
 try{observed=await adapter.readEnteredGrid(tokens.accessToken,j.spreadsheet_id,{sheetId:j.sheet_id,row:d.verified_rows+1,column:1,rows:count,columns:j.header_cells.length});}
 catch(e){await failure(db,d.id,d.lease_token,e instanceof GoogleSheetsError?e.code:'GOOGLE_PROVIDER_UNAVAILABLE',e instanceof GoogleSheetsError&&e.retryable,options.retryDelaySeconds);return true;}
 if(observed.title!==j.sheet_title){await failure(db,d.id,d.lease_token,'GOOGLE_EXPORT_READ_MISMATCH',false,options.retryDelaySeconds);return true;}
 await db.begin(async tx=>{
  const current=await context(tx,d.id);if(current.d.state!=='READING'||current.d.lease_token!==d.lease_token)return;
  if(!current.allowed||!current.d.live||current.c.capabilities.grantId!==g.id){await transition(tx,current.d,'NEEDS_ATTENTION','GOOGLE_EXPORT_ACCESS_CHANGED');return;}
  const [comparison]=await tx`SELECT sha256(convert_to(${tx.json(observed.cells)}::jsonb::text,'UTF8')) actual,sha256(convert_to(google_export_expected_grid(${j.id},${current.d.verified_rows},${count})::text,'UTF8')) expected`;
  if(!Buffer.from(comparison!.actual).equals(Buffer.from(comparison!.expected))){await transition(tx,current.d,'NEEDS_ATTENTION','GOOGLE_EXPORT_READ_MISMATCH');return;}
  await tx`INSERT INTO google_export_read_receipt(delivery_id,start_row,row_count,delivery_version,lease_token,grant_id,cells_sha256)
   VALUES(${d.id},${current.d.verified_rows},${count},${current.d.version+1},${d.lease_token},${g.id},${comparison!.actual})`;
  const verified=current.d.verified_rows+count;await transition(tx,current.d,verified===j.expected_rows+1?'DONE':'VERIFYING',null,{verified,failures:0});
 });return true;
}
