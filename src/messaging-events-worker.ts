import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from './db.js';
import { processOnePendingDeliveryEvent } from './messaging/delivery-events.js';
import { processOneInboundEvent } from './messaging/inbound-events.js';
import { eventWorkerOptions } from './messaging/event-processing.js';

const options = eventWorkerOptions(); const db = createDatabase(); let running = false; let stopping = false;
async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    // Alternating queues keeps both inbound and callbacks progressing during a burst.
    for (let i = 0; i < options.batchSize && !stopping; i++) {
      const callback = await processOnePendingDeliveryEvent(db);
      const inbound = !stopping && await processOneInboundEvent(db);
      if (!callback && !inbound) break;
    }
  } catch {
    process.stderr.write(JSON.stringify({ level: 'error', component: 'messaging-events-worker',
      code: 'EVENT_WORKER_CYCLE_FAILED', at: new Date().toISOString() }) + '\n');
  } finally { running = false; }
}
await tick(); const timer = setInterval(() => { void tick(); }, options.pollMs);
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, async () => {
  stopping = true; clearInterval(timer); while (running) await delay(50); await db.end();
});
