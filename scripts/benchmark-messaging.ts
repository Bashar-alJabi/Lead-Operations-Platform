import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runMessagingLoad, type MessagingLoadOptions } from '../test-integration/support/messaging-load.js';

if (process.argv.length !== 3 || process.argv[2] !== '--reset-test-database')
  throw new Error('Usage: npm run benchmark:messaging -- --reset-test-database (resets local lead_operations_test only)');
const input: Partial<MessagingLoadOptions> = {};
for (const [key, name] of Object.entries({ contactsPerSender: 'LOAD_CONTACTS_PER_SENDER', senders: 'LOAD_SENDERS',
  workers: 'LOAD_WORKERS', apiReplicas: 'LOAD_API_REPLICAS', httpConcurrency: 'LOAD_HTTP_CONCURRENCY',
  duplicateCopies: 'LOAD_DUPLICATE_COPIES', providerDelayMs: 'LOAD_PROVIDER_DELAY_MS' })) {
  if (process.env[name] !== undefined) input[key as keyof MessagingLoadOptions] = Number(process.env[name]);
}
const result = await runMessagingLoad(process.env.TEST_DATABASE_URL, true, input);
const folder = resolve('.local/performance'); await mkdir(folder, { recursive: true });
const path = resolve(folder, 'messaging-latest.json'); await writeFile(path, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
