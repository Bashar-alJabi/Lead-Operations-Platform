import { boundedResponse } from '../media/meta-provider.js';
import { mediaMimeTypes, type MediaKind } from '../media/validation.js';
import { mediaCaptionAllowed } from '../media/outbound-policy.js';
import { validateMetaOutboundMedia } from '../media/meta-outbound.js';
import { MediaError } from '../media/validation.js';
import { validUrlSuffix, parseQuickReplyPayload } from './approved-template.js';
export type MessagingCredentials = { accessToken: string; appSecret: string; verifyToken: string };
export type MessagingConnectionConfig = { wabaId: string; graphVersion: string };
export type DiscoveredSender = { externalId: string; displayName: string; qualityRating: string | null };

export interface MessagingProviderAdapter {
  discoverSenders(config: MessagingConnectionConfig, credentials: MessagingCredentials): Promise<DiscoveredSender[]>;
}

export type SendTextInput = { config: MessagingConnectionConfig; credentials: MessagingCredentials;
  externalSenderId: string; recipient: string; body: string };
export type SendTemplateInput = Omit<SendTextInput, 'body'> & { templateName: string;
  templateLanguage: string; bodyParameters?: string[];headerParameter?:string;urlButton?:{ index:number;suffix:string };quickReplyButtons?:{ index:number;payload:string }[] };
export type UploadMediaInput = Omit<SendTextInput, 'body'> & { bytes: Buffer; mime: string;
  mediaKind: MediaKind; caption: string; filename: string };
export type SendMediaInput = Omit<UploadMediaInput, 'bytes'|'mime'> & { providerMediaId: string };
export interface MessagingSendAdapter {
  sendText(input: SendTextInput): Promise<{ providerMessageId: string }>;
  sendTemplate?(input: SendTemplateInput): Promise<{ providerMessageId: string }>;
  sendMedia?(input: SendMediaInput): Promise<{ providerMessageId: string }>;
  uploadMedia?(input: UploadMediaInput): Promise<{ providerMediaId: string }>;
}
export class ProviderSendError extends Error {
  constructor(public kind: 'REJECTED'|'RETRYABLE'|'UNKNOWN', public code: string,
    public retryAfterSeconds?: number) { super(code); }
}

async function sendMetaMessage(input: Omit<SendTextInput, 'body'>, content: object) {
    if (!/^\d{1,30}$/.test(input.externalSenderId) || !/^v\d{1,2}\.\d{1,2}$/.test(input.config.graphVersion)
      || !/^\+[1-9]\d{7,14}$/.test(input.recipient))
      throw new ProviderSendError('REJECTED', 'PROVIDER_SEND_INPUT_INVALID');
    const url = `https://graph.facebook.com/${input.config.graphVersion}/${input.externalSenderId}/messages`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers: {
        Authorization: `Bearer ${input.credentials.accessToken}`, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual',
        to: input.recipient.slice(1), ...content }),
      signal: AbortSignal.timeout(10000) });
    } catch { throw new ProviderSendError('UNKNOWN', 'PROVIDER_SEND_OUTCOME_UNKNOWN'); }
    if (response.status === 429) {
      const parsed = Number(response.headers.get('retry-after'));
      const retryAfter = Number.isFinite(parsed) && parsed >= 1 && parsed <= 3600 ? parsed : 30;
      throw new ProviderSendError('RETRYABLE', 'PROVIDER_RATE_LIMITED', retryAfter);
    }
    if (response.status === 401 || response.status === 403)
      throw new ProviderSendError('REJECTED', 'PROVIDER_AUTH_FAILED');
    if (response.status >= 500) throw new ProviderSendError('UNKNOWN', 'PROVIDER_SEND_OUTCOME_UNKNOWN');
    if (!response.ok) throw new ProviderSendError('REJECTED', 'PROVIDER_SEND_REJECTED');
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new ProviderSendError('UNKNOWN', 'PROVIDER_RESPONSE_AMBIGUOUS'); }
    const id = (payload as { messages?: { id?: unknown }[] } | null)?.messages?.[0]?.id;
    if (typeof id !== 'string' || !id || id.length > 255)
      throw new ProviderSendError('UNKNOWN', 'PROVIDER_RESPONSE_AMBIGUOUS');
    return { providerMessageId: id };
}

