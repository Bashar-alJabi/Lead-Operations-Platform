import {randomUUID,randomBytes} from 'node:crypto';
import type postgres from 'postgres';
import type {FastifyRequest} from 'fastify';
import type {Database} from '../db.js';
import {HttpError,requireRole,sha256,type Principal} from '../security.js';
import {isProduction} from '../config.js';
import {currentPaymentSession} from '../payments/access.js';
import {openOpaque,sealOpaque,openSecret} from '../credentials.js';
import {googleAuthorizationUrl,googlePkceChallenge,GoogleSheetsError,type GoogleSheetsAdapter,type GoogleTokens} from './sheets.js';

type Tx=postgres.TransactionSql;
type Row=postgres.Row;
type StoredTokens=GoogleTokens&{expiresAt:string};
type Envelope={ciphertext:string;nonce:string;authTag:string;keyVersion:number};
function sealed(context:string,value:unknown):Envelope {
 const s=sealOpaque(context,JSON.stringify(value));return {ciphertext:s.ciphertext.toString('base64'),nonce:s.nonce.toString('base64'),authTag:s.authTag.toString('base64'),keyVersion:s.keyVersion};
}
function opened<T>(context:string,s:Envelope):T {
 return JSON.parse(openOpaque(context,{ciphertext:Buffer.from(s.ciphertext,'base64'),nonce:Buffer.from(s.nonce,'base64'),authTag:Buffer.from(s.authTag,'base64'),keyVersion:s.keyVersion})) as T;
}
export function googleSetup() {
 let origin:URL;try{origin=new URL(process.env.APP_ORIGIN??'');}catch{throw new HttpError(503,'GOOGLE_PLATFORM_URL_REQUIRED');}
 if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||origin.protocol!=='https:'&&
  (isProduction||origin.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))throw new HttpError(503,'GOOGLE_PLATFORM_URL_REQUIRED');
 return {redirectUri:origin.origin+'/api/google/callback',returnUrl:origin.origin+'/',allowLoopbackHttp:origin.protocol==='http:'};
}
export async function googleSession(tx:Tx,actor:Principal,request:FastifyRequest) {
 requireRole(actor,'SUPER_ADMIN','MANAGER');const session=await currentPaymentSession(tx,actor,request);if(!session)throw new HttpError(403,'GOOGLE_ACCESS_REVOKED');return session;
}
export async function googleConnection(tx:Tx,actor:Principal,id:string,write=false) {
 requireRole(actor,'SUPER_ADMIN','MANAGER');const c=(await tx`SELECT * FROM integration_connection WHERE id=${id} AND kind='GOOGLE' AND organization_id=${actor.organizationId}
 AND (${actor.role==='SUPER_ADMIN'} OR branch_id=${actor.branchId}) ${write?tx`FOR UPDATE`:tx`FOR SHARE`}`)[0];
 if(!c)throw new HttpError(404,'GOOGLE_CONNECTION_NOT_FOUND');return c;
}
async function active(tx:Tx,c:Row) {
 if(c.status==='DISABLED')throw new HttpError(409,'GOOGLE_CONNECTION_DISABLED');
 if(c.branch_id&&!(await tx`SELECT 1 FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length)throw new HttpError(409,'GOOGLE_BRANCH_DISABLED');
}
export async function googleRevision(tx:Tx,c:Row,actor:Principal,sessionId:string,reason:string,secretChanged:boolean) {
 await tx`INSERT INTO google_connection_revision(connection_id,version,actor_id,session_id,actor_role,actor_branch_id,name,status,reason,secret_changed)
 VALUES(${c.id},${c.version},${actor.id},${sessionId},${actor.role},${actor.branchId},${c.name},${c.status},${reason.trim()},${secretChanged})`;
}
async function client(tx:Tx,c:Row) {
 const s=(await tx`SELECT * FROM connection_secret WHERE connection_id=${c.id}`)[0];if(!s)throw new HttpError(409,'GOOGLE_CLIENT_REQUIRED');
 return {clientId:c.config.clientId as string,clientSecret:openSecret(c.id,{ciphertext:s.ciphertext,nonce:s.nonce,authTag:s.auth_tag,keyVersion:s.key_version})};
}
async function expire(tx:Tx,c:Row) {
 const expired=await tx`UPDATE google_oauth_operation SET state=CASE WHEN state='WAITING' THEN 'EXPIRED' ELSE 'UNKNOWN' END,
 error_code=CASE WHEN state='WAITING' THEN 'GOOGLE_AUTHORIZATION_EXPIRED' ELSE 'GOOGLE_RESULT_UNKNOWN' END,version=version+1
 WHERE connection_id=${c.id} AND state IN ('WAITING','RUNNING') AND expires_at<=clock_timestamp() RETURNING *`;
 for(const o of expired)if(o.state==='UNKNOWN'&&o.connection_version===c.version&&c.status!=='DISABLED')await health(tx,c,o);
}
async function health(tx:Tx,c:Row,o:Row) {
 const ok=o.state==='VERIFIED';await tx`UPDATE integration_connection SET status=${ok?'CONNECTED':o.error_code==='GOOGLE_AUTH_FAILED'?'AUTH_EXPIRED':'ERROR'},
 capabilities=${tx.json(ok?{grantId:o.id}:{})},last_error_code=${o.error_code},updated_at=clock_timestamp(),
 last_success_at=CASE WHEN ${ok} THEN clock_timestamp() ELSE last_success_at END,last_failure_at=CASE WHEN ${!ok} THEN clock_timestamp() ELSE last_failure_at END WHERE id=${c.id}`;
}
export async function startGoogleAuthorization(db:Database,actor:Principal,request:FastifyRequest,id:string,version:number) {
 const setup=googleSetup(),state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),operationId=randomUUID();
 return db.begin(async(tx)=>{
  const c=await googleConnection(tx,actor,id,true),session=await googleSession(tx,actor,request);await active(tx,c);
  if(c.version!==version)throw new HttpError(409,'GOOGLE_VERSION_CONFLICT');await expire(tx,c);
  if((await tx`SELECT 1 FROM google_oauth_operation WHERE connection_id=${id} AND state='RUNNING'`).length)throw new HttpError(409,'GOOGLE_OPERATION_IN_PROGRESS');
  await tx`UPDATE google_oauth_operation SET state='SUPERSEDED',error_code='GOOGLE_NEW_AUTHORIZATION',version=version+1 WHERE connection_id=${id} AND state='WAITING'`;
  const credentials=await client(tx,c);
  await tx`INSERT INTO google_oauth_operation(id,connection_id,connection_version,kind,actor_id,session_id,actor_role,actor_branch_id,state,state_hash,verifier)
   VALUES(${operationId},${id},${version},'AUTHORIZE',${actor.id},${session},${actor.role},${actor.branchId},'WAITING',${sha256(state)},${tx.json(sealed('google-verifier:'+operationId,verifier))})`;
  return {operationId,url:googleAuthorizationUrl({clientId:credentials.clientId,redirectUri:setup.redirectUri,state,codeChallenge:googlePkceChallenge(verifier),allowLoopbackHttp:setup.allowLoopbackHttp})};
 });
}
async function finish(db:Database,actor:Principal,request:FastifyRequest,operationId:string,connectionId:string,tokens:StoredTokens|null,subject:string|null,error:string|null) {
 // Seal even an unverified/stale response: it is historical evidence, never an active grant.
 const result=tokens?sealed('google-result:'+operationId,tokens):null,subjectHash=subject?sha256('google:'+subject):null;
 return db.begin(async(tx)=>{
  const c=(await tx`SELECT * FROM integration_connection WHERE id=${connectionId} FOR UPDATE`)[0]!;
  const o=(await tx`SELECT *,expires_at<=clock_timestamp() AS expired FROM google_oauth_operation WHERE id=${operationId} FOR UPDATE`)[0]!;
  const session=await currentPaymentSession(tx,actor,request),branchActive=!c.branch_id||(await tx`SELECT 1 FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length>0;
  const stale=o.state!=='RUNNING'||o.expired||c.version!==o.connection_version||c.status==='DISABLED'||session!==o.session_id||!branchActive;
  const pinned=(await tx`SELECT subject_hash FROM google_connection_subject WHERE connection_id=${c.id}`)[0]?.subject_hash as Buffer|undefined;
  if(subjectHash&&pinned&&!pinned.equals(subjectHash))error='GOOGLE_ACCOUNT_MISMATCH';
  if(tokens&&!tokens.refreshToken)error='GOOGLE_REFRESH_REQUIRED';
  if(tokens&&new Date(tokens.expiresAt).getTime()<=Date.now())error='GOOGLE_TOKEN_EXPIRED';
  const state=stale?'SUPERSEDED':!error&&tokens&&subjectHash?'VERIFIED':error==='GOOGLE_RESULT_UNKNOWN'?'UNKNOWN':'FAILED';
  const errorCode=stale?'GOOGLE_CONTEXT_CHANGED':error??'GOOGLE_RESPONSE_INVALID';
  if(o.state!=='RUNNING')return {state:o.state as string,errorCode:o.error_code as string|null,allowed:!!session};
  const updated=(await tx`UPDATE google_oauth_operation SET state=${state},version=version+1,error_code=${state==='VERIFIED'?null:errorCode},
   result=${result?tx.json(result):null},subject_hash=${subjectHash},scopes=${tx.array(tokens?.scopes??[])},access_expires_at=${tokens?.expiresAt??null} WHERE id=${o.id} RETURNING *`)[0]!;
  if(!stale)await health(tx,c,updated);
  return {state,errorCode:state==='VERIFIED'?null:errorCode,allowed:session===o.session_id};
 });
}
async function exchangeResult(run:()=>Promise<GoogleTokens>,adapter:GoogleSheetsAdapter,previousRefresh:string|null=null) {
 let tokens:StoredTokens|null=null,subject:string|null=null,error:string|null=null;
 try{
  const value=await run();tokens={...value,refreshToken:value.refreshToken??previousRefresh,expiresAt:new Date(Date.now()+value.expiresIn*1000).toISOString()};
  subject=await adapter.subject(tokens.accessToken);
 }catch(e){error=e instanceof GoogleSheetsError?e.code:'GOOGLE_PROVIDER_UNAVAILABLE';}
 return {tokens,subject,error};
}
export async function completeGoogleAuthorization(db:Database,adapter:GoogleSheetsAdapter,actor:Principal,request:FastifyRequest,input:{state:string;code?:string;error?:string}) {
 const setup=googleSetup();
 const claim=await db.begin(async(tx)=>{
  const found=(await tx`SELECT connection_id FROM google_oauth_operation WHERE state_hash=${sha256(input.state)}`)[0];if(!found)throw new HttpError(400,'GOOGLE_STATE_INVALID');
  const c=await googleConnection(tx,actor,found.connection_id,true),session=await googleSession(tx,actor,request);
  const o=(await tx`SELECT *,expires_at<=clock_timestamp() AS expired FROM google_oauth_operation WHERE state_hash=${sha256(input.state)} FOR UPDATE`)[0]!;
  if(o.actor_id!==actor.id||o.session_id!==session||o.actor_role!==actor.role||o.actor_branch_id!==actor.branchId)throw new HttpError(403,'GOOGLE_ORIGINAL_SESSION_REQUIRED');
  if(o.state==='RUNNING'){
   if(!o.expired)throw new HttpError(409,'GOOGLE_OPERATION_IN_PROGRESS');await expire(tx,c);return {c,operation:null};
  }
  if(o.state!=='WAITING')return {c,operation:null};
  if(o.expired){await expire(tx,c);return {c,operation:null};}
  const branchActive=!c.branch_id||(await tx`SELECT 1 FROM branch WHERE id=${c.branch_id} AND active FOR SHARE`).length>0;
  if(c.version!==o.connection_version||c.status==='DISABLED'||!branchActive){
   await tx`UPDATE google_oauth_operation SET state='SUPERSEDED',error_code='GOOGLE_CONTEXT_CHANGED',version=version+1 WHERE id=${o.id}`;return {c,operation:null};
  }
  if(input.error){
   const denied=(await tx`UPDATE google_oauth_operation SET state='DENIED',error_code='GOOGLE_CONSENT_DENIED',version=version+1 WHERE id=${o.id} RETURNING *`)[0]!;
   await health(tx,c,denied);return {c,operation:null};
  }
  if(!input.code)throw new HttpError(400,'GOOGLE_CODE_REQUIRED');
  const credentials=await client(tx,c),verifier=opened<string>('google-verifier:'+o.id,o.verifier);
  await tx`UPDATE google_oauth_operation SET state='RUNNING',version=version+1 WHERE id=${o.id}`;
  return {c,operation:{id:o.id as string,credentials,verifier}};
 });
 if(claim.operation){
  const o=claim.operation,r=await exchangeResult(()=>adapter.exchangeCode(o.credentials,{code:input.code!,redirectUri:setup.redirectUri,verifier:o.verifier,allowLoopbackHttp:setup.allowLoopbackHttp}),adapter);
  const result=await finish(db,actor,request,o.id,claim.c.id,r.tokens,r.subject,r.error);if(!result.allowed)throw new HttpError(403,'GOOGLE_ACCESS_REVOKED');
 }
 return setup.returnUrl+'?google='+claim.c.id;
}
export async function checkGoogleConnection(db:Database,adapter:GoogleSheetsAdapter,actor:Principal,request:FastifyRequest,id:string,version:number) {
 const claim=await db.begin(async(tx)=>{
  const original=await googleConnection(tx,actor,id,true),session=await googleSession(tx,actor,request);await active(tx,original);
  if(original.version!==version)throw new HttpError(409,'GOOGLE_VERSION_CONFLICT');await expire(tx,original);
  const c=(await tx`SELECT * FROM integration_connection WHERE id=${id}`)[0]!;
  if((await tx`SELECT 1 FROM google_oauth_operation WHERE connection_id=${id} AND state IN ('WAITING','RUNNING')`).length)throw new HttpError(409,'GOOGLE_OPERATION_IN_PROGRESS');
  if(c.status!=='CONNECTED'||!c.capabilities.grantId)throw new HttpError(409,'GOOGLE_NEW_AUTHORIZATION_REQUIRED');
  const parent=(await tx`SELECT * FROM google_oauth_operation WHERE id=${c.capabilities.grantId} AND connection_id=${id} AND connection_version=${version} AND state='VERIFIED'`)[0];
  if(!parent)throw new HttpError(409,'GOOGLE_NEW_AUTHORIZATION_REQUIRED');
  const tokens=opened<StoredTokens>('google-result:'+parent.id,parent.result);if(!tokens.refreshToken)throw new HttpError(409,'GOOGLE_REFRESH_REQUIRED');
  const operationId=randomUUID(),credentials=await client(tx,c);
  await tx`INSERT INTO google_oauth_operation(id,connection_id,connection_version,kind,actor_id,session_id,actor_role,actor_branch_id,state,previous_operation_id)
   VALUES(${operationId},${id},${version},'CHECK',${actor.id},${session},${actor.role},${actor.branchId},'RUNNING',${parent.id})`;
  return {id:operationId,credentials,tokens,scopes:parent.scopes as string[]};
 });
 const r=await exchangeResult(()=>adapter.refresh(claim.credentials,claim.tokens.refreshToken!,claim.scopes),adapter,claim.tokens.refreshToken);
 return finish(db,actor,request,claim.id,id,r.tokens,r.subject,r.error);
}
