import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { parseInboundMedia, validateMedia, MediaError } from '../src/media/validation.js';
import { metaMessagingMediaAdapter } from '../src/media/meta-provider.js';
import { clamAvScanner } from '../src/media/scanner.js';
import { localMediaStorage, s3MediaStorage } from '../src/media/storage.js';

const pdf = Buffer.from('%PDF-1.7\nsample\n%%EOF');
const hash = createHash('sha256').update(pdf).digest('hex');
test('media validation rejects MIME spoofing, corrupt hashes, oversized files and unsafe provider identities', async () => {
  const source = { type: 'document', document: { id: '123', mime_type: 'application/pdf',
    sha256: Buffer.from(hash, 'hex').toString('base64'), filename: '../../evil', caption: '<b>untrusted</b>' } };
  assert.equal(parseInboundMedia(source)?.sha256, hash);
  assert.equal(parseInboundMedia(source)?.caption, '<b>untrusted</b>');
  assert.equal(parseInboundMedia({ type: 'location' }), null);
  assert.throws(() => parseInboundMedia({ ...source, document: { ...source.document, id: '../123' } }), /MEDIA_PAYLOAD_INVALID/);
  assert.throws(() => parseInboundMedia({ ...source, document: { ...source.document, mime_type: 'text/html' } }), /MEDIA_PAYLOAD_INVALID/);
  assert.equal((await validateMedia(pdf, 'document', 'application/pdf', hash)).mime, 'application/pdf');
  await assert.rejects(validateMedia(Buffer.from('<html>x</html>'), 'document', 'application/pdf', hash), /MEDIA_TYPE_MISMATCH/);
  await assert.rejects(validateMedia(pdf, 'document', 'application/pdf', '0'.repeat(64)), /MEDIA_HASH_MISMATCH/);
  const previous = process.env.MEDIA_MAX_BYTES; process.env.MEDIA_MAX_BYTES = '1024';
  try { await assert.rejects(validateMedia(Buffer.alloc(1025), 'document', 'application/pdf', hash), /MEDIA_SIZE_INVALID/); }
  finally { if (previous == null) delete process.env.MEDIA_MAX_BYTES; else process.env.MEDIA_MAX_BYTES = previous; }
});
test('Meta media retrieval binds phone identity, bounds bytes and never forwards credentials to arbitrary URLs', async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0; let url = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/test';
  let mode: 'valid'|'oversize'|'overstream'|'auth'|'timeout' = 'valid';
  const input = { config: { wabaId: '123', graphVersion: 'v25.0' },
    credentials: { accessToken: 'test-token', appSecret: 'test-app', verifyToken: 'test-verify' },
    externalSenderId: '456', mediaId: '789', maxBytes: 1024 };
  globalThis.fetch = async (path, init) => {
    calls++;
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-token');
    if (mode === 'timeout') throw new Error('Untrusted provider error with secrets');
    if (mode === 'auth') return new Response('private', { status: 401 });
    if (String(path).startsWith('https://graph.facebook.com/')) {
      assert.equal(String(path), 'https://graph.facebook.com/v25.0/789?phone_number_id=456');
      return Response.json({ id: '789', url, file_size: mode === 'oversize' ? 1025 : pdf.length });
    }
    assert.equal(String(path), url);
    return new Response(new Uint8Array(mode === 'overstream' ? Buffer.alloc(1025) : pdf));
  };
  assert.deepEqual(await metaMessagingMediaAdapter.download(input), pdf); assert.equal(calls, 2);
  for (const unsafe of ['https://example.test/steal', 'http://lookaside.fbsbx.com/file',
    'https://lookaside.fbsbx.com.evil.test/file', 'https://user@lookaside.fbsbx.com/file']) {
    url = unsafe; calls = 0;
    await assert.rejects(metaMessagingMediaAdapter.download(input), /MEDIA_PROVIDER_URL_DENIED/); assert.equal(calls, 1);
  }
  url = 'https://lookaside.fbsbx.com/attachment'; mode = 'oversize'; calls = 0;
  await assert.rejects(metaMessagingMediaAdapter.download(input), /MEDIA_SIZE_INVALID/); assert.equal(calls, 1);
  mode = 'overstream'; await assert.rejects(metaMessagingMediaAdapter.download(input), /MEDIA_SIZE_INVALID/);
  mode = 'auth'; await assert.rejects(metaMessagingMediaAdapter.download(input), /MEDIA_PROVIDER_AUTH_FAILED/);
  mode = 'timeout'; await assert.rejects(metaMessagingMediaAdapter.download(input), (error) =>
    error instanceof MediaError && error.retryable && !error.message.includes('secrets'));
});
test('private storage adapters preserve byte content, restrict keys and bound downloads', async (t) => {
  const root = await mkdtemp(resolve('.local/storage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = localMediaStorage(root); const key = `${randomUUID()}-${hash}`;
  await Promise.all([storage.put(key, pdf), storage.put(key, pdf)]);
  assert.deepEqual(await storage.get(key, 1024), pdf);
  await assert.rejects(storage.get('../escape', 1024), /MEDIA_STORAGE_KEY_INVALID/);
  await assert.rejects(storage.get(key, 1), /MEDIA_STORAGE_INTEGRITY_FAILED/);
  let stored: Buffer | null = null;
  const fake = { async send(command: { constructor: { name: string }; input: Record<string, unknown> }, options: { abortSignal: unknown }) {
    assert.equal(command.input.Bucket, 'private-test'); assert.equal(command.input.Key, `media/${key}`);
    assert.ok(options.abortSignal); assert.equal(command.input.ACL, undefined);
    if (command.constructor.name === 'PutObjectCommand') {
      assert.equal(command.input.ChecksumSHA256, Buffer.from(hash, 'hex').toString('base64'));
      stored = command.input.Body as Buffer; return {};
    }
    return { Body: { transformToWebStream: () => new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(stored!)); controller.close();
    } }) } };
  } } as unknown as S3Client;
  const s3 = s3MediaStorage(fake, 'private-test'); await s3.put(key, pdf);
  assert.deepEqual(await s3.get(key, 1024), pdf);
  await assert.rejects(s3.get(key, 1), /MEDIA_STORAGE_INTEGRITY_FAILED/);
});
test('clamd protocol accepts only complete clean responses with current definitions and fails closed', async (t) => {
  let result = 'stream: OK'; let version = `ClamAV test/1/${new Date().toUTCString()}`;
  const server = createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.toString('utf8').startsWith('zVERSION\0')) return socket.end(version + '\0');
      if (!data.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
      let offset = 10; const chunks: Buffer[] = [];
      while (offset + 4 <= data.length) {
        const length = data.readUInt32BE(offset); offset += 4;
        if (length === 0) { assert.deepEqual(Buffer.concat(chunks), pdf); socket.end(result + '\0'); return; }
        if (offset + length > data.length) return;
        chunks.push(data.subarray(offset, offset + length)); offset += length;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port; const scanner = clamAvScanner('127.0.0.1', port);
  assert.equal((await scanner.scan(pdf)).clean, true);
  result = 'stream: Eicar-Test-Signature FOUND'; assert.equal((await scanner.scan(pdf)).clean, false);
  result = 'stream: INSTREAM size limit exceeded ERROR'; await assert.rejects(scanner.scan(pdf), /MEDIA_SCANNER_UNAVAILABLE/);
  version = 'ClamAV test/1/Thu, 01 Jan 1970 00:00:00 GMT';
  await assert.rejects(scanner.scan(pdf), /MEDIA_SCANNER_DEFINITIONS_STALE/);
});
