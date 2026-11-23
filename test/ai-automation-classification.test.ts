import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classificationResult } from '../src/ai/automation-classification.js';

test('Classification accepts only an approved option with distinct supplied evidence or an abstention', () => {
  const options=[{ id:'tag:1',text:'Enrollment inquiry' }];
  const references=[{ id:'message:1',text:'Can I enroll?' }];
  const accepted={ optionId:'tag:1',referenceIds:['message:1'] };
  assert.deepEqual(classificationResult(accepted,options,references),accepted);
  assert.deepEqual(classificationResult({ optionId:null,referenceIds:[] },options,references),{ optionId:null,referenceIds:[] });
  for(const invalid of [
    { ...accepted, optionId:'tag:2' },{ ...accepted, referenceIds:[] },{ ...accepted, referenceIds:['message:2'] },
    { ...accepted, referenceIds:['message:1','message:1'] },{ ...accepted, optionId:null },{ ...accepted, mutateLead:true },
  ]) assert.throws(()=>classificationResult(invalid,options,references));
});
