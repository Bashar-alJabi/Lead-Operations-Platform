-- Pure bounded arithmetic. This grants no Handoff, job, notification or customer-send authority.
CREATE FUNCTION ai_handoff_wall_microseconds(h jsonb,lo timestamp,hi timestamp) RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE day date;last_day date;key text;r jsonb;period_lo timestamp;period_hi timestamp;total numeric=0;BEGIN
 IF lo IS NULL OR hi IS NULL OR NOT isfinite(lo) OR NOT isfinite(hi) OR hi<lo OR hi-lo>interval '1 minute' THEN RAISE EXCEPTION 'HANDOFF_CLOCK_WALL_INTERVAL_INVALID';END IF;
 -- The caller validates the bounded canonical calendar once. A wall piece is at most one minute/two dates.
 day=lo::date;last_day=hi::date;
 WHILE day<=last_day LOOP
  key=(ARRAY['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow FROM day)::integer];
  FOR r IN SELECT value FROM jsonb_array_elements(COALESCE(h->key,'[]')) LOOP
   period_lo=day::timestamp+make_interval(mins=>split_part(r->>0,':',1)::integer*60+split_part(r->>0,':',2)::integer);
   period_hi=day::timestamp+make_interval(mins=>split_part(r->>1,':',1)::integer*60+split_part(r->>1,':',2)::integer);
   total=total+GREATEST(0,extract(epoch FROM LEAST(hi,period_hi)-GREATEST(lo,period_lo))*1000000);
  END LOOP;
  day=day+1;
 END LOOP;
 RETURN total::bigint;
END $$;
CREATE FUNCTION ai_handoff_clock_slice(mode text,zone text,h jsonb,lo timestamptz,hi timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE through timestamptz;cursor_time timestamptz;edge timestamptz;piece_hi timestamptz;lower_time timestamptz;upper_time timestamptz;middle_time timestamptz;
 wall_lo timestamp;offset_lo interval;offset_last interval;offset_mid interval;total bigint=0;cells integer=0;pieces integer;BEGIN
 IF mode IS NULL OR mode NOT IN ('ELAPSED','WORKING_HOURS') OR zone IS NULL OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=zone)
  OR h IS NULL OR NOT operational_hours_valid(h) OR lo IS NULL OR hi IS NULL OR NOT isfinite(lo) OR NOT isfinite(hi) OR hi<lo THEN RAISE EXCEPTION 'HANDOFF_CLOCK_SLICE_INVALID';END IF;
 -- Six hours per call is a technical work bound, never a limit on the configured SLA target.
 through=LEAST(hi,lo+interval '360 minutes');cursor_time=lo;
 IF mode='ELAPSED' OR h='{}' THEN total=(extract(epoch FROM through-lo)*1000000)::bigint;
 ELSE
  WHILE cursor_time<through LOOP
   edge=LEAST(through,(date_trunc('minute',cursor_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+interval '1 minute');cells=cells+1;pieces=0;
   WHILE cursor_time<edge LOOP
    pieces=pieces+1;IF pieces>4 THEN RAISE EXCEPTION 'HANDOFF_CLOCK_ZONE_TRANSITION_LIMIT';END IF;
    wall_lo=cursor_time AT TIME ZONE zone;offset_lo=wall_lo-(cursor_time AT TIME ZONE 'UTC');
    offset_last=((edge-interval '1 microsecond') AT TIME ZONE zone)-((edge-interval '1 microsecond') AT TIME ZONE 'UTC');piece_hi=edge;
    IF offset_last<>offset_lo THEN
     -- Locate the offset transition in absolute time, retaining exact PostgreSQL microseconds.
     lower_time=cursor_time;upper_time=edge-interval '1 microsecond';
     WHILE upper_time-lower_time>interval '1 microsecond' LOOP
      middle_time=lower_time+(upper_time-lower_time)/2;
      offset_mid=(middle_time AT TIME ZONE zone)-(middle_time AT TIME ZONE 'UTC');
      IF offset_mid=offset_lo THEN lower_time=middle_time;ELSE upper_time=middle_time;END IF;
     END LOOP;
     piece_hi=upper_time;
    END IF;
    -- Intersect actual local time traversed, rather than inverse-converting ambiguous/missing wall endpoints.
    total=total+ai_handoff_wall_microseconds(h,wall_lo,wall_lo+(piece_hi-cursor_time));cursor_time=piece_hi;
   END LOOP;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('algorithmVersion',1,'accountedMicroseconds',total,'processedUntil',through,'complete',through=hi,'utcCells',cells,'sliceMinutes',360,'authorityGranted',false);
END $$;
