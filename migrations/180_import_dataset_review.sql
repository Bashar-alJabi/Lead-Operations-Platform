-- Whole-dataset review is not business intake authority. Customer values expire with quarantine.
CREATE TABLE lead_import_review (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),file_id uuid NOT NULL REFERENCES lead_import_file(id),revision integer NOT NULL CHECK(revision>0),
 request_key uuid NOT NULL,session_id uuid NOT NULL REFERENCES user_session(id),
 selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='array' AND jsonb_array_length(selection) BETWEEN 1 AND 10),
 configuration_hash text NOT NULL CHECK(configuration_hash~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'VALIDATING' CHECK(state IN ('VALIDATING','READY','FAILED','STALE','CANCELLED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),total integer NOT NULL CHECK(total BETWEEN 1 AND 10000),
 processed integer NOT NULL DEFAULT 0 CHECK(processed BETWEEN 0 AND total),valid_count integer NOT NULL DEFAULT 0 CHECK(valid_count BETWEEN 0 AND processed),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),error_code text,
 next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(file_id,revision),UNIQUE(file_id,request_key),UNIQUE(id,file_id)
);
CREATE INDEX lead_import_review_work ON lead_import_review(next_run_at,id) WHERE state='VALIDATING';
CREATE TABLE lead_import_review_row (
 review_id uuid NOT NULL,file_id uuid NOT NULL,sheet_index integer NOT NULL,row_number integer NOT NULL,
 valid boolean NOT NULL,contact jsonb,fields jsonb NOT NULL,errors jsonb NOT NULL,
 phone_normalized text GENERATED ALWAYS AS (contact->>'phoneNormalized') STORED,
 email_normalized text GENERATED ALWAYS AS (contact->>'emailNormalized') STORED,
 PRIMARY KEY(review_id,sheet_index,row_number),
 FOREIGN KEY(review_id,file_id) REFERENCES lead_import_review(id,file_id),
 FOREIGN KEY(file_id,sheet_index,row_number) REFERENCES lead_import_row(file_id,sheet_index,row_number) ON DELETE CASCADE,
 CHECK(contact IS NULL OR jsonb_typeof(contact)='object'),
 CHECK(jsonb_typeof(fields)='array' AND jsonb_array_length(fields)<=64),
 CHECK(jsonb_typeof(errors)='array' AND jsonb_array_length(errors)<=65),CHECK(valid=(errors='[]'::jsonb))
);
CREATE INDEX lead_import_review_phone ON lead_import_review_row(review_id,phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX lead_import_review_email ON lead_import_review_row(review_id,email_normalized) WHERE email_normalized IS NOT NULL;
CREATE TABLE lead_import_review_decision (
 review_id uuid NOT NULL REFERENCES lead_import_review(id),sheet_index integer NOT NULL,row_number integer NOT NULL,
 version integer NOT NULL CHECK(version>0),request_key uuid NOT NULL,session_id uuid NOT NULL REFERENCES user_session(id),
 action text NOT NULL CHECK(action IN ('SKIP','KEEP_AS_NEW_LEAD')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(review_id,sheet_index,row_number,version),UNIQUE(review_id,request_key)
);
CREATE TABLE lead_import_review_history (
 review_id uuid NOT NULL REFERENCES lead_import_review(id),version integer NOT NULL,state text NOT NULL,
 processed integer NOT NULL,valid_count integer NOT NULL,attempt_count integer NOT NULL,error_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(review_id,version)
);
CREATE FUNCTION lead_import_review_current(j lead_import_file,r lead_import_review) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT j.state='REVIEW' AND j.expires_at>clock_timestamp() AND j.purged_at IS NULL AND lead_import_authority(j)
  AND r.configuration_hash=lead_import_mapping_config(j)
  AND NOT EXISTS(SELECT 1 FROM lead_import_review newer WHERE newer.file_id=j.id AND newer.revision>r.revision)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.selection) s WHERE NOT EXISTS(
   SELECT 1 FROM lead_import_mapping_revision m JOIN lead_import_sheet sh ON sh.file_id=m.file_id AND sh.sheet_index=m.sheet_index
    WHERE m.file_id=j.id AND m.sheet_index=(s->>'sheet')::integer AND m.version=(s->>'version')::integer
     AND m.configuration_hash=r.configuration_hash AND NOT EXISTS(SELECT 1 FROM lead_import_mapping_revision n
      WHERE n.file_id=m.file_id AND n.sheet_index=m.sheet_index AND n.version>m.version)))
$$;
CREATE FUNCTION lead_import_review_audit(j lead_import_file,r lead_import_review,act text,human boolean) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM audit_log a WHERE a.organization_id=j.organization_id AND a.branch_id=j.branch_id
  AND a.target_type='LEAD_IMPORT_REVIEW' AND a.target_id=r.id::text AND a.action=act AND ai_row_inserted_here(a.xmin)
  AND a.detail->>'version'=r.version::text AND CASE WHEN human THEN a.actor_user_id=j.actor_id AND EXISTS(
   SELECT 1 FROM user_session us WHERE us.id=(a.detail->>'sessionId')::uuid AND us.user_id=j.actor_id AND us.revoked_at IS NULL AND us.expires_at>clock_timestamp())
   ELSE a.actor_user_id IS NULL END)
