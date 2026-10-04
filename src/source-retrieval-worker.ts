import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from './db.js';
import { processOneSourceRetrieval,sourceWorkerOptions } from './sources/retrieval-worker.js';
const db=createDatabase();const options=sourceWorkerOptions();let running=false;let stopping=false;
async function tick() {
  if (running || stopping) return;running=true;
  try { for (let i=0;i<options.batchSize && !stopping;i++) if (!await processOneSourceRetrieval(db)) break; }
  catch { process.stderr.write(JSON.stringify({ level:'error',component:'source-retrieval-worker',code:'SOURCE_WORKER_CYCLE_FAILED',at:new Date().toISOString() })+'\n'); }
  finally { running=false; }
}
await tick();const timer=setInterval(()=> { void tick(); },options.pollMs);
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,async()=> {
  stopping=true;clearInterval(timer);while (running) await delay(50);await db.end();
});
