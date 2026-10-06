// Pure financial dispatch rules. All instants must come from PostgreSQL, never the application clock.
// Durable workers must preserve every attempt and apply current authorization separately before I/O.
export type PaymentAttemptEvidence = { number:number;state:'RUNNING'|'ACKNOWLEDGED'|'REJECTED'|'RETRYABLE'|'UNKNOWN'|'INTERRUPTED' };
export type PaymentDispatchPolicy = { maxAttempts:number;retentionMs:number;dispatchBudgetMs:number;retryBaseMs:number;retryMaxMs:number };
export type PaymentDispatchContext = { nowMs:number;firstDispatchMs:number|null;history:readonly PaymentAttemptEvidence[];policy:PaymentDispatchPolicy };
type Denial='PAYMENT_DISPATCH_EVIDENCE_INVALID'|'PAYMENT_DISPATCH_CLOCK_INVALID'|'PAYMENT_DISPATCH_ALREADY_ACCEPTED'
  |'PAYMENT_DISPATCH_REJECTED'|'PAYMENT_DISPATCH_ATTEMPTS_EXHAUSTED'|'PAYMENT_DISPATCH_WINDOW_ELAPSED'|'PAYMENT_DISPATCH_ATTEMPT_IN_PROGRESS';
type Window = { allowed:true;deadlineMs:number|null } | { allowed:false;reason:Denial;deadlineMs:number|null };
export type PaymentAttemptResolution = { state:'ACCEPTED'|'FAILED'|'NEEDS_ATTENTION';uncertain:boolean;reason:Denial|null }
  | { state:'RETRY';uncertain:boolean;reason:null;runAfterMs:number;deadlineMs:number };
