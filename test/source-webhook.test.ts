import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { parseSourceWebhook,verifySourceSignature } from '../src/sources/webhook.js';
import { metaLeadSourceSubscriptionAdapter as adapter } from '../src/sources/meta-subscription.js';
import { safeRequestUrl } from '../src/safe-logging.js';
const event={ object:'page',entry:[{ id:'11',time:1700000000,changes:[{ field:'leadgen',value:{ page_id:'11',form_id:'101',leadgen_id:'999',
  created_time:1699999999,adgroup_id:'77',metadata:{ text:'<img onerror=alert(1)>' } } }] }] };
test('source notifications verify exact raw bytes, reject unsafe shapes and preserve opaque metadata without inventing Ad Set references',()=> {
  const raw=Buffer.from(JSON.stringify(event));const signature='sha256='+createHmac('sha256','synthetic-secret').update(raw).digest('hex');
  verifySourceSignature(raw,signature,'synthetic-secret');
  for (const invalid of [undefined,'sha256=zz','sha256='+'0'.repeat(64),[signature]]) assert.throws(()=>verifySourceSignature(raw,invalid,'synthetic-secret'),/SIGNATURE_INVALID/);
  assert.throws(()=>verifySourceSignature(Buffer.concat([raw,Buffer.from(' ')]),signature,'synthetic-secret'),/SIGNATURE_INVALID/);
  const parsed=parseSourceWebhook(event);assert.equal(parsed[0]!.createdAt,'2023-11-14T22:13:19.000Z');assert.equal(parsed[0]!.raw.change,event.entry[0]!.changes[0]);
  assert.equal(Object.hasOwn(parsed[0]!.raw,'adsetId'),false);
  for (const value of [null,[],{ ...event,object:'whatsapp_business_account' },{ ...event,entry:[] },
    { ...event,entry:[{ ...event.entry[0],id:11 }] },{ ...event,entry:[{ ...event.entry[0],time:'1700000000' }] },
    { ...event,entry:[{ ...event.entry[0],changes:[{ field:'leadgen',value:{ ...event.entry[0]!.changes[0]!.value,page_id:'12' } }] }] },
    { ...event,entry:[{ ...event.entry[0],changes:Array(101).fill(event.entry[0]!.changes[0]) }] }]) assert.throws(()=>parseSourceWebhook(value),/SOURCE_WEBHOOK_/);
});
const input={ config:{ graphVersion:'v25.0',appId:'777' },page:{ externalId:'11',accessToken:'synthetic-page-token' },appSecret:'synthetic-app-secret',subscribe:true };
test('Meta subscription proves app identity, preserves other subscribed fields and verifies the mutation over confined Graph requests',async(t)=> {
  let subscribed=false;let calls=0;
  t.mock.method(globalThis,'fetch',async(path:string|URL,init?:RequestInit)=> {
    const url=new URL(String(path));calls++;assert.equal(url.origin,'https://graph.facebook.com');assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    const token=new Headers(init?.headers).get('authorization');assert.equal(url.searchParams.has('access_token'),false);
    if (url.pathname.endsWith('/debug_token')) { assert.equal(token,'Bearer 777|synthetic-app-secret');assert.equal(url.searchParams.get('input_token'),input.page.accessToken);
      return Response.json({ data:{ app_id:'777',is_valid:true,profile_id:'11' } }); }
    assert.equal(url.pathname,'/v25.0/11/subscribed_apps');assert.equal(token,'Bearer synthetic-page-token');
    if (init?.method==='POST') { assert.equal(String(init.body),'subscribed_fields=messages%2Cleadgen');subscribed=true;return Response.json({ success:true }); }
    return Response.json({ data:[{ id:'777',subscribed_fields:subscribed ? ['messages','leadgen'] : ['messages'] }] });
  });
  assert.deepEqual(await adapter.check(input),{ subscribed:true });assert.equal(calls,4);
  assert.deepEqual(await adapter.check(input),{ subscribed:true });assert.equal(calls,6); // Already subscribed: no mutation.
});
test('Meta subscription rejects app mismatch, malformed, redirect, excessive pagination and provider errors without leaking credentials',async(t)=> {
  let mode='mismatch';let mutations=0;
  t.mock.method(globalThis,'fetch',async(path:string|URL,init?:RequestInit)=> {
    const url=new URL(String(path));if (init?.method==='POST') mutations++;
    if (mode==='redirect') throw new Error('synthetic-page-token');
    if (mode==='401' || mode==='429' || mode==='500') return new Response('synthetic-app-secret',{ status:Number(mode) });
    if (mode==='oversize') return new Response('x',{ headers:{ 'content-length':'300000' } });
    if (url.pathname.endsWith('/debug_token')) return Response.json({ data:{ app_id:mode==='mismatch' ? '888' : '777',is_valid:mode!=='invalid',profile_id:mode==='page' ? '12' : '11' } });
    if (mode==='paging') return Response.json({ data:[],paging:{ next:'https://evil.test/secret',cursors:{ after:'same' } } });
    if (mode==='malformed') return Response.json({ data:[{ id:'777',subscribed_fields:['bad\nfield'] }] });
    return Response.json({ data:[] });
  });
  for (const [value,code] of [['mismatch','AUTH_FAILED'],['invalid','AUTH_FAILED'],['page','AUTH_FAILED'],['401','AUTH_FAILED'],['429','RATE_LIMITED'],['500','UNAVAILABLE'],['redirect','UNAVAILABLE'],['oversize','RESPONSE_INVALID'],['paging','RESPONSE_INVALID'],['malformed','RESPONSE_INVALID']]) {
    mode=value!;await assert.rejects(adapter.check({ ...input,subscribe:false }),new RegExp(code!));
  }
  assert.equal(mutations,0);await assert.rejects(adapter.check({ ...input,config:{ ...input.config,appId:'777/../me' } }),/INPUT_INVALID/);
});
test('request logging strips every query, including verification, OAuth and untrusted search values',()=> {
  assert.equal(safeRequestUrl('/api/webhooks/sources/meta/id?hub.verify_token=secret&hub.challenge=private'),'/api/webhooks/sources/meta/id');
  assert.equal(safeRequestUrl('/callback?code=secret'),'/callback');assert.equal(safeRequestUrl('/health/live'),'/health/live');assert.equal(safeRequestUrl(undefined),undefined);
});
