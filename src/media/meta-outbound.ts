import { MediaError, mediaMimeTypes, mediaMaxBytes, type MediaKind } from './validation.js';
import { ffprobeMediaProbe, type MediaProbe } from './probe.js';
import { webpMetadata } from './webp.js';
import { mediaSupportsCaption } from './outbound-policy.js';

// Provider protocol profile, isolated from campaign/business rules; review against Meta on adapter upgrades.
export const metaMediaProfile = {
  revision:'meta-cloud-media-2026-10-04',
  limits:{ image:5*1024*1024,document:100*1024*1024,audio:16*1024*1024,video:16*1024*1024,sticker:500*1024 },
  staticStickerMaxBytes:100*1024, stickerWidth:512, stickerHeight:512,
} as const;
export function metaMediaCapabilities() {
  return { media:Object.keys(mediaMimeTypes), mediaProfile:metaMediaProfile.revision,
    mediaRules:Object.fromEntries(Object.entries(mediaMimeTypes).map(([kind,mimes])=>[kind,{
      mimes,maxBytes:Math.min(metaMediaProfile.limits[kind as MediaKind],mediaMaxBytes()),
      caption:mediaSupportsCaption(kind as MediaKind),
      ...(kind==='sticker' ? { staticMaxBytes:metaMediaProfile.staticStickerMaxBytes,width:512,height:512 } : {}),
    }])) };
}
export async function validateMetaOutboundMedia(bytes:Buffer,kind:MediaKind,mime:string,probe:MediaProbe=ffprobeMediaProbe) {
  if (!(mediaMimeTypes[kind] as readonly string[]).includes(mime)) throw new MediaError('MEDIA_TYPE_UNSUPPORTED');
  if (bytes.length>metaMediaProfile.limits[kind]) throw new MediaError('MEDIA_PROVIDER_SIZE_INVALID');
  if (kind==='sticker') {
    const data=webpMetadata(bytes);
    if (data.width!==metaMediaProfile.stickerWidth || data.height!==metaMediaProfile.stickerHeight)
      throw new MediaError('MEDIA_STICKER_DIMENSIONS_INVALID');
    if (!data.animated && bytes.length>metaMediaProfile.staticStickerMaxBytes)
      throw new MediaError('MEDIA_PROVIDER_SIZE_INVALID');
  } else if (kind==='audio' || kind==='video') {
    const streams=await probe.inspect(bytes);
    const audio=streams.filter((s)=>s.type==='audio'); const video=streams.filter((s)=>s.type==='video');
    const expectedAudio=mime==='audio/ogg' ? 'opus' : mime==='audio/mpeg' ? 'mp3' : 'aac';
    if (kind==='audio' ? streams.length!==1 || audio.length!==1 || audio[0]!.codec!==expectedAudio
      : video.length!==1 || video[0]!.codec!=='h264' || audio.length>1 || audio.some((s)=>s.codec!=='aac')
        || streams.length!==audio.length+video.length) throw new MediaError('MEDIA_CODEC_NOT_SUPPORTED');
  }
}