$$;
CREATE FUNCTION lead_import_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j lead_import_file;s jsonb;actual integer;good integer;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMPORT_REVIEW_HISTORY_RETAINED';END IF;
 SELECT * INTO j FROM lead_import_file WHERE id=NEW.file_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'VALIDATING' OR NEW.version<>1 OR NEW.processed<>0 OR NEW.valid_count<>0 OR NEW.attempt_count<>0 OR NEW.error_code IS NOT NULL
   OR NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp()
   OR NEW.revision<>COALESCE((SELECT max(revision)+1 FROM lead_import_review WHERE file_id=j.id),1)
   OR NOT lead_import_review_current(j,NEW) OR NOT lead_import_review_audit(j,NEW,'IMPORT_REVIEW_CREATED',true)
   OR NOT EXISTS(SELECT 1 FROM user_session us WHERE us.id=NEW.session_id AND us.user_id=j.actor_id AND us.revoked_at IS NULL AND us.expires_at>clock_timestamp())
   OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.target_type='LEAD_IMPORT_REVIEW' AND a.target_id=NEW.id::text AND a.action='IMPORT_REVIEW_CREATED'
    AND ai_row_inserted_here(a.xmin) AND a.detail->>'sessionId'=NEW.session_id::text AND a.detail->>'requestId'=NEW.request_key::text
    AND a.detail->>'revision'=NEW.revision::text AND a.detail->>'configurationHash'=NEW.configuration_hash AND a.detail->'selection'=NEW.selection)
   THEN RAISE EXCEPTION 'IMPORT_REVIEW_CURRENT_PROOF';END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(NEW.selection) LOOP
   IF jsonb_typeof(s)<>'object' OR s-ARRAY['sheet','version']<>'{}'::jsonb
    OR jsonb_typeof(s->'sheet') IS DISTINCT FROM 'number' OR (s->>'sheet')!~'^[0-9]$'
    OR jsonb_typeof(s->'version') IS DISTINCT FROM 'number' OR (s->>'version')!~'^[1-9][0-9]*$'
    THEN RAISE EXCEPTION 'IMPORT_REVIEW_SELECTION';END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x->>'sheet') FROM jsonb_array_elements(NEW.selection) x)<>jsonb_array_length(NEW.selection)
   OR NEW.total<>(SELECT sum(sh.row_count) FROM lead_import_sheet sh JOIN jsonb_array_elements(NEW.selection) x ON sh.sheet_index=(x->>'sheet')::integer WHERE sh.file_id=j.id)
   THEN RAISE EXCEPTION 'IMPORT_REVIEW_SELECTION';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','version','processed','valid_count','attempt_count','error_code','next_run_at','updated_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','processed','valid_count','attempt_count','error_code','next_run_at','updated_at'])
   OR NEW.version<>OLD.version+1 OR OLD.state IN ('CANCELLED','STALE') THEN RAISE EXCEPTION 'IMPORT_REVIEW_IMMUTABLE';END IF;
  IF NEW.state='CANCELLED' THEN
   IF NOT lead_import_authority(j) OR NOT lead_import_review_audit(j,NEW,'IMPORT_REVIEW_CANCELLED',true) THEN RAISE EXCEPTION 'IMPORT_REVIEW_CANCEL_PROOF';END IF;
  ELSIF NEW.state='STALE' THEN
   IF lead_import_review_current(j,OLD) OR NOT lead_import_review_audit(j,NEW,'IMPORT_REVIEW_STALE',false) THEN RAISE EXCEPTION 'IMPORT_REVIEW_STALE_PROOF';END IF;
  ELSIF OLD.state='FAILED' AND NEW.state='VALIDATING' THEN
   IF NOT lead_import_review_current(j,NEW) OR NEW.attempt_count<>0 OR NEW.error_code IS NOT NULL
    OR NOT lead_import_review_audit(j,NEW,'IMPORT_REVIEW_RETRIED',true) THEN RAISE EXCEPTION 'IMPORT_REVIEW_RETRY_PROOF';END IF;
  ELSIF OLD.state='VALIDATING' AND NEW.state IN ('VALIDATING','READY','FAILED') AND lead_import_review_current(j,NEW) THEN
   IF NEW.processed>OLD.processed THEN
    SELECT count(*)::integer,count(*) FILTER(WHERE valid)::integer INTO actual,good FROM lead_import_review_row WHERE review_id=NEW.id;
    IF NEW.state NOT IN ('VALIDATING','READY') OR NEW.processed-OLD.processed>100 OR NEW.processed<>actual OR NEW.valid_count<>good
     OR NEW.processed-OLD.processed<>(SELECT count(*) FROM lead_import_review_row WHERE review_id=NEW.id AND ai_row_inserted_here(xmin))
     OR NEW.attempt_count<>OLD.attempt_count OR NEW.error_code IS NOT NULL
     OR (NEW.state='READY') IS DISTINCT FROM (NEW.processed=NEW.total)
     OR NOT lead_import_review_audit(j,NEW,'IMPORT_REVIEW_PROGRESS',false) THEN RAISE EXCEPTION 'IMPORT_REVIEW_PROGRESS_PROOF';END IF;
   ELSE
    IF NEW.state NOT IN ('VALIDATING','FAILED') OR NEW.attempt_count<>OLD.attempt_count+1 OR NEW.error_code IS DISTINCT FROM 'IMPORT_REVIEW_PROCESSING_FAILED'
     OR (NEW.state='FAILED') IS DISTINCT FROM (NEW.attempt_count=5)
     OR NOT lead_import_review_audit(j,NEW,'IMPORT_REVIEW_FAILED',false) THEN RAISE EXCEPTION 'IMPORT_REVIEW_FAILURE_PROOF';END IF;
   END IF;
  ELSE RAISE EXCEPTION 'IMPORT_REVIEW_TRANSITION';END IF;
  IF NEW.processed=OLD.processed AND NEW.valid_count<>OLD.valid_count OR NEW.processed<OLD.processed THEN RAISE EXCEPTION 'IMPORT_REVIEW_COUNT_IMMUTABLE';END IF;
  IF NEW.state IN ('CANCELLED','STALE') AND (NEW.processed<>OLD.processed OR NEW.attempt_count<>OLD.attempt_count) THEN RAISE EXCEPTION 'IMPORT_REVIEW_COUNT_IMMUTABLE';END IF;
 END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER lead_import_review_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_review FOR EACH ROW EXECUTE FUNCTION lead_import_review_guard();
