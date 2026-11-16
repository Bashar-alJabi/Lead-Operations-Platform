import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bulkFollowUpHash,type BulkFollowUpInput} from '../src/bulk-follow-ups.js';
import {humanFollowUpOwner} from '../src/human-follow-ups.js';
import type {Principal} from '../src/security.js';
test('Bulk Follow-up retry binds due time, priority, owner and Lead snapshots while normalizing ordinary Human defaults',()=>{
 const input:BulkFollowUpInput={requestId:'key',confirmed:true,dueAt:'2099-11-16T09:30:00Z',note:' call ',items:[{id:'lead',leadVersion:1,ownerUserId:'owner'}]};
 assert.deepEqual(bulkFollowUpHash(input),bulkFollowUpHash({...input,note:'call',priority:'NORMAL'}));
 for(const changed of [{...input,dueAt:'2099-11-16T10:30:00Z'},{...input,priority:'HIGH' as const},{...input,ownerUserId:'different'},{...input,items:[{...input.items[0]!,leadVersion:2}]},{...input,note:'changed'}])assert.notDeepEqual(bulkFollowUpHash(input),bulkFollowUpHash(changed));
});
test('Human Follow-up defaults preserve Agent self, current assignment and acting branch manager without inventing an Admin owner',()=>{
 const lead={id:'lead',branch_id:'branch',assigned_agent_id:'assigned'},actor={id:'caller',role:'MANAGER'} as Principal;
 assert.equal(humanFollowUpOwner(actor,lead,{}),'assigned');assert.equal(humanFollowUpOwner(actor,{...lead,assigned_agent_id:null},{}),'caller');
 assert.equal(humanFollowUpOwner({...actor,role:'AGENT'},lead,{}),'caller');assert.equal(humanFollowUpOwner({...actor,role:'SUPER_ADMIN'},lead,{ownerUserId:'explicit'}),'explicit');
});
