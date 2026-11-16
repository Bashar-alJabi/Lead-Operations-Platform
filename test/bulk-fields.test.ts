import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bulkFieldValue,bulkFieldHash,type BulkFieldInput} from '../src/bulk-fields.js';
test('Bulk tag deltas preserve other tags, deduplicate additions and enforce the typed operand and result boundary',()=>{
 assert.deepEqual(bulkFieldValue('ADD_TAGS','TAGS',['sales'],['sales','support']),['sales','support']);
 assert.deepEqual(bulkFieldValue('REMOVE_TAGS','TAGS',['sales','support'],['sales']),['support']);
 assert.deepEqual(bulkFieldValue('ADD_TAGS','TAGS',null,['sales']),['sales']);
 assert.throws(()=>bulkFieldValue('ADD_TAGS','NUMBER',0,['x']));assert.throws(()=>bulkFieldValue('ADD_TAGS','TAGS',['a'],['x','x']));
 assert.throws(()=>bulkFieldValue('REMOVE_TAGS','TAGS','malformed',['x']));assert.equal(bulkFieldValue('SET','BOOLEAN',true,false),false);
});
test('Bulk immutable retry hash binds selection, versions and typed value while ignoring JSON object key order',()=>{
 const input={requestId:'synthetic',confirmed:true,fieldId:'field',operation:'SET',value:{amount:0,currency:'EUR'},items:[{id:'a',leadVersion:1,definitionVersion:1,bindingVersion:1}]} as BulkFieldInput;
 assert.deepEqual(bulkFieldHash(input),bulkFieldHash({...input,value:{currency:'EUR',amount:0}}));
 for(const changed of [{...input,value:{amount:1,currency:'EUR'}},{...input,items:[{...input.items[0]!,leadVersion:2}]},{...input,operation:'ADD_TAGS' as const}])assert.notDeepEqual(bulkFieldHash(input),bulkFieldHash(changed));
});
