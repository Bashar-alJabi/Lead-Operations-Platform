import { HttpError } from '../security.js';

export type SourceReference = { namespace: 'META_AD'|'META_POST'; externalId: string;
  headline: string|null; description: string|null };

// Provider metadata is evidence, never instructions or a URL to fetch.
export function parseMetaSourceReference(message: Record<string, unknown>): SourceReference|null {
  if (!Object.hasOwn(message, 'referral')) return null;
  const value = message.referral;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'INBOUND_SOURCE_REFERENCE_INVALID');
  const referral = value as Record<string, unknown>;
  if (typeof referral.source_type !== 'string' || !['ad','post'].includes(referral.source_type) || typeof referral.source_id !== 'string'
    || !/^[1-9]\d{0,29}$/.test(referral.source_id))
    throw new HttpError(400, 'INBOUND_SOURCE_REFERENCE_INVALID');
  function caption(key: string): string|null {
    const text = referral[key];
    if (text == null) return null;
    if (typeof text !== 'string' || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
      throw new HttpError(400, 'INBOUND_SOURCE_REFERENCE_INVALID');
    return text;
  }
  return { namespace: referral.source_type === 'ad' ? 'META_AD' : 'META_POST', externalId: referral.source_id,
    headline: caption('headline'), description: caption('body') };
}
