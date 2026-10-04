import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';

export class MediaError extends Error {
  constructor(public code: string, public retryable = false) { super(code); }
}
export const mediaMimeTypes = {
  image: ['image/jpeg','image/png'], document: ['application/pdf'],
  audio: ['audio/ogg','audio/mpeg','audio/mp4'], video: ['video/mp4'], sticker: ['image/webp'],
} as const;
export type MediaKind = keyof typeof mediaMimeTypes;
export type InboundMedia = { kind: MediaKind; providerId: string; mime: string; sha256: string; caption: string };
export function mediaMaxBytes(): number {
  const value = Number(process.env.MEDIA_MAX_BYTES ?? 25 * 1024 * 1024);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 100 * 1024 * 1024)
    throw new MediaError('MEDIA_LIMIT_CONFIG_INVALID');
  return value;
}
export function parseInboundMedia(message: Record<string, unknown>): InboundMedia | null {
  if (typeof message.type !== 'string' || !Object.hasOwn(mediaMimeTypes, message.type)) return null;
  const kind = message.type as MediaKind;
  const item = message[kind];
  if (!item || typeof item !== 'object') throw new MediaError('MEDIA_PAYLOAD_INVALID');
  const data = item as Record<string, unknown>;
  if (typeof data.id !== 'string' || !/^\d{1,30}$/.test(data.id)
    || typeof data.mime_type !== 'string' || !(mediaMimeTypes[kind] as readonly string[]).includes(data.mime_type)
    || typeof data.sha256 !== 'string') throw new MediaError('MEDIA_PAYLOAD_INVALID');
  const hash = /^[0-9a-fA-F]{64}$/.test(data.sha256) ? data.sha256.toLowerCase()
    : /^[A-Za-z0-9+/]{43}=$/.test(data.sha256) ? Buffer.from(data.sha256, 'base64').toString('hex') : null;
  if (!hash || (data.caption != null && (typeof data.caption !== 'string' || data.caption.length > 20000)))
    throw new MediaError('MEDIA_PAYLOAD_INVALID');
  // Provider filenames never participate in storage paths or download headers.
  return { kind, providerId: data.id, mime: data.mime_type, sha256: hash,
    caption: typeof data.caption === 'string' ? data.caption : '' };
}
export async function validateMedia(bytes: Buffer, kind: MediaKind, mime: string, expectedHash: string) {
  if (!bytes.length || bytes.length > mediaMaxBytes()) throw new MediaError('MEDIA_SIZE_INVALID');
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
  if (!detected || detected.mime !== mime || !(mediaMimeTypes[kind] as readonly string[]).includes(mime))
    throw new MediaError('MEDIA_TYPE_MISMATCH');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== expectedHash) throw new MediaError('MEDIA_HASH_MISMATCH');
  return { hash, mime, size: bytes.length, extension: detected.ext };
}
