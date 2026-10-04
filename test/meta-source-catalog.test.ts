import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metaLeadSourceCatalogAdapter,SourceProviderError,validateSourceForms,validateSourcePages } from '../src/sources/meta-provider.js';
const config={ graphVersion:'v25.0' };const credentials={ accessToken:'synthetic-root-token-not-live',appSecret:'synthetic-secret',verifyToken:'synthetic-verify' };
test('Meta source catalog confines Graph pagination and separates page credentials from safe form metadata',async(t)=> {
  const calls:{ url:URL;init:RequestInit|undefined }[]=[];
  t.mock.method(globalThis,'fetch',async(input:string|URL,init?:RequestInit)=> {
    const url=new URL(String(input));calls.push({ url,init });assert.equal(url.origin,'https://graph.facebook.com');assert.equal(url.searchParams.has('access_token'),false);
    assert.equal(init?.redirect,'error');assert.ok(init?.signal);const headers=new Headers(init?.headers);
    if (url.pathname.endsWith('/me/accounts')) {
      assert.equal(headers.get('authorization'),'Bearer '+credentials.accessToken);
      return Response.json({ data:[{ id:url.searchParams.has('after') ? '2' : '1',name:'Page <b>literal</b>',access_token:'synthetic-page-token' }],
        ...(!url.searchParams.has('after') ? { paging:{ next:'https://untrusted.test/?access_token=secret',cursors:{ after:'opaque+cursor' } } } : {}) });
    }
    assert.equal(url.pathname,'/v25.0/1/leadgen_forms');assert.equal(headers.get('authorization'),'Bearer synthetic-page-token');
    return Response.json({ data:[{ id:'101',name:'Form',status:'ACTIVE',untrusted_secret:'not-catalogued',questions:[
      { id:'q1',key:'interest',type:'CUSTOM',label:'<img src=x onerror=alert(1)>',options:[{ key:'yes',value:'Yes',photo:{ arbitrary:'ignored' } }],
        access_token:'must-not-be-metadata' },{ type:'FULL_NAME' }] }] });
  });
  const pages=await metaLeadSourceCatalogAdapter.discoverPages(config,credentials);assert.equal(pages.length,2);assert.equal(calls[1]!.url.searchParams.get('after'),'opaque+cursor');
  const forms=await metaLeadSourceCatalogAdapter.discoverForms(config,{ externalId:'1',accessToken:pages[0]!.accessToken });
  assert.deepEqual(forms[0]!.questions[0]!.options,[{ key:'yes',value:'Yes' }]);assert.equal(forms[0]!.questions[1]!.key,null);
  assert.ok(!JSON.stringify(forms).includes('access_token'));assert.ok(!JSON.stringify(forms).includes('untrusted_secret'));
  assert.ok(!JSON.stringify(forms).includes('ignored'));assert.equal(calls.length,3);
  await assert.rejects(metaLeadSourceCatalogAdapter.discoverForms(config,{ externalId:'1/../me',accessToken:'secret' }),/SOURCE_PROVIDER_INPUT_INVALID/);
  assert.equal(calls.length,3);
});
test('source catalog bounds malformed, duplicate, redirect, HTTP and partial pagination failures without leaking provider content',async(t)=> {
  assert.throws(()=>validateSourcePages([{ externalId:'1',name:'P',accessToken:'token' },{ externalId:'1',name:'P',accessToken:'token' }]),/SOURCE_RESPONSE_INVALID/);
  assert.throws(()=>validateSourcePages(Array(1001).fill({})),/SOURCE_CATALOG_TOO_LARGE/);
  assert.throws(()=>validateSourceForms([{ externalId:'1',name:'F',questions:[{ type:'CUSTOM',label:{ unsafe:'object' } }] }]),/SOURCE_RESPONSE_INVALID/);
  assert.throws(()=>validateSourceForms([{ externalId:'1',name:'F',questions:Array(101).fill({}) }]),/SOURCE_RESPONSE_INVALID/);
  let mode='401';let calls=0;
  t.mock.method(globalThis,'fetch',async()=> {
    calls++;
    if (mode==='redirect') throw new Error('Secret token in redirect error');
    if (mode==='oversize') return new Response('secret',{ headers:{ 'content-length':String(512*1024+1) } });
    if (mode==='null') return Response.json(null);
    if (mode==='partial') return calls%2 ? Response.json({ data:[{ id:'1',name:'Page',access_token:'page-token' }],paging:{ next:'url',cursors:{ after:'a' } } })
      : new Response('secret provider body',{ status:500 });
    if (mode==='repeated') return Response.json({ data:[],paging:{ next:'url',cursors:{ after:'same' } } });
    return new Response('secret provider body',{ status:Number(mode) });
  });
  for (const [value,code,retryable] of [['401','SOURCE_PROVIDER_AUTH_FAILED',false],['403','SOURCE_PROVIDER_AUTH_FAILED',false],
    ['429','SOURCE_PROVIDER_RATE_LIMITED',true],['500','SOURCE_PROVIDER_UNAVAILABLE',true],['400','SOURCE_PROVIDER_REJECTED',false],
    ['redirect','SOURCE_PROVIDER_UNAVAILABLE',true],['oversize','SOURCE_RESPONSE_INVALID',false],['null','SOURCE_RESPONSE_INVALID',false],
    ['partial','SOURCE_PROVIDER_UNAVAILABLE',true],['repeated','SOURCE_RESPONSE_INVALID',false]] as const) {
    mode=value;calls=0;await assert.rejects(metaLeadSourceCatalogAdapter.discoverPages(config,credentials),(error:unknown)=> {
      assert.ok(error instanceof SourceProviderError);assert.equal(error.code,code);assert.equal(error.retryable,retryable);assert.ok(!error.message.includes('secret'));return true;
    });
  }
});
