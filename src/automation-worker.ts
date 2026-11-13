import {createDatabase} from './db.js';
import {processOneAutomationMatch,processOneAutomationExecution} from './automation.js';
const batch=Number(process.env.AUTOMATION_WORKER_BATCH??25),poll=Number(process.env.AUTOMATION_WORKER_POLL_MS??2000);
if(!Number.isInteger(batch)||batch<1||batch>100||!Number.isInteger(poll)||poll<250||poll>60000)throw new Error('Invalid automation worker capacity settings');
const db=createDatabase();let running=false,stopping=false,matchNext=true;
async function tick(){if(running||stopping)return;running=true;
 try{for(let n=0;n<batch&&!stopping;n++){
  const first=matchNext?processOneAutomationMatch:processOneAutomationExecution,second=matchNext?processOneAutomationExecution:processOneAutomationMatch;matchNext=!matchNext;
  if(!await first(db)&&!await second(db))break;
 }}catch{process.stderr.write(JSON.stringify({level:'error',event:'automation_worker_cycle_failed'})+'\n');}
 finally{running=false;}}
await tick();process.stdout.write(JSON.stringify({level:'info',event:'automation_worker_started',batch,poll})+'\n');
const timer=setInterval(()=>void tick(),poll);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{stopping=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,50));await db.end();});
