import {createDatabase} from './db.js';
import {processOneHandoffSLATimer,admitLegacyHandoffSLATimers} from './ai/handoff-sla.js';
const db=createDatabase();let running=false,stopping=false;
const batch=Number(process.env.HANDOFF_SLA_WORKER_BATCH??25),poll=Number(process.env.HANDOFF_SLA_WORKER_POLL_MS??2000);
if(!Number.isInteger(batch)||batch<1||batch>100||!Number.isInteger(poll)||poll<250||poll>60000)throw new Error('Invalid Handoff SLA worker capacity settings');
let legacyDone=false,legacyCursor:string|null=null;
async function tick(){if(running||stopping)return;running=true;try{for(let n=0;n<batch&&!stopping;n++)if(!await processOneHandoffSLATimer(db))break;
 if(!legacyDone&&!stopping){const result=await admitLegacyHandoffSLATimers(db,legacyCursor);legacyDone=result.done;legacyCursor=result.nextCursor??legacyCursor;}
 }catch{process.stderr.write(JSON.stringify({level:'error',event:'handoff_sla_worker_cycle_failed'})+'\n');}finally{running=false;}}
await tick();process.stdout.write(JSON.stringify({level:'info',event:'handoff_sla_worker_started',batch,poll})+'\n');const timer=setInterval(()=>void tick(),poll);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{stopping=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,50));await db.end();});
