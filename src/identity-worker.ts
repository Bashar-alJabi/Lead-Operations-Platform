import { createDatabase } from './db.js';
import { processOneIdentityEmailJob } from './identity-email.js';

const db = createDatabase();
let running = false;
let stopping = false;

async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    for (let i = 0; i < 10 && await processOneIdentityEmailJob(db); i += 1) { /* bounded batch */ }
  } catch {
    process.stderr.write('Identity email worker cycle failed; retrying.\n');
  } finally {
    running = false;
  }
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
