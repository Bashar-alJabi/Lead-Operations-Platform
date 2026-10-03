export type MessagingCredentials = { accessToken: string; appSecret: string; verifyToken: string };
export type MessagingConnectionConfig = { wabaId: string; graphVersion: string };
export type DiscoveredSender = { externalId: string; displayName: string; qualityRating: string | null };

export interface MessagingProviderAdapter {
  discoverSenders(config: MessagingConnectionConfig, credentials: MessagingCredentials): Promise<DiscoveredSender[]>;
}

export type SendTextInput = { config: MessagingConnectionConfig; credentials: MessagingCredentials;
  externalSenderId: string; recipient: string; body: string };
export interface MessagingSendAdapter {
  sendText(input: SendTextInput): Promise<{ providerMessageId: string }>;
}
export class ProviderSendError extends Error {
  constructor(public kind: 'REJECTED'|'RETRYABLE'|'UNKNOWN', public code: string,
    public retryAfterSeconds?: number) { super(code); }
}

export const metaWhatsAppSendAdapter: MessagingSendAdapter = {
  async sendText(input) {
    if (!/^\d{1,30}$/.test(input.externalSenderId) || !/^v\d{1,2}\.\d{1,2}$/.test(input.config.graphVersion)
      || !/^\+[1-9]\d{7,14}$/.test(input.recipient))
      throw new ProviderSendError('REJECTED', 'PROVIDER_SEND_INPUT_INVALID');
    const url = `https://graph.facebook.com/${input.config.graphVersion}/${input.externalSenderId}/messages`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers: {
        Authorization: `Bearer ${input.credentials.accessToken}`, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual',
        to: input.recipient.slice(1), type: 'text', text: { preview_url: false, body: input.body } }),
      signal: AbortSignal.timeout(10000) });
    } catch { throw new ProviderSendError('UNKNOWN', 'PROVIDER_SEND_OUTCOME_UNKNOWN'); }
    if (response.status === 429) {
      const parsed = Number(response.headers.get('retry-after'));
      const retryAfter = Number.isFinite(parsed) && parsed >= 1 && parsed <= 3600 ? parsed : 30;
      throw new ProviderSendError('RETRYABLE', 'PROVIDER_RATE_LIMITED', retryAfter);
    }
    if (response.status >= 500) throw new ProviderSendError('UNKNOWN', 'PROVIDER_SEND_OUTCOME_UNKNOWN');
    if (!response.ok) throw new ProviderSendError('REJECTED', 'PROVIDER_SEND_REJECTED');
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new ProviderSendError('UNKNOWN', 'PROVIDER_RESPONSE_AMBIGUOUS'); }
    const id = (payload as { messages?: { id?: unknown }[] } | null)?.messages?.[0]?.id;
    if (typeof id !== 'string' || !id || id.length > 255)
      throw new ProviderSendError('UNKNOWN', 'PROVIDER_RESPONSE_AMBIGUOUS');
    return { providerMessageId: id };
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
