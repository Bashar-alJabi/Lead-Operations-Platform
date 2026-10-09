import type postgres from 'postgres';
import { validateFieldValue, type FieldOption, type FieldType, type FieldValidation } from '../fields.js';
import { HttpError } from '../security.js';

export type QualificationAnswerInput = {
  requestId: string; definitionVersion: number; answerVersion: number;
  fieldValueVersion: number | null; value: postgres.JSONValue;
};

export function normalizeQualificationAnswer(value: unknown, field?: {
  field_type: string; options: FieldOption[]; validation: FieldValidation;
}): postgres.JSONValue {
  const strings = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  if (strings.some(item => item.includes('\u0000') || Buffer.from(item).toString() !== item)) throw new HttpError(400, 'QUALIFICATION_ANSWER_INVALID');
  if (field) return validateFieldValue(field.field_type as FieldType, value, field.options, field.validation) as postgres.JSONValue;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 4000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || Buffer.from(value).toString() !== value) {
    throw new HttpError(400, 'QUALIFICATION_ANSWER_INVALID');
  }
  return value.trim() || null;
}

export const qualificationAnswerSchema = {
  type: 'object', additionalProperties: false,
  required: ['requestId', 'definitionVersion', 'answerVersion', 'fieldValueVersion', 'value'],
  properties: {
    requestId: { type: 'string', format: 'uuid' }, definitionVersion: { type: 'integer', minimum: 1 },
    answerVersion: { type: 'integer', minimum: 0 },
    fieldValueVersion: { type: ['integer', 'null'], minimum: 0 }, value: {},
  },
} as const;
