CREATE TABLE source_historical_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connection(id),
  form_id uuid NOT NULL,
  page_id uuid NOT NULL,
  connection_version integer NOT NULL CHECK (connection_version>0),
  form_version integer NOT NULL CHECK (form_version>0),
  page_version integer NOT NULL CHECK (page_version>0),
  actor_user_id uuid NOT NULL REFERENCES user_account(id),
  actor_role text NOT NULL CHECK (actor_role IN ('SUPER_ADMIN','MANAGER')),
  actor_branch_id uuid REFERENCES branch(id),
  request_id uuid NOT NULL,
  range_from timestamptz NOT NULL,
  range_until timestamptz NOT NULL CHECK (range_until>range_from),
  phase text NOT NULL DEFAULT 'PREVIEW' CHECK (phase IN ('PREVIEW','IMPORT')),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','PREVIEW_READY','IMPORTING','SUCCEEDED','FAILED','BLOCKED','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  cursor_token text CHECK (length(cursor_token) BETWEEN 1 AND 4096),
  pages integer NOT NULL DEFAULT 0 CHECK (pages>=0),
  scanned integer NOT NULL DEFAULT 0 CHECK (scanned>=0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  failures integer NOT NULL DEFAULT 0 CHECK (failures>=0),
  recoveries integer NOT NULL DEFAULT 0 CHECK (recoveries BETWEEN 0 AND 10),
  error_code text,
  lease_id uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES user_account(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id,request_id),
  UNIQUE (id,connection_id),
  FOREIGN KEY (form_id,connection_id) REFERENCES source_resource(id,connection_id),
  FOREIGN KEY (page_id,connection_id) REFERENCES source_resource(id,connection_id),
  CHECK ((state='RUNNING' AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'RUNNING' AND lease_id IS NULL AND lease_until IS NULL)),
  CHECK ((phase='IMPORT')=(confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)),
  CHECK ((phase='PREVIEW' AND state NOT IN ('IMPORTING','SUCCEEDED')) OR (phase='IMPORT' AND state NOT IN ('PENDING','RUNNING','PREVIEW_READY')))
);
CREATE INDEX source_historical_connection_cursor_idx ON source_historical_job (connection_id,created_at DESC,id DESC);
CREATE INDEX source_historical_queue_idx ON source_historical_job (available_at,id) WHERE state IN ('PENDING','RUNNING','IMPORTING');
CREATE UNIQUE INDEX source_historical_inflight_idx ON source_historical_job (connection_id) WHERE state='RUNNING';
CREATE TABLE source_historical_cursor (
  job_id uuid NOT NULL REFERENCES source_historical_job(id),
  cursor_hash bytea NOT NULL CHECK (octet_length(cursor_hash)=32),
  PRIMARY KEY (job_id,cursor_hash)
);
CREATE TABLE source_historical_item (
  job_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_lead_id text NOT NULL CHECK (external_lead_id ~ '^[0-9]{1,30}$'),
  raw_payload jsonb NOT NULL CHECK (jsonb_typeof(raw_payload)='object'),
  source_timestamp timestamptz NOT NULL,
  result text NOT NULL DEFAULT 'STAGED' CHECK (result IN ('STAGED','IMPORTED','DUPLICATE_SUBMISSION','DUPLICATE_RECEIPT','CONTEXT_CONFLICT')),
  submission_id uuid REFERENCES source_submission(id),
  PRIMARY KEY (job_id,external_lead_id),
  FOREIGN KEY (job_id,connection_id) REFERENCES source_historical_job(id,connection_id),
  CHECK ((result IN ('IMPORTED','DUPLICATE_SUBMISSION'))=(submission_id IS NOT NULL))
);
CREATE INDEX source_historical_staged_idx ON source_historical_item (job_id,external_lead_id) WHERE result='STAGED';
CREATE TABLE source_historical_attempt (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES source_historical_job(id),
  number integer NOT NULL CHECK (number>0),
  state text NOT NULL DEFAULT 'RUNNING' CHECK (state IN ('RUNNING','SUCCEEDED','FAILED','SUPERSEDED','CANCELLED')),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (job_id,number),
  CHECK ((state='RUNNING')=(finished_at IS NULL))
);
CREATE FUNCTION guard_source_historical_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.connection_id,NEW.form_id,NEW.page_id,NEW.connection_version,NEW.form_version,NEW.page_version,
    NEW.actor_user_id,NEW.actor_role,NEW.actor_branch_id,NEW.request_id,NEW.range_from,NEW.range_until,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.connection_id,OLD.form_id,OLD.page_id,OLD.connection_version,OLD.form_version,OLD.page_version,
    OLD.actor_user_id,OLD.actor_role,OLD.actor_branch_id,OLD.request_id,OLD.range_from,OLD.range_until,OLD.created_at)
    OR OLD.state IN ('SUCCEEDED','CANCELLED') OR NEW.version<=OLD.version OR NEW.pages<OLD.pages OR NEW.scanned<OLD.scanned
    OR NEW.attempts<OLD.attempts OR NEW.recoveries<OLD.recoveries OR (OLD.phase='IMPORT' AND NEW.phase<>'IMPORT')
    OR (OLD.confirmed_at IS NOT NULL AND ROW(NEW.confirmed_at,NEW.confirmed_by) IS DISTINCT FROM ROW(OLD.confirmed_at,OLD.confirmed_by))
    THEN RAISE EXCEPTION 'Historical job integrity violation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_historical_job_guard BEFORE UPDATE ON source_historical_job FOR EACH ROW EXECUTE FUNCTION guard_source_historical_job();