export const metaWhatsAppSendAdapter: MessagingSendAdapter = {
  async uploadMedia(input) {
    if (!/^\d{1,30}$/.test(input.externalSenderId) || !/^v\d{1,2}\.\d{1,2}$/.test(input.config.graphVersion)
      || !Object.hasOwn(mediaMimeTypes,input.mediaKind) || !input.bytes.length
      || !mediaCaptionAllowed(input.mediaKind,input.caption) || !/^[A-Za-z0-9._-]{1,100}$/.test(input.filename)
      || !(mediaMimeTypes[input.mediaKind] as readonly string[]).includes(input.mime))
      throw new ProviderSendError('REJECTED', 'PROVIDER_MEDIA_INPUT_INVALID');
    await validateMetaOutboundMedia(input.bytes,input.mediaKind,input.mime).catch((error:unknown)=> {
      throw new ProviderSendError(error instanceof MediaError && error.retryable ? 'RETRYABLE' : 'REJECTED',
        error instanceof MediaError ? error.code : 'PROVIDER_MEDIA_INPUT_INVALID');
    });
    const body = new FormData(); body.set('messaging_product', 'whatsapp'); body.set('type', input.mime);
    body.set('file', new Blob([new Uint8Array(input.bytes)], { type: input.mime }), input.filename);
    let uploaded: Response;
    try { uploaded = await fetch(`https://graph.facebook.com/${input.config.graphVersion}/${input.externalSenderId}/media`, {
      method: 'POST', headers: { Authorization: `Bearer ${input.credentials.accessToken}` }, body,
      signal: AbortSignal.timeout(30000), redirect: 'error' }); }
    catch { throw new ProviderSendError('RETRYABLE', 'PROVIDER_MEDIA_UPLOAD_UNAVAILABLE'); }
    if (uploaded.status === 429) {
      const delay = Number(uploaded.headers.get('retry-after'));
      throw new ProviderSendError('RETRYABLE', 'PROVIDER_RATE_LIMITED',
        Number.isFinite(delay) && delay >= 1 && delay <= 3600 ? delay : 30);
    }
    if (uploaded.status === 401 || uploaded.status === 403) throw new ProviderSendError('REJECTED', 'PROVIDER_AUTH_FAILED');
    if (uploaded.status >= 500) throw new ProviderSendError('RETRYABLE', 'PROVIDER_MEDIA_UPLOAD_UNAVAILABLE');
    if (!uploaded.ok) throw new ProviderSendError('REJECTED', 'PROVIDER_MEDIA_UPLOAD_REJECTED');
    let id: unknown;
    try { id = (JSON.parse((await boundedResponse(uploaded, 16384)).toString('utf8')) as { id?: unknown }).id; }
    catch { throw new ProviderSendError('RETRYABLE', 'PROVIDER_MEDIA_RESPONSE_INVALID'); }
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) throw new ProviderSendError('RETRYABLE', 'PROVIDER_MEDIA_RESPONSE_INVALID');
    return { providerMediaId: id };
  },
  async sendMedia(input) {
    if (!/^\d{1,30}$/.test(input.providerMediaId) || !Object.hasOwn(mediaMimeTypes,input.mediaKind)
      || !mediaCaptionAllowed(input.mediaKind,input.caption) || !/^[A-Za-z0-9._-]{1,100}$/.test(input.filename))
      throw new ProviderSendError('REJECTED', 'PROVIDER_MEDIA_INPUT_INVALID');
    return sendMetaMessage(input, { type: input.mediaKind, [input.mediaKind]: {
      id: input.providerMediaId, ...(input.caption ? { caption: input.caption } : {}),
      ...(input.mediaKind === 'document' ? { filename: input.filename } : {}),
    } });
  },
  async sendText(input) {
    return sendMetaMessage(input, { type: 'text', text: { preview_url: false, body: input.body } });
  },
  async sendTemplate(input) {
    const replyMessageId=parseQuickReplyPayload(input.quickReplyButtons?.[0]?.payload)?.messageId;
    if (!/^[a-z0-9_]{1,512}$/.test(input.templateName)
      || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(input.templateLanguage)
      || !Array.isArray(input.bodyParameters ?? []) || (input.bodyParameters?.length ?? 0) > 10
      || (input.bodyParameters ?? []).some((value) => typeof value !== 'string' || !value.trim()
        || value.length > 512 || /[\x00-\x1f\x7f]/.test(value))
      || (input.headerParameter!==undefined && (typeof input.headerParameter!=='string' || !input.headerParameter.trim()
        || input.headerParameter.length>60 || /[\x00-\x1f\x7f]/.test(input.headerParameter)))
      || (input.urlButton!==undefined && (!input.urlButton || !Number.isInteger(input.urlButton.index)
        || input.urlButton.index<0 || input.urlButton.index>1 || !validUrlSuffix(input.urlButton.suffix)))
      || (input.quickReplyButtons!==undefined && (input.urlButton!==undefined || !Array.isArray(input.quickReplyButtons)
        || !input.quickReplyButtons.length || input.quickReplyButtons.length>3 || input.quickReplyButtons.some((button,index)=>
          !button || button.index!==index || parseQuickReplyPayload(button.payload)?.index!==index
          || parseQuickReplyPayload(button.payload)?.messageId!==replyMessageId))))
      throw new ProviderSendError('REJECTED', 'PROVIDER_TEMPLATE_INVALID');
    const components=[...(input.headerParameter!==undefined ? [{ type:'header',parameters:[{ type:'text',text:input.headerParameter }] }] : []),
      ...(input.bodyParameters?.length ? [{ type:'body',parameters:input.bodyParameters.map((text)=>({ type:'text',text })) }] : []),
      ...(input.urlButton ? [{ type:'button',sub_type:'url',index:String(input.urlButton.index),parameters:[{ type:'text',text:input.urlButton.suffix }] }] : []),
      ...(input.quickReplyButtons?.map((button)=>({ type:'button',sub_type:'quick_reply',index:String(button.index),parameters:[{ type:'payload',payload:button.payload }] })) ?? [])];
    return sendMetaMessage(input, { type: 'template', template: {
      name: input.templateName, language: { code: input.templateLanguage },
      ...(components.length ? { components } : {}),
    } });
  },
};

