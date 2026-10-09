import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQualificationAnswer } from '../src/ai/qualification-answers.js';

test('Actual qualification answer validation uses typed Fields and preserves false/zero while bounding unmapped text', () => {
  assert.equal(normalizeQualificationAnswer(false, { field_type: 'BOOLEAN', options: [], validation: {} }), false);
  assert.equal(normalizeQualificationAnswer(0, { field_type: 'NUMBER', options: [], validation: {} }), 0);
  assert.equal(normalizeQualificationAnswer('  Collected <img literal>  '), 'Collected <img literal>');
  assert.equal(normalizeQualificationAnswer('  '), null); assert.equal(normalizeQualificationAnswer(null), null);
  for (const value of [false, 2, {}, [], 'x'.repeat(4001), 'bad\u0000', '\ud800']) assert.throws(() => normalizeQualificationAnswer(value));
  assert.throws(() => normalizeQualificationAnswer('unapproved', { field_type: 'SINGLE_SELECT', options: [{ value: 'A', label: 'A', active: true }], validation: {} }));
  for (const value of ['\ud800', 'bad\u0000']) assert.throws(() => normalizeQualificationAnswer(value, { field_type: 'LONG_TEXT', options: [], validation: {} }));
  assert.throws(() => normalizeQualificationAnswer(['\ud800'], { field_type: 'TAGS', options: [], validation: {} }));
});
