import { HttpError } from './security.js';

export type ContactInput = { name: string; phone?: string; email?: string };
export type NormalizedContact = { name: string; phone: string | null; phoneNormalized: string | null; email: string | null; emailNormalized: string | null };

export function normalizeContact(input: ContactInput): NormalizedContact {
  const name = input.name.trim();
  if (!name) throw new HttpError(400, 'CONTACT_NAME_REQUIRED');
  const phone = input.phone?.trim() || null;
  const email = input.email?.trim() || null;
  const phoneNormalized = phone?.replace(/[\s().-]/g, '') ?? null;
  if (phoneNormalized && !/^\+[1-9]\d{7,14}$/.test(phoneNormalized)) throw new HttpError(400, 'PHONE_E164_REQUIRED');
  const emailNormalized = email?.normalize('NFKC').toLowerCase() ?? null;
  if (emailNormalized && (emailNormalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized))) {
    throw new HttpError(400, 'EMAIL_INVALID');
  }
  if (!phoneNormalized && !emailNormalized) throw new HttpError(400, 'CONTACT_IDENTIFIER_REQUIRED');
  return { name, phone, phoneNormalized, email, emailNormalized };
}

export function identityLockKeys(organizationId: string, contact: NormalizedContact): string[] {
  return [contact.phoneNormalized && `phone:${contact.phoneNormalized}`, contact.emailNormalized && `email:${contact.emailNormalized}`]
    .filter((value): value is string => Boolean(value)).map((value) => `${organizationId}:${value}`).sort();
}

// Source campaigns have no fixed mandatory Contact fields. Published mapping validates provided values.
export function normalizeSourceContact(input: Partial<Record<'name'|'phone'|'email',string>>): NormalizedContact|null {
  const name=input.name?.trim() ?? '';const phone=input.phone?.trim() || null;const email=input.email?.trim() || null;
  if (!name && !phone && !email) return null;
  const phoneNormalized=phone?.replace(/[\s().-]/g,'') ?? null;
  const emailNormalized=email?.normalize('NFKC').toLowerCase() ?? null;
  if (phoneNormalized && !/^\+[1-9]\d{7,14}$/.test(phoneNormalized)) throw new HttpError(400,'PHONE_E164_REQUIRED');
  if (emailNormalized && (emailNormalized.length>320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized))) throw new HttpError(400,'EMAIL_INVALID');
  return { name,phone,phoneNormalized,email,emailNormalized };
}
