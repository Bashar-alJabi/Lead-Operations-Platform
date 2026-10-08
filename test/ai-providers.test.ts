import test from 'node:test';
import assert from 'node:assert/strict';
import { aiCredential,normalizeAIModels,openAIConnectionAdapter } from '../src/ai/providers.js';
test('AI catalog normalization is bounded, deterministic and excludes unsafe model identifiers',()=> {
  assert.deepEqual(normalizeAIModels(['model-b','model-a']),['model-a','model-b']);
  for(const value of [null,['../bad'],['x','x'],[42],Array(2001).fill('x')])assert.throws(()=>normalizeAIModels(value));
  assert.throws(()=>aiCredential('short'));assert.throws(()=>aiCredential('synthetic-header\ninjection'));assert.equal(aiCredential('SyntheticCredential_123'),'SyntheticCredential_123');
});
test('Actual OpenAI catalog adapter uses fixed authenticated GET, bounded safe IDs and no Lead data or raw provider errors',async(t)=> {
  const old=globalThis.fetch;t.after(()=>{ globalThis.fetch=old; });let response=new Response(JSON.stringify({ object:'list',data:[{ id:'mock-model-b',object:'model',owned_by:'private-metadata' },{ id:'mock-model-a',object:'model' }] }));
  globalThis.fetch=async(input,init)=>{ assert.equal(input,'https://api.openai.com/v1/models');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal(init?.body,undefined);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer SyntheticCredential_123');return response; };
  assert.deepEqual(await openAIConnectionAdapter.listModels('SyntheticCredential_123'),['mock-model-a','mock-model-b']);
  for(const [status,code] of [[401,'AI_AUTH_FAILED'],[403,'AI_AUTH_FAILED'],[429,'AI_RATE_LIMITED'],[503,'AI_PROVIDER_UNAVAILABLE']] as const) {
    response=new Response('secret unsafe raw error',{ status });await assert.rejects(()=>openAIConnectionAdapter.listModels('SyntheticCredential_123'),new RegExp(code));
  }
  response=new Response(JSON.stringify({ object:'list',data:[{ id:'<script>',object:'model' }] }));await assert.rejects(()=>openAIConnectionAdapter.listModels('SyntheticCredential_123'),/AI_RESPONSE_INVALID/);
  response=new Response('x'.repeat(1048577));await assert.rejects(()=>openAIConnectionAdapter.listModels('SyntheticCredential_123'),/AI_RESPONSE_INVALID/);
  globalThis.fetch=async()=>{ throw new Error('secret transport exception'); };await assert.rejects(()=>openAIConnectionAdapter.listModels('SyntheticCredential_123'),/AI_PROVIDER_UNAVAILABLE/);
});