CREATE FUNCTION lead_import_review_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r lead_import_review;j lead_import_file;proof lead_import_review;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'IMPORT_REVIEW_ROW_IMMUTABLE';END IF;
 SELECT * INTO r FROM lead_import_review WHERE id=CASE WHEN TG_OP='INSERT' THEN NEW.review_id ELSE OLD.review_id END;
 SELECT * INTO j FROM lead_import_file WHERE id=r.file_id FOR UPDATE;
 SELECT * INTO r FROM lead_import_review WHERE id=r.id FOR UPDATE;
 IF TG_OP='DELETE' THEN
  IF j.state NOT IN ('CANCELLED','EXPIRED','REJECTED','REVOKED') AND r.state NOT IN ('CANCELLED','STALE') THEN RAISE EXCEPTION 'IMPORT_REVIEW_ROWS_RETAINED';END IF;RETURN OLD;
 END IF;
 proof=r;proof.version=r.version+1;
 IF r.state<>'VALIDATING' OR NOT lead_import_review_current(j,r) OR NOT lead_import_review_audit(j,proof,'IMPORT_REVIEW_PROGRESS',false)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.selection) s WHERE (s->>'sheet')::integer=NEW.sheet_index)
  THEN RAISE EXCEPTION 'IMPORT_REVIEW_ROW_PROOF';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lead_import_review_row_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_review_row FOR EACH ROW EXECUTE FUNCTION lead_import_review_row_guard();
