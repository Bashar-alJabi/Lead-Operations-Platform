import { test } from 'node:test';
import { runMessagingLoad } from './support/messaging-load.js';

test('signed webhook bursts and multi-pool workers preserve messages, sender isolation, cooldown and monotonic delivery',
  { timeout: 120000 }, async () => {
    await runMessagingLoad(process.env.TEST_DATABASE_URL, true, { contactsPerSender: 12, duplicateCopies: 2 });
  });
