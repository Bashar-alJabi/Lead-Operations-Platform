import type {FastifyRequest} from 'fastify';
import type postgres from 'postgres';
import {HttpError,sha256,type Principal} from './security.js';
import {currentPaymentSession} from './payments/access.js';

function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value)??'null';
}
export function bulkHash(value:unknown){return sha256(canonical(value));}
export async function bulkSession(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest){
 await tx`SET LOCAL statement_timeout='8s'`;await tx`SET LOCAL lock_timeout='750ms'`;
 const id=await currentPaymentSession(tx,actor,request);if(!id)throw new HttpError(403,'BULK_ACCESS_REVOKED');return id;
}
export function bulkScope(tx:postgres.TransactionSql,actor:Principal){
 return tx`l.organization_id=${actor.organizationId} AND (${actor.role==='SUPER_ADMIN'} OR l.branch_id=${actor.branchId}
  AND (${actor.role==='MANAGER'} OR ${actor.role==='AGENT'} AND l.assigned_agent_id=${actor.id}))`;
}
export function bulkDeadline(variable:string){
 const budget=Number(process.env[variable]??15000);
 if(!Number.isInteger(budget)||budget<100||budget>30000)throw new Error('Invalid '+variable);
 return Date.now()+budget;
}
export function bulkFailure(error:unknown):string{
 if(error instanceof HttpError)return error.code;
 if(error instanceof Error&&'code'in error&&['55P03','57014','40001','40P01'].includes(String(error.code)))return 'BULK_ITEM_RETRYABLE';
 throw error;
}
