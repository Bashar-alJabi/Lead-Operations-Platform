import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createDatabase} from '../src/db.js';
import {calculateHandoffDurationSlice,type ResolvedHandoffClock} from '../src/ai/handoff-accounting.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/lead_operations_test')throw new Error('Isolated TEST_DATABASE_URL required');
test('Native bounded SLA arithmetic counts real elapsed and working duration across closed days, fractional endpoints and DST without granting action authority',async t=>{
 const db=createDatabase(url);t.after(()=>db.end());const eventsBefore=(await db`SELECT count(*)::int AS n FROM notification_event`)[0]!.n;
 const slice=async(mode:string,zone:string,h:object,lo:string,hi:string)=>calculateHandoffDurationSlice(db,{mode,timezone:zone,calendar:h} as ResolvedHandoffClock,lo,hi);
 const check=async(zone:string,h:object,lo:string,hi:string,seconds:number)=>{
  const s=await slice('WORKING_HOURS',zone,h,lo,hi);assert.equal(s.accountedMicroseconds,seconds*1_000_000);assert.equal(s.complete,true);assert.equal(s.algorithmVersion,1);assert.equal(s.authorityGranted,false);assert.ok(s.utcCells<=361);return s;
 };
 const elapsed=await slice('ELAPSED','Europe/Paris',{mon:[]},'2026-10-25T00:00:00.000001Z','2026-10-25T03:00:00.000002Z');assert.equal(elapsed.accountedMicroseconds,10_800_000_001);assert.equal(elapsed.utcCells,0);
 await check('UTC',{},'2026-10-14T10:00:00Z','2026-10-14T10:01:00Z',60);
 await check('UTC',{wed:[['10:00','10:01']]},'2026-10-14T09:59:59.500001Z','2026-10-14T10:00:00.123456Z',0.123456);
 await check('UTC',{wed:[['10:00','10:01']]},'2026-10-14T10:00:59.750000Z','2026-10-14T10:01:00.500000Z',0.25);
 await check('UTC',{wed:[['10:00','10:01'],['10:02','10:03']]},'2026-10-14T09:59:30Z','2026-10-14T10:03:30Z',120);
 await check('UTC',{wed:[['23:59','24:00']]},'2026-10-14T23:59:30Z','2026-10-15T00:00:30Z',30);
 await check('UTC',{wed:[]},'2026-10-14T10:00:00Z','2026-10-14T11:00:00Z',0);
 await check('UTC',{mon:[['09:00','17:00']]},'2026-10-14T10:00:00Z','2026-10-14T11:00:00Z',0);
 // Both occurrences of the repeated wall-time interval count; the skipped interval never occurs.
 await check('Europe/Paris',{sun:[['02:15','02:30']]},'2026-10-25T00:00:00Z','2026-10-25T03:00:00Z',1800);
 await check('Europe/Paris',{sun:[['02:15','02:30']]},'2026-03-29T00:00:00Z','2026-03-29T03:00:00Z',0);
 await check('Europe/Paris',{sun:[['01:00','04:00']]},'2026-10-25T00:00:00Z','2026-10-25T03:00:00Z',10_800);
 await check('Europe/Paris',{sun:[['01:00','04:00']]},'2026-03-29T00:00:00Z','2026-03-29T03:00:00Z',7200);
 // Half-hour DST and a whole missing civil date must not be treated as a fixed one-hour transition.
 await check('Australia/Lord_Howe',{sun:[['01:45','02:00']]},'2026-04-04T14:00:00Z','2026-04-04T16:00:00Z',1800);
 await check('Australia/Lord_Howe',{sun:[['02:00','02:30']]},'2026-10-03T14:00:00Z','2026-10-03T17:00:00Z',0);
 await check('Pacific/Apia',{fri:[['00:00','24:00']]},'2011-12-30T09:00:00Z','2011-12-30T12:00:00Z',0);
 // Native timestamp intersection also handles historical second-valued offsets without rounding minutes.
 const oddStart='1911-03-10T23:45:00Z',oddEnd='1911-03-11T00:05:00Z',oddHours={fri:[['23:50','24:00']]};
 const reference=(await db`SELECT count(*)::int AS seconds FROM generate_series(${oddStart}::timestamptz,${oddEnd}::timestamptz-interval '1 second',interval '1 second') instant WHERE operational_hours_open(${db.json(oddHours)},'Europe/Paris',instant)`)[0]!.seconds;
 await check('Europe/Paris',oddHours,oddStart,oddEnd,reference);
 // Future transition styles and non-whole-hour offsets use the same current PostgreSQL timezone data.
 for(const[zone,start,end]of[['America/New_York','2026-11-01T04:45:00Z','2026-11-01T08:15:00Z'],['Asia/Kathmandu','2026-10-14T02:45:00Z','2026-10-14T04:15:00Z'],['Europe/Paris','2026-03-29T00:15:00Z','2026-03-29T03:15:00Z']]as const){
  const allDays={mon:[['09:00','10:00']],tue:[['09:00','10:00']],wed:[['09:00','10:00']],thu:[['09:00','10:00']],fri:[['09:00','10:00']],sat:[['09:00','10:00']],sun:[['01:30','02:15'],['03:00','03:30']]};
  const seconds=(await db`SELECT count(*)::int AS seconds FROM generate_series(${start}::timestamptz,${end}::timestamptz-interval '1 second',interval '1 second') instant WHERE operational_hours_open(${db.json(allDays)},${zone},instant)`)[0]!.seconds;
  await check(zone,allDays,start,end,seconds);
 }
 const boundedWorking=await slice('WORKING_HOURS','UTC',{thu:[['00:00','24:00']]},'2026-01-01T00:00:00Z','6100-01-01T00:00:00Z');assert.equal(boundedWorking.complete,false);assert.equal(boundedWorking.accountedMicroseconds,21_600_000_000);assert.equal(boundedWorking.utcCells,360);
 const chunk=await slice('ELAPSED','UTC',{},'2026-01-01T00:00:00Z','6100-01-01T00:00:00Z');assert.equal(chunk.complete,false);assert.equal(chunk.accountedMicroseconds,21_600_000_000);assert.equal(chunk.utcCells,0);assert.equal(new Date(chunk.processedUntil).toISOString(),'2026-01-01T06:00:00.000Z');
 // Arbitrary queue catch-up boundaries are additive, including inside the repeated hour.
 const h={sun:[['02:00','03:00']]},a='2026-10-25T00:00:00.123456Z',b='2026-10-25T01:23:45.654321Z',c='2026-10-25T03:00:00.987654Z';
 assert.equal((await slice('WORKING_HOURS','Europe/Paris',h,a,c)).accountedMicroseconds,(await slice('WORKING_HOURS','Europe/Paris',h,a,b)).accountedMicroseconds+(await slice('WORKING_HOURS','Europe/Paris',h,b,c)).accountedMicroseconds);
 const weekly={mon:[['09:00','17:00']],tue:[['09:00','17:00']],wed:[['09:00','17:00']],thu:[['09:00','17:00']],fri:[['09:00','17:00']]};
 let cursor='2026-10-09T16:00:00Z',total=0,calls=0;const until='2026-10-12T10:00:00Z';const started=performance.now();
 while(cursor<until){const s=await slice('WORKING_HOURS','UTC',weekly,cursor,until);assert.ok(s.utcCells<=361);assert.ok(new Date(s.processedUntil)>new Date(cursor));total+=s.accountedMicroseconds;cursor=new Date(s.processedUntil).toISOString();calls++;if(s.complete)break;assert.ok(calls<20);}
 assert.equal(total,7200_000_000);assert.equal(calls,11);t.diagnostic(`Weekend catch-up ${calls} bounded slices: ${Math.round(performance.now()-started)}ms; measurement is not a capacity guarantee.`);
 await db.begin(async tx=>{await tx`SET LOCAL TIME ZONE 'America/New_York'`;const s=(await tx`SELECT ai_handoff_clock_slice('WORKING_HOURS','Europe/Paris',${tx.json(h)},${a}::text::timestamptz,${c}::text::timestamptz) AS s`)[0]!.s;assert.equal(s.accountedMicroseconds,(await slice('WORKING_HOURS','Europe/Paris',h,a,c)).accountedMicroseconds);});
 for(const[mode,zone,calendar,lo,hi]of[['BAD','UTC',{},a,c],['ELAPSED','Not/Real',{},a,c],['ELAPSED','UTC',{sun:[['03:00','02:00']]},a,c],['ELAPSED','UTC',{},c,a],['ELAPSED','UTC',{},'infinity','infinity']]as const)await assert.rejects(slice(mode,zone,calendar,lo,hi),/SLICE_INVALID/);
 assert.equal((await slice('WORKING_HOURS','UTC',weekly,a,a)).accountedMicroseconds,0);
 assert.equal((await db`SELECT count(*)::int AS n FROM notification_event`)[0]!.n,eventsBefore);
});
