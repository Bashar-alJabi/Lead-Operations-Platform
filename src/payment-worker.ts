import { createDatabase } from './db.js';
import { processOnePaymentDispatch } from './payments/dispatch-worker.js';
import { processOnePaymentReceipt } from './payments/confirmation-worker.js';
import { processOnePaymentCapture } from './payments/capture-worker.js';
const db=createDatabase();let running=false;let stopping=false;
async function tick() {
  if(running || stopping)return;running=true;
  try { for(let i=0;i<10 && !stopping;i++) {
    const receipt=await processOnePaymentReceipt(db);const dispatch=await processOnePaymentDispatch(db);const capture=await processOnePaymentCapture(db);if(!receipt && !dispatch && !capture)break;
  } }catch { process.stderr.write('Payment worker cycle failed; durable leases will recover.\n'); }
  finally { running=false; }
}
await tick();const timer=setInterval(()=>void tick(),2000);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=> {
  stopping=true;clearInterval(timer);while(running)await new Promise((resolve)=>setTimeout(resolve,50));await db.end();
});
