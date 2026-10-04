import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedLoadDatabase, loadOptions } from '../test-integration/support/messaging-load.js';

test('load tooling refuses development/remote databases and unbounded workloads before opening a connection', () => {
  assert.throws(() => isolatedLoadDatabase('postgres://localhost/lead_operations', true));
  assert.throws(() => isolatedLoadDatabase('postgres://db.example.test/lead_operations_test', true));
  assert.throws(() => isolatedLoadDatabase('https://localhost/lead_operations_test', true));
  assert.throws(() => isolatedLoadDatabase('postgres://localhost/lead_operations_test', false));
  assert.throws(() => isolatedLoadDatabase(undefined, true));
  assert.equal(isolatedLoadDatabase('postgres://localhost/lead_operations_test', true), 'postgres://localhost/lead_operations_test');
  assert.throws(() => loadOptions({ workers: 100 })); assert.throws(() => loadOptions({ senders: 3 }));
  assert.throws(() => loadOptions({ contactsPerSender: 0 })); assert.throws(() => loadOptions({ providerDelayMs: -1 }));
  assert.throws(() => loadOptions({ apiReplicas: NaN })); assert.equal(loadOptions().senders, 4);
});
