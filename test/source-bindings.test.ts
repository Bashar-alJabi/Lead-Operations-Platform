import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceContextsOverlap,resolveSourceContext,type BindingContext } from '../src/sources/bindings.js';
const context:BindingContext={ connectionId:'c',formId:'f',externalCampaignId:null,externalAdSetId:null,externalAdId:null };
test('source selector intersections block wildcard overlap across campaign/ad dimensions without ranking',()=> {
  assert.equal(sourceContextsOverlap(context,{ ...context,externalCampaignId:'1',externalAdId:'2' }),true);
  assert.equal(sourceContextsOverlap({ ...context,externalCampaignId:'1' },{ ...context,externalCampaignId:'2' }),false);
  assert.equal(sourceContextsOverlap({ ...context,externalAdSetId:'1' },{ ...context,externalAdSetId:'2' }),false);
  assert.equal(sourceContextsOverlap({ ...context,externalAdId:'1' },{ ...context,externalAdId:'2' }),false);
  assert.equal(sourceContextsOverlap(context,{ ...context,connectionId:'other' }),false);
  assert.equal(sourceContextsOverlap(context,{ ...context,formId:'other' }),false);
  assert.equal(sourceContextsOverlap({ ...context,externalCampaignId:'1' },{ ...context,externalAdId:'2' }),true);
});
test('source resolution requires every trusted selector and preserves unmatched or ambiguous inputs',()=> {
  const a={ ...context,externalCampaignId:'1',externalAdId:'11' };const b={ ...context,externalCampaignId:'2' };
  assert.deepEqual(resolveSourceContext([a,b],{ ...a }),{ state:'RESOLVED',binding:a });
  assert.deepEqual(resolveSourceContext([a,b],{ ...context,externalCampaignId:'1' }),{ state:'UNMATCHED' });
  assert.deepEqual(resolveSourceContext([a,b],context),{ state:'UNMATCHED' });
  assert.deepEqual(resolveSourceContext([context,a],a),{ state:'AMBIGUOUS' });
  assert.deepEqual(resolveSourceContext([a,b],{ ...a,connectionId:'other' }),{ state:'UNMATCHED' });
});
