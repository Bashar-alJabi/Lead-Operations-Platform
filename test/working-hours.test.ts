import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWeeklyHours } from '../src/working-hours.js';
import { isWithinWorkingHours } from '../src/routing.js';
test('Working hours distinguish unrestricted and closed schedules and preserve local day boundaries',()=>{
  assert.deepEqual(normalizeWeeklyHours({}),{});
  const closed=normalizeWeeklyHours({mon:[]});assert.equal(isWithinWorkingHours(closed,'UTC',new Date('2026-10-12T09:00:00Z')),false);
  const hours=normalizeWeeklyHours({mon:[['09:00','12:00'],['13:00','24:00']]});
  assert.equal(isWithinWorkingHours(hours,'Europe/Paris',new Date('2026-10-12T07:00:00Z')),true);
  assert.equal(isWithinWorkingHours(hours,'Europe/Paris',new Date('2026-10-12T10:00:00Z')),false);
  assert.equal(isWithinWorkingHours(hours,'UTC',new Date('2026-10-12T23:59:59Z')),true);
  assert.equal(isWithinWorkingHours(hours,'UTC',new Date('2026-10-13T00:00:00Z')),false);
});
test('Working hours reject malformed, overlapping, reversed, oversized and overnight periods',()=>{
  for(const h of [null,[],{bad:[]},{mon:null},{mon:[['24:00','24:00']]},{mon:[['09:00','08:00']]},{mon:[['22:00','02:00']]},
    {mon:[['09:00','13:00'],['12:00','15:00']]},{mon:[['09:60','17:00']]},{mon:Array.from({length:9},()=>['09:00','10:00'])}])assert.throws(()=>normalizeWeeklyHours(h));
  assert.doesNotThrow(()=>normalizeWeeklyHours({mon:[['09:00','10:00'],['10:00','11:00']]}));
});
