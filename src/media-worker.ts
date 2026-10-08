import { createDatabase } from './db.js';
import { processOneInboundAttachment } from './media/inbound-worker.js';
import { processOneTemplateSample } from './media/template-sample-worker.js';
import { processOneKnowledgeAsset } from './ai/knowledge-asset-worker.js';
const db = createDatabase();
let running = false; let stopping = false;
async function tick() {
  if (running || stopping) return;
  running = true;
  try { for (let i = 0; i < 5 && !stopping; i++) {
    const inbound=await processOneInboundAttachment(db);
    const sample=!stopping && await processOneTemplateSample(db);
    const knowledge=!stopping && await processOneKnowledgeAsset(db);
    if (!inbound && !sample && !knowledge) break;
  } }
  catch { process.stderr.write('Media worker cycle failed; retrying.\n'); }
  finally { running = false; }
}
await tick();
const timer = setInterval(() => { void tick(); }, 2000);
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, async () => {
  stopping = true; clearInterval(timer);
  while (running) await new Promise((resolve) => setTimeout(resolve, 50));
  await db.end();
});
