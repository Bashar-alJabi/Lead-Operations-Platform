import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetaSourceReference } from '../src/messaging/source-reference.js';

test('Meta referral preserves bounded untrusted captions and exact Ad/Post identity without URLs or click identity',()=> {
  assert.equal(parseMetaSourceReference({ type:'text' }),null);
  assert.deepEqual(parseMetaSourceReference({ referral:{ source_type:'ad',source_id:'900',headline:'<img src=x onerror=alert(1)>',
    body:'Unknown business claim',source_url:'http://127.0.0.1/private',ctwa_clid:'not-a-person',media_type:'image',image_url:'http://invalid.test' } }),
  { namespace:'META_AD',externalId:'900',headline:'<img src=x onerror=alert(1)>',description:'Unknown business claim' });
  assert.deepEqual(parseMetaSourceReference({ referral:{ source_type:'post',source_id:'901' } }),
    { namespace:'META_POST',externalId:'901',headline:null,description:null });
});
test('Meta referral malformed identities, structures and oversized/control captions never become campaign guesses',()=> {
  for (const referral of [null,[],{},'ad',{ source_type:['ad'],source_id:'900' },{ source_type:'ad',source_id:900 },
    { source_type:'campaign',source_id:'900' },{ source_type:'ad',source_id:'900/lead' },{ source_type:'ad',source_id:'0' },
    { source_type:'ad',source_id:'1'.repeat(31) },{ source_type:'ad',source_id:'900',headline:{ html:'unsafe' } },
    { source_type:'ad',source_id:'900',body:'x'.repeat(2001) },{ source_type:'ad',source_id:'900',body:'a\u0000b' }])
    assert.throws(()=>parseMetaSourceReference({ referral }),/INBOUND_SOURCE_REFERENCE_INVALID/);
});