type GraphPhone = { id?: unknown; display_phone_number?: unknown; verified_name?: unknown; quality_rating?: unknown };
type GraphResponse = { data?: unknown; paging?: { next?: unknown; cursors?: { after?: unknown } } };

export const metaWhatsAppAdapter: MessagingProviderAdapter = {
  async discoverSenders(config, credentials) {
    const discovered: DiscoveredSender[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${config.wabaId}/phone_numbers`);
      url.searchParams.set('fields', 'id,display_phone_number,verified_name,quality_rating');
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${credentials.accessToken}` },
        signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('PROVIDER_DISCOVERY_FAILED');
      const body = await response.json() as GraphResponse;
      if (!Array.isArray(body.data) || body.data.length > 100) throw new Error('PROVIDER_RESPONSE_INVALID');
      for (const value of body.data as GraphPhone[]) {
        if (!value || typeof value.id !== 'string' || !/^\d{1,30}$/.test(value.id)
          || typeof value.display_phone_number !== 'string' || value.display_phone_number.length > 80
          || (value.verified_name != null && typeof value.verified_name !== 'string')) throw new Error('PROVIDER_RESPONSE_INVALID');
        if (seen.has(value.id)) throw new Error('PROVIDER_RESPONSE_INVALID');
        seen.add(value.id);
        discovered.push({ externalId: value.id, displayName: String(value.verified_name || value.display_phone_number).slice(0, 200),
          qualityRating: typeof value.quality_rating === 'string' ? value.quality_rating.slice(0, 30) : null });
      }
      if (!body.paging?.next) return discovered;
      const cursor = body.paging.cursors?.after;
      if (typeof cursor !== 'string' || cursor.length > 1024 || cursor === after) throw new Error('PROVIDER_RESPONSE_INVALID');
      after = cursor;
    }
    throw new Error('PROVIDER_DISCOVERY_TOO_LARGE');
  },
};
