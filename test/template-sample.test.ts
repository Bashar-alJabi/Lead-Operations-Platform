import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { metaTemplateSampleAdapter, validSampleHandle } from '../src/media/template-sample-provider.js';
test('sample adapter confines resumable sessions, preserves bytes, bounds failures and never exposes credentials in errors',async()=> {
  const original=globalThis.fetch;const bytes=Buffer.from('%PDF-1.7\n%%EOF\n');const config={ graphVersion:'v25.0',wabaId:'123' };
  const credentials={ accessToken:'synthetic-provider-token-no-live',appSecret:'synthetic-app-secret',verifyToken:'synthetic-verify-token' };const requests:{ url:string;init:RequestInit|undefined }[]=[];
  let scenario:'ok'|'url'|'redirect'|'bad-handle'|'auth'|'retry'|'oversized'='ok';
  globalThis.fetch=async(input,init)=> {
    requests.push({ url:String(input),init });
    if (scenario==='redirect') throw new Error('secret must never leak '+credentials.accessToken);
    if (scenario==='auth') return new Response('secret response',{ status:401 });
    if (scenario==='retry') return new Response('secret response',{ status:429 });
    if (String(input).includes('/app/uploads')) return Response.json({ id:scenario==='url' ? 'https://evil.test/upload' : 'upload:abc_DEF==?sig=safe_123' });
    if (scenario==='oversized') return new Response('x'.repeat(32769));
    return Response.json({ h:scenario==='bad-handle' ? 'bad\nhandle' : '2:synthetic:test_only_handle' });
  };
  try {
    assert.equal(validSampleHandle(null),false);assert.equal(validSampleHandle('secret\r\nheader'),false);
    const result=await metaTemplateSampleAdapter.upload({ config,credentials,bytes,mime:'application/pdf',kind:'document' });
    assert.equal(result.handle,'2:synthetic:test_only_handle');assert.equal(requests.length,2);
    const start=new URL(requests[0]!.url);assert.equal(start.origin,'https://graph.facebook.com');assert.equal(start.pathname,'/v25.0/app/uploads');
    assert.equal(start.searchParams.get('file_type'),'application/pdf');assert.equal(start.searchParams.get('file_length'),String(bytes.length));
    assert.equal(start.searchParams.get('file_name'),'approval-sample.pdf');assert.equal(start.searchParams.has('access_token'),false);
    assert.equal(requests[1]!.url,'https://graph.facebook.com/v25.0/upload:abc_DEF==?sig=safe_123');
    assert.equal((requests[1]!.init!.headers as Record<string,string>).file_offset,'0');
    assert.equal((requests[1]!.init!.headers as Record<string,string>).Authorization,'OAuth '+credentials.accessToken);
    assert.equal(requests[1]!.init!.redirect,'error');assert.deepEqual(Buffer.from(requests[1]!.init!.body as Uint8Array),bytes);
    for (const [mode,code,retryable] of [['url','SAMPLE_PROVIDER_SESSION_INVALID',true],['redirect','SAMPLE_PROVIDER_UNAVAILABLE',true],
      ['bad-handle','SAMPLE_PROVIDER_RESPONSE_INVALID',true],['auth','SAMPLE_PROVIDER_AUTH_FAILED',false],['retry','SAMPLE_PROVIDER_REQUEST_FAILED',true],
      ['oversized','SAMPLE_PROVIDER_RESPONSE_INVALID',true]] as const) {
      scenario=mode;await assert.rejects(metaTemplateSampleAdapter.upload({ config,credentials,bytes,mime:'application/pdf',kind:'document' }),
        (error:unknown)=>error instanceof Error && 'retryable' in error && error.message===code && error.retryable===retryable);
    }
    const count=requests.length;
    await assert.rejects(metaTemplateSampleAdapter.upload({ config:{ ...config,graphVersion:'https://evil.test' },credentials,bytes,mime:'application/pdf',kind:'document' }),/SAMPLE_PROVIDER_CONFIG_INVALID/);
    await assert.rejects(metaTemplateSampleAdapter.upload({ config,credentials,bytes:await readFile('test-fixtures/media/mpeg4.mp4'),mime:'video/mp4',kind:'video' }),/MEDIA_CODEC_NOT_SUPPORTED/);
    assert.equal(requests.length,count);
  } finally { globalThis.fetch=original; }
});
