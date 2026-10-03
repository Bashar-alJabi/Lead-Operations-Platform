import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFieldConfiguration, validateFieldValue } from '../src/fields.js';

const options = [{ value: 'new', label: 'New', active: true }, { value: 'old', label: 'Old', active: false }];

test('field definitions enforce calculation and option constraints', () => {
  validateFieldConfiguration('SINGLE_SELECT', 'MANUAL', options, {}, null);
  validateFieldConfiguration('CALCULATED', 'CALCULATED', [], {}, { kind: 'LEAD_AGE_DAYS' });
  assert.throws(() => validateFieldConfiguration('CALCULATED', 'MANUAL', [], {}, { kind: 'LEAD_AGE_DAYS' }), { code: 'FIELD_CALCULATION_INVALID' });
  assert.throws(() => validateFieldConfiguration('SINGLE_SELECT', 'MANUAL', [], {}, null), { code: 'FIELD_OPTIONS_REQUIRED' });
  assert.throws(() => validateFieldConfiguration('TEXT', 'MANUAL', options, {}, null), { code: 'FIELD_OPTIONS_NOT_ALLOWED' });
  assert.throws(() => validateFieldConfiguration('CURRENCY', 'MANUAL', [], {}, null), { code: 'FIELD_CURRENCY_REQUIRED' });
});

test('field values are typed and reject inactive options, unsafe URLs, and invalid dates', () => {
  assert.equal(validateFieldValue('SINGLE_SELECT', 'new', options, {}), 'new');
  assert.throws(() => validateFieldValue('SINGLE_SELECT', 'old', options, {}), { code: 'FIELD_VALUE_INVALID' });
  assert.equal(validateFieldValue('PHONE', '+1 (555) 000-0001', [], {}), '+15550000001');
  assert.equal(validateFieldValue('EMAIL', ' A@Example.TEST ', [], {}), 'a@example.test');
  assert.throws(() => validateFieldValue('URL', 'javascript:alert(1)', [], {}), { code: 'FIELD_VALUE_INVALID' });
  assert.throws(() => validateFieldValue('DATE', '2026-02-30', [], {}), { code: 'FIELD_VALUE_INVALID' });
  assert.throws(() => validateFieldValue('BOOLEAN', 'true', [], {}), { code: 'FIELD_VALUE_INVALID' });
  assert.deepEqual(validateFieldValue('MULTI_SELECT', ['new'], options, {}), ['new']);
  assert.deepEqual(validateFieldValue('CURRENCY', { amount: 12.34, currency: 'USD' }, [], { currency: 'USD' }), { amount: 12.34, currency: 'USD' });
  assert.throws(() => validateFieldValue('CURRENCY', { amount: 1e40, currency: 'USD' }, [], { currency: 'USD' }), { code: 'FIELD_VALUE_INVALID' });
});
