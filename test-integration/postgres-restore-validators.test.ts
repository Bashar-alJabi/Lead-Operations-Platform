import assert from 'node:assert/strict';
import {test} from 'node:test';
import {emptyKnowledge} from '../src/ai/knowledge.js';
import {createDatabase} from '../src/db.js';

const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');

test('Database CHECK validators accept valid rows and reject invalid rows on the pg_restore search path',async t=>{
 const db=createDatabase(url);
 t.after(()=>db.end());
 const draft=emptyKnowledge();
 const tools={allowedTools:['sendConversationMessage','requestHumanHandoff']};
 const clock={mode:'WORKING_HOURS',timezone:'UTC',calendar:{mon:[['09:00','17:00']]}};
 const payment={maxAttempts:3,retentionMs:90000,dispatchBudgetMs:30000,retryBaseMs:2000,retryMaxMs:60000};
 const [result]=await db.begin(async tx=>{
  await tx`SET LOCAL search_path TO ''`;
  return tx`SELECT public.ai_knowledge_content_valid(${tx.json(draft)}) AS valid_draft,
   public.ai_knowledge_content_valid(${tx.json({...draft,assets:['invalid']})}) AS invalid_draft,
   public.ai_tool_policy_valid(${tx.json(tools)}) AS valid_tools,
   public.ai_tool_policy_valid(${tx.json({allowedTools:['unapprovedTool']})}) AS invalid_tools,
   public.ai_handoff_clock_valid(${tx.json(clock)}) AS valid_clock,
   public.ai_handoff_clock_valid(${tx.json({...clock,calendar:{mon:[['17:00','09:00']]}})}) AS invalid_clock,
   public.valid_payment_dispatch_policy(${tx.json(payment)}) AS valid_payment,
   public.valid_payment_dispatch_policy(${tx.json({...payment,retentionMs:null})}) AS invalid_payment`;
 });
 assert.deepEqual(result,{valid_draft:true,invalid_draft:false,valid_tools:true,invalid_tools:false,
  valid_clock:true,invalid_clock:false,valid_payment:true,invalid_payment:false});
});
