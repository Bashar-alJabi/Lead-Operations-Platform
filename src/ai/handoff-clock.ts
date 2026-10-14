import {HttpError} from '../security.js';
import {normalizeWeeklyHours,weeklyHoursSchema,type WeeklyHours} from '../working-hours.js';
export type HandoffClock={mode:'ELAPSED'|'WORKING_HOURS'|null;timezone:string|null;calendar:WeeklyHours|null};
export function emptyHandoffClock():HandoffClock{return {mode:null,timezone:null,calendar:null};}
export function normalizeHandoffClock(raw:unknown):HandoffClock {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==3||!['mode','timezone','calendar'].every(k=>Object.hasOwn(raw,k)))throw new HttpError(400,'INVALID_HANDOFF_CLOCK');
 const r=raw as Record<string,unknown>;
 if(r.mode!==null&&r.mode!=='ELAPSED'&&r.mode!=='WORKING_HOURS')throw new HttpError(400,'INVALID_HANDOFF_CLOCK');
 if(r.timezone!==null&&(typeof r.timezone!=='string'||r.timezone.length>100||!r.timezone.trim()||r.timezone!==r.timezone.trim()||!/[A-Za-z]/.test(r.timezone)||r.timezone.includes(':')||/^[+-]/.test(r.timezone)))throw new HttpError(400,'INVALID_HANDOFF_CLOCK');
 let timezone:string|null=null;
 if(r.timezone!==null)try{timezone=new Intl.DateTimeFormat('en',{timeZone:r.timezone as string}).resolvedOptions().timeZone;}catch{throw new HttpError(400,'INVALID_HANDOFF_TIMEZONE');}
 return {mode:r.mode as HandoffClock['mode'],timezone,calendar:r.calendar===null?null:normalizeWeeklyHours(r.calendar)};
}
export const handoffClockSchema={type:'object',additionalProperties:false,required:['mode','timezone','calendar'],properties:{mode:{enum:[null,'ELAPSED','WORKING_HOURS']},timezone:{type:['string','null'],minLength:1,maxLength:100},calendar:{anyOf:[{type:'null'},weeklyHoursSchema]}}} as const;
