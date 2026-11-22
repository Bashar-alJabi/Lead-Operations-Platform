import type postgres from 'postgres';
import type { FastifyRequest } from 'fastify';
import { lockCurrentSession,type Principal } from '../security.js';

export { lockCurrentSession as currentPaymentSession };
export async function currentPaymentActor(tx:postgres.TransactionSql,actor:Principal,request:FastifyRequest) {
  return (await lockCurrentSession(tx,actor,request))!==null;
}
