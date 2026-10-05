import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceSubmissionData } from '../src/sources/evaluation.js';
const raw=()=>({ context:{ pageId:'10',formId:'20',leadId:'30' },lead:{ id:'30',form_id:'20',created_time:'2023-11-14T22:13:19Z',
  field_data:[{ name:'choice',values:['a','b'] }],campaign_id:'40' },notification:{ change:{ value:{ adgroup_id:'77',ad_id:'60' } } } });
test('Source runtime resolves declared identifiers and retains missing identities/multiple values without guessing legacy Ad Set',()=> {
  const input=raw();const data=sourceSubmissionData('connection','30',input);
  assert.deepEqual(data.context,{ connectionId:'connection',formId:'20',externalCampaignId:'40',externalAdSetId:null,externalAdId:'60' });
  assert.deepEqual(data.values,[{ key:'choice',values:['a','b'] }]);assert.equal(input.notification.change.value.adgroup_id,'77');
});
test('Source runtime rejects conflicting or malformed context before campaign resolution',()=> {
  for (const value of [null,[],false]) assert.throws(()=>sourceSubmissionData('connection','30',value as unknown as Record<string,any>),/SOURCE_RESPONSE_INVALID/);
  const conflict=raw();Object.assign(conflict.notification.change.value,{ campaign_id:'41' });assert.throws(()=>sourceSubmissionData('connection','30',conflict),/SOURCE_CONTEXT_CONFLICT/);
  for (const change of [{ context:{ pageId:10,formId:'20',leadId:'30' } },{ context:{ pageId:'10',formId:'20',leadId:'31' } },{ lead:{ ...raw().lead,id:'31' } }])
    assert.throws(()=>sourceSubmissionData('connection','30',{ ...raw(),...change }),/SOURCE_RESPONSE_INVALID/);
});