CREATE FUNCTION lead_import_review_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r lead_import_review;j lead_import_file;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'IMPORT_REVIEW_DECISION_IMMUTABLE';END IF;
 SELECT f.* INTO j FROM lead_import_file f JOIN lead_import_review rv ON rv.file_id=f.id WHERE rv.id=NEW.review_id FOR UPDATE OF f;
 SELECT * INTO r FROM lead_import_review WHERE id=NEW.review_id FOR UPDATE;
 IF r.state<>'READY' OR NOT lead_import_review_current(j,r)
  OR NEW.created_at<transaction_timestamp() OR NEW.created_at>clock_timestamp()
  OR NEW.version<>COALESCE((SELECT max(version)+1 FROM lead_import_review_decision WHERE review_id=r.id AND sheet_index=NEW.sheet_index AND row_number=NEW.row_number),1)
  OR NOT EXISTS(SELECT 1 FROM lead_import_review_row rw WHERE rw.review_id=r.id AND rw.sheet_index=NEW.sheet_index AND rw.row_number=NEW.row_number AND (NEW.action='SKIP' OR rw.valid))
  OR NOT EXISTS(SELECT 1 FROM user_session us WHERE us.id=NEW.session_id AND us.user_id=j.actor_id AND us.revoked_at IS NULL AND us.expires_at>clock_timestamp())
  OR NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.target_type='LEAD_IMPORT_REVIEW' AND a.target_id=r.id::text AND a.organization_id=j.organization_id AND a.branch_id=j.branch_id
   AND a.actor_user_id=j.actor_id AND a.action='IMPORT_REVIEW_DECIDED' AND ai_row_inserted_here(a.xmin)
   AND a.detail->>'sessionId'=NEW.session_id::text AND a.detail->>'requestId'=NEW.request_key::text
   AND a.detail->>'sheet'=NEW.sheet_index::text AND a.detail->>'row'=NEW.row_number::text AND a.detail->>'version'=NEW.version::text AND a.detail->>'action'=NEW.action)
  THEN RAISE EXCEPTION 'IMPORT_REVIEW_DECISION_PROOF';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lead_import_review_decision_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_review_decision FOR EACH ROW EXECUTE FUNCTION lead_import_review_decision_guard();
CREATE FUNCTION lead_import_review_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM lead_import_review r WHERE r.id=NEW.review_id AND r.version=NEW.version AND r.state=NEW.state
  AND r.processed=NEW.processed AND r.valid_count=NEW.valid_count AND r.attempt_count=NEW.attempt_count AND r.error_code IS NOT DISTINCT FROM NEW.error_code AND ai_row_inserted_here(r.xmin))
  THEN RAISE EXCEPTION 'IMPORT_REVIEW_HISTORY_IMMUTABLE';END IF;RETURN NEW;
END $$;
CREATE TRIGGER lead_import_review_history_guard BEFORE INSERT OR UPDATE OR DELETE ON lead_import_review_history FOR EACH ROW EXECUTE FUNCTION lead_import_review_history_guard();
CREATE FUNCTION lead_import_review_history_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO lead_import_review_history(review_id,version,state,processed,valid_count,attempt_count,error_code) VALUES(NEW.id,NEW.version,NEW.state,NEW.processed,NEW.valid_count,NEW.attempt_count,NEW.error_code);RETURN NEW;
END $$;
CREATE TRIGGER lead_import_review_history_record AFTER INSERT OR UPDATE ON lead_import_review FOR EACH ROW EXECUTE FUNCTION lead_import_review_history_record();
