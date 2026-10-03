import { HttpError } from './security.js';

export const fieldTypes = ['TEXT','LONG_TEXT','NUMBER','PHONE','EMAIL','DATE','TIME','DATETIME','SINGLE_SELECT',
  'MULTI_SELECT','BOOLEAN','STATUS','INTEREST','TAGS','CURRENCY','PERCENTAGE','DURATION','URL','CALCULATED'] as const;
export type FieldType = typeof fieldTypes[number];
export type FieldOption = { value: string; label: string; active: boolean };
export type FieldValidation = { minLength?: number; maxLength?: number; min?: number; max?: number; currency?: string };
export const calculationKinds = ['LEAD_AGE_DAYS','FIRST_PLATFORM_CONTACT_AT','FIRST_AI_CONTACT_AT','FIRST_HUMAN_CONTACT_AT',
  'TIME_SINCE_LAST_CONTACT_SECONDS','AI_CONTACT_ATTEMPTS','HUMAN_CONTACT_ATTEMPTS','HUMAN_RESPONSE_SECONDS'] as const;
export type CalculationKind = typeof calculationKinds[number];

const selectTypes: readonly FieldType[] = ['SINGLE_SELECT','MULTI_SELECT','STATUS','INTEREST'];

export function validateFieldConfiguration(fieldType: FieldType, valueMode: string, options: FieldOption[],
  validation: FieldValidation, calculation: { kind: CalculationKind } | null): void {
  if (fieldType === 'CALCULATED') {
    if (valueMode !== 'CALCULATED' || !calculation || !calculationKinds.includes(calculation.kind)) throw new HttpError(400, 'FIELD_CALCULATION_INVALID');
  } else if (valueMode === 'CALCULATED' || calculation !== null) throw new HttpError(400, 'FIELD_CALCULATION_INVALID');
  if (selectTypes.includes(fieldType) && options.filter((option) => option.active).length === 0) throw new HttpError(400, 'FIELD_OPTIONS_REQUIRED');
  if (!selectTypes.includes(fieldType) && fieldType !== 'TAGS' && options.length > 0) throw new HttpError(400, 'FIELD_OPTIONS_NOT_ALLOWED');
  const values = new Set<string>();
  for (const option of options) {
    if (!option.value || option.value.length > 100 || !option.label.trim() || option.label.length > 200 || values.has(option.value)) {
      throw new HttpError(400, 'FIELD_OPTION_INVALID');
    }
    values.add(option.value);
  }
  if (validation.minLength !== undefined && (!Number.isInteger(validation.minLength) || validation.minLength < 0)) throw new HttpError(400, 'FIELD_VALIDATION_INVALID');
  if (validation.maxLength !== undefined && (!Number.isInteger(validation.maxLength) || validation.maxLength < 1 || validation.maxLength > 20000)) throw new HttpError(400, 'FIELD_VALIDATION_INVALID');
  if (validation.minLength !== undefined && validation.maxLength !== undefined && validation.minLength > validation.maxLength) throw new HttpError(400, 'FIELD_VALIDATION_INVALID');
  if (validation.min !== undefined && (!Number.isFinite(validation.min))) throw new HttpError(400, 'FIELD_VALIDATION_INVALID');
  if (validation.max !== undefined && (!Number.isFinite(validation.max))) throw new HttpError(400, 'FIELD_VALIDATION_INVALID');
  if (validation.min !== undefined && validation.max !== undefined && validation.min > validation.max) throw new HttpError(400, 'FIELD_VALIDATION_INVALID');
  if (validation.currency !== undefined && !/^[A-Z]{3}$/.test(validation.currency)) throw new HttpError(400, 'FIELD_CURRENCY_INVALID');
  if (fieldType === 'CURRENCY' && !validation.currency) throw new HttpError(400, 'FIELD_CURRENCY_REQUIRED');
  if (fieldType !== 'CURRENCY' && validation.currency) throw new HttpError(400, 'FIELD_CURRENCY_INVALID');
}

export function validateFieldValue(fieldType: FieldType, input: unknown, options: FieldOption[], validation: FieldValidation): unknown {
  if (input === null) return null;
  const invalid = () => { throw new HttpError(400, 'FIELD_VALUE_INVALID'); };
  const allowed = new Set(options.filter((option) => option.active).map((option) => option.value));
  if (['TEXT','LONG_TEXT','PHONE','EMAIL','DATE','TIME','DATETIME','SINGLE_SELECT','STATUS','INTEREST','URL'].includes(fieldType)) {
    if (typeof input !== 'string') return invalid();
    const value = input.trim();
    if (value.length === 0) return invalid();
    const max = fieldType === 'LONG_TEXT' ? 20000 : fieldType === 'URL' ? 2048 : 500;
    if (value.length > max || value.length < (validation.minLength ?? 0) || value.length > (validation.maxLength ?? max)) return invalid();
    if (['SINGLE_SELECT','STATUS','INTEREST'].includes(fieldType) && !allowed.has(value)) return invalid();
    if (fieldType === 'PHONE') {
      const phone = value.replace(/[\s().-]/g, '');
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) return invalid();
      return phone;
    }
    if (fieldType === 'EMAIL') {
      const email = value.normalize('NFKC').toLowerCase();
      if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid();
      return email;
    }
    if (fieldType === 'DATE' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) return invalid();
    if (fieldType === 'TIME' && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) return invalid();
    if (fieldType === 'DATETIME') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) return invalid();
      return new Date(value).toISOString();
    }
    if (fieldType === 'URL') {
      try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol)) return invalid(); }
      catch { return invalid(); }
    }
    return value;
  }
  if (['NUMBER','PERCENTAGE','DURATION'].includes(fieldType)) {
    if (typeof input !== 'number' || !Number.isFinite(input) || !Number.isSafeInteger(input) && Math.abs(input) > Number.MAX_SAFE_INTEGER) return invalid();
    if (input < (validation.min ?? (fieldType === 'DURATION' ? 0 : -Infinity)) || input > (validation.max ?? Infinity)) return invalid();
    return input;
  }
  if (fieldType === 'CURRENCY') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'amount,currency' || typeof value.amount !== 'number' || !Number.isFinite(value.amount)
      || Math.abs(value.amount) > 1_000_000_000_000 || !/^-?\d+(\.\d{1,6})?$/.test(String(value.amount))
      || value.currency !== validation.currency || value.amount < (validation.min ?? -Infinity) || value.amount > (validation.max ?? Infinity)) return invalid();
    return { amount: value.amount, currency: value.currency };
  }
  if (fieldType === 'BOOLEAN') return typeof input === 'boolean' ? input : invalid();
  if (fieldType === 'MULTI_SELECT' || fieldType === 'TAGS') {
    if (!Array.isArray(input) || input.length > 50 || input.some((item) => typeof item !== 'string' || !item || item.length > 100)) return invalid();
    if (new Set(input).size !== input.length || input.some((item) => fieldType === 'MULTI_SELECT' && !allowed.has(item))) return invalid();
    return input;
  }
  return invalid();
}
