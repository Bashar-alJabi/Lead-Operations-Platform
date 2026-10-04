import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metaLeadSourceRetrievalAdapter,validateRetrievedLead } from '../src/sources/meta-lead.js';
import { sourceRetryDelay,sourceWorkerOptions } from '../src/sources/retrieval-worker.js';
const input={ config:{ graphVersion:'v25.0' },page:{ externalId:'11',accessToken:'synthetic-page-token' },leadId:'900',formId:'101' };
const lead={ id:'900',form_id:'101',created_time:'2023-11-14T22:13:19+0000',ad_id:'31',adset_id:'32',campaign_id:'33',field_data:[
  { name:'full_name',values:['<img onerror=alert(1)>'] },{ name:'choices',values:['a','b'] },{ name:'choices',values:[] }],custom_disclaimer_responses:[{ text:'preserved' }] };
test('source lead retrieval preserves field arrays, duplicates, metadata and timestamps without guessing missing identity or context',()=> {
  const valid=validateRetrievedLead(lead,input);assert.equal(valid.raw,lead);assert.equal(valid.createdAt,'2023-11-14T22:13:19.000Z');
  assert.deepEqual(valid.values,[{ key:'full_name',values:['<img onerror=alert(1)>'] },{ key:'choices',values:['a','b'] },{ key:'choices',values:[] }]);
  assert.equal(validateRetrievedLead({ id:'900',form_id:'101',created_time:lead.created_time,field_data:[] },input).values.length,0);
  for (const invalid of [null,{}, { ...lead,id:900 },{ ...lead,form_id:'102' },{ ...lead,created_time:'2023-02-30T12:00:00Z' },
    { ...lead,adset_id:32 },{ ...lead,field_data:[{ name:'bad',values:[10] }] },{ ...lead,field_data:Array(101).fill({ name:'a',values:[] }) },
    { ...lead,field_data:[{ name:'a',values:['x'.repeat(20001)] }] }]) assert.throws(()=>validateRetrievedLead(invalid,input),/SOURCE_RESPONSE_INVALID/);
});
test('Meta lead retrieval confines IDs, requested fields, Page bearer token, body size, timeout, redirect and safe provider failures',async(t)=> {
  let mode='ok';let calls=0;
  t.mock.method(globalThis,'fetch',async(path:string|URL,init?:RequestInit)=> {
    calls++;const url=new URL(String(path));assert.equal(url.origin,'https://graph.facebook.com');assert.equal(url.pathname,'/v25.0/900');assert.equal(url.searchParams.has('access_token'),false);
    assert.ok(url.searchParams.get('fields')?.includes('adset_id'));assert.ok(url.searchParams.get('fields')?.includes('field_data'));assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-page-token');
    assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    if (mode==='redirect') throw new Error('secret');if (mode==='oversize') return new Response('secret',{ headers:{ 'content-length':String(512*1024+1) } });
    if (mode==='malformed') return Response.json({ ...lead,id:'901' });if (mode==='json') return new Response('not json');
    if (mode!=='ok') return new Response('secret provider body',{ status:Number(mode) });return Response.json(lead);
  });
  assert.deepEqual(await metaLeadSourceRetrievalAdapter.retrieve(input),lead);
  for (const [value,code] of [['redirect','UNAVAILABLE'],['oversize','RESPONSE_INVALID'],['malformed','RESPONSE_INVALID'],['json','RESPONSE_INVALID'],['401','AUTH_FAILED'],['403','AUTH_FAILED'],['429','RATE_LIMITED'],['500','UNAVAILABLE'],['400','REJECTED']]) {
    mode=value!;await assert.rejects(metaLeadSourceRetrievalAdapter.retrieve(input),new RegExp(code!));
  }
  const before=calls;await assert.rejects(metaLeadSourceRetrievalAdapter.retrieve({ ...input,leadId:'900/../me' }),/INPUT_INVALID/);assert.equal(calls,before);
});
test('source worker capacity assumptions and bounded backoff remain configurable and validated',()=> {
  assert.deepEqual(sourceWorkerOptions({}),{ batchSize:20,pollMs:2000,maxFailures:5,leaseSeconds:30 });
  assert.equal(sourceWorkerOptions({ SOURCE_RETRIEVAL_MAX_FAILURES:'2' }).maxFailures,2);
  assert.throws(()=>sourceWorkerOptions({ SOURCE_RETRIEVAL_BATCH_SIZE:'0' }));assert.throws(()=>sourceWorkerOptions({ SOURCE_RETRIEVAL_LEASE_SECONDS:'5' }));
  assert.equal(sourceRetryDelay(1),30);assert.equal(sourceRetryDelay(2),60);assert.equal(sourceRetryDelay(100),1800);
});
