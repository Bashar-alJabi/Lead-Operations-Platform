import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from './db.js';
import { processOneSourceRetrieval,sourceWorkerOptions } from './sources/retrieval-worker.js';
import { processOneSourceEvaluation } from './sources/evaluation.js';
import { processOneSourceIntake } from './sources/intake.js';
const db=createDatabase();const options=sourceWorkerOptions();let running=false;let evaluating=false;let intaking=false;let stopping=false;
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
async function intakeTick() {
  if (intaking || stopping) return;intaking=true;
  try { for (let i=0;i<options.batchSize && !stopping;i++) if (!await processOneSourceIntake(db)) break; }
  catch { process.stderr.write(JSON.stringify({ level:'error',component:'source-intake-worker',code:'SOURCE_INTAKE_CYCLE_FAILED',at:new Date().toISOString() })+'\n'); }
  finally { intaking=false; }
}
void tick();void evaluationTick();void intakeTick();
const timer=setInterval(()=> { void tick(); },options.pollMs);
const evaluationTimer=setInterval(()=> { void evaluationTick(); },options.pollMs);
const intakeTimer=setInterval(()=> { void intakeTick(); },options.pollMs);
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,async()=> {
  stopping=true;clearInterval(timer);clearInterval(evaluationTimer);clearInterval(intakeTimer);while (running || evaluating || intaking) await delay(50);await db.end();
});
