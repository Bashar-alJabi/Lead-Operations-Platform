import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type SealedSecret = { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; keyVersion: number };

export function credentialKey(): Buffer {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex || !/^[a-f\d]{64}$/i.test(hex)) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 random bytes encoded as hex');
  return Buffer.from(hex, 'hex');
}

export function sealSecret(connectionId: string, plaintext: string, key = credentialKey()): SealedSecret {
  if (!plaintext || plaintext.length > 65536) throw new Error('Invalid credential length');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`connection:${connectionId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: 1 };
}

export function openSecret(connectionId: string, sealed: SealedSecret, key = credentialKey()): string {
  if (sealed.keyVersion !== 1) throw new Error('Unsupported credential key version');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  decipher.setAAD(Buffer.from(`connection:${connectionId}`, 'utf8'));
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
}
