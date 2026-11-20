import {createDatabase} from './db.js';
import {processOneEmailPublication} from './notification-email-outbox.js';
import {processOneNotificationEmail} from './notification-email-dispatch.js';
import {sendNotificationSmtp} from './identity-email.js';
const db=createDatabase();let running=false,stopping=false;
const batch=Number(process.env.EMAIL_NOTIFICATION_WORKER_BATCH??25),poll=Number(process.env.EMAIL_NOTIFICATION_WORKER_POLL_MS??2000);
if(!Number.isInteger(batch)||batch<1||batch>100||!Number.isInteger(poll)||poll<250||poll>60000)throw Error('Invalid Email notification worker capacity');
async function tick(){if(running||stopping)return;running=true;try{
 for(let n=0;n<batch&&!stopping;n++){
  const prepared=await processOneEmailPublication(db);
  const sent=process.env.EMAIL_NOTIFICATION_SMTP_ENABLED==='1' && await processOneNotificationEmail(db,sendNotificationSmtp);
  if(!prepared&&!sent)break;
 }
}catch{process.stderr.write(JSON.stringify({level:'error',event:'email_notification_materialization_failed'})+'\n');}finally{running=false;}}
await tick();
if(process.env.EMAIL_NOTIFICATION_WORKER_ONCE==='1')await db.end();
else{
 process.stdout.write(JSON.stringify({level:'info',event:'email_notification_worker_started',batch,poll})+'\n');
 const timer=setInterval(()=>void tick(),poll);
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{stopping=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,50));await db.end();});
}
