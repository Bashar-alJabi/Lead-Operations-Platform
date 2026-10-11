import { HttpError } from './security.js';
export const weekdays = ['mon','tue','wed','thu','fri','sat','sun'] as const;
export type WeeklyHours = Partial<Record<typeof weekdays[number], [string,string][]>>;
export function normalizeWeeklyHours(raw: unknown): WeeklyHours {
  const invalid = () => { throw new HttpError(400, 'INVALID_WORKING_HOURS'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const entries = Object.entries(raw); if (entries.some(([k]) => !(weekdays as readonly string[]).includes(k))) return invalid();
  if (!entries.length) return {};
  const result: WeeklyHours = {};
  const minutes = (s: unknown, end: boolean) => {
    if (typeof s !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s) && !(end && s === '24:00')) return NaN;
    return Number(s.slice(0,2)) * 60 + Number(s.slice(3));
  };
  for (const day of weekdays) {
    const ranges = Object.hasOwn(raw,day) ? (raw as Record<string,unknown>)[day] : []; if (!Array.isArray(ranges) || ranges.length > 8) return invalid();
    let previousEnd = -1;
    result[day] = ranges.map(r => {
      if (!Array.isArray(r) || r.length !== 2) return invalid();
      const start = minutes(r[0],false), end = minutes(r[1],true);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < previousEnd) return invalid();
      previousEnd = end; return [r[0] as string,r[1] as string];
    });
  }
  return result;
}
export const weeklyHoursSchema = { type:'object',additionalProperties:false,properties:Object.fromEntries(weekdays.map(day => [day,
  { type:'array',maxItems:8,items:{ type:'array',minItems:2,maxItems:2,items:{ type:'string',maxLength:5 } } }])) } as const;
