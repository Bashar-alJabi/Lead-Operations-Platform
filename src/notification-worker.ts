import {createDatabase} from './db.js';
import {processOneFollowUpNotification} from './follow-up-notifications.js';
const db=createDatabase();let running=false,stopping=false;
const batch=Number(process.env.NOTIFICATION_WORKER_BATCH??25),poll=Number(process.env.NOTIFICATION_WORKER_POLL_MS??2000);
if(!Number.isInteger(batch)||batch<1||batch>100||!Number.isInteger(poll)||poll<250||poll>60000)throw new Error('Invalid notification worker capacity settings');
async function tick(){if(running||stopping)return;running=true;
 try{for(let n=0;n<batch&&!stopping;n++)if(!await processOneFollowUpNotification(db))break;}
 catch{process.stderr.write(JSON.stringify({level:'error',event:'notification_worker_cycle_failed'})+'\n');}
 finally{running=false;}}
await tick();process.stdout.write(JSON.stringify({level:'info',event:'notification_worker_started',batch,poll})+'\n');const timer=setInterval(()=>void tick(),poll);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{stopping=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,50));await db.end();});
