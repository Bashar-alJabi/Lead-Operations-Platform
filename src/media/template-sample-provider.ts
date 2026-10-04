import type { MessagingConnectionConfig, MessagingCredentials } from '../messaging/providers.js';
import { MediaError, type MediaKind } from './validation.js';
import { validateMetaOutboundMedia } from './meta-outbound.js';

export type TemplateSampleKind = Extract<MediaKind,'image'|'video'|'document'>;
export interface TemplateSampleAdapter {
  upload(input:{ config:MessagingConnectionConfig;credentials:MessagingCredentials;
    bytes:Buffer;mime:string;kind:TemplateSampleKind }):Promise<{ handle:string }>;
}
export function validSampleHandle(value:unknown):value is string {
  return typeof value==='string' && /^[A-Za-z0-9+/=_:-]{1,4096}$/.test(value);
}
async function responseJson(response:Response):Promise<Record<string,unknown>> {
  if (!response.ok) {
    await response.body?.cancel().catch(()=>{});
    throw new MediaError(response.status===401 || response.status===403 ? 'SAMPLE_PROVIDER_AUTH_FAILED' : 'SAMPLE_PROVIDER_REQUEST_FAILED',
      response.status===429 || response.status>=500);
  }
  const reader=response.body?.getReader();if (!reader) throw new MediaError('SAMPLE_PROVIDER_RESPONSE_INVALID',true);
  const chunks:Uint8Array[]=[];let size=0;
  try {
    for (;;) { const item=await reader.read();if (item.done) break;
      size+=item.value.length;if (size>32768) throw new MediaError('SAMPLE_PROVIDER_RESPONSE_INVALID',true);chunks.push(item.value); }
    const data:unknown=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
    if (!data || typeof data!=='object' || Array.isArray(data)) throw new Error('Invalid response');
    return data as Record<string,unknown>;
  } catch (error) { throw error instanceof MediaError ? error : new MediaError('SAMPLE_PROVIDER_RESPONSE_INVALID',true); }
  finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
}
async function request(url:string,credentials:MessagingCredentials,mime?:string,bytes?:Buffer) {
  let response:Response;
  try { response=await fetch(url,{ method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{ Authorization:`OAuth ${credentials.accessToken}`,...(bytes ? { 'Content-Type':mime!,'file_offset':'0' } : {}) },
    ...(bytes ? { body:new Uint8Array(bytes) } : {}) }); }
  catch { throw new MediaError('SAMPLE_PROVIDER_UNAVAILABLE',true); }
  return responseJson(response);
}
export const metaTemplateSampleAdapter:TemplateSampleAdapter={
  async upload({ config,credentials,bytes,mime,kind }) {
    if (!/^v\d{1,2}\.\d{1,2}$/.test(config.graphVersion) || !/^\d{1,30}$/.test(config.wabaId)
      || !credentials.accessToken) throw new MediaError('SAMPLE_PROVIDER_CONFIG_INVALID');
    if (!['image','video','document'].includes(kind)) throw new MediaError('SAMPLE_KIND_UNSUPPORTED');
    await validateMetaOutboundMedia(bytes,kind,mime);
    // The app alias refers to the app associated with the connection token. No operator URL or filename is used.
    const start=new URL(`https://graph.facebook.com/${config.graphVersion}/app/uploads`);
    start.searchParams.set('file_length',String(bytes.length));start.searchParams.set('file_type',mime);
    const extensions:Record<string,string>={ 'image/jpeg':'jpg','image/png':'png','video/mp4':'mp4','application/pdf':'pdf' };
    start.searchParams.set('file_name','approval-sample.'+extensions[mime]);
    const session=await request(start.toString(),credentials);
    if (typeof session.id!=='string' || session.id.length>2048
      || !/^upload:[A-Za-z0-9_+=:-]+(?:\?sig=[A-Za-z0-9_-]+)?$/.test(session.id))
      throw new MediaError('SAMPLE_PROVIDER_SESSION_INVALID',true);
    const result=await request(`https://graph.facebook.com/${config.graphVersion}/${session.id}`,credentials,mime,bytes);
    if (!validSampleHandle(result.h)) throw new MediaError('SAMPLE_PROVIDER_RESPONSE_INVALID',true);
    return { handle:result.h };
  },
};
