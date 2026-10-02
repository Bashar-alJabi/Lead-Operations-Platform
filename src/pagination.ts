import { HttpError } from './security.js';

export type Cursor = { timestamp: string; id: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.timestamp, cursor.id])).toString('base64url');
}

export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  if (value.length > 256) throw new HttpError(400, 'INVALID_CURSOR');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string'
      || !Number.isFinite(Date.parse(parsed[0])) || !uuid.test(parsed[1])) throw new Error('bad cursor');
    return { timestamp: parsed[0], id: parsed[1] };
  } catch { throw new HttpError(400, 'INVALID_CURSOR'); }
}
