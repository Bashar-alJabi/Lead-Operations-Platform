import type postgres from 'postgres';
import type { Database } from './db.js';
import { openSecret } from './credentials.js';
import { ProviderSendError, type MessagingConnectionConfig, type MessagingCredentials, type SendTemplateInput } from './messaging/providers.js';

export type StaffMessagingTransports = Readonly<Record<string, (input: SendTemplateInput) => Promise<{ providerMessageId: string }>>>;
type Tx = postgres.TransactionSql;
type JobKey = { event_id: string; user_id: string; connection_id: string };
type Claim = JobKey & { version: number; attempts: number };
type Authority = {
 config: MessagingConnectionConfig; provider: string; phone: string; external_sender_id: string;
 template_name: string; template_language: string; ready: boolean; ready_at: string;
 ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; key_version: number;
};
type Prepared = {input:SendTemplateInput;send:StaffMessagingTransports[string]};
type Outcome = { state: 'ACCEPTED'|'UNKNOWN'|'REJECTED'|'SUPPRESSED'|'WAITING'; code: string|null; providerId?: string; retryAfter?: number };
const unknown:Outcome={state:'UNKNOWN',code:'PROVIDER_SEND_OUTCOME_UNKNOWN'};
const stale:Outcome={state:'SUPPRESSED',code:'STAFF_MESSAGING_CONTEXT_CHANGED'};
const noTransport:Outcome={state:'SUPPRESSED',code:'STAFF_MESSAGING_TRANSPORT_UNAVAILABLE'};

async function lockConnection(tx:Tx,connectionId:string) {
 return (await tx`SELECT id FROM integration_connection WHERE id=${connectionId} FOR UPDATE SKIP LOCKED`).length>0;
}

async function loadAuthority(tx:Tx,job:JobKey):Promise<Authority|undefined> {
 const [scope]=await tx`SELECT e.branch_id,e.lead_id,e.campaign_id,e.follow_up_id,e.conversation_id,e.event_type,
   b.sender_id,b.template_id FROM notification_event e JOIN staff_messaging_outbox o ON o.event_id=e.id
   JOIN staff_messaging_binding b ON b.branch_id=e.branch_id AND b.event_type=e.event_type AND b.language=o.language
   WHERE e.id=${job.event_id} AND o.user_id=${job.user_id}`;
 if(!scope)return;
 await tx`SELECT id FROM branch WHERE id=${scope.branch_id} FOR SHARE`;
 if(scope.lead_id)await tx`SELECT id FROM lead WHERE id=${scope.lead_id} FOR SHARE`;
 if(scope.campaign_id)await tx`SELECT id FROM campaign WHERE id=${scope.campaign_id} FOR SHARE`;
 if(scope.conversation_id)await tx`SELECT id FROM conversation WHERE id=${scope.conversation_id} FOR SHARE`;
 if(scope.follow_up_id)await tx`SELECT id FROM follow_up WHERE id=${scope.follow_up_id} FOR SHARE`;
 await tx`SELECT id FROM user_account WHERE id=${job.user_id} FOR SHARE`;
 await tx`SELECT user_id FROM staff_messaging_destination WHERE user_id=${job.user_id} FOR SHARE`;
 await tx`SELECT user_id FROM staff_messaging_preference WHERE user_id=${job.user_id} AND event_type=${scope.event_type} FOR SHARE`;
 await tx`SELECT id FROM messaging_sender WHERE id=${scope.sender_id} AND connection_id=${job.connection_id} FOR SHARE`;
 await tx`SELECT id FROM provider_message_template WHERE id=${scope.template_id} AND connection_id=${job.connection_id} FOR SHARE`;
 await tx`SELECT b.branch_id FROM staff_messaging_binding b JOIN staff_messaging_outbox o ON o.language=b.language
  WHERE b.branch_id=${scope.branch_id} AND b.event_type=${scope.event_type} AND o.event_id=${job.event_id} AND o.user_id=${job.user_id} FOR SHARE OF b`;
 return (await tx<Authority[]>`SELECT c.config,c.provider,d.phone,s.external_sender_id,t.name AS template_name,t.language AS template_language,
    x.available_at<=clock_timestamp() AS ready,x.available_at::text AS ready_at,secret.ciphertext,secret.nonce,secret.auth_tag,secret.key_version
   FROM staff_messaging_dispatch_context(${job.event_id},${job.user_id}) x JOIN integration_connection c ON c.id=x.connection_id
   JOIN staff_messaging_destination d ON d.user_id=${job.user_id} JOIN messaging_sender s ON s.id=x.sender_id
   JOIN provider_message_template t ON t.id=x.template_id JOIN connection_secret secret ON secret.connection_id=c.id
   WHERE c.id=${job.connection_id} AND x.sender_id=${scope.sender_id} AND x.template_id=${scope.template_id}`)[0];
}

