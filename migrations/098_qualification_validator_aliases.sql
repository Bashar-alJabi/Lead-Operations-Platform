CREATE OR REPLACE FUNCTION ai_qualification_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE q jsonb;r jsonb;rules jsonb;BEGIN
  IF jsonb_typeof(d)<>'object' OR octet_length(d::text)>65536 OR (SELECT count(*) FROM jsonb_object_keys(d))<>4 OR NOT d ?& ARRAY['enabled','questions','completion','handoff']
    OR jsonb_typeof(d->'enabled')<>'boolean' OR jsonb_typeof(d->'questions')<>'array' OR jsonb_array_length(d->'questions')>40 THEN RETURN false;END IF;
  FOR q IN SELECT jsonb_array_elements(d->'questions') LOOP
    IF jsonb_typeof(q)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(q))<>4 OR NOT q ?& ARRAY['id','prompt','fieldId','required']
      OR jsonb_typeof(q->'id')<>'string' OR (q->>'id') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      OR jsonb_typeof(q->'prompt')<>'string' OR length(trim(q->>'prompt')) NOT BETWEEN 1 AND 500 OR (q->>'prompt') ~ '[[:cntrl:]]'
      OR jsonb_typeof(q->'required')<>'boolean' OR NOT (q->'fieldId'='null'::jsonb OR jsonb_typeof(q->'fieldId')='string' AND (q->>'fieldId') ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') THEN RETURN false;END IF;
  END LOOP;
  IF (SELECT count(DISTINCT entry->>'id') FROM jsonb_array_elements(d->'questions') entry)<>jsonb_array_length(d->'questions') THEN RETURN false;END IF;
  IF jsonb_typeof(d->'completion')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d->'completion'))<>3 OR NOT (d->'completion') ?& ARRAY['mode','match','conditions']
    OR jsonb_typeof(d->'completion'->'mode')<>'string' OR jsonb_typeof(d->'completion'->'match')<>'string'
    OR d->'completion'->>'mode' NOT IN ('ALL_REQUIRED','CONDITIONS') OR d->'completion'->>'match' NOT IN ('ALL','ANY')
    OR jsonb_typeof(d->'handoff')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(d->'handoff'))<>3 OR NOT (d->'handoff') ?& ARRAY['onCompletion','match','conditions']
    OR jsonb_typeof(d->'handoff'->'onCompletion')<>'boolean' OR jsonb_typeof(d->'handoff'->'match')<>'string' OR d->'handoff'->>'match' NOT IN ('ALL','ANY') THEN RETURN false;END IF;
  FOR rules IN SELECT d->'completion'->'conditions' UNION ALL SELECT d->'handoff'->'conditions' LOOP
    IF jsonb_typeof(rules)<>'array' OR jsonb_array_length(rules)>40 THEN RETURN false;END IF;
    FOR r IN SELECT jsonb_array_elements(rules) LOOP
      IF jsonb_typeof(r)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>3 OR NOT r ?& ARRAY['questionId','operator','value']
        OR jsonb_typeof(r->'operator')<>'string' OR jsonb_typeof(r->'questionId')<>'string' OR r->>'operator' NOT IN ('ANSWERED','EQUALS') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'questions') entry WHERE entry->>'id'=r->>'questionId')
        OR octet_length((r->'value')::text)>4096 OR r->>'operator'='ANSWERED' AND r->'value'<>'null'::jsonb OR r->>'operator'='EQUALS' AND r->'value'='null'::jsonb THEN RETURN false;END IF;
    END LOOP;
  END LOOP;
  IF d->'completion'->>'mode'='ALL_REQUIRED' AND (jsonb_array_length(d->'completion'->'conditions')<>0 OR d->'completion'->>'match'<>'ALL') THEN RETURN false;END IF;
  IF (d->>'enabled')::boolean AND (jsonb_array_length(d->'questions')=0 OR d->'completion'->>'mode'='ALL_REQUIRED' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'questions') entry WHERE (entry->>'required')::boolean)
    OR d->'completion'->>'mode'='CONDITIONS' AND jsonb_array_length(d->'completion'->'conditions')=0) THEN RETURN false;END IF;
  RETURN true;EXCEPTION WHEN others THEN RETURN false;END $$;