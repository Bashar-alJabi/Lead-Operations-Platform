import { createDatabase } from './db.js';
import { processOneAISimulation,processOneAICopilotSummary } from './ai/simulation-worker.js';
import { processOneAICustomerProposal } from './ai/customer-worker.js';
import { processOneAIQualificationAction } from './ai/customer-qualification.js';
import { processOneAIHumanHandoff } from './ai/customer-handoff.js';
import { processOneAIHandoffSummary } from './ai/handoff-summary.js';
import { processOneAICustomerSend } from './ai/customer-send.js';
import { admitLegacyLocalAIActions, type LocalAIActionKind } from './ai/local-action-queue.js';
const db=createDatabase();let running=false,stopping=false;
const legacy = new Map<LocalAIActionKind, { done: boolean; nextCursor: { createdAt: string; proposalId: string } | null }>([['QUALIFICATION',{done:false,nextCursor:null}],['HANDOFF',{done:false,nextCursor:null}]]);
async function tick(){ if(running || stopping)return;running=true;try {
 for(const [kind,sweep] of legacy)if(!sweep.done&&!stopping)legacy.set(kind,await admitLegacyLocalAIActions(db,kind,sweep.nextCursor));
 for(let i=0;i<5 && !stopping;i++){ const customer=await processOneAICustomerProposal(db),action=await processOneAIQualificationAction(db),handoff=await processOneAIHumanHandoff(db),send=await processOneAICustomerSend(db),summary=await processOneAIHandoffSummary(db),a=await processOneAISimulation(db),b=await processOneAICopilotSummary(db);if(!customer && !action && !handoff && !send && !summary && !a && !b)break; } }catch { process.stderr.write('AI worker cycle failed; retrying.\n'); }finally { running=false; } }
await tick();process.stdout.write(JSON.stringify({event:'ai_worker_started',batch:5,legacyBatch:25,pollMs:2000})+'\n');const timer=setInterval(()=>void tick(),2000);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{ stopping=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,50));await db.end(); });