async function claim(db:Database,transports:StaffMessagingTransports|null):Promise<Claim|boolean> {
 return db.begin(async tx=>{
  await tx`SET LOCAL lock_timeout='750ms'`;
  await tx`SET LOCAL statement_timeout='5s'`;
  const expired=await tx<JobKey[]>`SELECT event_id,user_id,connection_id FROM staff_messaging_dispatch
   WHERE state='SENDING' AND lease_until<=clock_timestamp() ORDER BY lease_until,event_id,user_id LIMIT 20`;
  for(const job of expired){
   if(!await lockConnection(tx,job.connection_id))continue;
   const changed=await tx`UPDATE staff_messaging_dispatch SET version=version+1,state='UNKNOWN',error_code=${unknown.code}
    WHERE event_id=${job.event_id} AND user_id=${job.user_id} AND state='SENDING' AND lease_until<=clock_timestamp() RETURNING 1`;
   if(changed.length)return true;
  }
  if(!transports)return false;
  const batch=await tx<JobKey[]>`SELECT d.event_id,d.user_id,d.connection_id FROM staff_messaging_dispatch d
   WHERE d.state='WAITING' AND d.run_at<=statement_timestamp() AND NOT EXISTS(
    SELECT 1 FROM staff_messaging_dispatch busy WHERE busy.connection_id=d.connection_id AND busy.state='SENDING')
   ORDER BY d.run_at,d.event_id,d.user_id LIMIT 20`;
  for(const job of batch){
   if(!await lockConnection(tx,job.connection_id))continue;
   const [waiting]=await tx`SELECT event_id FROM staff_messaging_dispatch d
    WHERE d.event_id=${job.event_id} AND d.user_id=${job.user_id} AND d.state='WAITING' AND d.run_at<=clock_timestamp()
     AND NOT EXISTS(SELECT 1 FROM staff_messaging_dispatch busy WHERE busy.connection_id=d.connection_id AND busy.state='SENDING')
    FOR UPDATE OF d SKIP LOCKED`;
   if(!waiting)continue;
   const authority=await loadAuthority(tx,job);
   if(!authority || !Object.hasOwn(transports,authority.provider)){
    await tx`UPDATE staff_messaging_dispatch SET version=version+1,state='SUPPRESSED',error_code=${authority?noTransport.code:stale.code}
     WHERE event_id=${job.event_id} AND user_id=${job.user_id}`;
    return true;
   }
   if(!authority.ready){
    await tx`UPDATE staff_messaging_dispatch SET version=version+1,run_at=${authority.ready_at}::timestamptz,error_code='PROVIDER_RATE_LIMITED'
     WHERE event_id=${job.event_id} AND user_id=${job.user_id}`;
    return true;
   }
   const [claimed]=await tx<Claim[]>`UPDATE staff_messaging_dispatch SET version=version+1,state='SENDING'
    WHERE event_id=${job.event_id} AND user_id=${job.user_id} RETURNING event_id,user_id,connection_id,version,attempts`;
   return claimed!;
  }
  return false;
 });
}

