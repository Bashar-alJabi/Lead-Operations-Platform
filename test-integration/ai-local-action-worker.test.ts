import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/lead_operations_test') throw new Error('Isolated TEST_DATABASE_URL required');
test('AI CLI starts bounded legacy admission and local action processing and shuts down without enabling live inference', async () => {
  const child = spawn(process.execPath, [resolve('dist/src/ai-worker.js')], { env: { ...process.env, DATABASE_URL: url }, windowsHide: true });
  let output = '', failure = ''; child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { failure += String(b); });
  try {
    for (let n = 0; n < 200 && !output.includes('ai_worker_started'); n++) { assert.equal(child.exitCode, null, failure); await new Promise(r => setTimeout(r, 50)); }
    assert.match(output, /ai_worker_started/); assert.match(output, /"legacyBatch":25/); assert.match(output, /"batch":5/);
    assert.equal(failure, '');
  } finally { const closed = new Promise<void>(r => child.once('close', () => r())); child.kill('SIGTERM'); await closed; }
});
