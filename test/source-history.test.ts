import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historicalRange,historicalOptions } from '../src/sources/historical.js';
import { metaLeadSourceHistoryAdapter,validateHistoricalPage } from '../src/sources/meta-history.js';
const lead={ id:'123',form_id:'22',created_time:'2023-11-14T22:13:19+0000',field_data:[] };
test('historical range is explicit UTC, half-open, calendar-valid and bounded technical capacity is configurable',()=> {
  assert.deepEqual(historicalRange('2023-11-14T00:00:00Z','2023-11-15T00:00:00Z'),{ from:'2023-11-14T00:00:00.000Z',until:'2023-11-15T00:00:00.000Z' });
  for (const bad of ['2023-02-30T00:00:00Z','2023-11-14T24:00:00Z','2023-11-14','2023-11-14T00:00:00+00:00','1999-11-14T00:00:00Z'])
    assert.throws(()=>historicalRange(bad,'2023-11-15T00:00:00Z'),/RANGE_INVALID/);
  assert.throws(()=>historicalRange('2023-11-14T00:00:00Z','2023-11-14T00:00:00Z'),/RANGE_INVALID/);
  assert.equal(historicalOptions({}).maxPages,10000);assert.equal(historicalOptions({ SOURCE_HISTORICAL_MAX_PAGES:'1' }).maxPages,1);
  assert.throws(()=>historicalOptions({ SOURCE_HISTORICAL_MAX_PAGES:'0' }));
});
test('historical page validates every record and bounded cursor without trusting provider next URLs',()=> {
  assert.equal(validateHistoricalPage({ data:[lead],paging:{ next:'https://untrusted.invalid/private',cursors:{ after:'opaque' } } },'22').after,'opaque');
  assert.equal(validateHistoricalPage({ data:[] },'22').after,null);
  for (const bad of [null,{}, { data:Array(101).fill(lead) },{ data:[{ ...lead,form_id:'23' }] },{ data:[{ ...lead,id:123 }] },
    { data:[],paging:{ next:'url' } },{ data:[],paging:{ next:'url',cursors:{ after:'bad\nsecret' } } },{ data:[lead],extra:'x'.repeat(512*1024) }])
    assert.throws(()=>validateHistoricalPage(bad,'22'),/RESPONSE_INVALID/);
});
test('Meta historical adapter uses fixed Form leads endpoint, Page bearer, bounds and safe failure codes',async(t)=> {
  let calls=0;let mode='ok';
  t.mock.method(globalThis,'fetch',async(path:string|URL,init?:RequestInit)=> {
    calls++;const url=new URL(String(path));assert.equal(url.origin,'https://graph.facebook.com');assert.equal(url.pathname,'/v25.0/22/leads');
    assert.equal(url.searchParams.get('limit'),'100');assert.equal(url.searchParams.get('after'),'opaque');assert.equal(url.searchParams.has('access_token'),false);
    assert.ok(url.searchParams.get('fields')?.includes('campaign_id'));assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-page-token');
    assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    if (mode==='network') throw new Error('private provider detail');if (mode==='large') return new Response('private',{ headers:{ 'content-length':String(512*1024+1) } });
    if (mode==='json') return new Response('private');if (mode!=='ok') return new Response('private',{ status:Number(mode) });
    return Response.json({ data:[lead] });
  });
  const input={ config:{ graphVersion:'v25.0' },page:{ externalId:'11',accessToken:'synthetic-page-token' },formId:'22',after:'opaque' };
  await metaLeadSourceHistoryAdapter.page(input);
  for (const [value,code] of [['network','UNAVAILABLE'],['large','RESPONSE_INVALID'],['json','RESPONSE_INVALID'],['401','AUTH_FAILED'],['403','AUTH_FAILED'],['429','RATE_LIMITED'],['500','UNAVAILABLE'],['400','REJECTED']]) {
    mode=value!;await assert.rejects(metaLeadSourceHistoryAdapter.page(input),new RegExp(code!));
  }
  const before=calls;await assert.rejects(metaLeadSourceHistoryAdapter.page({ ...input,formId:'22/../me' }),/INPUT_INVALID/);assert.equal(calls,before);
});
