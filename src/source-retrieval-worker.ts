import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from './db.js';
import { processOneSourceRetrieval,sourceWorkerOptions } from './sources/retrieval-worker.js';
import { processOneSourceEvaluation } from './sources/evaluation.js';
const db=createDatabase();const options=sourceWorkerOptions();let running=false;let evaluating=false;let stopping=false;
async function tick() {
  if (running || stopping) return;running=true;
  try {
    for (let i=0;i<options.batchSize && !stopping;i++) if (!await processOneSourceRetrieval(db)) break;
  }
  catch { process.stderr.write(JSON.stringify({ level:'error',component:'source-retrieval-worker',code:'SOURCE_WORKER_CYCLE_FAILED',at:new Date().toISOString() })+'\n'); }
  finally { running=false; }
}
// Independent schedules keep slow provider GETs from delaying already retrieved submissions.
async function evaluationTick() {
  if (evaluating || stopping) return;evaluating=true;
  try { for (let i=0;i<options.batchSize && !stopping;i++) if (!await processOneSourceEvaluation(db)) break; }
  catch { process.stderr.write(JSON.stringify({ level:'error',component:'source-processing-worker',code:'SOURCE_EVALUATION_CYCLE_FAILED',at:new Date().toISOString() })+'\n'); }
  finally { evaluating=false; }
}
void tick();void evaluationTick();
const timer=setInterval(()=> { void tick(); },options.pollMs);
const evaluationTimer=setInterval(()=> { void evaluationTick(); },options.pollMs);
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,async()=> {
  stopping=true;clearInterval(timer);clearInterval(evaluationTimer);while (running || evaluating) await delay(50);await db.end();
});
