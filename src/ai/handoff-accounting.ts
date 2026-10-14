import type postgres from 'postgres';
import type {Database} from '../db.js';
import type {WeeklyHours} from '../working-hours.js';

export type ResolvedHandoffClock={mode:'ELAPSED'|'WORKING_HOURS';timezone:string;calendar:WeeklyHours};
export type HandoffDurationSlice={algorithmVersion:1;accountedMicroseconds:number;processedUntil:string;complete:boolean;utcCells:number;sliceMinutes:360;authorityGranted:false};

// Internal arithmetic only. Callers still need native trusted source/current job/action guards.
// Keep DB timestamps as text/JSON strings: JavaScript Date would truncate their microseconds.
export async function calculateHandoffDurationSlice(sql:Database|postgres.TransactionSql,clock:ResolvedHandoffClock,from:string,until:string):Promise<HandoffDurationSlice>{
 const row=(await sql`SELECT ai_handoff_clock_slice(${clock.mode},${clock.timezone},${sql.json(clock.calendar)},${from}::text::timestamptz,${until}::text::timestamptz) AS result`)[0]!;
 return row.result as HandoffDurationSlice;
}
