import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { metaMediaCapabilities, validateMetaOutboundMedia } from '../src/media/meta-outbound.js';
import { validateMedia, type MediaKind, MediaError } from '../src/media/validation.js';
import { mediaCaptionAllowed } from '../src/media/outbound-policy.js';
import { ffprobeMediaProbe } from '../src/media/probe.js';
import { webpMetadata } from '../src/media/webp.js';
import { metaWhatsAppSendAdapter, ProviderSendError } from '../src/messaging/providers.js';

const fixture=(name:string)=>readFile(`test-fixtures/media/${name}`);
test('real synthetic audio/video/sticker bytes meet provider format and codec rules; spoofed codecs fail',async()=> {
  for (const [name,kind,mime] of [['tone.ogg','audio','audio/ogg'],['tone.mp3','audio','audio/mpeg'],
    ['tone.m4a','audio','audio/mp4'],['clip.mp4','video','video/mp4'],['sticker.webp','sticker','image/webp'],
    ['animated.webp','sticker','image/webp']] as const) {
    const bytes=await fixture(name);
    await validateMedia(bytes,kind,mime,createHash('sha256').update(bytes).digest('hex'));
    await validateMetaOutboundMedia(bytes,kind,mime);
  }
  await assert.rejects(validateMetaOutboundMedia(await fixture('vorbis.ogg'),'audio','audio/ogg'),/MEDIA_CODEC_NOT_SUPPORTED/);
  await assert.rejects(validateMetaOutboundMedia(await fixture('mpeg4.mp4'),'video','video/mp4'),/MEDIA_CODEC_NOT_SUPPORTED/);
  await assert.rejects(validateMetaOutboundMedia(await fixture('clip.mp4'),'audio','audio/mp4'),/MEDIA_CODEC_NOT_SUPPORTED/);
  await assert.rejects(ffprobeMediaProbe.inspect(Buffer.from('https://example.test/evil')),/MEDIA_FORMAT_INVALID/);
});
test('provider limits, captions and WebP dimensions are enforced independently of business sending limits',async()=> {
  const capabilities=metaMediaCapabilities();
  assert.deepEqual(capabilities.media,['image','document','audio','video','sticker']);
  assert.equal(capabilities.mediaRules.audio!.maxBytes,16*1024*1024);
  assert.equal(capabilities.mediaRules.sticker!.staticMaxBytes,100*1024);
  assert.equal(mediaCaptionAllowed('video','Caption'),true);
  assert.equal(mediaCaptionAllowed('audio','Caption'),false);
  assert.equal(mediaCaptionAllowed('sticker',' '),false);
  assert.equal(mediaCaptionAllowed('audio',''),true);
  assert.equal(mediaCaptionAllowed('image','x'.repeat(1025)),false);
  assert.deepEqual(webpMetadata(await fixture('sticker.webp')),{ width:512,height:512,animated:false });
  assert.deepEqual(webpMetadata(await fixture('animated.webp')),{ width:512,height:512,animated:true });
  const wrongDimensions=Buffer.from(await fixture('sticker.webp'));
  wrongDimensions[21]=0; // VP8L width bit field becomes 257 instead of 512.
  await assert.rejects(validateMetaOutboundMedia(wrongDimensions,'sticker','image/webp'),/MEDIA_STICKER_DIMENSIONS_INVALID/);
  const truncated=await fixture('animated.webp');
  assert.throws(()=>webpMetadata(truncated.subarray(0,truncated.length-1)),/MEDIA_FORMAT_INVALID/);
  for (const [kind,size] of [['image',5*1024*1024],['audio',16*1024*1024],['video',16*1024*1024],['sticker',500*1024]] as const)
    await assert.rejects(validateMetaOutboundMedia(Buffer.alloc(size+1),kind,capabilities.mediaRules[kind]!.mimes[0]!),/MEDIA_PROVIDER_SIZE_INVALID/);
  const padded=Buffer.concat([await fixture('sticker.webp'),Buffer.alloc(100*1024)]);
  // A valid unknown RIFF chunk still cannot bypass the static sticker limit.
  padded.writeUInt32LE(padded.length-8,4);padded.write('EXIF',52);padded.writeUInt32LE(padded.length-60,56);
  await assert.rejects(validateMetaOutboundMedia(padded,'sticker','image/webp'),/MEDIA_PROVIDER_SIZE_INVALID/);
  await assert.rejects(validateMetaOutboundMedia(Buffer.alloc(1),'video','video/mp4',{
    inspect:async()=>[{ type:'video',codec:'h264' },{ type:'audio',codec:'aac' },{ type:'audio',codec:'aac' }],
  }),/MEDIA_CODEC_NOT_SUPPORTED/);
});
test('unavailable ffprobe fails closed with a retryable safe code',async(t)=> {
  const previous=process.env.MEDIA_PROBE_BINARY;t.after(()=> {
    if (previous===undefined) delete process.env.MEDIA_PROBE_BINARY;else process.env.MEDIA_PROBE_BINARY=previous;
  });
  process.env.MEDIA_PROBE_BINARY='nonexistent-lead-platform-probe';
  await assert.rejects(ffprobeMediaProbe.inspect(await fixture('tone.ogg')),(error)=>
    error instanceof MediaError && error.retryable && error.code==='MEDIA_PROBE_UNAVAILABLE');
});
test('Meta sends all supported attachment types with the correct immutable caption shape and rejects unsupported captions before I/O',async(t)=> {
  const original=globalThis.fetch;t.after(()=> { globalThis.fetch=original; });let calls=0;
  const common={ config:{ wabaId:'123',graphVersion:'v25.0' },credentials:{ accessToken:'test',appSecret:'test',verifyToken:'test' },
    externalSenderId:'456',recipient:'+15550002222',filename:'generated-safe-name',providerMediaId:'789' };
  let expectedKind:MediaKind='video';let expectedCaption='';let expectedMime='';let expectedBytes=Buffer.alloc(0);
  globalThis.fetch=async(url,options)=> {
    calls++;
    if (String(url).endsWith('/media')) {
      const form=options!.body as FormData;assert.equal(form.get('type'),expectedMime);
      const file=form.get('file') as File;assert.equal(file.type,expectedMime);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()),expectedBytes);
      return Response.json({ id:'789' });
    }
    const body=JSON.parse(options!.body as string);
    assert.equal(body.type,expectedKind);
    assert.deepEqual(body[expectedKind],{ id:'789',...(expectedCaption ? { caption:expectedCaption } : {}) });
    return Response.json({ messages:[{ id:'wamid.test-'+calls }] });
  };
  for (const kind of ['video','audio','sticker'] as const) {
    expectedKind=kind;expectedCaption=kind==='video' ? '<b>Literal caption</b>' : '';
    expectedMime=kind==='audio' ? 'audio/ogg' : kind==='video' ? 'video/mp4' : 'image/webp';
    expectedBytes=await fixture(kind==='audio' ? 'tone.ogg' : kind==='video' ? 'clip.mp4' : 'animated.webp');
    await metaWhatsAppSendAdapter.uploadMedia!({ ...common,mediaKind:kind,caption:expectedCaption,mime:expectedMime,bytes:expectedBytes });
    await metaWhatsAppSendAdapter.sendMedia!({ ...common,mediaKind:kind,caption:expectedCaption });
  }
  for (const kind of ['audio','sticker'] as const)
    await assert.rejects(metaWhatsAppSendAdapter.sendMedia!({ ...common,mediaKind:kind,caption:'Cannot be dropped' }),
      (error)=>error instanceof ProviderSendError && error.kind==='REJECTED');
  assert.equal(calls,6);
  await assert.rejects(metaWhatsAppSendAdapter.uploadMedia!({ ...common,mediaKind:'audio',mime:'audio/ogg',caption:'',
    bytes:await fixture('vorbis.ogg') }),/MEDIA_CODEC_NOT_SUPPORTED/);
  assert.equal(calls,6);
});
