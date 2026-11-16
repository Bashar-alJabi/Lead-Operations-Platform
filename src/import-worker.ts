import {createDatabase} from './db.js';
import {processOneImportFile} from './imports/service.js';
const batch=Number(process.env.IMPORT_WORKER_BATCH??2),poll=Number(process.env.IMPORT_WORKER_POLL_MS??2000),once=process.env.IMPORT_WORKER_ONCE==='1';
if(!Number.isInteger(batch)||batch<1||batch>20||!Number.isInteger(poll)||poll<250||poll>60000)throw Error('Invalid Import worker capacity');
const db=createDatabase();let running=false,stopping=false;
async function tick(){if(running||stopping)return;running=true;try{for(let i=0;i<batch&&!stopping;i++)if(!await processOneImportFile(db))break;}
 catch{process.stderr.write(JSON.stringify({level:'error',event:'import_worker_cycle_failed'})+'\n');}finally{running=false;}}
await tick();if(once)await db.end();else{
 process.stdout.write(JSON.stringify({level:'info',event:'import_worker_started',batch,poll})+'\n');const timer=setInterval(()=>void tick(),poll);
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,async()=>{stopping=true;clearInterval(timer);while(running)await new Promise(r=>setTimeout(r,50));await db.end();});
}
