import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { MediaError } from './validation.js';

export interface MediaStorage {
  readonly backend: string;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string, maxBytes: number): Promise<Buffer>;
}
function checkedKey(key: string) {
  if (!/^[0-9a-f-]{36}-[0-9a-f]{64}$/.test(key)) throw new MediaError('MEDIA_STORAGE_KEY_INVALID');
  return key;
}
export function localMediaStorage(root: string): MediaStorage {
  const base = resolve(root);
  return { backend: 'LOCAL',
    async put(key, bytes) {
      const path = resolve(base, checkedKey(key));
      await mkdir(base, { recursive: true, mode: 0o700 });
      const temporary = resolve(base, `.part-${randomUUID()}`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        // Same content hash/key on every lease; atomic rename never exposes a partial file.
        await rename(temporary, path).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
          const stored = await this.get(key, bytes.length);
          if (!stored.equals(bytes)) throw new MediaError('MEDIA_STORAGE_INTEGRITY_FAILED');
        });
      } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
    },
    async get(key, maxBytes) {
      const path = await realpath(resolve(base, checkedKey(key)));
      const actualBase = await realpath(base);
      if (dirname(path) !== actualBase || relative(actualBase, path).startsWith('..'))
        throw new MediaError('MEDIA_STORAGE_KEY_INVALID');
      const file = await open(path, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new MediaError('MEDIA_STORAGE_INTEGRITY_FAILED');
        return await file.readFile();
      } finally { await file.close(); }
    },
  };
}
export function s3MediaStorage(client: S3Client, bucket: string): MediaStorage {
  if (!bucket) throw new MediaError('MEDIA_STORAGE_CONFIG_INVALID');
  return { backend: 'S3',
    async put(key, bytes) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: `media/${checkedKey(key)}`,
        Body: bytes, ContentType: 'application/octet-stream',
        ChecksumSHA256: createHash('sha256').update(bytes).digest('base64') }),
      { abortSignal: AbortSignal.timeout(30000) });
    },
    async get(key, maxBytes) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `media/${checkedKey(key)}` }),
        { abortSignal: AbortSignal.timeout(30000) });
      if (!result.Body) throw new MediaError('MEDIA_STORAGE_INTEGRITY_FAILED');
      const stream = result.Body.transformToWebStream();
      const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          size += item.value.length;
          if (size > maxBytes) throw new MediaError('MEDIA_STORAGE_INTEGRITY_FAILED');
          chunks.push(item.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return Buffer.concat(chunks, size);
    },
  };
}
let configured: MediaStorage | undefined;
export function configuredMediaStorage(): MediaStorage {
  if (configured) return configured;
  const backend = process.env.MEDIA_STORAGE_BACKEND ?? (process.env.NODE_ENV === 'production' ? '' : 'local');
  if (backend === 'local') configured = localMediaStorage(process.env.MEDIA_LOCAL_ROOT ?? '.local/media');
  else if (backend === 's3') configured = s3MediaStorage(new S3Client({ region: process.env.AWS_REGION,
    ...(process.env.MEDIA_S3_ENDPOINT ? { endpoint: process.env.MEDIA_S3_ENDPOINT } : {}),
    forcePathStyle: process.env.MEDIA_S3_FORCE_PATH_STYLE === 'true', maxAttempts: 2 }), process.env.MEDIA_S3_BUCKET ?? '');
  else throw new MediaError('MEDIA_STORAGE_NOT_CONFIGURED', true);
  return configured;
}
