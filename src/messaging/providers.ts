export type MessagingCredentials = { accessToken: string; appSecret: string; verifyToken: string };
export type MessagingConnectionConfig = { wabaId: string; graphVersion: string };
export type DiscoveredSender = { externalId: string; displayName: string; qualityRating: string | null };

export interface MessagingProviderAdapter {
  discoverSenders(config: MessagingConnectionConfig, credentials: MessagingCredentials): Promise<DiscoveredSender[]>;
}

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
