import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyHandoffClock,normalizeHandoffClock} from '../src/ai/handoff-clock.js';
test('Handoff clocks distinguish inheritance, elapsed/working calendars, unrestricted/closed days and reject unsafe shapes/zones',()=>{
 assert.deepEqual(normalizeHandoffClock(emptyHandoffClock()),{mode:null,timezone:null,calendar:null});
 assert.deepEqual(normalizeHandoffClock({mode:'ELAPSED',timezone:'UTC',calendar:{}}),{mode:'ELAPSED',timezone:'UTC',calendar:{}});
 const c=normalizeHandoffClock({mode:'WORKING_HOURS',timezone:'Europe/Paris',calendar:{mon:[['09:00','24:00']]}});assert.deepEqual(c.calendar?.tue,[]);
 for(const d of [null,[],{}, {...emptyHandoffClock(),extra:true},{...emptyHandoffClock(),mode:'false'},{...emptyHandoffClock(),timezone:'Not/Real'}, {...emptyHandoffClock(),timezone:' UTC '},{...emptyHandoffClock(),calendar:{mon:null}},{...emptyHandoffClock(),calendar:{mon:[['22:00','02:00']]}}])assert.throws(()=>normalizeHandoffClock(d));
});
