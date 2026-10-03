import { createDatabase } from './db.js';
import { processOneMessagingJob } from './messaging/send-worker.js';
import { processOnePendingDeliveryEvent } from './messaging/delivery-events.js';
import { processOneInboundEvent } from './messaging/inbound-events.js';

const db = createDatabase();
let running = false;
let stopping = false;

async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    for (let i = 0; i < 10 && await processOneMessagingJob(db); i += 1) { /* bounded batch */ }
    for (let i = 0; i < 50 && await processOnePendingDeliveryEvent(db); i += 1) { /* bounded reconciliation */ }
    for (let i = 0; i < 50 && await processOneInboundEvent(db); i += 1) { /* bounded inbound resolution */ }
  } catch {
    process.stderr.write('Messaging worker cycle failed; retrying.\n');
  } finally { running = false; }
}

await tick();
const timer = setInterval(() => { void tick(); }, 2_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopping = true;
    clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    await db.end();
  });
}
