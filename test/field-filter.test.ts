import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fieldFilterInputValue,fieldFilterValue} from '../web/src/field-filter.js';
test('UI field filters encode typed zero/false/selection/currency values without changing text into instructions',()=>{
 assert.equal(fieldFilterValue({field_type:'NUMBER'},'0'),0);assert.equal(fieldFilterValue({field_type:'BOOLEAN'},'false'),false);
 assert.deepEqual(fieldFilterValue({field_type:'MULTI_SELECT'},'["a","b"]'),['a','b']);assert.deepEqual(fieldFilterValue({field_type:'TAGS'},'["sales"]'),['sales']);
 assert.deepEqual(fieldFilterValue({field_type:'CURRENCY',validation:{currency:'EUR'}},'10.25'),{amount:10.25,currency:'EUR'});
 assert.deepEqual(fieldFilterValue({field_type:'TAGS'},'sales, service'),['sales','service']);
 assert.equal(fieldFilterValue({field_type:'TEXT'},'<script>literal</script>'),'<script>literal</script>');assert.throws(()=>fieldFilterValue({field_type:'MULTI_SELECT'},'not JSON'));
});
test('Saved filters retain typed selections and currency input while preserving false and zero',()=>{
 assert.equal(fieldFilterInputValue(false),'false');assert.equal(fieldFilterInputValue(0),'0');assert.equal(fieldFilterInputValue(['a','b']),'["a","b"]');
 assert.equal(fieldFilterInputValue({amount:12.5,currency:'EUR'}),'12.5');assert.equal(fieldFilterInputValue(null),'');
});