async function currentTransport(db:Database,job:Claim,transports:StaffMessagingTransports):Promise<Prepared|undefined> {
 return db.begin<Prepared|undefined>(async tx=>{
  await tx`SET LOCAL lock_timeout='750ms'`;
  await tx`SET LOCAL statement_timeout='5s'`;
  await tx`SELECT id FROM integration_connection WHERE id=${job.connection_id} FOR SHARE`;
  if(!(await tx`SELECT 1 FROM staff_messaging_dispatch WHERE event_id=${job.event_id} AND user_id=${job.user_id}
    AND state='SENDING' AND version=${job.version} AND lease_until>clock_timestamp() FOR SHARE`).length)return;
  const a=await loadAuthority(tx,job);
  if(!a?.ready || !Object.hasOwn(transports,a.provider))return;
  let credentials:MessagingCredentials;
  try {
   credentials=JSON.parse(openSecret(job.connection_id,{ciphertext:a.ciphertext,nonce:a.nonce,authTag:a.auth_tag,keyVersion:a.key_version}));
   if(typeof credentials?.accessToken!=='string'||!credentials.accessToken.trim())return;
  }catch{return;}
  const input:SendTemplateInput={config:a.config,credentials,externalSenderId:a.external_sender_id,
   recipient:a.phone,templateName:a.template_name,templateLanguage:a.template_language};
  return {input,send:transports[a.provider]!};
 });
}

async function resolve(db:Database,job:Claim,outcome:Outcome) {
 await db.begin(async tx=>{
  await tx`SELECT id FROM integration_connection WHERE id=${job.connection_id} FOR UPDATE`;
  const [current]=await tx`SELECT lease_until>clock_timestamp() AS live_lease FROM staff_messaging_dispatch
   WHERE event_id=${job.event_id} AND user_id=${job.user_id} AND state='SENDING' AND version=${job.version} FOR UPDATE`;
  if(!current)return;
  const result:Outcome=current.live_lease?outcome:unknown;
  if(result.retryAfter)await tx`UPDATE integration_connection SET cooldown_until=GREATEST(
   COALESCE(cooldown_until,clock_timestamp()),clock_timestamp()+make_interval(secs=>${result.retryAfter}::double precision))
   WHERE id=${job.connection_id}`;
  if(result.code==='PROVIDER_AUTH_FAILED')await tx`UPDATE integration_connection c SET status='AUTH_EXPIRED',
   last_failure_at=clock_timestamp(),last_error_code='PROVIDER_AUTH_FAILED',updated_at=clock_timestamp()
   FROM staff_messaging_outbox o WHERE c.id=${job.connection_id} AND c.version=o.connection_version
    AND c.status IN ('CONNECTED','WARNING') AND o.event_id=${job.event_id} AND o.user_id=${job.user_id}`;
  await tx`UPDATE staff_messaging_dispatch SET version=version+1,state=${result.state},error_code=${result.code},
   provider_message_id=${result.providerId??null},run_at=clock_timestamp()+make_interval(secs=>${result.retryAfter??0}::double precision)
   WHERE event_id=${job.event_id} AND user_id=${job.user_id}`;
 });
}

export async function processOneStaffMessagingDispatch(db:Database,transports:StaffMessagingTransports|null):Promise<boolean> {
 const job=await claim(db,transports);
 if(typeof job==='boolean')return job;
 const prepared=await currentTransport(db,job,transports!);
 let outcome:Outcome=stale;
 if(prepared){
  try {
   const {providerMessageId}=await prepared.send(prepared.input);
   outcome=typeof providerMessageId==='string' && providerMessageId.length<=255 && /^[^\s\x00-\x1f\x7f]+$/u.test(providerMessageId)
    ? {state:'ACCEPTED',code:null,providerId:providerMessageId} : unknown;
  } catch(error) {
   outcome=unknown;
   if(error instanceof ProviderSendError){
    if(error.kind==='RETRYABLE'&&error.code==='PROVIDER_RATE_LIMITED'){
     const delay=Math.min(3600,Math.max(1,Number.isFinite(error.retryAfterSeconds)?error.retryAfterSeconds!:30));
     outcome={state:job.attempts<3?'WAITING':'REJECTED',code:'PROVIDER_RATE_LIMITED',retryAfter:delay};
    } else if(error.kind==='REJECTED')outcome={state:'REJECTED',code:error.code==='PROVIDER_AUTH_FAILED'?error.code:'PROVIDER_SEND_REJECTED'};
   }
  }
 }
 try { await resolve(db,job,outcome); }
 catch(error){
  if((error as {constraint_name?:string}).constraint_name!=='staff_messaging_provider_message')throw error;
  await resolve(db,job,unknown);
 }
 return true;
}
