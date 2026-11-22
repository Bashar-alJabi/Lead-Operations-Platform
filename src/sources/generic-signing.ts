import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGenericSourceSignature(body: Buffer, connectionId: string, secret: string,
  timestamp: string | string[] | undefined, signature: string | string[] | undefined, nowSeconds: number,
  purpose: 'test'|'intake'): number | null {
  if (typeof timestamp !== 'string' || !/^[1-9][0-9]{0,11}$/.test(timestamp) ||
    typeof signature !== 'string' || !/^v1=[0-9a-f]{64}$/.test(signature) || !/^[0-9a-f]{64}$/.test(secret)) return null;
  const signedAt = Number(timestamp);
  if (Math.abs(nowSeconds - signedAt) >= 300) return null;
  const digest = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`lead-operations.generic-source:${purpose}:v1\n${connectionId}\n${timestamp}\n`)
    .update(body)
    .digest();
  return timingSafeEqual(digest, Buffer.from(signature.slice(3), 'hex')) ? signedAt : null;
}