CREATE FUNCTION guard_source_historical_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target source_submission;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.result<>'STAGED' OR ROW(NEW.job_id,NEW.connection_id,NEW.external_lead_id,NEW.raw_payload,NEW.source_timestamp)
    IS DISTINCT FROM ROW(OLD.job_id,OLD.connection_id,OLD.external_lead_id,OLD.raw_payload,OLD.source_timestamp))
    THEN RAISE EXCEPTION 'Historical item is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.submission_id IS NOT NULL THEN
    SELECT * INTO target FROM source_submission WHERE id=NEW.submission_id;
    IF target.connection_id IS DISTINCT FROM NEW.connection_id OR target.external_event_id IS DISTINCT FROM NEW.external_lead_id OR target.source_kind<>'META'
      THEN RAISE EXCEPTION 'Historical submission identity mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_historical_item_guard BEFORE INSERT OR UPDATE ON source_historical_item FOR EACH ROW EXECUTE FUNCTION guard_source_historical_item();
CREATE FUNCTION guard_source_historical_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state<>'RUNNING' OR ROW(NEW.id,NEW.job_id,NEW.number,NEW.started_at) IS DISTINCT FROM ROW(OLD.id,OLD.job_id,OLD.number,OLD.started_at)
    THEN RAISE EXCEPTION 'Historical attempt is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_historical_attempt_guard BEFORE UPDATE ON source_historical_attempt FOR EACH ROW EXECUTE FUNCTION guard_source_historical_attempt();
CREATE FUNCTION preserve_source_historical_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Historical records cannot be deleted' USING ERRCODE='23514';
END $$;
CREATE TRIGGER source_historical_job_no_delete BEFORE DELETE ON source_historical_job FOR EACH ROW EXECUTE FUNCTION preserve_source_historical_record();
CREATE TRIGGER source_historical_item_no_delete BEFORE DELETE ON source_historical_item FOR EACH ROW EXECUTE FUNCTION preserve_source_historical_record();
CREATE TRIGGER source_historical_attempt_no_delete BEFORE DELETE ON source_historical_attempt FOR EACH ROW EXECUTE FUNCTION preserve_source_historical_record();
