import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireLocalE2ETarget } from '../test-e2e/guard.js';
test('browser reset guard rejects development, production, remote and missing consent before opening a database',()=> {
  const valid='postgres://test:test@127.0.0.1:5432/lead_operations_test';
  assert.equal(requireLocalE2ETarget(valid,'1','test'),valid);
  for (const [url,ack,env] of [[undefined,'1','test'],['invalid-secret-url','1','test'],
    [valid,undefined,'test'],[valid,'0','test'],[valid,'1','production'],
    [valid.replace('lead_operations_test','lead_operations'),'1','test'],
    [valid.replace('127.0.0.1','database.example'),'1','test'],[valid.replace('postgres:','https:'),'1','test']]) {
    assert.throws(()=>requireLocalE2ETarget(url,ack,env),(error:Error)=>error.message.startsWith('E2E requires local')
      && !error.message.includes('secret') && !error.message.includes('postgres://'));
  }
});
