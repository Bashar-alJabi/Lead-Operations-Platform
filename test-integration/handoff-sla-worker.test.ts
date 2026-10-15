import {test} from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {resolve} from 'node:path';
const url=process.env.TEST_DATABASE_URL;if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('Dedicated Handoff SLA CLI starts with bounded capacity, rejects invalid configuration and can be stopped independently of AI inference',async()=>{
 const invalid=spawn(process.execPath,[resolve('dist/src/handoff-sla-worker.js')],{env:{...process.env,DATABASE_URL:url,HANDOFF_SLA_WORKER_BATCH:'0'},windowsHide:true});let error='';invalid.stderr.on('data',b=>{error+=String(b);});
 const code=await new Promise<number|null>((res,rej)=>{invalid.once('exit',res);invalid.once('error',rej);});assert.notEqual(code,0);assert.match(error,/Invalid Handoff SLA worker capacity settings/);
 const worker=spawn(process.execPath,[resolve('dist/src/handoff-sla-worker.js')],{env:{...process.env,DATABASE_URL:url,HANDOFF_SLA_WORKER_BATCH:'2',HANDOFF_SLA_WORKER_POLL_MS:'300'},windowsHide:true});let output='',failure='';worker.stdout.on('data',b=>{output+=String(b);});worker.stderr.on('data',b=>{failure+=String(b);});
 try{for(let n=0;n<100&&!output.includes('handoff_sla_worker_started');n++){assert.equal(worker.exitCode,null,failure);await new Promise(r=>setTimeout(r,50));}assert.match(output,/handoff_sla_worker_started/);assert.match(output,/"batch":2/);assert.equal(failure,'');}
 finally{const closed=new Promise<void>(r=>worker.once('close',()=>r()));worker.kill('SIGTERM');await closed;}
});