const states=new Set(['RUNNING','ACKNOWLEDGED','REJECTED','RETRYABLE','UNKNOWN','INTERRUPTED']);
function positiveInteger(n:number) { return Number.isSafeInteger(n) && n>0; }
function validEvidence(context:PaymentDispatchContext):boolean {
  return Array.isArray(context.history) && Array.from(context.history).every((attempt,index)=>attempt?.number===index+1 && states.has(attempt.state))
    && (context.firstDispatchMs===null ? context.history.length===0 : Number.isSafeInteger(context.firstDispatchMs)
      && context.firstDispatchMs>=0 && context.history.length>0);
}
function validPolicy(context:PaymentDispatchContext):boolean {
  const p=context.policy;
  return !!p && positiveInteger(p.maxAttempts) && positiveInteger(p.retentionMs) && positiveInteger(p.dispatchBudgetMs)
    && p.retentionMs>p.dispatchBudgetMs && positiveInteger(p.retryBaseMs) && positiveInteger(p.retryMaxMs) && p.retryMaxMs>=p.retryBaseMs
    && Number.isSafeInteger(context.nowMs) && context.nowMs>=0
    && (context.firstDispatchMs===null || Number.isSafeInteger(context.firstDispatchMs+p.retentionMs));
}
export function paymentAttemptUncertain(history:readonly PaymentAttemptEvidence[]):boolean {
  return !Array.isArray(history) || Array.from(history).some((attempt)=>!attempt || !states.has(attempt.state) || ['RUNNING','UNKNOWN','INTERRUPTED'].includes(attempt.state));
}
// An earlier acknowledged result is permanent evidence of Link acceptance, never evidence of Paid/Enrollment.
export function paymentDispatchWindow(context:PaymentDispatchContext):Window {
  if(!validEvidence(context))return { allowed:false,reason:'PAYMENT_DISPATCH_EVIDENCE_INVALID',deadlineMs:null };
  // Operational policy/time corruption does not erase a valid historical acknowledgement.
  if(context.history.some((attempt)=>attempt.state==='ACKNOWLEDGED'))return { allowed:false,reason:'PAYMENT_DISPATCH_ALREADY_ACCEPTED',deadlineMs:null };
  if(!validPolicy(context))return { allowed:false,reason:'PAYMENT_DISPATCH_EVIDENCE_INVALID',deadlineMs:null };
  const deadline=context.firstDispatchMs===null ? null : context.firstDispatchMs+context.policy.retentionMs;
  // An unexpired I/O attempt must never be retried in parallel. Lease recovery first records INTERRUPTED.
  if(context.history.some((attempt)=>attempt.state==='RUNNING'))return { allowed:false,reason:'PAYMENT_DISPATCH_ATTEMPT_IN_PROGRESS',deadlineMs:deadline };
  if(context.firstDispatchMs!==null && context.nowMs<context.firstDispatchMs)return { allowed:false,reason:'PAYMENT_DISPATCH_CLOCK_INVALID',deadlineMs:deadline };
  if(context.history.at(-1)?.state==='REJECTED')return { allowed:false,reason:'PAYMENT_DISPATCH_REJECTED',deadlineMs:deadline };
  if(context.history.length>=context.policy.maxAttempts)return { allowed:false,reason:'PAYMENT_DISPATCH_ATTEMPTS_EXHAUSTED',deadlineMs:deadline };
  if(!Number.isSafeInteger(context.nowMs+context.policy.dispatchBudgetMs))return { allowed:false,reason:'PAYMENT_DISPATCH_CLOCK_INVALID',deadlineMs:deadline };
  if(deadline!==null && context.nowMs+context.policy.dispatchBudgetMs>=deadline)return { allowed:false,reason:'PAYMENT_DISPATCH_WINDOW_ELAPSED',deadlineMs:deadline };
  return { allowed:true,deadlineMs:deadline };
}
export function resolvePaymentAttempt(context:PaymentDispatchContext,retryAfterSeconds:number|null=null,jitterMs=0):PaymentAttemptResolution {
  const uncertain=paymentAttemptUncertain(context.history);
  const window=paymentDispatchWindow(context);
  if(!window.allowed) {
    if(window.reason==='PAYMENT_DISPATCH_ALREADY_ACCEPTED')return { state:'ACCEPTED',uncertain:false,reason:null };
    const invalid=['PAYMENT_DISPATCH_EVIDENCE_INVALID','PAYMENT_DISPATCH_CLOCK_INVALID'].includes(window.reason);
    return { state:uncertain || invalid ? 'NEEDS_ATTENTION' : 'FAILED',uncertain,reason:window.reason };
  }
  // A finish decision needs at least one completed/expired attempt; an empty history is for initial claim only.
  if(window.deadlineMs===null || !context.history.length || !Number.isSafeInteger(jitterMs) || jitterMs<0 || jitterMs>context.policy.retryMaxMs
    || (retryAfterSeconds!==null && (!positiveInteger(retryAfterSeconds) || !Number.isSafeInteger(retryAfterSeconds*1000))))
    return { state:'NEEDS_ATTENTION',uncertain,reason:'PAYMENT_DISPATCH_EVIDENCE_INVALID' };
  const delay=Math.max(Math.min(context.policy.retryMaxMs,context.policy.retryBaseMs*2**Math.min(context.history.length-1,30)),(retryAfterSeconds ?? 0)*1000)+jitterMs;
  const runAfterMs=context.nowMs+delay;
  if(!Number.isSafeInteger(runAfterMs) || !Number.isSafeInteger(runAfterMs+context.policy.dispatchBudgetMs))
    return { state:'NEEDS_ATTENTION',uncertain,reason:'PAYMENT_DISPATCH_CLOCK_INVALID' };
  if(runAfterMs+context.policy.dispatchBudgetMs>=window.deadlineMs)
    return { state:uncertain ? 'NEEDS_ATTENTION' : 'FAILED',uncertain,reason:'PAYMENT_DISPATCH_WINDOW_ELAPSED' };
  return { state:'RETRY',uncertain,reason:null,runAfterMs,deadlineMs:window.deadlineMs };
}
