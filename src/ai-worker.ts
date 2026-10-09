import { createDatabase } from './db.js';
import { processOneAISimulation,processOneAICopilotSummary } from './ai/simulation-worker.js';
const db=createDatabase();let running=false,stopping=false;
async function tick(){ if(running || stopping)return;running=true;try { for(let i=0;i<5 && !stopping;i++){ const a=await processOneAISimulation(db),b=await processOneAICopilotSummary(db);if(!a && !b)break; } }catch { process.stderr.write('AI read worker cycle failed; retrying.\n'); }finally { running=false; } }
await tick();const timer=setInterval(()=>void tick(),2000);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{ stopping=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,50));await db.end(); });
