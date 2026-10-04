import type { MessagingConnectionConfig, MessagingCredentials } from '../messaging/providers.js';
import { MediaError } from './validation.js';

export interface MessagingMediaAdapter {
  download(input: { config: MessagingConnectionConfig; credentials: MessagingCredentials;
    externalSenderId: string; mediaId: string; maxBytes: number }): Promise<Buffer>;
}
export async function boundedResponse(response: Response, max: number): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) {
    await response.body?.cancel(); throw new MediaError('MEDIA_SIZE_INVALID');
  }
  if (!response.body) throw new MediaError('MEDIA_PROVIDER_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > max) throw new MediaError('MEDIA_SIZE_INVALID');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
async function checkedFetch(url: string, token: string) {
  let response: Response;
  try { response = await fetch(url, { headers: { Authorization: `Bearer ${token}` },
    redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { throw new MediaError('MEDIA_PROVIDER_UNAVAILABLE', true); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new MediaError('MEDIA_PROVIDER_AUTH_FAILED');
    if (response.status === 404 || response.status === 410) throw new MediaError('MEDIA_PROVIDER_NOT_FOUND');
    throw new MediaError('MEDIA_PROVIDER_UNAVAILABLE', response.status === 429 || response.status >= 500);
  }
  return response;
}
export const metaMessagingMediaAdapter: MessagingMediaAdapter = {
  async download({ config, credentials, externalSenderId, mediaId, maxBytes }) {
    if (!/^v\d{1,2}\.\d{1,2}$/.test(config.graphVersion) || !/^\d{1,30}$/.test(mediaId)
      || !/^\d{1,30}$/.test(externalSenderId)) throw new MediaError('MEDIA_PROVIDER_INPUT_INVALID');
    const metadata = await checkedFetch(`https://graph.facebook.com/${config.graphVersion}/${mediaId}`
      + `?phone_number_id=${externalSenderId}`, credentials.accessToken);
    let payload: { id?: unknown; url?: unknown; file_size?: unknown };
    try { payload = JSON.parse((await boundedResponse(metadata, 16384)).toString('utf8')); }
    catch (error) { if (error instanceof MediaError) throw error; throw new MediaError('MEDIA_PROVIDER_RESPONSE_INVALID'); }
    if (!payload || payload.id !== mediaId || typeof payload.url !== 'string')
      throw new MediaError('MEDIA_PROVIDER_RESPONSE_INVALID');
    if (typeof payload.file_size !== 'number' || !Number.isSafeInteger(payload.file_size)
      || payload.file_size < 1 || payload.file_size > maxBytes) throw new MediaError('MEDIA_SIZE_INVALID');
    let downloadUrl: URL;
    try { downloadUrl = new URL(payload.url); } catch { throw new MediaError('MEDIA_PROVIDER_URL_DENIED'); }
    // Do not forward the credential to arbitrary webhook/CDN hosts or follow redirects.
    if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== 'lookaside.fbsbx.com'
      || downloadUrl.port || downloadUrl.username || downloadUrl.password)
      throw new MediaError('MEDIA_PROVIDER_URL_DENIED');
    const response = await checkedFetch(downloadUrl.href, credentials.accessToken);
    try {
      const bytes = await boundedResponse(response, maxBytes);
      if (bytes.length !== payload.file_size) throw new MediaError('MEDIA_SIZE_MISMATCH');
      return bytes;
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('MEDIA_PROVIDER_UNAVAILABLE', true);
    }
  },
};
